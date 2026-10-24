---
type: iteration
title: "Iteration 11: relay request path hardening"
status: in-progress
description: "Fixes from the 2026-10-24 review of the relay's request path and sessions (packages/tab-mcp/src/relay.ts, exchange.ts, session.ts): an unbounded listen stream, idle timeouts that never come back, 401 without WWW-Authenticate, limits, shutdown answers, log hygiene."
timestamp: 2026-10-24T22:00:00+02:00
tags: [iteration, security, relay]
---
# Iteration 11: relay request path hardening

From the codebase review of 2026-10-24 (relay request path, plus architecture F4). The
files are `packages/tab-mcp/src/relay.ts`, `exchange.ts` and `session.ts`; iteration 12
(OAuth) touches other files, so the two can run in parallel. Releases as a relay patch
or minor version.

Findings 1 and 2 were reproduced with throwaway tests in the session scratchpad
(`wrap.test.ts`, `idle.test.ts`); each fix needs a test in the repository that fails
before it.

## Findings and fixes

1. **High: a listen stream started by the relay buffers non-event-stream chunks without
   limit** (`exchange.ts:213-218`, `#wrapped += data`; `exchange.ts:309-311`, `#account`
   is true for every listen stream). An AI app sends `subscriptions/listen`; after
   `keepAliveMs` the relay starts the event stream; the page answers
   `http.response.start` with `content-type: application/json` and then sends chunks
   forever. Everything lands in `#wrapped`: +60 MB from 4000 chunks of 15 KB, no cancel,
   while a `tools/call` is cut off at once with `-31006`. Fix: a listen stream must be an
   event stream; answer any other content type with `#badResponse` (and apply
   `maxBodyBytes` to `#wrapped` in every case as a second guard).
2. **Medium: `server.timeout(req, 0)` is never undone** (`relay.ts:880`, `relay.ts:931`).
   Any request with a valid token switches Bun's idle timer off for its TCP connection
   for good: in the test the socket stayed open after 25 s with `httpIdleTimeoutS: 2`
   (the unauthenticated control closed after 4 s). A token holder can hold any number of
   idle sockets. Fix: restore `server.timeout(req, config.httpIdleTimeoutS)` on every
   exit after line 880 (page not open, identity mismatch, 413, 429, closed) and in the
   exchange's `onDone`; first check that Bun applies a timeout set on a finished
   response's socket.
3. **Low-medium: `-31009` answers 401 without `WWW-Authenticate`** (`relay.ts:427-431`
   `failPending` → `exchange.ts:426-432` `#errorResponse`). RFC 9110 §15.5.2 requires
   the header, and MCP clients treat 401 as "authorize again". On the refused-assertion
   and `store_unavailable` paths the grants are not revoked, so a passing JWKS or store
   outage can make clients drop valid tokens, which the relay avoids elsewhere on purpose
   (`relay.ts:815`). Fix: add `wwwAuthenticate(addressId, true)`; answer the transient
   paths (`error`, `store_unavailable`) with 503 and `Retry-After` instead of 401.
   `failPending(session, message)` does not know the reason today: give it a status (or
   the reason), with `refuse()` passing 503 for `error` and `store_unavailable`, and
   document the transient variant of `-31009`.
   Update `docs/protocol.md:210`.
4. **Low: the cap on waiting requests per address uses the instance limit**
   (`relay.ts:472` checks `config.maxConcurrentRequests`, forwarding checks
   `session.limits.maxConcurrentRequests` at `relay.ts:921`). A site with a limit of 4
   lets 8 wait; when the page connects 4 get an immediate 429. Fix: the last known site's
   limit, or re-check on wake.
5. **Low: during shutdown AI apps are told the page is not open** (`relay.ts:465`,
   `relay.ts:1217-1226`). With the page open, `stop()` answered 200 with `-31001` "ask the
   user to open the web page" within 1 ms, so during a deploy the model sends the user on
   an errand. Fix: while stopping, 503 with `Retry-After` (or a "relay restarting, try
   again" text in the same shape as page-not-open).
6. **Low: one grant can use every concurrency slot of a page** (`relay.ts:921`:
   `pending.size` counts every exchange, listen streams included, across grants). One AI
   app with 8 `subscriptions/listen` streams, which have no request timer, gives every
   other app of that page 429. Fix: a per-grant share, or a small separate cap on listen
   streams per grant.
7. **Low: store errors are logged with `error.message`** (`relay.ts:346`, `388`,
   `620`, `1178`; `session.ts:378-381`), against `log.ts:82` (names only,
   messages can carry request data). A custom store's message can hold token hashes,
   address ids or a connection string. Fix: log `error.name`, or the message only for the
   built-in stores.
8. **Low: oversized tab frames are parsed before they are refused** (`session.ts:213-215`;
   `relay.ts:1136`, `maxPayloadLength: largest * 4`, factor undocumented). A session with
   a 16 KiB site limit can make the relay `JSON.parse` frames of up to four times the
   largest site limit. Fix: refuse by length first (get the id from a cheap prefix
   match), and document or drop the factor of 4.
9. **Low: the body-deadline timer survives a failed body read** (`relay.ts:655-680`: a
   rejected `Promise.race` skips `clearTimeout`). Fix: `try/finally`.
10. **Medium (architecture F4): session slots can be filled with forged origins.**
    `handleTab` admits any client that sends an allowed `Origin` and a well-formed secret;
    500 slots in all, 5 per IPv6 /64, so about 100 /64s hold every slot with idle
    WebSockets and real pages get `too_many_sessions`. Not volumetric, so a CDN does not
    see it. Fix to decide: a quota per site, and evicting the oldest session that never
    paired and has no grants when the instance is full; document the limit in
    `docs/self-hosting.md`.

## Code quality

- `handleMcp` (`relay.ts:775-983`, about 200 lines) mixes auth, page wait, identity,
  limits, retry and timeouts in one loop. Pull out "admit the request to a session"
  first; that makes finding 2 easy to get right on every exit.
- `exchange.ts`: replace the flags `#relayStarted`, `#tabStarted`, `#wrap`,
  `#atBoundary` next to `#state` with one explicit state type (finding 1 hid in their
  combinations).
- Frames in the `hello` state are dropped silently (`session.ts:278`), `bye` included;
  document the contract or handle `bye`.
- Dead or constant parameters: `ForwardInput.method` (always POST), the path (always
  `/mcp`), `SessionHost.ready?` (optional but always given), `CloseCode.rateLimited`
  (unused).

## Architecture note (decide, do not build)

Architecture F9: the address is known only inside the WebSocket (`hello`), so no load
balancer can route `/tab` and `/a/{id}/mcp` for one address to the same process, even
with a shared token store. Carrying the address id (not the secret) in the `/tab` URL
would keep a multi-instance setup possible later, at no cost to security. Rate limits and
pending authorizations also reset on every deploy, and `/healthz` does not check the
store. Record a decision (DEC) on whether to change the `/tab` URL now, while there are
few clients.

## Tasks

- [x] 1: listen streams must be event streams; `#wrapped` bounded; test with a JSON-answered listen
- [x] 2: idle timeout restored after every authenticated request; raw-socket test
- [x] 3: `WWW-Authenticate` on `-31009`; 503 for transient refusals; `docs/protocol.md`
- [x] 4: per-site cap on waiting requests
- [x] 5: shutdown answer is "restarting", not "page not open"
- [x] 6: per-grant cap on concurrency or on listen streams
- [x] 7: error names only in logs
- [x] 8: tab frames refused by length before parsing; the factor of 4 documented or dropped
- [x] 9: `clearTimeout` in `finally`
- [ ] 10: decide and implement session-slot protection; document it
- [x] Refactors: `handleMcp` admission step, exchange state type, dead parameters
- [ ] Decision on the address id in the `/tab` URL (F9), and on `/healthz` checking the store
- [ ] Changelog, relay release, deploy

# Citations

- [RFC 9110 §15.5.2, 401 Unauthorized](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.2)
- [MCP 2026-07-28, Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
