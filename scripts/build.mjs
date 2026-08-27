import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(repositoryRoot, "dist");
const outfile = resolve(outdir, "saasfunnels.js");
const libraryOutfile = resolve(outdir, "library.js");
const typeOutdir = resolve(outdir, "types");

const banner =
  'import { createRequire as __saasfunnelsCreateRequire } from "node:module"; const require = __saasfunnelsCreateRequire(import.meta.url);';

await rm(outdir, { force: true, recursive: true });
await mkdir(outdir, { recursive: true });
await build({
  banner: { js: banner },
  bundle: true,
  entryPoints: [resolve(repositoryRoot, "src/saasfunnels.ts")],
  format: "esm",
  legalComments: "none",
  minify: false,
  outfile,
  packages: "bundle",
  platform: "node",
  sourcemap: false,
  target: "node22",
});
await chmod(outfile, 0o755);

await build({
  banner: { js: banner },
  bundle: true,
  entryPoints: [resolve(repositoryRoot, "src/library.ts")],
  format: "esm",
  legalComments: "none",
  minify: false,
  outfile: libraryOutfile,
  packages: "bundle",
  platform: "node",
  sourcemap: false,
  target: "node22",
});

const declarations = spawnSync(
  process.execPath,
  [
    resolve(repositoryRoot, "node_modules/typescript/bin/tsc"),
    resolve(repositoryRoot, "src/library.ts"),
    "--ignoreConfig",
    "--declaration",
    "--emitDeclarationOnly",
    "--esModuleInterop",
    "--forceConsistentCasingInFileNames",
    "--lib",
    "ES2024,DOM,DOM.Iterable",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--outDir",
    typeOutdir,
    "--skipLibCheck",
    "--strict",
    "--target",
    "ES2024",
    "--types",
    "node",
  ],
  { encoding: "utf8" },
);
if (declarations.status !== 0) {
  throw new Error(
    `Type declaration build failed: ${declarations.stderr || declarations.stdout}`,
  );
}
await copyFile(
  resolve(repositoryRoot, "src/runtime-contracts.d.ts"),
  resolve(typeOutdir, "runtime-contracts.d.ts"),
);
