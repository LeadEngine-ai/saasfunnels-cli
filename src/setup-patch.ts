import { z } from "zod";
import { extractSetupPricing, type CatalogPrice } from "./setup-pricing.js";
const key = z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/);
export const baselineSchema = z
  .object({
    revision: z.string().uuid().nullable(),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
const removal = z
  .object({
    planKey: key,
    featureKey: key.optional(),
    componentKey: key.optional(),
    quotaKey: key.optional(),
  })
  .strict()
  .refine(
    (v) =>
      [v.featureKey, v.componentKey, v.quotaKey].filter(Boolean).length <= 1,
  );
const fileSchema = z
  .object({
    mode: z.enum(["patch", "snapshot"]).default("patch"),
    plans: z.array(z.record(z.string(), z.unknown())).max(200),
    removals: z.array(removal).max(2000).default([]),
    withdrawDeveloperAnswers: z
      .array(z.string().min(1).max(240))
      .max(100)
      .optional(),
    withdrawLifecycle: z
      .array(
        z
          .object({
            family: z.string().min(1).max(80),
            subjectKey: z.string().min(1).max(80).nullable(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
  })
  .strict();
/** Normalize locally while retaining which fields the developer actually supplied. */
export function extractSetupPatch(
  source: string,
  catalog: readonly CatalogPrice[],
  baseline: ReturnType<typeof extractSetupPricing>,
) {
  const raw = JSON.parse(source);
  const file = fileSchema.parse(Array.isArray(raw) ? { plans: raw } : raw);
  if (new Set(file.plans.map((p) => p.key)).size !== file.plans.length)
    throw new Error("Duplicate plan patches.");
  const patches = file.plans.map((row) => {
    if (
      Object.keys(row).some(
        (k) =>
          ![
            "key",
            "name",
            "productKey",
            "features",
            "quotas",
            "prices",
            "components",
            "provenance",
          ].includes(k),
      )
    )
      throw new Error("Use normalized plan fields in corrections.");
    const prior = baseline.find((p) => p.key === row.key);
    const merged = {
      ...prior,
      ...row,
      features: { ...prior?.features, ...((row.features as object) ?? {}) },
    };
    const normalized = extractSetupPricing(
      JSON.stringify({ plans: [merged] }),
      "json",
      catalog,
    )[0]!;
    if (file.mode === "snapshot") return normalized;
    const patch: Record<string, unknown> = { key: normalized.key };
    for (const field of Object.keys(row))
      if (field !== "key")
        patch[field] =
          (normalized as unknown as Record<string, unknown>)[field] ??
          row[field];
    if (!prior && !row.name) patch.name = normalized.name;
    if (row.features)
      patch.features = Object.fromEntries(
        Object.keys(row.features as object).map((k) => [
          k,
          normalized.features[k],
        ]),
      );
    return patch;
  });
  return {
    mode: file.mode,
    patches,
    removals: file.removals,
    ...(file.withdrawDeveloperAnswers
      ? { withdrawDeveloperAnswers: file.withdrawDeveloperAnswers }
      : {}),
    ...(file.withdrawLifecycle
      ? { withdrawLifecycle: file.withdrawLifecycle }
      : {}),
  };
}
