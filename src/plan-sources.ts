import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import {
  defaultRoots,
  ignoredSegments,
  sensitivePathPattern,
} from "./feature-setup.js";

/**
 * Finds the files that define which plan grants which feature.
 *
 * Unlike Feature instrumentation, which reports only file:line references, plan
 * mapping needs the file's *contents* — a plan object cannot be parsed from a
 * line number. That makes this the one path that uploads source, so discovery
 * deliberately only proposes: nothing is sent until a human has committed the
 * approved list, and the caller names every file before it leaves the machine.
 */

export const planSourceApprovalPath = ".saasfunnels/plan-sources.json";

// The server accepts at most 12 inputs of 512,000 characters each. Enforced
// here too, so an oversized repository gets a message naming the file rather
// than a 400 from the API.
export const maxPlanSourceFiles = 12;
export const maxPlanSourceCharacters = 512_000;

const planSourceStems = [
  "billing",
  "entitlement",
  "entitlements",
  "plan",
  "plans",
  "price",
  "prices",
  "pricing",
  "subscription",
  "subscriptions",
  "tier",
  "tiers",
];

const planSourceKindByExtension = new Map<string, PlanSourceKind>([
  [".cjs", "typescript"],
  [".js", "typescript"],
  [".json", "json"],
  [".jsonc", "json"],
  [".mjs", "typescript"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
]);

// A Stripe price identifier in a candidate file is close to proof that it
// defines commercial mapping, and it is what lets the server join the file to
// the synced Stripe catalog.
// A pricing definition states what is charged and how often. Requiring both
// separates a real price table from any file that merely mentions a plan.
const billingIntervalPattern =
  /\b(month|monthly|year|yearly|annual|annually|week|weekly|day|daily|recurring|interval|billing_period)\b/i;
const chargeAmountPattern =
  /\b(unit_amount|unit_amount_decimal|amount|amount_decimal|price|prices|currency|usd|eur|gbp|cents)\b/i;

const stripePriceIdPattern =
  /["'`]price_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{14,}["'`]/;

// A pricing definition never lives in a test or a type declaration, and both
// match the filename heuristic often enough to be noise.
const nonDefinitionPattern = /(^|\/)(__tests__|__mocks__|tests?|specs?)(\/)|\.(test|spec|d)\.[cm]?[jt]sx?$/i;

export type PlanSourceKind = "json" | "typescript" | "yaml";

export const maxNamedOnlyCandidates = 10;

export type PlanSourceCandidate = {
  characters: number;
  confidenceBasisPoints: number;
  hasStripePriceId: boolean;
  kind: PlanSourceKind;
  path: string;
  rationale: string;
};

export type PlanMappingHandoffInput = {
  content: string;
  kind: PlanSourceKind;
  label: string;
  observedAt: string;
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

function looksLikePlanSource(relativePath: string) {
  const base = relativePath.split("/").pop() ?? "";
  const stem = base.slice(0, base.length - extname(base).length).toLowerCase();
  // Split on separators so `plan-config` and `pricing.config` both match, while
  // `deployment-plans-archive` still matches on its `plans` part.
  const parts = stem.split(/[^a-z0-9]+/).filter(Boolean);
  return parts.some((part) => planSourceStems.includes(part));
}

export async function discoverPlanSourceCandidates(input: {
  cwd: string;
  excludes?: readonly string[];
  roots?: readonly string[];
}): Promise<PlanSourceCandidate[]> {
  const excludes = input.excludes ?? [];
  // Plan definitions frequently sit at the repository root or under config/,
  // not only in the source roots Feature discovery walks.
  const roots = input.roots ?? [".", "config", ...defaultRoots];
  const seen = new Set<string>();
  const candidates: PlanSourceCandidate[] = [];
  const queue = roots.map((root) => resolve(input.cwd, root));

  while (queue.length && candidates.length < 200) {
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
    if (!entryStat.isFile()) continue;
    const kind = planSourceKindByExtension.get(extname(current).toLowerCase());
    if (!kind || !relativePath || !looksLikePlanSource(relativePath)) continue;
    if (entryStat.size > maxPlanSourceCharacters) continue;

    const contents = await readFile(current, "utf8");
    const hasStripePriceId = stripePriceIdPattern.test(contents);
    // Without a Stripe price to anchor on, a filename is only a guess, so the
    // contents have to look like a price table before it is worth proposing.
    const looksPriced =
      billingIntervalPattern.test(contents) && chargeAmountPattern.test(contents);
    if (!hasStripePriceId && !looksPriced) continue;
    candidates.push({
      characters: contents.length,
      confidenceBasisPoints: hasStripePriceId ? 9_000 : 4_000,
      hasStripePriceId,
      kind,
      path: relativePath,
      rationale: hasStripePriceId
        ? "Filename suggests commercial configuration and the file references a Stripe price."
        : "Filename suggests commercial configuration and the file states amounts and billing intervals.",
    });
  }

  const sorted = candidates.sort(
    (left, right) =>
      right.confidenceBasisPoints - left.confidenceBasisPoints ||
      left.path.localeCompare(right.path),
  );
  const confirmed = sorted.filter((candidate) => candidate.hasStripePriceId);
  const namedOnly = sorted.filter((candidate) => !candidate.hasStripePriceId);
  return [...confirmed, ...namedOnly.slice(0, maxNamedOnlyCandidates)];
}

export async function readApprovedPlanSources(cwd: string): Promise<string[]> {
  try {
    const raw = await readFile(resolve(cwd, planSourceApprovalPath), "utf8");
    const parsed = JSON.parse(raw) as { files?: unknown };
    return Array.isArray(parsed.files)
      ? parsed.files.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

export async function writeApprovedPlanSources(cwd: string, files: readonly string[]) {
  const target = resolve(cwd, planSourceApprovalPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    `${JSON.stringify(
      {
        files: [...files].sort(),
        note: "Only these files are uploaded for plan mapping. Review before committing.",
        schemaVersion: 1,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return target;
}

/**
 * Reads only the approved list. Discovery output is never uploaded directly, so
 * CI can never send a file a human has not committed.
 */
export async function buildPlanMappingHandoff(input: {
  cwd: string;
  files: readonly string[];
  observedAt?: string;
}): Promise<{ inputs: PlanMappingHandoffInput[] }> {
  if (input.files.length > maxPlanSourceFiles) {
    throw new Error(
      `Plan mapping accepts at most ${maxPlanSourceFiles} files; ${input.files.length} are approved. Remove some from ${planSourceApprovalPath}.`,
    );
  }
  const observedAt = input.observedAt ?? new Date().toISOString();
  const inputs: PlanMappingHandoffInput[] = [];
  for (const file of [...input.files].sort()) {
    const relativePath = normalize(file);
    if (!allowed(relativePath, [])) {
      throw new Error(`${relativePath} is not a readable plan source path.`);
    }
    const kind = planSourceKindByExtension.get(extname(relativePath).toLowerCase());
    if (!kind) {
      throw new Error(`${relativePath} is not a supported plan source type.`);
    }
    const content = await readFile(resolve(input.cwd, relativePath), "utf8");
    if (content.length > maxPlanSourceCharacters) {
      throw new Error(
        `${relativePath} is ${content.length} characters; the limit is ${maxPlanSourceCharacters}.`,
      );
    }
    inputs.push({ content, kind, label: relativePath, observedAt });
  }
  return { inputs };
}

/** Stable across re-runs of the same revision so a repeat run restages nothing. */
export function planMappingRequestKey(input: {
  repositoryKey: string;
  repositoryRevision: string;
}) {
  const slug = `${input.repositoryKey}:${input.repositoryRevision}`
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `plans-${slug}`.slice(0, 160);
}
