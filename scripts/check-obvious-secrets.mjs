#!/usr/bin/env node
import { scanDirectory } from "./obvious-secret-scanner.mjs";

const root = process.cwd();
const findings = scanDirectory(root);

if (findings.length > 0) {
  console.error("Obvious secret scan failed:\n");
  for (const finding of findings) {
    console.error(`- ${finding.path}:${finding.line}: ${finding.description}`);
  }
  console.error("\nMove secrets into Doppler/GitHub secrets and keep browser-exposed env vars publishable only.");
  process.exit(1);
}

console.log("Obvious secret scan passed.");

