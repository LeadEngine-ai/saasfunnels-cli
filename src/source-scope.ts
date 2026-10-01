import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Use Git's own ignore semantics, including nested ignores, negations and
// worktrees. Keep tracked files even when a later ignore rule matches them.
// Standalone, non-Git projects still use the scanners' filesystem filters.
export async function repositorySourceScope(cwd: string) {
  try {
    await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  } catch (error) {
    const failure = error as { code?: string | number; stderr?: string };
    if (
      failure.code === "ENOENT" ||
      failure.stderr?.includes("not a git repository")
    )
      return (_path: string) => true;
    throw new Error(
      "Cannot read repository source scope. Check Git access and retry.",
    );
  }
  let stdout: string;
  try {
    ({ stdout } = await exec(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
      ],
      {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
      },
    ));
  } catch {
    throw new Error(
      "Cannot list repository sources. Check Git access and retry.",
    );
  }
  const included = new Set<string>([""]);
  for (const path of stdout.split("\0").filter(Boolean)) {
    included.add(path);
    let end = path.lastIndexOf("/");
    while (end > 0) {
      included.add(path.slice(0, end));
      end = path.lastIndexOf("/", end - 1);
    }
  }
  return (path: string) => included.has(path);
}
