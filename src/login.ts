import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseEnv, promisify } from "node:util";

import { SAASFUNNELS_CLI_VERSION } from "./identity.js";

const exec = promisify(execFile);

/* Browser device login (RFC 8628, LEA-2291). The key is stored in the user's
   config folder, never printed, and never written to an env file unless the
   person asks with --save-env and git ignores that file. */

export const LOGIN_SCHEMA_VERSION = "2026-11-29.1";
const AGENT_WAIT_MS = 90_000;
const PENDING_FILE = join(".saasfunnels", "login-pending.json");

type Env = Record<string, string | undefined>;

export type LoginOptions = {
  apiBaseUrl: string;
  cwd: string;
  env: Env;
  fetch?: typeof fetch;
  /** A person is at the keyboard (TTY): wait until the code expires. */
  interactive: boolean;
  json: boolean;
  noBrowser?: boolean;
  openBrowser?: (url: string) => Promise<void>;
  progress?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type LoginResult =
  | { ok: true; key: string; workspaceName: string }
  | { ok: false; pending: true; message: string }
  | { ok: false; pending?: false; code: string; message: string; nextAction: string };

type StoredCredential = { api_key: string; workspace_name?: string; key_name?: string; saved_at?: string };
type CredentialsFile = { version: 1; credentials: Record<string, StoredCredential> };
type PendingLogin = { api_base_url: string; device_code: string; user_code: string; verification_uri_complete: string; expires_at: number; interval: number };

export function configDir(env: Env) {
  if (env.SAASFUNNELS_CONFIG_DIR?.trim()) return resolve(env.SAASFUNNELS_CONFIG_DIR.trim());
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "saasfunnels");
  const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(base, "saasfunnels");
}

export function credentialsPath(env: Env) {
  return join(configDir(env), "credentials.json");
}

async function readCredentials(env: Env): Promise<CredentialsFile> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(env), "utf8"));
    if (parsed && parsed.version === 1 && parsed.credentials && typeof parsed.credentials === "object") return parsed;
  } catch { /* Missing or unreadable: treat as signed out. */ }
  return { version: 1, credentials: {} };
}

async function writePrivateJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export async function readStoredCredential(env: Env, apiBaseUrl: string) {
  const file = await readCredentials(env);
  const entry = file.credentials[apiBaseUrl];
  return entry?.api_key ? entry : null;
}

export async function storeCredential(env: Env, apiBaseUrl: string, credential: StoredCredential) {
  const file = await readCredentials(env);
  file.credentials[apiBaseUrl] = { ...credential, saved_at: new Date().toISOString() };
  await writePrivateJson(credentialsPath(env), file);
}

export async function deleteStoredCredential(env: Env, apiBaseUrl: string) {
  const file = await readCredentials(env);
  if (!file.credentials[apiBaseUrl]) return false;
  delete file.credentials[apiBaseUrl];
  await writePrivateJson(credentialsPath(env), file);
  return true;
}

function jsonLine(event: string, payload: Record<string, unknown> = {}) {
  return JSON.stringify({ schema_version: LOGIN_SCHEMA_VERSION, event, ...payload });
}

function canOpenBrowser(env: Env) {
  if (env.CI || env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

async function defaultOpenBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  await exec(command, args, { timeout: 10_000 }).catch(() => undefined);
}

function shortHostname() {
  return hostname().split(".")[0]?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || undefined;
}

async function readPending(cwd: string, apiBaseUrl: string, now: number): Promise<PendingLogin | null> {
  try {
    const pending = JSON.parse(await readFile(join(cwd, PENDING_FILE), "utf8")) as PendingLogin;
    if (pending.api_base_url === apiBaseUrl && typeof pending.device_code === "string" && pending.expires_at > now) return pending;
  } catch { /* No pending login. */ }
  return null;
}

async function clearPending(cwd: string) {
  await rm(join(cwd, PENDING_FILE), { force: true }).catch(() => undefined);
}

async function postJson(options: LoginOptions, path: string, body: unknown, key?: string) {
  const response = await (options.fetch ?? fetch)(new URL(path, options.apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-saasfunnels-cli-version": SAASFUNNELS_CLI_VERSION,
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { payload: payload && typeof payload === "object" ? payload as Record<string, unknown> : {}, status: response.status };
}

export async function deviceLogin(options: LoginOptions): Promise<LoginResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const say = (text: string, event: string, payload: Record<string, unknown> = {}) =>
    options.progress?.(options.json ? jsonLine(event, payload) : text);
  const unavailable = (message: string): LoginResult => ({
    code: "login_unavailable",
    message,
    nextAction: `Create a key in ${options.apiBaseUrl}/app/setup and load it as SAASFUNNELS_API_KEY.`,
    ok: false,
  });

  let pending = await readPending(options.cwd, options.apiBaseUrl, now());
  if (pending) {
    say(`Resuming sign-in. If you haven't yet, open ${pending.verification_uri_complete} and confirm code ${pending.user_code}.`, "login_pending", {
      user_code: pending.user_code,
      verification_uri_complete: pending.verification_uri_complete,
    });
  } else {
    let started: Awaited<ReturnType<typeof postJson>>;
    try {
      started = await postJson(options, "/api/cli/auth/device", { client_version: SAASFUNNELS_CLI_VERSION, hostname: shortHostname() });
    } catch {
      return unavailable("Couldn't reach SaaSFunnels to sign in. Check your connection and try again.");
    }
    const body = started.payload;
    if (started.status !== 200 || typeof body.device_code !== "string" || typeof body.user_code !== "string" || typeof body.verification_uri_complete !== "string")
      return unavailable(typeof body.error_description === "string" ? body.error_description : "Sign-in from the terminal isn't available right now.");
    pending = {
      api_base_url: options.apiBaseUrl,
      device_code: body.device_code,
      expires_at: now() + Number(body.expires_in ?? 600) * 1000,
      interval: Number(body.interval ?? 5),
      user_code: body.user_code,
      verification_uri_complete: body.verification_uri_complete,
    };
    say(`To sign in, open ${pending.verification_uri_complete}\nand confirm the code ${pending.user_code}.`, "login_required", {
      expires_in: Math.round((pending.expires_at - now()) / 1000),
      user_code: pending.user_code,
      verification_uri_complete: pending.verification_uri_complete,
    });
    if (options.interactive && !options.noBrowser && canOpenBrowser(options.env))
      await (options.openBrowser ?? defaultOpenBrowser)(pending.verification_uri_complete);
  }

  const deadline = options.interactive ? pending.expires_at : Math.min(pending.expires_at, now() + AGENT_WAIT_MS);
  let interval = Math.max(1, pending.interval);
  if (!options.json && options.interactive) options.progress?.("Waiting for approval in the browser…");
  while (now() < deadline) {
    await sleep(interval * 1000);
    let poll: Awaited<ReturnType<typeof postJson>>;
    try {
      poll = await postJson(options, "/api/cli/auth/token", { device_code: pending.device_code });
    } catch {
      continue;
    }
    const error = typeof poll.payload.error === "string" ? poll.payload.error : null;
    if (poll.status === 200 && typeof poll.payload.api_key === "string") {
      const workspace = poll.payload.workspace as { name?: unknown } | undefined;
      const workspaceName = typeof workspace?.name === "string" ? workspace.name : "";
      await storeCredential(options.env, options.apiBaseUrl, {
        api_key: poll.payload.api_key,
        key_name: shortHostname() ? `CLI on ${shortHostname()}` : "CLI",
        workspace_name: workspaceName,
      });
      await clearPending(options.cwd);
      say(`Signed in to ${workspaceName || "SaaSFunnels"}.`, "login_complete", { workspace: { name: workspaceName } });
      return { key: poll.payload.api_key, ok: true, workspaceName };
    }
    if (error === "authorization_pending" || error === "temporarily_unavailable") continue;
    if (error === "slow_down") {
      interval = Number(poll.payload.interval) > interval ? Number(poll.payload.interval) : interval + 5;
      continue;
    }
    await clearPending(options.cwd);
    if (error === "access_denied")
      return { code: "login_denied", message: "Sign-in was canceled in the browser.", nextAction: "Run the command again to get a new code.", ok: false };
    return { code: "login_expired", message: "The sign-in code expired.", nextAction: "Run the command again to get a new code.", ok: false };
  }

  if (now() >= pending.expires_at) {
    await clearPending(options.cwd);
    return { code: "login_expired", message: "The sign-in code expired.", nextAction: "Run the command again to get a new code.", ok: false };
  }
  await mkdir(join(options.cwd, ".saasfunnels"), { recursive: true });
  await writePrivateJson(join(options.cwd, PENDING_FILE), pending);
  return {
    message: `Approve in the browser (${pending.verification_uri_complete}, code ${pending.user_code}), then run the same command again.`,
    ok: false,
    pending: true,
  };
}

export async function logout(options: Pick<LoginOptions, "apiBaseUrl" | "env" | "fetch">) {
  const stored = await readStoredCredential(options.env, options.apiBaseUrl);
  if (!stored) return { signedIn: false, revoked: false };
  let revoked = false;
  try {
    const response = await postJson({ ...options, cwd: ".", interactive: false, json: false }, "/api/cli/auth/revoke", {}, stored.api_key);
    revoked = response.status === 200 && response.payload.revoked === true;
  } catch { /* Delete locally even when offline. */ }
  await deleteStoredCredential(options.env, options.apiBaseUrl);
  return { signedIn: true, revoked };
}

/** --save-env: write the key only into an env file git ignores. */
export async function saveKeyToEnvFile(cwd: string, file: string, key: string) {
  const path = resolve(cwd, file);
  if (!/^\.env(\.[A-Za-z0-9_-]+)*$/.test(file.split(/[\\/]/).pop() ?? ""))
    return { ok: false as const, message: `--save-env only writes .env files, like .env.local.` };
  try {
    await exec("git", ["check-ignore", "-q", file], { cwd, timeout: 10_000 });
  } catch {
    return { ok: false as const, message: `${file} isn't ignored by git, so the key wasn't saved there. Add it to .gitignore first.` };
  }
  let source = "";
  try { source = await readFile(path, "utf8"); } catch { /* New file. */ }
  const lines = source.split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ""));
  const kept = lines.filter((line) => !/^\s*(export\s+)?SAASFUNNELS_API_KEY\s*=/.test(line));
  kept.push(`SAASFUNNELS_API_KEY=${key}`);
  await writeFile(path, kept.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  return parseEnv(kept.join("\n")).SAASFUNNELS_API_KEY === key
    ? { ok: true as const, message: `Saved SAASFUNNELS_API_KEY to ${file}.` }
    : { ok: false as const, message: `Couldn't save the key to ${file}.` };
}
