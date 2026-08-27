export const SAASFUNNELS_CLI_NAME = "saasfunnels";
export const SAASFUNNELS_CLI_VERSION = "0.1.0-beta.1";
export const SAASFUNNELS_PRODUCT_NAME = "SaaSFunnels";

// Explicit base URLs keep the same command implementation testable against
// localhost, previews, and the controlled legacy host during cutover.
export const SAASFUNNELS_DEFAULT_API_BASE_URL = "https://app.saasfunnels.ai";

export const SAASFUNNELS_ENV = Object.freeze({
  apiBaseUrl: ["SAASFUNNELS_API_BASE_URL", "PREVENUE_API_BASE_URL"],
  apiKey: ["SAASFUNNELS_API_KEY", "PREVENUE_API_KEY"],
  funnelsServerKey: [
    "SAASFUNNELS_FUNNELS_SERVER_KEY",
    "PREVENUE_FUNNELS_SERVER_KEY",
  ],
  ingestApiKey: ["SAASFUNNELS_INGEST_API_KEY", "PREVENUE_INGEST_API_KEY"],
  mcpEnableFunnelWrites: [
    "SAASFUNNELS_MCP_ENABLE_FUNNEL_WRITES",
    "PREVENUE_MCP_ENABLE_FUNNEL_WRITES",
  ],
  mcpEnableFunnelTests: [
    "SAASFUNNELS_MCP_ENABLE_FUNNEL_TESTS",
    "PREVENUE_MCP_ENABLE_FUNNEL_TESTS",
  ],
  mcpEnableSendTestEvent: [
    "SAASFUNNELS_MCP_ENABLE_SEND_TEST_EVENT",
    "PREVENUE_MCP_ENABLE_SEND_TEST_EVENT",
  ],
});

export function saasFunnelsPublicText(value: string) {
  return value
    .replaceAll(".prevenue/", ".saasfunnels/")
    .replaceAll("<PREVENUE_INGEST_KEY>", "<SAASFUNNELS_INGEST_KEY>")
    .replaceAll("PREVENUE_INGEST_API_KEY", "SAASFUNNELS_INGEST_API_KEY")
    .replaceAll("PREVENUE_FUNNELS_SERVER_KEY", "SAASFUNNELS_FUNNELS_SERVER_KEY")
    .replaceAll("PREVENUE_MCP_ENABLE_FUNNEL_WRITES", "SAASFUNNELS_MCP_ENABLE_FUNNEL_WRITES")
    .replaceAll("PREVENUE_MCP_ENABLE_FUNNEL_TESTS", "SAASFUNNELS_MCP_ENABLE_FUNNEL_TESTS")
    .replaceAll("PREVENUE_MCP_ENABLE_SEND_TEST_EVENT", "SAASFUNNELS_MCP_ENABLE_SEND_TEST_EVENT")
    .replaceAll("PREVENUE_API_BASE_URL", "SAASFUNNELS_API_BASE_URL")
    .replaceAll("PREVENUE_API_KEY", "SAASFUNNELS_API_KEY")
    .replaceAll("PREVENUE_DIRECT_API.md", "SAASFUNNELS_DIRECT_API.md")
    .replaceAll("prevenue-event-discovery", "saasfunnels-event-discovery")
    .replaceAll("prevenue://", "saasfunnels://")
    .replace(
      /\bprevenue (?=(?:init|agent|events|features|catalog|doctor|readiness|verify|mcp)\b)/g,
      "saasfunnels ",
    )
    .replaceAll("prevenueFeatureKeys", "saasFunnelsFeatureKeys")
    .replaceAll("PrevenueFeatureKey", "SaaSFunnelsFeatureKey")
    .replaceAll("SaaSFunnels", SAASFUNNELS_PRODUCT_NAME);
}
