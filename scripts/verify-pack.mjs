import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packOnce, run, sha256 } from "./pack-utils.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = await mkdtemp(join(tmpdir(), "saasfunnels-pack-"));

try {
  run("npm", ["run", "build"], { cwd: repositoryRoot });
  const first = packOnce(repositoryRoot, join(workspace, "first"));
  const second = packOnce(repositoryRoot, join(workspace, "second"));
  const firstSha256 = await sha256(first.tarball);
  const secondSha256 = await sha256(second.tarball);

  if (
    firstSha256 !== secondSha256 ||
    first.artifact.shasum !== second.artifact.shasum ||
    first.artifact.integrity !== second.artifact.integrity
  ) {
    throw new Error("Two isolated npm packs were not byte-identical");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        files: first.actualFiles,
        integrity: first.artifact.integrity,
        name: first.artifact.name,
        sha256: firstSha256,
        shasum: first.artifact.shasum,
        version: first.artifact.version,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(workspace, { force: true, recursive: true });
}
