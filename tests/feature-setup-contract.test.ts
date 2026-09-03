import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSaaSFunnelsCli } from "../src/cli.js";
import { applyFeatureSetupChangesAtomically } from "../src/feature-setup.js";

async function writeFixture(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function nextFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "saasfunnels-features-"));
  await writeFixture(
    join(cwd, "package.json"),
    JSON.stringify({
      dependencies: {
        "@saasfunnels/funnels-node": "1.3.3",
        "@saasfunnels/funnels-react": "1.3.3",
        next: "16.2.9",
      },
    }),
  );
  await writeFixture(join(cwd, "package-lock.json"), "{}\n");
  await writeFixture(
    join(cwd, "app/api/projects/route.ts"),
    'export async function POST() { return checkFeature("projects"); }\n',
  );
  await writeFixture(
    join(cwd, "components/ExportButton.tsx"),
    'export const ExportButton = () => <FeatureGate featureKey="exports">Export</FeatureGate>;\n',
  );
  await writeFixture(
    join(cwd, "lib/limits.ts"),
    'export const automationUsage = { usageKey: "automation_runs" };\n',
  );
  await writeFixture(
    join(cwd, "src/.env.ts"),
    'const featureKey = "must_never_scan";\n',
  );
  await writeFixture(
    join(cwd, "node_modules/private/index.ts"),
    'const featureKey = "dependency_feature";\n',
  );
  return cwd;
}

function parseResult(stdout: string) {
  return JSON.parse(stdout) as any;
}

describe("saasfunnels features setup", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((path) => rm(path, { force: true, recursive: true })),
    );
  });

  it("discovers bounded Next.js candidates and prints complete dry-run diffs without writing", async () => {
    const cwd = await nextFixture();
    tempDirs.push(cwd);

    const result = await runSaaSFunnelsCli(
      ["features", "setup", "--accept", "all", "--json"],
      { cwd },
    );
    const output = parseResult(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output.framework).toMatchObject({
      framework: "nextjs",
      packageManager: "npm",
      saasFunnelsPackages: [
        "@saasfunnels/funnels-node",
        "@saasfunnels/funnels-react",
      ],
    });
    expect(
      output.candidates.map((candidate: any) => candidate.suggestedKey).sort(),
    ).toEqual(["automation_runs", "exports", "projects"]);
    expect(output.edits).toHaveLength(2);
    expect(
      output.edits.every((edit: any) =>
        edit.diff.includes("+++ b/.saasfunnels/"),
      ),
    ).toBe(true);
    expect(output.applied).toBe(false);
    expect(output.runtimeCheck.state).toBe("skipped");
    await expect(
      readFile(join(cwd, ".saasfunnels/catalog.yaml"), "utf8"),
    ).rejects.toThrow();
  });

  it("applies approved generated files, preserves reviewed metadata, and reruns idempotently", async () => {
    const cwd = await nextFixture();
    tempDirs.push(cwd);

    const first = await runSaaSFunnelsCli(
      ["features", "setup", "--accept", "all", "--apply", "--json"],
      { cwd },
    );
    expect(parseResult(first.stdout)).toMatchObject({
      applied: true,
      ok: true,
    });

    const manifestPath = join(cwd, ".saasfunnels/catalog.yaml");
    const generatedPath = join(cwd, ".saasfunnels/features.ts");
    const recordPath = join(cwd, ".saasfunnels/feature-installation.json");
    const manifest = parseYaml(await readFile(manifestPath, "utf8"));
    manifest.features.find(
      (feature: any) => feature.key === "projects",
    ).description = "Create and manage projects.";
    await writeFile(
      manifestPath,
      stringifyYaml(manifest, { sortMapEntries: true }),
      "utf8",
    );

    const second = await runSaaSFunnelsCli(
      ["features", "setup", "--accept", "all", "--apply", "--json"],
      { cwd },
    );
    const third = await runSaaSFunnelsCli(
      ["features", "setup", "--accept", "all", "--apply", "--json"],
      { cwd },
    );

    expect(parseYaml(await readFile(manifestPath, "utf8")).features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: "Create and manage projects.",
          key: "projects",
        }),
      ]),
    );
    expect(await readFile(generatedPath, "utf8")).toContain("AUTOMATION_RUNS");
    expect(await readFile(generatedPath, "utf8")).toContain(
      "saasFunnelsFeatureKeys",
    );
    expect(await readFile(generatedPath, "utf8")).not.toContain(
      "prevenueFeatureKeys",
    );
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({
      environment: "test",
      schemaVersion: 1,
    });
    expect(parseResult(second.stdout)).toMatchObject({
      applied: false,
      idempotent: true,
    });
    expect(parseResult(third.stdout)).toMatchObject({
      applied: false,
      idempotent: true,
    });
  });

  it("supports reject, rename, and manifest-only decisions without editing source files", async () => {
    const cwd = await nextFixture();
    tempDirs.push(cwd);
    const sourcePath = join(cwd, "components/ExportButton.tsx");
    const beforeSource = await readFile(sourcePath, "utf8");

    const discovery = parseResult(
      (
        await runSaaSFunnelsCli(
          ["features", "setup", "--accept", "all", "--json"],
          {
            cwd,
          },
        )
      ).stdout,
    );
    const projects = discovery.candidates.find(
      (candidate: any) => candidate.suggestedKey === "projects",
    );
    const result = await runSaaSFunnelsCli(
      [
        "features",
        "setup",
        "--accept",
        "all",
        "--reject",
        "exports",
        "--map",
        `${projects.id}=workspace_projects`,
        "--manifest-only",
        "--apply",
        "--json",
      ],
      { cwd },
    );
    const output = parseResult(result.stdout);

    expect(
      output.manifest.features.map((feature: any) => feature.key).sort(),
    ).toEqual(["automation_runs", "workspace_projects"]);
    expect(output.edits.map((edit: any) => edit.kind)).toEqual(["manifest"]);
    expect(await readFile(sourcePath, "utf8")).toBe(beforeSource);
    await expect(
      readFile(join(cwd, ".saasfunnels/features.ts"), "utf8"),
    ).rejects.toThrow();
  });

  it("leaves an unmarked constants file unchanged and provides manual instructions", async () => {
    const cwd = await nextFixture();
    tempDirs.push(cwd);
    const constantsPath = join(cwd, ".saasfunnels/features.ts");
    await writeFixture(constantsPath, "export const customerOwned = true;\n");

    const result = await runSaaSFunnelsCli(
      ["features", "setup", "--accept", "all", "--apply", "--json"],
      { cwd },
    );
    const output = parseResult(result.stdout);

    expect(await readFile(constantsPath, "utf8")).toBe(
      "export const customerOwned = true;\n",
    );
    expect(output.instructions[0]).toMatchObject({
      file: ".saasfunnels/features.ts",
      featureKey: "catalog",
    });
  });

  it("uses explicit interactive approval for scope, candidates, and final writes", async () => {
    const cwd = await nextFixture();
    tempDirs.push(cwd);
    const answers = ["y", "a", "a", "a", "y"];
    const prompt = vi.fn(async () => answers.shift() ?? "r");

    const result = await runSaaSFunnelsCli(["features", "setup"], {
      cwd,
      prompt,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Applied reviewed edits");
    expect(prompt).toHaveBeenCalledTimes(5);
  });

  it("runs an optional Test entitlement check without sending source content", async () => {
    const cwd = await nextFixture();
    tempDirs.push(cwd);
    const serverKey = "pv_test_server_secret_should_not_print";
    const accountId = "11111111-1111-4111-8111-111111111111";
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe(
          "https://app.prevenue.test/api/funnels/v1/runtime/entitlements/check",
        );
        expect(
          (init?.headers as Record<string, string>)["x-saasfunnels-server-key"],
        ).toBe(serverKey);
        expect(
          (init?.headers as Record<string, string>)[
            "x-saasfunnels-api-version"
          ],
        ).toBe("1");
        const body = JSON.parse(String(init?.body));
        expect(Object.keys(body).sort()).toEqual([
          "accountId",
          "apiVersion",
          "environment",
          "featureKey",
          "requestId",
        ]);
        expect(body).toMatchObject({
          accountId,
          apiVersion: 1,
          environment: "test",
        });
        expect(String(init?.body)).not.toContain("route.ts");
        return new Response(
          JSON.stringify({
            apiVersion: 1,
            data: {
              decision: {
                allowed: true,
                environment: "test",
                featureKey: body.featureKey,
                reasonCode: "PLAN_DEFAULT",
                source: "plan_default",
                value: { allowed: true },
              },
              replayed: false,
            },
            ok: true,
            requestId: body.requestId,
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    const result = await runSaaSFunnelsCli(
      [
        "features",
        "setup",
        "--accept",
        "all",
        "--apply",
        "--account-id",
        accountId,
        "--api-base-url",
        "https://app.prevenue.test",
        "--json",
      ],
      {
        cwd,
        env: { PREVENUE_FUNNELS_SERVER_KEY: serverKey },
        fetch: fetchImpl,
      },
    );

    expect(parseResult(result.stdout).runtimeCheck.state).toBe("passed");
    expect(`${result.stdout}${result.stderr}`).not.toContain(serverKey);
  });

  it("runs an explicit Test-only Feature decision without exposing the server key", async () => {
    const cwd = await nextFixture();
    tempDirs.push(cwd);
    const serverKey = "pv_test_explicit_feature_key_should_not_print";
    const accountId = "11111111-1111-4111-8111-111111111111";
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          accountId,
          apiVersion: 1,
          environment: "test",
          featureKey: "exports",
        });
        return new Response(
          JSON.stringify({
            apiVersion: 1,
            data: {
              decision: {
                allowed: false,
                environment: "test",
                featureKey: "exports",
                reasonCode: "PLAN_RULE_DENIED",
                source: "plan_default",
                value: { allowed: false },
              },
              replayed: false,
            },
            ok: true,
            requestId: body.requestId,
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    const checked = await runSaaSFunnelsCli(
      [
        "features",
        "check",
        "--feature",
        "exports",
        "--account-id",
        accountId,
        "--api-base-url",
        "https://app.prevenue.test",
        "--json",
      ],
      {
        cwd,
        env: { PREVENUE_FUNNELS_SERVER_KEY: serverKey },
        fetch: fetchImpl,
      },
    );

    expect(checked.exitCode).toBe(0);
    expect(parseResult(checked.stdout)).toMatchObject({
      decision: { allowed: false, reasonCode: "PLAN_RULE_DENIED" },
      featureKey: "exports",
      state: "passed",
    });
    expect(`${checked.stdout}${checked.stderr}`).not.toContain(serverKey);
  });

  it("refuses production Feature diagnostics before making a request", async () => {
    const fetchImpl = vi.fn();
    const result = await runSaaSFunnelsCli(
      [
        "features",
        "check",
        "--feature",
        "exports",
        "--account-id",
        "11111111-1111-4111-8111-111111111111",
        "--environment",
        "production",
      ],
      {
        env: { PREVENUE_FUNNELS_SERVER_KEY: "pv_test_unused_server_key_12345" },
        fetch: fetchImpl,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Test-only");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("builds and sends a structured CLI-to-app instrumentation handoff", async () => {
    const cwd = await nextFixture();
    tempDirs.push(cwd);
    await runSaaSFunnelsCli(
      ["features", "setup", "--accept", "all", "--apply", "--json"],
      { cwd },
    );

    const local = await runSaaSFunnelsCli(
      [
        "features",
        "handoff",
        "--repository-revision",
        "git_sha_abc123",
        "--repository-key",
        "github.com/leadengine-ai/example",
        "--discovery-roots",
        "app,lib",
        "--json",
      ],
      { cwd },
    );
    const handoff = parseResult(local.stdout);
    expect(
      handoff.bindings.map((item: any) => item.bindingKind).sort(),
    ).toEqual(["browser_presentation", "server_enforcement", "usage_reporter"]);
    expect(handoff.sdkVersions).toEqual(["1.3.3"]);
    expect(JSON.stringify(handoff)).not.toContain("sourceCode");
    expect(JSON.stringify(handoff)).not.toContain("checkFeature(");

    const apiKey = "pv_live_features_write_secret_should_not_print";
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe(
          "https://app.prevenue.test/api/developer-tools/features/instrumentation",
        );
        expect((init?.headers as Record<string, string>).authorization).toBe(
          `Bearer ${apiKey}`,
        );
        expect(JSON.parse(String(init?.body))).toMatchObject({
          environment: "test",
          repositoryRevision: "git_sha_abc123",
          validationState: "valid",
        });
        return new Response(
          JSON.stringify({
            data: {
              deduplicated: false,
              reviewUrl: "/app/settings/integrations/stripe?catalog=features",
            },
            ok: true,
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      },
    ) as unknown as typeof fetch;
    const sent = await runSaaSFunnelsCli(
      [
        "features",
        "handoff",
        "--repository-revision",
        "git_sha_abc123",
        "--repository-key",
        "github.com/leadengine-ai/example",
        "--send",
        "--api-base-url",
        "https://app.prevenue.test",
        "--json",
      ],
      { cwd, env: { PREVENUE_API_KEY: apiKey }, fetch: fetchImpl },
    );

    expect(sent.exitCode).toBe(0);
    expect(parseResult(sent.stdout)).toMatchObject({ ok: true });
    expect(`${sent.stdout}${sent.stderr}`).not.toContain(apiKey);
  });

  it("attributes a GitHub Action scan to the Action, not the CLI", async () => {
    const cwd = await nextFixture();
    tempDirs.push(cwd);
    await runSaaSFunnelsCli(
      ["features", "setup", "--accept", "all", "--apply", "--json"],
      { cwd },
    );

    let body: any = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ data: {}, ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }) as unknown as typeof fetch;

    const sent = await runSaaSFunnelsCli(
      [
        "features",
        "handoff",
        "--repository-revision",
        "pr-head@abc123",
        "--repository-key",
        "github.com/leadengine-ai/example",
        "--scan-role",
        "candidate",
        "--producer",
        "github_action",
        "--send",
        "--api-base-url",
        "https://app.saasfunnels.test",
        "--json",
      ],
      {
        cwd,
        env: { SAASFUNNELS_API_KEY: "pv_test_key_value_1234567890" },
        fetch: fetchImpl,
      },
    );

    expect(sent.exitCode).toBe(0);
    expect(body.producer).toBe("github_action");
    expect(body.scanRole).toBe("candidate");
    expect(body.schemaVersion).toBe(2);
  });

  it("validates malformed manifests and refuses Live setup", async () => {
    const cwd = await nextFixture();
    tempDirs.push(cwd);
    await writeFixture(
      join(cwd, ".saasfunnels/catalog.yaml"),
      "features: nope\n",
    );

    const validation = await runSaaSFunnelsCli(
      ["catalog", "validate", "--json"],
      { cwd },
    );
    const production = await runSaaSFunnelsCli(
      ["features", "setup", "--environment", "production", "--json"],
      { cwd },
    );

    expect(validation.exitCode).toBe(1);
    expect(parseResult(validation.stdout).ok).toBe(false);
    expect(production.exitCode).toBe(1);
    expect(production.stderr).toContain("Test-only");
  });

  it("falls back safely for unsupported projects", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "saasfunnels-unsupported-"));
    tempDirs.push(cwd);
    await writeFixture(join(cwd, "package.json"), JSON.stringify({}));
    await writeFixture(
      join(cwd, "src/license.ts"),
      'export const featureKey = "licensed_export";\n',
    );

    const result = await runSaaSFunnelsCli(
      ["features", "setup", "--accept", "all", "--manifest-only", "--json"],
      { cwd },
    );

    expect(parseResult(result.stdout)).toMatchObject({
      framework: { framework: "unsupported", packageManager: "unknown" },
      manifest: {
        features: [expect.objectContaining({ key: "licensed_export" })],
      },
    });
  });

  it("rolls every file back when an atomic rename fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "saasfunnels-rollback-"));
    tempDirs.push(cwd);
    await writeFixture(join(cwd, "one.txt"), "before one\n");
    await writeFixture(join(cwd, "two.txt"), "before two\n");
    let renameCalls = 0;

    await expect(
      applyFeatureSetupChangesAtomically(
        cwd,
        [
          { contents: "after one\n", path: "one.txt" },
          { contents: "after two\n", path: "two.txt" },
        ],
        {
          mkdir,
          read: async (path) => {
            try {
              return await readFile(path, "utf8");
            } catch {
              return null;
            }
          },
          remove: rm,
          rename: async (from, to) => {
            renameCalls += 1;
            if (renameCalls === 2) throw new Error("simulated rename failure");
            await rename(from, to);
          },
          write: writeFile,
        },
      ),
    ).rejects.toThrow("simulated rename failure");

    expect(await readFile(join(cwd, "one.txt"), "utf8")).toBe("before one\n");
    expect(await readFile(join(cwd, "two.txt"), "utf8")).toBe("before two\n");
  });
});
