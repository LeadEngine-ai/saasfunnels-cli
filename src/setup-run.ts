import { baselineSchema, extractSetupPatch } from "./setup-patch.js";
import { SAASFUNNELS_CLI_VERSION } from "./identity.js";
import {
  LifecycleEvidenceError,
  readSetupLifecycle,
} from "./setup-lifecycle.js";
import {
  discoverLifecycleInSource,
  combineLifecycleFindings,
} from "./lifecycle-discovery.js";
import type { SetupLifecycleFinding } from "./setup-lifecycle-contract.js";
import { developerAnswersSchema } from "./setup-commercial.js";
import { discoverCoverageLimitations } from "./discovery-coverage.js";
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
import {
  extractSetupPricing,
  PricingExtractionError,
} from "./setup-pricing.js";

const exec = promisify(execFile);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const contextSchema = z.object({
  contractVersion: z.literal(4),
  minimumCliVersion: z.string(),
  workspaceId: z.string(),
  generation: z.string().regex(/^[a-f0-9]{64}$/),
  installationId: z.string().nullable(),
  integrationId: z.string().nullable(),
  environment: z.enum(["test", "production"]),
  catalogReady: z.boolean(),
  planNames: z.array(z.string()),
  catalogPrices: z
    .array(
      z.object({
        id: z.string().regex(/^price_[A-Za-z0-9]+$/),
        lookupKey: z.string().nullable(),
      }),
    )
    .default([]),
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
  progress?: (message: string) => void;
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
        "x-saasfunnels-cli-version": SAASFUNNELS_CLI_VERSION,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 426)
      throw new Error(
        "Setup request failed: update the installer with npx --yes saasfunnels@latest setup run",
      );
    if (!response.ok)
      throw new Error(
        `Setup request failed (${response.status}). Check installation access and retry.`,
      );
    return response.json();
  };
  let run:
    | {
        id: string;
        sequence: number;
        receipts: Record<string, unknown>;
        planNames?: string[];
      }
    | undefined;
  let stage: Stage = "features";
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: Promise<void> = Promise.resolve();
  let reportFailure: (() => Promise<void>) | undefined;
  let progressState: "running" | "waiting" | "failed" = "running";
  let progressFailure: string | null = null;
  try {
    options.progress?.("1/4 Checking app connection…");
    const initialContext = await request("/api/developer-tools/setup/context");
    if (initialContext.contractVersion !== 4)
      throw new Error(
        "This app does not support this installer yet. Finish deploying the matching Setup release before retrying.",
      );
    if (initialContext.patchesAvailable === false)
      throw new Error(
        "The app connection is temporarily paused for corrections. Existing findings and decisions are retained. Retry when Setup is available.",
      );
    let context = contextSchema.parse(initialContext);
    if (!context.installationId || !context.integrationId)
      throw new Error(
        "Connect Stripe and create app credentials in Setup first.",
      );
    try {
      await exec("git", ["rev-parse", "HEAD"], { cwd: options.cwd });
      await exec("git", ["remote", "get-url", "origin"], { cwd: options.cwd });
    } catch {
      throw new Error(
        "Repository setup needed: run this command inside your app’s Git repository with an initial commit and an origin remote. No push or production deploy is required for discovery.",
      );
    }
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
    const reviewedInputs = await Promise.all(
      ["setup-pricing.json", "setup-answers.json", "setup-lifecycle.json"].map(
        async (name) => {
          if (name === "setup-lifecycle.json")
            return [
              name,
              (await readSetupLifecycle(options.cwd))?.fingerprint ?? null,
            ];
          try {
            return [
              name,
              hash(
                await readFile(join(options.cwd, ".saasfunnels", name), "utf8"),
              ),
            ];
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return [name, null];
            throw error;
          }
        },
      ),
    );

    const remote = (
      await exec("git", ["remote", "get-url", "origin"], { cwd: options.cwd })
    ).stdout.trim();
    const repositoryKey = safeRepositoryKey(remote);
    const baselineResponse = await request(
      `/api/developer-tools/setup/baseline?repositoryKey=${encodeURIComponent(repositoryKey)}`,
    );
    const baseline = baselineSchema.parse(baselineResponse.baseline);
    if (baselineResponse.generation !== context.generation)
      throw new Error("The app connection changed. Start setup again.");
    const revision = `${head}:${hash(JSON.stringify(["configuration-v4", SAASFUNNELS_CLI_VERSION, diff, sourceHashes, reviewedInputs, baseline]))}`;
    const statePath = join(options.cwd, ".saasfunnels", "setup-run.json");
    if (options.resume) {
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      if (
        saved.cliVersion !== SAASFUNNELS_CLI_VERSION ||
        saved.generation !== context.generation ||
        saved.repositoryKey !== repositoryKey ||
        saved.revision !== revision
      )
        throw new Error(
          "The app connection, installer, or source changed. Start a fresh scan: npx --yes saasfunnels@latest setup run",
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
        exitCode: options.prompt ? 0 : 2,
        stdout:
          "Discovery cancelled. Nothing was uploaded. Run npx --yes saasfunnels@latest setup when ready.\n",
        stderr: "",
      };
    run = (
      await request("/api/developer-tools/setup/runs", {
        generation: context.generation,
        repositoryKey,
        repositoryRevisionHash: hash(revision),
        baseline,
      })
    ).run;
    if (!run) throw new Error("Setup did not return a run.");
    await mkdir(join(options.cwd, ".saasfunnels"), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify(
        {
          cliVersion: SAASFUNNELS_CLI_VERSION,
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
    let selection = "receiving";
    const send = (
      evidence: unknown,
      proposals?: unknown,
      coverage?: unknown,
    ) => {
      const currentStage = stage;
      if (
        JSON.stringify({
          runId: run!.id,
          stage: currentStage,
          evidence,
          ...(proposals ? { proposals } : {}),
          ...(coverage ? { coverage } : {}),
        }).length > 1_000_000
      )
        throw new Error(
          "Feature discovery evidence exceeds the upload size limit. Review the source scope before retrying.",
        );
      heartbeat = heartbeat.then(async () => {
        const result = await request("/api/developer-tools/setup/evidence", {
          runId: run!.id,
          stage: currentStage,
          evidence,
          ...(proposals ? { proposals } : {}),
          ...(coverage ? { coverage } : {}),
        });
        selection = result.selection ?? selection;
        if (typeof result.sequence === "number")
          run!.sequence = result.sequence;
        run!.receipts[currentStage] = result.receipt ?? { complete: true };
        if (currentStage === "plans")
          run!.planNames =
            result.planNames ??
            (
              evidence as { plans: Array<{ key: string; name: string }> }
            ).plans.flatMap((plan) => [plan.key, plan.name]);
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
    let discoveredLifecycle: SetupLifecycleFinding[] = [];
    const limitations = await discoverCoverageLimitations(
      options.cwd,
      (file) => {
        discoveredLifecycle = combineLifecycleFindings([
          ...discoveredLifecycle,
          ...discoverLifecycleInSource(file),
        ]);
      },
    );
    if (limitations.length)
      options.progress?.(
        "Some app behavior needs manual review. Coverage details will appear with your findings in Setup.",
      );
    options.progress?.(
      run.receipts.features
        ? "2/4 Features already submitted."
        : "2/4 Discovering features…",
    );
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
        freshDiscovery: true,
        accept: ["all"],
      });
      const unsupportedOnly =
        scan.coverage.scannedFiles === 0 &&
        !scan.coverage.byteLimitReached &&
        limitations.some((l) => l.code === "unsupported_language");
      if (!scan.coverage.complete && !unsupportedOnly) {
        const reason = scan.coverage.byteLimitReached
          ? `${scan.coverage.oversizedFileCount} source file(s) exceed the 2 MB per-file limit. Split large source files before retrying.`
          : !scan.coverage.scannedFiles
            ? "No JavaScript or TypeScript app files were found in the source roots. Run from the application folder."
            : "More than 10,000 feature bindings were found. Review the source scope before retrying.";
        throw new Error(
          `Feature discovery needs attention: ${reason} Scanned ${scan.coverage.scannedFiles} of ${scan.coverage.matchedFiles} files. Nothing was submitted for this stage.`,
        );
      }
      options.progress?.(
        `Scanned ${scan.scannedFileCount} files; found ${scan.manifest.features.length} feature proposals.`,
      );
      if (scan.manifest.features.length > 500)
        throw new Error(
          "Feature discovery needs attention: more than 500 features. Narrow the application scope before retrying; nothing was submitted.",
        );
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
        scan.manifest.features.map((feature) => ({
          featureKey: feature.key,
          name: feature.name,
          accessModel: feature.accessModel,
          reason: feature.evidence.some((e) => e.symbol === "plan_catalog")
            ? "plan_catalog"
            : feature.accessModel === "limit"
              ? "usage_check"
              : feature.evidence.some(
                    (e) => e.bindingKind === "server_enforcement",
                  )
                ? "access_check"
                : feature.evidence.some(
                      (e) => e.bindingKind === "browser_presentation",
                    )
                  ? "visibility_gate"
                  : "denied_access",
        })),
        {
          status: unsupportedOnly ? "unsupported" : "complete",
          scannedFiles: scan.coverage.scannedFiles,
        },
      );
    }
    stage = "plans";
    if (!context.catalogReady)
      options.progress?.(
        "Waiting for your Stripe catalog. Setup can stay open while it imports…",
      );
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
          "Stripe is still importing. Run npx --yes saasfunnels@latest setup run --resume when the catalog is ready.\n",
        stderr: "",
      };
    options.progress?.(
      run.receipts.plans
        ? "3/4 Plans already submitted."
        : "3/4 Discovering plans and prices…",
    );
    if (!run.receipts.plans) {
      await update("running");
      const candidates = await discoverPlanSourceCandidates({
        cwd: options.cwd,
      });
      let manual: string | null = null;
      try {
        manual = await readFile(
          join(options.cwd, ".saasfunnels/setup-pricing.json"),
          "utf8",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        (manual === null ? null : hash(manual)) !==
        reviewedInputs.find(([name]) => name === "setup-pricing.json")?.[1]
      )
        throw new Error(
          "The app connection, installer, or source changed. Start a fresh scan: npx --yes saasfunnels@latest setup run",
        );
      const correction =
        manual !== null
          ? extractSetupPatch(
              manual,
              context.catalogPrices,
              baselineResponse.plans ?? [],
            )
          : null;
      const byKey = new Map<
        string,
        ReturnType<typeof extractSetupPricing>[number]
      >();
      const reviewedFiles: string[] = [];
      const issues: { file: string; reason: string }[] = [];
      const sources =
        manual !== null
          ? [{ path: ".saasfunnels/setup-pricing.json", kind: "json" as const }]
          : candidates;
      for (const candidate of correction ? [] : sources) {
        try {
          const plans = extractSetupPricing(
            manual ??
              (await readFile(join(options.cwd, candidate.path), "utf8")),
            candidate.kind,
            context.catalogPrices,
          );
          for (const plan of plans) {
            if (
              byKey.has(plan.key) &&
              JSON.stringify(byKey.get(plan.key)) !== JSON.stringify(plan)
            )
              throw new PricingExtractionError(
                "needs_review",
                "Conflicting declarations for the same plan.",
              );
            byKey.set(plan.key, plan);
          }
          reviewedFiles.push(candidate.path);
        } catch (error) {
          if (
            manual === null &&
            error instanceof PricingExtractionError &&
            error.code === "no_declarations"
          )
            continue;
          issues.push({
            file: candidate.path,
            reason:
              error instanceof PricingExtractionError
                ? error.message
                : "Unsupported pricing syntax.",
          });
        }
      }
      if (reviewedFiles.length > 12 || byKey.size > 200)
        issues.push({
          file: "pricing",
          reason:
            "Combine the pricing declarations into at most 12 files and 200 plans.",
        });
      if (issues.length) {
        await writeFile(
          join(options.cwd, ".saasfunnels/setup-review.json"),
          JSON.stringify({ stage: "plans", issues }, null, 2) + "\n",
          { mode: 0o600 },
        );
        await update("waiting", "extraction_unsupported");
        return {
          exitCode: 2,
          stdout: `Pricing needs review in ${issues.length} file(s). See .saasfunnels/setup-review.json for the exact files and reasons. Ask your coding agent to review those declarations, or prepare .saasfunnels/setup-pricing.json, then run npx --yes saasfunnels@latest setup run for a fresh scan. No pricing evidence was submitted.\n`,
          stderr: "",
        };
      }
      options.progress?.(
        `Found ${byKey.size} plan proposals in ${reviewedFiles.length} pricing files.`,
      );
      let developerAnswers: unknown = undefined;
      let answerInputFingerprint: string | null = null;
      try {
        const raw = await readFile(
          join(options.cwd, ".saasfunnels/setup-answers.json"),
          "utf8",
        );
        if (raw.length > 100_000)
          throw new Error("Developer answers exceed the upload limit.");
        answerInputFingerprint = hash(raw);
        developerAnswers = developerAnswersSchema.parse(JSON.parse(raw));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        answerInputFingerprint !==
        reviewedInputs.find(([name]) => name === "setup-answers.json")?.[1]
      )
        throw new Error(
          "The app connection, installer, or source changed. Start a fresh scan: npx --yes saasfunnels@latest setup run",
        );
      const lifecycle = await readSetupLifecycle(options.cwd);
      if (
        (lifecycle?.fingerprint ?? null) !==
        reviewedInputs.find(([name]) => name === "setup-lifecycle.json")?.[1]
      )
        throw new LifecycleEvidenceError("changed");
      // Transport failures must not be reported as unsupported source syntax.
      await send({
        coverage: { status: "complete", scannedFiles: sources.length },
        ...(developerAnswers ? { developerAnswers } : {}),
        lifecycle: combineLifecycleFindings(
          discoveredLifecycle,
          lifecycle?.findings ?? [],
        ),
        plans:
          correction?.mode === "patch"
            ? []
            : correction
              ? correction.patches
              : [...byKey.values()],
        ...(correction?.mode === "patch"
          ? { patches: correction.patches }
          : {}),
        update: {
          mode: correction?.mode ?? "snapshot",
          baseline,
          removals: correction?.removals ?? [],
          ...(correction?.withdrawDeveloperAnswers
            ? { withdrawDeveloperAnswers: correction.withdrawDeveloperAnswers }
            : {}),
          ...(correction?.withdrawLifecycle
            ? { withdrawLifecycle: correction.withdrawLifecycle }
            : {}),
        },
        reviewedFiles: correction
          ? [".saasfunnels/setup-pricing.json"]
          : reviewedFiles,
        ...(limitations.length ? { limitations } : {}),
      });
    }

    stage = "branches";
    const planValues = [
      ...new Set([...context.planNames, ...(run.planNames ?? [])]),
    ];
    options.progress?.(
      run.receipts.branches
        ? "4/4 Plan checks already submitted."
        : "4/4 Checking plan conditions…",
    );
    if (!run.receipts.branches) {
      await update("running");
      const branches = planValues.length
        ? await discoverPlanBranches({
            cwd: options.cwd,
            planValues,
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
      options.progress?.(`Found ${clusters.length} groups of plan conditions.`);
      await send({
        clusters,
        environment: context.environment,
        planValues,
        producer: "cli",
        repositoryKey,
        repositoryRevision: revision,
        schemaVersion: 1,
      });
    }
    return {
      exitCode: 0,
      stdout: `Discovery submitted. ${selection === "rejected" ? "This submission was rejected in Setup. Current findings and decisions are retained." : selection === "superseded" ? "A newer submission is selected in Setup. Current findings and decisions are retained." : selection === "complete_candidate" ? "Existing findings and decisions are retained; review proposed removals or finish the pending publication in Setup." : "Corrections are ready for review; unrelated records and saved decisions are retained."} Open https://app.saasfunnels.ai/app/setup. Configuration has not been published.\n`,
      stderr: "",
    };
  } catch (error) {
    clearInterval(timer);
    await reportFailure?.().catch(() => {});
    // Never print provider bodies, environment values, or credential-bearing git errors.
    const safe =
      error instanceof LifecycleEvidenceError
        ? error.message
        : error instanceof Error &&
            /^(Setup request failed|Connect Stripe|The app connection|Use a repository|Feature discovery|Plan discovery|Repository setup|This app does not support)/.test(
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
        "x-saasfunnels-cli-version": SAASFUNNELS_CLI_VERSION,
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
  const baselineResponse = await call(
    `/api/developer-tools/setup/baseline?repositoryKey=${encodeURIComponent(input.repositoryKey)}`,
  );
  const baseline = baselineSchema.parse(baselineResponse.baseline);
  const { run } = await call("/api/developer-tools/setup/runs", {
    generation: context.generation,
    repositoryKey: input.repositoryKey,
    repositoryRevisionHash: hash(input.revision),
    baseline,
  });
  await call("/api/developer-tools/setup/evidence", {
    runId: run.id,
    stage: "plans",
    evidence: {
      ...input.evidence,
      coverage: {
        status: "complete",
        scannedFiles: input.evidence.reviewedFiles.length,
      },
      update: { mode: "snapshot", baseline, removals: [] },
    },
  });
  return { accepted: true };
}
