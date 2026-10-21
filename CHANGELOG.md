# Changelog

All notable changes to the published packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Each package is released on its own,
with the Git tag `client-v<version>` or `relay-v<version>`.

## @ractive-ch/tab-mcp-client

### Unreleased

#### Added

- Identity binding with relays that pair by `oidc`: the option `identityAssertion`, a
  function that returns a tab assertion from your web app's backend for the signed-in
  user and the page's address (or `null` when nobody is signed in). The library asks it
  after every connect and sends the assertion to the relay. `refreshIdentity()` asks
  again (after a sign-in without a page load), `signOut()` tells the relay the user
  signed out, which ends every AI connection of the page at once. `identity` and the
  event `identitychange` say whether the relay accepted the page's user; only the answer
  to the newest assertion counts, and `identityTimeoutMs` (15 s) ends the wait.
- `SessionInfo.pairing` (`code` or `oidc`). With `oidc` the connect dialog shows no code
  but "sign in with the account you use on this page".

### [0.2.0][client-0.2.0] - 2026-10-20

#### Added

- "Always allow" in the default confirmation. That tool then runs without asking for that
  AI app until the page is reloaded or the app is disconnected. Like "Allow", it stays
  disabled for a moment after the dialog opens. A custom `onConfirm` is asked every time,
  as before.
- The events `toolcall` and `toolcallend`: every call of a known tool by an AI app as it
  starts (id, tool, arguments, AI app) and as it ends (outcome `ok`, `error`, `declined`
  or `cancelled`, the result, the duration). For an activity log in the page.

### [0.1.0][client-0.1.0] - 2026-10-20

The first stable release, on the npm dist-tag `latest`; install without `@alpha`.

#### Added

- "New address" in the connect dialog. It calls `newAddress()`, which disconnects every
  connected AI app and makes a new address. While apps are connected, the dialog first
  names them and asks.
- The connect dialog notes that a new pairing code appears every 2 minutes and after each
  use, and announces each newly connected AI app.

#### Changed

- The default dialog says "AI app" instead of "AI tool": its title is now "Connect your
  AI app". Pages that quote the old wording should follow.
- `appName` must be 1-64 characters without control characters, as the relay requires
  (before, only the length was checked).
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
- The connect dialog shows the pairing code from the relay.

## @ractive-ch/tab-mcp

The relay. Each relay release is also a Docker image, `ractive/tab-mcp` and
`ghcr.io/ractive/tab-mcp`, tagged with the version.

### Unreleased

#### Added

- Identity binding (`TAB_MCP_IDENTITY=oidc`, or `pairing: "oidc"` per site): an AI app
  connects without a code when the person signing in at your OpenID Connect provider is
  the person signed in to the page; anyone else gets "This AI tool is logged in as
  someone other than the page." The relay is a client of the provider
  (`TAB_MCP_OIDC_ISSUER`, `TAB_MCP_OIDC_CLIENT_ID`, `TAB_MCP_OIDC_CLIENT_SECRET`,
  `TAB_MCP_OIDC_SUBJECT_CLAIM`; callback `/authorize/callback`), and the page proves its
  user with a short JWT from the web app's backend (`TAB_MCP_TAB_ASSERTION_ISSUER`,
  `TAB_MCP_TAB_ASSERTION_JWKS_URL`). Settings are checked at start.
- Protocol: `identity`, `identity.bound`, `identity.logout`, error `identity_refused`,
  `session.pairing`, MCP error `-31009`. Logout in the page revokes the address's grants
  at once; a page that signs in as someone else revokes the previous person's grants.
- `TokenRecord.subject` and `GrantSummary.subject`: the hashed identity of a grant made by
  identity binding. Custom token stores must store and return it (the conformance suite
  checks it); a store that drops it refuses those grants. The SQLite store adds the
  column when it opens an older file.

#### Changed

- A site without `pairing` now takes `TAB_MCP_IDENTITY` (default `code`, so nothing
  changes unless you set it); `resolveConfig()` no longer fills in `pairing: "code"`.

### [0.2.1][relay-0.2.1] - 2026-10-21

#### Fixed

- `/healthz` sends `cache-control: no-store` and `/` a cache time of one hour. Without
  them bunny's CDN kept both for 30 days, so after the deploy of 0.2.0 `/healthz` still
  reported 0.1.0.

### [0.2.0][relay-0.2.0] - 2026-10-21

#### Added

- `TAB_MCP_PAGE_WAIT_S` (default 10, at most 60, 0 = off): an MCP request whose page is
  not open waits that long for the page to open or reconnect, then is forwarded as usual.
  Phones pause a tab in the background, so this covers switching apps. The wait ends when
  the AI app closes the request; at most `TAB_MCP_MAX_CONCURRENT_REQUESTS` requests wait
  per address and `TAB_MCP_MAX_SESSIONS` in all. `server/discover` does not wait.

#### Changed

- "The page is not open" is answered with HTTP 200 instead of 503, so AI apps keep using
  the 2026-07-28 protocol: an HTTP error made claude.ai and Claude Code fall back to the
  old `initialize` handshake, which the relay refuses, and the connection did not recover
  when the page came back. A `tools/call` gets a tool result with `isError: true` that
  tells the model to ask the user to open the page (by its app name) and keep it in
  front; `server/discover` gets a stand-in result with `ttlMs: 0`; other requests get the
  JSON-RPC error `-31001`. Notifications keep the 503.
- When the page closes its connection during a request, a `tools/list` waits for the page
  once more and is sent again; a `tools/call` is not sent twice and gets a tool result
  saying the page closed while the tool ran. Other requests get `-31003` at HTTP 200.

### [0.1.0][relay-0.1.0] - 2026-10-20

The first stable release, on the npm dist-tag `latest`; install without `@alpha`. The
image is `ractive/tab-mcp:0.1.0` and `ghcr.io/ractive/tab-mcp:0.1.0`, also tagged `0.1`
and `latest`.

#### Added

- The `RevokeOptions` type is exported, for custom token stores.
- Package README with the quick start, the `tab-mcp` command and the library API.
- Documentation: configuration, self-hosting, token store, protocol, threat model and
  security policy, and the tab-mcp agent skill.

#### Changed

- The relay's pages say "AI app" instead of "AI tool" and name the page's "Connect your
  AI app" dialog.

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

[client-0.2.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.2.0
[client-0.1.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.1.0
[client-0.1.0-alpha.1]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.1.0-alpha.1
[client-0.1.0-alpha.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.1.0-alpha.0
[relay-0.2.1]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.2.1
[relay-0.2.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.2.0
[relay-0.1.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.1.0
[relay-0.1.0-alpha.1]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.1.0-alpha.1
[relay-0.1.0-alpha.0]: https://www.npmjs.com/package/@ractive-ch/tab-mcp/v/0.1.0-alpha.0
