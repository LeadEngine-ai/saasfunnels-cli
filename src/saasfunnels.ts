#!/usr/bin/env node

import { createInterface } from "node:readline/promises";

import { runSaaSFunnelsCli } from "./cli.js";

const argv = process.argv.slice(2);
const interactiveFeatureSetup =
  !argv.includes("--json") &&
  !argv.includes("--non-interactive") &&
  ((argv[0] === "features" && argv[1] === "setup") ||
    (argv[0] === "catalog" && ["discover", "diff"].includes(argv[1] ?? "")));
const prompts = interactiveFeatureSetup
  ? createInterface({ input: process.stdin, output: process.stdout })
  : null;

let result;
try {
  result = await runSaaSFunnelsCli(argv, {
    cwd: process.cwd(),
    env: process.env,
    prompt: prompts ? (message) => prompts.question(message) : undefined,
  });
} finally {
  prompts?.close();
}

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
