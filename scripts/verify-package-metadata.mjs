#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import PackageJson from "@npmcli/package-json";

const require = createRequire(import.meta.url);
const normalizerVersion = require("@npmcli/package-json/package.json").version;
const expectedBin = { saasfunnels: "dist/saasfunnels.js" };

export async function verifyPackageMetadata(packageRoot) {
  const manifestPath = join(packageRoot, "package.json");
  const sourceManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const workspace = await mkdtemp(join(tmpdir(), "saasfunnels-metadata-"));

  try {
    await writeFile(
      join(workspace, "package.json"),
      `${JSON.stringify(sourceManifest, null, 2)}\n`,
      "utf8",
    );
    await mkdir(join(workspace, "dist"), { recursive: true });
    await writeFile(join(workspace, expectedBin.saasfunnels), "#!/usr/bin/env node\n", "utf8");

    const changes = [];
    const packageJson = await PackageJson.fix(workspace, { changes });
    await packageJson.prepare();

    const normalizedBin = packageJson.content.bin;
    const binChanges = changes.filter((change) => change.includes('"bin'));
    if (JSON.stringify(normalizedBin) !== JSON.stringify(expectedBin)) {
      throw new Error(
        `npm-normalized package metadata lost or changed the executable: expected ${JSON.stringify(expectedBin)}; received ${JSON.stringify(normalizedBin)}`,
      );
    }
    if (binChanges.length > 0) {
      throw new Error(`npm changed the bin declaration during normalization: ${binChanges.join("; ")}`);
    }
    if (JSON.stringify(sourceManifest.bin) !== JSON.stringify(expectedBin)) {
      throw new Error(
        `Source package metadata must declare exactly ${JSON.stringify(expectedBin)}; received ${JSON.stringify(sourceManifest.bin)}`,
      );
    }

    return {
      binChanges,
      normalizer: `@npmcli/package-json@${normalizerVersion}`,
      normalizedBin,
      sourceBin: sourceManifest.bin,
    };
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

const scriptPath = resolve(process.argv[1] ?? "");
if (import.meta.url === pathToFileURL(scriptPath).href) {
  const repositoryRoot = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(dirname(fileURLToPath(import.meta.url)), "..");

  try {
    const result = await verifyPackageMetadata(repositoryRoot);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
