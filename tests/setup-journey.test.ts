import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { runGuidedSetup } from "../src/setup-run.js";

async function fixture(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "setup-journey-"));
  try {
    await mkdir(join(cwd, "lib"));
    await writeFile(
      join(cwd, "lib/app.ts"),
      'checkFeature("exports"); if (plan === "pro") { throw new Error("upgrade"); }',
    );
    await writeFile(
      join(cwd, "lib/pricing.ts"),
      'export const plans=[{key:"pro",name:"Pro",features:{exports:true,seats:"unlimited"},prices:{month:{lookupKey:"pro_month"}}}];',
    );
    for (let i = 0; i < 15; i++)
      await writeFile(
        join(cwd, `lib/a-pricing-${i}.ts`),
        "export function priceLabel(month:string,amount:number){ return month+amount; }",
      );
    execFileSync("git", ["init", "--quiet"], { cwd });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/example/app.git"],
      { cwd },
    );
    execFileSync("git", ["add", "."], { cwd });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--quiet",
        "-m",
        "Fixture",
      ],
      { cwd },
    );
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
function server(failPlans = false) {
  const uploads: any[] = [];
  const receipts: Record<string, unknown> = {};
  let sequence = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/context"))
      return Response.json({
        workspaceId: "workspace",
        generation: "a".repeat(64),
        installationId: "installation",
        integrationId: "stripe",
        environment: "production",
        contractVersion: 3,
        minimumCliVersion: "0.4.0",
        catalogReady: true,
        planNames: [],
        catalogPrices: [{ id: "price_pro", lookupKey: "pro_month" }],
      });
    if (path.endsWith("/runs")) {
      if (body.sequence) sequence = body.sequence;
      return Response.json({ run: { id: "run", sequence, receipts } });
    }
    if (path.endsWith("/evidence")) {
      if (body.stage === "plans" && failPlans)
        return Response.json(
          { error: "do not print provider response" },
          { status: 503 },
        );
      uploads.push(body);
      receipts[body.stage] = { complete: true };
      return Response.json({
        accepted: true,
        sequence: ++sequence,
        planNames: body.stage === "plans" ? ["pro", "Pro"] : undefined,
      });
    }
    throw new Error("Unexpected request");
  };
  return { fetcher, uploads };
}
it("finds pricing beyond ten filename matches and completes all stages with literal unlimited limits", async () =>
  fixture(async (cwd) => {
    const mock = server();
    const progress: string[] = [];
    const options = {
      cwd,
      key: "fixture",
      apiBaseUrl: "https://app.example",
      send: true,
      resume: false,
      fetch: mock.fetcher,
      progress: (message: string) => progress.push(message),
    };
    expect(await runGuidedSetup(options)).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(mock.uploads.map((u) => u.stage)).toEqual([
      "features",
      "plans",
      "branches",
    ]);
    expect(mock.uploads[1].evidence).toEqual({
      coverage: { status: "complete", scannedFiles: 16 },
      lifecycle: [],
      plans: [
        {
          key: "pro",
          name: "Pro",
          features: { exports: true, seats: "unlimited" },
          prices: [{ key: "price_pro" }],
        },
      ],
      reviewedFiles: ["lib/pricing.ts"],
    });
    expect(mock.uploads[2].evidence.clusters).toHaveLength(1);
    expect(await runGuidedSetup({ ...options, resume: true })).toMatchObject({
      exitCode: 0,
    });
    expect(mock.uploads).toHaveLength(3);
    expect(progress.some((line) => line.includes("17 files"))).toBe(true);
  }));
it("reports network failure as transport failure, not a request to rewrite pricing", async () =>
  fixture(async (cwd) => {
    const mock = server(true);
    const output = await runGuidedSetup({
      cwd,
      key: "fixture",
      apiBaseUrl: "https://app.example",
      send: true,
      resume: false,
      fetch: mock.fetcher,
    });
    expect(output.stderr).toContain("503");
    expect(output.stdout).not.toContain("manual");
    expect(output.stderr).not.toContain("provider response");
    await expect(
      readFile(join(cwd, ".saasfunnels/setup-review.json")),
    ).rejects.toThrow();
  }));
it("writes exact recovery tasks and resumes after a reviewed pricing declaration", async () =>
  fixture(async (cwd) => {
    await writeFile(
      join(cwd, "lib/pricing.ts"),
      "export const plans=getPlansFromServer(); // monthly price",
    );
    const mock = server();
    const options = {
      cwd,
      key: "fixture",
      apiBaseUrl: "https://app.example",
      send: true,
      resume: false,
      fetch: mock.fetcher,
    };
    expect(await runGuidedSetup(options)).toMatchObject({
      exitCode: 2,
      stderr: "",
    });
    const report = JSON.parse(
      await readFile(join(cwd, ".saasfunnels/setup-review.json"), "utf8"),
    );
    expect(report.issues).toEqual([
      { file: "lib/pricing.ts", reason: expect.any(String) },
    ]);
    await writeFile(
      join(cwd, ".saasfunnels/setup-pricing.json"),
      JSON.stringify({
        plans: [
          { key: "pro", features: { exports: true }, prices: ["price_pro"] },
        ],
      }),
    );
    expect(await runGuidedSetup({ ...options, resume: true })).toMatchObject({
      exitCode: 2,
    });
    expect(await runGuidedSetup({ ...options, resume: false })).toMatchObject({
      exitCode: 0,
    });
    expect(mock.uploads.filter((u) => u.stage === "features")).toHaveLength(1);
  }));

it("includes reviewed lifecycle findings in the plans stage and invalidates resume when they change", async () =>
  fixture(async (cwd) => {
    await mkdir(join(cwd, ".saasfunnels"), { recursive: true });
    const file = join(cwd, ".saasfunnels/setup-lifecycle.json");
    const findings = [{
      family: "trial_conversion", subjectKey: null, state: "supported",
      provenance: [{ file: "lib/app.ts", line: 1 }], reason: "Reviewed trial behavior", entry: null, action: null,
      terms: { durationDays: 14, endBehavior: "paid_conversion", paymentRequirement: "required", paidPlanKey: "pro" },
    }];
    await writeFile(file, JSON.stringify(findings));
    const mock = server();
    const options = { cwd, key: "fixture", apiBaseUrl: "https://app.example", send: true, resume: false, fetch: mock.fetcher };
    expect((await runGuidedSetup(options)).exitCode).toBe(0);
    expect(mock.uploads.find((body) => body.stage === "plans").evidence.lifecycle).toEqual(findings);
    expect((await runGuidedSetup({ ...options, resume: true })).exitCode).toBe(0);
    const before = mock.uploads.length;
    findings[0]!.terms.durationDays = 7;
    await writeFile(file, JSON.stringify(findings));
    const changed = await runGuidedSetup({ ...options, resume: true });
    expect(changed.exitCode).toBe(2);
    expect(changed.stderr).toContain("source changed");
    expect(mock.uploads).toHaveLength(before);
  }));

it("rejects lifecycle terms changed after scan identity was captured", async () =>
  fixture(async (cwd) => {
    const mock = server();
    const changedFetch: typeof fetch = async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (new URL(String(url)).pathname.endsWith("/evidence") && body?.stage === "features") {
        await writeFile(join(cwd, ".saasfunnels/setup-lifecycle.json"), "[]");
      }
      return mock.fetcher(url, init);
    };
    const result = await runGuidedSetup({ cwd, key: "fixture", apiBaseUrl: "https://app.example", send: true, resume: false, fetch: changedFetch });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Lifecycle findings changed during discovery");
    expect(mock.uploads.map((body) => body.stage)).toEqual(["features"]);
  }));

it("automatically submits trial and cancellation evidence without a lifecycle input file", async () =>
  fixture(async (cwd) => {
    await writeFile(join(cwd, "lib/billing.ts"), 'import Stripe from "stripe"; const billing = new Stripe(process.env.STRIPE_SECRET!); export async function subscribe() { return billing.subscriptions.create({ trial_period_days: 14 }); } export async function cancel(id:string) { return billing.subscriptions.update(id, { cancel_at_period_end: true }); }');
    const mock = server();
    const result = await runGuidedSetup({ cwd, key: "fixture", apiBaseUrl: "https://app.example", send: true, resume: false, fetch: mock.fetcher });
    expect(result.exitCode).toBe(0);
    const evidence = mock.uploads.find((body) => body.stage === "plans").evidence;
    expect(evidence.lifecycle).toMatchObject([
      { family: "subscription_trial_start", terms: { durationDays: 14, paidPlanKey: null } },
      { family: "trial_conversion", terms: { durationDays: 14, paidPlanKey: null } },
      { family: "cancellation_save", terms: { cancellationTiming: "period_end" } },
    ]);
    expect(JSON.stringify(evidence.lifecycle)).not.toContain("STRIPE_SECRET");
  }));
