import { describe, expect, it } from "vitest";
import { parseApplicationSource } from "../src/source-analysis.js";
import {
  discoverLifecycleInSource,
  combineLifecycleFindings,
} from "../src/lifecycle-discovery.js";
const header =
  'import Stripe from "stripe"; const billing = new Stripe(process.env.STRIPE_SECRET!);\n';
function scan(source: string, file = "src/billing.ts") {
  return discoverLifecycleInSource(parseApplicationSource(file, source));
}
describe("automatic lifecycle source discovery", () => {
  it("discovers actual trial duration without inventing payment, access, plan or binding semantics", () => {
    const findings = scan(
      header +
        'async function subscribe() { return billing.subscriptions.create({ trial_period_days: 14, customer: "never-upload-customer" }); }',
    );
    expect(findings).toMatchObject([
      { family: "subscription_trial_start", state: "supported", terms: { durationDays: 14, endBehavior: "unknown", paymentRequirement: "unknown", paidPlanKey: null }, entry: null, action: null, provenance: [{ file: "src/billing.ts", line: 2 }] },
      {
        family: "trial_conversion",
        state: "supported",
        terms: {
          durationDays: 14,
          conversionAction: "unknown",
          conversionTiming: "unknown",
          endBehavior: "unknown",
          paymentRequirement: "unknown",
          paidPlanKey: null,
        },
        entry: null,
        action: null,
        provenance: [{ file: "src/billing.ts", line: 2 }],
      },
    ]);
    expect(JSON.stringify(findings)).not.toMatch(
      /never-upload-customer|STRIPE_SECRET/,
    );
  });
  it("discovers the nested Checkout trial setting", () => {
    expect(
      scan(
        header +
          'billing.checkout.sessions.create({ mode: "subscription", subscription_data: { trial_period_days: 7 } });',
      )[0],
    ).toMatchObject({ family: "subscription_trial_start", terms: { durationDays: 7 } });
  });
  it.each([
    "trial_period_days: days",
    "trial_end: expiration",
    "trial_period_days: 0",
  ])("keeps dynamic or unusable terms unknown: %s", (setting) => {
    expect(
      scan(header + `billing.subscriptions.create({ ${setting} });`)[0],
    ).toMatchObject({ state: "unknown", terms: { durationDays: null } });
  });
  it.each([
    "const billing = fake(); billing.subscriptions.create({trial_period_days:14});",
    'import Stripe from "another-sdk"; const billing = new Stripe(); billing.subscriptions.create({trial_period_days:14});',
    header +
      "function handler(billing:any) { billing.subscriptions.create({trial_period_days:14}); }",
    header +
      "billing.subscriptions = fake; billing.subscriptions.create({trial_period_days:14});",
    header +
      "billing = fake; billing.subscriptions.create({trial_period_days:14});",
    header +
      "function handler(Stripe:any) { billing.subscriptions.create({trial_period_days:14}); }",
    header +
      "function demoBilling() { billing.subscriptions.create({trial_period_days:14}); }",
    header +
      'if (process.env.NODE_ENV === "test") billing.subscriptions.create({trial_period_days:14});',
    header +
      "billing.subscriptions.create({trial_period_days:14, ...dynamic});",
    header +
      "billing.subscriptions.create({trial_period_days:14, trial_period_days:7});",
  ])("does not attribute ambiguous or non-product calls", (source) => {
    expect(scan(source)).toEqual([]);
  });
  it("excludes fixture paths", () => {
    expect(
      scan(
        header + "billing.subscriptions.create({ trial_period_days: 14 });",
        "tests/billing.ts",
      ),
    ).toEqual([]);
  });
  it("combines conflicting trial terms and retains source references", () => {
    const rows = scan(
      header +
        "billing.subscriptions.create({trial_period_days:14});\nbilling.subscriptions.create({trial_period_days:7});",
    );
    const result = combineLifecycleFindings(rows);
    expect(result).toHaveLength(2);
    expect(result.map(item => item.family)).toEqual(["subscription_trial_start", "trial_conversion"]);
    expect(result[0]).toMatchObject({
      state: "supported",
      terms: { durationDays: null },
      provenance: [{ line: 2 }, { line: 3 }],
    });
  });
  it("keeps immediate and scheduled cancellation distinct without inferring a customer choice", () => {
    const rows = scan(
      header +
        "billing.subscriptions.cancel(id);\nbilling.subscriptions.update(id, {cancel_at_period_end:true});",
    );
    expect(rows.map((item) => item.terms)).toEqual([
      { cancellationTiming: "immediate" },
      { cancellationTiming: "period_end" },
    ]);
    expect(combineLifecycleFindings(rows)[0]).toMatchObject({
      family: "cancellation_save",
      terms: { cancellationTiming: "unknown" },
    });
  });
  it("does not call undoing a scheduled cancellation reactivation", () => {
    expect(
      scan(
        header +
          "billing.subscriptions.update(id, {cancel_at_period_end:false});",
      ),
    ).toEqual([]);
  });
  it("requires recovery review for a generic invoice payment call", () => {
    expect(scan(header + "billing.invoices.pay(id);")[0]).toMatchObject({
      family: "failed_payment_recovery",
      state: "unknown",
      terms: { recoveryAction: "unknown", providerRecovery: "unknown" },
    });
  });
  it("lets explicit reviewed evidence resolve incomplete automatic findings", () => {
    const rows = scan(
      header + "billing.subscriptions.create({trial_period_days:days});",
    );
    const reviewed = {
      ...rows[0]!,
      family: "trial_conversion" as const,
      state: "supported" as const,
      terms: {
        durationDays: 14,
        endBehavior: "paid_conversion" as const,
        paymentRequirement: "required" as const,
        paidPlanKey: "pro",
      },
    };
    expect(combineLifecycleFindings(rows, [reviewed])).toEqual([rows[0], reviewed]);
  });
});
