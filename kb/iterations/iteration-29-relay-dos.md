---
type: iteration
title: "Iteration 29: relay denial of service and the refresh bug"
status: completed
description: >-
  Iteration A of the review of 2026-11-13: a token store failure during a refresh no
  longer costs the user their pairing (RQ 1), and the cheap ways for an unauthenticated
  party to stop pairing or park sockets are closed or bounded (RS 1 to 5, 8, 13, 15),
  with bounded timer settings (RQ 3), keep-alives only in event streams (RS 16 = RQ 9),
  a sweep that survives a throwing store (RQ 10) and an error handler for Bun.serve
  (RQ 20). Relay only; DEC-127 to DEC-129.
timestamp: 2026-11-13T18:00:00+01:00
tags: [iteration, relay, security, review]
---
# Iteration 29: relay denial of service and the refresh bug

Iteration A of [the review of 2026-11-13](../research/review-2026-11-13.md): the
relay's open issues were denial of service by an unauthenticated party and one
correctness bug that costs a user their pairing. Branch `iteration/29-relay-dos`.
Iteration B (the pairing page and the logs) follows on the same package.

## Tasks

### RQ 1: a store failure during a refresh revokes the grant (DEC-127)

- [x] Refresh: store the new pair first, `markUsed` last
- [x] Code exchange: a throwing `issueTokenPair` makes the code usable again and keeps
  its grant id
- [x] Tests with a store whose first or second `put` throws: 503, then the retry
  succeeds and the grant stays; a reuse after a successful refresh still revokes

### RS 1: one party fills the 10 000 open authorization requests (DEC-129)

- [x] A full instance evicts: first a request whose page is gone or whose dialog is
  closed, else the oldest of the network holding the most
- [x] Per-network caps count an IPv6 /56 (`networkKey`)
- [x] Tests (test hook `maxPending`); existing DEC-088 tests moved to distinct /56s
- Not done: dropping an address's requests 60 s after its session ended; eviction takes
  them first, and keeping them lets "Try again" continue after a reconnect

### RS 2: 1.2 requests a second keep the new-client budget empty (DEC-129)

- [x] Uncached client ids charged to the requesting network first (5, then 1 a minute)
  at `/authorize`, `/token`, `/revoke`; 429 when used up
- [x] Self-hosting guide recommends `TAB_MCP_CLIENT_ID_HOSTS`; threat model A3 states
  the residual (about 60 networks)

### RS 3: tab control messages have no rate limit (DEC-129)

- [x] Per-session budget (30, then 2 a second) for every frame but `pong` and
  `http.response*`; `rate_limited` and close 4008, documented in the protocol
- [x] A second `grants.revokeAll` within a second is a no-op; a repeat waits for a
  revocation under way; a `hello` with `revokeAll` always revokes (review of PR 117)

### RS 4 = RQ 2: `/token`, `/revoke`, `POST /authorize` read their body without a deadline (DEC-128)

- [x] One reader with a deadline (`src/body.ts`) for all four endpoints; 408 and
  `Connection: close`; it counts bytes while they arrive, so a chunked body is refused
  at the limit instead of buffered whole (review of PR 117)
- [x] Raw-socket tests for the three OAuth endpoints

### RQ 3: timer settings above 24.8 days fire at once (DEC-128)

- [x] `resolveConfig` and site limits refuse timer settings above 2^31-1 ms
- [x] Configuration reference names the bound

### RS 5: a JWKS with hundreds of keys under one kid (DEC-129)

- [x] At most 20 keys per set, at most 3 candidates per token
- [x] Failed assertions per IP checked before client authentication, in a bucket of
  their own (not `#tokenFailuresPerIp`, which would refuse a hosted app's good
  refreshes; see DEC-129)

### RS 8: the MCP endpoint parses 1 MiB before it looks at the token (DEC-129)

- [x] Token looked up first; without a valid token at most 16 KiB is read, a larger body
  gets 401 (or 503) unparsed; DEC-040's order kept for parsed bodies

### RS 13: the metadata fetch's timeout does not cover DNS

- [x] One `AbortSignal.timeout` for the lookup and the fetch; a hanging lookup fails as
  `unresolvable`

### RS 15: proxy header values with a port are used verbatim as limiter keys

- [x] `forwardedIp` strips `:port` and `[v6]:port`; anything else falls back to the
  socket address with one warning (`relay.bad_forwarded_ip`)

### RS 16 = RQ 9: keep-alives and error events in streamed bodies that are not event streams

- [x] Keep-alives, error events and the page-gone event only when the AI app's stream
  is an event stream
- [x] A streamed body that is not an event stream and ends early is broken off
  (the stream errors, Bun resets the connection) instead of ending cleanly, so the AI
  app cannot take a cut body for a whole one (review of PR 117)

### RQ 10: a sweep with a store that throws synchronously ends the process

- [x] `deleteExpired` called inside a promise chain
- [x] `installCrashLogging` exported and described in the README

### RQ 20: `Bun.serve` has no `error` handler

- [x] `error` handler: `http.handler_error` with the error's name, plain 500

## Outcome

- Tests: `packages/tab-mcp/test/dos-hardening.test.ts`, one block per finding; 31 of its
  first 38 tests failed on the code before this iteration (the others guard behaviour that must
  not change, such as reuse detection and the DEC-040 order).
- Deploy notes: no new environment variables and no changed defaults. A configuration
  with a timer setting above 24.8 days now refuses to start instead of closing every
  session; behind a proxy, a malformed `X-Real-IP` / `X-Forwarded-For` now counts as the
  proxy's address (watch for `relay.bad_forwarded_ip`).
