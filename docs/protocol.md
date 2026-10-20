# Tab–relay protocol, `tab-mcp.v1`

This is the WebSocket protocol between a web page (the *tab*) and a tab-mcp relay. The
browser library `@ractive-ch/tab-mcp-client` implements the tab side; the relay
`@ractive-ch/tab-mcp` implements the other. Read this if you write your own tab
implementation or want to know what passes over the connection.

The protocol tunnels the AI app's MCP HTTP requests to the tab and the tab's HTTP
responses back. It also carries the session's control messages: pairing, connected apps
and the heartbeat. It knows nothing about MCP tools. The tab runs the MCP server itself
(MCP revision 2026-07-28, stateless); the relay authenticates AI apps and forwards their
requests.

```text
AI app ──HTTPS POST /a/{id}/mcp──▶ relay ──WebSocket /tab (tab-mcp.v1)──▶ page
       ◀──JSON or event stream───        ◀──http.response* messages─────
```

## Connection

- URL: `wss://<relay>/tab`.
- The relay checks the `Origin` header against its allow-list first (empty by default).
  An origin that is not on it gets HTTP 403 with `{"error":"origin_not_allowed"}` and no
  upgrade.
- Version negotiation: the tab offers the WebSocket subprotocol `tab-mcp.v1`
  (`Sec-WebSocket-Protocol`). The relay accepts it, or refuses the upgrade with HTTP 426
  and `{"error":"unsupported_protocol","supported":["tab-mcp.v1"]}`. A future
  `tab-mcp.v2` will be offered alongside v1 during a transition.
- Too many sessions in total or from one client IP: HTTP 429 with
  `{"error":"too_many_sessions"}`.
- Frames are UTF-8 text, one JSON object each, with a string `type`. Binary frames are a
  protocol error.
- Unknown `type` values from the peer are ignored, for forward compatibility. If such a
  message carries an `id` that expects an answer, the receiver answers with `error` code
  `unknown_type`.
- A session begins only after a user action in the page. The library opens the WebSocket
  only from `connect()`, which pages call from a click handler.
- The tab must send `hello` within 10 seconds of the open, or the relay closes with 1008.

## Message types

T→R is tab to relay, R→T is relay to tab.

### Session

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `hello` | T→R | `library: {name, version}`, `page: {title}`, `app?: {name}`, `secret` | First message after the open. `page.title` is untrusted and never logged. `app.name` (for example `saturnus`) must be 1-64 characters without control characters, else `bad_message` and close 1008. It is the page's own claim; the relay shows it on `/authorize` unless the relay configures a name for the site. |
| `session` | R→T | `sessionId`, `address`, `origin`, `appName?`, `expiresAt`, `limits`, `grants` | The session exists. `address` is the MCP URL the user gives to the AI app. |
| `ping` | R→T | `t` | Heartbeat, every `limits.heartbeatMs`. |
| `pong` | T→R | `t` | Answer to `ping` with the same `t`. |
| `bye` | both | `reason` | Orderly end; the sender closes the socket after it. Reasons from the relay: `replaced`, `expired`, `idle`, `shutdown`. |

**The address secret.** `secret` makes the address stable across sessions. It is 32
random bytes as base64url without padding (43 characters), kept by the library in the
page's `localStorage` under `tab-mcp:secret:<relay origin>`. The relay derives the
address id as `base32(sha256(secret))`: SHA-256 over the secret's UTF-8 text, RFC 4648
base32, lower case, no padding, 52 characters. The relay therefore stores nothing to
recognise an address, and the address does not reveal the secret. A `hello` without a
well-formed `secret` gets `error` `bad_message` and close 1008.

If a session with the same address is already connected, the new one replaces it: the
old tab gets `bye` with reason `replaced` and close 4005.

**The session message.** `sessionId` is a fresh random id per WebSocket. It appears only
in logs and in this protocol, never in URLs. `origin` is the page origin the relay saw on
the upgrade; `/authorize` shows it. `appName` is the name `/authorize` will show: the
site's configured name, else the page's `app.name`, absent if neither exists. `grants`
lists the AI apps already connected to this address (see below).

`limits` carries `maxMessageBytes`, `maxBodyBytes`, `requestTimeoutMs`, `idleTimeoutMs`,
`heartbeatMs`, `keepAliveMs` and `maxConcurrentRequests`, so the tab can show and respect
them. `maxMessageBytes` is at least 16 384.

```json
{"type":"session","sessionId":"s_6Gx…","origin":"https://ractive.ch",
 "address":"https://relay.ractive.ch/a/mzxw6ytboi4dmnrqgq3tm…/mcp",
 "expiresAt":"2026-10-20T08:00:00.000Z","grants":[],
 "limits":{"maxMessageBytes":1048576,"maxBodyBytes":1048576,"requestTimeoutMs":300000,
           "idleTimeoutMs":3600000,"heartbeatMs":25000,"keepAliveMs":20000,
           "maxConcurrentRequests":8}}
```

### Pairing and grants

Pairing works like signing in on a TV: the tab shows the address and a code, and the user
types the code on the relay's `/authorize` page when the AI app opens it.

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `pairing.start` | T→R | none | The page's "Connect your AI app" dialog is open; the relay starts issuing codes (only on sites whose pairing method is `code`). Sent again while codes are on, it repeats the current code. |
| `pairing.code` | R→T | `code`, `expiresAt` | The code to show: 6 digits, single-use, valid 2 minutes, 5 attempts. A fresh one follows by itself after expiry, use or 5 failed attempts while pairing is on. Guesses are also limited per address and network and per address overall; malformed input does not count. |
| `pairing.stop` | T→R | none | The dialog closed; the current code becomes invalid and no more codes come. |
| `grant.added` | R→T | `grant` | An AI app finished pairing (the token endpoint issued its first tokens). |
| `grant.revoke` | T→R | `grantId` | The user pressed Disconnect for one app; its tokens stop working at once. A grant that does not belong to this address gets `error` `unknown_id`. |
| `grants.revokeAll` | T→R | none | Revoke every grant of this address (sent before "New address"). |
| `grant.removed` | R→T | `grantId`, `reason` | A grant ended: `revoked` (Disconnect, `/revoke`, "New address") or `reuse_detected` (an authorization code or refresh token was presented twice). `expired` is reserved; grants that run out (at the latest 90 days after pairing) are not announced. |

A grant as the tab sees it:

```json
{"grantId":"g_…","client":{"id":"https://claude.ai/oauth/claude-code-client-metadata",
 "name":"Claude Code","host":"claude.ai"},"createdAt":"2026-10-19T20:00:00.000Z"}
```

`client.name` is what the AI app declares in its Client ID Metadata Document, cleaned (no
control, format or bidi characters, at most 64 characters). `client.host`, the host of the
verified `client_id` URL, is the verified part. Codes are never logged. A session that
ends, for any reason, stops its codes; grants stay.

### Tunnelled MCP requests

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `http.request` | R→T | `id`, `method`, `path`, `headers`, `body`, `grant` | One HTTP request to the session's MCP address. |
| `http.response` | T→R | `id`, `status`, `headers`, `body` | A complete response in one message (JSON or empty). |
| `http.response.start` | T→R | `id`, `status`, `headers` | Start of a streamed (SSE) response. |
| `http.response.chunk` | T→R | `id`, `data` | The next piece of the body (UTF-8 text). |
| `http.response.end` | T→R | `id` | End of a streamed response. |
| `http.cancel` | R→T | `id`, `reason` | The AI app closed the connection or the request timed out. |

- `id` is chosen by the relay and unique per session.
- `headers` is an object with lower-case names, limited to `content-type`, `accept`,
  `mcp-protocol-version`, `mcp-method`, `mcp-name`, `mcp-param-*`, `traceparent` and
  `tracestate`. The relay never forwards `authorization`, `cookie`, IP addresses or
  `x-forwarded-*`.
- `body` is the request body as a string. The relay has checked its size and that it is
  JSON, and forwards it unchanged.
- `grant` identifies the caller:
  `{"grantId":"g_…","clientId":"https://…","scopes":["tools"]}`. Nothing about the token
  reaches the tab.
- The relay keeps only `content-type` and `cache-control` from the tab's response headers.
  It sets the rest itself (`x-accel-buffering: no` and `cache-control: no-cache` on
  streams, CORS headers).
- A response must end within `requestTimeoutMs` (300 s by default), except for
  `subscriptions/listen` (recognised by `mcp-method`), which may stay open for the
  session's lifetime. Streams count against `maxConcurrentRequests`.
- The library answers `tools/call` with an event stream that starts at once. Other
  methods may answer with one `http.response`.
- If the tab has not started a response within `keepAliveMs` (20 s) for a request with a
  JSON-RPC `id`, the relay answers the AI app with `200 text/event-stream` itself. A later
  `http.response` is then sent as one SSE event (`event: message`, `data: <body>`); a
  later `http.response.start` continues on the same stream, and its status and headers
  are dropped. The tab does not need to know. This keeps proxies and CDNs that drop
  requests without response headers after 60 s from cutting long tool calls.
- On streamed responses the relay writes an SSE comment (`: keep-alive`) to the AI app
  every `keepAliveMs` while the tab is silent, but only at an event boundary (when the
  bytes forwarded so far end with a blank line). The tab never sends keep-alives.
- A request gets either one `http.response`, or one `http.response.start` followed by
  any number of `http.response.chunk` and one `http.response.end`. An `http.response`
  after `http.response.start`, or a second `http.response.start`, is a protocol error:
  the relay answers `error` `bad_message` with the `id`, fails the request (`-31007`) and
  sends `http.cancel`.
- `http.cancel` aborts the tab's `Request.signal`; the tab sends nothing more for that
  `id`. Late messages for a cancelled `id` are dropped silently.

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
request's id: as an HTTP error, or as a final SSE event if the stream had started. The
codes are outside the JSON-RPC reserved range.

| Code | HTTP | Meaning |
|---|---|---|
| `-31001` | 503 | The page is not open (valid token, no tab connected). |
| `-31002` | 504 | The page did not answer within `requestTimeoutMs`. |
| `-31003` | 503 | The page closed its connection while the request was in flight. |
| `-31004` | 429 | Too many concurrent requests for this page. |
| `-31005` | 503 | The WebSocket send was dropped under backpressure. |
| `-31006` | 502 | The page's response exceeded `maxMessageBytes` (one message) or `maxBodyBytes` (the whole body; listen streams excepted). |
| `-31007` | 502 | The page sent an invalid response (malformed message, a header value that is not an RFC 9110 field value, a body with status 204, 205 or 304). |
| `-31008` | 503 | The token store is unavailable. Sent with `Retry-After`, so clients keep their tokens. |

The relay notices that an AI app closed a streamed response when it next writes to it,
so at the latest after one keep-alive interval. It then sends `http.cancel`.

Before a request reaches the tab, the relay checks, in this order: the method (POST,
else 405), the body size and JSON (413, 400), the `MCP-Protocol-Version` header (400 with
JSON-RPC error `-32022` naming the supported version `2026-07-28`, or `-32020` when the
header is missing), the bearer token for this address (401 with `WWW-Authenticate`), that
the tab is online (503, `-31001`) and the concurrency limit (429, `-31004`). An unknown
address and an address whose tab is offline look the same without a token, so addresses
cannot be probed.

One exception exists for a known client bug: a request with the header
`MCP-Protocol-Version: 2025-11-25` whose body declares `2026-07-28` is accepted and
counted in `/healthz` (`counters.claudeHeaderWorkaround`).

### Errors between tab and relay

`{"type":"error","code":"…","message":"…","id":"r42"}` in either direction. `id` is
optional and names the request the error concerns.

| Code | Sent by | Meaning |
|---|---|---|
| `bad_message` | both | Not JSON, missing fields, a binary frame, a malformed `secret`. |
| `unknown_type` | both | Message type not understood, but an answer was expected. |
| `unknown_id` | relay | A `grant.revoke` named a grant that is not this address's; the error has no `id`. Late `http.response*` messages for a finished or cancelled `id` get no answer: the relay drops them. |
| `too_large` | relay | A message exceeded `maxMessageBytes`; the relay answers the AI app with 502. |
| `rate_limited` | relay | Reserved: the tab sent too much, and the relay may close with 4008. Relay 0.1.0 does not send it. |

Failures of an MCP request inside the tab are not protocol errors: the tab answers with
an HTTP status and a JSON-RPC error body, as its MCP handler produced it.

## Close codes

| Code | Meaning |
|---|---|
| 1000 | Normal close (`bye`, the user pressed Disconnect). |
| 1008 | Policy violation (bad message, no `hello` in time). |
| 1009 | Message too large. |
| 4001 | Session expired (absolute lifetime). |
| 4002 | Idle timeout: no MCP request for `idleTimeoutMs` and nothing in flight. An open `subscriptions/listen` stream counts as activity. |
| 4003 | Heartbeat lost. |
| 4004 | The relay is shutting down. |
| 4005 | Replaced by a newer session for the same address. |
| 4008 | Rate limited (reserved, see `rate_limited`). |

On any close the relay ends the session: pending HTTP requests get 503 with a JSON-RPC
error, listen streams end, and the pairing code becomes invalid. Grants and tokens stay:
they belong to the address, not to the WebSocket. While no tab is connected, MCP
requests with a valid token get 503 "the page is not open". The library never
reconnects on its own, because a session needs a user action.

## Heartbeat

Browsers cannot send WebSocket pings from JavaScript, so the heartbeat is part of the
protocol. The relay sends `ping` every `heartbeatMs` (25 s by default) and the tab
answers `pong`. The relay closes with 4003 after two missed pongs. The tab treats two
missed pings as a dead connection and shows the session as ended. The relay also sends
WebSocket protocol pings, so proxies keep the connection open.

## Limits (defaults)

| Limit | Default | Enforced by |
|---|---|---|
| WebSocket message | 1 MiB | both |
| MCP request body | 1 MiB | relay (HTTP 413) |
| Request timeout | 300 s | relay (504 and `http.cancel`; keep-alives throughout) |
| Keep-alive interval | 20 s | relay |
| Concurrent requests per session | 8 | relay (429) |
| Idle timeout | 60 min | relay (close 4002) |
| Session lifetime | 12 h | relay (close 4001) |
| Sessions per IP / in total | 5 / 500 | relay (HTTP 429 on upgrade) |

All are configurable on the relay; see [configuration](configuration.md). The
[threat model](threat-model.md) explains why each exists.
