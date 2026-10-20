---
type: decision-log
title: "Decision log"
description: Decisions for tab-mcp with their reasons, newest last. Owner decisions are marked as such and are not reopened.
tags:
  - decisions
timestamp: 2026-10-20T07:10:00+02:00
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

**Replaced for the tab by DEC-049** after the measurement: the tab runs its own subset.

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
WebSocket): "You're connecting Claude (claude.ai) to tools from `https://ractive.ch`"
(extended with the page's app name by DEC-045). The
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
tab is offline. Order: method (405) → body size and JSON (413 / 400; the version check
needs the body for `initialize` and the DEC-033 exception) → `MCP-Protocol-Version`
pre-check (400 / `-32022`, `-32020` when the header is missing) → bearer token valid for
this address (401) → tab online (503 "the page is not open") → concurrency limit (429) →
forward. Implemented in iteration 1. No 404
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

## DEC-043: The hosted relay is infrastructure as code with OpenTofu (owner)

The owner's relay on bunny.net is managed with OpenTofu (preferred to Terraform for an
open-source project) and the official `BunnyWay/bunnynet` provider
(`bunnynet_compute_container_app`, `bunnynet_compute_container_imageregistry`, plus pull
zone and DNS records as needed). The bunny account is shared with other projects: OpenTofu
manages only its own state, every resource name starts with `tab-mcp-`, and shared
resources are never managed (single DNS records, not a shared zone). The bunny API key
lives only in the GitHub Actions secret `BUNNY_API_KEY`, set by the owner with
`gh secret set`, never on a developer machine. `plan` runs on pull requests, `apply` on main
or by manual dispatch. The remote state backend (HCP Terraform free tier, an S3-compatible
bucket, or encrypted state in GitHub) is chosen in
[iteration 6](/iterations/iteration-6-deployment-bunny.md); the state may contain secrets.

**Backend decided in DEC-044** (bunny storage zone over S3, encrypted on the client).

## DEC-044: OpenTofu state in a bunny storage zone, encrypted on the client (owner)

The state backend for DEC-043 is a bunny.net storage zone (e.g. `tab-mcp-tfstate`, region
`de`) through its S3-compatible API. S3 compatibility must be enabled when the zone is
created and cannot be added later; the owner creates the zone. Bunny's S3 API is a
preview/beta and its documentation disagrees on the URL style (path-style; virtual-hosted
per newer pages), so the backend needs a custom endpoint, path-style addressing and the
AWS-specific validations skipped. Whether bunny supports the S3 conditional writes that
OpenTofu's native locking (`use_lockfile`) needs is unknown and is tested with a throwaway
state; the fallback is that only the GitHub workflow runs `apply`, serialised by a workflow
`concurrency` group. OpenTofu's client-side state encryption (passphrase in a GitHub
secret) means the zone holds only ciphertext; this is one more reason for OpenTofu over
Terraform. Secrets, all GitHub Actions secrets set by the owner: `BUNNY_API_KEY`, the
storage zone's S3 access key and secret, `TOFU_STATE_PASSPHRASE`. Settles the backend
question left open in DEC-043.

## DEC-045: One relay serves several sites; configuration per origin (owner)

One hosted relay instance can serve several projects on ractive.ch.

1. **App name.** The tab sends an app name when connecting (e.g. `saturnus`, in `hello`).
   The relay's `/authorize` page shows "You're connecting <client> to <app name> on
   <origin>". The name is self-declared by the page and not verified; the origin is.
   Within one's own origin that is acceptable (the threat model says so).
2. **Sites.** Relay configuration becomes per origin, not only per instance: a list of
   sites `{ origin, name?, pairing: "code" | "oidc", limits overrides }` with
   instance-wide defaults. The origin allow-list is the list of configured sites; an empty
   list admits nobody (DEC-032 still holds; `*` stays the explicit open-relay setting).
   A configured `name` takes precedence over the name the page sends.

(2) is built in [iteration 3](/iterations/iteration-3-oauth.md), because the site's
`pairing` choice shapes the pairing-method interface (DEC-042); (1) is sent by the client
from [iteration 2](/iterations/iteration-2-client-library.md) and shown from iteration 3.
A project with stricter requirements (own limits it cannot share, own operator, separate
logs or store) gets its own relay instance instead ([iteration 6](/iterations/iteration-6-deployment-bunny.md)).

## DEC-046: Deployments live outside this repository (owner)

The open-source repository holds no deployment secrets and no owner
infrastructure. The owner's hosted relay for `https://ractive.ch` is deployed
from the private repository `ractive/ractive.ch` (`infra/relay/`, OpenTofu,
state in the bunny storage zone `ractive-ch-terraform-state`), which may later manage
more of ractive.ch on bunny.net. This project's release secrets (Docker Hub;
npm via OIDC) stay here. Supersedes the owner-instance parts of DEC-043 and
DEC-044; iteration 6 becomes generic, secret-free deployment docs and
examples. Reason: one operator's secrets and infrastructure do not belong in a
public, reusable project.

## DEC-047: Escaped errors are logged; rejections keep the relay running

The relay handles errors per tab message and per request (a bad tab response fails only
its request with 502 / `-31007`). As defence in depth, `installCrashLogging` in the
`tab-mcp` binary logs anything that still escapes, never silently: an unhandled promise
rejection is logged (`process.unhandled_rejection`) and the relay keeps running, so one
bad request or tab cannot end every other session; an uncaught exception is logged
(`process.uncaught_exception`) and the process exits with 1, because its state may be
inconsistent; the supervisor restarts it and AI apps keep their tokens (they live in the
store). Only the error's name is logged, since messages can carry request data. From the
review of PR #1.

## DEC-048: A deadline for reading MCP request bodies

Bun 1.4.3's `idleTimeout` does not fire while a handler waits for an unfinished request
body (checked with `arrayBuffer()` and a stream reader), so a client that stalls mid-body
would hold a socket forever. The relay reads bodies with its own deadline
(`TAB_MCP_BODY_TIMEOUT_S`, default 10 s) and answers 408 with `Connection: close`, which
makes Bun close the socket. `server.timeout(req, 0)` (switching Bun's idle timer off) runs
only right before an authenticated request is forwarded. From the review of PR #1.

## DEC-049: The tab runs its own stateless MCP subset; the SDK stays in tests

Measured at the start of iteration 2, as DEC-035 asks (`scripts/measure-sdk.ts` in the
client package repeats it): a browser bundle of `createMcpHandler` + `McpServer` +
`fromJsonSchema` from `@modelcontextprotocol/server` 2.3.1 is 309.5 KiB minified and
81.3 KiB gzipped. By package (minified): the server package 194 KiB (63 %), zod 4 99 KiB
(32 %), `@modelcontextprotocol/core` 16 KiB (5 %, OAuth metadata and error schemas the tab
never uses). Inside the server package: zod schemas for two protocol revisions (the
2025-11-25 legacy set is the larger), the `Protocol` engine, the era-classification ladder,
`McpServer`/`Server`, the web-standard transport and `createMcpHandler`, MRTR, completions,
bearer-auth and OAuth-metadata middleware, and an inlined `@cfworker/json-schema` (22 KiB
minified, 5.9 KiB gzipped). The tab needs `server/discover`, `tools/list`, `tools/call`,
`subscriptions/listen`, the request checks and argument validation: mostly unused features
and zod, the case DEC-035 names.

Decision: the tab-side subset is ours (`packages/tab-mcp-client/src/mcp.ts`), with
`@cfworker/json-schema` 4.1.1 (MIT, the validator the SDK itself uses in browsers) for
arguments. Sizes now: core 3.8 KiB gzipped (with the page), connection chunk 11.5 KiB
gzipped including the validator (on `connect()`), default UI 2.3 KiB gzipped (when a
dialog opens), instead of 81 KiB plus the core. No Apache-2.0 SDK code ships, so no NOTICE.
Conformance: a test sends 36 requests (every rung of the 2026-07-28 check ladder,
discover, list, call, errors, notifications, batches, posted responses, a base64 `Mcp-Name`)
to our handler and to the SDK's `createMcpHandler(…, { legacy: "reject" })` and requires
the same HTTP status, JSON-RPC error code and result shape; the SDK `Client` pinned to
2026-07-28 calls tools end to end through the relay. Re-run both when the SDK or the spec
changes. Kept from the SDK's behaviour: `ttlMs: 0` and `cacheScope: "private"` on
`server/discover` and `tools/list` (the research note's 60 s would leave AI apps without a
listen stream on a stale list), `ping` answered 404 / `-32601` (gone in 2026-07-28), an
unknown tool `-32602` in band, failed argument validation an `isError` result,
`tools/call` always as SSE and the rest as JSON. Tools must not use `x-mcp-header`
(registration refuses it). Replaces the tab half of DEC-013; the relay is unaffected
(DEC-014).

## DEC-050: No reconnect by the library; `connect({ resume: true })` for "Keep AI access on"

The library never reconnects by itself (plan, protocol). `connect()` refuses to run
without transient user activation where the browser tracks it
(`navigator.userActivation`), so a session starts from a click (DEC-009). Whether AI
access survives a reload or a dropped connection is the page's choice: a page that offers
something like "Keep AI access on" (turned on by the user with a click) calls
`connect({ resume: true })` on load or after `disconnected`, which skips the activation
check. The check is a guard against accidental connects, not a security boundary: a page
can always open a WebSocket itself. Events for the page: `statechange`, `connected`,
`disconnected` (with a reason from the bye or close code: `user`, `new_address`,
`replaced`, `expired`, `idle`, `shutdown`, `heartbeat`, `policy`, `too_large`,
`rate_limited`, `closed`, `network`), `replaced`, `error`, `pairingcode`, `grantschange`,
`toolschange`. `disconnect()` and `newAddress()` report `disconnected` at once and ignore
late callbacks of the old connection.

## DEC-051: Registration rules beyond WebMCP

`registerTool` returns a promise, as in the WebMCP draft: it rejects with a `TypeError`
for an invalid tool and an `InvalidStateError` for a duplicate name, and the tool is
registered before it resolves. `inputSchema` must have `"type": "object"` (MCP requires an
object schema; WebMCP does not say), is copied at registration, and may not use
`x-mcp-header` (DEC-049). Registration also refuses what the validator (loaded only on
`connect()`) would throw on later: a `pattern` that is not a regular expression and a
`$ref` that does not resolve inside the schema; should anything still fail outside the
tool, the call answers `-32603`, and a result that is not JSON becomes an `isError` result. Only boolean annotations are kept. `execute(input, { signal,
client })` gets the caller (grant id, client id, verified host, declared name when the
grant is known) besides WebMCP's signal. Several registrations in one task produce one
`notifications/tools/list_changed`.

## DEC-052: The address secret is kept per relay; plain-text relays only on loopback

The secret's storage key is `tab-mcp:secret:<relay origin>` (overridable with
`storageKey`), so a page that talks to two relays never sends one relay's secret to the
other, whose operator could otherwise take over the address there. The library refuses
`http:`/`ws:` relay URLs except for `localhost`, `127.0.0.1` and `[::1]`, because the
secret travels in `hello`. `storage: null` keeps the secret for the page's lifetime;
storage that throws (blocked, quota) falls back to that silently. The secret is read from
storage on every connect, so a rotation in another tab is seen.

## DEC-053: The npm package is built into `dist/` with its own `package.json`

The workspace keeps `exports` pointing at `src/` (tests, the example and type checks run
without a build). `bun run build` in the client package (`scripts/build.ts`) writes the
publishable directory `dist/`: ESM for bundlers with `@cfworker/json-schema` external and
the core, connection and UI as separate chunks; a minified, self-contained CDN build in
`dist/cdn/` (`exports["./cdn"]`); declarations from TypeScript 7 `tsc` with
`isolatedDeclarations` (their `.ts` specifiers rewritten to `.js`); and a generated
`package.json`, LICENSE and AI_NOTICE. Iteration 5 packs and publishes `dist/` (DEC-024).
A test builds it and type-checks a consumer file against the declarations.

## DEC-054: Default confirmation and dialogs

A consequential tool is confirmed after its arguments are validated, so the user is never
asked about a call that would fail. Without `onConfirm` and without a `document` the call
is declined. The default confirmation focuses "Don't allow", names the client by its
declared name and verified host, shows the arguments in full in a scrolling box (hidden
when there are none; if they could not be shown, Allow is not offered), keeps "Allow"
disabled for 750 ms after it opens (`confirmDelayMs`, never below 500 ms) so a click meant
for the page cannot approve, and closes itself when the call is cancelled. `revoke()`
returns `false` while not connected (only the relay can revoke); the connect dialog then
disables its Disconnect buttons and says to connect the page again first. Chunks of
streamed bodies are sized from the relay's `maxMessageBytes` (512 bytes of envelope, 6
bytes per UTF-16 unit at worst); below 896 bytes the library refuses the session. Both dialogs are `<dialog>` elements opened
with `showModal()` (Escape closes them), built with `textContent` only, styled through
CSSOM with `--tab-mcp-*` custom properties (no inline `style` attributes, so a strict CSP
needs no exception). The connect dialog shows `session.appName`, else the page's own
`appName`, until iteration 3 makes the relay send it; its code line stays hidden until the
relay sends a code. Tests pass a happy-dom `document` instead of registering DOM globals,
because the relay's tests share the process; the browser test needs Chrome (required when
`CI` is set, skipped otherwise).

## DEC-055: Release tags per package, dist-tags from the version, one release workflow

Each package is released on its own: a GitHub release with the tag `client-v<version>`
publishes `@ractive-ch/tab-mcp-client`; the relay will use `relay-v<version>` (npm and the
Docker image). The tag must equal the version in the package's `package.json`, and the
GitHub release must be marked as a pre-release exactly when the version is one. The npm
dist-tag comes from the version: `alpha`, `beta` or `rc` for a pre-release named so
(`0.1.0-alpha.0` → `alpha`; other pre-release names are refused), `latest` only for a stable
version. The first version is `0.1.0-alpha.0`. The source `package.json` is `private` so it
cannot be published by mistake; the build writes the published one into `dist/` (DEC-053).

One workflow, `.github/workflows/release.yml`, does the dry run on pull requests, the
bootstrap and the release, so they cannot drift apart (GitHub also only dispatches a
workflow it already knows). A job without an OIDC token builds, tests, packs and checks the
tarball (`scripts/npm-pack.ts`: file list, manifest, exact repository URL, exact dependency
versions), dry-runs the publication and installs the tarball into an empty project; only
the signing job (bootstrap) and the publishing job (environment `release`) get
`id-token: write`, and both use that same tarball. The bootstrap signs it with npm's own
provenance code (`scripts/npm-provenance.mjs`) for the owner's first manual upload; after
that, npm trusted publishing (repository `ractive/tab-mcp`, workflow `release.yml`,
environment `release`) publishes with `npm publish --provenance`. A version that is already
on npm is skipped when the downloaded tarball's own hash matches and fails the job
otherwise; a stable version below the current `latest` is refused. npm is pinned (12.2.0)
because the signing step loads npm's internal modules.

Bootstrap runs only on `main`; bootstrap and publish refuse a commit that is not on `main`.
These checks catch mistakes; the guard against a tag on an unreviewed commit (whose own
workflow file would run) is that only the owner may create release tags (tag ruleset) and
the `release` environment accepts release tags only and needs the owner's approval. The
owner's `verify` before the manual upload accepts only bundles signed by `release.yml` of
`ractive/tab-mcp` on `main` or on the version's tag. `latest` stays on `0.1.0-alpha.0`
(the registry sets it on a package's first publication and never removes it) until the
first stable version; the owner may move it by hand with `npm dist-tag add`. Steps:
[npm publishing](/operations/npm-publishing.md).

## DEC-056: Sites as JSON, allowed origins as shorthand, a floor for message sizes

Sites (DEC-045) are configured with `TAB_MCP_SITES`, a JSON array in the same shape as
`createRelay({ sites })`: `{ origin, name?, pairing?, limits? }`, where `limits` may set
`maxMessageBytes`, `maxConcurrentRequests`, `requestTimeoutMs`, `keepAliveMs`,
`idleTimeoutMs`, `sessionLifetimeMs` and `heartbeatMs` in the units of the
configuration (milliseconds, bytes). Unknown keys are refused at start, so a typo is not
silently ignored. `TAB_MCP_ALLOWED_ORIGINS` stays as the short form for sites without
overrides; an origin may appear in only one of the two. With `*`, configured sites keep
their settings and every other origin gets the instance defaults. `pairing: "oidc"` is
refused at start until identity binding exists (iteration 7), rather than accepted and
then failing at `/authorize`. A JSON variable was chosen over a config file: one more
environment variable fits Docker and bunny.net without a volume, and a file can be added
later. `maxMessageBytes` must be at least 16 KiB, for the instance and every site: MCP
requests need room, and the browser library refuses sessions below 896 bytes (found in
the review of PR #2). The page's `hello.app.name` must be 1-64 characters without
control characters, else the relay closes the session (`bad_message`); the library
refuses such a name in its constructor, so a page cannot trip over it.

## DEC-057: The /authorize form: a pending request, Bun.CSRF and a cookie, no scripts

A valid authorization request becomes a pending request kept in memory for 10 minutes;
the form posts only its random id, the pairing fields and a CSRF token. The token is
`Bun.CSRF.generate` bound (`sessionId`) to the pending request and to a random visit id
in a first-party cookie (`__Host-tab-mcp-authorize` on https; `HttpOnly`,
`SameSite=Lax`), so only the browser that opened the page can submit it. Posts with an
`Origin` other than the relay or `Sec-Fetch-Site` other than `same-origin` are refused
as well. This adds little against an attacker typing guesses (the attempt limits do
that) but closes cross-site form posts as a class. The page has no JavaScript:
`default-src 'none'; style-src 'self'` with the stylesheet at `/authorize.css`,
`frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`
(not `no-referrer`: with it, Firefox and Chrome send `Origin: null` on the form post, found
in a headless Firefox run), `Cache-Control: no-store`, and `form-action 'self'` plus the client's redirect origin
(Chrome applies `form-action` to the redirect after the post). No
`Cross-Origin-Opener-Policy`: claude.ai opens `/authorize` in a popup and needs the
opener back on its callback page. Errors before the redirect URI is trusted (bad client
id, document or redirect URI) are shown on the page; all later errors go back to the
client with `error`, `state` and `iss`.

## DEC-058: Token endpoint rules

- Scope: the only scope is `tools`. A request without `scope`, or with `tools` among
  other values (e.g. `offline_access`), is granted `tools`, and the token response always
  names the granted scope; a request with none of the known scopes gets `invalid_scope`.
- An authorization code is burnt by its first presentation, even if a check then fails
  (wrong verifier, redirect URI, client), so the verifier cannot be guessed against one
  code. A code presented again revokes the grant made with it (RFC 6749 §4.1.2).
- A refresh token presented a second time revokes the whole grant (DEC-029). That includes
  the loser of two concurrent refreshes with the same token: `markUsed` lets exactly one
  win, and the other counts as reuse. A client that refreshes twice in parallel thus loses
  its connection; the alternative (a grace period) would also let a thief who races the
  victim keep a token.
- A refresh token presented with another `client_id` is refused without revoking (the
  presenter is not the client; the grant stays usable for its owner).
- `/revoke` with either token ends the whole grant: the grant is the connection the page
  lists. A token of another client is refused with `invalid_client` (RFC 7009 §2.1); an
  unknown token gets 200 (§2.2).
- Client authentication is `none` only: a `client_secret`, a client assertion or an
  `Authorization` header gets `invalid_client` (401 with `WWW-Authenticate` for the
  header, RFC 6749 §5.2).
- The rate limit (30 requests, then 1 per second per IP) answers 429 with
  `temporarily_unavailable` and `Retry-After`.

## DEC-059: Client ID Metadata Document details

The `client_id` must be its own canonical URL (`new URL(id).href === id`), which refuses
dot segments, upper-case hosts, an explicit default port and other aliases without
special cases; it needs `https:`, a path, the default port, no credentials or fragment.
IP literals and every address the host resolves to must be public. The document needs
`client_id` equal to the URL, `client_name` and 1-20 `redirect_uris` (absolute, no
fragment, not `javascript:`/`data:`); `token_endpoint_auth_method` absent or `none`; no
`client_secret`; `grant_types` and `response_types`, if present, allow the code flow.
Caching: `max-age` clamped to 5 minutes-24 hours, `no-store`/`no-cache` 5 minutes, no
header 1 hour; at most 1000 documents. Fetches per host: 5, then 1 every 5 s. The name
shown is cleaned (control and bidi characters become spaces, whitespace collapsed, at
most 64 characters). The test-only switch that lets the fetcher reach a local HTTPS
fixture (loopback hosts, any port, `http:`, an extra CA) is reachable only through
`createTestRelay`, which the package does not export (its `exports` map blocks deep
imports), refuses to run without `development: true` and logs `relay.test_hooks`; no
environment variable or `createRelay` option turns it on.

## DEC-060: Pairing attempt limits and code behaviour

Besides the 5 attempts per code (DEC-028), pairing attempts are limited per address (10,
then 1 every 30 s) and per IP (20, then 1 every 10 s); page loads per IP (30, then 1
every 2 s). With an attacker who can keep the dialog's codes coming, the per-address
limit bounds the chance of a guessed code to about 2 880 guesses a day out of a million
codes (0.3 % a day while the dialog stays open). Input that is not 6 digits (spaces and a
dash are allowed) is answered without counting an attempt. A code typed after it expired
gets "That code has expired" (it counts as an attempt on the new code). A second
`pairing.start` while codes are on repeats the current code instead of replacing it, so
two dialogs show the same code. Codes are compared in constant time and never logged.
Codes come only while the tab has sent `pairing.start`; `/authorize` explains that the
code is shown in the page's "Connect your AI tool" dialog.

**Limits replaced by DEC-061** (security review of PR #4: the per-address limit was
charged for every post, so anyone who knew an address could lock its owner out).

## DEC-061: Only real guesses count; per-IP limits by /64; open requests capped

From the security review of PR #4. Replaces the limits of DEC-060.

- A pairing method is given an `admit()` callback and calls it right before judging an
  answer that could be right: for the code method, a well-formed 6-digit code while a code
  is active. Malformed input, an empty field, junk and a closed dialog are answered
  without charging anything. `admit()` charges two buckets: per address and network (10
  guesses, then 1 a minute) and per address overall (30, then 1 every 30 s). One network
  can therefore never use up an address's allowance alone; the overall bucket keeps the
  brute-force bound (about 2 880 guesses a day per address against a million codes, and
  only while the page's dialog is open). An attacker with many networks can still exhaust
  the overall bucket and keep the owner waiting; the page then says so and points to
  "New address" in the page, which the attacker does not learn. Availability against a
  distributed attacker is traded for the brute-force bound on purpose.
- Every per-IP limit (tab sessions, `/authorize` page loads and posts, guesses, `/token`,
  `/revoke`) counts an IPv4 address as is (/32: many users already share one behind NAT
  or CGNAT, a /24 would group strangers) and an IPv6 address by its /64, which one
  subscriber usually gets whole.
- No pending authorization is kept for an address without a connected tab: the "Open
  the page first" page reloads the same request (Try again) or links back with
  `access_denied` (Cancel). At most 10 pending requests per network and 20 per address
  are open; more are refused with 429 instead of evicting others' requests. Requests all
  live 10 minutes, so the map's insertion order is expiry order and sweeps stop at the
  first live one. CIMD fetches are also limited all together (30, then 1 a second), so
  many attacker-owned hosts do not add up.

## DEC-062: A grant ends 90 days after pairing at the latest

From the security review of PR #4: with only the sliding 30 days of DEC-029, a stolen
refresh token that is used once a month never expires. Refreshes still slide by 30 days
as DEC-029 says, but no token outlives `grantCreatedAt + grantLifetimeMs`
(`TAB_MCP_GRANT_LIFETIME_S`, default 90 days); access tokens and `expires_in` are capped
the same way. 90 days rather than the 30 the review suggested: a 30-day absolute end
would turn DEC-029's "valid 30 days from then" into a fixed monthly re-pairing, which
changes an owner decision; 90 days bounds a theft to one quarter while a used connection
asks for the code at most four times a year. The owner can shorten it by configuration.

## DEC-063: Revocation leaves a tombstone; put refuses revoked grants

From the security review of PR #4: with an asynchronous store, a refresh or code
exchange could store new tokens after Disconnect had deleted the grant's tokens. Amends
DEC-041: `revoke(selector, { now, keepUntil })` deletes the tokens and records a tombstone
(for a grant, or for an address with the revocation time); `put` returns `false` and
stores nothing for a record of a tombstoned grant, or of a grant of a tombstoned address
created at or before the revocation. Check and insert are atomic (a SQLite transaction;
synchronous in memory), so whichever runs first, no token survives the revocation. The
relay keeps tombstones for the grant lifetime (DEC-062), the longest any earlier token
could live; `deleteExpired` drops them afterwards. A refused `put` ends the token
request with `invalid_grant`. The conformance suite checks all of this; custom stores
must implement it (`put` now returns a boolean, so they fail to type-check until they do).

## DEC-064: Invalid requests are shown, not redirected

From the security review of PR #4 (RFC 9700 §4.11.2): anyone can publish a client
document with their own redirect URI, so redirecting every invalid request there would
make the relay an open redirector. Amends DEC-057: after the redirect URI is trusted,
an invalid request (wrong response type, missing PKCE, wrong resource or scope, repeated
parameters) shows a relay page that names the client's host and links back with
`error`, `state` and `iss`. Only the user's own Cancel redirects at once
(`access_denied`). No allow-list exception: one rule is easier to reason about.

## DEC-065: Names without invisible characters; the verified host always beside them

From the security review of PR #4. Amends DEC-059: the shown client name drops all format
characters (`Cf`: zero-width, bidi, word joiner, BOM, soft hyphen) and other invisible
characters (Hangul fillers, braille blank), turns controls and line separators into
spaces, and is refused if it contains a web address in parentheses (e.g. "Claude
(claude.ai)", which would read like the verified host). The page's heading and title are
"Connect <name> from <verified host>".

## DEC-066: CIMD fetches are pinned to the vetted address

From the security review of PR #4 (DNS rebinding, threat model A3). Bun's `fetch`
accepts `tls.serverName`, so the relay connects to the address that passed the SSRF
check (IPv4 first) and sends the original `Host` and TLS server name; the certificate is
still checked against the host name. A second DNS answer is never used. All failures
from resolving to parsing (unresolvable, private address, redirect, status, type, size,
time-out, TLS, JSON) show one fixed message, "The AI app's details could not be loaded
from <host>.", with the reason only in the log; validation errors of a fetched (public)
document keep their specific messages.

## DEC-067: Redirect URIs: https, loopback http, reverse-domain native schemes

From the security review of PR #4. A client document's `redirect_uris` must be `https:`;
`http:` only on `localhost`, `127.0.0.1` or `[::1]` (RFC 8252 §7.3); or a private-use
scheme in reverse-domain form such as `com.example.app:/callback` (RFC 8252 §7.1), which
native apps need. One-word custom schemes, `file:`, `blob:`, `data:`, `javascript:`,
plain `http:` on other hosts and URIs with credentials or fragments are refused.

## DEC-068: The relay's npm package is `dist/` with three bundles and its own `package.json`

As DEC-053 for the client: the workspace keeps `bin` and `exports` on `src/`, and
`bun run build` in `packages/tab-mcp` (`scripts/build.ts`) writes the directory to pack.
`bun build --target=bun` makes `main.js` (the `tab-mcp` command, first line
`#!/usr/bin/env bun`), `index.js` and `testing.js`, one self-contained file each without
code splitting: the relay has no runtime dependencies and `bun:*` stays an import, so no
chunks and no hashed file names. Because `dist/` is the package root, the published `bin`
is `./main.js` (the plan's `dist/main.js` seen from the workspace). Declarations come from
`tsc` with `isolatedDeclarations` (a few defaulted parameters and fields got explicit
types for it); `main.d.ts` is dropped. The relay reads only `version` from its
`package.json` (a named JSON import), so the bundles do not carry the whole file. The
source `package.json` is now `private` with version `0.1.0-alpha.0`, the first relay
release (`relay-v0.1.0-alpha.0`, dist-tag `alpha`). There is no package README yet; the
documentation part of iteration 5 adds it and its entry in `scripts/npm-pack.ts`.

## DEC-069: The image is built on the build platform and pushed after npm

The Dockerfile's build stage runs on `$BUILDPLATFORM` (its output is JavaScript), the
runtime stage only copies files, so both architectures build without emulation. Base
images are pinned by tag and digest. The runtime runs as uid/gid 65532 with `/data`
(owned by 65532, a volume) holding the SQLite store; no `HEALTHCHECK` (the plan's choice:
platforms probe `GET /healthz`). Image tags: `X.Y.Z` always, `X.Y` and `latest` only for a
stable version, so a pre-release never moves them. In `release.yml` the image job builds
both architectures without pushing on every pull request and dry run, then loads the amd64
image and runs `scripts/docker-smoke.ts` (health and version, non-root, store in `/data`
surviving a restart, a tab gets a session and its address answers 401 with resource
metadata, foreign origins refused, prompt stop on SIGTERM). The npm publication of the
relay waits for that job, and the push (environment `release`, Docker Hub and ghcr.io,
provenance `mode=max` and SBOM) waits for the npm publication, so a version npm refuses
(wrong tag, `latest` backwards) is never pushed as an image. No build cache is used: the
build takes seconds and a shared cache could carry pull-request content into a release.

## DEC-070: The token-expiry check fails a monthly run; the release only warns

`scripts/token-expiry.ts` reads `DOCKERHUB_TOKEN_EXPIRES` (the day the token stops
working). The monthly workflow `token-expiry.yml` fails when the date is 30 days away or
less, or missing or malformed; a failed scheduled run is GitHub's notification, so no issue
is opened. The release's image job runs the same check in warning mode: it must not block a
release for a token that still works, but fails once the token has expired, with the
renewal link, before the login fails with a less helpful message.

## DEC-071: Dependabot for bun, GitHub Actions and Docker; one Bun version everywhere

Weekly updates, minor and patch grouped per ecosystem, the two `oven/bun` stages grouped.
Exact pins stay exact (Dependabot replaces an exact version with the new exact version;
the `bun` ecosystem takes no `versioning-strategy`). A test (`scripts/docker.test.ts`)
requires the Dockerfile's base images and every Bun version in the workflows to equal
`@types/bun`, so a partial Bun update fails until all places follow.

# Citations

- [MCP 2026-07-28 research](/research/mcp-2026-07-28-spec.md)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
- [AI app support research](/research/ai-app-support.md)
- [Bun runtime and publishing research](/research/bun-runtime-and-publishing.md)
- [bunny.net research](/research/bunny-magic-containers.md)
- [WebMCP registerTool](/research/webmcp-register-tool.md)
