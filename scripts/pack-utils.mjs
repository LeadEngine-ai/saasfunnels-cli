import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const expectedPackageFiles = [
  "LICENSE",
  "README.md",
  "dist/library.js",
  "dist/saasfunnels.js",
  "dist/types/capabilities.d.ts",
  "dist/types/feature-setup.d.ts",
  "dist/types/identity.d.ts",
  "dist/types/library.d.ts",
  "dist/types/mcp.d.ts",
  "dist/types/runtime-contracts.d.ts",
  "package.json",
].sort((left, right) => left.localeCompare(right));

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

export function validatePackReport(report) {
  const artifact = report[0];
  if (!artifact || artifact.name !== "saasfunnels") {
    throw new Error("npm pack did not produce the saasfunnels package");
  }
  const actualFiles = artifact.files
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedPackageFiles)) {
    throw new Error(
      `Unexpected package contents: expected ${expectedPackageFiles.join(", ")}; received ${actualFiles.join(", ")}`,
    );
  }
  if (!artifact.shasum || !artifact.integrity || !artifact.filename) {
    throw new Error("npm pack omitted artifact identity fields");
  }
  return { actualFiles, artifact };
}

export function packOnce(repositoryRoot, destination) {
  mkdirSync(destination, { recursive: true });
  const stdout = run(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--cache",
      join(destination, "npm-cache"),
      "--pack-destination",
      destination,
      ".",
    ],
    { cwd: repositoryRoot },
  );
  const report = JSON.parse(stdout);
  const validated = validatePackReport(report);
  return {
    ...validated,
    tarball: resolve(destination, validated.artifact.filename),
  };
}

export async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
