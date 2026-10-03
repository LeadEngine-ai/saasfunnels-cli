import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readSetupLifecycle } from "../src/setup-lifecycle.js";
import { setupLifecycleEvidenceSchema } from "../src/setup-lifecycle-contract.js";
const trial = {
  family: "trial_conversion",
  subjectKey: null,
  state: "supported",
  provenance: [{ file: "src/billing.ts", line: 12 }],
  reason: "Subscription trial creation",
  entry: { key: "trial.ending", verification: "tested" },
  action: null,
  terms: {
    durationDays: 14,
    conversionAction: "existing_subscription_change",
    conversionTiming: "trial_end",
    endBehavior: "paid_conversion",
    paymentRequirement: "required",
    paidPlanKey: "pro",
  },
};
async function fixture(run: (cwd: string, path: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "lifecycle-"));
  try {
    await mkdir(join(cwd, ".saasfunnels"));
    await run(cwd, join(cwd, ".saasfunnels/setup-lifecycle.json"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
it("preserves absent findings as unknown rather than a declaration of no trials", () =>
  fixture(async (cwd) => {
    expect(await readSetupLifecycle(cwd)).toBeNull();
  }));
it("submits bounded structured evidence without treating declarations as tested connections", () =>
  fixture(async (cwd, path) => {
    await writeFile(path, JSON.stringify([trial]));
    expect((await readSetupLifecycle(cwd))?.findings).toEqual([
      { ...trial, entry: { key: "trial.ending", verification: "discovered" } },
    ]);
  }));
it.each(
  [
    [{ ...trial, provenance: [] }],
    [{ ...trial, secret: "must not leak" }],
    [trial, trial],
    [{ ...trial, provenance: [{ file: ".env.local" }] }],
    [{ ...trial, terms: { ...trial.terms, durationDays: 0 } }],
    [
      { ...trial, state: "not_applicable" },
      { ...trial, subjectKey: "reports" },
    ],
  ].map((value) => ({ value })),
)("rejects invalid evidence without returning its contents", ({ value }) =>
  fixture(async (cwd, path) => {
    await writeFile(path, JSON.stringify(value));
    await expect(readSetupLifecycle(cwd)).rejects.toThrow(
      "Review .saasfunnels/setup-lifecycle.json",
    );
  }),
);
it("bounds file size and rejects file symlinks", () =>
  fixture(async (cwd, path) => {
    await writeFile(path, " ".repeat(200_001));
    await expect(readSetupLifecycle(cwd)).rejects.toThrow(
      "Review .saasfunnels/setup-lifecycle.json",
    );
    await rm(path);
    await writeFile(join(cwd, "other.json"), JSON.stringify([trial]));
    await symlink(join(cwd, "other.json"), path);
    await expect(readSetupLifecycle(cwd)).rejects.toThrow(
      "Use a regular local file",
    );
  }));
it("keeps supported feature trials scoped and rejects duplicate family subjects", () => {
  const feature = {
    ...trial,
    family: "feature_trial",
    subjectKey: "reports",
    terms: {
      durationDays: 7,
      endBehavior: "access_ends",
      paymentRequirement: "not_required",
      trialKey: "reports_trial",
    },
  };
  expect(setupLifecycleEvidenceSchema.safeParse([trial, feature]).success).toBe(
    true,
  );
  expect(
    setupLifecycleEvidenceSchema.safeParse([{ ...feature, subjectKey: null }])
      .success,
  ).toBe(false);
});
