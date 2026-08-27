# Extraction boundary

This repository is a clean, history-free extraction of the public SaaSFunnels CLI. It does not contain or inherit Git history from the private application repository.

## Extracted under MIT

- The command dispatcher and local CLI operations: initialization, event validation/samples/test sends, agent handoffs, Feature discovery and manifest generation, diagnostics, readiness, verification, and stdio MCP startup.
- The local stdio MCP protocol handler, public resources, tool definitions, redaction rules, capability gates, and bounded calls to public developer-tool endpoints.
- A typed server-side `saasfunnels/library` export of that same MCP registry for the private application's hosted transport adapter. The export contains no hosted authentication, database, UI, deployment, or environment owner.
- The Feature setup scanner and generated manifest/instrumentation handoff logic.
- Only the runtime portions of five shared contract areas reachable from the CLI build: developer-tool payload contracts, agent capability boundary metadata, event semantics, signal-family readiness metadata, and Feature instrumentation schema validation.
- Standalone build, focused tests, deterministic package inspection, installed-package smoke, secret scanning, dependency auditing, and the manual staged-publish workflow.

The CLI executable and library export are built from the same source revision and version. The release verifier installs the exact tarball, imports the library through package exports, and asserts that the hosted registry contains no write tools. The application must pin an exact published prerelease rather than copy or deep-import this source.

The shared runtime contract code in `src/runtime-contracts.ts` was produced from an explicit export allowlist and tree-shaken before extraction. It contains no imports back into the private repository.

## Intentionally private and not extracted

- Application pages, UI components, routes other than the CLI's remote endpoint strings, and hosted MCP transport/authentication.
- Database schemas, migrations, queries, persistence services, background jobs, billing implementations, and provider credentials.
- Environment files, deployment configuration, secrets, logs, test artifacts, and customer data.
- Funnel Studio, account, signal, automation, integration, analytics, and reporting implementations beyond the small immutable contract data required by the CLI.
- Other packages, SDK source, monorepo tooling, and the private repository's Git history.

## Compatibility aliases

Public help, errors, generated files, MCP resources, and package metadata use only SaaSFunnels names. For migration safety, the runtime still accepts the legacy `PREVENUE_*` environment-variable aliases and legacy `prevenue://` MCP resource URIs internally. Canonical `SAASFUNNELS_*` variables and `saasfunnels://` URIs take precedence and are the only names emitted.

If a future CLI change requires another private application module, extract a minimal immutable contract or public API schema deliberately. Do not copy the owning application service across this boundary.
