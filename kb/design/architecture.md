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
timestamp: 2026-11-12T16:30:00+01:00
---

# tab-mcp architecture

A web page offers some of its functions as MCP tools. The page connects to a tab-mcp relay,
where its app has one public MCP address, the same for every page of the app (DEC-196).
The user adds the address to an AI app and pairs it with a code shown in the page, which
selects the page; the AI app then calls the tools through the relay while the tab is
open. Nothing is installed on the user's computer.

[WebMCP](https://webmachinelearning.github.io/webmcp/) (`document.modelContext`) offers a
page's tools to agents in the browser; tab-mcp offers them to AI apps outside it. The
library can do both (`webmcp: true`, DEC-115), and the tab-mcp browser extension passes on the
WebMCP tools of the page in front, in a tab the user gave it (a click on its icon, or
"Give access to all sites"), top frame only, through the relay
([extension](/design/extension.md)).

The overview for readers, with the two paths in one picture (a page with the library in
any browser; a page with WebMCP tools only, in Chrome with the extension), is the
README's "How the parts fit together" and `docs/overview.svg`. ractive.ch shows a copy
of the picture with a short version of the text (`static/images/tab-mcp-overview.svg`
and `src/pages/tab-mcp/index.vto` in ractive.ch). A change to the parts or to what a
path needs goes into all of them.

## Components

| Component | Package | Runs | Knows |
|---|---|---|---|
| Browser library | `@ractive-ch/tab-mcp-client` | in the page | the tools, the MCP server logic (loaded on `connect()`), the pairing and confirmation UI, the address secret |
| Relay | `@ractive-ch/tab-mcp`, Docker `ractive/tab-mcp` and `ghcr.io/ractive/tab-mcp` | Bun server | tab sessions, OAuth (authorization server and resource server), limits; **not** tools |
| Token store | `TokenStore` interface in the relay package | SQLite file (default), memory, or the library user's own | grants and token hashes per address id (one page), each with its app |
| Browser's WebMCP (optional) | none: the browser's `document.modelContext` | in the page, with `webmcp: true` | the tools the library mirrors there, for agents in the browser; calls never pass the relay (DEC-115, DEC-119) |
| The site's own assistant (optional) | `@ractive-ch/tab-mcp-client/tunnel` (`createTunnelFetch`) at the caller's end | wherever the site runs it, e.g. its backend behind a chat frame on the page | the tools, through `mcp.serve(port)`: the relay's `http.*` messages over a port the page hands out; no relay, pairing or address, and `relay` may be left out (iteration 28, DEC-122 to DEC-126); its own question per port and a time limit per request, and `callers` per tool says which of the three callers see a tool (iteration 40, DEC-164 to DEC-167) |
| tab-mcp browser extension | `packages/tab-mcp-extension` | Chrome extension, connected to the relay as `chrome-extension://<id>` | the WebMCP tools of the tab in front, its own address secret; its app id is fixed ([extension](/design/extension.md)) |
| End-to-end test page | `test/e2e` | served by the e2e test, against a relay the test starts | four-function calculator with `press_keys`, `read_display`, `clear`, `clear_memory` (consequential); the live examples are on ractive.ch (DEC-080) |

The relay is a dumb pipe for MCP: it authenticates the AI app, checks a few HTTP-level
things, and tunnels the HTTP request to the tab over the tab's WebSocket
([protocol](/design/protocol.md)). The tab runs a stateless 2026-07-28 MCP handler on the
tunnelled request and streams the response back. See the [decision log](/decision-log.md)
for why.

```text
 AI app (Claude, ChatGPT, Claude Code, …)
   │  HTTPS: Streamable HTTP POST /s/{app}/mcp, Bearer token (CORS without credentials)
   │  HTTPS: OAuth metadata, /authorize (in the user's browser), /token, /revoke
   ▼
 Relay (Bun.serve) ── tab sessions in memory ── TokenStore (SQLite) ── logs without bodies
   │  WSS /tab, subprotocol tab-mcp.v1, origin allow-list (empty by default)
   ▼
 Page with @ractive-ch/tab-mcp-client
   ├─ core (eager): registerTool registry, events, pairing state
   └─ connection + MCP handler (dynamic import on connect(), serve() or a WebMCP call)
        ▲  the same http.* messages over a MessagePort: mcp.serve(port, { client })
        │
 The site's own assistant (chat frame ⇄ its backend, createTunnelFetch), no relay
```

## Relay endpoints

| Path | Method | Purpose |
|---|---|---|
| `/tab` | GET (WebSocket upgrade) | tab sessions; the page names its app and proves its secret in `hello` |
| `/s/{app}/mcp` | POST, OPTIONS | the MCP endpoint of one app (DEC-196); the token says which page; GET/DELETE answer 405 |
| `/.well-known/oauth-protected-resource/s/{app}/mcp` | GET | RFC 9728 metadata for that address |
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 metadata (issuer = relay origin) |
| `/authorize` | GET, POST | pairing page in the user's browser: names the AI app and the app of the address, asks for the code |
| `/authorize/callback` | GET | the return from the OpenID Connect provider (identity binding, DEC-079) |
| `/authorize.css` | GET | the pairing page's stylesheet (the page's only script is the code field's, inline and allowed by its hash; DEC-057, DEC-211) |
| `/token` | POST | authorization code + PKCE → tokens; refresh token rotation |
| `/revoke` | POST | RFC 7009 token revocation |
| `/healthz` | GET | health (`{"status":"ok","version":"…","counters":{"claudeHeaderWorkaround":n}}`); 503 with a reason when the token store does not answer (DEC-099) |
| `/` | GET | short HTML page: what this relay is, link to the privacy notice |

The metadata endpoints, `/token`, `/revoke` and the MCP endpoint send CORS headers without
credentials (DEC-036), unless `TAB_MCP_CORS=off`.

## Sequence

### 1. The page connects

1. The page registers tools with the library (`registerTool(tool, { signal })`, WebMCP
   shape) and shows a "Connect your AI app" button. Only the small core is loaded.
2. On click, `connect()` loads the connection and MCP handler (dynamic import) and opens
   `wss://relay/tab` with subprotocol `tab-mcp.v1`. The relay checks `Origin` against
   its allow-list and the session limits.
3. The tab sends `hello` with its app id (`app.id`: the library's `app` option, else
   derived from `server.name`, DEC-196) and the address secret from `localStorage`
   (DEC-027). The relay checks that the page's origin may serve that app (`sites[].apps`,
   DEC-197; else `app_not_allowed` and close 1008), derives the address id from the app
   and the secret together, `base32(sha256(app + "\n" + secret))` (DEC-196, amending
   DEC-027: the same secret under another app is another page), replaces an older
   session of the same address id (it gets `bye` `replaced`), and answers `session` with
   the app's address
   `https://relay/s/{app}/mcp`, the page origin, the limits and the apps already
   connected to this page.

### 2. Pairing (TV sign-in)

1. The page opens its "Connect your AI app" dialog and sends `pairing.start`. The relay
   answers `pairing.code` with a code of 8 letters, sent as `XXXX-XXXX` (single-use, 2
   minutes, unique among the relay's live codes), and sends a fresh one by itself while
   the dialog is open (DEC-028, DEC-196).
2. The dialog shows the address with a copy button, short instructions per AI app, and
   the code.
3. The user adds the address to the AI app. claude.ai/Desktop: Settings → Connectors → Add
   custom connector → URL. ChatGPT: developer mode → add app/connector. Claude Code:
   `claude mcp add --transport http calc <address>`. The address is the same for every
   page of the app, so an organisation's Owner can add it once for all members.
4. The AI app POSTs to the address without a token. The relay answers `401` with
   `WWW-Authenticate: Bearer resource_metadata="https://relay/.well-known/oauth-protected-resource/s/{app}/mcp", scope="tools"`.
5. The AI app reads the protected-resource metadata (`resource` = the address,
   `authorization_servers` = [relay origin]) and the authorization-server metadata
   (`client_id_metadata_document_supported: true`, `code_challenge_methods_supported:
   ["S256"]`, `token_endpoint_auth_methods_supported: ["none", "private_key_jwt"]`
   (DEC-106),
   `authorization_response_iss_parameter_supported: true`, `grant_types_supported:
   ["authorization_code", "refresh_token"]`).
6. The AI app opens `/authorize?response_type=code&client_id=<its CIMD URL>&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&resource=<address>&scope=tools`
   in the user's browser.
7. The relay validates the request: `resource` is the address of an app on this relay;
   `client_id` is an HTTPS URL; it fetches the Client ID Metadata Document (SSRF guards,
   size and time limits, cache) and checks `client_id` equality and that `redirect_uri`
   is listed. Errors before the redirect URI is trusted are shown on the page, never
   redirected.
8. The relay always shows the pairing form; it does not look whether a page of the app
   is connected, so the page tells nothing about that. Its heading is "Connect Claude
   from claude.ai" and it says "You're connecting Claude (claude.ai) to saturnus: to the
   page or browser extension in this browser that shows the code." (declared name,
   verified client host, the app id from the address; nothing a page sent), with a field
   for the code. For an app that pairs by sign-in only, it says "… to saturnus: to the
   page in this browser that is signed in with your account." and has no code field. Which pairing methods the form offers comes
   from the configuration alone (`pairingKindsOf`). The form carries `data-tab-mcp-*` hooks for an extension in
   the same browser (DEC-199).
9. The user types the code shown in the tab, in any case, with or without the dash. The
   field is one input drawn as `▢▢▢▢-▢▢▢▢`; its script keeps the text as `XXXX-XXXX`
   while typing and pasting, and without it the field is a plain input (DEC-211). The
   relay finds the session that shows this code in its index of live codes; it counts
   only if that session is a page of the address's app. A wrong or expired code gets one
   message and is charged to the network's guesses (10, then 1 a minute; a sign-in is
   charged when it starts and given back when it pairs); there are no attempts per code. On success the relay redirects to
   `redirect_uri?code=…&state=…&iss=<relay origin>`; "Cancel" redirects with
   `error=access_denied`.
10. The AI app calls `/token` with the code, `code_verifier`, `redirect_uri`, `client_id`
    and `resource`, and a `private_key_jwt` client also with a signed `client_assertion`
    (DEC-106). The relay checks PKCE S256, single use, 60 s code lifetime and that all
    values match, then creates a grant bound to the page's address id, with the app in
    its token records, and issues an access token (1 h) and a refresh token (30 days)
    (DEC-029). The tab receives `grant.added` and shows "<client> connected" with a
    Disconnect button.

### 3. Tool calls

1. The AI app POSTs `server/discover`, `tools/list`, `tools/call` with the bearer token.
2. The relay checks (DEC-040): POST, `MCP-Protocol-Version` is `2026-07-28` (else 400 /
   `-32022` naming the supported version, except the one Claude case of DEC-033), body size
   and JSON, the token is valid and its record names the app of this address (the record's
   address id says which page the request is for), the page's tab is online (else it
   waits up to `TAB_MCP_PAGE_WAIT_S` for it and then answers "the page is not open" at
   HTTP 200; DEC-074), concurrency. It calls `server.timeout(req, 0)` and starts its own
   request timer (300 s).
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
- "Disconnect all apps" (`disconnectAll()`): the page connects with the old secret and
  `hello.revokeAll`, so the relay revokes all grants of the old address id (DEC-095),
  then makes a new secret and connects again. The address stays: it is the app's. Each
  AI app pairs again with a new code.
- Closing the tab, network loss (missed heartbeats), the idle timeout or the session
  lifetime end the WebSocket session only. Grants and tokens stay; MCP calls get "the page
  is not open" (HTTP 200, DEC-074) until the page connects again with the same secret.

## What lives where

- **Relay memory:** tab sessions, pairing codes and the index that finds a session by its
  code, pending authorizations, OIDC sign-ins in progress, authorization codes, the `jti`
  replay cache, CIMD and JWKS caches, rate-limit buckets. A relay restart ends all
  sessions (pages show "disconnected").
- **Token store** (SQLite file by default): grants and SHA-256 hashes of access and refresh
  tokens, with client id and name, address id, app, scopes and expiry. Survives restarts.
- **Page `localStorage`:** the address secret. "Disconnect all apps" replaces it.
- **Never stored or logged by the relay:** request and response bodies, tool names,
  arguments, results, tokens, codes and secrets (tokens only as hashes in the store).

## Several instances

Not supported: a relay is one instance (DEC-198, which withdraws DEC-098). A typed
pairing code must reach the process whose page shows it, and neither the address nor the
form post says which one that is. What it would take is in DEC-198.

## Configuration (relay)

The relay is configured per site (DEC-045, DEC-056): `TAB_MCP_SITES` (or
`createRelay({ sites })`) is a JSON array of `{ origin, name?, apps?, pairing?, limits? }`
with the instance-wide values below as defaults; `limits` may set `maxMessageBytes`,
`maxConcurrentRequests`, `requestTimeoutMs`, `keepAliveMs`, `idleTimeoutMs`,
`sessionLifetimeMs` and `heartbeatMs` (milliseconds, bytes). `pairing` is `code` or `oidc`
(identity binding, DEC-079); without it the site takes `TAB_MCP_IDENTITY`. `apps` lists the
app ids the origin serves (DEC-197): its pages may name only these, and no origin that
does not list an app may serve it; an app no site lists is open to every allowed origin.
The configured sites together with `TAB_MCP_ALLOWED_ORIGINS` are the origin allow-list; an
origin may appear in only one of them. Example:

```sh
TAB_MCP_SITES='[{"origin":"https://ractive.ch","name":"saturnus","apps":["saturnus"],"limits":{"maxConcurrentRequests":4}}]'
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
| `TAB_MCP_SITES` | empty | JSON array of sites with their own name, apps, pairing method or limits (see above) |
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
| `TAB_MCP_UNPAIRED_IDLE_TIMEOUT_S` | 600 | session that never had a grant, started pairing, signed in or got a request (DEC-117) |
| `TAB_MCP_SESSION_LIFETIME_S` | 43200 | absolute WebSocket session lifetime |
| `TAB_MCP_HEARTBEAT_S` | 25 | protocol ping interval |
| `TAB_MCP_BODY_TIMEOUT_S` | 10 | deadline for receiving an MCP request body (408 and close; DEC-048) |
| `TAB_MCP_PAGE_WAIT_S` | 10 | how long an MCP request waits for its page before "the page is not open"; 0 = at once, at most 60 (DEC-074) |
| `TAB_MCP_MAX_MESSAGE_BYTES` | 1048576 | request body and WebSocket message limit; at least 16384 |
| `TAB_MCP_ACCESS_TOKEN_TTL_S` / `TAB_MCP_REFRESH_TOKEN_TTL_S` | 3600 / 2592000 | token lifetimes |
| `TAB_MCP_GRANT_LIFETIME_S` | 7776000 | absolute end of a connection after pairing; refreshes never go beyond it (DEC-062) |
| `TAB_MCP_LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` (never bodies) |
| `TAB_MCP_IDENTITY` | `code` | pairing of sites without their own: `code` or `oidc` (DEC-079) |
| `TAB_MCP_OIDC_ISSUER` / `TAB_MCP_OIDC_CLIENT_ID` / `TAB_MCP_OIDC_CLIENT_SECRET` | none | the relay as a client of the OpenID Connect provider (secret optional) |
| `TAB_MCP_OIDC_SUBJECT_CLAIM` | `sub` | `sub` or `oid`, the claim compared |
| `TAB_MCP_TAB_ASSERTION_ISSUER` / `TAB_MCP_TAB_ASSERTION_JWKS_URL` | none | the web app backend that signs tab assertions (DEC-076) |

# Citations

- [MCP 2026-07-28 research](/research/mcp-2026-07-28-spec.md)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
- [AI app support research](/research/ai-app-support.md)
- [Bun runtime research](/research/bun-runtime-and-publishing.md)
- [WebMCP registerTool](/research/webmcp-register-tool.md)
- [Decision log](/decision-log.md)
