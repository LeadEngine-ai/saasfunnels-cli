# SaaSFunnels CLI

The `saasfunnels` package provides local event and Feature validation, implementation handoffs, customer-safe live diagnostics, and a local stdio MCP server.

This repository contains only the MIT-licensed CLI and its bounded runtime contracts. The SaaSFunnels application, hosted MCP implementation, data layer, environment configuration, and other product packages remain private. See [docs/extraction-boundary.md](docs/extraction-boundary.md).

## Requirements

- Node.js 22 or newer

## Install

After the beta is published:

```bash
npm install --global saasfunnels@beta
```

## Use

```bash
saasfunnels --help
saasfunnels verify --json
saasfunnels mcp serve
```

Local validation does not require credentials. Live reads use `SAASFUNNELS_API_KEY`; Direct API smoke events use `SAASFUNNELS_INGEST_API_KEY`. Set `SAASFUNNELS_API_BASE_URL` to target a controlled preview or the current SaaSFunnels host.

Hosted interactive MCP uses Clerk OAuth at the application `/mcp` URL and does not require this CLI or a copied API key.

## Development

```bash
npm ci
npm run release:verify
```

The package allowlist is enforced as exactly `LICENSE`, `README.md`, `dist/saasfunnels.js`, and `package.json`.

Documentation: https://docs.saasfunnels.ai/developer-tools/saasfunnels-cli

Support: support@saasfunnels.ai
