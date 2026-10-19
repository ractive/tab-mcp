---
type: design
title: "tab-mcp architecture"
description: Components, endpoints, data flow and the full sequence from a page connecting to an AI app calling its tools and the user disconnecting.
tags:
  - architecture
  - design
timestamp: 2026-10-19T20:00:00+02:00
---

# tab-mcp architecture

A web page offers some of its functions as MCP tools. The page connects to a tab-mcp relay
and gets a public MCP address. The user adds the address to an AI app; the AI app calls
the tools through the relay while the tab stays open. Nothing is installed on the user's
computer.

## Components

| Component | Package | Runs | Knows |
|---|---|---|---|
| Browser library | `@ractive-ch/tab-mcp-client` | in the page | the tools, the MCP server logic (via the MCP SDK), the consent and confirmation UI |
| Relay | `@ractive-ch/tab-mcp`, Docker `ractive/tab-mcp` | Bun server | sessions, addresses, OAuth (authorization server and resource server), limits; **not** tools |
| Example | `examples/calculator` | static page | four-function calculator with `press_keys`, `read_display`, `clear`, `clear_memory` (consequential) |

The relay is a dumb pipe for MCP: it authenticates the AI app, checks a few HTTP-level
things, and tunnels the HTTP request to the tab over the tab's WebSocket
([protocol](/design/protocol.md)). The tab runs the MCP SDK's stateless handler
(`createMcpHandler`, 2026-07-28 only) on the tunnelled request and streams the response
back. See the [decision log](/decision-log.md) for why.

```text
 AI app (Claude, ChatGPT, Claude Code, …)
   │  HTTPS: Streamable HTTP POST /a/{id}/mcp, Bearer token
   │  HTTPS: OAuth metadata, /authorize (in the user's browser), /token
   ▼
 Relay (Bun.serve) ── sessions, grants, tokens in memory ── logs without bodies
   │  WSS /tab, subprotocol tab-mcp.v1, origin allow-list
   ▼
 Page with @ractive-ch/tab-mcp-client
   └─ createMcpHandler(McpServer with the page's registered tools)
```

## Relay endpoints

| Path | Method | Purpose |
|---|---|---|
| `/tab` | GET (WebSocket upgrade) | tab sessions |
| `/a/{id}/mcp` | POST | the MCP endpoint of one address; GET/DELETE answer 405 |
| `/.well-known/oauth-protected-resource/a/{id}/mcp` | GET | RFC 9728 metadata for that address |
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 metadata (issuer = relay origin) |
| `/authorize` | GET | consent page in the user's browser |
| `/authorize/wait` | GET | the consent page's long-poll for the tab's decision |
| `/token` | POST | authorization code + PKCE → access token |
| `/revoke` | POST | RFC 7009 token revocation |
| `/healthz` | GET | health (`{"status":"ok","version":"…"}`) |
| `/` | GET | short HTML page: what this relay is, link to the privacy notice |

## Sequence

### 1. The page connects

1. The page registers tools with the library (`registerTool(tool, { signal })`, WebMCP
   shape) and shows a "Connect AI app" button.
2. On click, `connect()` opens `wss://relay/tab` with subprotocol `tab-mcp.v1`. The relay
   checks `Origin` against its allow-list and the per-IP session limit.
3. The tab sends `hello` (library version, page title, `addressKey` from `localStorage`).
   The relay derives the address id and answers `session` with the address
   `https://relay/a/{id}/mcp` and the limits.
4. The page shows the address with a copy button and short instructions per AI app, plus a
   "Disconnect" button and the list of connected apps (empty).

### 2. The user adds the address to an AI app

claude.ai/Desktop: Settings → Connectors → Add custom connector → URL. ChatGPT: developer
mode → add app/connector. Claude Code: `claude mcp add --transport http calc <address>`.

### 3. OAuth with code comparison

1. The AI app POSTs to the address without a token. The relay answers `401` with
   `WWW-Authenticate: Bearer resource_metadata="https://relay/.well-known/oauth-protected-resource/a/{id}/mcp", scope="tools"`.
2. The AI app reads the protected-resource metadata (`resource` = the address,
   `authorization_servers` = [relay origin]) and the authorization-server metadata
   (`client_id_metadata_document_supported: true`, `code_challenge_methods_supported:
   ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`,
   `authorization_response_iss_parameter_supported: true`).
3. The AI app opens `/authorize?response_type=code&client_id=<its CIMD URL>&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&resource=<address>&scope=tools`
   in the user's browser.
4. The relay validates the request: `resource` is a known address; `client_id` is an HTTPS
   URL; it fetches the Client ID Metadata Document (SSRF guards, size and time limits,
   cache) and checks `client_id` equality and that `redirect_uri` is listed. Errors before
   the redirect URI is trusted are shown on the page, never redirected.
5. If the address's tab is not connected, the page says so and waits up to 5 minutes for it
   to connect.
6. The relay creates a pending authorization with a random 4-digit code, sends
   `auth.request` to the tab and renders the page: client name (as declared), client id
   host and redirect host (verified), the page title, the code, "Approve in your tab".
   It sets a `__Host-` cookie that binds the waiting page to this browser.
7. The tab shows "Claude Code wants to connect. Code 4711. Allow?" with the same verified
   hosts. If more than one authorization is pending at once, the tab says so and warns
   that someone else may know the address.
8. The user compares the codes and clicks Allow in the tab. The tab sends `auth.decision`.
9. The `/authorize/wait` long-poll returns, and the page redirects to
   `redirect_uri?code=…&state=…&iss=<relay origin>`. Deny or timeout redirects with
   `error=access_denied`.
10. The AI app calls `/token` with the code, `code_verifier`, `redirect_uri`, `client_id`
    and `resource`. The relay checks PKCE S256, single use, 60 s code lifetime and that all
    values match, then issues an opaque random access token bound to (address, session,
    grant, client id, scope). No refresh token. `expires_in` is the session's remaining
    lifetime. The tab receives `grant.added` and lists the app as connected.

### 4. Tool calls

1. The AI app POSTs `server/discover`, `tools/list`, `tools/call` with the bearer token.
2. The relay checks: address known and tab connected, `MCP-Protocol-Version` is
   `2026-07-28` (else 400 / `-32022` naming the supported version), token valid for this
   address and session, body size, JSON, rate and concurrency limits. It calls
   `server.timeout(req, 0)` and starts its own request timer.
3. It sends `http.request` with the filtered headers, the body and the grant. Nothing about
   the token goes to the tab.
4. The tab builds a `Request`, calls `handler.fetch(request, { parsedBody, authInfo })`,
   and streams the `Response` back (`http.response` or `start`/`chunk`/`end`).
5. For a consequential tool, the library asks in the page before running `execute`
   ("Claude Code wants to run clear_memory. Allow?"); a refusal becomes an `isError`
   result.
6. Tool-list changes (a tool registered or its signal aborted) call
   `handler.notify.toolsChanged()`; AI apps that hold a `subscriptions/listen` stream get
   `notifications/tools/list_changed` through the tunnel. `tools/list` results are
   `cacheScope: "private"`.
7. If the AI app disconnects, the relay sends `http.cancel` and the tab aborts the request
   signal.

### 5. Disconnect

- "Disconnect" in the page: the tab sends `bye` and closes; the relay deletes the session,
  its grants and tokens, ends listen streams and fails pending requests with 503.
- Removing one app in the page: `grant.revoke`; its token stops working at once.
- Closing the tab, network loss (missed heartbeats), idle timeout or the session lifetime
  end the session the same way. The next request from the AI app gets 404 "tab not
  connected"; after the page connects again the AI app must authorize again.

## What lives where

- **Relay memory only:** sessions, pending authorizations, grants, token hashes, CIMD cache,
  rate-limit buckets. Nothing is written to disk. A relay restart ends all sessions.
- **Page `localStorage`:** the `addressKey` (so the address stays the same on the next
  visit). "New address" in the page replaces it.
- **Never stored or logged by the relay:** request and response bodies, tool names,
  arguments, results, tokens (only SHA-256 hashes in memory).

## Configuration (relay)

Environment variables with safe defaults; the full list goes to `docs/configuration.md` in
[iteration 5](/iterations/iteration-5-packaging-release.md).

| Variable | Default | Meaning |
|---|---|---|
| `TAB_MCP_PUBLIC_URL` | required | external origin, e.g. `https://relay.ractive.ch` (issuer and address base) |
| `TAB_MCP_PORT` | `8080` | listen port |
| `TAB_MCP_ALLOWED_ORIGINS` | empty = refuse all tabs | comma-separated page origins allowed to open sessions |
| `TAB_MCP_TRUST_PROXY` | `none` | `none`, `x-real-ip` or `x-forwarded-for` (client IP source) |
| `TAB_MCP_CLIENT_ID_HOSTS` | empty = any | optional allow-list of CIMD hosts |
| `TAB_MCP_MAX_SESSIONS` / `_PER_IP` | 500 / 5 | session limits |
| `TAB_MCP_REQUEST_TIMEOUT_S` | 120 | per MCP request |
| `TAB_MCP_IDLE_TIMEOUT_S` | 3600 | session without MCP requests |
| `TAB_MCP_SESSION_LIFETIME_S` | 43200 | absolute session lifetime |
| `TAB_MCP_MAX_BODY_BYTES` | 1048576 | request body and WebSocket message limit |
| `TAB_MCP_LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` (never bodies) |

# Citations

- [MCP 2026-07-28 research](/research/mcp-2026-07-28-spec.md)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
- [AI app support research](/research/ai-app-support.md)
- [Bun runtime research](/research/bun-runtime-and-publishing.md)
- [WebMCP registerTool](/research/webmcp-register-tool.md)
