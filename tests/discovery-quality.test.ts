import { expect, it } from "vitest";
import { namedFeatureEvidence } from "../src/source-analysis.js";
import { planRestrictionEvidence } from "../src/plan-analysis.js";
import { extractSetupPricing } from "../src/setup-pricing.js";

it("separates commercial gates from RBAC, flags, status and strings", () => {
  const source = `// checkFeature("comment_noise")
  const help = 'checkFeature("string_noise")';
  requirePermission("users.manage"); requireCapability("users.manage");
  requireProjectCapability("billing.admin"); isEnabled("rollout");
  if (subscription.status === "trialing") sendEmail();
  checkFeature("exports");
  requireBillingCapability({ accountId, capability: "sso" });
  checkEntitlement(account, "custom_domains");
  consumeQuota({quotaKey:"api_requests",count:1});`;
  expect(
    namedFeatureEvidence("src/access.ts", source).map((x) => [x.key, x.model]),
  ).toEqual([
    ["exports", "boolean"],
    ["sso", "boolean"],
    ["custom_domains", "boolean"],
    ["api_requests", "limit"],
  ]);
});
it("excludes inline fixtures while preserving real demo/preview features", () => {
  const source = `function demoCatalog(){checkFeature("fake_demo")}
  function buildAccessE2eFixture(){checkFeature("fake_e2e")}
  if(process.env.E2E_FIXTURES === "1"){checkFeature("fake_flag")}
  if(isDemo){checkFeature("fake_mode")} else {checkFeature("real_else")}
  function renderPreview(){checkFeature("preview")}
  checkFeature("demo_recording");
  const sample = {featureKey:"placeholder"};`;
  expect(
    namedFeatureEvidence("src/product.ts", source).map((x) => x.key),
  ).toEqual(["real_else", "preview", "demo_recording"]);
  expect(
    namedFeatureEvidence("src/access-e2e-fixture.ts", 'checkFeature("fake")'),
  ).toEqual([]);
});
it("handles JSX and named multi-argument helper options", () => {
  expect(
    namedFeatureEvidence(
      "src/page.tsx",
      `const page = <FeatureGate featureKey={"exports"}/>; requireFeature(account,{featureKey:"sso"});`,
    ).map((x) => [x.key, x.kind]),
  ).toEqual([
    ["exports", "browser_presentation"],
    ["sso", "server_enforcement"],
  ]);
});
it("finds real denials and limits without checkout validation and pricing branches", () => {
  const source = `function exportData(plan){if(plan !== "team") throw new Error("Upgrade to export");}
  function checkout(plan){if(plan !== "team") throw new Error("Invalid plan");}
  function price(plan){return plan === "team" ? 20 : 10;}
  const seatLimit = plan === "team" ? 20 : 2;
  function testFixture(){if(plan === "free") return false;}
  function page(plan){return plan === "team" ? <Badge/> : <Upgrade/>;}`;
  expect(
    planRestrictionEvidence("src/product.tsx", source).map((x) => [
      x.symbol,
      x.shape,
    ]),
  ).toEqual([
    ["exportData", "boolean"],
    ["seatLimit", "limit"],
    ["page", "presentation"],
  ]);
});
it("supports collaboration and usage plans independently of Stripe availability", () => {
  const source = `const plans = {free:{features:{sharing:false},quotas:{seats:1,requests:100}},team:{features:{sharing:true},quotas:{seats:10,requests:"unlimited"},prices:{month:{lookupKey:"team-month"}}}};`;
  expect(
    extractSetupPricing(source, "typescript", [], { featuresOnly: true }),
  ).toMatchObject([
    { key: "free", features: { sharing: false, seats: 1, requests: 100 } },
    {
      key: "team",
      features: { sharing: true, seats: 10, requests: "unlimited" },
    },
  ]);
});
it("does not execute dynamic enterprise or trial entitlements", () => {
  expect(() =>
    extractSetupPricing("const plans=loadEnterprisePlans();", "typescript"),
  ).toThrow();
  expect(() =>
    extractSetupPricing(
      'const plans=[{id:"trial",features:getTrialEntitlements()}];',
      "typescript",
    ),
  ).toThrow();
});

it("keeps production branches when demo conditions are negated or disabled", () => {
  const source = `if(!isDemo){checkFeature("real")}else{checkFeature("fake")}
  if(process.env.E2E_MODE === "0"){checkFeature("enabled")}else{checkFeature("fake_mode")}
  const output = isDemo ? checkFeature("fake_ternary") : checkFeature("real_ternary");`;
  expect(
    namedFeatureEvidence("src/access.ts", source).map((x) => x.key),
  ).toEqual(["real", "enabled", "real_ternary"]);
});
it("requires review for conflicting quota values and mixed access models", () => {
  expect(() =>
    extractSetupPricing(
      JSON.stringify({
        plans: [
          { key: "free", features: { storage: 10 }, quotas: { storage: 20 } },
        ],
      }),
      "json",
    ),
  ).toThrow(/Conflicting/);
  expect(() =>
    extractSetupPricing(
      JSON.stringify({
        plans: [
          { key: "free", features: { storage: false } },
          { key: "pro", features: { storage: 20 } },
        ],
      }),
      "json",
    ),
  ).toThrow(/mixes/);
  expect(
    extractSetupPricing(
      "plans:\n  free:\n    features:\n      sharing: false\n    quotas:\n      seats: 1\n  team:\n    features:\n      sharing: true\n    quotas:\n      seats: unlimited\n",
      "yaml",
    ),
  ).toHaveLength(2);
});
it("does not reverse the meaning of negated plan checks or overclaim compound rules", () => {
  const source = `if(plan !== "pro") requireUpgrade();
 if(!(plan === "free")) denyAccess();
 if(plan === "free" && overLimit) denyAccess();`;
  expect(
    planRestrictionEvidence("src/access.ts", source).map((x) => x.polarity),
  ).toEqual(["grant", "grant", "unclear"]);
});
it("does not call a conditional denial an unconditional plan restriction", () => {
  const findings = planRestrictionEvidence(
    "src/access.ts",
    `function access(plan, overLimit) { if (plan === "free") { if (overLimit) return false; } return true; }`,
  );
  expect(findings[0]).toMatchObject({ literal: "free", polarity: "unclear" });
});
