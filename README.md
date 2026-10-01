# SaaSFunnels CLI

The `saasfunnels` package provides local event and Feature validation, implementation handoffs, customer-safe live diagnostics, and a local stdio MCP server.

This repository contains only the MIT-licensed CLI and its bounded runtime contracts. The SaaSFunnels application, hosted MCP implementation, data layer, environment configuration, and other product packages remain private. See [docs/extraction-boundary.md](docs/extraction-boundary.md).

## Requirements

- Node.js 22 or newer

## Install

Install the stable CLI:

```bash
npm install --global saasfunnels
```

## Use

```bash
saasfunnels --help
saasfunnels verify --json
saasfunnels mcp serve
```

### Plans and pricing

```bash
saasfunnels plans discover              # propose files, no network call
saasfunnels plans discover --apply      # write .saasfunnels/plan-sources.json
saasfunnels plans handoff --integration-id <id> \
  --repository-key <repo> --repository-revision <sha> --send
```

`plans discover` reads the working tree and proposes files that define plans and
prices. Files that reference a Stripe price are reported as evidence; files that
only look commercial by name and content are reported separately as guesses.
Nothing leaves the machine until `.saasfunnels/plan-sources.json` lists the files
and `plans handoff --send` is run. The CLI extracts normalized mapping evidence
locally; source contents stay on your machine. Commit the approval file so the
approved set is reviewable.

### GitHub Action

```yaml
- uses: LeadEngine-ai/saasfunnels-cli/action@v0.2.1
  with:
    api-key: ${{ secrets.SAASFUNNELS_API_KEY }}
    cli-version: 0.2.1          # pin it; a floating version rebaselines drift
    discovery-roots: app,lib
```

On a pull request the Action scans as a `candidate`: the result is compared
against the branch's baseline and discarded. Only the default branch advances
the lineage. Changing `discovery-roots` starts a new lineage, so drift is
measured against a comparable scan rather than a wider or narrower one.

Plan and pricing upload is opt-in:

```yaml
    plan-sources: "true"
    integration-id: <stripe integration id>
```

It runs only on the default branch, requires a committed
`.saasfunnels/plan-sources.json`, and fails with an explanation rather than
uploading anything if that file is missing.

Local validation does not require credentials. Live reads use `SAASFUNNELS_API_KEY`; Direct API smoke events use `SAASFUNNELS_INGEST_API_KEY`. Set `SAASFUNNELS_API_BASE_URL` to target a controlled preview or the current SaaSFunnels host.

Hosted interactive MCP uses Clerk OAuth at the application `/mcp` URL and does not require this CLI or a copied API key.

The application imports the exact versioned MCP registry through the server-side `saasfunnels/library` export. This keeps hosted Streamable HTTP and local stdio MCP on one package owner; it is not a browser API.

## Development

```bash
npm ci
npm run release:verify
```

The package allowlist is enforced as `LICENSE`, `README.md`, `package.json`, the `saasfunnels` executable bundle, and the typed server-side library bundle/declarations.

Documentation: https://docs.saasfunnels.ai/developer-tools/saasfunnels-cli

Support: support@saasfunnels.ai

### Guided application discovery

Use `saasfunnels setup run` from the application repository after creating app credentials in Setup. Load `SAASFUNNELS_API_KEY` from **Developer setup access** into the local process environment. Its scopes are `developer:read` and `features:write`; it is not a browser or payment-administration key.

The command asks before uploading structured discovery proposals. `--send` provides explicit non-interactive approval. It coordinates features, pricing extraction, and plan branches, reports progress, and waits for the Stripe catalog. Run `saasfunnels setup run --resume` after an interruption. Existing accepted stages and customer review decisions are preserved.

If extraction is unsupported, review a `.saasfunnels/setup-pricing.json` file with `{ "plans": [{ "key": "pro", "name": "Pro", "features": { "export": true }, "prices": [{ "key": "price_ACTUAL_ID" }] }] }`, then resume. Use real identifiers from the connected merchant. Raw source files are never uploaded by guided setup or the pricing handoff.

The command does not implement arbitrary payment code, approve feature access, or verify transactions. Complete **Review and verify** in Setup after deploying the runtime and payment integration. Requires the server's guided setup API release.
