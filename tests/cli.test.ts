import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runSaaSFunnelsCli } from "../src/cli.ts";
import { getDeveloperToolSourceContract } from "../src/runtime-contracts.js";

const tempDirectories: string[] = [];

async function temporaryWorkspace() {
  const path = await mkdtemp(join(tmpdir(), "saasfunnels-cli-test-"));
  tempDirectories.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("SaaSFunnels CLI", () => {
  it("exposes canonical help and a stable local verify contract", async () => {
    const help = await runSaaSFunnelsCli(["--help"]);
    const verified = await runSaaSFunnelsCli(["verify", "--json"]);
    const payload = JSON.parse(verified.stdout);

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("SaaSFunnels CLI");
    expect(help.stdout).toContain("saasfunnels verify");
    expect(help.stdout).toContain("SAASFUNNELS_MCP_ENABLE_FUNNEL_WRITES");
    expect(help.stdout).not.toContain("PREVENUE_");
    expect(verified.exitCode).toBe(0);
    expect(payload).toMatchObject({
      checks: { source_contracts: { ok: true } },
      errors: [],
      ok: true,
    });
  });

  it("validates local events and redacts unsafe values", async () => {
    const cwd = await temporaryWorkspace();
    const validPath = join(cwd, "event.json");
    const unsafePath = join(cwd, "unsafe.json");
    await writeFile(
      validPath,
      `${JSON.stringify(getDeveloperToolSourceContract("direct").sample_payload)}\n`,
      "utf8",
    );
    await writeFile(
      unsafePath,
      `${JSON.stringify({
        event_name: "usage_limit_hit",
        properties: { api_token: "sk_test_123456789012345678901234" },
        timestamp: "2026-06-20T15:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const valid = await runSaaSFunnelsCli(
      ["events", "validate", validPath, "--source", "direct", "--json"],
      { cwd },
    );
    const unsafe = await runSaaSFunnelsCli(
      ["events", "validate", unsafePath, "--json"],
      { cwd },
    );

    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      normalized_event: { account_id: "acct_123", event_name: "usage_limit_hit" },
      ok: true,
    });
    expect(unsafe.exitCode).toBe(1);
    expect(JSON.parse(unsafe.stdout).errors.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining(["missing_account_identity", "unsafe_field"]),
    );
    expect(`${unsafe.stdout}${unsafe.stderr}`).not.toContain(
      "sk_test_123456789012345678901234",
    );
  });

  it("generates only canonical handoff paths and content", async () => {
    const cwd = await temporaryWorkspace();
    const result = await runSaaSFunnelsCli(
      ["agent", "install", "--target", "codex"],
      { cwd },
    );
    const artifact = await readFile(
      join(cwd, ".agents/skills/saasfunnels-event-discovery/SKILL.md"),
      "utf8",
    );

    expect(result.exitCode).toBe(0);
    expect(artifact).toContain("<SAASFUNNELS_INGEST_KEY>");
    expect(artifact).toContain("SaaSFunnels Event Discovery");
    expect(artifact).not.toContain("PREVENUE_");
  });

  it("accepts the documented legacy environment aliases without emitting them", async () => {
    const legacyKey = "pv_test_legacy_alias_secret_should_not_print";
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(
        `Bearer ${legacyKey}`,
      );
      return new Response(
        JSON.stringify({ data: { persisted: true, workflow_enqueued: true }, ok: true }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await runSaaSFunnelsCli(["events", "send-test"], {
      env: {
        PREVENUE_API_BASE_URL: "https://legacy-host.invalid",
        PREVENUE_INGEST_API_KEY: legacyKey,
      },
      fetch: fetchImpl,
    });

    expect(result.exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(`${result.stdout}${result.stderr}`).not.toContain(legacyKey);
    expect(`${result.stdout}${result.stderr}`).not.toContain("PREVENUE_");
  });

  it("discovers Feature candidates locally without writing during a dry run", async () => {
    const cwd = await temporaryWorkspace();
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { next: "16.2.9" } }),
      "utf8",
    );
    await writeFile(
      join(cwd, "feature.ts"),
      'export const canExport = checkFeature("exports");\n',
      "utf8",
    );

    const result = await runSaaSFunnelsCli(
      ["features", "setup", "--root", "feature.ts", "--accept", "all", "--json"],
      { cwd },
    );
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.candidates).toContainEqual(expect.objectContaining({ suggestedKey: "exports" }));
    expect(payload.applied).toBe(false);
    await expect(readFile(join(cwd, ".saasfunnels/catalog.yaml"), "utf8")).rejects.toThrow();
  });
});
