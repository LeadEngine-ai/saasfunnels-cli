import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { setupLifecycleEvidenceSchema } from "./setup-lifecycle-contract.js";

export class LifecycleEvidenceError extends Error {
  constructor(issue: "changed" | "invalid" | "unreadable") {
    super(
      {
        changed:
          "Lifecycle findings changed during discovery. Start a fresh scan before submitting them.",
        invalid:
          "Review .saasfunnels/setup-lifecycle.json: use valid, bounded lifecycle findings with source references. No lifecycle terms were submitted.",
        unreadable:
          "Cannot read .saasfunnels/setup-lifecycle.json. Use a regular local file.",
      }[issue],
    );
  }
}

/** Reviewed structured facts only. Reading a declaration neither executes source
 * nor establishes a working runtime binding or an approved commercial offer. */
export async function readSetupLifecycle(cwd: string) {
  let file;
  try {
    file = await open(
      join(cwd, ".saasfunnels/setup-lifecycle.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LifecycleEvidenceError("unreadable");
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 200_000)
      throw new Error(
        "Lifecycle evidence must be a regular file no larger than 200 KB.",
      );
    const buffer = Buffer.alloc(200_001);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 200_000) throw new Error("Lifecycle evidence exceeds 200 KB.");
    const findings = setupLifecycleEvidenceSchema.parse(
      JSON.parse(buffer.subarray(0, length).toString("utf8")),
    );
    // A repository declaration may discover a connection, but cannot attest to
    // installed/tested authority. The application's exact Test remains required.
    return {
      fingerprint: createHash("sha256")
        .update(buffer.subarray(0, length).toString("utf8"))
        .digest("hex"),
      findings: findings.map((finding) => ({
        ...finding,
        entry: finding.entry
          ? { ...finding.entry, verification: "discovered" as const }
          : null,
        action: finding.action
          ? { ...finding.action, verification: "discovered" as const }
          : null,
      })),
    };
  } catch {
    throw new LifecycleEvidenceError("invalid");
  } finally {
    await file.close();
  }
}
