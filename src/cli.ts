import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  getDeveloperToolAgentHandoffArtifacts,
  getDeveloperToolSourceContract,
  validateDeveloperToolEventPayload,
  type DeveloperToolEventSource,
} from "./runtime-contracts.js";
import {
  buildFeatureInstrumentationHandoff,
  featureSdkVersionsFromPackageJson,
  featureSetupSummary,
  isFeatureKey,
  parseFeatureManifestSource,
  parseFeatureMappings,
  runFeatureRuntimeCheck,
  runFeatureSetup,
} from "./feature-setup.ts";
import {
  SAASFUNNELS_CLI_NAME,
  SAASFUNNELS_DEFAULT_API_BASE_URL,
  SAASFUNNELS_ENV,
  SAASFUNNELS_PRODUCT_NAME,
  saasFunnelsPublicText,
} from "./identity.ts";
import { serveSaaSFunnelsMcp } from "./mcp.ts";

type CliEnv = Record<string, string | undefined>;

type CliFileSystem = {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, contents: string, encoding: "utf8"): Promise<void>;
};

export type SaaSFunnelsCliOptions = {
  cwd?: string;
  env?: CliEnv;
  fetch?: typeof fetch;
  fs?: CliFileSystem;
  prompt?: (message: string) => Promise<string>;
};

export type SaaSFunnelsCliResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

type ParsedArgs = {
  args: string[];
  flags: Record<string, string | boolean>;
};

const cliSchemaVersion = "2026-07-02.1";
const targetNames = new Set(["codex", "claude-code", "cursor", "markdown"]);
const sourceNames = new Set(["direct", "posthog", "segment"]);
const tokenPattern =
  /\b((?:pv|sk|pk|rk|whsec|xox[baprs]|gh[pousr])_[A-Za-z0-9_=-]{8,}|[A-Za-z0-9_-]{32,})\b/g;

function parseArgs(argv: string[]): ParsedArgs {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      args.push(value);
      continue;
    }

    const [rawName, inlineValue] = value.slice(2).split("=", 2);
    const next = argv[index + 1];
    if (inlineValue !== undefined) {
      flags[rawName] = inlineValue;
    } else if (next && !next.startsWith("--")) {
      flags[rawName] = next;
      index += 1;
    } else {
      flags[rawName] = true;
    }
  }

  return { args, flags };
}

function flagString(flags: ParsedArgs["flags"], name: string) {
  const value = flags[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasFlag(flags: ParsedArgs["flags"], name: string) {
  return flags[name] === true;
}

function jsonMode(flags: ParsedArgs["flags"]) {
  return hasFlag(flags, "json");
}

function redactOutput(value: string) {
  return value.replace(tokenPattern, (candidate) =>
    /^[A-Z0-9_]+$/.test(candidate) ? candidate : "[redacted-token]",
  );
}

function result(exitCode: number, stdout = "", stderr = ""): SaaSFunnelsCliResult {
  return {
    exitCode,
    stderr: redactOutput(stderr),
    stdout: redactOutput(stdout),
  };
}

function jsonResult(exitCode: number, data: unknown) {
  return result(exitCode, `${JSON.stringify(data, null, 2)}\n`);
}

function usage() {
  return `${SAASFUNNELS_PRODUCT_NAME} CLI

Usage:
  ${SAASFUNNELS_CLI_NAME} init [--api-base-url <url>] [--force]
  ${SAASFUNNELS_CLI_NAME} agent install --target codex|claude-code|cursor|markdown [--endpoint <url>]
  ${SAASFUNNELS_CLI_NAME} events validate <file> [--source direct|posthog|segment] [--json]
  ${SAASFUNNELS_CLI_NAME} events sample [--source direct|posthog|segment] [--json]
  ${SAASFUNNELS_CLI_NAME} events send-test [--file <file>] [--json]
  ${SAASFUNNELS_CLI_NAME} features setup [--root <paths>] [--exclude <paths>] [--accept <ids|all>] [--reject <ids>] [--map <id=key>] [--manifest-only] [--apply] [--json]
  ${SAASFUNNELS_CLI_NAME} features check --feature <key> --account-id <uuid> [--environment test] [--json]
  ${SAASFUNNELS_CLI_NAME} features handoff [--file <path>] --repository-revision <revision> [--send] [--json]
  ${SAASFUNNELS_CLI_NAME} catalog discover [feature setup options]
  ${SAASFUNNELS_CLI_NAME} catalog validate [file] [--json]
  ${SAASFUNNELS_CLI_NAME} catalog diff [feature setup options]
  ${SAASFUNNELS_CLI_NAME} doctor [--events] [--mappings] [--destinations] [--signals] [--json]
  ${SAASFUNNELS_CLI_NAME} readiness [--json]
  ${SAASFUNNELS_CLI_NAME} verify [--event <file>] [--catalog <file>] [--live] [--json]
  ${SAASFUNNELS_CLI_NAME} mcp serve [--enable-funnel-writes] [--enable-send-test-event]

Environment:
  SAASFUNNELS_API_KEY          developer:read key for doctor/readiness/live verify
  SAASFUNNELS_INGEST_API_KEY   direct:write or events:write key for send-test
  SAASFUNNELS_FUNNELS_SERVER_KEY  Test server key for Feature decisions; never expose it to a browser
  SAASFUNNELS_API_BASE_URL     defaults to ${SAASFUNNELS_DEFAULT_API_BASE_URL}; override for localhost, previews, or rollback
  SAASFUNNELS_MCP_ENABLE_FUNNEL_WRITES  set true to expose versioned Funnel draft write tools
`;
}

function flagList(flags: ParsedArgs["flags"], name: string) {
  return (flagString(flags, name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function filesystem(options: SaaSFunnelsCliOptions): CliFileSystem {
  return (
    options.fs ?? {
      mkdir: async (path, mkdirOptions) => {
        await mkdir(path, mkdirOptions);
      },
      readFile,
      writeFile,
    }
  );
}

function cwd(options: SaaSFunnelsCliOptions) {
  return options.cwd ?? process.cwd();
}

function env(options: SaaSFunnelsCliOptions): CliEnv {
  return options.env ?? process.env;
}

function envValue(options: SaaSFunnelsCliOptions, names: readonly string[]) {
  const values = env(options);
  for (const name of names) {
    const value = values[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function apiBaseUrl(options: SaaSFunnelsCliOptions, flags: ParsedArgs["flags"]) {
  const value =
    flagString(flags, "api-base-url") ??
    envValue(options, SAASFUNNELS_ENV.apiBaseUrl) ??
    SAASFUNNELS_DEFAULT_API_BASE_URL;
  return value.replace(/\/+$/, "");
}

function sourceFlag(flags: ParsedArgs["flags"]): DeveloperToolEventSource {
  const source = flagString(flags, "source") ?? "direct";
  if (sourceNames.has(source)) return source as DeveloperToolEventSource;
  throw new Error(
    `Unknown source "${source}". Use direct, posthog, or segment.`,
  );
}

async function readJsonFile(filePath: string, options: SaaSFunnelsCliOptions) {
  const raw = await filesystem(options).readFile(
    resolve(cwd(options), filePath),
    "utf8",
  );
  return JSON.parse(raw) as Record<string, unknown>;
}

async function commandInit(
  flags: ParsedArgs["flags"],
  options: SaaSFunnelsCliOptions,
) {
  const fs = filesystem(options);
  const configPath = join(cwd(options), ".saasfunnels", "config.json");
  const config = {
    api_base_url: apiBaseUrl(options, flags),
    schema_version: cliSchemaVersion,
  };

  await fs.mkdir(dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  if (jsonMode(flags)) {
    return jsonResult(0, {
      config_path: ".saasfunnels/config.json",
      ok: true,
      schema_version: cliSchemaVersion,
    });
  }

  return result(0, "Created .saasfunnels/config.json\n");
}

async function commandAgentInstall(
  args: string[],
  flags: ParsedArgs["flags"],
  options: SaaSFunnelsCliOptions,
) {
  if (args[0] !== "install")
    return result(
      2,
      "",
      `Usage: ${SAASFUNNELS_CLI_NAME} agent install --target codex|claude-code|cursor|markdown\n`,
    );
  const target = flagString(flags, "target");
  if (!target || !targetNames.has(target))
    return result(
      2,
      "",
      "Missing --target codex|claude-code|cursor|markdown\n",
    );

  const endpoint =
    flagString(flags, "endpoint") ??
    `${apiBaseUrl(options, flags)}/api/events/ingest`;
  const artifacts = getDeveloperToolAgentHandoffArtifacts({ endpoint });
  const artifact = artifacts[target as keyof typeof artifacts];
  const targetPath =
    flagString(flags, "path") ?? saasFunnelsPublicText(artifact.target_path);
  const absoluteTarget = join(cwd(options), targetPath);
  const fs = filesystem(options);

  await fs.mkdir(dirname(absoluteTarget), { recursive: true });
  await fs.writeFile(
    absoluteTarget,
    saasFunnelsPublicText(artifact.file_contents),
    "utf8",
  );

  if (jsonMode(flags)) {
    return jsonResult(0, {
      ok: true,
      target,
      target_path: targetPath,
      version: artifact.version,
    });
  }

  return result(0, `Installed ${artifact.label} handoff at ${targetPath}\n`);
}

async function commandEvents(
  args: string[],
  flags: ParsedArgs["flags"],
  options: SaaSFunnelsCliOptions,
) {
  const action = args[0];
  if (action === "validate")
    return commandEventsValidate(args.slice(1), flags, options);
  if (action === "sample") return commandEventsSample(flags);
  if (action === "send-test")
    return commandEventsSendTest(args.slice(1), flags, options);
  return result(
    2,
    "",
    `Usage: ${SAASFUNNELS_CLI_NAME} events validate|sample|send-test\n`,
  );
}

async function commandFeaturesSetup(
  flags: ParsedArgs["flags"],
  options: SaaSFunnelsCliOptions,
) {
  const environment = flagString(flags, "environment") ?? "test";
  if (environment !== "test" && environment !== "production") {
    return result(2, "", "--environment must be test or production.\n");
  }
  const interactive =
    !jsonMode(flags) && !hasFlag(flags, "non-interactive")
      ? options.prompt
      : undefined;
  const setup = await runFeatureSetup({
    accept: flagList(flags, "accept"),
    accountId: flagString(flags, "account-id"),
    apiBaseUrl: apiBaseUrl(options, flags),
    apply: hasFlag(flags, "apply"),
    cwd: cwd(options),
    environment,
    exclude: flagList(flags, "exclude"),
    fetch: options.fetch,
    include: flagList(flags, "root"),
    manifestOnly: hasFlag(flags, "manifest-only"),
    mappings: parseFeatureMappings(flagList(flags, "map")),
    prompt: interactive,
    reject: flagList(flags, "reject"),
    serverKey: envValue(options, SAASFUNNELS_ENV.funnelsServerKey),
  });
  if (jsonMode(flags)) return jsonResult(setup.ok ? 0 : 1, setup);
  return result(setup.ok ? 0 : 1, `${featureSetupSummary(setup)}\n`);
}

async function commandFeatures(
  args: string[],
  flags: ParsedArgs["flags"],
  options: SaaSFunnelsCliOptions,
) {
  if (args[0] === "setup") return commandFeaturesSetup(flags, options);
  if (args[0] === "check") {
    const environment = flagString(flags, "environment") ?? "test";
    const featureKey = flagString(flags, "feature");
    const accountId = flagString(flags, "account-id");
    if (environment !== "test")
      return result(
        2,
        "",
        "Feature diagnostics are Test-only. Promote separately after verification.\n",
      );
    if (!featureKey || !isFeatureKey(featureKey))
      return result(2, "", "Provide a valid --feature key.\n");
    if (
      !accountId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        accountId,
      )
    )
      return result(
        2,
        "",
        "Provide the UUID of a Test account with --account-id.\n",
      );
    const serverKey = envValue(options, SAASFUNNELS_ENV.funnelsServerKey);
    if (!serverKey)
      return result(
        2,
        "",
        "Set SAASFUNNELS_FUNNELS_SERVER_KEY to a Test server key with funnels:entitlements:check scope.\n",
      );
    const checked = await runFeatureRuntimeCheck({
      accountId,
      apiBaseUrl: apiBaseUrl(options, flags),
      featureKey,
      fetch: options.fetch,
      serverKey,
    });
    if (jsonMode(flags))
      return jsonResult(checked.state === "passed" ? 0 : 1, checked);
    if (checked.state !== "passed" || !checked.decision)
      return result(1, "", `${checked.reason ?? "Test decision failed."}\n`);
    return result(
      0,
      [
        `Test decision: ${checked.decision.allowed ? "allowed" : "denied"}`,
        `Feature: ${featureKey}`,
        `Reason: ${checked.decision.reasonCode}`,
        `Source: ${checked.decision.source}`,
      ].join("\n") + "\n",
    );
  }
  if (args[0] === "handoff") {
    const path = flagString(flags, "file") ?? ".saasfunnels/catalog.yaml";
    const repositoryRevision = flagString(flags, "repository-revision");
    if (!repositoryRevision) {
      return result(
        2,
        "",
        "Missing --repository-revision for the structured Feature handoff.\n",
      );
    }
    const source = await filesystem(options).readFile(
      resolve(cwd(options), path),
      "utf8",
    );
    const validation = parseFeatureManifestSource(source);
    if (!validation.ok || !validation.manifest) {
      return jsonMode(flags)
        ? jsonResult(1, validation)
        : result(
            1,
            "",
            `Feature catalog validation failed:\n${validation.errors.map((error) => `- ${error}`).join("\n")}\n`,
          );
    }
    let sdkVersions: string[] = [];
    try {
      const packageSource = await filesystem(options).readFile(
        resolve(cwd(options), "package.json"),
        "utf8",
      );
      sdkVersions = featureSdkVersionsFromPackageJson(
        JSON.parse(packageSource),
      );
    } catch {
      // The readiness view will identify missing SDK evidence after handoff.
    }
    const handoff = buildFeatureInstrumentationHandoff({
      manifest: validation.manifest,
      repositoryRevision,
      sdkVersions,
    });
    if (hasFlag(flags, "send")) {
      const key = envValue(options, SAASFUNNELS_ENV.apiKey);
      if (!key)
        return result(
          2,
          "",
          "Missing SAASFUNNELS_API_KEY with features:write scope for --send.\n",
        );
      const response = await (options.fetch ?? fetch)(
        `${apiBaseUrl(options, flags)}/api/developer-tools/features/instrumentation`,
        {
          body: JSON.stringify(handoff),
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
          },
          method: "POST",
        },
      );
      const body = await response.json();
      return jsonMode(flags)
        ? jsonResult(response.ok ? 0 : 1, body)
        : response.ok
          ? result(
              0,
              "Feature instrumentation handoff accepted. Open the Features review link returned by SaaSFunnels.\n",
            )
          : result(1, "", "Feature instrumentation handoff was rejected.\n");
    }
    return jsonMode(flags)
      ? jsonResult(0, handoff)
      : result(0, `${JSON.stringify(handoff, null, 2)}\n`);
  }
  return result(
    2,
    "",
    `Usage: ${SAASFUNNELS_CLI_NAME} features setup|check|handoff [options]\n`,
  );
}

async function commandCatalog(
  args: string[],
  flags: ParsedArgs["flags"],
  options: SaaSFunnelsCliOptions,
) {
  const action = args[0];
  if (action === "discover") return commandFeaturesSetup(flags, options);
  if (action === "diff") {
    const diffFlags = { ...flags };
    if (!flagString(diffFlags, "accept")) diffFlags.accept = "all";
    delete diffFlags.apply;
    return commandFeaturesSetup(diffFlags, options);
  }
  if (action === "validate") {
    const path = args[1] ?? ".saasfunnels/catalog.yaml";
    const source = await filesystem(options).readFile(
      resolve(cwd(options), path),
      "utf8",
    );
    const validation = parseFeatureManifestSource(source);
    if (jsonMode(flags)) return jsonResult(validation.ok ? 0 : 1, validation);
    return validation.ok
      ? result(0, `OK: ${path} is a valid Feature catalog manifest.\n`)
      : result(
          1,
          `Feature catalog validation failed:\n${validation.errors.map((error) => `- ${error}`).join("\n")}\n`,
        );
  }
  return result(
    2,
    "",
    `Usage: ${SAASFUNNELS_CLI_NAME} catalog discover|validate|diff\n`,
  );
}

async function commandEventsValidate(
  args: string[],
  flags: ParsedArgs["flags"],
  options: SaaSFunnelsCliOptions,
) {
  const filePath = args[0];
  if (!filePath)
    return result(
      2,
      "",
      `Usage: ${SAASFUNNELS_CLI_NAME} events validate <file> [--source direct|posthog|segment]\n`,
    );

  const source = sourceFlag(flags);
  const payload = await readJsonFile(filePath, options);
  const validation = validateDeveloperToolEventPayload({ payload, source });
  const exitCode = validation.errors.length > 0 ? 1 : 0;

  if (jsonMode(flags)) return jsonResult(exitCode, validation);

  const issueLines = [...validation.errors, ...validation.warnings].map(
    (issue) =>
      `- ${issue.code}${issue.path ? ` (${issue.path})` : ""}: ${issue.message}`,
  );
  const header = validation.ok
    ? `OK: ${source} event payload is valid.`
    : `Validation failed for ${source} event payload.`;
  return result(
    exitCode,
    `${header}\n${issueLines.length ? `${issueLines.join("\n")}\n` : ""}`,
  );
}

function commandEventsSample(flags: ParsedArgs["flags"]) {
  const source = sourceFlag(flags);
  const contract = getDeveloperToolSourceContract(source);

  if (jsonMode(flags)) return jsonResult(0, contract);

  return result(
    0,
    [
      `${contract.name} sample`,
      `Endpoint: ${contract.endpoint}`,
      `Scope: ${contract.scope}`,
      "Auth: Authorization: Bearer <SAASFUNNELS_INGEST_KEY>",
      "",
      JSON.stringify(contract.sample_payload, null, 2),
      "",
    ].join("\n"),
  );
}

async function commandEventsSendTest(
  args: string[],
  flags: ParsedArgs["flags"],
  options: SaaSFunnelsCliOptions,
) {
  const key =
    envValue(options, SAASFUNNELS_ENV.ingestApiKey) ??
    flagString(flags, "api-key");
  if (!key)
    return result(2, "", "Missing SAASFUNNELS_INGEST_API_KEY for send-test.\n");

  const filePath = flagString(flags, "file") ?? args[0];
  const payload = filePath
    ? await readJsonFile(filePath, options)
    : getDeveloperToolSourceContract("direct").sample_payload;
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(
    `${apiBaseUrl(options, flags)}/api/events/ingest`,
    {
      body: JSON.stringify(payload),
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  const body = (await response.json()) as {
    data?: Record<string, unknown>;
    error?: string;
    ok?: boolean;
  };
  const data = body.data ?? {};
  const exitCode =
    response.ok && body.ok !== false && !data.rejected_reason ? 0 : 1;

  if (jsonMode(flags)) return jsonResult(exitCode, body);

  if (!response.ok || body.ok === false)
    return result(exitCode, "", `${body.error ?? `HTTP ${response.status}`}\n`);
  return result(
    exitCode,
    [
      data.rejected_reason
        ? "Test event was received but rejected."
        : "Test event sent.",
      `persisted: ${String(data.persisted ?? false)}`,
      `duplicate: ${String(data.duplicate ?? false)}`,
      `workflow_enqueued: ${String(data.workflow_enqueued ?? false)}`,
      data.rejected_reason
        ? `rejected_reason: ${String(data.rejected_reason)}`
        : undefined,
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function developerGet(
  path: string,
  flags: ParsedArgs["flags"],
  options: SaaSFunnelsCliOptions,
) {
  const key =
    envValue(options, SAASFUNNELS_ENV.apiKey) ?? flagString(flags, "api-key");
  if (!key)
    throw new Error(
      "Missing SAASFUNNELS_API_KEY for live developer diagnostics.",
    );

  const response = await (options.fetch ?? fetch)(
    `${apiBaseUrl(options, flags)}${path}`,
    {
      headers: {
        authorization: `Bearer ${key}`,
      },
      method: "GET",
    },
  );
  const body = await response.json();
  if (!response.ok) {
    const message =
      typeof body === "object" && body && "error" in body
        ? String((body as { error?: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as { data?: Record<string, unknown>; ok?: boolean };
}

async function commandDoctor(
  flags: ParsedArgs["flags"],
  options: SaaSFunnelsCliOptions,
) {
  const focused = ["events", "mappings", "destinations", "signals"].filter(
    (flag) => hasFlag(flags, flag),
  );
  const all = focused.length === 0;
  const checks: Array<[string, string]> = [
    ["workspace", "/api/developer-tools/workspace"],
    ...(all || focused.includes("destinations")
      ? [
          ["integrations", "/api/developer-tools/integrations/health"] as [
            string,
            string,
          ],
        ]
      : []),
    ...(all || focused.includes("events")
      ? [["events", "/api/developer-tools/events/health"] as [string, string]]
      : []),
    ...(all || focused.includes("mappings")
      ? [["mappings", "/api/developer-tools/mappings/gaps"] as [string, string]]
      : []),
    ...(all || focused.includes("signals")
      ? [["signals", "/api/developer-tools/signals/recent"] as [string, string]]
      : []),
  ];

  try {
    const entries = await Promise.all(
      checks.map(
        async ([name, path]) =>
          [name, await developerGet(path, flags, options)] as const,
      ),
    );
    const data = Object.fromEntries(entries);
    if (jsonMode(flags))
      return jsonResult(0, {
        ok: true,
        schema_version: cliSchemaVersion,
        checks: data,
      });
    return result(
      0,
      `${SAASFUNNELS_PRODUCT_NAME} doctor completed ${checks.length} checks.\n`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to run doctor.";
    return jsonMode(flags)
      ? jsonResult(2, {
          error: message,
          ok: false,
          schema_version: cliSchemaVersion,
        })
      : result(2, "", `${message}\n`);
  }
}

async function commandReadiness(
  flags: ParsedArgs["flags"],
  options: SaaSFunnelsCliOptions,
) {
  try {
    const response = await developerGet(
      "/api/developer-tools/signals/readiness",
      flags,
      options,
    );
    if (jsonMode(flags)) return jsonResult(0, response);

    const rows = Array.isArray(response.data?.readiness)
      ? (response.data.readiness as Array<Record<string, unknown>>)
      : [];
    const lines = rows.map(
      (row) => `- ${row.label}: ${row.status} (${row.next_action_label})`,
    );
    return result(0, `Signal readiness\n${lines.join("\n")}\n`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to read readiness.";
    return jsonMode(flags)
      ? jsonResult(2, {
          error: message,
          ok: false,
          schema_version: cliSchemaVersion,
        })
      : result(2, "", `${message}\n`);
  }
}

type VerifyCheck = {
  details?: Record<string, unknown>;
  ok: boolean;
};

async function commandVerify(
  flags: ParsedArgs["flags"],
  options: SaaSFunnelsCliOptions,
) {
  const checks: Record<string, VerifyCheck> = {};
  const errors: Array<{ code: string; message: string }> = [];
  const warnings: Array<{ code: string; message: string }> = [];
  let configurationFailure = false;

  const contractResults = [...sourceNames].map((source) => {
    const contract = getDeveloperToolSourceContract(
      source as DeveloperToolEventSource,
    );
    const validation = validateDeveloperToolEventPayload({
      payload: contract.sample_payload,
      source: source as DeveloperToolEventSource,
    });
    return {
      error_count: validation.errors.length,
      ok: validation.errors.length === 0,
      source,
      warning_count: validation.warnings.length,
    };
  });
  checks.source_contracts = {
    details: { sources: contractResults },
    ok: contractResults.every((item) => item.ok),
  };
  if (!checks.source_contracts.ok) {
    errors.push({
      code: "source_contract_invalid",
      message: "One or more bundled source contracts failed validation.",
    });
  }

  const eventPath = flagString(flags, "event");
  if (eventPath) {
    const source = sourceFlag(flags);
    try {
      const payload = await readJsonFile(eventPath, options);
      const validation = validateDeveloperToolEventPayload({ payload, source });
      checks.event = {
        details: {
          error_codes: validation.errors.map((issue) => issue.code),
          source,
          warning_codes: validation.warnings.map((issue) => issue.code),
        },
        ok: validation.errors.length === 0,
      };
      for (const issue of validation.errors) {
        errors.push({ code: issue.code, message: issue.message });
      }
      for (const issue of validation.warnings) {
        warnings.push({ code: issue.code, message: issue.message });
      }
    } catch (error) {
      checks.event = { ok: false };
      errors.push({
        code: "event_file_unreadable",
        message:
          error instanceof Error ? error.message : "Unable to read event file.",
      });
    }
  }

  const catalogPath = flagString(flags, "catalog");
  if (catalogPath) {
    try {
      const source = await filesystem(options).readFile(
        resolve(cwd(options), catalogPath),
        "utf8",
      );
      const validation = parseFeatureManifestSource(source);
      checks.catalog = {
        details: { errors: validation.errors },
        ok: validation.ok,
      };
      for (const message of validation.errors) {
        errors.push({ code: "catalog_invalid", message });
      }
    } catch (error) {
      checks.catalog = { ok: false };
      errors.push({
        code: "catalog_file_unreadable",
        message:
          error instanceof Error
            ? error.message
            : "Unable to read catalog file.",
      });
    }
  }

  if (hasFlag(flags, "live")) {
    try {
      const [workspace, integrations, readiness] = await Promise.all([
        developerGet("/api/developer-tools/workspace", flags, options),
        developerGet(
          "/api/developer-tools/integrations/health",
          flags,
          options,
        ),
        developerGet("/api/developer-tools/signals/readiness", flags, options),
      ]);
      checks.live = {
        details: {
          integration_check_ok: integrations.ok !== false,
          readiness_rows: Array.isArray(readiness.data?.readiness)
            ? readiness.data.readiness.length
            : 0,
          workspace_check_ok: workspace.ok !== false,
        },
        ok:
          workspace.ok !== false &&
          integrations.ok !== false &&
          readiness.ok !== false,
      };
      if (!checks.live.ok) {
        errors.push({
          code: "live_check_failed",
          message: "One or more customer-safe live checks failed.",
        });
      }
    } catch (error) {
      checks.live = { ok: false };
      configurationFailure = true;
      errors.push({
        code: "live_check_unavailable",
        message:
          error instanceof Error
            ? error.message
            : "Unable to complete live checks.",
      });
    }
  } else {
    warnings.push({
      code: "live_checks_skipped",
      message:
        "Live checks were skipped. Add --live when a scoped key is available.",
    });
  }

  const ok = errors.length === 0;
  const output = {
    checks,
    errors,
    ok,
    schema_version: cliSchemaVersion,
    warnings,
  };
  const exitCode = ok ? 0 : configurationFailure ? 2 : 1;
  if (jsonMode(flags)) return jsonResult(exitCode, output);

  const lines = Object.entries(checks).map(
    ([name, check]) => `- ${name}: ${check.ok ? "passed" : "failed"}`,
  );
  return result(
    exitCode,
    `${SAASFUNNELS_PRODUCT_NAME} verify ${ok ? "passed" : "failed"}.\n${lines.join("\n")}\n`,
  );
}

async function commandMcp(
  args: string[],
  flags: ParsedArgs["flags"],
  options: SaaSFunnelsCliOptions,
) {
  if (args[0] === "serve") {
    if (hasFlag(flags, "help")) {
      return result(
        0,
        `Starts the ${SAASFUNNELS_PRODUCT_NAME} MCP server over stdio. Live reads use SAASFUNNELS_API_KEY; Funnel runtime Test challenges require --enable-funnel-tests; setup smoke sends require --enable-send-test-event and SAASFUNNELS_INGEST_API_KEY.\n`,
      );
    }
    const cliEnv = env(options);
    await serveSaaSFunnelsMcp({
      allowFunnelTests:
        hasFlag(flags, "enable-funnel-tests") ||
        envValue(options, SAASFUNNELS_ENV.mcpEnableFunnelTests) === "true",
      allowFunnelWrites:
        hasFlag(flags, "enable-funnel-writes") ||
        envValue(options, SAASFUNNELS_ENV.mcpEnableFunnelWrites) === "true",
      allowTestWrites:
        hasFlag(flags, "enable-send-test-event") ||
        envValue(options, SAASFUNNELS_ENV.mcpEnableSendTestEvent) === "true",
      env: {
        ...cliEnv,
        SAASFUNNELS_API_BASE_URL: apiBaseUrl(options, flags),
        SAASFUNNELS_API_KEY: envValue(options, SAASFUNNELS_ENV.apiKey),
        SAASFUNNELS_INGEST_API_KEY: envValue(
          options,
          SAASFUNNELS_ENV.ingestApiKey,
        ),
      },
      fetch: options.fetch ?? fetch,
    });
    return result(0);
  }
  return result(2, "", `Usage: ${SAASFUNNELS_CLI_NAME} mcp serve\n`);
}

export async function runSaaSFunnelsCli(
  argv: string[],
  options: SaaSFunnelsCliOptions = {},
): Promise<SaaSFunnelsCliResult> {
  const parsed = parseArgs(argv);
  const [command, ...args] = parsed.args;

  try {
    if (!command || command === "help" || command === "--help")
      return result(0, usage());
    if (command === "init") return await commandInit(parsed.flags, options);
    if (command === "agent")
      return await commandAgentInstall(args, parsed.flags, options);
    if (command === "events")
      return await commandEvents(args, parsed.flags, options);
    if (command === "features")
      return await commandFeatures(args, parsed.flags, options);
    if (command === "catalog")
      return await commandCatalog(args, parsed.flags, options);
    if (command === "doctor") return await commandDoctor(parsed.flags, options);
    if (command === "readiness")
      return await commandReadiness(parsed.flags, options);
    if (command === "verify") return await commandVerify(parsed.flags, options);
    if (command === "mcp") return await commandMcp(args, parsed.flags, options);
    return result(2, "", `Unknown command "${command}".\n\n${usage()}`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown CLI error.";
    return result(1, "", `${message}\n`);
  }
}
