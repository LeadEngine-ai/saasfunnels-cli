import { expect, it } from "vitest";
import {
  extractSetupPricing,
  PricingExtractionError,
} from "../src/setup-pricing.js";

it("reads static spreads, capability maps, numeric separators, quotas and catalog lookup keys", () => {
  const source = `const featureKeys = ["export", "events"] as const;
  const base = {export:false};
  const formatter = new Intl.NumberFormat("en-US");
  export const billingCatalog = [
    {id:"launch", name:"Launch", capabilities:{...base,events:true}, quotas:{events:25_000}, prices:{month:{lookupKey:"launch_month"}}},
    {id:"scale", name:"Scale", capabilities:Object.fromEntries(featureKeys.map(key=>[key,true])), quotas:{events:"unlimited"}, prices:{month:{lookupKey:"scale_month"}}}
  ] as const;`;
  const result = extractSetupPricing(source, "typescript", [
    { id: "price_launch", lookupKey: "launch_month" },
    { id: "price_scale", lookupKey: "scale_month" },
  ]);
  expect(result).toEqual([
    {
      key: "launch",
      name: "Launch",
      features: { export: false, events: 25000 },
      prices: [{ key: "price_launch" }],
    },
    {
      key: "scale",
      name: "Scale",
      features: { export: true, events: "unlimited" },
      prices: [{ key: "price_scale" }],
    },
  ]);
});
it("does not treat recommendation capabilities or unrelated runtime helpers as plan definitions", () => {
  expect(() =>
    extractSetupPricing(
      'const recommendations = { upsell: {capabilities:["upgrade"]} }; const helper = loadConfig();',
      "typescript",
    ),
  ).toThrowError(expect.objectContaining({ code: "no_declarations" }));
});
it.each([
  "export const plans=getPlans(process.env.SECRET);",
  'export const plans=[{key:"pro",features:callUntrusted()}];',
  'export const plans=[{key:"pro",features:Object.fromEntries(keys.map(key=>fetch(key)))}];',
  'export const plans=[{key:"pro",features:{__proto__:{export:true}}}];',
])("does not execute dynamic declarations: %s", (source) =>
  expect(() => extractSetupPricing(source, "typescript")).toThrow(
    PricingExtractionError,
  ),
);
it("requires unique lookup-key matches instead of guessing", () => {
  const source = JSON.stringify({
    plans: [
      {
        key: "pro",
        features: { export: true },
        prices: { month: { lookupKey: "pro_month" } },
      },
    ],
  });
  expect(() => extractSetupPricing(source, "json", [])).toThrow("unique match");
  expect(() =>
    extractSetupPricing(source, "json", [
      { id: "price_a", lookupKey: "pro_month" },
      { id: "price_b", lookupKey: "pro_month" },
    ]),
  ).toThrow("unique match");
});
