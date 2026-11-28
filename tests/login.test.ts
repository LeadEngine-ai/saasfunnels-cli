import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSaaSFunnelsCli } from "../src/cli.js";
import { credentialsPath } from "../src/login.js";

const base = "https://app.example.test";
const key = "pv_live_AbCdEfGh_" + "s".repeat(43);

type Reply = { status?: number; body: Record<string, unknown> };

function server(tokenReplies: Reply[]) {
  const calls: Array<{ path: string; body: unknown; auth?: string | null }> = [];
  const fetch = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ auth: new Headers(init?.headers).get("authorization"), body, path: url.pathname });
    const reply: Reply =
      url.pathname === "/api/cli/auth/device"
        ? { body: { device_code: "d".repeat(43), expires_in: 600, interval: 5, user_code: "BCDF-GHJK", verification_uri: `${base}/cli/connect`, verification_uri_complete: `${base}/cli/connect?code=BCDF-GHJK` } }
        : url.pathname === "/api/cli/auth/token"
          ? tokenReplies.shift() ?? { status: 400, body: { error: "authorization_pending" } }
          : url.pathname === "/api/cli/auth/revoke"
            ? { body: { revoked: true } }
            : url.pathname === "/api/developer-tools/workspace"
              ? { body: { workspace: { name: "Acme" } } }
              : { status: 404, body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

describe("saasfunnels login", () => {
  let cwd: string;
  let configDir: string;
  let env: Record<string, string>;
  let clock: number;
  const sleep = async (ms: number) => { clock += ms; };
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "sf-login-"));
    configDir = await mkdtemp(join(tmpdir(), "sf-config-"));
    env = { SAASFUNNELS_API_BASE_URL: base, SAASFUNNELS_CONFIG_DIR: configDir };
    clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(cwd, { force: true, recursive: true });
    await rm(configDir, { force: true, recursive: true });
  });

  it("prints the link and code, opens the browser, and stores the key privately", async () => {
    const api = server([{ status: 400, body: { error: "authorization_pending" } }, { body: { api_key: key, scopes: ["developer:read"], workspace: { name: "Acme" } } }]);
    const openBrowser = vi.fn(async () => undefined);
    const result = await runSaaSFunnelsCli(["login"], { cwd, env, fetch: api.fetch, openBrowser, prompt: async () => "", sleep });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${base}/cli/connect?code=BCDF-GHJK`);
    expect(result.stdout).toContain("BCDF-GHJK");
    expect(result.stdout).toContain("Signed in to Acme.");
    expect(result.stdout + result.stderr).not.toContain(key);
    expect(openBrowser).toHaveBeenCalledWith(`${base}/cli/connect?code=BCDF-GHJK`);
    const file = credentialsPath(env);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).credentials[base].api_key).toBe(key);
  });

  it("never prompts or opens a browser for agents, and resumes the same code on the next run", async () => {
    const api = server([]);
    const openBrowser = vi.fn();
    const first = await runSaaSFunnelsCli(["login"], { cwd, env, fetch: api.fetch, openBrowser, sleep });
    expect(first.exitCode).toBe(2);
    expect(first.stdout).toContain("BCDF-GHJK");
    expect(first.stderr).toContain("then run the same command again");
    expect(openBrowser).not.toHaveBeenCalled();
    expect((await stat(join(cwd, ".saasfunnels", "login-pending.json"))).mode & 0o777).toBe(0o600);

    const resumed = server([{ body: { api_key: key, workspace: { name: "Acme" } } }]);
    const second = await runSaaSFunnelsCli(["login"], { cwd, env, fetch: resumed.fetch, sleep });
    expect(second.exitCode).toBe(0);
    expect(resumed.calls.some((call) => call.path === "/api/cli/auth/device")).toBe(false);
    expect(resumed.calls.find((call) => call.path === "/api/cli/auth/token")?.body).toEqual({ device_code: "d".repeat(43) });
    await expect(stat(join(cwd, ".saasfunnels", "login-pending.json"))).rejects.toThrow();
  });

  it("prints one JSON object per line with a schema version", async () => {
    const api = server([{ status: 400, body: { error: "slow_down", interval: 10 } }, { body: { api_key: key, workspace: { name: "Acme" } } }]);
    const result = await runSaaSFunnelsCli(["login", "--json"], { cwd, env, fetch: api.fetch, sleep });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.event)).toEqual(["login_required", "login_complete"]);
    expect(lines.every((line) => typeof line.schema_version === "string")).toBe(true);
    expect(result.stdout).not.toContain(key);
  });

  it("reports a denied sign-in with a next action", async () => {
    const api = server([{ status: 400, body: { error: "access_denied" } }]);
    const result = await runSaaSFunnelsCli(["login", "--json"], { cwd, env, fetch: api.fetch, sleep });
    expect(result.exitCode).toBe(1);
    const last = JSON.parse(result.stdout.trim().split("\n").pop()!);
    expect(last).toMatchObject({ code: "login_denied", event: "error", next_action: expect.any(String) });
  });

  it("logout revokes the key and deletes it; whoami shows the workspace", async () => {
    const api = server([{ body: { api_key: key, workspace: { name: "Acme" } } }]);
    await runSaaSFunnelsCli(["login"], { cwd, env, fetch: api.fetch, prompt: async () => "", openBrowser: async () => undefined, sleep });
    const who = await runSaaSFunnelsCli(["whoami"], { cwd, env, fetch: api.fetch });
    expect(who.stdout).toContain("Workspace: Acme");
    expect(who.stdout).not.toContain(key);
    const out = await runSaaSFunnelsCli(["logout"], { cwd, env, fetch: api.fetch });
    expect(out.stdout).toContain("The key was revoked");
    expect(api.calls.find((call) => call.path === "/api/cli/auth/revoke")?.auth).toBe(`Bearer ${key}`);
    expect(JSON.parse(await readFile(credentialsPath(env), "utf8")).credentials[base]).toBeUndefined();
    expect((await runSaaSFunnelsCli(["whoami"], { cwd, env, fetch: api.fetch })).exitCode).toBe(1);
  });

  it("refuses --save-env for a file git doesn't ignore and leaves it unchanged", async () => {
    await writeFile(join(cwd, ".env.local"), "OTHER=1\n");
    const api = server([{ body: { api_key: key, workspace: { name: "Acme" } } }]);
    const result = await runSaaSFunnelsCli(["login", "--save-env", ".env.local"], { cwd, env, fetch: api.fetch, sleep });
    expect(result.stdout).toContain("isn't ignored by git");
    expect(await readFile(join(cwd, ".env.local"), "utf8")).toBe("OTHER=1\n");
  });

  it("prints its version", async () => {
    const result = await runSaaSFunnelsCli(["--version"], { env });
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});
