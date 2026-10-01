import ts from "typescript";
import { parseDocument } from "yaml";

type Plan = {
  key: string;
  name: string;
  features: Record<string, boolean | number>;
  prices: { key: string }[];
  productKey?: string;
};
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const safeKey = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z][a-z0-9_.-]{0,79}$/.test(v);

/** Reads literal declarations only. No eval, imports, calls, or environment access. */
function declarations(source: string) {
  const file = ts.createSourceFile(
    "pricing.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const values = new Map<string, ts.Expression>();
  const roots: ts.Expression[] = [];
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          values.set(declaration.name.text, declaration.initializer);
          roots.push(declaration.initializer);
        }
      }
    if (ts.isExportAssignment(statement)) roots.push(statement.expression);
  }
  function read(node: ts.Expression, depth = 0): unknown {
    if (depth > 20) throw new Error("Unsupported pricing expression");
    if (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node)
    )
      return read(node.expression, depth + 1);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(node) && values.has(node.text))
      return read(values.get(node.text)!, depth + 1);
    if (ts.isArrayLiteralExpression(node))
      return node.elements.map((n) => read(n as ts.Expression, depth + 1));
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, unknown> = Object.create(null);
      for (const property of node.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          ts.isComputedPropertyName(property.name)
        )
          throw new Error("Unsupported pricing expression");
        result[property.name.getText(file).replace(/^["']|["']$/g, "")] = read(
          property.initializer,
          depth + 1,
        );
      }
      return result;
    }
    throw new Error("Unsupported pricing expression");
  }
  return roots.map((node) => read(node));
}

export function extractSetupPricing(
  source: string,
  kind: "json" | "yaml" | "typescript",
): Plan[] {
  if (source.length > 512_000) throw new Error("Pricing file exceeds limit");
  const documents: unknown[] =
    kind === "typescript"
      ? declarations(source)
      : kind === "json"
        ? [JSON.parse(source)]
        : [
            parseDocument(source, { uniqueKeys: true }).toJS({
              maxAliasCount: 10,
            }),
          ];
  const plans = new Map<string, Plan>();
  for (const doc of documents) {
    const root = object(doc);
    const candidate = root?.plans ?? doc;
    const rows = Array.isArray(candidate)
      ? candidate
      : object(candidate)
        ? Object.entries(candidate as Record<string, unknown>).map(
            ([key, value]) => ({ key, ...object(value) }),
          )
        : [];
    for (const value of rows) {
      const row = object(value);
      if (!row) continue;
      const key = row.key ?? row.planKey ?? row.slug ?? row.id;
      const name = row.name ?? row.displayName ?? key;
      if (
        !safeKey(key) ||
        typeof name !== "string" ||
        !name.length ||
        name.length > 120
      )
        continue;
      // A generic object is not evidence of a plan.
      if (
        !("features" in row) &&
        !("prices" in row) &&
        !("stripePriceId" in row) &&
        !("productKey" in row)
      )
        continue;
      const features: Plan["features"] = {};
      const rawFeatures = object(row.features);
      if (rawFeatures)
        for (const [feature, access] of Object.entries(rawFeatures)) {
          if (
            !safeKey(feature) ||
            !(
              typeof access === "boolean" ||
              (typeof access === "number" &&
                Number.isFinite(access) &&
                access >= 0)
            )
          )
            throw new Error("Feature access needs manual review");
          features[feature] = access;
        }
      else if (Array.isArray(row.features) && row.features.every(safeKey)) {
        for (const feature of row.features) features[feature] = true;
      } else if (row.features !== undefined)
        throw new Error("Feature access needs manual review");
      const rawPrices = Array.isArray(row.prices)
        ? row.prices
        : (row.stripePriceId ?? row.priceId)
          ? [{ key: row.stripePriceId ?? row.priceId }]
          : [];
      const prices = rawPrices.map((value) => {
        const price =
          typeof value === "string"
            ? value
            : (object(value)?.key ?? object(value)?.stripePriceId);
        if (typeof price !== "string" || !/^price_[A-Za-z0-9]+$/.test(price))
          throw new Error("Price needs manual review");
        return { key: price };
      });
      const productKey = row.productKey ?? row.stripeProductId;
      if (
        productKey !== undefined &&
        (typeof productKey !== "string" ||
          !/^prod_[A-Za-z0-9]+$/.test(productKey))
      )
        throw new Error("Product needs manual review");
      const plan: Plan = {
        key,
        name,
        features,
        prices,
        ...(typeof productKey === "string" ? { productKey } : {}),
      };
      if (
        plans.has(key) &&
        JSON.stringify(plans.get(key)) !== JSON.stringify(plan)
      )
        throw new Error("Conflicting plan declarations");
      plans.set(key, plan);
    }
  }
  if (!plans.size) throw new Error("No supported pricing declaration found");
  if (plans.size > 200) throw new Error("Too many pricing declarations");
  return [...plans.values()];
}
