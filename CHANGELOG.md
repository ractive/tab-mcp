# Changelog

All notable changes to the published packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Each package is released on its own,
with the Git tag `client-v<version>` or `relay-v<version>`.

## @ractive-ch/tab-mcp-client

### Unreleased

#### Changed

- README: how to get a relay, pairing, consequential tools and your own UI. Cursor is no
  longer named among the AI apps, because it cannot connect yet.

### [0.1.0-alpha.1][client-0.1.0-alpha.1] - 2026-10-20

No changes to the library. Published through the release workflow (trusted publishing)
to validate it; the release step now reads `npm view` output from npm 11 and 12 alike.

### [0.1.0-alpha.0][client-0.1.0-alpha.0] - 2026-10-19

First alpha of the browser library, on the npm dist-tag `alpha`.

#### Added

- `TabMcp`: register tools WebMCP-style (`registerTool` with JSON Schema input, annotations
  and an abort signal), connect to a tab-mcp relay and answer MCP requests in the page.
- A small core; `connect()` loads the connection and the dialogs on demand.
- Default dialogs: "Connect your AI tool" with the address and connected apps, and a
  confirmation for consequential tools.
- ESM build for bundlers with type declarations, and a self-contained build for
  `<script type="module">` under `@ractive-ch/tab-mcp-client/cdn`.
- The connect dialog shows the pairing code from the relay, notes that it changes every
  2 minutes, and announces each newly connected AI app.
- `appName` must be 1-64 characters without control characters, as the relay requires.

## @ractive-ch/tab-mcp

The relay. Each relay release is also a Docker image, `ractive/tab-mcp` and
`ghcr.io/ractive/tab-mcp`, tagged with the version.

### Unreleased

#### Added

- Package README with the quick start, the `tab-mcp` command and the library API.

### [0.1.0-alpha.1][relay-0.1.0-alpha.1] - 2026-10-20

No changes to the relay. The first version published through the release workflow
(trusted publishing) to validate it, and the first Docker image:
`ractive/tab-mcp:0.1.0-alpha.1` and `ghcr.io/ractive/tab-mcp:0.1.0-alpha.1` for
linux/amd64 and linux/arm64, with provenance and SBOM attestations.

### [0.1.0-alpha.0][relay-0.1.0-alpha.0] - 2026-10-20

First alpha of the relay, on the npm dist-tag `alpha`, uploaded by hand from the
CI-signed tarball (no GitHub release, no Docker image). It runs on Bun 1.4.3 or newer.

#### Added

- Tab sessions over a WebSocket (`/tab`, protocol `tab-mcp.v1`): page origins from an
  allow-list that is empty by default, a stable MCP address per page derived from a
  secret the page keeps, heartbeat, idle timeout and session lifetime.
- An MCP endpoint per address (`/a/<id>/mcp`) for MCP revision 2026-07-28 only. It
  forwards requests to the page, starts the event stream itself after 20 seconds, sends
  keep-alives, and limits body size, concurrent requests and request time. One exception
  for Claude's mismatched `MCP-Protocol-Version` header, counted in `/healthz`.
- OAuth 2.1 authorization server for AI apps: protected-resource and server metadata,
  clients through Client ID Metadata Documents only, PKCE S256, `iss`, a pairing page
  where the user types the code shown in the page, rotating refresh tokens with reuse
  detection, revocation, and a connection lifetime of at most 90 days after pairing
  (`TAB_MCP_GRANT_LIFETIME_S`).
- Per-site configuration (`TAB_MCP_SITES`): app name, pairing method and limits per page
  origin; `TAB_MCP_CLIENT_ID_HOSTS` to limit which AI apps may connect.
- `TokenStore` interface with SQLite (default) and memory stores, and the conformance
  suite `@ractive-ch/tab-mcp/testing` for custom stores.
- `createRelay()` for embedding, and the `tab-mcp` command configured with `TAB_MCP_*`
  environment variables (`tab-mcp --help`).
- `/healthz` with the version, and JSON-line logs that never contain request or response
  bodies.

[client-0.1.0-alpha.1]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.1.0-alpha.1
[client-0.1.0-alpha.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.1.0-alpha.0
[relay-0.1.0-alpha.1]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.1.0-alpha.1
[relay-0.1.0-alpha.0]: https://www.npmjs.com/package/@ractive-ch/tab-mcp/v/0.1.0-alpha.0
