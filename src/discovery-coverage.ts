import { createHash } from "node:crypto";
import { planRestrictionEvidence } from "./plan-analysis.js";
import { planConstantResolver } from "./plan-constants.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { ignoredSegments, sensitivePathPattern } from "./feature-setup.js";
import {
  isProductNode,
  namedFeatureEvidence,
  nonProductPath,
  parseApplicationSource,
} from "./source-analysis.js";

export type DiscoveryLimitation = {
  code: "unsupported_language" | "commercial_extensions" | "dynamic_access";
  files: string[];
  sourceFingerprint: string;
};
const exec = promisify(execFile);

/** Coverage is evidence about what was not interpreted, never an entitlement.
 * Only bounded repository-relative paths leave the machine, after approval. */
export async function discoverCoverageLimitations(
  cwd: string,
  onSource?: (file: ts.SourceFile) => void,
): Promise<DiscoveryLimitation[]> {
  const { stdout } = await exec(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
    { cwd, maxBuffer: 32 * 1024 * 1024 },
  );
  const files = [...new Set(stdout.split("\0").filter(Boolean))].sort();
  if (files.length > 50_000)
    throw new Error(
      "Feature discovery needs attention: more than 50,000 repository files. Narrow the application repository before scanning.",
    );
  const sources = new Map<string, string>();
  const results = new Map<DiscoveryLimitation["code"], Set<string>>();
  const evidence = new Map<string, string>();
  const record = (code: DiscoveryLimitation["code"], file: string) => {
    const paths = results.get(code) ?? new Set<string>();
    paths.add(file);
    results.set(code, paths);
  };
  for (const path of files) {
    if (
      path.length > 200 ||
      path.startsWith("/") ||
      path.includes("..") ||
      /[\x00-\x1f]/.test(path) ||
      sensitivePathPattern.test(path) ||
      /secret|credential/i.test(path) ||
      nonProductPath.test(path) ||
      path
        .split("/")
        .some(
          (part) => ignoredSegments.has(part) || /^\.next(?:[-.]|$)/.test(part),
        )
    )
      continue;
    const stat = await lstat(join(cwd, path)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    if (
      /\.(?:py|rb|go|rs|java|kt|cs|php|ex|exs|scala|swift|vue|svelte)$/.test(
        path,
      )
    ) {
      if (stat.size > 2_000_000)
        throw new Error(
          "Unsupported source exceeds the 2 MB scan limit. Narrow the discovery scope before retrying.",
        );
      evidence.set(
        path,
        createHash("sha256")
          .update(await readFile(join(cwd, path)))
          .digest("hex"),
      );
      record("unsupported_language", path);
      continue;
    }
    if (
      !/\.[cm]?[jt]sx?$/.test(path) ||
      /\.d\.ts$/.test(path) ||
      stat.size > 2_000_000
    )
      continue;
    const source = await readFile(join(cwd, path), "utf8");
    sources.set(path, source);
    evidence.set(path, createHash("sha256").update(source).digest("hex"));
    const file = parseApplicationSource(path, source);
    onSource?.(file);
    const visit = (node: ts.Node) => {
      if (!isProductNode(node)) return;
      if (
        (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
        node.initializer
      ) {
        const name = node.name.getText(file).replace(/["'_-]/g, "");
        let initializer = node.initializer;
        while (
          ts.isAsExpression(initializer) ||
          ts.isSatisfiesExpression(initializer) ||
          ts.isParenthesizedExpression(initializer)
        )
          initializer = initializer.expression;
        const commercialFields = (node: ts.Node): boolean => {
          if (
            ts.isPropertyAssignment(node) &&
            /^(?:prices?|quotas?|features?|entitlements?|.*Limit|.*Allowance|lookupKey|amount|unit_amount)$/i.test(
              node.name.getText(file).replace(/["']/g, ""),
            )
          )
            return true;
          return (
            ts.forEachChild(node, (child) =>
              commercialFields(child) ? true : undefined,
            ) ?? false
          );
        };
        const entitlementObject =
          /trialfeatures|trialentitlements|externalentitlements/i.test(name) &&
          ts.isObjectLiteralExpression(initializer) &&
          initializer.properties.length > 0;
        if (
          /(?:addons?|capacitybands?|usagerates?|meteredpricing|trialfeatures|trialentitlements|externalentitlements|seatpricing)/i.test(
            name,
          ) &&
          (ts.isArrayLiteralExpression(initializer) ||
            ts.isObjectLiteralExpression(initializer)) &&
          (entitlementObject || commercialFields(initializer))
        )
          record("commercial_extensions", path);
      }
      if (ts.isCallExpression(node)) {
        const name = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : "";
        if (
          /^(?:has|check|require|assert|enforce|evaluate|canUse|is)(?:Feature|Entitlement|Quota|UsageLimit)/i.test(
            name,
          ) &&
          !namedFeatureEvidence(path, node.getText(file)).length
        )
          record("dynamic_access", path);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const resolvePlanConstant = planConstantResolver(sources);
  for (const [path, source] of sources) {
    if (
      planRestrictionEvidence(path, source).some(
        (finding) =>
          finding.reference &&
          !resolvePlanConstant(path, finding.reference, finding.line),
      )
    )
      record("dynamic_access", path);
  }
  return [...results].map(([code, paths]) => ({
    code,
    files: [...paths].sort().slice(0, 12),
    // Include all affected files in the receipt, even when the UI path list is capped.
    sourceFingerprint: createHash("sha256")
      .update(
        JSON.stringify(
          [...paths].sort().map((path) => [path, evidence.get(path)]),
        ),
      )
      .digest("hex"),
  }));
}
