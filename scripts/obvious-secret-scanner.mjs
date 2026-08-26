import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, sep } from "node:path";

const skippedDirs = new Set([
  ".agents",
  ".git",
  ".next",
  ".vercel",
  ".worktrees",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const scannedExtensions = new Set([
  ".cjs",
  ".css",
  ".env",
  ".example",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".md",
  ".mdx",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const placeholderValues = new Set([
  "",
  "changeme",
  "change-me",
  "dummy",
  "example",
  "example-secret",
  "fake",
  "placeholder",
  "replace-me",
  "test",
  "todo",
  "your-secret",
  "your-secret-here",
  "your-token",
  "your-token-here",
]);

const providerPatterns = [
  {
    description: "private key material",
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  },
  {
    description: "Stripe live secret key",
    regex: /\bsk_live_(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{16,}\b/,
  },
  {
    description: "Stripe webhook signing secret",
    regex: /\bwhsec_(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{16,}\b/,
  },
  {
    description: "GitHub classic access token",
    regex: /\bgh[pousr]_(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{30,}\b/,
  },
  {
    description: "GitHub fine-grained access token",
    regex: /\bgithub_pat_(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{40,}\b/,
  },
];

function extensionFor(path) {
  const match = path.match(/\.[^.]+$/);
  return match?.[0] ?? "";
}

function normalizePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function isScannable(path) {
  if (path.endsWith(".env")) return true;
  if (path.includes(".env.")) return true;
  return scannedExtensions.has(extensionFor(path));
}

function isSkippedPart(part) {
  return skippedDirs.has(part) || part.startsWith("static_analysis_codeql_") || part.startsWith("static_analysis_semgrep_");
}

function isPlaceholderValue(value) {
  const normalized = value.trim().replace(/^["']|["']$/g, "").trim();
  if (placeholderValues.has(normalized.toLowerCase())) return true;
  if (/^env\([A-Z0-9_]+\)$/i.test(normalized)) return true;
  if (/^\$\{?[A-Z0-9_]+\}?$/i.test(normalized)) return true;
  if (/^<[^>]+>$/.test(normalized)) return true;
  return normalized.length === 0;
}

function isBrowserSafePublicKey(name, value) {
  const normalizedName = name.toUpperCase();
  const normalizedValue = value.trim().replace(/^["']|["']$/g, "");

  if (normalizedName.includes("SECRET")) return false;
  if (normalizedName.includes("PUBLISHABLE")) return true;
  if (normalizedName.includes("ANON_KEY")) return true;
  if (normalizedName.includes("CLIENT_KEY")) return normalizedValue.startsWith("pv_web_");

  return false;
}

function extractAssignment(line) {
  const envMatch = line.match(
    /^\s*(?:export\s+)?([A-Z0-9_]*?(?:SECRET|TOKEN|API_KEY|PRIVATE_KEY|PASSWORD)[A-Z0-9_]*)\s*=\s*([^#;\n]+)/,
  );

  if (envMatch) {
    return {
      envStyle: true,
      name: envMatch[1],
      value: envMatch[2].trim().replace(/[,;]$/, ""),
    };
  }

  const jsMatch = line.match(
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*?(?:Secret|Token|ApiKey|APIKey|PrivateKey|Password)[A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*([^#;\n]+)/,
  );

  if (!jsMatch) return undefined;

  return {
    envStyle: false,
    name: jsMatch[1],
    value: jsMatch[2].trim().replace(/[,;]$/, ""),
  };
}

function sensitiveAssignmentFinding(line) {
  const assignment = extractAssignment(line);
  if (!assignment) return undefined;

  if (isPlaceholderValue(assignment.value)) return undefined;
  if (assignment.name.startsWith("NEXT_PUBLIC_") && !isBrowserSafePublicKey(assignment.name, assignment.value)) {
    return `public environment variable ${assignment.name} appears to expose a secret`;
  }
  if (isBrowserSafePublicKey(assignment.name, assignment.value)) return undefined;

  const value = assignment.value.replace(/^["']|["']$/g, "");
  if (!assignment.envStyle && !/^["'`]/.test(assignment.value)) return undefined;
  if (value.length < 16) return undefined;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return undefined;

  return `${assignment.name} appears to contain a hardcoded secret`;
}

export function scanContent(content, path = "inline") {
  const findings = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    for (const pattern of providerPatterns) {
      if (pattern.regex.test(line)) {
        findings.push({
          description: pattern.description,
          line: lineNumber,
          path,
        });
      }
    }

    const assignmentFinding = sensitiveAssignmentFinding(line);
    if (assignmentFinding) {
      findings.push({
        description: assignmentFinding,
        line: lineNumber,
        path,
      });
    }
  }

  return findings;
}

function collectFilesFromWalk(root, dir = root) {
  const files = [];

  for (const entry of readdirSync(dir)) {
    if (isSkippedPart(entry)) continue;

    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...collectFilesFromWalk(root, fullPath));
      continue;
    }

    if (stats.isFile() && isScannable(fullPath)) files.push(fullPath);
  }

  return files;
}

function collectGitFiles(root) {
  try {
    const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((path) => !path.split("/").some(isSkippedPart))
      .filter(isScannable)
      .map((path) => join(root, path));
  } catch {
    return collectFilesFromWalk(root);
  }
}

export function collectCandidateFiles(root, { useGit = true } = {}) {
  return (useGit ? collectGitFiles(root) : collectFilesFromWalk(root)).filter(existsSync);
}

export function scanFiles(root, files) {
  const findings = [];

  for (const file of files) {
    const rel = normalizePath(root, file);
    const content = readFileSync(file, "utf8");
    findings.push(...scanContent(content, rel));
  }

  return findings;
}

export function scanDirectory(root, options = {}) {
  return scanFiles(root, collectCandidateFiles(root, options));
}

