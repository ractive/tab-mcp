---
type: research
title: "MCP TypeScript SDK v2 (2.3.1): what it gives tab-mcp"
description: Packages, the stateless createMcpHandler, browser and Bun spikes, auth helpers, and what we take versus write.
tags:
  - mcp
  - sdk
  - spike
timestamp: 2026-10-19T20:00:00+02:00
---

# MCP TypeScript SDK v2 (2.3.1): what it gives tab-mcp

Read from the `v2.3.1` tag (commit `fcef852`) and spiked under Bun 1.4.3 and headless
Firefox 158 on 2026-10-19 (spikes outside the repo, deleted).

## Packages

| Package | Version | Licence | Dependencies | Notes |
|---|---|---|---|---|
| `@modelcontextprotocol/server` | 2.3.1 | Apache-2.0 | `zod ^4.2.0`, core | ESM+CJS, `.d.mts`/`.d.cts`; `_shims` export with `browser` condition |
| `@modelcontextprotocol/core` | 2.3.1 | Apache-2.0 | `zod ^4.2.0` | protocol and OAuth metadata schemas |
| `@modelcontextprotocol/client` | 2.3.1 | Apache-2.0 | zod, jose, eventsource, pkce-challenge, cross-spawn (stdio only) | for tests and the e2e |
| `@modelcontextprotocol/server-legacy` | 2.3.1 | Apache-2.0 | express, express-rate-limit, … | v1 auth router, frozen, Express-only |

The v2 packages are **Apache-2.0**, not MIT (the repository moved from MIT). Compatible with
our MIT code; a bundle that inlines the SDK must carry its licence and NOTICE text.

## Serving 2026-07-28

- `createMcpHandler(factory, options)` returns `{ fetch(Request, {authInfo?, parsedBody?}),
  close, notify, bus }`. The factory runs per request and returns an `McpServer`.
- `legacy: "reject"` makes the endpoint 2026-07-28-only: `initialize` gets HTTP 400 /
  `-32022` with `data.supported: ["2026-07-28"]`.
- It answers `server/discover`, `tools/list`, `tools/call`, validates `MCP-Protocol-Version`,
  `Mcp-Method`, `Mcp-Name` against the body (400 / `-32020`), adds `resultType`, `ttlMs`,
  `cacheScope`, serverInfo `_meta`, and serves `subscriptions/listen`
  (`handler.notify.toolsChanged()`).
- Raw JSON Schema tools: `registerTool(name, { inputSchema: fromJsonSchema(doc) }, cb)`;
  `tools/list` shows the document unchanged and arguments are validated (AJV on Node,
  `@cfworker/json-schema` in browsers).
- `responseMode: "auto"` answers JSON unless the handler emits a notification first, then
  SSE. Cancellation follows `Request.signal`.
- MRTR is supported (`inputRequired(...)`, `createRequestStateCodec` seals `requestState`
  with HMAC).
- No Origin/Host checks inside the handler; `originValidationResponse` and
  `hostHeaderValidationResponse` exist as separate helpers.

Spike results (Bun): `server/discover` 200 with `supportedVersions: ["2026-07-28"]`;
`tools/call` 200; a bad argument `isError: true`; missing `Mcp-Name` 400/`-32020`; legacy
`initialize` 400/`-32022`. The SDK's own `Client` pinned to 2026-07-28 connected, listed
and called the tool.

## In the browser

- `bun build --target=browser --minify` of `createMcpHandler + McpServer + fromJsonSchema`:
  317 KB minified, **82 KB gzipped** (zod ≈101 KB of it). Low-level `Server` only: 65 KB
  gzipped. No `node:` imports, no `process`/`Buffer` at runtime.
- Ran in headless Firefox 158. **Bug:** Firefox's `Request.body` is `undefined` for a
  constructed request, and `readRequestBody` only checks `=== null`, so the handler failed
  with `-32700`. Workaround: `handler.fetch(req, { parsedBody })`. Worth an upstream issue.

## A custom Transport does not work for 2026-07-28

`Transport` (start/send/close, onmessage) is public, but a server connected by hand is never
marked as serving the modern revision (`installModernOnlyHandlers` is internal; only
`createMcpHandler` and `serveStdio` set it). In the spike, `server/discover` returned
`-32601` and results lacked `resultType`. **The supported way to run 2026-07-28 logic in the
tab is `createMcpHandler(...).fetch(Request)`.**

## Auth helpers

- Resource-server side, web-standard (works on Bun): `requireBearerAuth({ verifier,
  requiredScopes, resourceMetadataUrl, expectedResource })`, `bearerAuthChallengeResponse`,
  `oauthMetadataResponse` (RFC 9728 and RFC 8414 documents),
  `getOAuthProtectedResourceMetadataUrl`, `checkResourceAllowed`.
- Authorization-server side: only `server-legacy/auth` (`mcpAuthRouter`, PKCE S256,
  `resource` parsing), which is Express-only, frozen and has **no CIMD**. The docs advise a
  dedicated identity provider.
- Client side (what real clients do, `packages/client/src/client/auth.ts`): uses its
  `clientMetadataUrl` as `client_id` when the AS advertises
  `client_id_metadata_document_supported: true`, else DCR; always PKCE S256 and fails
  without `code_challenge_methods_supported` containing S256; sends `resource` on both
  requests; checks `iss` when `authorization_response_iss_parameter_supported` is set.
- `@modelcontextprotocol/core` exports the OAuth metadata and client-metadata schemas, usable
  to validate fetched CIMD documents.

## Take versus write

| Part | Decision |
|---|---|
| Tab-side MCP logic (discover, list, call, validation, listen, cache hints) | take: `@modelcontextprotocol/server` `createMcpHandler`, `legacy: "reject"` |
| Tab↔relay link | write: tunnel HTTP request/response over the WebSocket (not a `Transport`) |
| Relay header pre-checks, bearer check, PRM/AS metadata documents | take the web-standard helpers where they fit; write the rest |
| OAuth authorization server (authorize, token, CIMD fetch, consent with code) | write |
| Tests and e2e client | take: `@modelcontextprotocol/client` pinned to 2026-07-28 with `clientMetadataUrl` |

Open: per-request `McpServer` construction cost with many tools (cache the
`fromJsonSchema` objects); SSE through the tunnel and abort-on-disconnect are not spiked;
Chrome and Safari not tested (always pass `parsedBody`).

# Citations

- [typescript-sdk v2.3.1](https://github.com/modelcontextprotocol/typescript-sdk/tree/v2.3.1)
- [docs/protocol-versions.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/protocol-versions.md)
- [docs/serving/web-standard.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/serving/web-standard.md)
- [docs/serving/authorization.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/serving/authorization.md)
- [docs/advanced/custom-transports.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/advanced/custom-transports.md)
- [docs/advanced/schema-libraries.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/advanced/schema-libraries.md)
- [docs/servers/input-required.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/servers/input-required.md)
- [server/requestBody.ts (Firefox body bug)](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/packages/server/src/server/requestBody.ts)
- [client/auth.ts (CIMD client behaviour)](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/packages/client/src/client/auth.ts)
- [SDK v2 documentation site](https://ts.sdk.modelcontextprotocol.io/v2/)
- [@modelcontextprotocol/server on npm](https://www.npmjs.com/package/@modelcontextprotocol/server)
