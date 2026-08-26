import { createInterface } from "node:readline";
import {
  DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION,
  developerToolEventSources,
  eventKinds,
  eventSentimentSources,
  eventSentiments,
  getDeveloperToolAgentHandoffArtifacts,
  getDeveloperToolSourceContract,
  semanticEventTypes,
  signalFamilyContracts,
  validateDeveloperToolEventPayload,
  type DeveloperToolEventSource,
} from "./runtime-contracts.js";
import {
  agentCapabilityAllowedAtBoundary,
  getAgentCapability,
  type AgentCapabilityId,
} from "./capabilities.ts";
import { validateFeatureCatalogManifest } from "./feature-setup.ts";
import {
  SAASFUNNELS_CLI_VERSION,
  SAASFUNNELS_DEFAULT_API_BASE_URL,
  SAASFUNNELS_ENV,
  SAASFUNNELS_PRODUCT_NAME,
  saasFunnelsPublicText,
} from "./identity.ts";

type McpEnv = Record<string, string | undefined>;
export type SaaSFunnelsMcpJsonObject = Record<string, unknown>;
type JsonObject = SaaSFunnelsMcpJsonObject;
type JsonRpcId = number | string | null;
type JsonRpcResponse = {
  error?: {
    code: number;
    data?: unknown;
    message: string;
  };
  id: JsonRpcId;
  jsonrpc: "2.0";
  result?: unknown;
};

type JsonRpcRequest = {
  id?: JsonRpcId;
  jsonrpc?: string;
  method?: string;
  params?: unknown;
};

export type SaaSFunnelsMcpToolDefinition = {
  annotations?: Record<string, unknown>;
  description: string;
  inputSchema: JsonObject;
  name: string;
  outputSchema?: JsonObject;
  title: string;
};
type McpToolDefinition = SaaSFunnelsMcpToolDefinition;

export type SaaSFunnelsMcpResourceDefinition = {
  description: string;
  mimeType: string;
  name: string;
  title: string;
  uri: string;
};
type McpResourceDefinition = SaaSFunnelsMcpResourceDefinition;

export const saasFunnelsMcpToolCapabilityIds = {
  get_account_strategy: "account.strategy.read",
  apply_funnel_entry: "funnel.entry.apply",
  generate_direct_api_handoff: "developer.handoff.generate",
  get_integration_health: "developer.workspace.read",
  get_signal_payload_preview: "developer.workspace.read",
  get_workspace_readiness: "developer.workspace.read",
  inspect_funnel_entry: "funnel.entry.inspect",
  list_mapping_gaps: "developer.workspace.read",
  list_recent_signals: "developer.workspace.read",
  simulate_account_funnel_fit: "account.funnel_fit.simulate",
  propose_funnel_entry_installation: "funnel.entry.plan",
  run_funnel_binding_test: "funnel.entry.test",
  send_test_event: "setup.test_event.send",
  submit_funnel_entry_evidence: "funnel.entry.evidence.submit",
  validate_event_payload: "developer.event.validate",
  validate_feature_catalog_manifest: "developer.feature_manifest.validate",
} as const satisfies Readonly<Record<string, AgentCapabilityId>>;

export type SaaSFunnelsMcpToolName = keyof typeof saasFunnelsMcpToolCapabilityIds;

export function saasFunnelsMcpCapabilityForTool(name: string) {
  const capabilityId =
    saasFunnelsMcpToolCapabilityIds[name as SaaSFunnelsMcpToolName];
  return capabilityId ? getAgentCapability(capabilityId) : null;
}

function assertMcpToolCapabilityContract(
  tools: McpToolDefinition[],
  boundary: "hosted_mcp" | "local_mcp",
) {
  for (const tool of tools) {
    const capability = saasFunnelsMcpCapabilityForTool(tool.name);
    if (!capability) {
      throw new Error(`MCP tool ${tool.name} has no agent capability owner.`);
    }
    const mutationEnabled = tool.annotations?.readOnlyHint === false;
    if (
      !agentCapabilityAllowedAtBoundary(capability.id, boundary, {
        mutationsEnabled: mutationEnabled,
      })
    ) {
      throw new Error(
        `MCP tool ${tool.name} is not allowed by capability ${capability.id}.`,
      );
    }
  }
}

export type SaaSFunnelsMcpOptions = {
  apiBaseUrlOverride?: string;
  allowFunnelWrites?: boolean;
  allowFunnelTests?: boolean;
  allowTestWrites?: boolean;
  authorizationHeader?: string;
  env?: McpEnv;
  fetch?: typeof fetch;
  hostedMode?: boolean;
  input?: NodeJS.ReadableStream;
  output?: Pick<NodeJS.WritableStream, "write">;
};

const defaultApiBaseUrl = SAASFUNNELS_DEFAULT_API_BASE_URL;
const mcpProtocolVersion = "2025-06-18";
const mcpServerVersion = SAASFUNNELS_CLI_VERSION;
const handoffTargets = ["markdown", "codex", "claude-code", "cursor"] as const;
const sourceNames = new Set<string>(developerToolEventSources);
const tokenPattern =
  /\b((?:pv|sk|pk|rk|whsec|xox[baprs]|gh[pousr])_[A-Za-z0-9_=-]{8,}|[A-Za-z0-9_-]{32,})\b/g;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const sensitiveKeyPattern =
  /(authorization|token|secret|password|session|cookie|email|invite|signature|webhook)/i;

class McpProtocolError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

class McpToolExecutionError extends Error {
  structuredContent: JsonObject;

  constructor(message: string, structuredContent: JsonObject) {
    super(message);
    this.structuredContent = structuredContent;
  }
}

function optionsEnv(options: SaaSFunnelsMcpOptions): McpEnv {
  return options.env ?? process.env;
}

function envValue(options: SaaSFunnelsMcpOptions, names: readonly string[]) {
  const values = optionsEnv(options);
  for (const name of names) {
    const value = values[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function apiBaseUrl(options: SaaSFunnelsMcpOptions, args?: JsonObject) {
  const override = options.apiBaseUrlOverride?.trim();
  if (override) return override.replace(/\/+$/, "");
  const argValue =
    typeof args?.api_base_url === "string" ? args.api_base_url.trim() : "";
  const configuredBaseUrl = envValue(options, SAASFUNNELS_ENV.apiBaseUrl);
  return (argValue || configuredBaseUrl || defaultApiBaseUrl).replace(/\/+$/, "");
}

function parseArgs(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function stringArg(args: JsonObject, name: string) {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sourceArg(args: JsonObject): DeveloperToolEventSource {
  const source = stringArg(args, "source") ?? "direct";
  if (!sourceNames.has(source)) {
    throw new McpProtocolError(
      -32602,
      `Unknown source "${source}". Use direct, posthog, or segment.`,
    );
  }
  return source as DeveloperToolEventSource;
}

function objectArg(args: JsonObject, name: string) {
  const value = args[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpProtocolError(-32602, `"${name}" must be a JSON object.`);
  }
  return value as JsonObject;
}

function sanitizeString(value: string) {
  const withoutSecrets = value
    .replace(tokenPattern, (candidate) =>
      /^[A-Z0-9_]+$/.test(candidate) ? candidate : "[redacted-token]",
    )
    .replace(emailPattern, "[redacted-email]");
  try {
    const parsed = new URL(
      withoutSecrets,
      withoutSecrets.startsWith("/") ? "https://local.saasfunnels" : undefined,
    );
    if (parsed.search) {
      parsed.search = "?[redacted-query]";
      return parsed.toString().replace("https://local.saasfunnels", "");
    }
  } catch {
    // Not a URL-like string.
  }
  return withoutSecrets;
}

function sanitizeJson(value: unknown, key = "", depth = 0): unknown {
  if (depth > 8) return "[truncated-depth]";
  if (typeof value === "string") {
    if (
      (key === "testToken" || key === "test_token") &&
      /^fet1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32,256}$/.test(value) &&
      value.length <= 8_192
    )
      return value;
    if (sensitiveKeyPattern.test(key)) return "[redacted]";
    return sanitizeString(value);
  }
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitizeJson(item, key, depth + 1));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .slice(0, 100)
      .map(([nestedKey, nestedValue]) => [
        nestedKey,
        sanitizeJson(nestedValue, nestedKey, depth + 1),
      ]),
  );
}

function saasFunnelsPublicValue(value: unknown): unknown {
  if (typeof value === "string") return saasFunnelsPublicText(value);
  if (Array.isArray(value)) return value.map(saasFunnelsPublicValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject).map(([key, nested]) => [
      key,
      saasFunnelsPublicValue(nested),
    ]),
  );
}

function structuredToolResult(data: unknown, isError = false) {
  const structuredContent = saasFunnelsPublicValue(
    sanitizeJson(data),
  ) as JsonObject;
  return {
    content: [
      {
        text: JSON.stringify(structuredContent, null, 2),
        type: "text",
      },
    ],
    isError,
    structuredContent,
  };
}

function successResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return {
    id,
    jsonrpc: "2.0",
    result: saasFunnelsPublicValue(result),
  };
}

function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    error: {
      code,
      data: saasFunnelsPublicValue(sanitizeJson(data)),
      message: saasFunnelsPublicText(sanitizeString(message)),
    },
    id,
    jsonrpc: "2.0",
  };
}

function sourceRequirementsMarkdown(source: DeveloperToolEventSource) {
  const contract = getDeveloperToolSourceContract(source);
  return [
    `# ${contract.name} Source Requirements`,
    "",
    `Endpoint: \`${contract.endpoint}\``,
    `Scope: \`${contract.scope}\``,
    `Auth: ${contract.auth_summary}`,
    "",
    "## Required Fields",
    ...contract.required_fields.map((field) => `- ${field}`),
    "",
    "## Recommended Allowlist",
    ...contract.recommended_allowlist.map((eventName) => `- \`${eventName}\``),
    "",
    "## Setup Steps",
    ...contract.setup_steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Sample Payload",
    "```json",
    JSON.stringify(sanitizeJson(contract.sample_payload), null, 2),
    "```",
  ].join("\n");
}

function semanticsMarkdown() {
  const familyRows = signalFamilyContracts
    .map(
      (family) =>
        `- ${family.label} (\`${family.signalFamilyKey}\`): required [${family.requiredSemanticTypes.join(", ") || "none"}], optional [${family.optionalSemanticTypes.join(", ") || "none"}]. ${family.description}`,
    )
    .join("\n");

  return [
    "# SaaSFunnels Event Semantics",
    "",
    "SaaSFunnels is a revenue decisioning layer. Prefer fewer high-signal product, billing, lifecycle, setup, support, and integration events over broad analytics noise.",
    "",
    "## Semantic Types",
    ...semanticEventTypes.map((type) => `- \`${type}\``),
    "",
    "## Event Kinds",
    ...eventKinds.map((kind) => `- \`${kind}\``),
    "",
    "## Sentiment Fields",
    `- sentiment: ${eventSentiments.map((value) => `\`${value}\``).join(", ")}`,
    `- sentiment_source: ${eventSentimentSources.map((value) => `\`${value}\``).join(", ")}`,
    "- sentiment_score: number from -1 to 1",
    "- sentiment_confidence: number from 0 to 1",
    "",
    "## Signal Families",
    familyRows,
  ].join("\n");
}

function safetyMarkdown() {
  return [
    "# SaaSFunnels Data Exposure Policy",
    "",
    "Never expose full API keys, provider tokens, auth headers, cookies, signatures, webhook URLs, invite links, support transcripts, prompts, comments, raw provider payloads, or arbitrary free text through CLI or MCP output. The only token-shaped exception is the explicitly enabled, short-lived fet1 Funnel Test challenge; pass it only to the exact runtime Test request and never persist or log it.",
    "",
    "Allowed output should stay compact and bounded: key prefixes, scopes, provider names, status labels, counts, timestamps, static event names, semantic types, readiness rows, signal IDs, rule/family names, and safe payload previews with PII policy metadata.",
    "",
    "Direct API keys belong only in server-side environment variables. Do not place workspace ingest keys in browser, mobile, desktop, or public client code.",
    "",
    "Every P0/P1 event should include account identity and source idempotency when possible. SaaSFunnels should resolve the tenant workspace server-side from credentials, not from a caller-supplied workspace ID.",
    "",
    "MCP defaults to read-only tools. The only MVP write-like tool is `send_test_event`, and it must be explicitly enabled as a setup smoke test.",
  ].join("\n");
}

function featureCatalogMarkdown() {
  return [
    "# SaaSFunnels Feature Catalog Manifest",
    "",
    "The CLI owns `.saasfunnels/catalog.yaml`. Discovery is local-only and Test-only; source content is never uploaded by the setup command.",
    "",
    "Required top-level fields:",
    "- `schemaVersion: 1`",
    "- `generatedBy: saasfunnels features setup`",
    "- `environment: test|production`",
    "- `features`: unique canonical Feature definitions",
    "",
    "Each Feature requires `key`, `name`, `description`, `accessModel`, `unit`, `aliases`, and bounded evidence metadata. Boolean Features use a null unit; Limit Features require a unit.",
    "",
    "MCP may validate an already-provided manifest, but it cannot scan a repository or write files. Run `saasfunnels features setup` locally for discovery and reviewed diffs.",
  ].join("\n");
}

function funnelEntryInstallationMarkdown() {
  return [
    "# Funnel Entry Installation",
    "",
    "Inspect the current Funnel entry before proposing or applying a change. Product and Direct API events use catalog-backed event entries. A button or element uses an explicit browser/React binding that emits a named event entry. A server-controlled start uses an API invocation entry. Lifecycle entries remain catalog-backed, and placement stays separate from entry.",
    "",
    "The host coding agent owns local repository inspection and edits. SaaSFunnels MCP never scans the filesystem. Submit only bounded binding metadata; never send source code, patches, DOM snapshots, credentials, environment values, or customer payloads.",
    "",
    "Funnel writes require explicit MCP enablement, a SAASFUNNELS_API_KEY with funnels:author scope, the current draft revision, and an idempotency key. MCP can update a draft but cannot publish it.",
  ].join("\n");
}

export function saasFunnelsMcpResources(): McpResourceDefinition[] {
  return [
    {
      description:
        "Semantic event types, event kinds, sentiment fields, and signal-family unlock context.",
      mimeType: "text/markdown",
      name: "events",
      title: "SaaSFunnels Event Semantics",
      uri: "saasfunnels://semantics/events",
    },
    ...developerToolEventSources.map((source) => {
      const contract = getDeveloperToolSourceContract(source);
      return {
        description: `${contract.name} source requirements, auth boundary, allowlist, and sample payload.`,
        mimeType: "text/markdown",
        name: source,
        title: `${contract.name} Requirements`,
        uri: `saasfunnels://sources/${source === "direct" ? "direct-api" : source}`,
      } satisfies McpResourceDefinition;
    }),
    {
      description:
        "Redaction, secret handling, payload safety, and read-only MCP policy.",
      mimeType: "text/markdown",
      name: "data-exposure",
      title: "Data Exposure Policy",
      uri: "saasfunnels://safety/data-exposure",
    },
    {
      description:
        "Feature catalog manifest contract and local-only setup boundary.",
      mimeType: "text/markdown",
      name: "feature-catalog",
      title: "Feature Catalog Manifest",
      uri: "saasfunnels://features/catalog-schema",
    },
    {
      description:
        "Funnel entry kinds, coding-agent installation boundary, and safe draft-authoring policy.",
      mimeType: "text/markdown",
      name: "funnel-entry-installation",
      title: "Funnel Entry Installation",
      uri: "saasfunnels://funnels/entry-installation",
    },
    ...handoffTargets.map((target) => ({
      description: `Generated Direct API handoff artifact for ${target}. Uses placeholders only.`,
      mimeType: "text/markdown",
      name: `direct-api-${target}`,
      title: `Direct API Handoff: ${target}`,
      uri: `saasfunnels://agent-handoff/direct-api/${target}`,
    })),
  ].map((resource) => ({
    ...resource,
    description: saasFunnelsPublicText(resource.description),
    title: saasFunnelsPublicText(resource.title),
    uri: saasFunnelsPublicText(resource.uri),
  }));
}

export function readSaaSFunnelsMcpResource(
  uri: string,
  options: SaaSFunnelsMcpOptions = {},
) {
  const internalUri = uri.replace(/^prevenue:/, "saasfunnels:");
  if (internalUri === "saasfunnels://semantics/events")
    return saasFunnelsPublicText(semanticsMarkdown());
  if (internalUri === "saasfunnels://sources/direct-api")
    return saasFunnelsPublicText(sourceRequirementsMarkdown("direct"));
  if (internalUri === "saasfunnels://sources/posthog")
    return saasFunnelsPublicText(sourceRequirementsMarkdown("posthog"));
  if (internalUri === "saasfunnels://sources/segment")
    return saasFunnelsPublicText(sourceRequirementsMarkdown("segment"));
  if (internalUri === "saasfunnels://safety/data-exposure")
    return saasFunnelsPublicText(safetyMarkdown());
  if (internalUri === "saasfunnels://features/catalog-schema")
    return saasFunnelsPublicText(featureCatalogMarkdown());
  if (internalUri === "saasfunnels://funnels/entry-installation")
    return saasFunnelsPublicText(funnelEntryInstallationMarkdown());

  const handoffPrefix = "saasfunnels://agent-handoff/direct-api/";
  if (internalUri.startsWith(handoffPrefix)) {
    const target = internalUri.slice(handoffPrefix.length);
    if (!handoffTargets.includes(target as (typeof handoffTargets)[number])) {
      throw new McpProtocolError(
        -32602,
        `Unknown Direct API handoff target "${target}".`,
      );
    }
    const endpoint = `${apiBaseUrl(options)}/api/events/ingest`;
    const artifacts = getDeveloperToolAgentHandoffArtifacts({ endpoint });
    return saasFunnelsPublicText(
      artifacts[target as keyof typeof artifacts].file_contents,
    );
  }

  throw new McpProtocolError(-32602, `Unknown resource "${uri}".`);
}

const apiBaseUrlSchema = {
  description:
    "Optional SaaSFunnels app base URL. Prefer SAASFUNNELS_API_BASE_URL in MCP server env.",
  type: "string",
};

function emptyLiveInputSchema() {
  return {
    additionalProperties: false,
    properties: {
      api_base_url: apiBaseUrlSchema,
    },
    type: "object",
  };
}

export function saasFunnelsMcpToolDefinitions({
  allowFunnelTests = false,
  allowFunnelWrites = false,
  allowTestWrites = false,
  includeHostedAccountTools = false,
}: {
  allowFunnelTests?: boolean;
  allowFunnelWrites?: boolean;
  allowTestWrites?: boolean;
  includeHostedAccountTools?: boolean;
} = {}): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [
    {
      annotations: {
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Validate a Direct API, PostHog, or Segment event payload locally and return missing identity, unsafe field, idempotency, and mapping hints.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          payload: {
            description:
              "Event payload object to validate. Do not include secrets or arbitrary free text.",
            type: "object",
          },
          source: {
            default: "direct",
            enum: developerToolEventSources,
            type: "string",
          },
        },
        required: ["payload"],
        type: "object",
      },
      name: "validate_event_payload",
      title: "Validate Event Payload",
    },
    {
      annotations: {
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Validate an already-provided SaaSFunnels Feature catalog manifest locally. This tool cannot scan source code or write project files.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          manifest: {
            description:
              "Parsed `.saasfunnels/catalog.yaml` object. Do not include source contents or secrets.",
            type: "object",
          },
        },
        required: ["manifest"],
        type: "object",
      },
      name: "validate_feature_catalog_manifest",
      title: "Validate Feature Catalog Manifest",
    },
    {
      annotations: {
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Generate a Direct API implementation handoff artifact for Codex, Claude Code, Cursor, or Markdown using placeholders only.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          endpoint: {
            description:
              "Optional Direct API ingest endpoint. Defaults to SAASFUNNELS_API_BASE_URL + /api/events/ingest.",
            type: "string",
          },
          target: {
            enum: handoffTargets,
            type: "string",
          },
        },
        required: ["target"],
        type: "object",
      },
      name: "generate_direct_api_handoff",
      title: "Generate Direct API Handoff",
    },
    {
      annotations: {
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Read compact integration/source/destination health through the developer:read platform API.",
      inputSchema: emptyLiveInputSchema(),
      name: "get_integration_health",
      title: "Get Integration Health",
    },
    {
      annotations: {
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Read signal-family readiness rows and next actions through the developer:read platform API.",
      inputSchema: emptyLiveInputSchema(),
      name: "get_workspace_readiness",
      title: "Get Workspace Readiness",
    },
    {
      annotations: {
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "List event mapping gaps through the developer:read platform API without raw event payloads.",
      inputSchema: emptyLiveInputSchema(),
      name: "list_mapping_gaps",
      title: "List Mapping Gaps",
    },
    {
      annotations: {
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "List bounded recent signal summaries through the developer:read platform API.",
      inputSchema: emptyLiveInputSchema(),
      name: "list_recent_signals",
      title: "List Recent Signals",
    },
    {
      annotations: {
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Read a safe, redacted payload preview for a signal through the developer:read platform API.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          api_base_url: apiBaseUrlSchema,
          signal_id: {
            type: "string",
          },
        },
        required: ["signal_id"],
        type: "object",
      },
      name: "get_signal_payload_preview",
      title: "Get Signal Payload Preview",
    },
    {
      annotations: {
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Inspect one editable Funnel's current entry, placement, draft revision, bounded catalog choices, and current Test state.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          api_base_url: apiBaseUrlSchema,
          funnel_id: { type: "string" },
        },
        required: ["funnel_id"],
        type: "object",
      },
      name: "inspect_funnel_entry",
      title: "Inspect Funnel Entry",
    },
    {
      annotations: {
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Generate a source-free coding-agent installation plan and collision-safe entry key without changing the Funnel draft.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          api_base_url: apiBaseUrlSchema,
          entry_kind: { enum: ["event", "api"], type: "string" },
          funnel_id: { type: "string" },
          intent: { type: "string" },
          placement_key: { type: "string" },
          preferred_binding: {
            enum: ["browser_event", "react_event", "server_invocation"],
            type: "string",
          },
        },
        required: ["funnel_id", "entry_kind", "intent"],
        type: "object",
      },
      name: "propose_funnel_entry_installation",
      title: "Propose Funnel Entry Installation",
    },
  ];

  if (includeHostedAccountTools) {
    tools.push({
      annotations: {
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Read one existing Account Strategist brief with bounded evidence, confidence, caveats, and freshness. Does not generate a new strategy or create an account action.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          account_id: { type: "string" },
          api_base_url: apiBaseUrlSchema,
        },
        required: ["account_id"],
        type: "object",
      },
      name: "get_account_strategy",
      title: "Get Account Strategy",
    });
    tools.push({
      annotations: {
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Simulate one account against up to eight current published Funnels through the production decision evaluator. Returns eligibility and suppression explanations without enrollment, delivery, identity mutation, or runtime writes.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          account_id: { type: "string" },
          api_base_url: apiBaseUrlSchema,
        },
        required: ["account_id"],
        type: "object",
      },
      name: "simulate_account_funnel_fit",
      title: "Simulate Account Funnel Fit",
    });
  }

  if (allowFunnelWrites) {
    tools.push({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Apply an explicit event, lifecycle, or server/API entry and placement to the current versioned Funnel draft. Never publishes.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          api_base_url: apiBaseUrlSchema,
          entry: {
            description:
              "Exact entry object returned or derived from inspection/plan.",
            type: "object",
          },
          expected_draft_revision: { minimum: 0, type: "integer" },
          funnel_id: { type: "string" },
          idempotency_key: { type: "string" },
          placement_key: { type: "string" },
        },
        required: [
          "funnel_id",
          "entry",
          "expected_draft_revision",
          "idempotency_key",
          "placement_key",
        ],
        type: "object",
      },
      name: "apply_funnel_entry",
      title: "Apply Funnel Entry",
    });
    tools.push({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Submit bounded source-free coding-agent evidence for the current Funnel draft entry. Raw source, patches, DOM, environment values, and credentials are rejected.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          api_base_url: apiBaseUrlSchema,
          funnel_id: { type: "string" },
          manifest: {
            description:
              "Structured installation manifest returned by the host coding agent. Never include source code or secrets.",
            type: "object",
          },
        },
        required: ["funnel_id", "manifest"],
        type: "object",
      },
      name: "submit_funnel_entry_evidence",
      title: "Submit Funnel Entry Evidence",
    });
  }

  if (allowFunnelTests) {
    tools.push({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Create a short-lived Test challenge for the exact current Funnel draft and manifest. Pass test_token only to the real React/browser/server entry request; detection is recorded at runtime ingress and never publishes.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          api_base_url: apiBaseUrlSchema,
          expected_draft_revision: { minimum: 0, type: "integer" },
          funnel_id: { type: "string" },
          idempotency_key: { type: "string" },
        },
        required: [
          "funnel_id",
          "expected_draft_revision",
          "idempotency_key",
        ],
        type: "object",
      },
      name: "run_funnel_binding_test",
      title: "Run Funnel Binding Test",
    });
  }
  if (allowTestWrites) {
    tools.push({
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Send one Direct API setup smoke event through /api/events/ingest. Requires SAASFUNNELS_INGEST_API_KEY and explicit MCP write enablement.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          api_base_url: apiBaseUrlSchema,
          payload: {
            description:
              "Optional Direct API payload object. Defaults to a safe sample payload.",
            type: "object",
          },
        },
        type: "object",
      },
      name: "send_test_event",
      title: "Send Test Event",
    });
  }

  const publicTools = tools.map(
    (tool) => saasFunnelsPublicValue(tool) as McpToolDefinition,
  );
  if (!includeHostedAccountTools) {
    assertMcpToolCapabilityContract(publicTools, "local_mcp");
  } else {
    for (const tool of publicTools) {
      if (!saasFunnelsMcpCapabilityForTool(tool.name)) {
        throw new Error(`MCP tool ${tool.name} has no agent capability owner.`);
      }
    }
  }
  return publicTools;
}

export function hostedSaaSFunnelsMcpToolDefinitions() {
  const tools = saasFunnelsMcpToolDefinitions({ includeHostedAccountTools: true }).filter((tool) => {
    const capability = saasFunnelsMcpCapabilityForTool(tool.name);
    return Boolean(
      capability &&
      agentCapabilityAllowedAtBoundary(capability.id, "hosted_mcp"),
    );
  });
  assertMcpToolCapabilityContract(tools, "hosted_mcp");
  return tools;
}

async function parseResponseJson(response: Response) {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as JsonObject;
  } catch {
    return { raw_response_redacted: sanitizeString(text.slice(0, 800)) };
  }
}

async function developerGet(
  path: string,
  args: JsonObject,
  options: SaaSFunnelsMcpOptions,
) {
  const key = envValue(options, SAASFUNNELS_ENV.apiKey);
  const authorization =
    options.authorizationHeader ?? (key ? `Bearer ${key}` : undefined);
  if (!authorization) {
    throw new McpToolExecutionError("Missing SAASFUNNELS_API_KEY.", {
      error: "Missing SAASFUNNELS_API_KEY for live developer reads.",
      ok: false,
      required_env: "SAASFUNNELS_API_KEY",
      required_scope: "developer:read",
      schema_version: DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION,
    });
  }

  const response = await (options.fetch ?? fetch)(
    `${apiBaseUrl(options, args)}${path}`,
    {
      headers: {
        authorization,
      },
      method: "GET",
    },
  );
  const body = await parseResponseJson(response);
  if (!response.ok || body.ok === false) {
    throw new McpToolExecutionError(
      typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
      {
        error:
          typeof body.error === "string"
            ? body.error
            : `HTTP ${response.status}`,
        ok: false,
        path,
        schema_version: DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION,
        status: response.status,
      },
    );
  }

  return body;
}

async function developerPost(
  path: string,
  args: JsonObject,
  body: JsonObject,
  options: SaaSFunnelsMcpOptions,
  requiredScope: string,
) {
  const key = envValue(options, SAASFUNNELS_ENV.apiKey);
  const authorization =
    options.authorizationHeader ?? (key ? `Bearer ${key}` : undefined);
  if (!authorization) {
    throw new McpToolExecutionError("Missing SAASFUNNELS_API_KEY.", {
      error: "Missing SAASFUNNELS_API_KEY for this Funnel operation.",
      ok: false,
      required_env: "SAASFUNNELS_API_KEY",
      required_scope: requiredScope,
      schema_version: DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION,
    });
  }
  const response = await (options.fetch ?? fetch)(
    `${apiBaseUrl(options, args)}${path}`,
    {
      body: JSON.stringify(body),
      headers: {
        authorization,
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  const responseBody = await parseResponseJson(response);
  if (!response.ok || responseBody.ok === false) {
    throw new McpToolExecutionError(
      typeof responseBody.error === "string"
        ? responseBody.error
        : `HTTP ${response.status}`,
      {
        ...(responseBody as JsonObject),
        error:
          typeof responseBody.error === "string"
            ? responseBody.error
            : `HTTP ${response.status}`,
        ok: false,
        path,
        schema_version: DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION,
        status: response.status,
      },
    );
  }
  return responseBody;
}

async function sendTestEvent(args: JsonObject, options: SaaSFunnelsMcpOptions) {
  if (!options.allowTestWrites) {
    throw new McpToolExecutionError("send_test_event is disabled.", {
      enablement:
        "Start the MCP server with --enable-send-test-event or SAASFUNNELS_MCP_ENABLE_SEND_TEST_EVENT=true.",
      error:
        "send_test_event is disabled by default because MCP is read-only unless setup smoke writes are explicitly enabled.",
      ok: false,
      schema_version: DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION,
    });
  }

  const key = envValue(options, SAASFUNNELS_ENV.ingestApiKey);
  if (!key) {
    throw new McpToolExecutionError("Missing SAASFUNNELS_INGEST_API_KEY.", {
      error: "Missing SAASFUNNELS_INGEST_API_KEY for setup smoke event sends.",
      ok: false,
      required_env: "SAASFUNNELS_INGEST_API_KEY",
      required_scope: "direct:write or events:write",
      schema_version: DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION,
    });
  }

  const payload =
    args.payload &&
    typeof args.payload === "object" &&
    !Array.isArray(args.payload)
      ? args.payload
      : getDeveloperToolSourceContract("direct").sample_payload;
  const response = await (options.fetch ?? fetch)(
    `${apiBaseUrl(options, args)}/api/events/ingest`,
    {
      body: JSON.stringify(payload),
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  const body = await parseResponseJson(response);
  const data =
    body.data && typeof body.data === "object" ? (body.data as JsonObject) : {};

  return {
    data,
    ok: response.ok && body.ok !== false && !data.rejected_reason,
    schema_version: DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION,
    status: response.status,
    test_only: true,
    write_policy: "setup_smoke_event_only",
  };
}

export async function callSaaSFunnelsMcpTool(
  name: string,
  args: JsonObject,
  options: SaaSFunnelsMcpOptions = {},
) {
  try {
    if (
      (name === "get_account_strategy" ||
        name === "simulate_account_funnel_fit") &&
      !options.hostedMode
    ) {
      throw new McpToolExecutionError(
        "This account tool requires hosted OAuth.",
        {
          error: "This account tool requires hosted OAuth.",
          ok: false,
          required_boundary: "hosted_mcp",
        },
      );
    }
    if (name === "validate_event_payload") {
      return structuredToolResult(
        validateDeveloperToolEventPayload({
          payload: objectArg(args, "payload"),
          source: sourceArg(args),
        }),
      );
    }

    if (name === "validate_feature_catalog_manifest") {
      return structuredToolResult(
        validateFeatureCatalogManifest(objectArg(args, "manifest")),
      );
    }

    if (name === "generate_direct_api_handoff") {
      const target = stringArg(args, "target");
      if (
        !target ||
        !handoffTargets.includes(target as (typeof handoffTargets)[number])
      ) {
        throw new McpProtocolError(
          -32602,
          "target must be one of: markdown, codex, claude-code, cursor.",
        );
      }
      const endpoint =
        stringArg(args, "endpoint") ??
        `${apiBaseUrl(options, args)}/api/events/ingest`;
      const artifacts = getDeveloperToolAgentHandoffArtifacts({ endpoint });
      return structuredToolResult(
        saasFunnelsPublicValue(
          artifacts[target as keyof typeof artifacts],
        ) as JsonObject,
      );
    }

    if (name === "get_integration_health")
      return structuredToolResult(
        await developerGet(
          "/api/developer-tools/integrations/health",
          args,
          options,
        ),
      );
    if (name === "get_workspace_readiness")
      return structuredToolResult(
        await developerGet(
          "/api/developer-tools/signals/readiness",
          args,
          options,
        ),
      );
    if (name === "list_mapping_gaps")
      return structuredToolResult(
        await developerGet("/api/developer-tools/mappings/gaps", args, options),
      );
    if (name === "list_recent_signals")
      return structuredToolResult(
        await developerGet(
          "/api/developer-tools/signals/recent",
          args,
          options,
        ),
      );
    if (name === "get_signal_payload_preview") {
      const signalId = stringArg(args, "signal_id");
      if (!signalId)
        throw new McpProtocolError(-32602, "signal_id is required.");
      return structuredToolResult(
        await developerGet(
          `/api/developer-tools/signals/${encodeURIComponent(signalId)}/payload-preview`,
          args,
          options,
        ),
      );
    }
    if (name === "get_account_strategy") {
      const accountId = stringArg(args, "account_id");
      if (!accountId)
        throw new McpProtocolError(-32602, "account_id is required.");
      return structuredToolResult(
        await developerGet(
          `/api/developer-tools/accounts/${encodeURIComponent(accountId)}/strategy`,
          args,
          options,
        ),
      );
    }
    if (name === "simulate_account_funnel_fit") {
      const accountId = stringArg(args, "account_id");
      if (!accountId)
        throw new McpProtocolError(-32602, "account_id is required.");
      return structuredToolResult(
        await developerGet(
          `/api/developer-tools/accounts/${encodeURIComponent(accountId)}/funnel-fit`,
          args,
          options,
        ),
      );
    }
    if (name === "inspect_funnel_entry") {
      const funnelId = stringArg(args, "funnel_id");
      if (!funnelId)
        throw new McpProtocolError(-32602, "funnel_id is required.");
      return structuredToolResult(
        await developerGet(
          `/api/developer-tools/funnels/${encodeURIComponent(funnelId)}/entry`,
          args,
          options,
        ),
      );
    }
    if (name === "propose_funnel_entry_installation") {
      const funnelId = stringArg(args, "funnel_id");
      const entryKind = stringArg(args, "entry_kind");
      const intent = stringArg(args, "intent");
      if (
        !funnelId ||
        !intent ||
        (entryKind !== "event" && entryKind !== "api")
      ) {
        throw new McpProtocolError(
          -32602,
          "funnel_id, intent, and entry_kind event|api are required.",
        );
      }
      return structuredToolResult(
        await developerPost(
          `/api/developer-tools/funnels/${encodeURIComponent(funnelId)}/entry/plan`,
          args,
          {
            entryKind,
            intent,
            ...(stringArg(args, "placement_key")
              ? { placementKey: stringArg(args, "placement_key") }
              : {}),
            ...(stringArg(args, "preferred_binding")
              ? { preferredBinding: stringArg(args, "preferred_binding") }
              : {}),
          },
          options,
          "developer:read",
        ),
      );
    }
    if (name === "apply_funnel_entry") {
      if (!options.allowFunnelWrites) {
        throw new McpToolExecutionError("Funnel draft writes are disabled.", {
          enablement:
            "Start the MCP server with --enable-funnel-writes or SAASFUNNELS_MCP_ENABLE_FUNNEL_WRITES=true.",
          error: "Funnel draft writes are disabled by default.",
          ok: false,
          required_scope: "funnels:author",
          schema_version: DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION,
        });
      }
      const funnelId = stringArg(args, "funnel_id");
      const idempotencyKey = stringArg(args, "idempotency_key");
      const placementKey = stringArg(args, "placement_key");
      const expectedDraftRevision = args.expected_draft_revision;
      if (
        !funnelId ||
        !idempotencyKey ||
        !placementKey ||
        !Number.isInteger(expectedDraftRevision) ||
        Number(expectedDraftRevision) < 0
      ) {
        throw new McpProtocolError(
          -32602,
          "A Funnel, current draft revision, idempotency key, entry, and placement are required.",
        );
      }
      return structuredToolResult(
        await developerPost(
          `/api/developer-tools/funnels/${encodeURIComponent(funnelId)}/entry`,
          args,
          {
            entry: objectArg(args, "entry"),
            expectedDraftRevision,
            idempotencyKey,
            placementKey,
          },
          options,
          "funnels:author",
        ),
      );
    }
    if (name === "submit_funnel_entry_evidence") {
      if (!options.allowFunnelWrites) {
        throw new McpToolExecutionError("Funnel draft writes are disabled.", {
          enablement:
            "Start the MCP server with --enable-funnel-writes or SAASFUNNELS_MCP_ENABLE_FUNNEL_WRITES=true.",
          error: "Funnel installation evidence writes are disabled by default.",
          ok: false,
          required_scope: "funnels:author",
          schema_version: DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION,
        });
      }
      const funnelId = stringArg(args, "funnel_id");
      if (!funnelId)
        throw new McpProtocolError(-32602, "funnel_id is required.");
      return structuredToolResult(
        await developerPost(
          `/api/developer-tools/funnels/${encodeURIComponent(funnelId)}/entry/evidence`,
          args,
          objectArg(args, "manifest"),
          options,
          "funnels:author",
        ),
      );
    }
    if (name === "run_funnel_binding_test") {
      if (!options.allowFunnelTests) {
        throw new McpToolExecutionError("Funnel binding Test is disabled.", {
          enablement:
            "Start the MCP server with --enable-funnel-tests or SAASFUNNELS_MCP_ENABLE_FUNNEL_TESTS=true.",
          error: "Funnel binding Test is disabled by default.",
          ok: false,
          required_scope: "funnels:test",
          schema_version: DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION,
        });
      }
      const funnelId = stringArg(args, "funnel_id");
      const idempotencyKey = stringArg(args, "idempotency_key");
      const expectedDraftRevision = args.expected_draft_revision;
      if (
        !funnelId ||
        !idempotencyKey ||
        !Number.isInteger(expectedDraftRevision) ||
        Number(expectedDraftRevision) < 0
      )
        throw new McpProtocolError(
          -32602,
          "A Funnel, current draft revision, and idempotency key are required.",
        );
      return structuredToolResult(
        await developerPost(
          `/api/developer-tools/funnels/${encodeURIComponent(funnelId)}/entry/test`,
          args,
          {
            expectedDraftRevision,
            idempotencyKey,
          },
          options,
          "funnels:test",
        ),
      );
    }
    if (name === "send_test_event")
      return structuredToolResult(await sendTestEvent(args, options));
  } catch (error) {
    if (error instanceof McpToolExecutionError)
      return structuredToolResult(error.structuredContent, true);
    throw error;
  }

  throw new McpProtocolError(-32602, `Unknown tool "${name}".`);
}

export async function handleSaaSFunnelsMcpMessage(
  message: unknown,
  options: SaaSFunnelsMcpOptions = {},
): Promise<JsonRpcResponse | undefined> {
  const request = parseArgs(message) as JsonRpcRequest;
  const id = request.id ?? null;

  if (request.jsonrpc && request.jsonrpc !== "2.0")
    return errorResponse(id, -32600, "Invalid JSON-RPC version.");
  if (!request.method) return undefined;

  try {
    if (request.method === "notifications/initialized") return undefined;

    if (request.method === "initialize") {
      return successResponse(id, {
        capabilities: {
          resources: {},
          tools: {
            listChanged: false,
          },
        },
        instructions:
          "Use SaaSFunnels MCP to validate revenue event payloads, inspect and plan Funnel entries, read setup/readiness context, and generate coding-agent handoffs. Live reads require SAASFUNNELS_API_KEY with developer:read scope. Versioned Funnel draft writes require explicit enablement and funnels:author scope; MCP cannot publish. Setup smoke sends require explicit enablement and SAASFUNNELS_INGEST_API_KEY.",
        protocolVersion: mcpProtocolVersion,
        serverInfo: {
          name: SAASFUNNELS_PRODUCT_NAME.toLowerCase(),
          title: "SaaSFunnels",
          version: mcpServerVersion,
        },
      });
    }

    if (request.method === "ping") return successResponse(id, {});

    if (request.method === "resources/list") {
      return successResponse(id, {
        resources: saasFunnelsMcpResources(),
      });
    }

    if (request.method === "resources/read") {
      const params = parseArgs(request.params);
      const uri = stringArg(params, "uri");
      if (!uri) throw new McpProtocolError(-32602, "uri is required.");
      const resource = saasFunnelsMcpResources().find((item) => item.uri === uri);
      return successResponse(id, {
        contents: [
          {
            mimeType: resource?.mimeType ?? "text/markdown",
            text: readSaaSFunnelsMcpResource(uri, options),
            uri,
          },
        ],
      });
    }

    if (request.method === "tools/list") {
      return successResponse(id, {
        tools: saasFunnelsMcpToolDefinitions({
          allowFunnelWrites: Boolean(options.allowFunnelWrites),
          allowFunnelTests: Boolean(options.allowFunnelTests),
          allowTestWrites: Boolean(options.allowTestWrites),
        }),
      });
    }

    if (request.method === "tools/call") {
      const params = parseArgs(request.params);
      const name = stringArg(params, "name");
      if (!name) throw new McpProtocolError(-32602, "Tool name is required.");
      const args = parseArgs(params.arguments);
      return successResponse(
        id,
        await callSaaSFunnelsMcpTool(name, args, options),
      );
    }

    throw new McpProtocolError(-32601, `Unknown method "${request.method}".`);
  } catch (error) {
    if (error instanceof McpProtocolError)
      return errorResponse(id, error.code, error.message, error.data);
    const message =
      error instanceof Error ? error.message : "Internal MCP server error.";
    return errorResponse(id, -32603, message);
  }
}

export async function serveSaaSFunnelsMcp(options: SaaSFunnelsMcpOptions = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const lines = createInterface({ crlfDelay: Infinity, input });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(
        `${JSON.stringify(errorResponse(null, -32700, "Parse error."))}\n`,
      );
      continue;
    }

    const response = await handleSaaSFunnelsMcpMessage(message, options);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

export {
  mcpProtocolVersion as SAASFUNNELS_MCP_PROTOCOL_VERSION,
  mcpServerVersion as SAASFUNNELS_MCP_SERVER_VERSION,
};
