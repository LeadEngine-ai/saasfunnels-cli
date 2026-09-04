import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  clusterPlanBranches,
  discoverPlanBranches,
  type PlanBranch,
} from "../src/plan-branches.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

async function fixture(files: Record<string, string>) {
  const cwd = await mkdtemp(join(tmpdir(), "saasfunnels-branches-"));
  tempDirs.push(cwd);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(cwd, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return cwd;
}

const plans = ["free", "pro", "enterprise"];

describe("plan branch discovery", () => {
  it("keeps comparisons against catalog plans and drops everything else", async () => {
    const cwd = await fixture({
      "src/gate.ts": [
        'if (plan === "pro") { enableExports(); }',
        'if (status === "active") { render(); }',
        'if (level === "enterprise") { sso(); }',
        'if (mode === "error") { log(); }',
        'if (logLevel === "warn") { log(); }',
      ].join("\n"),
    });

    const branches = await discoverPlanBranches({ cwd, planValues: plans });

    // `level === "enterprise"` qualifies on its value, not its name; `status`
    // and `mode` are rejected because their values are not plans.
    expect(branches.map((branch) => branch.planValue).sort()).toEqual([
      "enterprise",
      "pro",
    ]);
  });

  it("returns nothing without a catalog rather than guessing", async () => {
    const cwd = await fixture({
      "src/gate.ts": 'if (plan === "pro") { enableExports(); }\n',
    });
    expect(await discoverPlanBranches({ cwd, planValues: [] })).toEqual([]);
  });

  it("reads denial from a bail-out, an upgrade prompt, or the binding's own name", async () => {
    const cwd = await fixture({
      "src/a.ts": 'if (plan === "free") {\n  throw new Error("upgrade");\n}\n',
      "src/b.tsx": 'const gate = plan === "free" ? <UpgradeModal /> : children;\n',
      "src/c.ts": 'const needsHigherPlan = plan === "free" || plan === "pro";\n',
      "src/d.ts": 'if (plan === "pro") {\n  renderChart();\n}\n',
    });

    const branches = await discoverPlanBranches({ cwd, planValues: plans });
    const polarity = Object.fromEntries(
      branches.map((branch) => [`${branch.repositoryPath}:${branch.line}`, branch.polarity]),
    );

    expect(polarity["src/a.ts:1"]).toBe("deny");
    expect(polarity["src/b.tsx:1"]).toBe("deny");
    expect(polarity["src/c.ts:1"]).toBe("deny");
    // Nothing here says which way the branch runs, so it is not decided.
    expect(polarity["src/d.ts:1"]).toBe("unclear");
  });

  it("marks a branch between two numbers as a limit rather than a boolean", async () => {
    const cwd = await fixture({
      "src/quota.ts": 'const seats = plan === "free" ? 3 : 100;\n',
    });
    const [branch] = await discoverPlanBranches({ cwd, planValues: plans });
    expect(branch?.shape).toBe("limit");
  });

  it("never reads a sensitive path", async () => {
    const cwd = await fixture({
      "src/secrets/keys.ts": 'if (plan === "pro") { useKey(); }\n',
      ".env.ts": 'if (plan === "pro") { useKey(); }\n',
    });
    expect(await discoverPlanBranches({ cwd, planValues: plans })).toEqual([]);
  });

  it("groups by directory and lets stated denial outweigh silence", () => {
    const branch = (overrides: Partial<PlanBranch>): PlanBranch => ({
      line: 1,
      planValue: "free",
      polarity: "unclear",
      repositoryPath: "app/billing/gate.ts",
      shape: "boolean",
      symbol: "gate",
      ...overrides,
    });

    const clusters = clusterPlanBranches([
      branch({}),
      branch({ line: 9, planValue: "pro", polarity: "deny" }),
      branch({ repositoryPath: "app/exports/gate.ts" }),
    ]);

    expect(clusters).toHaveLength(2);
    const billing = clusters.find((item) => item.location === "app/billing")!;
    expect(billing.planValues).toEqual(["free", "pro"]);
    // One sibling plainly restricts and none contradicts it, so the group does.
    expect(billing.polarity).toBe("deny");
    expect(
      clusters.find((item) => item.location === "app/exports")!.polarity,
    ).toBe("unclear");
  });

  it("does not decide a group that contradicts itself", () => {
    const base: PlanBranch = {
      line: 1,
      planValue: "free",
      polarity: "deny",
      repositoryPath: "app/billing/gate.ts",
      shape: "boolean",
      symbol: "gate",
    };
    const [cluster] = clusterPlanBranches([
      base,
      { ...base, line: 4, polarity: "grant" },
    ]);
    expect(cluster?.polarity).toBe("unclear");
  });
});
