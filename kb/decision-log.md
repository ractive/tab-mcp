---
type: decision-log
title: "Decision log"
description: Decisions for tab-mcp with their reasons, newest last. Owner decisions are marked as such and are not reopened.
tags:
  - decisions
timestamp: 2026-10-19T20:00:00+02:00
---

# Decision log

Owner decisions (DEC-001 to DEC-012) were made with the owner on 2026-10-19 before the
research. DEC-013 onwards follow from the research and can be challenged.

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

## DEC-008: Tokens are opaque, in memory, and die with the session (owner)

Random strings; end on tab close/disconnect, timeout or revoke.

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

## DEC-016: No refresh tokens; access token lives as long as the session

A token is worthless after the session ends, so a refresh token adds nothing. `expires_in`
is the remaining session lifetime. Clients must not assume refresh tokens (spec).

## DEC-017: Stable addresses through a key kept in the page

Re-adding a connector in claude.ai or ChatGPT every visit would make the tool unusable. The
library keeps a random `addressKey` in `localStorage`; the relay derives the address id by
hashing it and stores nothing. Tokens still end with each session; on the next visit the AI
app gets 401/404, authorizes again, and the user approves in the tab. "New address" rotates
the key. A newer session for the same address replaces the older one. To be confirmed by
the owner ([open questions](/open-questions.md)).

## DEC-018: Relay checks the protocol version first

Order on the MCP endpoint: known address → `MCP-Protocol-Version` is `2026-07-28` (else 400
/ `-32022` with `supported: ["2026-07-28"]`, which also answers a legacy `initialize`) →
token → limits → forward. The tab's SDK handler does the full header/body validation.

## DEC-019: Tolerate one known Claude header bug

claude-code #93290: Claude Desktop and Claude Code via claude.ai connectors send
`MCP-Protocol-Version: 2025-11-25` with `_meta` protocol version `2026-07-28`, which a strict
server rejects. The relay rewrites the forwarded header to `2026-07-28` in exactly that case
(header `2025-11-25`, body `_meta` `2026-07-28`), counts it in a log line, and drops the
workaround once Claude fixes it. Not legacy support: the request is a 2026-07-28 request.

## DEC-020: Streamed responses for tool calls, keep-alives from the relay

Bun's idle timer kills held requests (fix: `server.timeout(req, 0)` plus our own timers),
and bunny.net's CDN returns 504 when no response headers arrive within 60 s. The tab answers
`tools/call` with SSE at once (`responseMode: "sse"`), and the relay writes `: keep-alive`
comments every 20 s at event boundaries. Other requests may answer as single JSON.

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

# Citations

- [MCP 2026-07-28 research](/research/mcp-2026-07-28-spec.md)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
- [AI app support research](/research/ai-app-support.md)
- [Bun runtime and publishing research](/research/bun-runtime-and-publishing.md)
- [bunny.net research](/research/bunny-magic-containers.md)
- [WebMCP registerTool](/research/webmcp-register-tool.md)
