import { z } from "zod";
const key = z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/);
export const quotaSchema = z
  .object({
    unit: z.string().min(1).max(80),
    period: z.enum([
      "instantaneous",
      "billing_period",
      "calendar_month",
      "lifetime",
    ]),
    aggregation: z.enum(["current", "sum", "maximum"]),
    usageSource: z.literal("customer_reported"),
  })
  .strict();
export const provenanceSchema = z
  .object({
    file: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (v) =>
          !v.startsWith("/") &&
          !v.includes("..") &&
          !/[\x00-\x1f]|\.env|secret|credential/i.test(v),
      ),
    line: z.number().int().positive().optional(),
    symbol: z.string().max(120).optional(),
  })
  .strict();
export const componentSchema = z
  .object({
    key,
    name: z.string().min(1).max(120),
    kind: z.enum(["recurring", "usage", "one_time"]),
    productKey: z.string().regex(/^prod_[A-Za-z0-9]+$/),
    prices: z
      .array(
        z.object({ key: z.string().regex(/^price_[A-Za-z0-9]+$/) }).strict(),
      )
      .min(1)
      .max(100),
    required: z.boolean(),
    relatedFeatureKey: key.optional(),
    includedQuantity: z.number().finite().nonnegative().optional(),
    quantityBasis: z.enum(["total", "additional"]).optional(),
    quantitySourceKey: key.optional(),
    usageSourceKey: key.optional(),
    provenance: z.array(provenanceSchema).max(12).optional(),
  })
  .strict();
export const developerAnswersSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(240),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        disposition: z.enum(["not_applicable", "unresolved", "configuration"]),
        configuration: z.array(z.object({
          planKey: key,
          featureKey: key.optional(),
          componentKey: key.optional(),
        }).strict().refine((v) => Boolean(v.featureKey) !== Boolean(v.componentKey), "Reference one feature or component.")).min(1).max(100).optional(),
        reason: z.string().trim().min(3).max(1000),
      })
      .strict(),
  )
  .max(100);
