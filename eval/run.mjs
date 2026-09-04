#!/usr/bin/env node
// Measures the discovery heuristics against real SaaS repositories, because
// fixtures written alongside an implementation only ever encode its author's
// intent. Deliberate to run, not part of CI: it clones about a gigabyte.
//
//   npm run eval            measure and write the report
//   npm run eval -- --check fail if the report would change (no rewrite)

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const evalDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evalDir, "..");
const cliPath = join(repoRoot, "dist", "saasfunnels.js");
const reportPath = join(evalDir, "baseline.md");
const cacheRoot =
  process.env.SAASFUNNELS_EVAL_CACHE ?? join(tmpdir(), "saasfunnels-eval");

// The same literal a real Stripe price takes, kept in step with
// stripePriceIdPattern in src/plan-sources.ts.
const stripePriceId = /["'`]price_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{14,}["'`]/;

// The five binding shapes the feature scanner recognises today.
const gateSite =
  /hasFeature\s*\(|checkFeature\s*\(|checkEntitlement\s*\(|isFeatureEnabled\s*\(|<FeatureGate|usageKey\s*[:=]|limitKey\s*[:=]/;

// A comparison of a plan-ish identifier against a string literal — the shape
// LEA-1142 proposes to extract.
const planComparison =
  /\b([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*(?:===|==|!==|!=)\s*["'`]([a-z][a-z0-9_ -]{1,31})["'`]/g;
const planIdentifier = /(^|\.)(plan|tier|level|subscription|package)s?$/i;

const codeFile = /\.(?:[cm]?[jt]sx?)$/;
// Mirrors nonDefinitionPattern in src/plan-sources.ts. Test doubles are
// excluded from ground truth as well as from discovery: a mock Stripe webhook
// payload carries a price identifier but is not a pricing definition, so
// counting it as a missed file would penalise correct behaviour.
const skipDirectory =
  /^(?:\.git|node_modules|dist|build|out|coverage|vendor|target|__snapshots__|__mocks__|__tests__|tests?|specs?|fixtures?|__fixtures__)$|^\.next/;
const skipFile = /\.(?:test|spec|d)\.[cm]?[jt]sx?$|\.min\.js$/;

async function walk(root) {
  const files = [];
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirectory.test(entry.name)) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!codeFile.test(entry.name) || skipFile.test(entry.name)) continue;
      files.push(full);
    }
  }
  return files;
}

async function ensureClone(repository) {
  const target = join(cacheRoot, repository.name);
  if (existsSync(join(target, ".git"))) {
    const { stdout } = await run("git", ["-C", target, "rev-parse", "HEAD"]);
    if (stdout.trim() === repository.commit) return target;
  }
  await mkdir(target, { recursive: true });
  // Fetching the pinned commit directly keeps the clone shallow and makes the
  // report reproducible; cloning a branch would drift with upstream.
  await run("git", ["-C", target, "init", "-q"]);
  await run("git", ["-C", target, "remote", "remove", "origin"]).catch(() => {});
  await run("git", ["-C", target, "remote", "add", "origin", repository.url]);
  await run(
    "git",
    ["-C", target, "fetch", "--depth", "1", "-q", "origin", repository.commit],
    { maxBuffer: 1024 * 1024 * 64 },
  );
  await run("git", ["-C", target, "checkout", "-q", "FETCH_HEAD"]);
  return target;
}

async function measure(root) {
  const files = await walk(root);
  const priceFiles = [];
  let gateSites = 0;
  const comparisons = new Map();
  let comparisonsNearGate = 0;

  for (const file of files) {
    let contents;
    try {
      const info = await stat(file);
      if (info.size > 2_000_000) continue;
      contents = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (stripePriceId.test(contents)) priceFiles.push(relative(root, file));

    const lines = contents.split("\n");
    const gateLines = [];
    lines.forEach((line, index) => {
      if (gateSite.test(line)) {
        gateSites += 1;
        gateLines.push(index);
      }
    });
    lines.forEach((line, index) => {
      planComparison.lastIndex = 0;
      let match;
      while ((match = planComparison.exec(line))) {
        if (!planIdentifier.test(match[1])) continue;
        comparisons.set(match[2], (comparisons.get(match[2]) ?? 0) + 1);
        // "Near" is the enclosing-block distance LEA-1142 assumes it can rely
        // on to bound false positives.
        if (gateLines.some((gateLine) => Math.abs(gateLine - index) <= 10)) {
          comparisonsNearGate += 1;
        }
      }
    });
  }
  return {
    comparisons,
    comparisonsNearGate,
    fileCount: files.length,
    gateSites,
    priceFiles: priceFiles.sort(),
  };
}

async function branches(root, planValues) {
  if (!planValues?.length) return { branches: [], clusters: [] };
  try {
    const { stdout } = await run(
      "node",
      [cliPath, "plans", "branches", "--plans", planValues.join(","), "--json"],
      { cwd: root, maxBuffer: 1024 * 1024 * 64 },
    );
    return JSON.parse(stdout);
  } catch {
    return { branches: [], clusters: [] };
  }
}

async function discover(root) {
  try {
    const { stdout } = await run("node", [cliPath, "plans", "discover", "--json"], {
      cwd: root,
      maxBuffer: 1024 * 1024 * 32,
    });
    return JSON.parse(stdout);
  } catch (error) {
    return { candidates: [], error: String(error?.message ?? error) };
  }
}

function percent(part, whole) {
  if (!whole) return "n/a";
  return `${Math.round((part / whole) * 100)}%`;
}

async function main() {
  if (!existsSync(cliPath)) {
    console.error("Build first: npm run build");
    process.exit(1);
  }
  const corpus = JSON.parse(
    await readFile(join(evalDir, "corpus.json"), "utf8"),
  );
  const rows = [];

  for (const repository of corpus.repositories) {
    process.stderr.write(`${repository.name}… `);
    const root = await ensureClone(repository);
    const measured = await measure(root);
    const discovered = await discover(root);
    const branched = await branches(root, repository.planValues);
    const candidates = discovered.candidates ?? [];
    const confirmed = candidates.filter((item) => item.hasStripePriceId);
    const namedOnly = candidates.filter((item) => !item.hasStripePriceId);
    const proposed = new Set(candidates.map((item) => item.path));
    const found = measured.priceFiles.filter((file) => proposed.has(file));

    const decided = (branched.branches ?? []).filter(
      (item) => item.polarity !== "unclear",
    );
    rows.push({
      ...repository,
      branchClusters: (branched.clusters ?? []).length,
      branchCount: (branched.branches ?? []).length,
      branchesDecided: decided.length,
      candidates: candidates.length,
      comparisons: measured.comparisons,
      comparisonsNearGate: measured.comparisonsNearGate,
      confirmed: confirmed.length,
      fileCount: measured.fileCount,
      found: found.length,
      gateSites: measured.gateSites,
      namedOnlyPaths: namedOnly.map((item) => item.path),
      priceFiles: measured.priceFiles,
      missed: measured.priceFiles.filter((file) => !proposed.has(file)),
    });
    process.stderr.write("done\n");
  }

  const totalComparisons = rows.reduce(
    (sum, row) => sum + [...row.comparisons.values()].reduce((a, b) => a + b, 0),
    0,
  );
  const totalNearGate = rows.reduce((sum, row) => sum + row.comparisonsNearGate, 0);
  const totalGateSites = rows.reduce((sum, row) => sum + row.gateSites, 0);

  const lines = [];
  lines.push("# Discovery heuristic baseline");
  lines.push("");
  lines.push(
    "Generated by `npm run eval`. Commits are pinned in `corpus.json`, so a change here is a change in the heuristics, not in the corpus.",
  );
  lines.push("");
  lines.push(
    "**Recall is measured against files containing a literal Stripe price identifier**, excluding test doubles. That is the strongest available ground truth, and it is approximate in two directions: a pricing file that reads its identifiers from environment variables is invisible to it, and a fixture carrying a price identifier is not a pricing definition, so mock and test directories are excluded from ground truth exactly as they are from discovery.",
  );
  lines.push("");
  lines.push("## Plan source discovery (LEA-1141)");
  lines.push("");
  lines.push(
    "| Repository | Declares pricing | Files scanned | Price files | Found | Recall | Confirmed | Named-only |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${row.declaresPricing ? "yes" : "no"} | ${row.fileCount} | ${row.priceFiles.length} | ${row.found} | ${percent(row.found, row.priceFiles.length)} | ${row.confirmed} | ${row.namedOnlyPaths.length} |`,
    );
  }
  lines.push("");
  for (const row of rows) {
    if (!row.missed.length && !row.namedOnlyPaths.length) continue;
    lines.push(`### ${row.name}`);
    lines.push("");
    if (row.missed.length) {
      lines.push("**Missed** — contains a Stripe price but was not proposed:");
      lines.push("");
      row.missed.forEach((file) => lines.push(`- \`${file}\``));
      lines.push("");
    }
    if (row.namedOnlyPaths.length) {
      lines.push(
        "**Named-only** — proposed without a Stripe price. Precision here is a human judgment, so the paths are listed rather than scored:",
      );
      lines.push("");
      row.namedOnlyPaths.forEach((file) => lines.push(`- \`${file}\``));
      lines.push("");
    }
  }
  lines.push("## Gate sites and plan comparisons (LEA-1142)");
  lines.push("");
  lines.push(
    "`Gate sites` counts the five binding shapes the feature scanner recognises. `Plan comparisons` counts a plan-ish identifier compared against a string literal. `Near a gate` counts those within ten lines of a gate site — the adjacency LEA-1142 assumed it could use to bound false positives.",
  );
  lines.push("");
  lines.push("| Repository | Gate sites | Plan comparisons | Near a gate |");
  lines.push("|---|---|---|---|");
  for (const row of rows) {
    const count = [...row.comparisons.values()].reduce((a, b) => a + b, 0);
    lines.push(
      `| ${row.name} | ${row.gateSites} | ${count} | ${row.comparisonsNearGate} |`,
    );
  }
  lines.push("");
  lines.push(
    `**Across the corpus: ${totalGateSites} gate sites, ${totalComparisons} plan comparisons, ${totalNearGate} of them near a gate site (${percent(totalNearGate, totalComparisons)}).**`,
  );
  lines.push("");
  lines.push("## Plan branch extraction (LEA-1142)");
  lines.push("");
  lines.push(
    "What `plans branches` extracts, filtered by the plan names in `corpus.json`. `Clusters` is the reviewable unit: one directory where the product forks by plan. `Polarity decided` counts branches where the code states which way it runs — a bail-out, an upgrade prompt, or a binding named for the restriction. The rest are reported as unclear rather than guessed.",
  );
  lines.push("");
  lines.push("| Repository | Branches | Clusters | Polarity decided |");
  lines.push("|---|---|---|---|");
  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${row.branchCount} | ${row.branchClusters} | ${row.branchesDecided} (${percent(row.branchesDecided, row.branchCount)}) |`,
    );
  }
  lines.push("");
  lines.push(
    "Plan values are resolved through enum members and string constants as well as literals, so a codebase that never compares against a literal is still visible: twenty compares only against `BillingPlanKey.PRO`.",
  );
  lines.push("");
  lines.push("### Literals compared against");
  lines.push("");
  lines.push(
    "Whether these are plan names or something else is the judgment the catalog anchor is meant to make for us. Listed so it can be checked by eye.",
  );
  lines.push("");
  for (const row of rows) {
    if (!row.comparisons.size) continue;
    const top = [...row.comparisons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([value, count]) => `\`${value}\` ×${count}`)
      .join(", ");
    lines.push(`- **${row.name}**: ${top}`);
  }
  lines.push("");
  const report = `${lines.join("\n")}\n`;

  if (process.argv.includes("--check")) {
    const existing = existsSync(reportPath)
      ? await readFile(reportPath, "utf8")
      : "";
    if (existing !== report) {
      console.error("Baseline is out of date. Run: npm run eval");
      process.exit(1);
    }
    console.log("Baseline is current.");
    return;
  }
  await writeFile(reportPath, report, "utf8");
  console.log(`Wrote ${relative(repoRoot, reportPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
