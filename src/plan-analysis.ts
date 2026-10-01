import ts from "typescript";
import {
  enclosingSymbol,
  isProductNode,
  literalText,
  nonProductPath,
  parseApplicationSource,
} from "./source-analysis.js";

type Restriction = {
  line: number;
  literal: string | null;
  reference: string | null;
  negated: boolean;
  polarity: "deny" | "grant" | "unclear";
  shape: "boolean" | "limit" | "presentation";
  symbol: string;
};

/** Find the consequence of this condition, not words on neighbouring lines. */
function effect(node: ts.Node): "deny" | "limit" | null {
  let result: "deny" | "limit" | null =
    node.kind === ts.SyntaxKind.FalseKeyword ? "deny" : null;
  const visit = (child: ts.Node) => {
    if (child !== node && (ts.isFunctionLike(child) || !isProductNode(child)))
      return;
    if (ts.isReturnStatement(child)) {
      if (
        child.expression?.kind === ts.SyntaxKind.FalseKeyword ||
        child.expression?.kind === ts.SyntaxKind.NullKeyword
      )
        result = "deny";
    }
    if (ts.isThrowStatement(child)) {
      // Generic validation exceptions are not commercial access denials.
      if (
        /upgrade|paywall|forbidden|entitlement|feature.+(?:denied|unavailable)|plan.+(?:required|does not|cannot)|quota|limit exceeded/i.test(
          child.expression.getText(),
        )
      )
        result = "deny";
    }
    if (ts.isCallExpression(child)) {
      const name = ts.isIdentifier(child.expression)
        ? child.expression.text
        : ts.isPropertyAccessExpression(child.expression)
          ? child.expression.name.text
          : "";
      if (
        /^(forbidden|denyAccess|requireUpgrade|showPaywall|denyFeatureAccess)$/i.test(
          name,
        )
      )
        result = "deny";
      if (
        /^(redirect|navigate|push|replace)$/.test(name) &&
        child.arguments.some((a) =>
          /upgrade|paywall/.test(literalText(a) ?? ""),
        )
      )
        result = "deny";
      if (
        /^(status|sendStatus)$/.test(name) &&
        child.arguments.some((a) => ts.isNumericLiteral(a) && a.text === "403")
      )
        result = "deny";
    }
    if (
      ts.isPropertyAssignment(child) &&
      child.name.getText().replace(/["']/g, "") === "status" &&
      ts.isNumericLiteral(child.initializer) &&
      child.initializer.text === "403"
    )
      result = "deny";
    ts.forEachChild(child, visit);
  };
  visit(node);
  return result;
}

// A denial behind another condition is evidence of a possible restriction,
// not proof that this plan always grants or denies access.
function conditionalEffect(node: ts.Node): boolean {
  let conditional = false;
  const visit = (child: ts.Node) => {
    if (ts.isFunctionLike(child)) return;
    if (
      ts.isIfStatement(child) ||
      ts.isConditionalExpression(child) ||
      ts.isSwitchStatement(child) ||
      ts.isIterationStatement(child, false)
    )
      conditional = true;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return conditional;
}

export function planRestrictionEvidence(
  path: string,
  source: string,
): Restriction[] {
  if (nonProductPath.test(path)) return [];
  const file = parseApplicationSource(path, source);
  const results: Restriction[] = [];
  function consequence(
    node: ts.Node,
  ): { shape: Restriction["shape"]; polarity: Restriction["polarity"] } | null {
    const conditionPolarity = (
      condition: ts.Expression,
      polarity: Restriction["polarity"],
    ): Restriction["polarity"] => {
      let cursor = condition;
      let inverted = false;
      while (
        ts.isParenthesizedExpression(cursor) ||
        (ts.isPrefixUnaryExpression(cursor) &&
          cursor.operator === ts.SyntaxKind.ExclamationToken)
      ) {
        if (ts.isParenthesizedExpression(cursor)) cursor = cursor.expression;
        else {
          inverted = !inverted;
          cursor = (cursor as ts.PrefixUnaryExpression).operand;
        }
      }
      if (cursor !== node) return "unclear";
      return inverted
        ? polarity === "deny"
          ? "grant"
          : polarity === "grant"
            ? "deny"
            : "unclear"
        : polarity;
    };
    let child = node;
    for (
      let parent = node.parent;
      parent;
      child = parent, parent = parent.parent
    ) {
      if (ts.isIfStatement(parent) && child === parent.expression) {
        if (effect(parent.thenStatement) === "deny")
          return {
            shape: "boolean",
            polarity: conditionalEffect(parent.thenStatement)
              ? "unclear"
              : conditionPolarity(parent.expression, "deny"),
          };
        if (parent.elseStatement && effect(parent.elseStatement) === "deny")
          return {
            shape: "boolean",
            polarity: conditionalEffect(parent.elseStatement)
              ? "unclear"
              : conditionPolarity(parent.expression, "grant"),
          };
        return null;
      }
      if (ts.isConditionalExpression(parent) && child === parent.condition) {
        const symbol = enclosingSymbol(parent);
        if (
          /limit|quota|capacity|max(?:imum)?|allowance/i.test(symbol) &&
          ts.isNumericLiteral(parent.whenTrue) &&
          ts.isNumericLiteral(parent.whenFalse)
        )
          return { shape: "limit", polarity: "unclear" };

        if (
          ts.isJsxElement(parent.whenTrue) ||
          ts.isJsxSelfClosingElement(parent.whenTrue) ||
          ts.isJsxElement(parent.whenFalse) ||
          ts.isJsxSelfClosingElement(parent.whenFalse)
        )
          return { shape: "presentation", polarity: "unclear" };
        if (effect(parent.whenTrue) === "deny")
          return {
            shape: "boolean",
            polarity: conditionPolarity(parent.condition, "deny"),
          };
        if (effect(parent.whenFalse) === "deny")
          return {
            shape: "boolean",
            polarity: conditionPolarity(parent.condition, "grant"),
          };
        return null;
      }
      if (
        ts.isVariableDeclaration(parent) &&
        child === parent.initializer &&
        ts.isIdentifier(parent.name)
      ) {
        // Follow a local alias only inside its lexical block, not a same-named
        // variable in another module/function.
        const scope = parent.parent.parent.parent;
        if (!scope) return null;
        let found: ReturnType<typeof consequence> = null;
        const search = (candidate: ts.Node) => {
          if (
            candidate === parent ||
            (candidate !== scope && ts.isFunctionLike(candidate))
          )
            return;
          if (
            ts.isIdentifier(candidate) &&
            candidate.text === parent.name.getText() &&
            candidate.parent !== parent
          ) {
            let ancestor = candidate.parent;
            while (
              ancestor &&
              !ts.isIfStatement(ancestor) &&
              !ts.isStatement(ancestor)
            )
              ancestor = ancestor.parent;
            if (
              ancestor &&
              ts.isIfStatement(ancestor) &&
              effect(ancestor.thenStatement) === "deny"
            )
              found = { shape: "boolean", polarity: "unclear" };
          }
          ts.forEachChild(candidate, search);
        };
        search(scope);
        return found;
      }
      if (ts.isStatement(parent) || ts.isFunctionLike(parent)) return null;
    }
    return null;
  }
  const visit = (node: ts.Node) => {
    if (!isProductNode(node)) return;
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      const left = node.left.getText(file);
      if (/plan|tier|subscription|package/i.test(left)) {
        const right = node.right;
        const literal = literalText(right);
        const reference =
          ts.isIdentifier(right) || ts.isPropertyAccessExpression(right)
            ? right.getText(file)
            : null;
        const outcome = consequence(node);
        if (outcome && (literal || reference)) {
          const negated =
            node.operatorToken.kind ===
              ts.SyntaxKind.ExclamationEqualsEqualsToken ||
            node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
          results.push({
            ...outcome,
            polarity: negated
              ? outcome.polarity === "deny"
                ? "grant"
                : outcome.polarity === "grant"
                  ? "deny"
                  : "unclear"
              : outcome.polarity,
            literal,
            reference,
            negated:
              node.operatorToken.kind ===
                ts.SyntaxKind.ExclamationEqualsEqualsToken ||
              node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken,
            line:
              file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            symbol: enclosingSymbol(node),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return results;
}
