// Finds the places a codebase behaves differently by plan.
//
// This is the mechanical half of plan mapping. Naming what a branch gates needs
// product knowledge the customer has and we do not, so nothing here guesses at
// feature names: it reports where the product forks, on which plans, and which
// way — and leaves the naming to review.
//
// Nothing in the output is source. Plan values, file:line, and the enclosing
// symbol are the same shape the instrumentation manifest already carries.

import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

import {
  defaultRoots,
  ignoredSegments,
  sensitivePathPattern,
} from "./feature-setup.js";

export const maxPlanBranchFileCharacters = 2_000_000;

// Clusters are keyed on the file's own directory. A fixed path depth cannot
// serve both layouts: three segments reaches `apps/web/ui` in dub's monorepo
// and collapses 126 sites into 5 useless groups, while reaching past the whole
// tree in a flat repository. A directory is where one feature's code sits in
// either layout.
const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const nonDefinitionPattern =
  /(^|\/)(__tests__|__mocks__|tests?|specs?|fixtures?|testing|mocks?|mock-data|stories|__stories__)(\/)|\.(test|spec|d|stories)\.[cm]?[jt]sx?$/i;

// A plan-ish identifier compared against a string literal or a constant.
const comparisonPattern =
  /\b([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*(===|==|!==|!=)\s*(?:["'`]([A-Za-z][A-Za-z0-9_ -]{0,39})["'`]|([A-Za-z_$][\w$]*(?:\.[\w$]+){0,2}))/g;
// Matched loosely on purpose. Real code writes `planKey`, `currentPlan.planKey`,
// and `targetPlanKey`, so anchoring at the end of the name misses most of it.
// Over-matching here is safe because the catalog decides: `subscriptionStatus
// === "active"` passes this test and is then rejected, because "active" is not
// a plan.
const planIdentifierPattern = /(plan|tier|level|subscription|package)/i;

// Enum members and string constants, so `plan === BillingPlanKey.PRO` resolves.
// Twenty is entirely invisible without this: it never compares against a
// literal.
const enumOpenPattern = /\b(?:enum|const)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*)?\{/;
const memberPattern =
  /^\s*([A-Za-z_$][\w$]*)\s*[:=]\s*["'`]([A-Za-z][A-Za-z0-9_ -]{0,39})["'`]/;
const blockClosePattern = /^\s*\}/;
const simpleConstPattern =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w<>[\]|\s]+)?=\s*["'`]([A-Za-z][A-Za-z0-9_ -]{0,39})["'`]/;

// Denial is the one polarity a line-based read can claim with confidence: the
// matched branch bails out or offers an upgrade. Anything else stays unclear
// rather than being guessed at from plan rank.
const denialPattern =
  /\b(?:throw|redirect|notFound|forbidden)\b|\breturn\s+(?:null|false|undefined)\b|upgrade|paywall|locked|disabled|403/i;
// Real code names the restriction it is computing — `const needsHigherPlan =
// plan === "free" || plan === "pro"` states the polarity in the binding itself.
const restrictionNamePattern =
  /\b(?:needs?|requires?|must)[A-Z_]|\b(?:is|has)?(?:Locked|Blocked|Restricted|Gated|Disabled)|upgrade|paywall/i;
// A branch selecting between numbers is a quota, which maps to a limit rule
// rather than a boolean one.
const numericBranchPattern = /\?\s*[\d_]+\s*:\s*[\d_]+|:\s*[\d_]+\s*[,;)]/;

// Pricing tables, upgrade banners, and plan badges branch on plan constantly,
// and none of it gates anything — they are the surfaces that *sell* plans. They
// were the largest source of disagreement between static and assisted reads,
// because static saw "upgrade" and called it denial while the model saw nothing
// being withheld and called it a grant. Both were wrong: it is not a mapping.
const renderPattern = /<[A-Z][\w.]*|className=|return\s*\(/;
const marketingPattern =
  /\b(?:upgrade|get started|contact sales|choose|current plan|most popular|per month|per year|\/mo\b|\/yr\b)|\$\{?\d/i;
// Control flow that leaves the branch: the mark of a gate rather than a label.
const escapePattern =
  /\breturn\s+(?:null|false|undefined)\b|\bthrow\b|\bredirect\b|\bnotFound\b/;

export type PlanBranchPolarity = "deny" | "grant" | "unclear";
export type PlanBranchShape = "boolean" | "limit" | "presentation";

// `Enum.MEMBER` and `CONST` to their string values. A name bound to two
// different values anywhere in the tree is dropped rather than guessed at.
type ConstantIndex = Map<string, string | null>;

function collectConstants(lines: readonly string[], into: ConstantIndex) {
  let container: string | null = null;
  for (const line of lines) {
    if (container && blockClosePattern.test(line)) {
      container = null;
      continue;
    }
    if (!container) {
      const open = line.match(enumOpenPattern);
      if (open?.[1]) {
        container = open[1];
        continue;
      }
      const simple = line.match(simpleConstPattern);
      if (simple?.[1] && simple[2]) record(into, simple[1], simple[2]);
      continue;
    }
    const member = line.match(memberPattern);
    if (member?.[1] && member[2]) {
      record(into, `${container}.${member[1]}`, member[2]);
      record(into, member[1], member[2]);
    }
  }
}

function record(into: ConstantIndex, name: string, value: string) {
  const normalized = value.toLowerCase();
  if (!into.has(name)) {
    into.set(name, normalized);
    return;
  }
  // Ambiguous across the tree, so it resolves to nothing.
  if (into.get(name) !== normalized) into.set(name, null);
}

function resolveConstant(index: ConstantIndex, reference: string) {
  const direct = index.get(reference);
  if (direct !== undefined) return direct;
  // `BillingPlanKey.PRO` may have been indexed under a shorter qualification.
  const segments = reference.split(".");
  if (segments.length > 1) {
    const tail = segments.slice(-2).join(".");
    const viaTail = index.get(tail);
    if (viaTail !== undefined) return viaTail;
    const viaMember = index.get(segments[segments.length - 1]!);
    if (viaMember !== undefined) return viaMember;
  }
  return undefined;
}

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

function nearestSymbol(lines: string[], lineIndex: number) {
  for (let index = lineIndex; index >= Math.max(0, lineIndex - 20); index -= 1) {
    const match = lines[index]?.match(
      /(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/,
    );
    if (match?.[1]) return match[1];
  }
  return "module";
}

function assignedName(line: string) {
  return line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/)?.[1] ?? null;
}

/**
 * Where a comparison is bound to a name, the lines that later read that name.
 * `const isProPlan = planKey === PRO` says nothing on its own; what the code
 * does with `isProPlan` is the whole answer, and it is usually elsewhere.
 */
function bindingUsages(lines: readonly string[], lineIndex: number, name: string) {
  const reference = new RegExp(`\\b${name}\\b`);
  const usages: string[] = [];
  lines.forEach((line, index) => {
    if (index === lineIndex || !reference.test(line)) return;
    usages.push(line);
  });
  return usages.join("\n");
}

function shapeAt(lines: readonly string[], lineIndex: number): PlanBranchShape {
  const line = lines[lineIndex] ?? "";
  const window = lines.slice(lineIndex, lineIndex + 4).join("\n");
  if (numericBranchPattern.test(line)) return "limit";
  // A branch that renders marketing copy and never escapes is choosing what to
  // show, not what to allow.
  if (
    renderPattern.test(window) &&
    marketingPattern.test(window) &&
    !escapePattern.test(window)
  ) {
    return "presentation";
  }
  return "boolean";
}

function polarityAt(
  lines: string[],
  lineIndex: number,
  negated: boolean,
): PlanBranchPolarity {
  // The consequent usually sits on the comparison's own line or just below it.
  const window = lines.slice(lineIndex, lineIndex + 3).join("\n");
  const bound = assignedName(lines[lineIndex] ?? "");
  const named = bound ? restrictionNamePattern.test(bound) : false;
  // Following the binding is what reaches codebases that never write the
  // decision inline — twenty and unkey resolved nothing without it.
  const usages = bound ? bindingUsages(lines, lineIndex, bound) : "";
  if (!named && !denialPattern.test(window) && !denialPattern.test(usages)) {
    return "unclear";
  }
  // `plan !== "free"` guarding a bail-out denies everyone *except* free, which
  // is the opposite reading, and not one to assert from three lines of text.
  return negated ? "unclear" : "deny";
}

export function clusterPlanBranches(
  branches: readonly PlanBranch[],
): PlanBranchCluster[] {
  const clusters = new Map<string, PlanBranch[]>();
  for (const branch of branches) {
    const segments = branch.repositoryPath.split("/");
    const location = segments.slice(0, -1).join("/") || ".";
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
        planValues: [...new Set(grouped.map((branch) => branch.planValue))].sort(),
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
  const constants: ConstantIndex = new Map();
  const pending: Array<
    Omit<PlanBranch, "planValue"> & {
      literal: string | null;
      negated: boolean;
      reference: string | null;
    }
  > = [];
  const queue = roots.map((root) => resolve(input.cwd, root));

  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const relativePath = normalize(relative(input.cwd, current));
    if (relativePath && !allowed(relativePath, excludes)) continue;
    let entryStat;
    try {
      entryStat = await stat(current);
    } catch {
      continue;
    }
    if (entryStat.isDirectory()) {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        queue.push(join(current, entry.name));
      }
      continue;
    }
    if (!entryStat.isFile() || !relativePath) continue;
    if (!codeExtensions.has(extname(current).toLowerCase())) continue;
    if (entryStat.size > maxPlanBranchFileCharacters) continue;

    const lines = (await readFile(current, "utf8")).split(/\r?\n/);
    collectConstants(lines, constants);
    lines.forEach((line, lineIndex) => {
      comparisonPattern.lastIndex = 0;
      let match;
      while ((match = comparisonPattern.exec(line))) {
        const [, identifier, operator, literal, reference] = match;
        if (!planIdentifierPattern.test(identifier ?? "")) continue;
        if (!literal && !reference) continue;
        pending.push({
          line: lineIndex + 1,
          literal: literal ?? null,
          negated: operator!.startsWith("!"),
          polarity: polarityAt(lines, lineIndex, operator!.startsWith("!")),
          reference: reference ?? null,
          repositoryPath: relativePath,
          shape: shapeAt(lines, lineIndex),
          symbol: nearestSymbol(lines, lineIndex),
        });
      }
    });
  }

  // Constants are resolved only after the whole tree is indexed: an enum is
  // rarely declared in the file that compares against it.
  for (const item of pending) {
    const value = item.literal
      ? item.literal.toLowerCase()
      : resolveConstant(constants, item.reference!);
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
