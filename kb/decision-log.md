---
type: decision-log
title: "Decision log"
description: Decisions for tab-mcp with their reasons, newest last. Owner decisions are marked as such and are not reopened.
tags:
  - decisions
timestamp: 2026-10-19T23:30:00+02:00
---

# Decision log

Owner decisions (DEC-001 to DEC-012) were made with the owner on 2026-10-19 before the
research. DEC-013 to DEC-026 follow from the research and can be challenged. DEC-027 to
DEC-038 are the owner's answers to the open questions (2026-10-19, evening) and are not
reopened; DEC-039 onwards follow from them. An entry that a later one replaces carries a
"Superseded by" note; the later entry is the one that holds.

## DEC-001: Page tools over a public relay (owner)

A page offers functions as MCP tools; the browser library opens an outgoing WebSocket to a
relay and receives a public Streamable HTTP address; AI apps call tools through the relay.
No install on the user's computer.

## DEC-002: MCP logic in the tab, the relay is a dumb pipe (owner)

The relay knows nothing about tools; tool lists and calls are answered in the tab.

## DEC-003: Packages and names (owner)

`packages/tab-mcp` = relay, npm `@ractive-ch/tab-mcp`, Docker Hub `ractive/tab-mcp`
(amd64 + arm64); `packages/tab-mcp-client` = browser library, npm
`@ractive-ch/tab-mcp-client`; `examples/calculator` = minimal example. saturnus is the first
real user, integrated in a separate later project.

## DEC-004: Stack (owner)

Bun 1.4.3, TypeScript 7.0.2 (`bun check`), Biome 2.5.15; latest versions pinned exactly;
Bun built-ins before packages; no Node-only packages where Bun has a built-in.

## DEC-005: Only MCP 2026-07-28 (owner)

Stateless revision only; no `initialize`, no sessions, no legacy support. Confirmed not to
lock out Claude or ChatGPT ([research](/research/ai-app-support.md)); it does lock out
VS Code/Copilot, Gemini CLI and default Codex today.

## DEC-006: OAuth 2.1 with CIMD only, relay is the authorization server (owner)

RFC 9728, RFC 8414, authorization code + PKCE S256, client registration only through Client
ID Metadata Documents, no dynamic client registration. Locks out Cursor (no CIMD yet).

## DEC-007: Consent with code comparison in the tab (owner)

`/authorize` and the tab show the same code; the user approves in the tab; the token is
bound to that tab session.

**Superseded by DEC-028** (the code is typed at `/authorize`, not compared) **and DEC-029**
(tokens are bound to the stable address, not to the tab session).

## DEC-008: Tokens are opaque, in memory, and die with the session (owner)

Random strings; end on tab close/disconnect, timeout or revoke.

**Superseded by DEC-029** (short access token plus rotating refresh token, bound to the
address) **and DEC-030** (stored as hashes in a `TokenStore`, SQLite by default).

## DEC-009: Safe defaults (owner)

Sessions start only by a user click; tab origins from an allow-list; limits on sessions per
IP, message size, idle and request time; logs never contain tool arguments or results; a
Disconnect in the page revokes.

## DEC-010: WebMCP-shaped registration and annotations (owner)

`registerTool(tool, { signal })` with name, description, inputSchema, execute, annotations;
aborting the signal unregisters. Consequential tools confirm in the page.

## DEC-011: Distribution (owner)

MIT + AI_NOTICE; npm with trusted publishing and provenance (first version uploaded by the
owner); Docker Hub with a token secret, possibly ghcr.io; protocol document, SECURITY.md,
threat model, configuration docs, CHANGELOG, compatibility matrix, Renovate or Dependabot,
health endpoint. Hosting on bunny.net Magic Containers is the last iteration.

ghcr.io and Dependabot confirmed in DEC-037.

## DEC-012: Developer skill (owner)

A small Agent Skill (SKILL.md) "add tab-mcp to your web app", packaged like hyalo's
(skill folder, plugin manifests) if cheap; part of the release iteration.

## DEC-013: The tab runs the MCP SDK's `createMcpHandler`; the link tunnels HTTP

The SDK v2 (2.3.1) serves 2026-07-28 only through `createMcpHandler(...).fetch(Request)`; a
hand-wired custom `Transport` stays on the 2025 behaviour (`server/discover` → `-32601`,
no `resultType`). So the tab-side library rebuilds the AI app's HTTP request from a
tunnelled message, calls the handler, and streams the `Response` back. This gives
discover, list, call, header/body validation, argument validation (JSON Schema via
`fromJsonSchema`), `subscriptions/listen`, cache hints and MRTR without our own protocol
code. Cost: about 82 KB gzipped in the page. Rejected: writing the MCP server ourselves
(more code to keep in step with the spec, for ~80 KB); a custom `Transport` (does not
work). Source: [SDK research](/research/mcp-typescript-sdk-v2.md).

**Amended by DEC-035:** the SDK part is loaded only on `connect()`, and iteration 2 first
measures the bundle; if it is mostly unused features and Zod, the tab-side stateless subset
is written by us and the SDK stays a test dependency.

## DEC-014: The relay does not depend on the MCP SDK at runtime

The relay needs: per-address protected-resource metadata, AS metadata, a `WWW-Authenticate`
challenge, a protocol-version pre-check and the bearer check against its own token store —
about 150 lines. The SDK has no authorization server we can use (`server-legacy/auth` is
Express-only, frozen, without CIMD), and its resource-server helpers assume one static
resource URL. Keeping the relay dependency-free keeps the image small and the attack surface
plain. The SDK **client** is a dev dependency for tests.

## DEC-015: The authorization server is ours

Written for Bun: `/authorize`, `/authorize/wait`, `/token`, `/revoke`, CIMD fetching and
validation with SSRF guards, PKCE S256 (`Bun.CryptoHasher`), `iss` (RFC 9207), exact
redirect matching with RFC 8252 loopback port tolerance. AS metadata advertises
`token_endpoint_auth_methods_supported: ["none"]` because claude.ai uses CIMD only then.

**Confirmed by the owner in DEC-031**, with mandatory spec tests, conformance runs and a
security review. `/authorize/wait` is gone with the pairing code (DEC-028).

## DEC-016: No refresh tokens; access token lives as long as the session

A token is worthless after the session ends, so a refresh token adds nothing. `expires_in`
is the remaining session lifetime. Clients must not assume refresh tokens (spec).

**Superseded by DEC-029.**

## DEC-017: Stable addresses through a key kept in the page

Re-adding a connector in claude.ai or ChatGPT every visit would make the tool unusable. The
library keeps a random `addressKey` in `localStorage`; the relay derives the address id by
hashing it and stores nothing. Tokens still end with each session; on the next visit the AI
app gets 401/404, authorizes again, and the user approves in the tab. "New address" rotates
the key. A newer session for the same address replaces the older one. To be confirmed by
the owner ([open questions](/open-questions.md)).

**Superseded by DEC-027** (same idea, owner-confirmed, with the hash spelled out and tokens
that survive sessions).

## DEC-018: Relay checks the protocol version first

Order on the MCP endpoint: known address → `MCP-Protocol-Version` is `2026-07-28` (else 400
/ `-32022` with `supported: ["2026-07-28"]`, which also answers a legacy `initialize`) →
token → limits → forward. The tab's SDK handler does the full header/body validation.

**Superseded by DEC-040** (the order changes because addresses are no longer known to the
relay without a token).

## DEC-019: Tolerate one known Claude header bug

claude-code #93290: Claude Desktop and Claude Code via claude.ai connectors send
`MCP-Protocol-Version: 2025-11-25` with `_meta` protocol version `2026-07-28`, which a strict
server rejects. The relay rewrites the forwarded header to `2026-07-28` in exactly that case
(header `2025-11-25`, body `_meta` `2026-07-28`), counts it in a log line, and drops the
workaround once Claude fixes it. Not legacy support: the request is a 2026-07-28 request.

**Confirmed by the owner in DEC-033.**

## DEC-020: Streamed responses for tool calls, keep-alives from the relay

Bun's idle timer kills held requests (fix: `server.timeout(req, 0)` plus our own timers),
and bunny.net's CDN returns 504 when no response headers arrive within 60 s. The tab answers
`tools/call` with SSE at once (`responseMode: "sse"`), and the relay writes `: keep-alive`
comments every 20 s at event boundaries. Other requests may answer as single JSON.

**Extended by DEC-039:** the relay itself switches a request to SSE when the tab has not
answered within 20 s, so every held request gets keep-alives, whatever the tab does.

## DEC-021: Check every WebSocket send

`ws.send()` returns 0 and drops the message beyond the backpressure limit. The relay sets a
per-socket limit (4 MiB), checks every return value and fails the HTTP request with 503 when
a send is dropped.

## DEC-022: Annotation mapping

WebMCP → MCP: `readOnlyHint` → `readOnlyHint: true`, `destructiveHint: false`;
`consequentialHint` → `destructiveHint: true` and page confirmation; `untrustedContentHint`
→ `openWorldHint: true`. All original WebMCP hints are also kept in the tool's `_meta`
under `ch.ractive.tab-mcp/annotations` (MCP has no trust annotation yet; SEP-1913 is a
draft). MCP-only hints (`idempotentHint`, `destructiveHint`, `openWorldHint`) may be set
directly and win.

## DEC-023: Tool results from `execute`

WebMCP leaves the mapping to the user agent. tab-mcp: a string → one text block; an object
with a `content` array → passed through as an MCP `CallToolResult`; any other JSON value →
a text block with its JSON plus `structuredContent`; a thrown error → `isError: true` with
the error message. Arguments are validated against `inputSchema` by the SDK before
`execute` runs.

## DEC-024: Declarations with TypeScript 7 `tsc`, publishing via `bun pm pack` + `npm publish`

`.d.ts` from `tsc -p tsconfig.build.json` (`emitDeclarationOnly`, `isolatedDeclarations`);
JavaScript from `bun build --target=browser --packages=external` (npm) and a minified
self-contained ESM file (CDN). `bun publish` cannot do provenance, so CI packs with
`bun pm pack` (rewrites `workspace:*`) and publishes the tarball with npm ≥ 11.5.1 through
OIDC trusted publishing. The relay's npm package ships `dist/` built with
`bun build --target=bun`; its `bin` runs on Bun only.

## DEC-025: Browser-level tests with headless Chrome over CDP, no Playwright

The library and the e2e need a real browser. CI runs headless Chrome driven over the
DevTools protocol with Bun's built-in `WebSocket` (a small helper, as saturnus does);
locally Firefox via `ff-rdp` for manual checks (Firefox needs `parsedBody`, see
DEC-013). Unit tests of the library run in Bun (which has `WebSocket`, `Request`,
`Response`).

## DEC-026: Docker image on `oven/bun:1.4.3-distroless`, Docker Hub and ghcr.io

Multi-arch amd64 + arm64 with provenance and SBOM attestations, pushed to Docker Hub
(`DOCKERHUB_TOKEN`) and ghcr.io (`GITHUB_TOKEN`) from one build. bunny.net pulls amd64.
Credentials: [release credentials](/operations/release-secrets.md).

## DEC-027: Stable address from a secret kept in the page (owner)

The page keeps a random secret (32 bytes, base64url, 43 characters) in `localStorage`. The
address id is `base32(sha256(secret))`: SHA-256 over the secret's UTF-8 text, RFC 4648
base32, lower case, no padding (52 characters); the address is
`https://<relay>/a/<id>/mcp`. The tab sends the secret in `hello` over TLS on every
connect; the relay hashes it, so possession of the secret proves ownership of the address
and the relay stores nothing for that. The address does not reveal the secret. "New
address" in the page creates a new secret. Several tabs with the same secret: the newest
session wins, the older tab gets `bye` with reason `replaced` and close code 4005. Without
`localStorage` the library makes a secret that lives as long as the page. Supersedes
DEC-017.

## DEC-028: Pairing like a TV sign-in (owner)

Replaces the code comparison (DEC-007). When the user clicks "Connect your AI tool", the tab
shows the MCP address to paste into the AI app and "When asked, enter the code 123456".
The relay's `/authorize` page asks for that code and names the connecting AI app (from its
verified Client ID Metadata Document) and the page's origin (the `Origin` of the tab's
WebSocket): "You're connecting Claude (claude.ai) to tools from `https://ractive.ch`". The
code has 6 digits, is single-use, valid 2 minutes, and allows at most 5 attempts; while the
dialog is open the tab shows a fresh code automatically (after expiry, use or 5 failed
attempts). The relay makes the codes and sends them to the tab; the tab asks for them only
while the dialog is open. After success the tab shows "<client> connected" with a
Disconnect button. Someone who knows the address but cannot see the tab cannot pair.

## DEC-029: Access token plus rotating refresh token, bound to the address (owner)

Access tokens live 1 hour. Refresh tokens live 30 days; every refresh issues a new refresh
token (valid 30 days from then) and invalidates the old one; presenting an already used
refresh token revokes the whole grant (RFC 9700 reuse detection). Grants and tokens are
bound to the stable address (DEC-027), not to one WebSocket, so a connection survives page
reloads and relay restarts. While the tab is offline, MCP calls with a valid token fail with
a clear "the page is not open" error (HTTP 503, JSON-RPC error). Disconnect in the tab
revokes the grant at once. Tokens are stored only as SHA-256 hashes. Supersedes DEC-008 and
DEC-016.

## DEC-030: `TokenStore` interface with SQLite and memory built in (owner)

Tokens and grants go through a small, documented `TokenStore` interface with a reusable
conformance test suite that other implementations can run. Built in: `sqlite` via
`bun:sqlite` (the default; path configurable, e.g. `TAB_MCP_SQLITE_PATH=/data/tab-mcp.db`)
and `memory`. The relay binary and Docker image pick by configuration (`TAB_MCP_STORE`);
library users pass their own (`createRelay({ store })`), e.g. Prisma, Redis or libSQL. The
interface is asynchronous so such stores fit. Its exact shape is DEC-041.

## DEC-031: The OAuth authorization server is ours, without an OAuth library (owner)

Confirms DEC-015: bending a general OAuth library to CIMD-only, pairing codes and
address-bound grants gives no benefit. Mandatory: tests that follow the specifications
(RFC 6749, 7636, 8414, 9728, 9207, 7009, 8707, the CIMD draft and the MCP authorization
pages), conformance runs against panva's `oauth4webapi` and the MCP SDK client, and a
separate security review of the OAuth iteration before it merges.

## DEC-032: Tab origins are closed by default (owner)

The relay accepts tab WebSockets only from configured origins; the default list is empty,
which admits nobody. An open relay needs an explicit setting (`TAB_MCP_ALLOWED_ORIGINS=*`)
and logs a warning at start. The owner's hosted relay allows exactly `https://ractive.ch`
(browsers send only the origin, not the path, so a path cannot be allowed). The calculator
example runs against a local relay (`docker run ractive/tab-mcp`), not the hosted one.

## DEC-033: MCP 2026-07-28 only, CIMD only, one Claude header case (owner)

Confirms DEC-005, DEC-006 and DEC-019: only the stateless 2026-07-28 revision, no legacy
path, no dynamic client registration. VS Code/Copilot, Cursor, Gemini CLI and default Codex
are knowingly unsupported until they catch up; the compatibility matrix tracks them. The
relay accepts exactly Claude's mismatched header case (`MCP-Protocol-Version: 2025-11-25`
with a 2026-07-28 body) until Claude fixes it.

## DEC-034: Limits (owner)

300 s per MCP request with keep-alives throughout (DEC-039), 60 min idle (no MCP request)
per tab session, 12 h WebSocket session lifetime, 5 sessions per IP, 1 MiB per message and
request body. All configurable.

## DEC-035: Browser library loads the heavy part on demand (owner)

A small core is loaded eagerly (the `registerTool` registry, events, the pairing state);
the heavy part (MCP handler, connection) is loaded by `connect()` through a dynamic
`import()`, so pages pay nothing until the user connects. At the start of iteration 2,
measure what makes up the SDK's ~82 KB gzipped; if it is mostly unused features and Zod,
write the tab-side stateless subset ourselves (`server/discover`, `tools/list`,
`tools/call`, errors) and keep the SDK client only in tests for conformance. The SDK is
Apache-2.0, which is acceptable; its notice ships with any bundle that contains it. Amends
DEC-013.

## DEC-036: CORS without credentials (owner)

The metadata endpoints, `/token`, `/revoke` and the MCP endpoint answer CORS requests from
any origin without credentials (`Access-Control-Allow-Origin: *`, no cookies), so
browser-based MCP clients work. Configurable off (`TAB_MCP_CORS=off`). Tokens are never
ambient (bearer header only), so a foreign origin gains nothing it could not do from a
server.

## DEC-037: Distribution details (owner)

The image is also published to ghcr.io (confirms DEC-026). Dependency updates with
Dependabot. The Claude Code end-to-end run is local only (it needs a Claude login).

## DEC-038: Connecting your AI to a page means trusting the page (owner)

`SECURITY.md` and the threat model say plainly: connecting an AI app to a page means
trusting that page like any MCP server; a page can describe its tools in misleading ways.
The closed origin list (DEC-032) keeps other sites from using a hosted relay's domain to
look trustworthy.

## DEC-039: The relay starts the event stream itself after 20 s

DEC-034 wants keep-alives throughout a 300 s request, and CDNs drop requests without
response headers after 60 s. If the tab has not started its response within 20 s, the
relay answers the AI app with `200 text/event-stream` itself and writes `: keep-alive`
comments every 20 s. A later complete `http.response` from the tab is sent as one SSE
`message` event (its JSON-RPC body unchanged); a later streamed response continues on the
same stream. Notifications (no JSON-RPC `id`) are never switched. Allowed because every
client must accept `text/event-stream`. The tab's own SSE for `tools/call` (DEC-020) stays.

## DEC-040: Order of checks on the MCP endpoint

With stable, hash-derived addresses the relay cannot tell an unknown address from one whose
tab is offline. Order: method (405) → `MCP-Protocol-Version` pre-check (400 / `-32022`,
with the DEC-033 exception) → body size and JSON → bearer token valid for this address
(401) → tab online (503 "the page is not open") → concurrency limit (429) → forward. No 404
for unknown addresses, so addresses cannot be probed. Supersedes DEC-018.

## DEC-041: Shape of the `TokenStore`

Asynchronous methods over token records (`hash`, `kind` access or refresh, `grantId`,
`addressId`, `clientId`, `clientName`, `scopes`, `issuedAt`, `expiresAt`, `usedAt`):
`put`, `get`, `revoke({ grantId } | { addressId })` (deletes all tokens of a grant or
address), `deleteExpired(now)` as the owner named them, plus `markUsed(hash, now)`, an
atomic "use once" that refresh rotation needs so two concurrent refreshes cannot both
succeed, and `listGrants(addressId, now)`, which lets the tab show the connected apps after
a reload. Times are milliseconds since the epoch. The conformance suite is exported as
`@ractive-ch/tab-mcp/testing` (`tokenStoreConformance(name, factory)`, `bun:test`).

## DEC-042: Pairing is a replaceable method; identity binding planned for 0.2+ (owner)

The step at `/authorize` that proves the browser belongs to the tab's user is a pairing
method behind a small interface in the authorization server. Version 0.1 has one method,
the 6-digit code (DEC-028). Planned for 0.2+: identity binding, where the relay connects an
AI app to a tab only if both are signed in as the same person at the same OpenID Connect
provider ([design](/design/identity-binding.md),
[iteration 7](/iterations/iteration-7-identity-binding.md),
[research needed](/research/identity-binding-research-needed.md)). Building pairing as an
interface in iteration 3 lets that extension fit without rebuilding the OAuth server.

# Citations

- [MCP 2026-07-28 research](/research/mcp-2026-07-28-spec.md)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
- [AI app support research](/research/ai-app-support.md)
- [Bun runtime and publishing research](/research/bun-runtime-and-publishing.md)
- [bunny.net research](/research/bunny-magic-containers.md)
- [WebMCP registerTool](/research/webmcp-register-tool.md)
