---
type: decision-log
title: "Decision log"
description: Decisions for tab-mcp with their reasons, newest last. Owner decisions are marked as such and are not reopened.
tags:
  - decisions
timestamp: 2026-10-25T12:00:00+02:00
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
Amended by DEC-080: live examples were published on ractive.ch (the calculator, removed again the same day).

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
platforms probe `GET /healthz`). Image tags: `X.Y.Z` always; a stable version gets
`latest` only when it is not below npm's `dist-tags.latest`, and `X.Y` only when it is the
highest stable `X.Y.*` on npm (`scripts/image-tags.mjs`, asked after the npm step, also
when that step skipped an identical version), so neither a pre-release nor a re-run of an
old release tag moves them. In `release.yml` the image job builds both architectures, with
provenance `mode=max` and SBOM, into one OCI archive on every pull request and dry run,
loads its amd64 image with `skopeo` (checking its layer diff IDs against the archive) and
runs `scripts/docker-smoke.ts` (health and version, non-root, store in `/data` surviving
a restart, a tab gets a session and its address answers 401 with resource metadata,
foreign origins refused, prompt stop on SIGTERM, and without `NODE_ENV=development` an
`http://` public URL is a configuration error), then uploads the archive with its
image-index digest. The npm publication of the relay waits for that job, and the push
(environment `release`, Docker Hub and ghcr.io) waits for the npm publication, so a
version npm refuses is never pushed as an image. The push does not rebuild: it copies the
archive with `skopeo copy --all --preserve-digests` (both platforms and the attestation
manifests, failing rather than re-encoding) and fails unless every pushed tag's index
digest equals the smoke-tested one, so the published bytes are the tested bytes,
attestations included. No build cache is used: the build takes seconds and a shared cache
could carry pull-request content into a release.

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

## DEC-072: Leave alpha: 0.1.0 is the first stable release of both packages

Owner decision (2026-10-20). The release after `0.1.0-alpha.1` is the stable `0.1.0` of
the relay `@ractive-ch/tab-mcp` and the client `@ractive-ch/tab-mcp-client`, not an
`alpha.2`. Both GitHub releases (`relay-v0.1.0`, `client-v0.1.0`) are normal releases, not
pre-releases, so the release workflow publishes with `npm publish --tag latest`: that moves
npm's `latest` off `0.1.0-alpha.0` (the "Known issue: latest" of DEC-055 ends). The relay
image gets `0.1.0` and, because the version is stable and not below npm's `latest`, also
`0.1` and `latest` (DEC-069, `scripts/image-tags.mjs`); later stable versions move them the
same way, pre-releases never do. The docs drop `@alpha` and pin `0.1.0`; a test
(`packages/tab-mcp-client/test/build.test.ts`) fails when a doc or plugin manifest names
any other package version or image tag. Until 1.0, a minor version may still change
settings, the protocol or the API.

## DEC-073: A grant ends 90 days after pairing at the latest

Owner decision (2026-10-21). `TAB_MCP_GRANT_LIFETIME_S` keeps its default of 7776000
(90 days), also on the hosted relay <https://tab-mcp.ractive.ch>: an AI app pairs again at
most every 90 days. Access tokens last 1 hour and refresh tokens 30 days, renewed on each
use; Disconnect in the page ends a grant at any time. Shorter would limit leaked tokens
further at the cost of pairing more often; 90 days is the usual order for OAuth
connectors.

## DEC-074: "The page is not open" is an HTTP 200 answer after a short wait

Iteration 8. Evidence: the owner's test on 2026-10-20 (hosted relay, CDN log, UTC).
claude.ai paired with saturnus on Firefox Android (18:29:01 `/authorize` 303, `/token`
200, four MCP POSTs 200 from UA "Claude-User"). At 18:30:09 a POST got 503
`page_not_open`: the phone had paused the tab when the owner switched apps. From then on
every call came as POST 400 then GET 405 (18:30:09/10, 18:30:11/12, 18:30:27, 18:31:36,
18:31:41, 18:32:08, …), also after the page had reconnected (`/tab` 101 at 18:30:30,
18:31:25, 18:34:40) and in split screen. The version check runs before the token check, so
the 400s are refused `initialize` requests and the 405 is the GET of the old HTTP+SSE
transport: Claude had fallen back to the legacy protocol and never came back.

The spec explains it. A dual-era client detects a server's era by inspecting a failed
request: a 4xx "without a recognized modern error body" means a legacy server, and the
client falls back to `initialize` and possibly to HTTP+SSE; it caches the era and
"re-probes if the cached assumption later fails" (Versioning, Backward Compatibility;
Streamable HTTP, Backward Compatibility). On stdio the probe is `server/discover` and
"any error that is not a recognized modern error" means legacy. `-31001` is not a modern
error code, so an HTTP error with it reads as "legacy server". Headless Claude Code 2.1.296
shows the same (local relay, the calculator, `claude -p`): with the page closed before the
run, the `server/discover` probe got 503 and Claude Code sent `initialize` 2025-11-25 at
once and failed to connect; with the page closed after a first `tools/call`, every 503
counted as "HTTP connection dropped". After this change it stays on 2026-07-28 and the
model gets the text. Claude Code also gives up on the discover probe after 5 s and then
reconnects pinned to the legacy protocol.

Decision:

1. **Wait first.** A request with a valid token whose page is not open waits up to
   `TAB_MCP_PAGE_WAIT_S` (default 10 s, at most 60, 0 = off) for the page's session and
   is forwarded if it comes. The wait ends when the AI app closes the request or the relay
   stops. At most `maxConcurrentRequests` requests wait per address and `maxSessions` in
   all (a waiting request holds its body and a socket like a forwarded one); beyond that
   the relay answers at once. `server/discover` never waits, because of the probe timeout.
2. **Answer at HTTP 200.** Then the relay answers with HTTP 200 and a JSON-RPC message, by
   method:
   - `tools/call`: a tool result with `isError: true` and the text "The page is not open,
     or not in front. Ask the user to open *name* and keep it in front (on a phone, in
     split screen), then try again." (*name*: the site's or page's app name from the
     address's last session, else "the web page"). The Tools spec says tool execution
     errors are what clients SHOULD pass to the model; protocol errors only MAY be.
   - `server/discover`: a stand-in result (`supportedVersions: ["2026-07-28"]`,
     `capabilities: {tools: {listChanged: true}}`, the same text as `instructions`,
     `ttlMs: 0`, `cacheScope: "private"`, `serverInfo` `tab-mcp`). It is the era probe, so
     it must succeed; `ttlMs: 0` makes the result immediately stale, and the capabilities
     are what the client library declares.
   - everything else, `tools/list` and `subscriptions/listen` included: a JSON-RPC error
     `-31001` with the same text. Not an empty `tools/list`: per the Caching spec, clients
     "MAY serve stale responses if errors occur during re-fetching", so an error keeps the
     tools the app already knows, while an empty list would replace them, and a
     `list_changed` to undo it may never come. Claude Code logs "tools/list failed …
     keeping previous tool set".
   - a notification (no `id`): 503 as before. The spec requires an HTTP error status for a
     notification the server cannot accept; none are defined over HTTP in 2026-07-28.
3. **Page gone mid-request.** When the page's session ends while a request waits for the
   page's answer, `tools/list` waits for the page again (once) and is sent again. A
   `tools/call` is never sent twice: the page may have run it, so it gets a tool result
   with `isError: true` saying so ("…may or may not have finished … check the result
   before trying again"). `server/discover` gets the stand-in at once. Others get the
   error with code `-31003`. If the relay had already started an event stream, the answer
   is its last event.

The log line keeps `reason: "page_not_open"` (status 200). Other 503s stay: a
notification, a dropped send (`-31005`) and an unavailable token store (`-31008`). It is
not proven that claude.ai behaves like Claude Code; the next test on a phone shows it.

## DEC-075: Identity binding is variant 1 only: the relay signs in at the provider

Iteration 7, from the [research findings](/research/identity-binding-research-needed.md).
The relay stays the AI app's only authorization server and becomes an OpenID Connect
client of one configured provider: at `/authorize` the user signs in there, and the relay
issues its own code and tokens if that person is the page's user. Variant 2 (the
organisation's authorization server in the protected-resource metadata, the relay as a
plain resource server) is dropped: no hosted provider registers unknown MCP clients and
issues audiences per tab address (Keycloak's CIMD is experimental and it has no RFC 8707;
Auth0 and Okta need registered APIs; Entra and Google have neither), and tokens from
another server could not be listed in the page or revoked by Disconnect (DEC-029). The
MCP-native route for enterprise providers is the Enterprise-Managed Authorization
extension (ID-JAG presented at the relay's `/token` with the RFC 7523 JWT-bearer grant);
it fits the relay's own authorization server and is the candidate for a later iteration,
once more providers than Okta issue ID-JAGs. `code` stays the default and unchanged.

## DEC-076: The tab assertion: a typed JWT from the web app, sent in an `identity` message

The web app's backend signs a short JWT for the relay; the page hands it to the library
(`identityAssertion` hook) and the library sends it as `{ type: "identity", assertion }`
after `session` (the page learns its address from `session` and needs it for `aud`), and
again when the hook is asked again (`refreshIdentity()`). The relay checks, in this order
(RFC 7523 claim rules, RFC 8725):

- compact JWS, at most 8 KiB; header `typ` exactly `tab-mcp-identity+jwt` (explicit
  typing, so an ID token or access token signed with the same key is refused); no `crit`;
  `alg` one of RS256/384/512, PS256/384/512, ES256/384/512, EdDSA (Ed25519), never `none`
  or HMAC; the key from `TAB_MCP_TAB_ASSERTION_JWKS_URL`, chosen by `kid` (or the only key
  of a matching type), whose `kty`/`crv` (and `alg`, if given) must fit the header's
  `alg`; `jku`, `jwk`, `x5u` in the header are never used;
- `iss` equal to `TAB_MCP_TAB_ASSERTION_ISSUER`;
- `aud` exactly the session's MCP address (a string, or an array with that one value):
  the address names both the relay and the page, so an assertion cannot be used at
  another relay or for another address;
- `exp` required, in the future (5 s leeway) and at most 60 s ahead (+5 s); `iat`, if
  given, not in the future (+5 s); `nbf`, if given, passed;
- `sub` a non-empty string of at most 255 characters: the user's subject at the OIDC
  provider, in the claim the relay compares (DEC-079);
- `jti` required (at most 128 characters) and single-use per person: the relay remembers
  (binding key, `jti`) until the assertion's `exp`. In memory is enough: an assertion is useful only on a session
  for its address, which needs the address secret.

The relay answers `identity.bound` or an `error` with code `identity_refused` (the
session stays). Verification is written on WebCrypto, without a JOSE library: the relay
has no runtime dependencies (DEC-068), the rules above are short, and allow-listing the
algorithms per key type closes the known JWT pitfalls (`none`, HMAC with a public key,
embedded keys). JWKS documents are fetched with a 5 s timeout and a 64 KiB limit, cached
10 minutes, and fetched again for an unknown `kid` at most every 30 s. After a failed
fetch the last good keys are served for up to an hour and the next attempt waits 30 s
(review of PR #13: an outage must not sign every page out at once).

`identity` and `identity.logout` of one session are handled one after another, in order,
and every `identity` gets exactly one answer (also `identity_refused` when the store
fails), so a slow check can never bind a user after a later sign-out. An authorization
code made by identity binding is exchanged only while the page is still bound to the
same person. The library counts only the relay's answer to its newest assertion and
gives up after `identityTimeoutMs` (15 s). The page numbers its assertions (`round`) and
the relay echoes the number in its answer, so an answer that was lost (a frame dropped
under backpressure, which the relay logs as `identity.answer_dropped`) or came late can
never pass for the answer to a newer one (review of PR #13; an order-based match broke
for good after one lost answer).

The replay memory keeps at most 120 assertions per person (about two a second over its
one-minute window) besides its relay-wide cap, so one signed-in user cannot fill it and
get everyone else's refreshes refused; expired entries are swept from the whole map at
most once a second. A JWKS fetch already running is awaited by every caller that comes
meanwhile, so tabs reconnecting together after a restart, or a refresh during a key
rotation, all get the keys; and responses are counted while they arrive, so a body
without Content-Length is cut off at the 64 KiB limit (review of PR #13).

## DEC-077: The address is bound to (provider, subject); grants carry the subject

The binding key is SHA-256 of the provider's issuer and the subject (never stored in the
clear). The session holds the key for its lifetime; it is proved again on every
connection, since assertions live 60 s. A grant made by the OIDC pairing method records
the key (`TokenRecord.subject`, `GrantSummary.subject`; a new nullable column in the
SQLite store, added on open). Then:

- An MCP request on a grant with a subject, or on a site with `pairing: "oidc"`, is
  forwarded only to a page bound to the same key. A page bound to another person gets
  401 `invalid_token` with "This AI tool is logged in as someone other than the page."
  (the AI app signs in again and meets the same message at `/authorize`). A page that is
  open but not signed in counts as not ready: the request waits like one for a closed
  page (DEC-074) and is forwarded once the page proves its identity, else it gets the
  HTTP 200 answer with "The page is open, but nobody is signed in to it. Ask the user to
  sign in to *name*, then try again."
- When a page proves another identity than its grants were made for (a different user in
  the same browser), the relay revokes those grants at once, ends their requests in
  flight (`-31009`) and tells the page (`grant.removed`).
- Grants without a subject (code pairing) on a `code` site are unaffected. A site that
  switches from `code` to `oidc` thus refuses its old code grants, and revokes them when
  its page first proves its user.
- A custom token store that drops the new field fails closed (every request is refused
  as a mismatch); the conformance suite checks the round trip.

## DEC-078: Logout is a message from the page; no back-channel logout

`TabMcp.signOut()` sends `identity.logout`. The relay revokes every grant of the address
(tombstone, DEC-063), fails the address's requests in flight with 401 and tells the page
to cancel them, forgets the binding and answers `grant.removed` for each grant: the AI
connection ends at once. The message needs no signature: the session is authenticated by
the address secret, and the page could already revoke everything (`grants.revokeAll`).
OIDC back-channel, front-channel and RP-initiated logout are not built: they end the
provider's sessions, and the relay has none; a logout while no page is open needs nothing,
because a grant works only while a page signed in as the same person is open (DEC-077).
The web app must call `signOut()` in its open pages when its user logs out (it has to end
its own session there too).

## DEC-079: The OIDC pairing method and its settings

- `TAB_MCP_IDENTITY=oidc` makes `oidc` the pairing of every site without its own
  `pairing` (the `TAB_MCP_ALLOWED_ORIGINS` origins included); a site may set
  `pairing: "oidc"` or `"code"` itself. With any `oidc` site the relay needs
  `TAB_MCP_OIDC_ISSUER`, `TAB_MCP_OIDC_CLIENT_ID`, `TAB_MCP_TAB_ASSERTION_ISSUER` and
  `TAB_MCP_TAB_ASSERTION_JWKS_URL` (https outside development) and refuses to start
  without them; `TAB_MCP_OIDC_CLIENT_SECRET` (absent: a public client with PKCE only) and
  `TAB_MCP_OIDC_SUBJECT_CLAIM` (`sub`, default, or `oid` for Entra ID) are optional. `oidc`
  with the open relay (`*`) is refused: one provider cannot vouch for any website's users.
  One provider and one assertion signer per relay instance; sites that need others get
  their own instance (DEC-045).
- The page's "Connect your AI app" dialog must be open (`pairing.start`), as for codes:
  someone who knows the address cannot pair while the user is not connecting. The tab
  sees `pairing: "oidc"` in `session` and shows no code.
- Connect at `/authorize` redirects to the provider's authorization endpoint (from
  discovery, whose `issuer` must equal the setting) with `response_type=code`,
  `scope=openid`, PKCE S256, `state` and `nonce` (random, bound to the pending request and
  the browser's visit cookie, 10 minutes, single-use), and `prompt=login` when the user
  tries again after a mismatch. The callback is `<public URL>/authorize/callback` (to be
  registered at the provider). The code is exchanged with `client_secret_basic` (or
  `client_secret_post` when the provider lists only that); the ID token is validated as
  OIDC Core §3.1.3.7 says (signature by the provider's JWKS with the algorithms above,
  `iss`, `aud` containing the client id, `azp` if several audiences, `exp`, `iat`,
  `nonce`). The subject is compared with the page's binding at callback time, so a page
  that signed out meanwhile pairs nobody.
- Match: the relay issues its code (DEC-029) and the grant records the subject. Mismatch:
  a page says "This AI tool is logged in as someone other than the page." with Try again
  (sign in as someone else) and Cancel; nothing is issued. A page not signed in: "Sign in
  to the page first." Provider errors are shown on the page, the reason only in the log.
- The owner's wording "logged in as someone else than the page" became "someone other
  than the page" (English idiom); the meaning is unchanged.

## DEC-080: Live examples on ractive.ch use the hosted relay (owner)

The owner, 2026-10-23: the examples are also published as live pages on ractive.ch, so
people can try tab-mcp without running anything, starting with the calculator at
<https://ractive.ch/tab-mcp/calculator/>. They connect to the hosted relay
`tab-mcp.ractive.ch`, which already allows `https://ractive.ch` (DEC-032), so the relay
does not change. The pages live in the ractive.ch site repository (DEC-046: deployments
stay outside this repository) and use the npm release of `@ractive-ch/tab-mcp-client`,
not the workspace. `bun run example` in this repository still starts a local relay and
never uses the hosted one. A live page served from localhost uses only a relay named in
its localStorage, never the hosted one.

Amended the same day (owner): the live calculator is removed again. It only showed that
the plumbing works; the diagram editor at <https://ractive.ch/tab-mcp/diagram/> shows what
an AI app can do in a page, and <https://ractive.ch/tab-mcp/> lists the live examples.
`/tab-mcp/calculator/` redirects there. The calculator then left this repository's examples
too (owner): it lives on in `test/e2e` as the page the end-to-end tests drive, and the
README points to the live examples instead.

## DEC-081: React bindings: provider plus hooks, a second entry of the client

Iteration 9's open questions, decided while building it (can be challenged):

- Provider plus hooks, not hooks only: tools are registered in many components, and one
  `TabMcp` per tree needs a place to live. `<TabMcpProvider>` takes the `TabMcp` options
  (or `client`, an instance of the page's own, which it then neither replaces nor
  disconnects). The instance comes from the first render; a changed `relay` or
  `server.name` makes a new one and warns (always, not only in development: the library
  cannot see the page's build mode without a bundler), other changes are ignored, but
  `onConfirm` and `identityAssertion` are read through a ref, so the latest closures
  count. Both wrappers are installed whether or not the props are there on the first
  render (review of PR #20), so a handler added or removed later counts too: without
  `onConfirm` the wrapper calls the new public `confirmInPage()` (the library's own
  dialog, which an `onConfirm` may also hand calls to), without `identityAssertion` it
  answers `null`, which is what no hook means (on an `oidc` relay `identity` passes
  through `pending` to `none`). The provider disconnects its own instance when it unmounts.
- The plan said the instance is made on the client only. It is made on the server too
  (during render), because the constructor touches no browser API and no storage, and
  effects (registering, connecting) never run there; so `useTabMcp()` always returns a
  `TabMcp` instead of `TabMcp | null` in every SPA. `useTabMcpState()` gives the server
  and hydration a fixed `disconnected` snapshot; a test renders on the server with no
  `window`/`document` and checks that storage is never read.
- Next.js app router and Remix: only the `"use client"` note in the README, no example.
  Other frameworks (Vue, Svelte, Solid): on demand; the core API works today.
- The entry is `src/react.ts` without JSX (`createElement`), so it imports only `react`
  and the core entry. The build makes it a separate file whose core import stays
  external (`./index.js`): one `TabMcp` class for both entries, no copy of the core, no
  lazy chunk loaded early (`build.test.ts` checks the imports and a 3 KB gzip budget).
  `"use client"` is a build banner, because Bun moves a source directive below the
  imports. The React entry is not in the CDN build.
- `react` is an optional peer dependency `>=18.3.0 <20`. Peer dependencies are ranges by
  nature, so they are the one exception to exact pins (DEC-004): `npm-pack.ts` checks
  them against the expected range and requires `peerDependenciesMeta` to mark each
  optional; dependencies stay exact.
- `useTool` keys the registration on name, title, description, input schema and
  annotations (JSON) plus optional `deps`; `execute` goes through a ref updated in
  `useInsertionEffect` (no server warning in React 18, unlike `useLayoutEffect`). A
  rejected registration (a duplicate name, an invalid tool) is thrown from the next
  render, for an error boundary. `useToolCalls` lists calls since the component mounted
  (per component, newest first), not a page-wide history. `ConnectButton` is always
  `type="button"` and has `data-state` (`reconnecting` as a fourth value).
- Tests run against React 19 and, in a second `bun test` process, against React 18.3:
  the dev dependencies `react-18`/`react-dom-18` (npm aliases) and a preload that maps
  `react` and `react-dom` to them with `mock.module` (also react-dom's own `react`, which
  the isolated install links to 19).
- `examples/react-todo` is bundled by Bun's HTML import and `bun build`, not Vite as the
  plan said: the repository uses Bun's bundler (CLAUDE.md), and the example shows the
  library, not a build tool. Its end-to-end test gives the AI app a token through the
  relay's store instead of pairing in Chrome, which the end-to-end test in `test/e2e`
  already covers.

## DEC-082: Reconnecting in the core library

`TabMcp` connects again by itself after a connection that was up ended with reason
`network`, `heartbeat` or `shutdown`: after 5, 10, 20 and 40 s, then every 60 s, and at
once on `visibilitychange` to visible or `online`. Every connection is user-started
(`connect()` needs a user action or `resume`), so the option `reconnect` is on by default;
`false` keeps the old behaviour, `{ delaysMs }` sets the waits (the last repeats).

- No new `ConnectionState` value: pages switch exhaustively over `state`, and a new
  member would break them. The getter `reconnecting` (`{ reason, attempt, at }` or
  `undefined`) and the event `reconnecting` (that object, or `null` when it stops) say
  it; `state` goes `disconnected` → `connecting` per attempt, as for a manual connect.
- `connect()` while waiting makes the attempt at once (also without user activation:
  the user started this connection). `disconnect()` stops reconnecting; `newAddress()`
  while waiting connects with the new address. The attempt count starts over after a
  successful connection.
- The library schedules after emitting `disconnected`, and not when the page's own
  listener already connected (pages like saturnus that reconnect themselves are not
  doubled until they drop their copy), nor when a listener ended it all with
  `disconnect()` or `newAddress()` (review of PR #20: the generation changed).
- A failed attempt is retried only when it failed for a reason that may get better:
  `network` (no WebSocket at all, a timeout, a lost chunk), `heartbeat` or `shutdown`.
  `connection.ts` rejects `ready` with the reason (the close code while opening, the
  relay's `error` as `policy` or `rate_limited`, a `bye`'s reason); anything else stops
  reconnecting (review of PR #20). A page whose origin is no longer allowed is the one
  refusal it cannot see: the relay refuses the upgrade, and the browser reports that as
  1006 like an unreachable relay, so it keeps trying every 60 s. Bun reports a failed
  handshake as 1002; both count as `network`.
- Not after `replaced` (another tab owns the address), `expired`, `idle`, `closed` or a
  refusal (`policy`, `too_large`, `rate_limited`): these do not get better by retrying,
  or retrying would fight another tab.
- A reconnect is a connect: `session` triggers the identity assertion again
  (`identityAssertion`, relays that pair by `oidc`) and `pairing.start` when pairing is
  on, as after a fresh connect.
- Cost: the core grows by about 0.5 KB gzipped, to 5.0 KB with the review fixes (budget
  5 KB, with a few bytes left: the next core feature has to raise it or trim).

## DEC-083: The address secret is kept per relay and page (owner)

The owner, 2026-10-23. Until 0.4 the library kept the secret under
`tab-mcp:secret:<relay origin>`, so every page of one origin that did not set `storageKey`
shared one address: on ractive.ch the calculator and the diagram editor did, and an AI app
paired with one got the other's tools. From 0.5 the default key is
`tab-mcp:secret:<relay origin>:<server.name>`: `server.name` is required and names the
page's MCP server, so it is the natural per-page part. It is URI-encoded in the key, and
renaming it changes the address (the page's apps pair again).

A secret under the old key is copied once: read, written under the new key, and a marker
`<old key>#moved` set, so a site with one page, saturnus for example, keeps its address
without a change. The old key is not removed (review of PR #23): a page of the same site
still on 0.4, or a rollback to 0.4, keeps reading it. On a site with several pages the
first page to connect keeps the old address and the others, seeing the marker, get new
ones; two pages connecting at the same instant could both take it, which a reload of
either does not undo but "New address" does. "New address" before the first connect also
sets the marker, so the abandoned address is not picked up by another page. A secret that
was read is used even when the writes fail (storage full). An explicit `storageKey` is
used as given and never copied.

The copy costs about 80 bytes gzipped and takes the core to 5.1 KB; the budget in
`build.test.ts` goes from 5 to 5.25 KB (DEC-082 said the next core feature would have to
raise it).

## DEC-084: The official MCP conformance suite in verify and CI

2026-10-24, the owner asked whether the implementation follows the 2026-07-28
specification, and for the suite in CI if it is cheap. It is: about 2 seconds.
`bun run conformance` (part of `bun run verify`, so of CI) runs
`@modelcontextprotocol/conformance` (pinned, 0.2.0-alpha.12) with
`--requirements 2026-07-28`, the frozen set of scenarios that revision requires. The target
is an in-process relay and this library in Bun with the suite's fixture tools (text, image,
audio, embedded resource, mixed content, error, JSON Schema 2020-12, a tool-list change),
behind a local proxy that adds the access token, since the suite has no option for one.

`packages/tab-mcp-client/test/conformance-baseline.yaml` lists the known failures, each
with its reason. A new failure, or a listed one that starts passing, fails the run. Known
failures:

- Features a page does not offer (DEC-049): resources, prompts, completion, progress and
  log notifications, input requests (MRTR) and required client capabilities.
- `Origin` on the MCP endpoint (DEC-036): the transport says a server MUST answer 403 to a
  present, invalid `Origin`. The relay accepts any, because tokens are bearer headers only
  and a public relay has no ambient authority to protect from DNS rebinding. It stays a
  documented deviation.

Not scored for 2026-07-28 and so not in the baseline: the tasks extension and the pending
scenarios (`x-mcp-header` validation, which DEC-033's research rules out for tab tools).

The first run found one real defect, fixed with this decision: the relay answered every
`initialize` with 400 and `-32022` before forwarding (DEC-040). An `initialize` in a
2026-07-28 envelope (header and `_meta` both 2026-07-28) is an ordinary request for a
method the server does not have, which the transport answers with 404 and `-32601`. The
relay now forwards it and the library answers that, as the MCP TypeScript SDK does. An
old-style `initialize` still gets 400 and `-32022`.

## DEC-085: Relay request path hardening

2026-10-24, iteration 11 (findings 1 to 9 of the review of the relay's request path). The
choices the plan left open:

- **Listen answers are event streams.** A streamed answer to `subscriptions/listen` with
  any other content type is a protocol error (`-31007`, `http.cancel`), whether the tab or
  the relay started the stream. Only a listen request's event stream is exempt from
  `maxBodyBytes`; a buffered (wrapped) body never is. A chunk before
  `http.response.start` on a relay-started stream is a protocol error too: it used to be
  written to the AI app as raw text. `exchange.ts` now has one state type instead of four
  flags, which is where the hole hid.
- **The idle timeout comes back on every exit.** Measured with Bun 1.4.3:
  `server.timeout(req, n)` applies while the response is in progress (before the handler
  returns, or before a streamed body is closed, also synchronously right after
  `controller.close()`), and is silently ignored once the response has finished (one
  microtask after the close is already too late). So the relay restores it before
  returning any answer that is not forwarded, and in the exchange's `onDone`, which runs
  synchronously when the exchange ends. The admission step (wait, identity, size,
  concurrency) is pulled out of `handleMcp` so there is one place for the restore.
- **`-31009` transient variant.** A refused assertion, a sign-out or another person: 401
  with `WWW-Authenticate` (`error="invalid_token"`). When the relay could not check
  (`jwks_unavailable`, `store_unavailable`, an unexpected `error`): 503 with
  `Retry-After`, same code, so clients keep their tokens. The binding still ends in both
  cases (fail closed). Review of PR #30: the session remembers that the last refusal was
  transient (`identityUnchecked`, cleared when an assertion is bound or the user signs
  out), and while nobody is bound new requests get the same 503 after the usual page wait
  instead of the signed-out answer, which would send the user to sign in for a relay-side
  outage. Nothing reaches the page meanwhile. A full relay-wide replay cache is its own
  reason, `relay_busy`, and transient; one person's full share stays `busy`, a refusal.
- **Waiting requests use the last seen site limit** of the address, kept in the bounded
  map that already held the app name; an address not seen since the start uses the
  instance's. No re-check on wake: the cap alone keeps more from waiting than can run.
- **Shutdown answers keep the page-not-open shape** (HTTP 200, a tool result for
  `tools/call`, a stand-in for `server/discover`), with the text "The relay is
  restarting" and a new code `-31010`, not 503: dual-era clients take an HTTP error as an
  old server (DEC-074). A notification, waiting or already sent to the page, gets 503 with
  `-31010` and `Retry-After`. `stop()` sets a flag before it ends the sessions, since
  their requests end synchronously inside it. A `tools/call` that was
  in flight says the result should be checked.
- **Listen streams: 2 per grant and session**, a constant, not a setting. A per-grant share
  of `maxConcurrentRequests` was the alternative; listen streams are the only requests
  without a request timer, so capping them is enough, and 2 lets a client open a new
  stream while its old one closes.
- **Store errors log `error` (the name) only**, for the built-in stores too, as
  `installCrashLogging` already does (`errorName` in `log.ts`).
- **Tab frames are refused by length before parsing**; the error's `id` comes from a
  match on the first 256 characters. The factor of 4 on `maxPayloadLength` stays, named
  `FRAME_HEADROOM` and documented: frames a little over the limit get `too_large` and the
  session stays, bigger ones close with 1009.
- Dead parameters: `ForwardInput.method` is gone (always `POST`), `SessionHost.ready` is
  required. `CloseCode.rateLimited` stays: 4008 is reserved in the protocol and the client
  library maps it.

Left for the owner: session-slot protection (finding 10) and the address id in the `/tab`
URL (architecture F9).

## DEC-086: Input schemas are compiled by the validator once it is loaded

2026-10-24, iteration 13 (finding 5 of the browser library review). The core checks a
schema at registration with its own walk (`schemaProblem`: patterns, `$ref`s by pointer or
anchor), because the validator, `@cfworker/json-schema`, is in the chunk that `connect()`
loads (DEC-035) and the core must stay small and free of it. That walk does not follow
`$id`: a `$ref` next to a nested `$id` resolves against the `$id`'s base, the walk accepts
it, and the validator throws `Unresolved $ref` at call time. That throw was outside every
`try`: each call answered `-32603`, the validator was never cached, and the `toolcall`
had no `toolcallend`.

The validator's own check runs where the validator is: `compileRegistry`, in the lazy
chunk, runs when `connect()` has loaded it. It dereferences each schema (which throws for
an `$id` that is not a URL or a duplicate one) and resolves every `$ref` in the lookup it
builds, which is what validation would do later, only for all of them at once. A
validator is kept per registered tool, so a call compiles nothing. From then on the
registry calls it in `registerTool`, which rejects such a schema with a `TypeError` like
any other bad schema; a tool registered before `connect()` whose schema it refuses is
unregistered and reported with the event `error`, before the session starts and so before
any AI app lists it. Compiling is linear in the schema's size and synchronous, so
`registerTool` stays as fast as before for normal schemas; it never waits for the chunk.
Loading the validator in `registerTool` would have made registration wait for the
network, and a tool that only fails after `connect()` is the price of a small core. The
handler still catches a compile failure (for a registry used without `TabMcp`) as an
`isError` result, and every `toolcall` has its `toolcallend`, also when something fails
outside the tool.

The fixes of iteration 13 (this one, the frozen `grants`, one connect dialog, the delay
options, the identity timeout) take the core from 5.1 to 5.4 KB gzipped; the budget in
`build.test.ts` goes from 5.25 to 5.5 KB.

## DEC-087: The confirmation counts its delay only while the user sees the page

2026-10-24, iteration 13 (findings 1 and 2 of the browser library review). Tools are
called while the user is in the AI app, so the confirmation of a consequential tool
usually opens in a tab or window in the background. The 750 ms of `confirmDelayMs` ran
from `showModal()`, so it was over by the time the user came back, and the click that
brought the window forward could land on "Allow". Now "Allow" and "Always allow" stay
disabled while `document.visibilityState` is `hidden` or `document.hasFocus()` is false,
and are enabled only after the page has been visible and focused for the full delay.
`visibilitychange` and the window's `focus` and `blur` start the wait again from zero
(a `blur` disables at once). Re-arming on every such event only ever delays "Allow",
which is the safe direction. A page embedded in a frame waits until the user is in the
frame. Tested in happy-dom with a fake clock and in headless Chrome, where a second
target hides the page and `Target.activateTarget` brings it back.

The arguments are shown as JSON in which every character that is invisible or changes the
direction of the text is written as `\uXXXX` (two for one beyond U+FFFF): `\p{Cf}` (bidi
controls and isolates, zero-width characters, tags), the other default-ignorable code
points (fillers, variation selectors), `\p{Co}`, `\p{Cn}`, the C1 controls and U+2028 and
U+2029, which `JSON.stringify` leaves as they are. These characters occur only inside JSON
strings, where the escape means the same character, so the text shown is still JSON for
exactly the arguments the tool gets; the arguments themselves are never changed. An emoji
sequence with a zero-width joiner or a variation selector is shown with escapes; that is
the honest view in a security dialog. The names of the AI app and the tool are in
`<bdi dir="ltr">`, so a right-to-left name cannot reorder the sentence around it, and the
client's name and host are escaped the same way, in case a relay does not strip them.

## DEC-088: Connection requests only while the page is connecting; evict at the caps

From the security audit of 2026-10-24 (finding 1), iteration 12. DEC-061 kept a pending
authorization for any address with a connected tab and refused with 429 past 20 per
address. Anyone who knew an address (A1) could therefore keep it full from two networks
and lock its owner out of `/authorize` for good. Now:

- `GET /authorize` opens a request only while the session's `pairingOpen` is true (the
  code method's codes are on, or the oidc page's dialog is open). Otherwise it keeps
  nothing and shows "Open “Connect your AI app” first" with Try again (the same URL) and
  Cancel, like the page for a tab that is not connected. Pairing needs the dialog open
  anyway, so this costs the owner nothing but a reload when the AI app opened the
  browser before the dialog.
- One network (IP prefix, DEC-061) holds at most 5 requests per address; a sixth drops
  that network's own oldest one. At 20 per address the next request drops the oldest
  request of the network holding the most, not the address's oldest overall. A tie goes
  to the network whose first request came last (review of PR 32: breaking it toward the
  first network evicted the owner, who usually comes first, with 2 requests against 9
  networks of 2). So the owner's request goes only if the owner's network holds more
  than every other, or ties with them and arrived last of all: a request that arrives
  into a full address is the next to go. An attacker who keeps the address full from
  many networks while the dialog is open can therefore still push out a request the
  owner opens after the flood began, though not one opened before it; this is the trade
  DEC-061 made for guesses too, and "New address" ends it.
- Per network overall (10) and in total (10 000) the caps still refuse: that only
  affects the network that fills them.

This replaces DEC-061's "refused with 429 instead of evicting others' requests" for the
per-address cap.

## DEC-089: Client metadata fetches limited per domain, the cache least recently used

From the audit (finding 2). The per-host limit keyed on `url.host`, so a wildcard DNS
entry gave every client id a fresh bucket, two networks kept the global bucket empty and
every uncached real client got "The relay is busy"; 1000 subdomains also pushed
claude.ai's document out of the first-in-first-out cache.

- The per-host limit is now keyed on the last two labels of the host name (an IP literal
  as is). We weighed the Public Suffix List: it is over 200 KB, changes every few days, and
  would need either a dependency or a vendored copy with an update routine. It is also
  not stricter here: under the PSL every `*.pages.dev` or `*.github.io` project is its
  own registrable domain, so an attacker with free subdomain hosting still gets one
  bucket per project, while the last two labels group them all. A heuristic such as
  "three labels when the TLD has two letters" was rejected: an attacker picks a domain
  that the heuristic splits.
- The cost is a denial-of-service risk for specific hosts, not only "stricter" limits
  (review of PR 32): every client under a multi-label public suffix (`co.uk`, `com.au`,
  `pages.dev`) shares one domain bucket, so an attacker with a wildcard under that
  suffix (`*.evil.co.uk`) can keep the uncached fetches of every other client under it
  refused. Cached documents keep working (at least 5 minutes, usually an hour). To make
  this need many hosts, each host also has its own bucket (5, then 1 every 5 s) and the
  domain bucket is three times larger (15, then 3 every 5 s): one host alone cannot
  empty its domain. None of the known AI apps (claude.ai, chatgpt.com, openai.com) is
  under such a suffix; an operator who expects one can list it in
  `TAB_MCP_CLIENT_ID_HOSTS`, which refuses other hosts before any limit is charged.
- The domain's token is taken only after the global limiter admits the fetch
  (`RateLimiter.available` checks without taking). The other order would let refusals
  of one domain drain the global bucket, which is the attack itself.
- The cache moves an entry to the end on a hit and evicts the least recently used
  entry. The plan also asked never to evict hosts in `TAB_MCP_CLIENT_ID_HOSTS`: with the
  list set, no other host is fetched or cached at all, so a stranger cannot evict a
  listed host's document; there is nothing to add. If the list ever stops being an
  allow-list (the owner's open question of finding 6), this needs revisiting.

## DEC-090: One OIDC sign-in per connection request, charged like a guess

From the audit (finding 3). Every Connect on an oidc site added a flow under a new
`state` and never dropped the earlier ones; the CSRF token is not bound to the IP, so a
signed-in user with an IPv6 /48 could post Connect for one pending request from many
/64s and fill all 10 000 flows, blocking identity pairing relay-wide.

- A pending request has at most one flow: a new Connect drops the earlier flow (its
  callback then says the sign-in expired), and a request that ends (paired, cancelled,
  expired, evicted) drops its flow through the new optional `PairingMethod.forget`.
  Flows are therefore bounded by pending requests, which are capped per network,
  per address and in total (DEC-088). A separate per-IP cap on flows would add nothing:
  the IP that posts Connect is not the one that opened the request, and one flow per
  request already ends the multiplication.
- `check` calls `admit()` before it starts a sign-in, so Connect clicks share the guess
  limits (10 per address and network, then 1 a minute; 30 per address): starting a
  sign-in is the oidc method's "answer that could be right" (DEC-061). It is called
  after the capacity check, so "Too many sign-ins are open" (now 429, like the other
  refusals for load) charges nothing (review of PR 32).

## DEC-091: A used refresh token is kept 24 hours; refreshes per grant are limited

From the audit (finding 4). Reuse detection kept every used refresh token until its own
expiry, 30 days: one grant refreshing at the `/token` rate added about 86 000 rows a day
per network.

- `TokenStore.markUsed(hash, now, keepUntil)` lowers `expiresAt` to `keepUntil` in the
  same atomic step (never raises it); the relay passes now + 24 hours, and
  `deleteExpired` drops the row after that. Inside the window a replay still revokes the
  grant (the theft signal of DEC-029). After it the token is unknown, refused as
  `invalid_grant` without revoking: a thief who waits a day with a token the client
  already rotated gets nothing, but the owner is not warned. A thief who races the
  client, the case detection is for, shows up within hours, not days.
- It is a contract change, not a new method: a store written for 0.3 still type-checks
  (fewer parameters), stays correct, and only keeps rows longer. The conformance suite
  checks the cut and that it never extends. The Redis sketch in the guide was updated
  and run against Redis 7.4.
- Rows used before the upgrade: the SQLite store's schema version 4 cuts every used
  refresh token to `used_at` + 24 hours once, when it opens an older file (review of
  PR 32). A custom store that keeps them only loses the space until they expire; the
  changelog says how to do the same.
- The plan's optional cap is in: 20 refreshes per grant, then 1 a minute, answered
  `429 temporarily_unavailable` before the token is marked used. A client refreshes
  about once an hour of use, so this binds only a misbehaving or hostile client, and it
  bounds the rows one grant can leave in the window to about 1 500.

## DEC-092: Client names with another domain are refused

From the audit (finding 5). DEC-065 refused only a web address in parentheses, so
"Claude [claude.ai]", "Claude · claude.ai" or "Claude from claude.ai" passed and the
heading read "Connect Claude · claude.ai from evil.example". Of the two fixes offered we
refuse such names rather than move the host first: the host is already in the heading
and title, and the look-alike name would still stand alone in the body text.

- A name is refused if, after NFKC, without combining marks, with the ideographic full
  stops (U+3002, U+FF0E, U+FF61) read as dots and in lower case, it contains a
  domain-shaped token (labels separated by dots, ending in a label of 2-63 letters)
  whose ASCII (punycode) form is not the verified host, a subdomain of it, or a parent
  of it. Marks are dropped because "claude.a̲i" or a variation selector after the
  `a` displays as "claude.ai" (review of PR 32); the parentheses check reads the same
  text, and the shown name loses variation selectors too, so what is shown is what was
  checked. The ASCII form lets "Bücher · bücher.example" name its own
  `xn--bcher-kva.example`.
- A domain spelled with words ("claude dot ai", "claude(dot)ai") passes. Normalising
  words would refuse ordinary names; the verified host in the heading is the defence
  there, as for any self-declared name. "Example AI from ai.example" from `ai.example`
  passes; so do "Claude", "Claude Code", "ChatGPT", "Codex" and versions like "v1.2".
- Risk: a real client whose name has a dotted product name ending in letters, such as
  "Next.js helper" or "Socket.IO tools", is refused, because `js` and `io` look like
  top-level domains and there is no list of real TLDs here. No known AI app is named
  like that. If one appears, a short exception list is the fix, not a looser pattern.
- The parentheses rule of DEC-065 stays as it is, also for the client's own domain.

## DEC-100: The pairing page does not mark unknown AI app hosts (owner)

The audit's architecture finding F6: any HTTPS host that serves a valid client metadata
document counts as "verified", so a host like `claude-connect.pages.dev` looks as
trustworthy as `claude.ai` on `/authorize`. The option was a built-in list of known AI
app hosts and a note on the pairing page for any other host. Owner, 2026-10-25: no.
People use many different AI tools, and a list would mostly warn about legitimate ones
and need constant upkeep. The verified host stays in the heading and title (DEC-065),
look-alike names are refused (DEC-092), and an operator who wants a closed set uses
`TAB_MCP_CLIENT_ID_HOSTS`, which `docs/self-hosting.md` lists under "Before you go live".

## DEC-101: CI and repository settings after the supply-chain review (owner)

From the review of 2026-10-24 (iteration 14). Owner, 2026-10-25:

- `main` is protected by the ruleset "main": no deletion, no force push, changes only
  through a pull request (merge commits only), and the `verify` check of `ci.yml` must
  pass. Repository admins can bypass it only when merging a pull request, not by
  pushing. This would have stopped PR #34, which was merged before its last CI run.
- Dependabot alerts and security updates are on; GitHub Actions must be pinned by full
  commit SHA (all of them already were).
- The `release` environment keeps no required reviewer for now; it admits only release
  tags. The header of `release.yml` says so.
- `DOCKERHUB_TOKEN` stays a repository secret until the owner sets it again as a secret
  of the `release` environment: a secret cannot be read back, so moving it means
  entering the token anew (`kb/operations/release-secrets.md`).
- Chrome for Testing is pinned to one version in `ci.yml` and `release.yml`
  (`CHROME_VERSION`) and bumped on purpose; `client-pack` installs it like
  `relay-pack`, so the browser tests of a client release no longer depend on the
  runner image; every job has a time limit (20 minutes, 5 for the token check).
- The image keeps `main.js.map`: the source is public, and the map turns a stack trace
  in the log into file and line.

# Citations

- [MCP conformance suite](https://github.com/modelcontextprotocol/conformance)
- [MCP 2026-07-28 research](/research/mcp-2026-07-28-spec.md)
- [MCP versioning: backward compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#backward-compatibility-with-initialization-based-versions)
- [MCP Streamable HTTP: backward compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility)
- [MCP tools: error handling](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling)
- [MCP caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
- [AI app support research](/research/ai-app-support.md)
- [Bun runtime and publishing research](/research/bun-runtime-and-publishing.md)
- [bunny.net research](/research/bunny-magic-containers.md)
- [WebMCP registerTool](/research/webmcp-register-tool.md)

## DEC-093: The default dialogs are styled by a constructed stylesheet

The owner asked for nicer default dialogs. Inline CSSOM styles (DEC-054) cannot express
hover, `:focus-visible`, `::backdrop`, media queries (360 px, `prefers-reduced-motion`)
or "hidden stays hidden", and a page could change them only through the custom
properties.

- The look is one constructed stylesheet (`DIALOG_CSS` in `ui.ts`), adopted once per
  document into `document.adoptedStyleSheets` next to the page's own sheets. Constructed
  stylesheets are not subject to `style-src`, so a strict CSP still needs no exception
  (checked in headless Chrome with `style-src 'self'`: no violation, rules applied).
  Where they are not supported, the dialogs keep the browser's default look.
- Every selector has the specificity of one class (the rest in `:where()`), and the
  rules are not in a cascade layer. A layer was tried first and dropped: any unlayered
  rule of the page would win, so a common reset (`* { border-width: 0 }`,
  `button { background-color: transparent }`) or a page's own `button { … }` took the
  primary button's fill and every border. With one class, element rules of the page do
  not reach in, and a page rule with two classes (`.tab-mcp-dialog .tab-mcp-primary`)
  wins. A page that writes its overrides inside a layer loses to the dialogs' rules; the
  README says to write them outside layers.
- The rules for states (hover, focus, disabled) and for the primary and danger buttons
  add two elements (`html dialog.tab-mcp-dialog :where(…)`, `html button.tab-mcp-primary`):
  0,1,2. That beats the page's `button:hover { … }`, `button:focus { outline: none }` and
  `button:disabled { opacity: 1 }` (0,1,1), and a page rule with two classes (0,2,0)
  still wins (review of PR 34).
- The commands in the help name the server by a label that every shell reads as one
  plain word (NFKD without marks, lower case, runs of anything but `a-z0-9_-` as `-`,
  no `-` at either end, at most 40 characters, else `tools`), not by a quoted name.
  Quoting cannot be right for POSIX shells, PowerShell and cmd.exe at once (review of
  PR 34: a newline, `'$ & calc & '` in cmd.exe, `'\''` in PowerShell, typographic
  quotes, a leading `-`). The address goes into a command only if `new URL(...).href`
  has nothing but `[A-Za-z0-9.:[]/_~-]` after `http(s)://`; otherwise the help shows the
  steps without commands.
- `--tab-mcp-*` custom properties change single values; the library never declares them,
  only reads them with a default, so a value on `:root` reaches the dialog. Internal
  values are `--_tab-mcp-*`.
- Neutral defaults: system colours (`Canvas`, `CanvasText`) and mixes of the text
  colour, so the dialogs follow the page's `color-scheme`; the primary button is the
  text colour filled. One primary per state: Copy the address, Done, and in the
  confirmation "Don't allow" (the focused, safe choice), not Allow.
- Inline styles stay only where they matter without the stylesheet: the arguments wrap
  (also long words) and scroll, and the code is selected as a whole.
- The stylesheet lives in the lazily loaded UI chunk (3.8 KB to 6.0 KB gzipped, with the help's commands, Codex and the review fixes of PR 34); the
  core is unchanged.
