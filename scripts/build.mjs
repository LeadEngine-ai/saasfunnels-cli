import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(repositoryRoot, "dist");
const outfile = resolve(outdir, "saasfunnels.js");

await rm(outdir, { force: true, recursive: true });
await mkdir(outdir, { recursive: true });
await build({
  banner: {
    js: 'import { createRequire as __saasfunnelsCreateRequire } from "node:module"; const require = __saasfunnelsCreateRequire(import.meta.url);',
  },
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
