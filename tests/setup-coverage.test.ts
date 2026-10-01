import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { runFeatureSetup } from "../src/feature-setup.js";
import { runGuidedSetup } from "../src/setup-run.js";

it.each([
  ["unsupported", "app.py", 'hasFeature("exports")'],
  ["candidate cap", "page.ts", Array.from({length:220}, (_, i) => `checkFeature("feature_${i}");`).join("\n")],
  ["byte budget", "page.ts", "//" + "a".repeat(2_000_001)],
])("does not submit successful evidence for %s coverage", async (_kind, file, source) => {
  const cwd = await mkdtemp(join(tmpdir(), "coverage-"));
  try {
    await mkdir(join(cwd, "src")); await writeFile(join(cwd, "src", file), source);
    execFileSync("git", ["init", "--quiet"], {cwd});
    execFileSync("git", ["remote", "add", "origin", "https://github.com/example/app.git"], {cwd});
    execFileSync("git", ["add", "."], {cwd});
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "Fixture"], {cwd});
    const evidence: unknown[] = []; const updates: any[] = [];
    const output = await runGuidedSetup({cwd, key:"fixture", apiBaseUrl:"https://app.example", send:true, resume:false, fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path.endsWith("/context")) return Response.json({workspaceId:"workspace", generation:"a".repeat(64), installationId:"installation", integrationId:"stripe", environment:"production", catalogReady:true, planNames:[]});
      if (path.endsWith("/runs")) { if (body.state) updates.push(body); return Response.json({run:{id:"run",sequence:body.sequence ?? 0,receipts:{}}}); }
      evidence.push(body); return Response.json({accepted:true});
    }});
    expect(output.exitCode).toBe(2); expect(output.stderr).toContain("scan limit");
    expect(evidence).toEqual([]); expect(updates.at(-1)).toMatchObject({state:"failed"});
  } finally { await rm(cwd, {recursive:true,force:true}); }
});

it("permits production proposals but never production apply or interactive mutation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "production-scan-"));
  try {
    await mkdir(join(cwd,"src")); await writeFile(join(cwd,"src/index.ts"),'checkFeature("exports");');
    const options = {cwd, apiBaseUrl:"https://app.example", environment:"production" as const, manifestOnly:true, apply:false};
    const output = await runFeatureSetup(options);
    expect(output.coverage.complete).toBe(true); expect(output.applied).toBe(false);
    await expect(readFile(join(cwd,".saasfunnels/catalog.yaml"))).rejects.toThrow();
    await expect(runFeatureSetup({...options, apply:true})).rejects.toThrow("Test-only");
    await expect(runFeatureSetup({...options, prompt:async()=>"yes"})).rejects.toThrow("Test-only");
  } finally { await rm(cwd,{recursive:true,force:true}); }
});
