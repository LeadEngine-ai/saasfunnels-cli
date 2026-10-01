import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  runFeatureSetup,
  buildFeatureInstrumentationHandoff,
} from "./feature-setup.js";
import { discoverPlanSourceCandidates } from "./plan-sources.js";
import { discoverPlanBranches, clusterPlanBranches } from "./plan-branches.js";
import { extractSetupPricing } from "./setup-pricing.js";

const exec = promisify(execFile);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const contextSchema = z.object({
  workspaceId: z.string(),
  generation: z.string().regex(/^[a-f0-9]{64}$/),
  installationId: z.string().nullable(),
  integrationId: z.string().nullable(),
  environment: z.enum(["test", "production"]),
  catalogReady: z.boolean(),
  planNames: z.array(z.string()),
});
type Stage = "features" | "plans" | "branches";
type Options = {
  cwd: string;
  apiBaseUrl: string;
  key?: string;
  send: boolean;
  resume: boolean;
  fetch?: typeof fetch;
  prompt?: (message: string) => Promise<string>;
};

export function safeRepositoryKey(remote: string) {
  const ssh = remote.match(/^[^@\s]+@([^:]+):(.+)$/);
  let identity: string;
  if (ssh) identity = `${ssh[1]}/${ssh[2]}`;
  else {
    const url = new URL(remote);
    identity = `${url.hostname}/${url.pathname.replace(/^\//, "")}`;
  }
  identity = identity.replace(/\.git$/, "");
  if (!/^[a-zA-Z0-9_.:/-]{1,200}$/.test(identity))
    throw new Error("Use a repository remote without sensitive identifiers.");
  return identity;
}

/** This orchestrates discovery; it never deploys or claims payment support. */
export async function runGuidedSetup(options: Options) {
  if (!options.key)
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        "Save SAASFUNNELS_API_KEY from Setup in your local environment first.\n",
    };
  const base = new URL(options.apiBaseUrl);
  if (
    base.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(base.hostname)
  )
    return { exitCode: 2, stdout: "", stderr: "Use HTTPS for setup.\n" };
  const request = async (path: string, body?: unknown, method = "POST") => {
    const response = await (options.fetch ?? fetch)(new URL(path, base), {
      method: body === undefined ? "GET" : method,
      headers: {
        authorization: `Bearer ${options.key}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `Setup request failed (${response.status}). Check installation access and retry.`,
      );
    return response.json();
  };
  let run:
    | { id: string; sequence: number; receipts: Record<string, unknown> }
    | undefined;
  let stage: Stage = "features";
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: Promise<void> = Promise.resolve();
  let reportFailure: (() => Promise<void>) | undefined;
  let progressState: "running" | "waiting" | "failed" = "running";
  let progressFailure: string | null = null;
  try {
    let context = contextSchema.parse(
      await request("/api/developer-tools/setup/context"),
    );
    if (!context.installationId || !context.integrationId)
      throw new Error(
        "Connect Stripe and create app credentials in Setup first.",
      );
    const head = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: options.cwd })
    ).stdout.trim();
    const diff = (
      await exec(
        "git",
        [
          "diff",
          "--no-ext-diff",
          "--binary",
          "HEAD",
          "--",
          ".",
          ":(exclude).saasfunnels/**",
        ],
        { cwd: options.cwd, maxBuffer: 8_000_000 },
      )
    ).stdout;
    const untracked = (
      await exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: options.cwd,
      })
    ).stdout
      .split("\0")
      .filter(
        (path) =>
          path &&
          !path.startsWith(".saasfunnels/") &&
          !/(^|\/)(\.env|node_modules|dist|\.next)(\/|$|\.)/i.test(path),
      )
      .sort();
    if (untracked.length > 2000)
      throw new Error(
        "Too many untracked files. Commit application changes before discovery.",
      );
    const sourceHashes = await Promise.all(
      untracked.map(async (path) => [
        path,
        hash(await readFile(join(options.cwd, path), "utf8")),
      ]),
    );
    // Raw diff/content stays local. Receipts bind to the actual working tree,
    // including uncommitted installation work, rather than HEAD alone.
    const revision = `${head}:${hash(JSON.stringify([diff, sourceHashes]))}`;
    const remote = (
      await exec("git", ["remote", "get-url", "origin"], { cwd: options.cwd })
    ).stdout.trim();
    const repositoryKey = safeRepositoryKey(remote);
    const statePath = join(options.cwd, ".saasfunnels", "setup-run.json");
    if (options.resume) {
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      if (
        saved.generation !== context.generation ||
        saved.repositoryKey !== repositoryKey ||
        saved.revision !== revision
      )
        throw new Error(
          "The app connection or revision changed. Run setup again without --resume.",
        );
    }
    const approved =
      options.send ||
      (options.prompt &&
        /^y(es)?$/i.test(
          (
            await options.prompt(
              "Send structured discovery findings to this workspace for review? No source files or secrets are uploaded. [y/N] ",
            )
          ).trim(),
        ));
    if (!approved)
      return {
        exitCode: 2,
        stdout: "",
        stderr:
          "No evidence uploaded. Review the installation instructions, then run setup run --send to approve discovery uploads.\n",
      };
    run = (
      await request("/api/developer-tools/setup/runs", {
        generation: context.generation,
        repositoryKey,
        repositoryRevisionHash: hash(revision),
      })
    ).run;
    if (!run) throw new Error("Setup did not return a run.");
    await mkdir(join(options.cwd, ".saasfunnels"), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify(
        {
          generation: context.generation,
          repositoryKey,
          revision,
          runId: run.id,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    const update = (
      state: "running" | "waiting" | "failed",
      failureCode: string | null = null,
    ) => {
      progressState = state;
      progressFailure = failureCode;
      const currentStage = stage;
      heartbeat = heartbeat.then(async () => {
        const result = await request(
          "/api/developer-tools/setup/runs",
          {
            runId: run!.id,
            sequence: run!.sequence + 1,
            stage: currentStage,
            state,
            failureCode,
          },
          "PATCH",
        );
        run!.sequence = result.run.sequence;
      });
      return heartbeat;
    };
    const send = (evidence: unknown) => {
      const currentStage = stage;
      heartbeat = heartbeat.then(async () => {
        const result = await request("/api/developer-tools/setup/evidence", {
          runId: run!.id,
          stage: currentStage,
          evidence,
        });
        if (typeof result.sequence === "number")
          run!.sequence = result.sequence;
      });
      return heartbeat;
    };
    reportFailure = async () => {
      await heartbeat.catch(() => {});
      heartbeat = Promise.resolve();
      await update("failed", "scan_failed");
    };
    timer = setInterval(() => {
      void update(progressState, progressFailure).catch(() => {});
    }, 30_000);
    if (!run.receipts.features) {
      await update("running");
      // Include candidates as proposals only. No generated files are applied;
      // the server review queue remains the authority for customer decisions.
      const scan = await runFeatureSetup({
        cwd: options.cwd,
        apiBaseUrl: options.apiBaseUrl,
        environment: context.environment,
        apply: false,
        manifestOnly: true,
        accept: ["all"],
      });
      if (!scan.ok)
        throw new Error(
          "Feature discovery needs attention. Run features setup to review the local findings.",
        );
      await send(
        buildFeatureInstrumentationHandoff({
          manifest: scan.manifest,
          repositoryKey,
          repositoryRevision: revision,
          discoveryRoots: scan.framework.roots,
        }),
      );
    }
    stage = "plans";
    const catalogDeadline = Date.now() + 5 * 60_000;
    const generation = context.generation;
    while (!context.catalogReady && Date.now() < catalogDeadline) {
      await update("waiting", "catalog_pending");
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      context = contextSchema.parse(
        await request("/api/developer-tools/setup/context"),
      );
      if (context.generation !== generation)
        throw new Error("The app connection changed. Start setup again.");
    }
    if (!context.catalogReady)
      return {
        exitCode: 2,
        stdout:
          "Stripe is still importing. Run setup run --resume --send when the catalog is ready.\n",
        stderr: "",
      };
    if (!run.receipts.plans) {
      await update("running");
      const candidates = await discoverPlanSourceCandidates({
        cwd: options.cwd,
      });
      try {
        if (candidates.length > 12) throw new Error("Too many sources");
        let manual: string | null = null;
        try {
          manual = await readFile(
            join(options.cwd, ".saasfunnels/setup-pricing.json"),
            "utf8",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const discovered =
          manual !== null
            ? extractSetupPricing(manual, "json")
            : (
                await Promise.all(
                  candidates.map(async (candidate) =>
                    extractSetupPricing(
                      await readFile(join(options.cwd, candidate.path), "utf8"),
                      candidate.kind,
                    ),
                  ),
                )
              ).flat();
        const byKey = new Map<string, (typeof discovered)[number]>();
        for (const plan of discovered) {
          if (
            byKey.has(plan.key) &&
            JSON.stringify(byKey.get(plan.key)) !== JSON.stringify(plan)
          )
            throw new Error("Conflicting pricing sources");
          byKey.set(plan.key, plan);
        }
        await send({
          plans: [...byKey.values()],
          reviewedFiles:
            manual !== null
              ? [".saasfunnels/setup-pricing.json"]
              : candidates.map((c) => c.path),
        });
      } catch {
        await update("waiting", "extraction_unsupported");
        return {
          exitCode: 2,
          stdout:
            "Pricing discovery needs manual review. Create .saasfunnels/setup-pricing.json with a plans array containing key, name, features (boolean or numeric access), and prices (Stripe price IDs). Review it, then run setup run --resume --send. No source files were uploaded.\n",
          stderr: "",
        };
      }
    }
    stage = "branches";
    if (!run.receipts.branches) {
      await update("running");
      const branches = context.planNames.length
        ? await discoverPlanBranches({
            cwd: options.cwd,
            planValues: context.planNames,
          })
        : [];
      const clusters = clusterPlanBranches(branches).map((cluster) => ({
        ...cluster,
        branchCount: cluster.branches.length,
        branches: cluster.branches.map((branch) => ({
          line: branch.line,
          planValue: branch.planValue,
          polarity: branch.polarity,
          repositoryPath: branch.repositoryPath,
          shape: branch.shape,
          symbol: branch.symbol,
        })),
      }));
      await send({
        clusters,
        environment: context.environment,
        planValues: context.planNames,
        producer: "cli",
        repositoryKey,
        repositoryRevision: revision,
        schemaVersion: 1,
      });
    }
    return {
      exitCode: 0,
      stdout:
        "Discovery submitted. Return to Setup to review findings and verify installation. Payment transactions have not been tested by this command.\n",
      stderr: "",
    };
  } catch (error) {
    clearInterval(timer);
    await reportFailure?.().catch(() => {});
    // Never print provider bodies, environment values, or credential-bearing git errors.
    const safe =
      error instanceof Error &&
      /^(Setup request failed|Connect Stripe|The app connection|Use a repository|Feature discovery)/.test(
        error.message,
      )
        ? error.message
        : "Setup could not finish. Check local repository access and developer credentials, then resume.";
    return { exitCode: 2, stdout: "", stderr: safe + "\n" };
  } finally {
    clearInterval(timer);
    await heartbeat.catch(() => {});
  }
}

/** Compatibility path: approved files are parsed locally, never sent as source. */
export async function submitApprovedSetupPlans(input: {
  apiBaseUrl: string;
  key: string;
  repositoryKey: string;
  revision: string;
  integrationId: string;
  evidence: {
    plans: ReturnType<typeof extractSetupPricing>;
    reviewedFiles: string[];
  };
  fetch?: typeof fetch;
}) {
  const base = new URL(input.apiBaseUrl);
  if (
    base.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(base.hostname)
  )
    throw new Error("Use HTTPS for setup.");
  const call = async (path: string, body?: unknown) => {
    const response = await (input.fetch ?? fetch)(new URL(path, base), {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${input.key}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        "Plan evidence could not be submitted. Check Setup and developer access, then retry.",
      );
    return response.json();
  };
  const context = contextSchema.parse(
    await call("/api/developer-tools/setup/context"),
  );
  if (!context.catalogReady || context.integrationId !== input.integrationId)
    throw new Error(
      "Refresh the connected Stripe catalog before submitting plan evidence.",
    );
  const { run } = await call("/api/developer-tools/setup/runs", {
    generation: context.generation,
    repositoryKey: input.repositoryKey,
    repositoryRevisionHash: hash(input.revision),
  });
  await call("/api/developer-tools/setup/evidence", {
    runId: run.id,
    stage: "plans",
    evidence: input.evidence,
  });
  return { accepted: true };
}
