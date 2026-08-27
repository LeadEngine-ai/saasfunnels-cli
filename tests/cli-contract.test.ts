import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDeveloperToolSourceContract } from "../src/runtime-contracts.js";
import { runSaaSFunnelsCli } from "../src/cli.js";

const rawIngestKey = "pv_live_ab12cd34_secret_should_never_print";
const rawDeveloperKey = "pv_live_ab12cd34_developer_secret_should_never_print";

async function tempWorkspace() {
  return mkdtemp(join(tmpdir(), "saasfunnels-cli-"));
}

async function writeJson(cwd: string, fileName: string, payload: unknown) {
  const filePath = join(cwd, fileName);
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("SaaSFunnels CLI contract", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { force: true, recursive: true })),
    );
  });

  it("validates local event payload files without a SaaSFunnels workspace", async () => {
    const cwd = await tempWorkspace();
    tempDirs.push(cwd);
    const filePath = await writeJson(
      cwd,
      "event.json",
      getDeveloperToolSourceContract("direct").sample_payload,
    );

    const result = await runSaaSFunnelsCli(
      ["events", "validate", filePath, "--source", "direct", "--json"],
      { cwd },
    );
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload).toMatchObject({
      ok: true,
      source: "direct",
    });
    expect(payload.normalized_event).toMatchObject({
      account_id: "acct_123",
      event_name: "usage_limit_hit",
    });
  });

  it("returns structured validation failures for unsafe or incomplete payloads", async () => {
    const cwd = await tempWorkspace();
    tempDirs.push(cwd);
    const filePath = await writeJson(cwd, "unsafe.json", {
      event_name: "usage_limit_hit",
      properties: {
        api_token: "sk_test_123456789012345678901234",
      },
      timestamp: "2026-06-20T15:00:00.000Z",
    });

    const result = await runSaaSFunnelsCli(
      ["events", "validate", filePath, "--json"],
      { cwd },
    );
    const output = `${result.stdout}${result.stderr}`;
    const payload = JSON.parse(result.stdout);
    const issueCodes = payload.errors.map(
      (issue: { code: string }) => issue.code,
    );

    expect(result.exitCode).toBe(1);
    expect(issueCodes).toContain("missing_account_identity");
    expect(issueCodes).toContain("unsafe_field");
    expect(output).not.toContain("sk_test_123456789012345678901234");
  });

  it("installs agent handoff artifacts with placeholders instead of raw keys", async () => {
    const cwd = await tempWorkspace();
    tempDirs.push(cwd);

    const codexResult = await runSaaSFunnelsCli(
      ["agent", "install", "--target", "codex"],
      { cwd },
    );
    const markdownResult = await runSaaSFunnelsCli(
      ["agent", "install", "--target", "markdown"],
      { cwd },
    );
    const codexArtifact = await readFile(
      join(cwd, ".agents/skills/saasfunnels-event-discovery/SKILL.md"),
      "utf8",
    );
    const markdownArtifact = await readFile(
      join(cwd, "SAASFUNNELS_DIRECT_API.md"),
      "utf8",
    );

    expect(codexResult.exitCode).toBe(0);
    expect(markdownResult.exitCode).toBe(0);
    expect(codexArtifact).toContain("<SAASFUNNELS_INGEST_KEY>");
    expect(markdownArtifact).toContain("Install SaaSFunnels Direct API");
    expect(`${codexArtifact}${markdownArtifact}`).not.toContain(rawIngestKey);
  });

  it("exposes final SaaSFunnels help and a stable local verify contract", async () => {
    const help = await runSaaSFunnelsCli(["help"]);
    const verified = await runSaaSFunnelsCli(["verify", "--json"]);
    const payload = JSON.parse(verified.stdout);

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("SaaSFunnels CLI");
    expect(help.stdout).toContain("saasfunnels verify");
    expect(help.stdout).toContain("SAASFUNNELS_MCP_ENABLE_FUNNEL_WRITES");
    expect(help.stdout).not.toContain("Usage:\n  prevenue");
    expect(help.stdout).not.toContain("PREVENUE_");
    expect(verified.exitCode).toBe(0);
    expect(payload).toMatchObject({
      checks: { source_contracts: { ok: true } },
      errors: [],
      ok: true,
    });
    expect(payload.warnings).toContainEqual(
      expect.objectContaining({ code: "live_checks_skipped" }),
    );
  });

  it("runs the stable live verify checks with the public environment names", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(url));
        expect((init?.headers as Record<string, string>).authorization).toBe(
          `Bearer ${rawDeveloperKey}`,
        );
        return jsonResponse({
          data: String(url).endsWith("/signals/readiness")
            ? { readiness: [{ label: "Activation", status: "ready" }] }
            : {},
          ok: true,
        });
      },
    ) as unknown as typeof fetch;

    const result = await runSaaSFunnelsCli(["verify", "--live", "--json"], {
      env: {
        SAASFUNNELS_API_BASE_URL: "https://app.prevenue.test",
        SAASFUNNELS_API_KEY: rawDeveloperKey,
      },
      fetch: fetchImpl,
    });
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload).toMatchObject({
      checks: {
        live: {
          details: {
            integration_check_ok: true,
            readiness_rows: 1,
            workspace_check_ok: true,
          },
          ok: true,
        },
      },
      errors: [],
      ok: true,
    });
    expect(calls).toEqual([
      "https://app.prevenue.test/api/developer-tools/workspace",
      "https://app.prevenue.test/api/developer-tools/integrations/health",
      "https://app.prevenue.test/api/developer-tools/signals/readiness",
    ]);
  });

  it("uses exit code 2 when a requested live verify cannot authenticate", async () => {
    const result = await runSaaSFunnelsCli(["verify", "--live", "--json"], {
      env: {},
    });
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(payload).toMatchObject({
      checks: { live: { ok: false } },
      ok: false,
    });
    expect(payload.errors).toContainEqual(
      expect.objectContaining({
        code: "live_check_unavailable",
        message: "Missing SAASFUNNELS_API_KEY for live developer diagnostics.",
      }),
    );
  });

  it("sends a test Direct API event with the ingest key redacted from output", async () => {
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe("https://app.prevenue.test/api/events/ingest");
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).authorization).toBe(
          `Bearer ${rawIngestKey}`,
        );
        expect(JSON.parse(String(init?.body))).toMatchObject({
          account_id: "acct_123",
          event_name: "usage_limit_hit",
        });

        return jsonResponse({
          data: {
            duplicate: false,
            persisted: true,
            workflow_enqueued: true,
          },
          ok: true,
        });
      },
    ) as unknown as typeof fetch;

    const result = await runSaaSFunnelsCli(["events", "send-test"], {
      env: {
        PREVENUE_API_BASE_URL: "https://app.prevenue.test",
        PREVENUE_INGEST_API_KEY: rawIngestKey,
      },
      fetch: fetchImpl,
    });

    expect(result.exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.stdout).toContain("Test event sent.");
    expect(result.stdout).toContain("persisted: true");
    expect(`${result.stdout}${result.stderr}`).not.toContain(rawIngestKey);
  });

  it("runs read-only diagnostics through developer-tool endpoints", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(url));
        expect((init?.headers as Record<string, string>).authorization).toBe(
          `Bearer ${rawDeveloperKey}`,
        );
        return jsonResponse({
          data: String(url).endsWith("/signals/readiness")
            ? {
                readiness: [
                  {
                    label: "Activation",
                    next_action_label: "Send account_activated",
                    status: "missing",
                  },
                ],
              }
            : { ok: true },
          ok: true,
        });
      },
    ) as unknown as typeof fetch;

    const options = {
      env: {
        PREVENUE_API_BASE_URL: "https://app.prevenue.test",
        PREVENUE_API_KEY: rawDeveloperKey,
      },
      fetch: fetchImpl,
    };

    const doctor = await runSaaSFunnelsCli(
      ["doctor", "--events", "--mappings", "--json"],
      options,
    );
    const readiness = await runSaaSFunnelsCli(["readiness"], options);

    expect(doctor.exitCode).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      ok: true,
      checks: {
        events: { ok: true },
        mappings: { ok: true },
        workspace: { ok: true },
      },
    });
    expect(readiness.exitCode).toBe(0);
    expect(readiness.stdout).toContain("Activation");
    expect(calls).toEqual([
      "https://app.prevenue.test/api/developer-tools/workspace",
      "https://app.prevenue.test/api/developer-tools/events/health",
      "https://app.prevenue.test/api/developer-tools/mappings/gaps",
      "https://app.prevenue.test/api/developer-tools/signals/readiness",
    ]);
    expect(
      `${doctor.stdout}${doctor.stderr}${readiness.stdout}${readiness.stderr}`,
    ).not.toContain(rawDeveloperKey);
  });
});
