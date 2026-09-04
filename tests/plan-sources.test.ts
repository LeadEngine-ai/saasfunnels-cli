import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runSaaSFunnelsCli } from "../src/cli.js";
import {
  buildPlanMappingHandoff,
  discoverPlanSourceCandidates,
  planMappingRequestKey,
  readApprovedPlanSources,
} from "../src/plan-sources.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>) {
  const cwd = await mkdtemp(join(tmpdir(), "saasfunnels-plans-"));
  tempDirs.push(cwd);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(cwd, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return cwd;
}

const plansFile = `export const PLANS = {
  free: { priceId: "price_1QAbCdEfGhIjKlMnOpQrStUv", features: ["basic_export"] },
  pro: { priceId: "price_1QZyXwVuTsRqPoNmLkJiHgFe", features: ["basic_export", "export_csv"] },
};
`;

describe("plan source discovery", () => {
  it("proposes a file carrying a Stripe price whatever it is called", async () => {
    // Real pricing lives in files like papermark's `ee/stripe/utils.ts`, which
    // no filename list would match. The price identifier has to be enough.
    const cwd = await fixture({
      "ee/stripe/utils.ts": plansFile,
      "src/helpers.ts": "export const noop = () => {};\n",
    });

    const candidates = await discoverPlanSourceCandidates({ cwd });

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      "ee/stripe/utils.ts",
    ]);
    expect(candidates[0]?.hasStripePriceId).toBe(true);
    expect(candidates[0]?.rationale).toBe("The file references a Stripe price.");
  });

  it("finds a pricing definition and ranks a Stripe price highest", async () => {
    const cwd = await fixture({
      "src/plans.ts": plansFile,
      "src/tiers.ts":
        "export const TIERS = { pro: { amount: 4900, interval: 'month' } };\n",
      "src/plan-names.ts": "export const TIERS = ['free', 'pro'];\n",
      "src/checkout.ts": "export function checkout() {}\n",
    });

    const candidates = await discoverPlanSourceCandidates({ cwd });
    const paths = candidates.map((candidate) => candidate.path);

    expect(paths).toContain("src/plans.ts");
    // No Stripe price, but it states an amount and an interval.
    expect(paths).toContain("src/tiers.ts");
    // Named like pricing, but carries nothing plan mapping could import.
    expect(paths).not.toContain("src/plan-names.ts");
    // Not a commercial-sounding filename, so never a candidate.
    expect(paths).not.toContain("src/checkout.ts");
    // A Stripe price is close to proof, so it sorts first.
    expect(candidates[0]?.path).toBe("src/plans.ts");
    expect(candidates[0]?.hasStripePriceId).toBe(true);
  });

  it("never proposes a file on a sensitive path", async () => {
    const cwd = await fixture({
      "config/plans.ts": plansFile,
      "secrets/plans.ts": plansFile,
      ".env.plans.ts": plansFile,
      "credentials/pricing.json": '{"pro":{"priceId":"price_1QAbCdEfGhIjKlMnOpQrStUv"}}',
    });

    const paths = (await discoverPlanSourceCandidates({ cwd })).map((c) => c.path);

    expect(paths).toContain("config/plans.ts");
    expect(paths.some((path) => path.includes("secrets/"))).toBe(false);
    expect(paths.some((path) => path.includes("credentials/"))).toBe(false);
    expect(paths.some((path) => path.includes(".env"))).toBe(false);
  });

  it("refuses to read a sensitive path even if it reaches the approved list", async () => {
    const cwd = await fixture({ "secrets/plans.ts": plansFile });

    await expect(
      buildPlanMappingHandoff({ cwd, files: ["secrets/plans.ts"] }),
    ).rejects.toThrow(/not a readable plan source path/);
  });

  it("names the offending file rather than letting the server reject the batch", async () => {
    const cwd = await fixture({ "src/plans.ts": plansFile });
    const tooMany = Array.from({ length: 13 }, (_, index) => `src/plans${index}.ts`);

    await expect(buildPlanMappingHandoff({ cwd, files: tooMany })).rejects.toThrow(
      /at most 12 files/,
    );
  });

  it("is idempotent for the same revision", () => {
    const first = planMappingRequestKey({
      repositoryKey: "github.com/LeadEngine-ai/example",
      repositoryRevision: "main@abc123",
    });
    const second = planMappingRequestKey({
      repositoryKey: "github.com/LeadEngine-ai/example",
      repositoryRevision: "main@abc123",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-z][a-z0-9_.:-]{7,159}$/);
    expect(
      planMappingRequestKey({
        repositoryKey: "github.com/LeadEngine-ai/example",
        repositoryRevision: "main@def456",
      }),
    ).not.toBe(first);
  });
});

describe("plans CLI", () => {
  it("exits cleanly when a repository has no pricing definition", async () => {
    const cwd = await fixture({ "src/checkout.ts": "export function checkout() {}\n" });

    const discovered = await runSaaSFunnelsCli(["plans", "discover"], { cwd });

    expect(discovered.exitCode).toBe(0);
    expect(discovered.stdout).toContain("No plan or pricing definition files found");
  });

  it("proposes without writing until --apply", async () => {
    const cwd = await fixture({ "src/plans.ts": plansFile });

    const proposed = await runSaaSFunnelsCli(["plans", "discover"], { cwd });
    expect(proposed.stdout).toContain("src/plans.ts");
    expect(await readApprovedPlanSources(cwd)).toEqual([]);

    await runSaaSFunnelsCli(["plans", "discover", "--apply"], { cwd });
    expect(await readApprovedPlanSources(cwd)).toEqual(["src/plans.ts"]);
  });

  it("cancels approval when the operator declines", async () => {
    const cwd = await fixture({ "src/plans.ts": plansFile });

    const declined = await runSaaSFunnelsCli(["plans", "discover", "--apply"], {
      cwd,
      prompt: async () => "n",
    });

    expect(declined.exitCode).toBe(2);
    expect(declined.stderr).toContain("cancelled");
    expect(await readApprovedPlanSources(cwd)).toEqual([]);
  });

  it("refuses to hand off before anything is approved", async () => {
    const cwd = await fixture({ "src/plans.ts": plansFile });

    const handoff = await runSaaSFunnelsCli(
      [
        "plans",
        "handoff",
        "--repository-key",
        "github.com/LeadEngine-ai/example",
        "--repository-revision",
        "main@abc123",
        "--integration-id",
        "11111111-1111-4111-8111-111111111111",
      ],
      { cwd },
    );

    expect(handoff.exitCode).toBe(2);
    expect(handoff.stderr).toContain("No approved plan sources");
  });

  it("uploads only approved files and names them first", async () => {
    const cwd = await fixture({
      "src/plans.ts": plansFile,
      "src/pricing.ts": "export const PRICING = { pro: 'price_1QOtherAbCdEfGhIjKlMnOp' };\n",
    });
    await runSaaSFunnelsCli(["plans", "discover", "--apply"], { cwd });
    // Narrow the approved list by hand, the way a reviewer would.
    await writeFile(
      join(cwd, ".saasfunnels/plan-sources.json"),
      JSON.stringify({ files: ["src/plans.ts"], schemaVersion: 1 }),
      "utf8",
    );

    let body: any = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }) as unknown as typeof fetch;

    const dryRun = await runSaaSFunnelsCli(
      [
        "plans",
        "handoff",
        "--repository-key",
        "github.com/LeadEngine-ai/example",
        "--repository-revision",
        "main@abc123",
        "--integration-id",
        "11111111-1111-4111-8111-111111111111",
      ],
      { cwd },
    );
    expect(dryRun.stdout).toContain("src/plans.ts");
    expect(dryRun.stdout).toContain("Add --send to upload");

    const sent = await runSaaSFunnelsCli(
      [
        "plans",
        "handoff",
        "--repository-key",
        "github.com/LeadEngine-ai/example",
        "--repository-revision",
        "main@abc123",
        "--integration-id",
        "11111111-1111-4111-8111-111111111111",
        "--send",
        "--api-base-url",
        "https://app.saasfunnels.test",
      ],
      { cwd, env: { SAASFUNNELS_API_KEY: "pv_test_key_value_1234567890" }, fetch: fetchImpl },
    );

    expect(sent.exitCode).toBe(0);
    expect(body.inputs).toHaveLength(1);
    expect(body.inputs[0].label).toBe("src/plans.ts");
    expect(body.inputs[0].kind).toBe("typescript");
    expect(body.inputs[0].content).toContain("price_1QAbCdEfGhIjKlMnOpQrStUv");
    expect(body.requestKey).toMatch(/^[a-z][a-z0-9_.:-]{7,159}$/);
  });
});
