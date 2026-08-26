export type AgentCapabilityId =
  | "account.funnel_fit.simulate"
  | "account.strategy.read"
  | "developer.event.validate"
  | "developer.feature_manifest.validate"
  | "developer.handoff.generate"
  | "developer.workspace.read"
  | "funnel.entry.apply"
  | "funnel.entry.evidence.submit"
  | "funnel.entry.inspect"
  | "funnel.entry.plan"
  | "funnel.entry.test"
  | "setup.test_event.send";

type AgentExecutionBoundary =
  | "api_key"
  | "hosted_mcp"
  | "in_app"
  | "local_cli"
  | "local_mcp"
  | "scheduled_agent";

type AgentOperationClass =
  | "external_write"
  | "plan"
  | "prepare"
  | "read"
  | "reversible_write"
  | "simulate"
  | "validate";

type Capability = {
  boundaries: AgentExecutionBoundary[];
  enabled: true;
  id: AgentCapabilityId;
  operationClass: AgentOperationClass;
};

const capability = (
  id: AgentCapabilityId,
  operationClass: AgentOperationClass,
  boundaries: AgentExecutionBoundary[],
): Capability => ({ boundaries, enabled: true, id, operationClass });

const registry: Readonly<Record<AgentCapabilityId, Capability>> = Object.freeze({
  "account.funnel_fit.simulate": capability(
    "account.funnel_fit.simulate",
    "simulate",
    ["in_app", "hosted_mcp"],
  ),
  "account.strategy.read": capability("account.strategy.read", "read", [
    "in_app",
    "hosted_mcp",
  ]),
  "developer.event.validate": capability("developer.event.validate", "validate", [
    "local_cli",
    "local_mcp",
    "hosted_mcp",
  ]),
  "developer.feature_manifest.validate": capability(
    "developer.feature_manifest.validate",
    "validate",
    ["local_cli", "local_mcp", "hosted_mcp"],
  ),
  "developer.handoff.generate": capability("developer.handoff.generate", "prepare", [
    "local_cli",
    "local_mcp",
    "hosted_mcp",
  ]),
  "developer.workspace.read": capability("developer.workspace.read", "read", [
    "local_cli",
    "local_mcp",
    "api_key",
    "hosted_mcp",
  ]),
  "funnel.entry.apply": capability("funnel.entry.apply", "reversible_write", [
    "in_app",
    "local_cli",
    "local_mcp",
    "api_key",
  ]),
  "funnel.entry.evidence.submit": capability(
    "funnel.entry.evidence.submit",
    "reversible_write",
    ["in_app", "local_cli", "local_mcp", "api_key"],
  ),
  "funnel.entry.inspect": capability("funnel.entry.inspect", "read", [
    "in_app",
    "local_cli",
    "local_mcp",
    "api_key",
    "hosted_mcp",
  ]),
  "funnel.entry.plan": capability("funnel.entry.plan", "plan", [
    "in_app",
    "local_cli",
    "local_mcp",
    "api_key",
    "hosted_mcp",
  ]),
  "funnel.entry.test": capability("funnel.entry.test", "reversible_write", [
    "local_cli",
    "local_mcp",
    "api_key",
  ]),
  "setup.test_event.send": capability("setup.test_event.send", "external_write", [
    "local_cli",
    "local_mcp",
    "api_key",
  ]),
});

const hostedOperationClasses = new Set<AgentOperationClass>([
  "plan",
  "prepare",
  "read",
  "simulate",
  "validate",
]);
const mutationOperationClasses = new Set<AgentOperationClass>([
  "external_write",
  "reversible_write",
]);

export function getAgentCapability(id: AgentCapabilityId) {
  return registry[id];
}

export function agentCapabilityAllowedAtBoundary(
  id: AgentCapabilityId,
  boundary: AgentExecutionBoundary,
  { mutationsEnabled = false }: { mutationsEnabled?: boolean } = {},
) {
  const selected = registry[id];
  if (!selected.enabled || !selected.boundaries.includes(boundary)) return false;
  if (boundary === "hosted_mcp" && !hostedOperationClasses.has(selected.operationClass)) {
    return false;
  }
  if (
    ["api_key", "local_cli", "local_mcp"].includes(boundary) &&
    mutationOperationClasses.has(selected.operationClass)
  ) {
    return mutationsEnabled;
  }
  return true;
}
