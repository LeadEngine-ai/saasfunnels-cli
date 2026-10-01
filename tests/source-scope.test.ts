import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repositorySourceScope } from "../src/source-scope.js";
import { runFeatureSetup } from "../src/feature-setup.js";
import { discoverPlanSourceCandidates } from "../src/plan-sources.js";
import { discoverPlanBranches } from "../src/plan-branches.js";

it("all discovery stages honor ignored custom builds while retaining tracked and untracked sources", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "source-scope-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd });
    await mkdir(join(cwd, "src/cache"), { recursive: true });
    await mkdir(join(cwd, "private/tmp/custom-next"), { recursive: true });
    await writeFile(join(cwd, "src/tracked.ts"), 'checkFeature("tracked");');
    execFileSync("git", ["add", "src/tracked.ts"], { cwd });
    await writeFile(join(cwd, ".gitignore"), "/private/tmp/\nsrc/tracked.ts\n");
    await writeFile(join(cwd, "src/.gitignore"), "cache/*\n!cache/keep.ts\n");
    await writeFile(join(cwd, "src/cache/keep.ts"), 'checkFeature("kept");');
    await writeFile(join(cwd, "src/cache/bundle.ts"), "x".repeat(2_000_001));
    await writeFile(
      join(cwd, "private/tmp/custom-next/pricing.js"),
      "x".repeat(2_000_001),
    );
    await writeFile(
      join(cwd, "src/app.ts"),
      'checkFeature("exports"); if (plan === "pro") { throw new Error("upgrade"); }',
    );
    await writeFile(
      join(cwd, "src/pricing.ts"),
      'export const plans = [{ key: "pro", prices: ["price_fixture12345678"], features: { exports: true } }];',
    );
    await symlink(
      join(cwd, "private/tmp/custom-next"),
      join(cwd, "src/linked"),
    );
    const features = await runFeatureSetup({
      cwd,
      apiBaseUrl: "https://example.test",
      environment: "production",
      apply: false,
      manifestOnly: true,
      accept: ["all"],
    });
    expect(features.coverage.complete).toBe(true);
    expect(features.manifest.features.map((f) => f.key).sort()).toEqual([
      "exports",
      "kept",
      "tracked",
    ]);
    const plans = await discoverPlanSourceCandidates({ cwd });
    expect(plans.map((p) => p.path)).toEqual(["src/pricing.ts"]);
    const branches = await discoverPlanBranches({ cwd, planValues: ["pro"] });
    expect(branches.map((b) => b.repositoryPath)).toEqual(["src/app.ts"]);
    const nested = await repositorySourceScope(join(cwd, "src"));
    expect(nested("app.ts")).toBe(true);
    expect(nested("cache/bundle.ts")).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("supports standalone folders without Git", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "non-git-source-"));
  try {
    const scope = await repositorySourceScope(cwd);
    expect(scope("src/app.ts")).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
