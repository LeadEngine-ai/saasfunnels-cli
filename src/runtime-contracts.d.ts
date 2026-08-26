export type DeveloperToolEventSource = "direct" | "posthog" | "segment";

export type DeveloperToolValidationIssue = {
  code: string;
  message: string;
  path?: string;
  severity: "error" | "info" | "warning";
};

export type DeveloperToolSourceContract = {
  auth_summary: string;
  docs_url: string;
  endpoint: string;
  key: DeveloperToolEventSource;
  name: string;
  recommended_allowlist: string[];
  required_fields: string[];
  sample_payload: Record<string, unknown>;
  scope: string;
  setup_steps: string[];
};

export const DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION: string;
export const developerToolEventSources: readonly DeveloperToolEventSource[];
export const eventKinds: readonly string[];
export const eventSentimentSources: readonly string[];
export const eventSentiments: readonly string[];
export const semanticEventTypes: readonly string[];
export const signalFamilyContracts: readonly Array<{
  description: string;
  label: string;
  optionalSemanticTypes: string[];
  requiredSemanticTypes: string[];
  signalFamilyKey: string;
}>;

export const featureInstrumentationManifestSchema: import("zod").ZodTypeAny;

export function getDeveloperToolAgentHandoffArtifacts(input: {
  endpoint: string;
  eventPlan?: unknown;
}): Record<
  "claude-code" | "codex" | "cursor" | "markdown",
  {
    file_contents: string;
    install_command?: string;
    label: string;
    prompt: string;
    target: string;
    target_path: string;
    version: string;
  }
>;

export function getDeveloperToolSourceContract(
  source: DeveloperToolEventSource,
): DeveloperToolSourceContract;

export function validateDeveloperToolEventPayload(input: {
  payload: unknown;
  source: DeveloperToolEventSource;
}): {
  errors: DeveloperToolValidationIssue[];
  idempotency: Record<string, unknown>;
  mapping_hints: Record<string, unknown>;
  normalized_event?: Record<string, unknown>;
  ok: boolean;
  redaction: Record<string, unknown>;
  revenue_relevant?: boolean;
  schema_version: string;
  source: DeveloperToolEventSource;
  warnings: DeveloperToolValidationIssue[];
};
