import { describe, expect, it } from "vitest";
import { extractSetupPricing } from "../src/setup-pricing.js";
import { developerAnswersSchema } from "../src/setup-commercial.js";
const plan = {
  key: "scale",
  name: "Scale",
  productKey: "prod_scale",
  features: { members: 10, reports: true },
  quotas: {
    members: {
      unit: "members",
      period: "instantaneous",
      aggregation: "current",
      usageSource: "customer_reported",
    },
  },
  prices: [{ key: "price_scale" }],
  components: [
    {
      key: "members",
      name: "Extra members",
      kind: "recurring",
      productKey: "prod_members",
      prices: [{ key: "price_members" }],
      required: false,
      relatedFeatureKey: "members",
      includedQuantity: 10,
      quantityBasis: "total",
      quantitySourceKey: "members",
    },
  ],
};
describe("reviewable commercial evidence", () => {
  it.each(["json", "typescript"] as const)(
    "preserves explicit quotas and allowances from %s without guessing",
    (kind) => {
      const source =
        kind === "json"
          ? JSON.stringify({ plans: [plan] })
          : `export const plans = ${JSON.stringify([plan])} as const;`;
      expect(extractSetupPricing(source, kind)).toEqual([plan]);
    },
  );
  it("keeps additional quantity basis distinct from total", () => {
    const additional = structuredClone(plan);
    additional.components[0]!.quantityBasis = "additional";
    expect(
      extractSetupPricing(JSON.stringify({ plans: [additional] }), "json")[0]
        ?.components?.[0]?.quantityBasis,
    ).toBe("additional");
  });
  it("rejects a quota with missing measurement semantics", () => {
    const broken: any = structuredClone(plan);
    delete broken.quotas.members.period;
    expect(() =>
      extractSetupPricing(JSON.stringify({ plans: [broken] }), "json"),
    ).toThrow();
  });
  it("cannot approve configuration through developer answers", () => {
    expect(
      developerAnswersSchema.safeParse([
        {
          id: "question",
          fingerprint: "a".repeat(64),
          disposition: "approved",
          reason: "Reviewed",
        },
      ]).success,
    ).toBe(false);
  });
});
