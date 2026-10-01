# SaaSFunnels CLI

The `saasfunnels` package provides local event and Feature validation, implementation handoffs, customer-safe live diagnostics, and a local stdio MCP server.

This repository contains only the MIT-licensed CLI and its bounded runtime contracts. The SaaSFunnels application, hosted MCP implementation, data layer, environment configuration, and other product packages remain private. See [docs/extraction-boundary.md](docs/extraction-boundary.md).

## Requirements

- Node.js 22 or newer

## Install

Start in your app repository:

```bash
npx --yes saasfunnels@latest setup
```

The explicit version tag avoids running an older project-local CLI. Setup asks where developer access is saved (Doppler or `.env.local`) when needed, requests approval before uploading findings, and shows each discovery stage. It never prints keys, rewrites env files, deploys your app, or approves inferred plans. Connect Stripe and create app credentials in the web Setup first. `setup run` remains a compatible entry point.

For scripts, use `--env-file .env.local --send --non-interactive`, or inject `SAASFUNNELS_API_KEY` from your secret manager. Without explicit approval, non-interactive runs stop without uploading. Run `setup --help` for setup-only guidance. Runtime implementation and payment verification remain in the web Setup.

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

The Action uploads an existing feature manifest; it does not freshly scan application source. On a pull request the upload is a `candidate`: the result is compared
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

In hosted OAuth, `list_workspaces` discovers accessible workspace names and IDs. Live read, inspect, and plan tools accept an optional `workspace_id`. The hosted application must select the sole accessible workspace automatically, require an explicit ID when several are accessible, recheck authorization for every call, and include the selected workspace name and ID in each live response. The application passes the selection through to its developer API as the `workspace_id` query parameter. Local stdio API-key tools do not expose workspace selection; their key stays pinned to its workspace.

For Funnel discovery, hosted MCP offers `list_funnels` and `get_funnel_state`. `list_funnels` returns at most 50 summaries per page; follow `page.hasMore` with the next `offset` to cover the workspace. The app returns the selected workspace and evaluation time with each read. `get_funnel_state` reports the current lifecycle and publication readiness for one Funnel. These reads do not include Funnel definitions, customer data, or Results. Signals remain supporting evidence and enrollment inputs.

For performance, `get_portfolio_results` and `get_funnel_results` use a 7d, 30d, 90d, or 12m reporting window (30d by default). Portfolio rows are paged at 50 Funnels and cover at most the first 100; check `page.has_more` and `funnels_truncated` before claiming complete coverage. Stage counts and revenue rows retain their distinct attribution, value basis, and currency. `list_opportunities` and `list_leads` return at most 50 records per page with `page.total_count` and `page.has_more`; `get_opportunity` and `get_lead` return one bounded record. Opportunity reads omit private evidence and money; Lead reads omit personal identity and raw responses. These six reads require hosted OAuth, an accessible selected workspace, and the app's `funnels.view` role check.

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

The scanner reads supported application files one at a time without the old 500-file, 2 MB repository, or 200-candidate cutoffs. Generated code, tests, and symlinks are excluded. Files over 2 MB and uploads over the server limit stop with a specific recovery message.

Static pricing supports literal spreads, capability/quota maps, unlimited limits, and exact Stripe lookup-key matching. It never executes customer code. Pricing definitions are inspected beyond the first ten filename matches; unrelated helpers do not count as plans.

If extraction is unsupported, `.saasfunnels/setup-review.json` lists the files and reasons. Correct those declarations or review a `.saasfunnels/setup-pricing.json` file with `{ "plans": [{ "key": "pro", "name": "Pro", "features": { "export": true }, "prices": [{ "key": "price_ACTUAL_ID" }] }] }`, then resume. Use real identifiers from the connected merchant. Raw source files are never uploaded by guided setup or the pricing handoff.

Discovery follows Git ignore rules (including custom build folders) while keeping tracked application sources and new, non-ignored source files. Standalone folders without Git use the standard source filters.

The command does not implement arbitrary payment code, approve feature access, or verify transactions. Complete **Review and verify** in Setup after deploying the runtime and payment integration. Requires the server's guided setup API release.

### Discovery accuracy and review

Guided setup proposes supported JavaScript/TypeScript gates and static JS/TS/JSON/YAML catalogs. Tests, fixture/demo scopes, comments, and generic role permissions are excluded. Named capabilities and numeric/unlimited limits remain separate; units, reset periods, and aggregation require review in Setup's existing Plans & pricing editor.

A frontend scan is not evidence of complete backend coverage. Setup flags unsupported application languages, unresolved dynamic access, and optional add-on/capacity/trial declarations. Review these against the actual application's entitlement owner before confirming. Imported or dynamic pricing that cannot be statically resolved needs reviewed literal `.saasfunnels/setup-pricing.json` evidence or manual configuration; source is never executed. Arbitrary helper names and external services cannot be exhaustively discovered automatically.

Feature configuration must be saved and published in Plans & pricing before Setup can confirm it. Naming an unnamed restriction records a review decision; it does not implement access. A new scanner version may require running without `--resume`; guided rescans preserve human decisions and leave local generated catalogs untouched.
