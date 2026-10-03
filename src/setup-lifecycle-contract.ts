// Wire contract validated against the application by its CLI contract suite.
import { z } from "zod";
import { provenanceSchema as applicationProvenanceSchema } from "./setup-commercial.js";
const applicationEvidenceKey = z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/);

const connection = z
  .object({
    key: applicationEvidenceKey,
    verification: z.enum(["discovered", "installed", "tested"]),
  })
  .strict();
const common = {
  subjectKey: applicationEvidenceKey.nullable(),
  state: z.enum(["supported", "not_applicable", "unknown"]),
  provenance: z.array(applicationProvenanceSchema).max(12),
  reason: z.string().trim().min(3).max(500),
  entry: connection.nullable(),
  action: connection.nullable(),
};
const trialTerms = {
  durationDays: z.number().int().positive().max(3650).nullable(),
  endBehavior: z.enum([
    "paid_conversion",
    "access_ends",
    "free_plan",
    "unknown",
  ]),
  paymentRequirement: z.enum([
    "required",
    "optional",
    "not_required",
    "unknown",
  ]),
};
const quantityTerms = {
  quantitySourceKey: applicationEvidenceKey.nullable(),
  quantityBasis: z.enum(["total", "additional", "unknown"]),
  includedQuantity: z.number().finite().nonnegative().nullable(),
  billingTiming: z.enum(["immediate", "period_end", "unknown"]),
};
/** Repository findings inform preparation. They are not runtime action bindings,
 * Offer approval, or server-verified installation evidence. */
export const setupLifecycleFindingSchema = z
  .discriminatedUnion("family", [
    z
      .object({
        ...common,
        family: z.literal("cancellation_save"),
        terms: z
          .object({
            cancellationTiming: z.enum([
              "immediate",
              "period_end",
              "customer_choice",
              "unknown",
            ]),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...common,
        family: z.literal("subscription_trial_start"),
        terms: z.object({ ...trialTerms, paidPlanKey: applicationEvidenceKey.nullable() }).strict(),
      })
      .strict(),
    z
      .object({
        ...common,
        family: z.literal("trial_conversion"),
        terms: z
          .object({
            ...trialTerms,
            conversionAction: z
              .enum([
                "existing_subscription_change",
                "new_subscription",
                "unknown",
              ])
              .optional(),
            conversionTiming: z
              .enum(["immediate", "trial_end", "unknown"])
              .optional(),
            paidPlanKey: applicationEvidenceKey.nullable(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...common,
        family: z.literal("feature_trial"),
        terms: z
          .object({
            ...trialTerms,
            trialKey: applicationEvidenceKey.nullable(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...common,
        family: z.literal("failed_payment_recovery"),
        terms: z
          .object({
            recoveryAction: z.enum([
              "update_payment_method",
              "retry_payment",
              "update_and_retry",
              "unknown",
            ]),
            providerRecovery: z.enum(["enabled", "disabled", "unknown"]),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...common,
        family: z.literal("reactivation"),
        terms: z
          .object({
            restoration: z.enum([
              "restore_existing",
              "new_subscription",
              "unknown",
            ]),
            paidPlanKey: applicationEvidenceKey.nullable(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...common,
        family: z.literal("seat_expansion"),
        terms: z.object(quantityTerms).strict(),
      })
      .strict(),
    z
      .object({
        ...common,
        family: z.literal("add_on_expansion"),
        terms: z.object(quantityTerms).strict(),
      })
      .strict(),
  ])
  .superRefine((finding, context) => {
    if (finding.state !== "unknown" && !finding.provenance.length)
      context.addIssue({
        code: "custom",
        path: ["provenance"],
        message: "A determination requires source evidence.",
      });
    const subjectRequired = [
      "feature_trial",
      "seat_expansion",
      "add_on_expansion",
    ].includes(finding.family);
    if (
      (subjectRequired &&
        finding.state === "supported" &&
        !finding.subjectKey) ||
      (!subjectRequired && finding.subjectKey)
    )
      context.addIssue({
        code: "custom",
        path: ["subjectKey"],
        message: subjectRequired
          ? "Identify the feature, quantity dimension, or add-on."
          : "This lifecycle applies to the product.",
      });
  });
export const setupLifecycleEvidenceSchema = z
  .array(setupLifecycleFindingSchema)
  .max(500)
  .superRefine((findings, context) => {
    const keys = findings.map((finding) =>
      JSON.stringify([finding.family, finding.subjectKey]),
    );
    if (
      findings.some(
        (finding) =>
          finding.state === "not_applicable" &&
          finding.subjectKey === null &&
          findings.some(
            (other) => other !== finding && other.family === finding.family,
          ),
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A product-wide absence cannot coexist with another finding for that journey.",
      });
    }
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        message: "Provide one finding per journey and subject.",
      });
  });
export type SetupLifecycleFinding = z.infer<typeof setupLifecycleFindingSchema>;
