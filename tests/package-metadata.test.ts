import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const verifier = join(repositoryRoot, "scripts/verify-package-metadata.mjs");
const tempDirectories: string[] = [];

async function fixture(binTarget: unknown, identityVersion = "0.2.1") {
  const root = await mkdtemp(join(tmpdir(), "saasfunnels-metadata-test-"));
  tempDirectories.push(root);
  await mkdir(join(root, "dist"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/identity.ts"), `export const SAASFUNNELS_CLI_VERSION = "${identityVersion}";\n`, "utf8");
  await writeFile(join(root, "dist/saasfunnels.js"), "#!/usr/bin/env node\n", "utf8");
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "saasfunnels", version: "0.2.1", bin: { saasfunnels: binTarget } }, null, 2)}\n`,
    "utf8",
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("npm package metadata verification", () => {
  it("preserves the canonical saasfunnels executable after npm normalization", async () => {
    const root = await fixture("dist/saasfunnels.js");
    const result = spawnSync(process.execPath, [verifier, root], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      binChanges: [],
      normalizedBin: { saasfunnels: "dist/saasfunnels.js" },
      sourceBin: { saasfunnels: "dist/saasfunnels.js" },
    });
  });

  it("rejects a package version that differs from the exported CLI version", async () => {
    const root = await fixture("dist/saasfunnels.js", "0.2.0");
    const result = spawnSync(process.execPath, [verifier, root], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLI identity version must match package.json");
  });

  it("rejects the leading-dot form that npm 11.19.0 auto-corrects during staging", async () => {
    const root = await fixture("./dist/saasfunnels.js");
    const result = spawnSync(process.execPath, [verifier, root], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'npm changed the bin declaration during normalization: "bin[saasfunnels]" script name dist/saasfunnels.js was invalid and removed',
    );
  });

  it("fails closed when npm normalization removes the executable", async () => {
    const root = await fixture(null);
    const result = spawnSync(process.execPath, [verifier, root], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm-normalized package metadata lost or changed the executable");
  });
});
