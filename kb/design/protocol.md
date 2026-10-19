---
type: design
title: "Tab↔relay protocol, version 1"
description: >-
  The versioned WebSocket protocol between the browser library and the relay —
  message types (session, pairing, grants, tunnel), JSON shapes, errors, heartbeat
  and limits.
tags:
  - protocol
  - design
timestamp: 2026-10-20T18:00:00+02:00
---

# Tab↔relay protocol, version 1

The browser library (the *tab*) and the relay talk over one WebSocket per tab session. The
protocol tunnels the AI app's MCP HTTP requests to the tab and the tab's HTTP responses
back, and carries the session's control messages (pairing, grants, heartbeat). It knows
nothing about MCP tools: the tab runs the MCP server logic (see
[architecture](/design/architecture.md)).

This document becomes `docs/protocol.md` in the repository in
[iteration 5](/iterations/iteration-5-packaging-release.md); it is the contract third-party
tab implementations would follow.

## Connection

- URL: `wss://<relay>/tab`. The relay refuses the upgrade (HTTP 403, no upgrade) unless the
  `Origin` header is on its allow-list (DEC-032; default empty = nobody).
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
- The tab must send `hello` within 10 s of the open, else the relay closes with 1008.

## Message types

Direction: T→R is tab to relay, R→T is relay to tab.

### Session

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `hello` | T→R | `library: {name, version}`, `page: {title}`, `app?: {name}`, `secret` | First message after open. `page.title` is untrusted and never logged. `app.name` (e.g. `saturnus`: 1-64 characters, no control characters, else `bad_message` and close 1008) is self-declared and shown on `/authorize` unless the site configures a name (DEC-045, DEC-056). |
| `session` | R→T | `sessionId`, `address`, `origin`, `appName?`, `expiresAt`, `limits`, `grants` | The session exists. `address` is the public MCP URL the user gives to the AI app. |
| `ping` | R→T | `t` | Heartbeat, every `limits.heartbeatMs`. |
| `pong` | T→R | `t` | Answer to `ping` with the same `t`. |
| `bye` | both | `reason` | Orderly end; the sender closes the socket after it. Reasons from the relay: `replaced`, `expired`, `idle`, `shutdown`. |

`secret` makes the address stable across sessions (DEC-027): 32 random bytes as base64url
without padding (43 characters), kept by the library in the page's `localStorage`. The relay
derives the address id as `base32(sha256(secret))` (SHA-256 over the secret's UTF-8 text,
RFC 4648 base32, lower case, no padding, 52 characters), so it stores nothing to recognise
an address and the address does not reveal the secret. A `hello` without a well-formed
`secret` gets `error` `bad_message` and close 1008. If a session with the same address is
already connected, the new one replaces it: the old tab gets `bye` with reason `replaced`
and close 4005.

`sessionId` is a fresh random id per WebSocket and appears only in logs and in this
protocol, never in URLs. `origin` is the page origin the relay saw on the upgrade (shown on
`/authorize`); `appName` is the name `/authorize` will show (the site's configured name, else
the page's `app.name`; absent if neither exists). `limits` are the site's limits (DEC-045).
`grants` lists the AI apps connected to this address (see below).

`limits` carries `maxMessageBytes`, `maxBodyBytes`, `requestTimeoutMs`, `idleTimeoutMs`,
`heartbeatMs`, `keepAliveMs`, `maxConcurrentRequests` so the tab can show and respect them.
`maxMessageBytes` is at least 16 384 (DEC-056).

```json
{"type":"session","sessionId":"s_6Gx…","origin":"https://ractive.ch",
 "address":"https://relay.ractive.ch/a/mzxw6ytboi4dmnrqgq3tm…/mcp",
 "expiresAt":"2026-10-20T08:00:00.000Z","grants":[],
 "limits":{"maxMessageBytes":1048576,"maxBodyBytes":1048576,"requestTimeoutMs":300000,
           "idleTimeoutMs":3600000,"heartbeatMs":25000,"keepAliveMs":20000,
           "maxConcurrentRequests":8}}
```

### Pairing and grants

Pairing works like a TV sign-in (DEC-028): the tab shows the address and a code, the user
types the code on the relay's `/authorize` page.

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `pairing.start` | T→R | — | The page's "Connect your AI tool" dialog is open; the relay starts issuing codes (only on sites whose pairing method is `code`). Sent again while codes are on, it repeats the current code. |
| `pairing.code` | R→T | `code`, `expiresAt` | The code to show: 6 digits, single-use, 2 minutes, 5 attempts. A fresh one follows by itself after expiry, use or 5 failed attempts while pairing is on. |
| `pairing.stop` | T→R | — | The dialog closed; the current code becomes invalid and no more codes come. |
| `grant.added` | R→T | `grant` | An AI app finished pairing (the token endpoint issued its first tokens). |
| `grant.revoke` | T→R | `grantId` | The user pressed Disconnect for one app; its tokens stop working at once. A grant that is not this address's gets `error` `unknown_id`. |
| `grants.revokeAll` | T→R | — | Revoke every grant of this address (used before "New address"). |
| `grant.removed` | R→T | `grantId`, `reason` | A grant ended: `revoked` (Disconnect, `/revoke`, "New address") or `reuse_detected` (an authorization code or refresh token was presented twice). `expired` is reserved; grants that simply run out are not announced. |

A grant as the tab sees it:

```json
{"grantId":"g_…","client":{"id":"https://claude.ai/oauth/claude-code-client-metadata",
 "name":"Claude Code","host":"claude.ai"},"createdAt":"2026-10-19T20:00:00.000Z"}
```

`client.name` is self-declared in the Client ID Metadata Document (cleaned: no control or
bidi characters, at most 64 characters); `client.host` (the host of the verified `client_id`
URL) is the verified part. Codes are never logged. A session that ends (any close) stops its
codes; grants stay.

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
- Response `headers` are filtered by the relay to `content-type` and `cache-control`; the
  relay sets the rest (`x-accel-buffering: no` on streams, CORS headers).
- A response must end within `requestTimeoutMs` (300 s), except for `subscriptions/listen`
  (recognised by `mcp-method`), which may stay open for the session's lifetime. Streams are
  counted against `maxConcurrentRequests`.
- The tab answers `tools/call` with a streamed SSE response that starts at once (DEC-020).
  Other methods may answer with one `http.response`.
- If the tab has not started any response within `keepAliveMs` (20 s) for a request with a
  JSON-RPC `id`, the relay answers the AI app with `200 text/event-stream` itself
  (DEC-039). A later `http.response` is then sent as one SSE event
  (`event: message`, `data: <body>`); a later `http.response.start` continues on the same
  stream and its status and headers are dropped. The tab does not need to know.
- On streamed responses the relay writes an SSE comment (`: keep-alive`) to the AI app
  every `keepAliveMs` while the tab is silent, but only at an event boundary (when the
  bytes forwarded so far end with a blank line). The tab never sends keep-alives.
- A request gets either one `http.response`, or one `http.response.start` followed by any
  number of `http.response.chunk` and one `http.response.end`. An `http.response` after
  `http.response.start`, or a second `http.response.start`, is a protocol error: the relay
  answers `error` `bad_message` with the `id`, fails the request (`-31007`) and sends
  `http.cancel`.
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

### Errors the relay sends to the AI app

When the relay itself ends an MCP request, the AI app gets a JSON-RPC error with the
request's id (as an HTTP error, or as a final SSE event if the stream had started). Codes
are outside the JSON-RPC reserved range:

| Code | HTTP | Meaning |
|---|---|---|
| `-31001` | 503 | The page is not open (valid token, no tab connected). |
| `-31002` | 504 | The page did not answer within `requestTimeoutMs`. |
| `-31003` | 503 | The page closed its connection while the request was in flight. |
| `-31004` | 429 | Too many concurrent requests for this page. |
| `-31005` | 503 | The WebSocket send was dropped under backpressure (DEC-021). |
| `-31006` | 502 | The page's response exceeded `maxMessageBytes` (one message) or `maxBodyBytes` (the whole body; listen streams excepted). |
| `-31007` | 502 | The page sent an invalid response (malformed message, header value that is not an RFC 9110 field value, body with status 204/205/304). |
| `-31008` | 503 | The token store is unavailable; sent with `Retry-After`, so clients keep their tokens. |

The relay notices that an AI app closed a streamed response when it next writes to it, so
at the latest after one keep-alive interval; then it sends `http.cancel`.

### Errors between tab and relay

`{"type":"error","code":"…","message":"…","id":"r42"?}` in either direction. `id` refers to
the request it concerns, if any.

| Code | Sent by | Meaning |
|---|---|---|
| `bad_message` | both | Not JSON, missing fields, binary frame, malformed `secret`. |
| `unknown_type` | both | Message type not understood but an answer was expected. |
| `unknown_id` | both | `id`/`grantId` not known (or already finished). |
| `too_large` | relay | A message exceeded `maxMessageBytes`; the relay answers the AI app with 502. |
| `rate_limited` | relay | The tab sent too much; the relay may close with 4008. |

Tab-side failures of an MCP request are not protocol errors: the tab answers with an HTTP
status and a JSON-RPC error body, as the MCP handler produced it.

## Close codes

| Code | Meaning |
|---|---|
| 1000 | Normal close (`bye`, user pressed Disconnect). |
| 1008 | Policy violation (bad message, no `hello` in time). |
| 1009 | Message too large. |
| 4001 | Session expired (absolute lifetime). |
| 4002 | Idle timeout: no MCP request for `idleTimeoutMs` and nothing in flight; an open `subscriptions/listen` stream counts as activity. |
| 4003 | Heartbeat lost. |
| 4004 | Relay shutting down. |
| 4005 | Replaced by a newer session for the same address. |
| 4008 | Rate limited. |

On any close the relay ends the session: pending HTTP requests get `503` with a JSON-RPC
error, listen streams end, the pairing code becomes invalid. Grants and tokens stay
(DEC-029): they belong to the address, not to the WebSocket. While no tab is connected, MCP
requests with a valid token get `503` "the page is not open". The library never reconnects
on its own, because a session needs a user action.

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
| Request timeout | 300 s | relay (504 and `http.cancel`; keep-alives throughout) |
| Keep-alive interval | 20 s | relay |
| Concurrent requests per session | 8 | relay (429) |
| Idle timeout | 60 min | relay (close 4002) |
| Session lifetime | 12 h | relay (close 4001) |
| Sessions per IP / in total | 5 / 500 | relay (HTTP 429 on upgrade) |

All are configurable on the relay (DEC-034); see the threat model for why each exists.

# Citations

- [MCP 2026-07-28 research](/research/mcp-2026-07-28-spec.md)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
- [Decision log](/decision-log.md)
- [RFC 6455 WebSocket close codes](https://www.rfc-editor.org/rfc/rfc6455#section-7.4)
- [RFC 4648 base32](https://www.rfc-editor.org/rfc/rfc4648#section-6)
