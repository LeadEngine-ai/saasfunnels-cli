import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { packOnce, run } from "./pack-utils.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = await mkdtemp(join(tmpdir(), "saasfunnels-install-"));

function runExecutable(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      SAASFUNNELS_API_BASE_URL: "https://app.saasfunnels.ai",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `saasfunnels ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

try {
  run("npm", ["run", "build"], { cwd: repositoryRoot });
  const packed = packOnce(repositoryRoot, join(workspace, "package"));
  const consumer = join(workspace, "consumer");
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--cache",
      join(workspace, "npm-cache"),
      "--prefix",
      consumer,
      packed.tarball,
    ],
    { cwd: repositoryRoot },
  );
  const executable = join(consumer, "node_modules", ".bin", "saasfunnels");

  const help = runExecutable(executable, ["--help"]);
  if (!help.includes("SaaSFunnels CLI") || help.includes("PREVENUE_")) {
    throw new Error("Installed help output did not expose only the SaaSFunnels identity");
  }
  const verification = JSON.parse(runExecutable(executable, ["verify", "--json"]));
  if (!verification.ok) {
    throw new Error("Installed saasfunnels verify command did not pass");
  }

  const child = spawn(executable, ["mcp", "serve"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  child.stdin.end(
    [
      {
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "saasfunnels-release-smoke", version: "1.0.0" },
          protocolVersion: "2025-03-26",
        },
      },
      { id: 2, jsonrpc: "2.0", method: "tools/list" },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n") + "\n",
  );

  const exitCode = await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Installed MCP server did not exit after stdin closed"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`Installed MCP server failed (${exitCode}): ${stderr.join("")}`);
  }

  const messages = stdout
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (
    messages.length !== 2 ||
    messages[0]?.result?.serverInfo?.name !== "saasfunnels" ||
    messages[1]?.result?.tools?.[0]?.name !== "validate_event_payload"
  ) {
    throw new Error("Installed MCP server returned an unexpected identity or tool registry");
  }
  if (stdout.join("").includes("PREVENUE_")) {
    throw new Error("Installed MCP output exposed a legacy environment name");
  }

  process.stdout.write(
    `${JSON.stringify({ help: "passed", mcp: "passed", verify: "passed" }, null, 2)}\n`,
  );
} finally {
  await rm(workspace, { force: true, recursive: true });
}
