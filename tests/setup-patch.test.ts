import { it, expect } from "vitest";
import { extractSetupPatch } from "../src/setup-patch.js";
const baseline = [
  {
    key: "pro",
    name: "Pro",
    features: { contacts: true, seats: 10 },
    prices: [{ key: "price_pro" }],
    provenance: [{ file: "lib/pricing.ts", line: 8 }],
  },
];
it("keeps absent fields absent when normalizing a fresh-worktree correction", () => {
  const result = extractSetupPatch(
    '{"plans":[{"key":"pro","features":{"contacts":false}}]}',
    [],
    baseline,
  );
  expect(result).toEqual({
    mode: "patch",
    removals: [],
    patches: [{ key: "pro", features: { contacts: false } }],
  });
});
it("retains validated provenance and only resolves explicitly supplied prices", () => {
  const result = extractSetupPatch(
    '{"plans":[{"key":"pro","prices":[{"lookupKey":"pro_monthly"}],"provenance":[{"file":"lib/billing.ts","line":12}]}]}',
    [{ id: "price_new", lookupKey: "pro_monthly" }],
    baseline,
  );
  expect(result.patches[0]).toEqual({
    key: "pro",
    prices: [{ key: "price_new" }],
    provenance: [{ file: "lib/billing.ts", line: 12 }],
  });
});
it("represents exact removals explicitly and rejects source/credential fields", () => {
  expect(
    extractSetupPatch(
      '{"plans":[],"removals":[{"planKey":"pro","featureKey":"contacts"}]}',
      [],
      baseline,
    ).removals,
  ).toHaveLength(1);
  expect(() =>
    extractSetupPatch(
      '{"plans":[{"key":"pro","source":"never upload"}]}',
      [],
      baseline,
    ),
  ).toThrow();
  expect(() =>
    extractSetupPatch(
      '{"plans":[{"key":"pro","provenance":[{"file":".env.local"}]}]}',
      [],
      baseline,
    ),
  ).toThrow();
});
