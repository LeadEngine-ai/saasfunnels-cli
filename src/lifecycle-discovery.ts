import ts from "typescript";
import { isProductNode, nonProductPath } from "./source-analysis.js";
import {
  setupLifecycleEvidenceSchema,
  type SetupLifecycleFinding,
} from "./setup-lifecycle-contract.js";

function unwrap(node: ts.Expression | undefined): ts.Expression | undefined {
  while (
    node &&
    (ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node))
  )
    node = node.expression;
  return node;
}
function property(
  node: ts.Expression | undefined,
  name: string,
): ts.Expression | undefined {
  node = unwrap(node);
  if (!node || !ts.isObjectLiteralExpression(node)) return;
  // Spreads or computed/duplicate properties may override the literal value.
  if (
    node.properties.some(
      (p) =>
        ts.isSpreadAssignment(p) ||
        (p.name && ts.isComputedPropertyName(p.name)),
    )
  )
    return;
  const matches = node.properties.filter(
    (p) =>
      p.name &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === name,
  );
  if (matches.length !== 1 || !ts.isPropertyAssignment(matches[0]!)) return;
  return unwrap(matches[0].initializer);
}
function path(node: ts.Expression): string[] | null {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
    const parent = path(node.expression);
    return parent ? [...parent, node.name.text] : null;
  }
  return null;
}

/** Recognize source evidence, never execute imports, create bindings or infer
 * customer-specific eligibility. Unknown fields deliberately survive review. */
export function discoverLifecycleInSource(
  file: ts.SourceFile,
): SetupLifecycleFinding[] {
  if (nonProductPath.test(file.fileName)) return [];
  const constructors = new Set<string>();
  const clients = new Set<string>();
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "stripe" &&
      statement.importClause?.name &&
      !statement.importClause.isTypeOnly
    )
      constructors.add(statement.importClause.name.text);
  }
  for (const statement of file.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      const init = unwrap(declaration.initializer);
      if (
        ts.isIdentifier(declaration.name) &&
        init &&
        ts.isNewExpression(init) &&
        ts.isIdentifier(init.expression) &&
        constructors.has(init.expression.text)
      )
        clients.add(declaration.name.text);
    }
  }
  // Conservative name resolution: if a client name is shadowed or mutated,
  // leave that file for review instead of attributing another object's calls.
  const declarations = new Map<string, number>();
  const invalid = new Set<string>();
  const names = new Set([...constructors, ...clients]);
  const countBinding = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      if (names.has(name.text))
        declarations.set(name.text, (declarations.get(name.text) ?? 0) + 1);
    } else
      for (const item of name.elements)
        if (ts.isBindingElement(item)) countBinding(item.name);
  };
  const inspect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isBindingElement(node)
    )
      countBinding(node.name);
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name &&
      names.has(node.name.text)
    )
      invalid.add(node.name.text);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const root = path(node.left)?.[0];
      if (root) invalid.add(root);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(file);
  if (
    [...constructors].some(
      (name) => (declarations.get(name) ?? 0) > 0 || invalid.has(name),
    )
  )
    return [];
  for (const client of clients)
    if (declarations.get(client) !== 1 || invalid.has(client))
      clients.delete(client);
  const findings: SetupLifecycleFinding[] = [];
  const visit = (node: ts.Node) => {
    if (!isProductNode(node)) return;
    if (ts.isCallExpression(node) && !node.questionDotToken) {
      const parts = path(node.expression);
      if (parts && clients.has(parts[0]!)) {
        const method = parts.slice(1).join(".");
        const common = {
          subjectKey: null,
          entry: null,
          action: null,
          provenance: [
            {
              file: file.fileName,
              line:
                file.getLineAndCharacterOfPosition(node.getStart(file)).line +
                1,
            },
          ],
        };
        if (
          method === "subscriptions.create" ||
          method === "checkout.sessions.create"
        ) {
          const options =
            method === "subscriptions.create"
              ? node.arguments[0]
              : property(node.arguments[0], "subscription_data");
          const days = property(options, "trial_period_days");
          const end = property(options, "trial_end");
          if (days || end) {
            const duration =
              days &&
              ts.isNumericLiteral(days) &&
              Number.isInteger(Number(days.text)) &&
              Number(days.text) > 0 &&
              Number(days.text) <= 3650
                ? Number(days.text)
                : null;
            findings.push({
              ...common,
              family: "subscription_trial_start",
              state: duration ? "supported" : "unknown",
              reason: "A Stripe subscription trial creation call was found. Review who may start it, payment collection and what happens when it ends.",
              terms: {
                durationDays: duration,
                endBehavior: "unknown",
                paymentRequirement: "unknown",
                paidPlanKey: null,
              },
            });
            findings.push({
              ...common,
              family: "trial_conversion",
              state: duration ? "supported" : "unknown",
              reason:
                "A Stripe trial setting was found. Review its duration, payment requirement, continuation and application access behavior.",
              terms: {
                durationDays: duration,
                conversionAction: "unknown",
                conversionTiming: "unknown",
                endBehavior: "unknown",
                paymentRequirement: "unknown",
                paidPlanKey: null,
              },
            });
          }
        }
        if (method === "subscriptions.cancel")
          findings.push({
            ...common,
            family: "cancellation_save",
            state: "supported",
            reason:
              "A subscription cancellation call was found. Connect the customer cancellation entry and verify the result.",
            terms: { cancellationTiming: "immediate" },
          });
        if (method === "subscriptions.update") {
          const cancel = property(node.arguments[1], "cancel_at_period_end");
          if (cancel && cancel.kind !== ts.SyntaxKind.FalseKeyword)
            findings.push({
              ...common,
              family: "cancellation_save",
              state:
                cancel.kind === ts.SyntaxKind.TrueKeyword
                  ? "supported"
                  : "unknown",
              reason:
                "A cancellation timing setting was found. Confirm its customer-facing behavior.",
              terms: {
                cancellationTiming:
                  cancel.kind === ts.SyntaxKind.TrueKeyword
                    ? "period_end"
                    : "unknown",
              },
            });
        }
        if (method === "invoices.pay")
          findings.push({
            ...common,
            family: "failed_payment_recovery",
            state: "unknown",
            reason:
              "An invoice payment call was found. Confirm that it supports failed-payment recovery and how it coordinates with provider retries.",
            terms: { recoveryAction: "unknown", providerRecovery: "unknown" },
          });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

/** Multiple source paths can disagree. Keep common known terms, not whichever
 * file happened to be visited last; never infer customer-choice behavior. */
export function combineLifecycleFindings(
  observed: SetupLifecycleFinding[],
  reviewed: SetupLifecycleFinding[] = [],
) {
  const key = (finding: SetupLifecycleFinding) =>
    JSON.stringify([finding.family, finding.subjectKey]);
  const groups = new Map<string, SetupLifecycleFinding[]>();
  for (const finding of observed) {
    const id = key(finding);
    const group = groups.get(id);
    if (group) group.push(finding);
    else groups.set(id, [finding]);
  }
  const combined = new Map<string, SetupLifecycleFinding>();
  for (const [id, group] of groups) {
    const first = group[0]!;
    const terms = { ...first.terms } as Record<string, unknown>;
    for (const field of Object.keys(terms)) {
      const values = group.map(
        (finding) => (finding.terms as Record<string, unknown>)[field],
      );
      if (values.some((value) => value !== values[0]))
        terms[field] =
          field === "durationDays" ||
          field.endsWith("Key") ||
          field === "includedQuantity"
            ? null
            : "unknown";
    }
    combined.set(id, {
      ...first,
      terms,
      state: group.some((finding) => finding.state === "supported")
        ? "supported"
        : "unknown",
      provenance: [
        ...new Map(
          group
            .flatMap((finding) => finding.provenance)
            .map((source) => [JSON.stringify(source), source]),
        ).values(),
      ].slice(0, 12),
    } as SetupLifecycleFinding);
  }
  // Explicit reviewed declarations follow the same precedence as setup-pricing.
  for (const finding of reviewed) combined.set(key(finding), finding);
  return setupLifecycleEvidenceSchema.parse([...combined.values()]);
}
