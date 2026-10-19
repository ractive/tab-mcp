# Changelog

All notable changes to the published packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Each package is released on its own,
with the Git tag `client-v<version>` or `relay-v<version>`.

## @ractive-ch/tab-mcp-client

### [0.1.0-alpha.0] - unreleased

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

[0.1.0-alpha.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.1.0-alpha.0

## @ractive-ch/tab-mcp

### Unreleased

#### Added

- OAuth 2.1 authorization server for MCP clients: protected-resource and server metadata,
  clients through Client ID Metadata Documents, PKCE S256, `iss`, a pairing page where the
  user types the code shown in the page, rotating refresh tokens with reuse detection,
  revocation.
- Per-site configuration (`TAB_MCP_SITES`): app name, pairing method and limits per page
  origin; `TAB_MCP_CLIENT_ID_HOSTS` to limit which AI apps may connect.

#### Changed

- `TAB_MCP_MAX_MESSAGE_BYTES` must be at least 16384.
