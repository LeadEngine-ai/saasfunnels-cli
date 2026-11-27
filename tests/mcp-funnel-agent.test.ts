import { describe, expect, it, vi } from "vitest";

import { callSaaSFunnelsMcpTool } from "../src/mcp.js";

const funnelId = "4f9b2c1e-7a3d-4e8f-9b0a-1c2d3e4f5a6b";
const requestKey = "1b4e28ba-2fa1-4d2e-8b3c-9c0e1d2f3a4b";

function recorder() {
  const calls: Array<{ body?: unknown; method: string; url: string }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method: init?.method ?? "GET",
      url: String(url),
    });
    return new Response(JSON.stringify({ data: { ok: true }, ok: true }), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("Funnel agent tools (LEA-2258, LEA-2259)", () => {
  it("reads templates, checklist, outline and problems through the developer API", async () => {
    const { calls, fetchImpl } = recorder();
    const options = {
      apiBaseUrlOverride: "https://app.saasfunnels.test",
      env: { SAASFUNNELS_API_KEY: "sf_test_key_value" },
      fetch: fetchImpl,
    };
    await callSaaSFunnelsMcpTool("list_funnel_templates", {}, options);
    await callSaaSFunnelsMcpTool("get_launch_checklist", { funnel_id: funnelId }, options);
    await callSaaSFunnelsMcpTool("get_funnel_outline", { funnel_id: funnelId }, options);
    await callSaaSFunnelsMcpTool("validate_funnel_draft", { funnel_id: funnelId }, options);
    await callSaaSFunnelsMcpTool("get_funnel_command_schema", { type: "set_step" }, options);
    await callSaaSFunnelsMcpTool("get_install_status", {}, options);
    await callSaaSFunnelsMcpTool("get_offer_catalog", {}, options);
    expect(calls.map((call) => call.url)).toEqual([
      "https://app.saasfunnels.test/api/developer-tools/funnels/templates",
      `https://app.saasfunnels.test/api/developer-tools/funnels/${funnelId}/checklist`,
      `https://app.saasfunnels.test/api/developer-tools/funnels/${funnelId}/outline`,
      `https://app.saasfunnels.test/api/developer-tools/funnels/${funnelId}/validation`,
      "https://app.saasfunnels.test/api/developer-tools/funnels/command-schema?type=set_step",
      "https://app.saasfunnels.test/api/developer-tools/setup/install-status",
      "https://app.saasfunnels.test/api/developer-tools/offers",
    ]);
  });

  it("keeps create and edit off until writes are enabled, then posts them", async () => {
    const { calls, fetchImpl } = recorder();
    const base = {
      apiBaseUrlOverride: "https://app.saasfunnels.test",
      env: { SAASFUNNELS_API_KEY: "sf_test_key_value" },
      fetch: fetchImpl,
    };
    const refused = await callSaaSFunnelsMcpTool(
      "create_funnel_draft",
      { request_key: requestKey, template_key: "cancellation_save" },
      base,
    );
    expect(refused.isError).toBe(true);
    expect(calls).toEqual([]);

    const options = { ...base, allowFunnelWrites: true };
    await callSaaSFunnelsMcpTool(
      "create_funnel_draft",
      { request_key: requestKey, template_key: "cancellation_save" },
      options,
    );
    await callSaaSFunnelsMcpTool(
      "apply_funnel_changes",
      {
        agent_name: "Claude Code",
        changes: [{ name: "Save offer", type: "update_identity" }],
        expected_draft_revision: 3,
        funnel_id: funnelId,
      },
      options,
    );
    expect(calls).toEqual([
      {
        body: { request_key: requestKey, template_key: "cancellation_save" },
        method: "POST",
        url: "https://app.saasfunnels.test/api/developer-tools/funnels",
      },
      {
        body: {
          agent_name: "Claude Code",
          changes: [{ name: "Save offer", type: "update_identity" }],
          expected_draft_revision: 3,
        },
        method: "POST",
        url: `https://app.saasfunnels.test/api/developer-tools/funnels/${funnelId}/changes`,
      },
    ]);

    await expect(
      callSaaSFunnelsMcpTool(
        "apply_funnel_changes",
        { changes: [], expected_draft_revision: 3, funnel_id: funnelId },
        options,
      ),
    ).rejects.toThrow("1–16 change objects");
    expect(calls).toHaveLength(2);
  });
});
