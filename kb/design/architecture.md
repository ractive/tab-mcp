---
type: design
title: "tab-mcp architecture"
description: >-
  Components, endpoints, data flow and the full sequence from a page connecting,
  through pairing with a code, to an AI app calling its tools and the user
  disconnecting.
tags:
  - architecture
  - design
timestamp: 2026-10-20T18:00:00+02:00
---

# tab-mcp architecture

A web page offers some of its functions as MCP tools. The page connects to a tab-mcp relay
and gets a public MCP address. The user adds the address to an AI app and pairs it with a
code shown in the page; the AI app then calls the tools through the relay while the tab is
open. Nothing is installed on the user's computer.

## Components

| Component | Package | Runs | Knows |
|---|---|---|---|
| Browser library | `@ractive-ch/tab-mcp-client` | in the page | the tools, the MCP server logic (loaded on `connect()`), the pairing and confirmation UI, the address secret |
| Relay | `@ractive-ch/tab-mcp`, Docker `ractive/tab-mcp` and `ghcr.io/ractive/tab-mcp` | Bun server | tab sessions, OAuth (authorization server and resource server), limits; **not** tools |
| Token store | `TokenStore` interface in the relay package | SQLite file (default), memory, or the library user's own | grants and token hashes per address |
| Example | `examples/calculator` | static page with a local relay | four-function calculator with `press_keys`, `read_display`, `clear`, `clear_memory` (consequential) |

The relay is a dumb pipe for MCP: it authenticates the AI app, checks a few HTTP-level
things, and tunnels the HTTP request to the tab over the tab's WebSocket
([protocol](/design/protocol.md)). The tab runs a stateless 2026-07-28 MCP handler on the
tunnelled request and streams the response back. See the [decision log](/decision-log.md)
for why.

```text
 AI app (Claude, ChatGPT, Claude Code, …)
   │  HTTPS: Streamable HTTP POST /a/{id}/mcp, Bearer token (CORS without credentials)
   │  HTTPS: OAuth metadata, /authorize (in the user's browser), /token, /revoke
   ▼
 Relay (Bun.serve) ── tab sessions in memory ── TokenStore (SQLite) ── logs without bodies
   │  WSS /tab, subprotocol tab-mcp.v1, origin allow-list (empty by default)
   ▼
 Page with @ractive-ch/tab-mcp-client
   ├─ core (eager): registerTool registry, events, pairing state
   └─ connection + MCP handler (dynamic import on connect())
```

## Relay endpoints

| Path | Method | Purpose |
|---|---|---|
| `/tab` | GET (WebSocket upgrade) | tab sessions |
| `/a/{id}/mcp` | POST, OPTIONS | the MCP endpoint of one address; GET/DELETE answer 405 |
| `/.well-known/oauth-protected-resource/a/{id}/mcp` | GET | RFC 9728 metadata for that address |
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 metadata (issuer = relay origin) |
| `/authorize` | GET, POST | pairing page in the user's browser: names the AI app and page origin, asks for the code |
| `/authorize.css` | GET | the pairing page's stylesheet (the page has no scripts; DEC-057) |
| `/token` | POST | authorization code + PKCE → tokens; refresh token rotation |
| `/revoke` | POST | RFC 7009 token revocation |
| `/healthz` | GET | health (`{"status":"ok","version":"…","counters":{"claudeHeaderWorkaround":n}}`) |
| `/` | GET | short HTML page: what this relay is, link to the privacy notice |

The metadata endpoints, `/token`, `/revoke` and the MCP endpoint send CORS headers without
credentials (DEC-036), unless `TAB_MCP_CORS=off`.

## Sequence

### 1. The page connects

1. The page registers tools with the library (`registerTool(tool, { signal })`, WebMCP
   shape) and shows a "Connect your AI tool" button. Only the small core is loaded.
2. On click, `connect()` loads the connection and MCP handler (dynamic import), opens
   `wss://relay/tab` with subprotocol `tab-mcp.v1`. The relay checks `Origin` against its
   allow-list and the session limits.
3. The tab sends `hello` with the address secret from `localStorage` (DEC-027). The relay
   derives the address id `base32(sha256(secret))`, replaces an older session of the same
   address (it gets `bye` `replaced`), and answers `session` with the address
   `https://relay/a/{id}/mcp`, the page origin, the limits and the apps already connected
   to this address.

### 2. Pairing (TV sign-in)

1. The page opens its "Connect your AI tool" dialog and sends `pairing.start`. The relay
   answers `pairing.code` with a 6-digit code (single-use, 2 minutes, 5 attempts) and sends
   a fresh one by itself while the dialog is open (DEC-028).
2. The dialog shows the address with a copy button, short instructions per AI app, and
   "When asked, enter the code 123456".
3. The user adds the address to the AI app. claude.ai/Desktop: Settings → Connectors → Add
   custom connector → URL. ChatGPT: developer mode → add app/connector. Claude Code:
   `claude mcp add --transport http calc <address>`.
4. The AI app POSTs to the address without a token. The relay answers `401` with
   `WWW-Authenticate: Bearer resource_metadata="https://relay/.well-known/oauth-protected-resource/a/{id}/mcp", scope="tools"`.
5. The AI app reads the protected-resource metadata (`resource` = the address,
   `authorization_servers` = [relay origin]) and the authorization-server metadata
   (`client_id_metadata_document_supported: true`, `code_challenge_methods_supported:
   ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`,
   `authorization_response_iss_parameter_supported: true`, `grant_types_supported:
   ["authorization_code", "refresh_token"]`).
6. The AI app opens `/authorize?response_type=code&client_id=<its CIMD URL>&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&resource=<address>&scope=tools`
   in the user's browser.
7. The relay validates the request: `resource` has the form of an address; `client_id` is
   an HTTPS URL; it fetches the Client ID Metadata Document (SSRF guards, size and time
   limits, cache) and checks `client_id` equality and that `redirect_uri` is listed. Errors
   before the redirect URI is trusted are shown on the page, never redirected.
8. If the address's tab is not connected, the page says "Open the page and click Connect
   your AI tool" and offers to try again. Otherwise it shows "You're connecting Claude
   (claude.ai) to tools from `https://ractive.ch`" (declared name, verified client host,
   page origin) and a field for the code.
9. The user types the code shown in the tab. A wrong code counts against the code's 5
   attempts. On success the relay redirects to `redirect_uri?code=…&state=…&iss=<relay
   origin>`; "Cancel" redirects with `error=access_denied`.
10. The AI app calls `/token` with the code, `code_verifier`, `redirect_uri`, `client_id`
    and `resource`. The relay checks PKCE S256, single use, 60 s code lifetime and that all
    values match, then creates a grant bound to the address and issues an access token
    (1 h) and a refresh token (30 days) (DEC-029). The tab receives `grant.added` and
    shows "<client> connected" with a Disconnect button.

### 3. Tool calls

1. The AI app POSTs `server/discover`, `tools/list`, `tools/call` with the bearer token.
2. The relay checks (DEC-040): POST, `MCP-Protocol-Version` is `2026-07-28` (else 400 /
   `-32022` naming the supported version, except the one Claude case of DEC-033), body size
   and JSON, the token is valid for this address, the tab is online (else 503 "the page is
   not open"), concurrency. It calls `server.timeout(req, 0)` and starts its own request
   timer (300 s).
3. It sends `http.request` with the filtered headers, the body and the grant. Nothing about
   the token goes to the tab.
4. The tab builds a `Request`, runs its MCP handler, and streams the `Response` back
   (`http.response` or `start`/`chunk`/`end`). If the tab has not answered within 20 s,
   the relay starts the event stream itself and sends keep-alives (DEC-039).
5. For a consequential tool, the library asks in the page before running `execute`
   ("Claude Code wants to run clear_memory. Allow?"); a refusal becomes an `isError`
   result.
6. Tool-list changes (a tool registered or its signal aborted) reach AI apps that hold a
   `subscriptions/listen` stream as `notifications/tools/list_changed` through the tunnel.
   `tools/list` results are `cacheScope: "private"`.
7. If the AI app disconnects, the relay sends `http.cancel` and the tab aborts the request
   signal.
8. When the access token expires, the AI app uses its refresh token at `/token`; it gets a
   new access token and a new refresh token, and the old refresh token stops working.
   Reusing an old refresh token revokes the grant.

### 4. Disconnect and offline

- "Disconnect" next to an app in the page: `grant.revoke`; its tokens stop working at once.
- "New address": the page revokes all grants of the old address (`grants.revokeAll`),
  makes a new secret and connects again.
- Closing the tab, network loss (missed heartbeats), the idle timeout or the session
  lifetime end the WebSocket session only. Grants and tokens stay; MCP calls get 503 "the
  page is not open" until the page connects again with the same secret.

## What lives where

- **Relay memory:** tab sessions, pairing codes, pending authorizations, CIMD cache,
  rate-limit buckets. A relay restart ends all sessions (pages show "disconnected").
- **Token store** (SQLite file by default): grants and SHA-256 hashes of access and refresh
  tokens, with client id and name, address id, scopes and expiry. Survives restarts.
- **Page `localStorage`:** the address secret. "New address" replaces it.
- **Never stored or logged by the relay:** request and response bodies, tool names,
  arguments, results, tokens, codes and secrets (tokens only as hashes in the store).

## Configuration (relay)

The relay is configured per site (DEC-045, DEC-056): `TAB_MCP_SITES` (or
`createRelay({ sites })`) is a JSON array of `{ origin, name?, pairing?, limits? }` with the
instance-wide values below as defaults; `limits` may set `maxMessageBytes`,
`maxConcurrentRequests`, `requestTimeoutMs`, `keepAliveMs`, `idleTimeoutMs`,
`sessionLifetimeMs` and `heartbeatMs` (milliseconds, bytes). `pairing` is `code` (the only
method so far; `oidc` is refused until identity binding exists). The configured sites
together with `TAB_MCP_ALLOWED_ORIGINS` are the origin allow-list; an origin may appear in
only one of them. Example:

```sh
TAB_MCP_SITES='[{"origin":"https://ractive.ch","name":"saturnus","limits":{"maxConcurrentRequests":4}}]'
```

Environment variables with safe defaults; the full list goes to `docs/configuration.md` in
[iteration 5](/iterations/iteration-5-packaging-release.md). Library users pass the same
settings to `createRelay({ … , store })`.

| Variable | Default | Meaning |
|---|---|---|
| `TAB_MCP_PUBLIC_URL` | required | external origin, e.g. `https://relay.ractive.ch` (issuer and address base); `https:` unless development |
| `TAB_MCP_PORT` | `8080` | listen port |
| `TAB_MCP_HOST` | `0.0.0.0` | listen address |
| `TAB_MCP_ALLOWED_ORIGINS` | empty = refuse all tabs | comma-separated page origins allowed to open sessions with the defaults; `*` = open relay (warning at start) |
| `TAB_MCP_SITES` | empty | JSON array of sites with their own name, pairing method or limits (see above) |
| `TAB_MCP_TRUST_PROXY` | `none` | `none`, `x-real-ip` or `x-forwarded-for` (client IP source) |
| `TAB_MCP_CORS` | `on` | `off` drops the CORS headers (DEC-036) |
| `TAB_MCP_STORE` | `sqlite` | `sqlite` or `memory` |
| `TAB_MCP_SQLITE_PATH` | `tab-mcp.db` | SQLite file; the Docker image uses `/data/tab-mcp.db` |
| `TAB_MCP_CLIENT_ID_HOSTS` | empty = any | optional allow-list of CIMD hosts |
| `TAB_MCP_MAX_SESSIONS` / `_PER_IP` | 500 / 5 | session limits |
| `TAB_MCP_MAX_CONCURRENT_REQUESTS` | 8 | per session |
| `TAB_MCP_REQUEST_TIMEOUT_S` | 300 | per MCP request |
| `TAB_MCP_KEEPALIVE_S` | 20 | SSE keep-alive interval and relay-started stream delay |
| `TAB_MCP_IDLE_TIMEOUT_S` | 3600 | session without MCP requests |
| `TAB_MCP_SESSION_LIFETIME_S` | 43200 | absolute WebSocket session lifetime |
| `TAB_MCP_HEARTBEAT_S` | 25 | protocol ping interval |
| `TAB_MCP_BODY_TIMEOUT_S` | 10 | deadline for receiving an MCP request body (408 and close; DEC-048) |
| `TAB_MCP_MAX_MESSAGE_BYTES` | 1048576 | request body and WebSocket message limit; at least 16384 |
| `TAB_MCP_ACCESS_TOKEN_TTL_S` / `TAB_MCP_REFRESH_TOKEN_TTL_S` | 3600 / 2592000 | token lifetimes |
| `TAB_MCP_LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` (never bodies) |

# Citations

- [MCP 2026-07-28 research](/research/mcp-2026-07-28-spec.md)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
- [AI app support research](/research/ai-app-support.md)
- [Bun runtime research](/research/bun-runtime-and-publishing.md)
- [WebMCP registerTool](/research/webmcp-register-tool.md)
- [Decision log](/decision-log.md)
