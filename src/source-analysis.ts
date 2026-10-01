import ts from "typescript";

/** Context rules concern executable scopes, never feature identifiers. */
const nonProductName =
  /(?:^|[_-])(?:test|tests|fixture|fixtures|mock|mocks|demo|sample|e2e|storybook)(?:$|[_-])|(?:^|[a-z])(?:TestFixture|Fixture|Mock|Demo|E2e|E2E|Storybook)(?:[A-Z]|$)|^(?:test|mock|demo|fixture|sample|e2e)[A-Z]/;
export const nonProductPath =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|fixtures?|mocks?|stories|examples?|qa)(?:\/|$)|(?:^|[\/._-])(?:fixture|fixtures|e2e|mock|stories)(?:[._-]|$)|\.(?:test|spec|stories|d)\.[cm]?[jt]sx?$/i;

export function parseApplicationSource(path: string, source: string) {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function nodeName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isVariableDeclaration(node)) &&
    node.name
  )
    return node.name.getText();
  return null;
}

function demoCondition(expression: ts.Expression): boolean | null {
  if (ts.isParenthesizedExpression(expression))
    return demoCondition(expression.expression);
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const value = demoCondition(expression.operand);
    return value === null ? null : !value;
  }
  const text = expression.getText();
  if (
    /^(?:isDemo|demoMode|isTest|[A-Z_]*(?:E2E|FIXTURES|MOCKS)[A-Z_]*)$/.test(
      text,
    ) ||
    /^(?:process\.env|import\.meta\.env)\.[A-Z_]*(?:E2E|FIXTURES|MOCKS)[A-Z_]*$/.test(
      text,
    )
  )
    return true;
  if (ts.isBinaryExpression(expression)) {
    const op = expression.operatorToken.kind;
    const equality = [
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
    ].includes(op);
    const inequality = [
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(op);
    if (!equality && !inequality) return null;
    const right = expression.right;
    const value = ts.isStringLiteral(right)
      ? right.text
      : right.kind === ts.SyntaxKind.TrueKeyword
        ? "1"
        : right.kind === ts.SyntaxKind.FalseKeyword
          ? "0"
          : null;
    const nodeEnv = /(?:^|\.)NODE_ENV$/.test(expression.left.getText());
    const positive =
      nodeEnv && value === "test" ? true : demoCondition(expression.left);
    if (positive === null || (nodeEnv && value !== "test")) return null;
    const enabled = nodeEnv || value === "1" || value === "true";
    if (!enabled && value !== "0" && value !== "false") return null;
    return equality ? enabled === positive : enabled !== positive;
  }
  return null;
}

export function isProductNode(node: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node;
    current;
    current = current.parent
  ) {
    const name = nodeName(current);
    if (name && nonProductName.test(name)) return false;
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current)) {
      const value = demoCondition(
        ts.isIfStatement(current) ? current.expression : current.condition,
      );
      if (value === null) continue;
      let child = node;
      while (child.parent && child.parent !== current) child = child.parent;
      const excluded = ts.isIfStatement(current)
        ? value
          ? current.thenStatement
          : current.elseStatement
        : value
          ? current.whenTrue
          : current.whenFalse;
      if (child === excluded) return false;
    }
  }
  return true;
}

export function enclosingSymbol(node: ts.Node): string {
  for (
    let current: ts.Node | undefined = node;
    current;
    current = current.parent
  ) {
    const name = nodeName(current);
    if (name) return name.slice(0, 120);
  }
  return "module";
}

export function literalText(node: ts.Node | undefined): string | null {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

export type NamedFeatureEvidence = {
  key: string;
  model: "boolean" | "limit";
  kind:
    | "server_enforcement"
    | "browser_presentation"
    | "usage_reporter"
    | "funnel_trigger";
  line: number;
  symbol: string;
  reason: string;
};

export function namedFeatureEvidence(
  path: string,
  source: string,
): NamedFeatureEvidence[] {
  if (nonProductPath.test(path)) return [];
  const file = parseApplicationSource(path, source);
  const findings: NamedFeatureEvidence[] = [];
  const add = (
    node: ts.Node,
    key: string | null,
    model: NamedFeatureEvidence["model"],
    kind: NamedFeatureEvidence["kind"],
    reason: string,
  ) => {
    if (!key || !/^[a-z][a-z0-9_.-]{0,79}$/.test(key)) return;
    findings.push({
      key,
      model,
      kind,
      reason,
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      symbol: enclosingSymbol(node),
    });
  };
  const visit = (node: ts.Node) => {
    if (!isProductNode(node)) return;
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : "";
      const featureCall =
        /^(?:has|check|require|assert|canUse|enforce|authorize|evaluate|is).*?(?:Feature|Entitlement)(?:Enabled|Access)?$/i.test(
          name,
        ) ||
        (/^(?:has|check|require|assert|canUse|enforce|authorize|evaluate|is).*Capability(?:Enabled|Access)?$/i.test(
          name,
        ) &&
          /billing|plan|subscription|commercial|product/i.test(name));
      const limitCall =
        /^(?:check|require|assert|enforce|report|track|consume).*?(?:Quota|Usage|Limit)$/i.test(
          name,
        );
      if (featureCall || limitCall) {
        // A single literal argument is unambiguous. For multi-argument helpers,
        // require a named key in an options object or a single literal overall.
        const literals = node.arguments
          .map(literalText)
          .filter((v): v is string => v !== null);
        let key = literals.length === 1 ? literals[0]! : null;
        for (const arg of node.arguments)
          if (ts.isObjectLiteralExpression(arg)) {
            for (const p of arg.properties)
              if (
                ts.isPropertyAssignment(p) &&
                /^(featureKey|feature|capability|entitlement|quotaKey|limitKey|meterKey)$/.test(
                  p.name.getText(file).replace(/["']/g, ""),
                )
              )
                key = literalText(p.initializer);
          }
        add(
          node,
          key,
          limitCall ? "limit" : "boolean",
          limitCall ? "usage_reporter" : "server_enforcement",
          limitCall
            ? "Application usage or limit check"
            : "Application access check",
        );
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (
        /^(FeatureGate|EntitlementGate|CapabilityGate)$/.test(
          node.tagName.getText(file),
        )
      )
        for (const prop of node.attributes.properties)
          if (
            ts.isJsxAttribute(prop) &&
            /^(featureKey|feature|capability)$/.test(prop.name.getText(file))
          )
            add(
              prop,
              prop.initializer && ts.isJsxExpression(prop.initializer)
                ? literalText(prop.initializer.expression)
                : literalText(prop.initializer),
              "boolean",
              "browser_presentation",
              "Application feature visibility gate",
            );
    }
    if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText(file).replace(/["']/g, "");
      if (/^(usageKey|limitKey|meterKey|featureLimit)$/.test(key))
        add(
          node,
          literalText(node.initializer),
          "limit",
          "usage_reporter",
          "Application usage or limit declaration",
        );
      if (/^(deniedFeatureKey|featureDenied|onFeatureDenied)$/.test(key))
        add(
          node,
          literalText(node.initializer),
          "boolean",
          "funnel_trigger",
          "Application denied-access trigger",
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}
