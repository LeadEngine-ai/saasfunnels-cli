import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv, promisify } from "node:util";

const exec = promisify(execFile);

/** Load only developer access, never print values or import runtime secrets. */
export async function resolveSetupAccess(options: {
  cwd: string;
  key?: string;
  envFile?: string;
  prompt?: (message: string) => Promise<string>;
  loadDoppler?: () => Promise<string>;
}) {
  if (options.key?.trim()) return { key: options.key.trim() };
  let file = options.envFile;
  if (!file && options.prompt) {
    const choice = (await options.prompt(
      "Developer access is not loaded. Where did you save SAASFUNNELS_API_KEY?\n  1. Doppler (this folder’s configured project)\n  2. .env.local in this app\n  3. I haven’t saved it yet\nChoose [1/2/3]: ",
    )).trim();
    if (choice === "1") {
      try {
        const key = options.loadDoppler
          ? await options.loadDoppler()
          : (await exec("doppler", ["secrets", "get", "SAASFUNNELS_API_KEY", "--plain"], {
              cwd: options.cwd, timeout: 30_000, maxBuffer: 64_000,
            })).stdout;
        if (key.trim()) return { key: key.trim() };
      } catch { /* Provider output may contain credentials; never forward it. */ }
      return { error: "Couldn’t load developer access from Doppler. Check this folder’s Doppler project/config and save SAASFUNNELS_API_KEY there, then rerun this command." };
    }
    if (choice === "2") file = ".env.local";
  }
  if (file) {
    try {
      const source = await readFile(resolve(options.cwd, file), "utf8");
      if (source.length > 64_000) throw new Error("Oversized env file");
      const key = parseEnv(source).SAASFUNNELS_API_KEY?.trim();
      if (key) return { key };
    } catch { /* Do not print the path, contents, or parser exception. */ }
    return { error: "Couldn’t find SAASFUNNELS_API_KEY in the selected env file. Save the developer access key there, then rerun this command. No file was changed." };
  }
  return { error: "Open SaaSFunnels → Setup → Environment values → Developer setup access. Save SAASFUNNELS_API_KEY in your secret manager or .env.local, then run npx --yes saasfunnels@latest setup again. Never paste the key into a command. For automation, load it into the process or use --env-file .env.local." };
}
