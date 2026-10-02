import { z } from "zod";
import { quotaSchema, componentSchema } from "./setup-commercial.js";
import { isProductNode } from "./source-analysis.js";
import ts from "typescript";
import { parseDocument } from "yaml";

export type CatalogPrice = { id: string; lookupKey: string | null };
type Plan = {
  key: string;
  name: string;
  features: Record<string, boolean | number | "unlimited">;
  prices: { key: string }[];
  productKey?: string;
  quotas?: Record<string, z.infer<typeof quotaSchema>>;
  components?: Array<z.infer<typeof componentSchema>>;
};
export class PricingExtractionError extends Error {
  constructor(
    public readonly code: "no_declarations" | "needs_review",
    message: string,
  ) {
    super(message);
  }
}
const unsupported = () =>
  new PricingExtractionError(
    "needs_review",
    "Pricing contains a value that needs developer review.",
  );
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const safeKey = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z][a-z0-9_.-]{0,79}$/.test(v);
const safeProperty = (key: string) =>
  !["__proto__", "constructor", "prototype"].includes(key);

/** Interpret a small static syntax tree, never evaluate customer code or imports. */
function declarations(source: string, featuresOnly = false): unknown[] {
  const file = ts.createSourceFile(
    "pricing.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const values = new Map<string, ts.Expression>();
  const roots: ts.Expression[] = [];
  const planName =
    /^(plans?|pricing|tiers?|billingCatalog|planCatalog|subscriptionPlans)$/i;
  const containsAccess = (
    node: ts.Node,
    fields = /^(features|capabilities|quotas)$/,
  ): boolean => {
    if (
      ts.isPropertyAssignment(node) &&
      fields.test(node.name.getText(file).replace(/["']/g, ""))
    )
      return true;
    return (
      ts.forEachChild(node, (child) =>
        containsAccess(child, fields) ? true : undefined,
      ) ?? false
    );
  };
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          isProductNode(declaration)
        ) {
          values.set(declaration.name.text, declaration.initializer);
          if (
            planName.test(declaration.name.text) ||
            (containsAccess(declaration.initializer) &&
              containsAccess(
                declaration.initializer,
                /^(prices|stripePriceId)$/,
              ))
          )
            roots.push(declaration.initializer);
        }
      }
    if (
      ts.isExportAssignment(statement) &&
      containsAccess(statement.expression)
    )
      roots.push(statement.expression);
  }
  function read(
    node: ts.Expression,
    depth = 0,
    locals = new Map<string, unknown>(),
  ): unknown {
    if (depth > 30) throw unsupported();
    const next = (value: ts.Expression) => read(value, depth + 1, locals);
    if (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node)
    )
      return next(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""));
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(node)) {
      if (locals.has(node.text)) return locals.get(node.text);
      if (values.has(node.text)) return next(values.get(node.text)!);
    }
    if (ts.isArrayLiteralExpression(node))
      return node.elements.flatMap((n) => {
        if (!ts.isSpreadElement(n)) return [next(n as ts.Expression)];
        const spread = next(n.expression);
        if (!Array.isArray(spread)) throw unsupported();
        return spread;
      });
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, unknown> = Object.create(null);
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = object(next(property.expression));
          if (!spread) throw unsupported();
          Object.assign(result, spread);
          continue;
        }
        if (
          !ts.isPropertyAssignment(property) ||
          ts.isComputedPropertyName(property.name)
        )
          throw unsupported();
        const key = property.name.getText(file).replace(/^["']|["']$/g, "");
        if (!safeProperty(key)) throw unsupported();
        if (
          featuresOnly &&
          /^(prices|stripePriceId|priceId|stripeProductId|productKey)$/.test(
            key,
          )
        )
          continue;
        result[key] = next(property.initializer);
      }
      return result;
    }
    // Static array transforms are common in capability tables. Only these exact
    // AST forms are interpreted; no function, method or property is executed.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const callee = node.expression;
      if (
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Object" &&
        !values.has("Object") &&
        callee.name.text === "fromEntries" &&
        node.arguments.length === 1
      ) {
        const entries = next(node.arguments[0]!);
        if (!Array.isArray(entries) || entries.length > 10_000)
          throw unsupported();
        const result: Record<string, unknown> = Object.create(null);
        for (const entry of entries) {
          if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== "string" ||
            !safeProperty(entry[0])
          )
            throw unsupported();
          result[entry[0]] = entry[1];
        }
        return result;
      }
      if (callee.name.text === "map" && node.arguments.length === 1) {
        const array = next(callee.expression);
        const callback = node.arguments[0]!;
        if (
          !Array.isArray(array) ||
          array.length > 10_000 ||
          !ts.isArrowFunction(callback) ||
          callback.parameters.length !== 1 ||
          !ts.isIdentifier(callback.parameters[0]!.name) ||
          ts.isBlock(callback.body)
        )
          throw unsupported();
        const parameter = callback.parameters[0]!.name.text;
        return array.map((value) =>
          read(
            callback.body as ts.Expression,
            depth + 1,
            new Map([...locals, [parameter, value]]),
          ),
        );
      }
    }
    throw unsupported();
  }
  return roots.map((node) => read(node));
}

export function extractSetupPricing(
  source: string,
  kind: "json" | "yaml" | "typescript",
  catalogPrices: readonly CatalogPrice[] = [],
  options: { featuresOnly?: boolean } = {},
): Plan[] {
  if (source.length > 2_000_000)
    throw new PricingExtractionError(
      "needs_review",
      "Pricing file exceeds the 2 MB per-file limit.",
    );
  const documents: unknown[] =
    kind === "typescript"
      ? declarations(source, options.featuresOnly)
      : kind === "json"
        ? [JSON.parse(source)]
        : [
            parseDocument(source, { uniqueKeys: true }).toJS({
              maxAliasCount: 10,
            }),
          ];
  const plans = new Map<string, Plan>();
  for (const doc of documents) {
    const candidate = object(doc)?.plans ?? doc;
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
      if (
        ![
          "features",
          "capabilities",
          "quotas",
          "prices",
          "stripePriceId",
          "productKey",
        ].some((k) => k in row)
      )
        continue;
      const features: Plan["features"] = Object.create(null);
      const quotas: NonNullable<Plan["quotas"]> = {};
      for (const field of ["features", "capabilities", "quotas"]) {
        const raw = row[field];
        const entries = object(raw)
          ? Object.entries(raw as Record<string, unknown>)
          : Array.isArray(raw) && raw.every(safeKey)
            ? raw.map((key) => [key, true] as const)
            : raw === undefined
              ? []
              : null;
        if (!entries) throw unsupported();
        for (const [feature, rawAccess] of entries) {
          const structured = object(rawAccess);
          let access = rawAccess;
          if (field === "quotas" && structured) {
            const { limit, ...measurement } = structured;
            const parsed = quotaSchema.safeParse(measurement);
            if (!parsed.success) throw unsupported();
            quotas[feature] = parsed.data;
            access = limit ?? features[feature];
          }
          if (
            !safeKey(feature) ||
            !safeProperty(feature) ||
            !(
              typeof access === "boolean" ||
              access === "unlimited" ||
              (typeof access === "number" &&
                Number.isFinite(access) &&
                access >= 0)
            )
          )
            throw unsupported();
          const previous = features[feature];
          if (previous !== undefined && previous !== access) {
            // A boolean allow can accompany a quota, but a denial, different
            // quota, or unlimited/finite disagreement needs a human decision.
            if (
              previous === false ||
              access === false ||
              (previous !== true && access !== true)
            )
              throw new PricingExtractionError(
                "needs_review",
                "Conflicting access values for the same feature.",
              );
          }
          features[feature] =
            access === true && previous !== undefined ? previous : access;
        }
      }
      const rawPrices = Array.isArray(row.prices)
        ? row.prices
        : object(row.prices)
          ? Object.values(row.prices as Record<string, unknown>)
          : (row.stripePriceId ?? row.priceId)
            ? [{ key: row.stripePriceId ?? row.priceId }]
            : [];
      const prices = (options.featuresOnly ? [] : rawPrices).map((value) => {
        const price =
          typeof value === "string"
            ? value
            : (object(value)?.key ?? object(value)?.stripePriceId);
        if (typeof price === "string" && /^price_[A-Za-z0-9]+$/.test(price))
          return { key: price };
        const lookup = object(value)?.lookupKey ?? object(value)?.lookup_key;
        const matches =
          typeof lookup === "string"
            ? catalogPrices.filter((p) => p.lookupKey === lookup)
            : [];
        if (matches.length !== 1)
          throw new PricingExtractionError(
            "needs_review",
            "A Stripe lookup key has no unique match in the connected catalog.",
          );
        return { key: matches[0]!.id };
      });
      const productKey = row.productKey ?? row.stripeProductId;
      if (
        productKey !== undefined &&
        (typeof productKey !== "string" ||
          !/^prod_[A-Za-z0-9]+$/.test(productKey))
      )
        throw unsupported();
      const plan: Plan = {
        key,
        name,
        features,
        prices,
        ...(typeof productKey === "string" ? { productKey } : {}),
        ...(Object.keys(quotas).length ? { quotas } : {}),
        ...(row.components !== undefined && !options.featuresOnly
          ? {
              components: z
                .array(componentSchema)
                .max(200)
                .parse(row.components),
            }
          : {}),
      };
      if (
        plans.has(key) &&
        JSON.stringify(plans.get(key)) !== JSON.stringify(plan)
      )
        throw new PricingExtractionError(
          "needs_review",
          "Conflicting plan declarations.",
        );
      plans.set(key, plan);
    }
  }
  const featureModels = new Map<string, Set<string>>();
  for (const plan of plans.values())
    for (const [key, value] of Object.entries(plan.features)) {
      const models = featureModels.get(key) ?? new Set<string>();
      models.add(typeof value === "boolean" ? "boolean" : "limit");
      featureModels.set(key, models);
    }
  if ([...featureModels.values()].some((models) => models.size > 1))
    throw new PricingExtractionError(
      "needs_review",
      "A feature mixes capability and quota values across plans. Review its access model; no conversion was guessed.",
    );
  if (!plans.size)
    throw new PricingExtractionError(
      "no_declarations",
      "No supported pricing declaration found.",
    );
  if (plans.size > 200)
    throw new PricingExtractionError(
      "needs_review",
      "More than 200 plan declarations need review.",
    );
  return [...plans.values()];
}
