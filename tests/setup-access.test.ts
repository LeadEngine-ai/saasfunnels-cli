import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveSetupAccess } from "../src/setup-access.js";
import { runSaaSFunnelsCli } from "../src/cli.js";

describe("guided developer access", () => {
  it("uses process access without prompting or invoking Doppler", async () => {
    const prompt = vi.fn(); const loadDoppler = vi.fn();
    expect(await resolveSetupAccess({ cwd: "/tmp", key: "fixture", prompt, loadDoppler })).toEqual({ key: "fixture" });
    expect(prompt).not.toHaveBeenCalled(); expect(loadDoppler).not.toHaveBeenCalled();
  });
  it("asks before reading Doppler and never forwards provider errors", async () => {
    const loadDoppler = vi.fn().mockRejectedValue(new Error("sensitive-value"));
    const result = await resolveSetupAccess({ cwd: "/tmp", prompt: async () => "1", loadDoppler });
    expect(loadDoppler).toHaveBeenCalledOnce(); expect(result.error).toContain("Doppler");
    expect(JSON.stringify(result)).not.toContain("sensitive-value");
  });
  it("loads only the developer key from an explicitly selected env file without executing it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "setup-env-"));
    try {
      const contents = 'SAASFUNNELS_API_KEY="fixture"\nSTRIPE_SECRET_KEY=private\nSAASFUNNELS_API_BASE_URL=https://untrusted.example\nSHELL=$(touch should-not-exist)\n';
      await writeFile(join(cwd, ".env.local"), contents);
      expect(await resolveSetupAccess({ cwd, prompt: async () => "2" })).toEqual({ key: "fixture" });
      expect(await resolveSetupAccess({ cwd, envFile: ".env.local" })).toEqual({ key: "fixture" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it("does not guess a credential source in automation", async () => {
    const loadDoppler = vi.fn();
    const result = await resolveSetupAccess({ cwd: "/tmp", loadDoppler });
    expect(result.error).toContain("Environment values"); expect(loadDoppler).not.toHaveBeenCalled();
  });
  it("gives setup-only help without accessing credentials or the network", async () => {
    const fetch = vi.fn(); const prompt = vi.fn();
    const result = await runSaaSFunnelsCli(["setup", "--help"], { env: {}, fetch, prompt });
    expect(result.exitCode).toBe(0); expect(result.stdout).toContain("saasfunnels@latest setup");
    expect(result.stdout).not.toContain("mcp serve"); expect(fetch).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled();
  });
  it("recognizes both entry points and honors non-interactive mode", async () => {
    for (const args of [["setup"], ["setup", "run"]]) {
      const prompt = vi.fn(); const fetch = vi.fn();
      const result = await runSaaSFunnelsCli([...args, "--non-interactive"], { env: {}, prompt, fetch });
      expect(result.exitCode).toBe(2); expect(result.stderr).toContain("Environment values");
      expect(result.stderr).not.toContain("Unknown command"); expect(prompt).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    }
  });
});
