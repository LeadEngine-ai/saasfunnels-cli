import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { runFeatureSetup } from "../src/feature-setup.js";
import { runGuidedSetup } from "../src/setup-run.js";

it.each([
  ["unsupported", "app.py", 'hasFeature("exports")'],
  ["byte budget", "page.ts", "//" + "a".repeat(2_000_001)],
])(
  "does not silently complete unsupported %s coverage",
  async (_kind, file, source) => {
    const cwd = await mkdtemp(join(tmpdir(), "coverage-"));
    try {
      await mkdir(join(cwd, "src"));
      await writeFile(join(cwd, "src", file), source);
      execFileSync("git", ["init", "--quiet"], { cwd });
      execFileSync(
        "git",
        ["remote", "add", "origin", "https://github.com/example/app.git"],
        { cwd },
      );
      execFileSync("git", ["add", "."], { cwd });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--quiet",
          "-m",
          "Fixture",
        ],
        { cwd },
      );
      const evidence: any[] = [];
      const updates: any[] = [];
      const output = await runGuidedSetup({
        cwd,
        key: "fixture",
        apiBaseUrl: "https://app.example",
        send: true,
        resume: false,
        fetch: async (url, init) => {
          const path = new URL(String(url)).pathname;
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          if (path.endsWith("/context"))
            return Response.json({
              workspaceId: "workspace",
              generation: "a".repeat(64),
              installationId: "installation",
              integrationId: "stripe",
              environment: "production",
              catalogReady: true,
              planNames: [],
            });
          if (path.endsWith("/runs")) {
            if (body.state) updates.push(body);
            return Response.json({
              run: { id: "run", sequence: body.sequence ?? 0, receipts: {} },
            });
          }
          evidence.push(body);
          return Response.json({ accepted: true });
        },
      });
      if (_kind === "unsupported") {
        expect(output.exitCode).toBe(0);
        expect(
          evidence.find((e) => e.stage === "plans").evidence.limitations,
        ).toEqual([{ code: "unsupported_language", files: ["src/app.py"] }]);
        expect(output.stdout).toContain("review findings");
      } else {
        expect(output.exitCode).toBe(2);
        expect(output.stderr).toContain("Feature discovery needs attention");
        expect(evidence).toEqual([]);
        expect(updates.at(-1)).toMatchObject({ state: "failed" });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

it("permits production proposals but never production apply or interactive mutation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "production-scan-"));
  try {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src/index.ts"), 'checkFeature("exports");');
    const options = {
      cwd,
      apiBaseUrl: "https://app.example",
      environment: "production" as const,
      manifestOnly: true,
      apply: false,
    };
    const output = await runFeatureSetup(options);
    expect(output.coverage.complete).toBe(true);
    expect(output.applied).toBe(false);
    await expect(
      readFile(join(cwd, ".saasfunnels/catalog.yaml")),
    ).rejects.toThrow();
    await expect(runFeatureSetup({ ...options, apply: true })).rejects.toThrow(
      "Test-only",
    );
    await expect(
      runFeatureSetup({ ...options, prompt: async () => "yes" }),
    ).rejects.toThrow("Test-only");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("scans beyond 500 files, 2 MB and 200 candidates without losing the last feature", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "large-app-"));
  try {
    await mkdir(join(cwd, "src"));
    for (let i = 0; i < 750; i++)
      await writeFile(
        join(cwd, `src/feature-${String(i).padStart(4, "0")}.ts`),
        `//${"x".repeat(5000)}\ncheckFeature("feature_${i}");`,
      );
    const result = await runFeatureSetup({
      cwd,
      apiBaseUrl: "https://app.example",
      environment: "production",
      apply: false,
      manifestOnly: true,
      accept: ["all"],
    });
    expect(result.coverage.complete).toBe(true);
    expect(result.scannedFileCount).toBe(750);
    expect(result.coverage.scannedBytes).toBeGreaterThan(2_000_000);
    expect(result.manifest.features).toHaveLength(750);
    expect(result.manifest.features.some((f) => f.key === "feature_749")).toBe(
      true,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("does not scan test, generated, overlapping or symlinked source twice", async () => {
  const { symlink } = await import("node:fs/promises");
  const cwd = await mkdtemp(join(tmpdir(), "scope-app-"));
  try {
    await mkdir(join(cwd, "src/nested"), { recursive: true });
    await writeFile(
      join(cwd, "src/nested/app.ts"),
      'checkFeature("real_feature");',
    );
    await writeFile(
      join(cwd, "src/example.test.ts"),
      'checkFeature("fake_feature");',
    );
    await symlink(join(cwd, "src"), join(cwd, "src/loop"));
    const result = await runFeatureSetup({
      cwd,
      apiBaseUrl: "https://app.example",
      environment: "test",
      apply: false,
      manifestOnly: true,
      accept: ["all"],
      include: ["src", "src/nested"],
    });
    expect(result.scannedFileCount).toBe(1);
    expect(result.manifest.features.map((f) => f.key)).toEqual([
      "real_feature",
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("fresh guided discovery ignores an invalid old manifest without modifying it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fresh-discovery-"));
  try {
    await mkdir(join(cwd, "src"));
    await mkdir(join(cwd, ".saasfunnels"));
    await writeFile(join(cwd, "src/access.ts"), 'checkFeature("exports");');
    await writeFile(join(cwd, ".saasfunnels/catalog.yaml"), "invalid: [");
    const options = {
      cwd,
      apiBaseUrl: "https://app.example",
      environment: "production" as const,
      apply: false,
      manifestOnly: true,
      accept: ["all"],
    };
    const result = await runFeatureSetup({ ...options, freshDiscovery: true });
    expect(result.manifest.features.map((f) => f.key)).toEqual(["exports"]);
    expect(await readFile(join(cwd, ".saasfunnels/catalog.yaml"), "utf8")).toBe(
      "invalid: [",
    );
    await expect(runFeatureSetup(options)).rejects.toThrow();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
