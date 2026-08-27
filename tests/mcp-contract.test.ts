import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  handleSaaSFunnelsMcpMessage,
  SAASFUNNELS_MCP_PROTOCOL_VERSION,
  saasFunnelsMcpResources,
  saasFunnelsMcpToolDefinitions,
  serveSaaSFunnelsMcp,
} from "../src/mcp.js";

const rawDeveloperKey = "pv_live_ab12cd34_developer_secret_should_not_print";
const rawIngestKey = "pv_live_ab12cd34_ingest_secret_should_not_print";

function textOutput(result: any) {
  return JSON.stringify(result);
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status,
  });
}

async function toolCall(
  name: string,
  args: Record<string, unknown>,
  options: Record<string, unknown> = {},
) {
  return handleSaaSFunnelsMcpMessage(
    {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: args,
        name,
      },
    },
    options,
  );
}

describe("SaaSFunnels MCP server", () => {
  it("negotiates initialize and lists read-only tools/resources by default", async () => {
    const initialized = await handleSaaSFunnelsMcpMessage({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "vitest", version: "1.0.0" },
        protocolVersion: SAASFUNNELS_MCP_PROTOCOL_VERSION,
      },
    });
    const tools = await handleSaaSFunnelsMcpMessage({
      id: 2,
      jsonrpc: "2.0",
      method: "tools/list",
    });
    const resources = await handleSaaSFunnelsMcpMessage({
      id: 3,
      jsonrpc: "2.0",
      method: "resources/list",
    });

    expect(initialized?.result).toMatchObject({
      protocolVersion: SAASFUNNELS_MCP_PROTOCOL_VERSION,
      serverInfo: { name: "saasfunnels" },
    });
    expect(JSON.stringify(initialized)).toContain("SAASFUNNELS_API_KEY");
    expect(JSON.stringify(initialized)).not.toContain("PREVENUE_API_KEY");
    expect(
      (tools?.result as any).tools.map((tool: { name: string }) => tool.name),
    ).toEqual([
      "validate_event_payload",
      "validate_feature_catalog_manifest",
      "generate_direct_api_handoff",
      "get_integration_health",
      "get_workspace_readiness",
      "list_mapping_gaps",
      "list_recent_signals",
      "get_signal_payload_preview",
      "inspect_funnel_entry",
      "propose_funnel_entry_installation",
    ]);
    expect(
      saasFunnelsMcpToolDefinitions({ allowTestWrites: true }).map(
        (tool) => tool.name,
      ),
    ).toContain("send_test_event");
    expect(
      saasFunnelsMcpToolDefinitions({ allowFunnelTests: true }).map(
        (tool) => tool.name,
      ),
    ).toContain("run_funnel_binding_test");
    expect(
      saasFunnelsMcpToolDefinitions({ allowFunnelWrites: true }).map(
        (tool) => tool.name,
      ),
    ).toContain("apply_funnel_entry");
    expect(
      saasFunnelsMcpToolDefinitions({ allowFunnelWrites: true }).map(
        (tool) => tool.name,
      ),
    ).toContain("submit_funnel_entry_evidence");
    expect(
      (resources?.result as any).resources.map(
        (resource: { uri: string }) => resource.uri,
      ),
    ).toContain("saasfunnels://semantics/events");
    expect(saasFunnelsMcpResources().map((resource) => resource.uri)).toContain(
      "saasfunnels://agent-handoff/direct-api/codex",
    );
    expect(saasFunnelsMcpResources().map((resource) => resource.uri)).toContain(
      "saasfunnels://features/catalog-schema",
    );
    expect(saasFunnelsMcpResources().map((resource) => resource.uri)).toContain(
      "saasfunnels://funnels/entry-installation",
    );
    const publicRegistry = JSON.stringify({
      resources: saasFunnelsMcpResources(),
      tools: saasFunnelsMcpToolDefinitions({
        allowFunnelTests: true,
        allowFunnelWrites: true,
        allowTestWrites: true,
      }),
    });
    expect(publicRegistry).not.toContain("prevenue://");
    expect(publicRegistry).not.toContain(".prevenue/");
    expect(publicRegistry).not.toContain("PREVENUE_API_KEY");
    expect(publicRegistry).not.toContain("PREVENUE_INGEST_API_KEY");
  });

  it("reads static resources and generated handoff artifacts", async () => {
    const safety = await handleSaaSFunnelsMcpMessage({
      id: 1,
      jsonrpc: "2.0",
      method: "resources/read",
      params: { uri: "saasfunnels://safety/data-exposure" },
    });
    const handoff = await handleSaaSFunnelsMcpMessage({
      id: 2,
      jsonrpc: "2.0",
      method: "resources/read",
      params: { uri: "saasfunnels://agent-handoff/direct-api/markdown" },
    });

    expect((safety?.result as any).contents[0].text).toContain(
      "Never expose full API keys",
    );
    expect((handoff?.result as any).contents[0].text).toContain(
      "<SAASFUNNELS_INGEST_KEY>",
    );
    expect((handoff?.result as any).contents[0].text).not.toContain(
      "<PREVENUE_INGEST_KEY>",
    );
    expect((handoff?.result as any).contents[0].text).not.toContain(
      rawIngestKey,
    );
  });

  it("validates event payloads with structured redacted output", async () => {
    const result = await toolCall("validate_event_payload", {
      payload: {
        account_id: "acct_123",
        event_name: "support_friction_seen",
        properties: {
          api_token: "sk_test_123456789012345678901234",
          email: "buyer@example.com",
        },
        timestamp: "2026-06-20T15:00:00.000Z",
      },
      source: "direct",
    });
    const structured = (result?.result as any).structuredContent;
    const issueCodes = structured.errors.map(
      (issue: { code: string }) => issue.code,
    );

    expect(result?.error).toBeUndefined();
    expect(issueCodes).toContain("unsafe_field");
    expect(textOutput(result)).not.toContain(
      "sk_test_123456789012345678901234",
    );
    expect(textOutput(result)).not.toContain("buyer@example.com");
  });

  it("validates provided Feature manifests without filesystem or write access", async () => {
    const result = await toolCall("validate_feature_catalog_manifest", {
      manifest: {
        environment: "test",
        features: [
          {
            accessModel: "boolean",
            aliases: [],
            description: "",
            evidence: [],
            key: "projects",
            name: "Projects",
            unit: null,
          },
        ],
        generatedBy: "saasfunnels features setup",
        schemaVersion: 1,
      },
    });

    expect((result?.result as any).structuredContent).toMatchObject({
      ok: true,
    });
    expect((result?.result as any).isError).toBe(false);
  });

  it("uses developer:read platform APIs for live read tools", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(url));
        expect((init?.headers as Record<string, string>).authorization).toBe(
          `Bearer ${rawDeveloperKey}`,
        );

        if (String(url).endsWith("/signals/sig_123/payload-preview")) {
          return response({
            data: {
              payload_preview: {
                evidence: ["safe bounded event"],
                pii_policy: { raw_payload_exposed: false },
              },
            },
            ok: true,
          });
        }

        return response({
          data: {
            items: [{ provider: "direct", status: "ready" }],
          },
          ok: true,
        });
      },
    ) as unknown as typeof fetch;

    const options = {
      env: {
        PREVENUE_API_BASE_URL: "https://app.prevenue.test",
        PREVENUE_API_KEY: rawDeveloperKey,
      },
      fetch: fetchImpl,
    };

    const integrations = await toolCall("get_integration_health", {}, options);
    const readiness = await toolCall("get_workspace_readiness", {}, options);
    const gaps = await toolCall("list_mapping_gaps", {}, options);
    const signals = await toolCall("list_recent_signals", {}, options);
    const preview = await toolCall(
      "get_signal_payload_preview",
      { signal_id: "sig_123" },
      options,
    );

    expect(calls).toEqual([
      "https://app.prevenue.test/api/developer-tools/integrations/health",
      "https://app.prevenue.test/api/developer-tools/signals/readiness",
      "https://app.prevenue.test/api/developer-tools/mappings/gaps",
      "https://app.prevenue.test/api/developer-tools/signals/recent",
      "https://app.prevenue.test/api/developer-tools/signals/sig_123/payload-preview",
    ]);
    for (const result of [integrations, readiness, gaps, signals, preview]) {
      expect(result?.error).toBeUndefined();
      expect((result?.result as any).isError).toBe(false);
      expect(textOutput(result)).not.toContain(rawDeveloperKey);
    }
  });

  it("inspects, plans, and explicitly gates versioned Funnel draft writes", async () => {
    const funnelId = "11111111-1111-4111-8111-111111111111";
    const calls: Array<{ body?: unknown; method?: string; url: string }> = [];
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          method: init?.method,
          url: String(url),
        });
        expect((init?.headers as Record<string, string>).authorization).toBe(
          `Bearer ${rawDeveloperKey}`,
        );
        if (String(url).endsWith("/entry/plan")) {
          return response({
            data: {
              draftRevision: 7,
              entryKey: "upgrade_offer.pricing_cta_requested",
              recommendedBinding: "react_event",
            },
            ok: true,
          });
        }
        if (String(url).endsWith("/entry/evidence")) {
          return response({
            data: { manifestId: "manifest-1", readiness: "installation_ready" },
            ok: true,
          });
        }
        if (init?.method === "POST") {
          return response({
            data: {
              draftRevision: 8,
              entry: {
                eventKey: "upgrade_offer.pricing_cta_requested",
                kind: "event",
                source: "host_interaction",
              },
            },
            ok: true,
          });
        }
        return response({
          data: {
            draftRevision: 7,
            entry: { eventKey: "pricing_viewed", kind: "event" },
            placementKey: "billing_upgrade",
          },
          ok: true,
        });
      },
    ) as unknown as typeof fetch;
    const baseOptions = {
      env: {
        PREVENUE_API_BASE_URL: "https://app.prevenue.test",
        PREVENUE_API_KEY: rawDeveloperKey,
      },
      fetch: fetchImpl,
    };

    const inspected = await toolCall(
      "inspect_funnel_entry",
      { funnel_id: funnelId },
      baseOptions,
    );
    const planned = await toolCall(
      "propose_funnel_entry_installation",
      {
        entry_kind: "event",
        funnel_id: funnelId,
        intent: "Pricing CTA",
        preferred_binding: "react_event",
      },
      baseOptions,
    );
    const disabled = await toolCall(
      "apply_funnel_entry",
      {
        entry: {
          eventKey: "upgrade_offer.pricing_cta_requested",
          kind: "event",
          source: "host_interaction",
        },
        expected_draft_revision: 7,
        funnel_id: funnelId,
        idempotency_key: "mcp:test:entry:1234",
        placement_key: "billing_upgrade",
      },
      baseOptions,
    );
    const applied = await toolCall(
      "apply_funnel_entry",
      {
        entry: {
          eventKey: "upgrade_offer.pricing_cta_requested",
          kind: "event",
          source: "host_interaction",
        },
        expected_draft_revision: 7,
        funnel_id: funnelId,
        idempotency_key: "mcp:test:entry:1234",
        placement_key: "billing_upgrade",
      },
      { ...baseOptions, allowFunnelWrites: true },
    );
    const manifest = {
      binding: {
        bindingFingerprint: "b".repeat(64),
        bindingKind: "react_event",
        line: 42,
        repositoryPath: "components/UpgradeButton.tsx",
        sdkPackage: "@saasfunnels/funnels-react",
        sdkVersion: "1.2.3",
        symbol: "UpgradeButton",
      },
      draftRevision: 8,
      entryKind: "event",
      entryKey: "upgrade_offer.pricing_cta_requested",
      environment: "test",
      funnelId,
      manifestFingerprint: "a".repeat(64),
      repositoryRevision: "abc123",
      schemaVersion: 1,
      validatedAt: "2026-08-16T12:00:00.000Z",
      validationState: "valid",
      warnings: [],
    };
    const evidence = await toolCall(
      "submit_funnel_entry_evidence",
      { funnel_id: funnelId, manifest },
      { ...baseOptions, allowFunnelWrites: true },
    );

    expect((inspected?.result as any).isError).toBe(false);
    expect((planned?.result as any).structuredContent.data).toMatchObject({
      recommendedBinding: "react_event",
    });
    expect((disabled?.result as any).isError).toBe(true);
    expect((applied?.result as any).structuredContent.data).toMatchObject({
      draftRevision: 8,
    });
    expect((evidence?.result as any).structuredContent.data).toMatchObject({
      readiness: "installation_ready",
    });
    expect(calls).toEqual([
      {
        method: "GET",
        url: `https://app.prevenue.test/api/developer-tools/funnels/${funnelId}/entry`,
      },
      {
        body: {
          entryKind: "event",
          intent: "Pricing CTA",
          preferredBinding: "react_event",
        },
        method: "POST",
        url: `https://app.prevenue.test/api/developer-tools/funnels/${funnelId}/entry/plan`,
      },
      {
        body: {
          entry: {
            eventKey: "upgrade_offer.pricing_cta_requested",
            kind: "event",
            source: "host_interaction",
          },
          expectedDraftRevision: 7,
          idempotencyKey: "mcp:test:entry:1234",
          placementKey: "billing_upgrade",
        },
        method: "POST",
        url: `https://app.prevenue.test/api/developer-tools/funnels/${funnelId}/entry`,
      },
      {
        body: manifest,
        method: "POST",
        url: `https://app.prevenue.test/api/developer-tools/funnels/${funnelId}/entry/evidence`,
      },
    ]);
    expect(textOutput(applied)).not.toContain(rawDeveloperKey);
  });

  it("gates the Funnel runtime Test separately and returns only its short-lived challenge", async () => {
    const funnelId = "11111111-1111-4111-8111-111111111111";
    const runtimeChallenge = `fet1.${"a".repeat(40)}.${"b".repeat(43)}`;
    const disabled = await toolCall("run_funnel_binding_test", {
      expected_draft_revision: 7,
      funnel_id: funnelId,
      idempotency_key: "binding-test-123",
    });
    expect((disabled?.result as any).isError).toBe(true);

    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe(
          `https://app.prevenue.test/api/developer-tools/funnels/${funnelId}/entry/test`,
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedDraftRevision: 7,
          idempotencyKey: "binding-test-123",
        });
        return response({
          data: {
            draftRevision: 7,
            entryKey: "upgrade_offer.requested",
            entryKind: "event",
            expiresInSeconds: 600,
            funnelId,
            placementKey: "upgrade_modal",
            testToken: runtimeChallenge,
          },
          ok: true,
        });
      },
    ) as unknown as typeof fetch;
    const enabled = await toolCall(
      "run_funnel_binding_test",
      {
        expected_draft_revision: 7,
        funnel_id: funnelId,
        idempotency_key: "binding-test-123",
      },
      {
        allowFunnelTests: true,
        env: {
          PREVENUE_API_BASE_URL: "https://app.prevenue.test",
          PREVENUE_API_KEY: rawDeveloperKey,
        },
        fetch: fetchImpl,
      },
    );
    expect((enabled?.result as any).isError).toBe(false);
    expect((enabled?.result as any).structuredContent.data.testToken).toBe(
      runtimeChallenge,
    );
    expect(textOutput(enabled)).not.toContain(rawDeveloperKey);
  });

  it("keeps send_test_event disabled by default and gates it behind explicit setup-smoke enablement", async () => {
    const disabled = await toolCall("send_test_event", {});
    expect((disabled?.result as any).isError).toBe(true);
    expect(textOutput(disabled)).toContain("disabled by default");
    expect(textOutput(disabled)).toContain(
      "SAASFUNNELS_MCP_ENABLE_SEND_TEST_EVENT",
    );
    expect(textOutput(disabled)).not.toContain(
      "PREVENUE_MCP_ENABLE_SEND_TEST_EVENT",
    );

    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe("https://app.prevenue.test/api/events/ingest");
        expect((init?.headers as Record<string, string>).authorization).toBe(
          `Bearer ${rawIngestKey}`,
        );
        expect(JSON.parse(String(init?.body))).toMatchObject({
          event_name: "usage_limit_hit",
        });

        return response({
          data: {
            duplicate: false,
            persisted: true,
            workflow_enqueued: true,
          },
          ok: true,
        });
      },
    ) as unknown as typeof fetch;

    const enabled = await toolCall(
      "send_test_event",
      {},
      {
        allowTestWrites: true,
        env: {
          PREVENUE_API_BASE_URL: "https://app.prevenue.test",
          PREVENUE_INGEST_API_KEY: rawIngestKey,
        },
        fetch: fetchImpl,
      },
    );

    expect((enabled?.result as any).isError).toBe(false);
    expect((enabled?.result as any).structuredContent).toMatchObject({
      data: { persisted: true },
      ok: true,
      test_only: true,
      write_policy: "setup_smoke_event_only",
    });
    expect(textOutput(enabled)).not.toContain(rawIngestKey);
  });

  it("returns canonical SaaSFunnels environment guidance from public tool errors", async () => {
    const missingDeveloperKey = await toolCall("get_workspace_readiness", {});
    const missingIngestKey = await toolCall(
      "send_test_event",
      {},
      { allowTestWrites: true },
    );

    expect(
      (missingDeveloperKey?.result as any).structuredContent,
    ).toMatchObject({
      required_env: "SAASFUNNELS_API_KEY",
    });
    expect((missingIngestKey?.result as any).structuredContent).toMatchObject({
      required_env: "SAASFUNNELS_INGEST_API_KEY",
    });
    expect(textOutput({ missingDeveloperKey, missingIngestKey })).not.toContain(
      "PREVENUE_",
    );
  });

  it("serves newline-delimited stdio JSON-RPC messages", async () => {
    const input = Readable.from([
      `${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: SAASFUNNELS_MCP_PROTOCOL_VERSION } })}\n`,
      `${JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list" })}\n`,
    ]);
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });

    await serveSaaSFunnelsMcp({ input, output });

    const messages = chunks
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(messages).toHaveLength(2);
    expect(messages[0].result.protocolVersion).toBe(
      SAASFUNNELS_MCP_PROTOCOL_VERSION,
    );
    expect(messages[1].result.tools[0].name).toBe("validate_event_payload");
  });
});
