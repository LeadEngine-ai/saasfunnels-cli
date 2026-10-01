import { planConstantResolver } from "./plan-constants.js";
import { planRestrictionEvidence } from "./plan-analysis.js";
import { repositorySourceScope } from "./source-scope.js";
// Finds the places a codebase behaves differently by plan.
//
// This is the mechanical half of plan mapping. Naming what a branch gates needs
// product knowledge the customer has and we do not, so nothing here guesses at
// feature names: it reports where the product forks, on which plans, and which
// way — and leaves the naming to review.
//
// Nothing in the output is source. Plan values, file:line, and the enclosing
// symbol are the same shape the instrumentation manifest already carries.

import { createHash } from "node:crypto";
import { readdir, readFile, lstat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

import {
  defaultRoots,
  ignoredSegments,
  sensitivePathPattern,
} from "./feature-setup.js";

export const maxPlanBranchFileCharacters = 2_000_000;

// Group findings by file and enclosing symbol so unrelated restrictions stay separate.
const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const nonDefinitionPattern =
  /(^|\/)(__tests__|__mocks__|tests?|specs?|fixtures?|testing|mocks?|mock-data|stories|__stories__)(\/)|\.(test|spec|d|stories)\.[cm]?[jt]sx?$/i;

export type PlanBranchPolarity = "deny" | "grant" | "unclear";
export type PlanBranchShape = "boolean" | "limit" | "presentation";

export type PlanBranch = {
  line: number;
  planValue: string;
  polarity: PlanBranchPolarity;
  repositoryPath: string;
  shape: PlanBranchShape;
  symbol: string;
};

export type PlanBranchCluster = {
  branches: PlanBranch[];
  location: string;
  planValues: string[];
  polarity: PlanBranchPolarity;
  shape: PlanBranchShape;
};

function normalize(path: string) {
  return path.split(sep).join("/");
}

function allowed(relativePath: string, excludes: readonly string[]) {
  if (!relativePath || relativePath.startsWith("..")) return false;
  const segments = relativePath.split("/");
  if (segments.some((segment) => ignoredSegments.has(segment))) return false;
  if (segments.some((segment) => /^\.next[-.]?/.test(segment))) return false;
  if (sensitivePathPattern.test(relativePath)) return false;
  if (nonDefinitionPattern.test(relativePath)) return false;
  return !excludes.some((exclude) => relativePath.startsWith(exclude));
}

export function clusterPlanBranches(
  branches: readonly PlanBranch[],
): PlanBranchCluster[] {
  const clusters = new Map<string, PlanBranch[]>();
  for (const branch of branches) {
    const fullLocation = `${branch.repositoryPath}::${branch.symbol}`;
    const location =
      fullLocation.length <= 400
        ? fullLocation
        : `${fullLocation.slice(0, 367)}~${createHash("sha256").update(fullLocation).digest("hex").slice(0, 32)}`;
    const key = `${branch.shape}|${location}`;
    const existing = clusters.get(key);
    if (existing) existing.push(branch);
    else clusters.set(key, [branch]);
  }
  return [...clusters.entries()]
    .map(([key, grouped]) => {
      const polarities = new Set(grouped.map((branch) => branch.polarity));
      // "unclear" is absence of evidence, not evidence against, so it does not
      // outvote a sibling that plainly restricts. Only deny and grant conflict.
      const decided: PlanBranchPolarity =
        polarities.has("deny") && polarities.has("grant")
          ? "unclear"
          : polarities.has("deny")
            ? "deny"
            : polarities.has("grant")
              ? "grant"
              : "unclear";
      return {
        branches: grouped,
        location: key.slice(key.indexOf("|") + 1),
        planValues: [
          ...new Set(grouped.map((branch) => branch.planValue)),
        ].sort(),
        polarity: decided,
        shape: grouped[0]!.shape,
      };
    })
    .sort(
      (left, right) =>
        right.branches.length - left.branches.length ||
        left.location.localeCompare(right.location),
    );
}

export async function discoverPlanBranches(input: {
  cwd: string;
  excludes?: readonly string[];
  // The synced Stripe catalog's plan names. Without them every string literal
  // is a candidate, which is how `status === "active"` becomes a plan.
  planValues: readonly string[];
  roots?: readonly string[];
}): Promise<PlanBranch[]> {
  const excludes = input.excludes ?? [];
  const planValues = new Set(
    input.planValues.map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  if (!planValues.size) return [];

  const roots = input.roots ?? [".", ...defaultRoots];
  const seen = new Set<string>();
  const branches: PlanBranch[] = [];
  const sources = new Map<string, string>();
  const pending: Array<
    Omit<PlanBranch, "planValue"> & {
      literal: string | null;
      negated: boolean;
      reference: string | null;
    }
  > = [];
  const inRepository = await repositorySourceScope(input.cwd);
  const queue = roots.map((root) => resolve(input.cwd, root));

  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const relativePath = normalize(relative(input.cwd, current));
    if (
      !inRepository(relativePath) ||
      (relativePath && !allowed(relativePath, excludes))
    )
      continue;
    let entryStat;
    try {
      entryStat = await lstat(current);
    } catch {
      continue;
    }
    if (entryStat.isSymbolicLink()) continue;
    if (entryStat.isDirectory()) {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        queue.push(join(current, entry.name));
      }
      continue;
    }
    if (!entryStat.isFile() || !relativePath) continue;
    if (!codeExtensions.has(extname(current).toLowerCase())) continue;
    if (entryStat.size > maxPlanBranchFileCharacters)
      throw new Error(
        "Plan discovery found a source file above the 2 MB per-file limit. Split large source files before retrying.",
      );

    const source = await readFile(current, "utf8");
    sources.set(relativePath, source);
    for (const evidence of planRestrictionEvidence(relativePath, source)) {
      pending.push({ ...evidence, repositoryPath: relativePath });
    }
  }

  // Constants are resolved only after the whole tree is indexed: an enum is
  // rarely declared in the file that compares against it.
  const resolveConstant = planConstantResolver(sources);
  for (const item of pending) {
    const value = item.literal
      ? item.literal.toLowerCase()
      : resolveConstant(item.repositoryPath, item.reference!, item.line);
    if (!value || !planValues.has(value)) continue;
    branches.push({
      line: item.line,
      planValue: value,
      polarity: item.polarity,
      repositoryPath: item.repositoryPath,
      shape: item.shape,
      symbol: item.symbol,
    });
  }
  return branches.sort(
    (left, right) =>
      left.repositoryPath.localeCompare(right.repositoryPath) ||
      left.line - right.line,
  );
}
