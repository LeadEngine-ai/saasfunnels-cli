import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { discoverCoverageLimitations } from "../src/discovery-coverage.js";
it("reports unsupported backends, dynamic access and optional pricing without sending contents", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "discovery-coverage-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    await mkdir(join(cwd, "src"));
    await mkdir(join(cwd, "vendor"));
    await mkdir(join(cwd, ".agents"));
    await writeFile(join(cwd, ".agents/utility.py"), "not_source()");
    await mkdir(join(cwd, "tests"));
    await writeFile(join(cwd, ".gitignore"), "ignored/\n");
    await mkdir(join(cwd, "ignored"));
    await writeFile(join(cwd, "ignored/backend.py"), "not_source()");
    await writeFile(join(cwd, "vendor/backend.rb"), "not_source()");
    await writeFile(join(cwd, "tests/fixture.go"), "not_source()");
    await writeFile(
      join(cwd, "src/backend.py"),
      "assert entitlement('PRIVATE_SOURCE')",
    );
    await writeFile(
      join(cwd, "src/access.ts"),
      'checkFeature(featureFromRequest); checkFeature("exports");',
    );
    await writeFile(
      join(cwd, "src/pricing.ts"),
      'const optionalAddOns = [{name:"extra seats",prices:{month:10}}] as const; const trialEntitlements={exports:true};',
    );
    const limitations = await discoverCoverageLimitations(cwd);
    expect(limitations).toEqual(
      expect.arrayContaining([
        { code: "unsupported_language", files: ["src/backend.py"] },
        { code: "dynamic_access", files: ["src/access.ts"] },
        { code: "commercial_extensions", files: ["src/pricing.ts"] },
      ]),
    );
    expect(JSON.stringify(limitations)).not.toMatch(
      /PRIVATE_SOURCE|vendor|fixture|ignored|utility/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
