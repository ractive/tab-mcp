---
type: design
title: "Tab↔relay protocol, version 1"
description: The versioned WebSocket protocol between the browser library and the relay — message types, JSON shapes, errors, heartbeat and limits.
tags:
  - protocol
  - design
timestamp: 2026-10-19T20:00:00+02:00
---

# Tab↔relay protocol, version 1

The browser library (the *tab*) and the relay talk over one WebSocket per tab session. The
protocol tunnels the AI app's MCP HTTP requests to the tab and the tab's HTTP responses
back, and carries the session's control messages (consent, revocation, heartbeat). It knows
nothing about MCP tools: the tab runs the MCP server logic (see
[architecture](/design/architecture.md)).

This document becomes `docs/protocol.md` in the repository in
[iteration 5](/iterations/iteration-5-packaging-release.md); it is the contract third-party
tab implementations would follow.

## Connection

- URL: `wss://<relay>/tab`. The relay refuses the upgrade (HTTP 403, no upgrade) unless the
  `Origin` header is on its allow-list.
- Version negotiation: the tab offers the WebSocket subprotocol `tab-mcp.v1`
  (`Sec-WebSocket-Protocol`). The relay accepts it or refuses the upgrade with HTTP 426 and
  a JSON body `{"error":"unsupported_protocol","supported":["tab-mcp.v1"]}`. A future
  `tab-mcp.v2` is offered alongside v1 during a transition.
- Frames are UTF-8 text, one JSON object each, with a string `type`. Binary frames are a
  protocol error. Unknown `type` values from the peer are ignored (forward compatibility)
  unless the message carries an `id` that expects an answer, in which case the receiver
  answers with `error` code `unknown_type`.
- A session begins only after a user action in the page: the library opens the WebSocket
  only from `connect()`, which pages call from a click handler.

## Message types

Direction: T→R is tab to relay, R→T is relay to tab.

### Session

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `hello` | T→R | `library: {name, version}`, `page: {title}`, `addressKey?` | First message after open. `page.title` is shown on the consent page; it is untrusted. |
| `session` | R→T | `sessionId`, `address`, `expiresAt`, `limits` | The session exists. `address` is the public MCP URL the user gives to the AI app. |
| `ping` | R→T | `t` | Heartbeat, every `limits.heartbeatMs`. |
| `pong` | T→R | `t` | Answer to `ping` with the same `t`. |
| `bye` | both | `reason` | Orderly end; the sender closes the socket after it. |

`addressKey` makes the address stable across sessions: a random 32-byte base64url string
the library keeps in the page's `localStorage`. The relay derives the address id as
`base64url(SHA-256("tab-mcp address v1" ‖ addressKey))`, truncated to 22 characters
(128 bits), so the relay stores nothing between sessions and the address does not reveal
the key. Without `addressKey` the relay picks a random id. If a session with the same
address is already connected, the new one replaces it and the old socket is closed with
4005. Tokens never survive a session, whatever the address.

`sessionId` is a fresh random id per WebSocket and appears only in logs and in this
protocol, never in URLs.

`limits` carries `maxMessageBytes`, `maxBodyBytes`, `requestTimeoutMs`, `idleTimeoutMs`,
`heartbeatMs`, `maxConcurrentRequests` so the tab can show and respect them.

```json
{"type":"session","sessionId":"s_6Gx…","address":"https://relay.ractive.ch/a/k3J9…/mcp",
 "expiresAt":"2026-10-20T08:00:00Z",
 "limits":{"maxMessageBytes":1048576,"maxBodyBytes":1048576,"requestTimeoutMs":120000,
           "idleTimeoutMs":3600000,"heartbeatMs":25000,"maxConcurrentRequests":8}}
```

### Consent and grants

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `auth.request` | R→T | `authId`, `client`, `code`, `expiresAt` | An AI app opened `/authorize` for this session. |
| `auth.decision` | T→R | `authId`, `allow` | The user's answer in the page. |
| `auth.cancelled` | R→T | `authId`, `reason` | Expired, browser left the `/authorize` page, or superseded. |
| `grant.added` | R→T | `grantId`, `client` | A token was issued after an `allow`. |
| `grant.revoke` | T→R | `grantId` | The user removes one connected app in the page. |
| `grant.removed` | R→T | `grantId`, `reason` | A grant ended (revoked, expired). |

`client` is what the relay learned from the Client ID Metadata Document:

```json
{"id":"https://claude.ai/oauth/claude-code-client-metadata","name":"Claude Code",
 "uri":"https://claude.ai","redirectHost":"localhost","logoUri":null}
```

`name` is self-declared by the client and shown as such; `id` and `redirectHost` are the
verified parts. `code` is a 4-digit string that the `/authorize` page shows too; the user
approves only if both match.

### Tunnelled MCP requests

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `http.request` | R→T | `id`, `method`, `path`, `headers`, `body`, `grant` | One HTTP request to the session's MCP address. |
| `http.response` | T→R | `id`, `status`, `headers`, `body` | Complete response in one message (JSON or empty). |
| `http.response.start` | T→R | `id`, `status`, `headers` | Start of a streamed (SSE) response. |
| `http.response.chunk` | T→R | `id`, `data` | Next piece of the body (UTF-8 text). |
| `http.response.end` | T→R | `id` | End of a streamed response. |
| `http.cancel` | R→T | `id`, `reason` | The AI app closed the connection or the request timed out. |

- `id` is a relay-chosen string, unique per session.
- `headers` is a lower-case object restricted to the forwarded set: `content-type`,
  `accept`, `mcp-protocol-version`, `mcp-method`, `mcp-name`, `mcp-param-*`,
  `traceparent`, `tracestate`. The relay never forwards `authorization`, `cookie`, IP
  addresses or `x-forwarded-*`.
- `body` is the request body as a string (already size-checked and JSON-parsed once by the
  relay, then forwarded verbatim).
- `grant` identifies the caller: `{"grantId":"g_…","clientId":"https://…","scopes":["tools"]}`.
  The tab passes it to the MCP handler as `authInfo`.
- Response `headers` are filtered by the relay to `content-type`, `cache-control`,
  `x-accel-buffering`; the relay sets the rest.
- A response must end within `requestTimeoutMs`, except for `subscriptions/listen`
  (recognised by `mcp-method`), which may stay open for the session's lifetime. Streams are
  counted against `maxConcurrentRequests`.
- The tab answers `tools/call` with a streamed SSE response that starts at once (the SDK's
  `responseMode: "sse"`), because CDNs in front of the relay give up when no response
  headers arrive within 60 s (bunny.net) and a confirmation in the page can take longer.
  Other methods may answer with one `http.response`.
- On streamed responses the relay writes an SSE comment (`: keep-alive`) to the AI app
  every 20 s while the tab is silent, but only at an event boundary (when the bytes
  forwarded so far end with a blank line). The tab never needs to send keep-alives.
- `http.cancel` aborts the tab's `Request.signal`; the tab sends nothing more for that `id`.
  Late messages for a cancelled `id` are dropped silently.

Example:

```json
{"type":"http.request","id":"r42","method":"POST","path":"/mcp",
 "headers":{"content-type":"application/json","accept":"application/json, text/event-stream",
            "mcp-protocol-version":"2026-07-28","mcp-method":"tools/call","mcp-name":"press_keys"},
 "body":"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{…}}",
 "grant":{"grantId":"g_1","clientId":"https://claude.ai/oauth/claude-code-client-metadata","scopes":["tools"]}}
```

### Errors

`{"type":"error","code":"…","message":"…","id":"r42"?}` in either direction. `id` refers to
the request or auth exchange it concerns, if any.

| Code | Sent by | Meaning |
|---|---|---|
| `bad_message` | both | Not JSON, missing fields, binary frame. |
| `unknown_type` | both | Message type not understood but an answer was expected. |
| `unknown_id` | both | `id`/`authId`/`grantId` not known (or already finished). |
| `too_large` | relay | A message exceeded `maxMessageBytes`; the relay answers the AI app with 502. |
| `rate_limited` | relay | The tab sent too much; the relay may close with 4008. |

Tab-side failures of an MCP request are not protocol errors: the tab answers with an HTTP
status and a JSON-RPC error body, as the MCP handler produced it.

## Close codes

| Code | Meaning |
|---|---|
| 1000 | Normal close (`bye`, user pressed Disconnect). |
| 1008 | Policy violation (bad message after warning). |
| 1009 | Message too large. |
| 4001 | Session expired (absolute lifetime). |
| 4002 | Idle timeout (no MCP request for `idleTimeoutMs`). |
| 4003 | Heartbeat lost. |
| 4004 | Relay shutting down. |
| 4005 | Replaced by a newer session for the same address. |
| 4008 | Rate limited. |

On any close the relay ends the session: pending HTTP requests get `503` with a JSON-RPC
error, listen streams end, every grant and token of the session is deleted, pending
authorizations are cancelled. A stable address answers "tab not connected" until the page
connects again; the AI app then has to authorize again.
The library never reconnects on its own, because a session needs a user action.

## Heartbeat

Browsers cannot send WebSocket pings from JavaScript, so the heartbeat is in the protocol:
the relay sends `ping` every `heartbeatMs` (default 25 s); the tab answers `pong`. The
relay closes with 4003 after two missed pongs; the tab treats two missed pings as a dead
connection and shows the session as ended. The relay also enables Bun's protocol-level
pings so proxies keep the connection open.

## Limits (defaults)

| Limit | Default | Where |
|---|---|---|
| WebSocket message | 1 MiB | both |
| MCP request body | 1 MiB | relay (HTTP 413) |
| Request timeout | 120 s | relay (504 and `http.cancel`) |
| Concurrent requests per session | 8 | relay (429) |
| Idle timeout | 60 min | relay (close 4002) |
| Session lifetime | 12 h | relay (close 4001) |
| Pending authorizations per session | 3 | relay |

All are configurable on the relay; see the threat model for why each exists.

# Citations

- [MCP 2026-07-28 research](/research/mcp-2026-07-28-spec.md)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
- [RFC 6455 WebSocket close codes](https://www.rfc-editor.org/rfc/rfc6455#section-7.4)
