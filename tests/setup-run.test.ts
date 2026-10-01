import { describe, expect, it } from "vitest";
import { extractSetupPricing } from "../src/setup-pricing.js";
import { safeRepositoryKey, runGuidedSetup } from "../src/setup-run.js";

describe("guided setup discovery", () => {
  it("removes credentials and query data from repository identity", () => {
    expect(
      safeRepositoryKey(
        "https://user:password@github.com/acme/app.git?token=secret",
      ),
    ).toBe("github.com/acme/app");
    expect(safeRepositoryKey("git@github.com:acme/app.git")).toBe(
      "github.com/acme/app",
    );
  });
  it("extracts literal pricing without executing code or exposing extra fields", () => {
    const source =
      'export const plans = [{ key: "pro", name: "Pro", features: { export: true, seats: 5 }, stripePriceId: "price_123", internal: "never upload" }] as const;';
    expect(extractSetupPricing(source, "typescript")).toEqual([
      {
        key: "pro",
        name: "Pro",
        features: { export: true, seats: 5 },
        prices: [{ key: "price_123" }],
      },
    ]);
    expect(() =>
      extractSetupPricing(
        "export const plans = getPlans(process.env.SECRET)",
        "typescript",
      ),
    ).toThrow();
  });
  it("rejects ambiguous feature values rather than inventing access", () => {
    expect(() =>
      extractSetupPricing(
        JSON.stringify({
          plans: [{ key: "pro", features: { export: "maybe" } }],
        }),
        "json",
      ),
    ).toThrow();
  });
  it("does not make requests without a setup credential", async () => {
    const result = await runGuidedSetup({
      cwd: "/tmp",
      apiBaseUrl: "https://app.example",
      send: true,
      resume: false,
    });
    expect(result.exitCode).toBe(2);
  });
});

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

it.each(["test", "production"] as const)("runs a genuine empty %s scan, uploads normalized stages, and resumes without duplicates", async (environment) => {
  const cwd = await mkdtemp(join(tmpdir(), "guided-fixture-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/example/fixture.git"],
      { cwd },
    );
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "fixture",
        dependencies: { next: "16.0.0", react: "19.0.0" },
      }),
    );
    await mkdir(join(cwd, "app"));
    await writeFile(
      join(cwd, "app/page.tsx"),
      "export default function Page() { return <div>Hello</div>; }",
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
          environment,
          catalogReady: true,
          planNames: [],
        });
      if (path.endsWith("/runs")) {
        if (init?.method === "PATCH") sequence = body.sequence;
        return Response.json({
          run: {
            id: "11111111-1111-4111-8111-111111111111",
            sequence,
            receipts,
          },
        });
      }
      if (path.endsWith("/evidence")) {
        uploads.push(body);
        receipts[body.stage] = { complete: true };
        return Response.json({ accepted: true, sequence: ++sequence });
      }
      throw new Error("Unexpected route");
    };
    const options = {
      cwd,
      apiBaseUrl: "https://app.example",
      key: "fixture-key",
      send: true,
      resume: false,
      fetch: fetcher,
    };
    const first = await runGuidedSetup(options);
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(0);
    expect(uploads.map((u) => u.stage)).toEqual([
      "features",
      "plans",
      "branches",
    ]);
    expect(uploads[1].evidence.plans).toEqual([]);
    expect(uploads[2].evidence.clusters).toEqual([]);
    expect(JSON.stringify(uploads)).not.toContain("Hello");
    expect(
      await readFile(join(cwd, ".saasfunnels/setup-run.json"), "utf8"),
    ).not.toContain("fixture-key");
    expect((await runGuidedSetup({ ...options, resume: true })).exitCode).toBe(
      0,
    );
    expect(uploads).toHaveLength(3);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
