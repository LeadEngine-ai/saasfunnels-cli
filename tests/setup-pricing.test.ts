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

it.each([
  'import {z} from "zod"; export const planSchema = z.object({features:z.record(z.boolean()),prices:z.array(z.string())}).strict();',
  'import {z as schema} from "zod/v4"; export const plans = schema.object({features:schema.record(schema.boolean()),prices:schema.array(schema.string())}).optional();',
  'import * as yup from "yup"; export default yup.object({features:yup.object(),prices:yup.array()});',
  'import Joi from "joi"; export const pricing = Joi.object({features:Joi.object(),prices:Joi.array()});',
  'import {object as shape} from "valibot"; export const tiers = shape({features:featureSchema,prices:priceSchema});',
  'import {object} from "superstruct"; export const plans = object({features:featureSchema,prices:priceSchema});',
])(
  "ignores validator declarations rather than failing pricing discovery: %s",
  (source) => {
    expect(() => extractSetupPricing(source, "typescript")).toThrowError(
      expect.objectContaining({ code: "no_declarations" }),
    );
    const mixed =
      source +
      '\nexport const billingCatalog=[{id:"pro",features:{reports:true},prices:["price_pro"]}];';
    expect(extractSetupPricing(mixed, "typescript")).toEqual([
      {
        key: "pro",
        name: "pro",
        features: { reports: true },
        prices: [{ key: "price_pro" }],
      },
    ]);
  },
);
it.each([
  "const z={object:loadPlans}; export const plans=z.object({features:featureMap,prices:priceMap});",
  'import {z} from "zod"; export const plans=planSchema.parse({features:featureMap,prices:priceMap});',
  'export const schema=[{id:"pro",features:{reports:true},prices:["price_pro"]}];',
])(
  "does not exclude actual or unresolved commercial data by a schema-like name",
  (source) => {
    if (source.startsWith("export const schema"))
      expect(extractSetupPricing(source, "typescript")).toHaveLength(1);
    else
      expect(() => extractSetupPricing(source, "typescript")).toThrowError(
        expect.objectContaining({ code: "needs_review" }),
      );
  },
);
