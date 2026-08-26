import { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  handleSaaSFunnelsMcpMessage,
  readSaaSFunnelsMcpResource,
  SAASFUNNELS_MCP_PROTOCOL_VERSION,
  saasFunnelsMcpResources,
  serveSaaSFunnelsMcp,
} from "../src/mcp.ts";

describe("SaaSFunnels stdio MCP server", () => {
  it("lists canonical resources while accepting the internal legacy URI alias", () => {
    const resources = saasFunnelsMcpResources();
    expect(resources.map((resource) => resource.uri)).toContain(
      "saasfunnels://semantics/events",
    );
    expect(JSON.stringify(resources)).not.toContain("prevenue://");
    expect(readSaaSFunnelsMcpResource("prevenue://semantics/events")).toContain(
      "SaaSFunnels Event Semantics",
    );
  });

  it("validates an event payload through a focused MCP tool call", async () => {
    const response = await handleSaaSFunnelsMcpMessage({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          payload: {
            account_id: "acct_123",
            event_name: "usage_limit_hit",
            timestamp: "2026-06-20T15:00:00.000Z",
          },
          source: "direct",
        },
        name: "validate_event_payload",
      },
    });

    expect(response?.error).toBeUndefined();
    expect((response?.result as any).structuredContent).toMatchObject({ ok: true });
  });

  it("serves newline-delimited initialize and tools/list messages over stdio", async () => {
    const input = Readable.from([
      `${JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: SAASFUNNELS_MCP_PROTOCOL_VERSION },
      })}\n`,
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
    expect(messages[0].result).toMatchObject({
      protocolVersion: SAASFUNNELS_MCP_PROTOCOL_VERSION,
      serverInfo: { name: "saasfunnels" },
    });
    expect(messages[1].result.tools[0].name).toBe("validate_event_payload");
    expect(chunks.join("")).not.toContain("PREVENUE_");
  });
});
