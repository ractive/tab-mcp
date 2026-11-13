---
type: iteration
title: "Iteration 32: client connection edge cases"
status: completed
description: >-
  Iteration D of the review of 2026-11-13 (CC 4, 5, 6, 7, 10, 11, 12, 14, 15).
  newAddress() always takes the old address back with hello.revokeAll, from the secret
  the tab last connected with, and the take-back fallback for relays of 0.4 and older,
  #takenOver and #pageWaits are gone; sibling claims carry the address id; close codes of
  a restarting proxy reconnect, with jitter; an oversized result becomes an error result
  before toolcallend; hello no longer sends the page title and the relay ignores page;
  the tab no longer answers frames it cannot read. Client, plus a few lines in the relay.
timestamp: 2026-11-13T22:00:00+01:00
tags: [iteration, client, protocol, review]
---
# Iteration 32: client connection edge cases

Iteration D of [the review of 2026-11-13](../research/review-2026-11-13.md), client core
report. Decisions: DEC-136 to DEC-138. The 0.4 secret-key migration (DEC-083) stays.

## Tasks

### CC 4: `newAddress()` revokes nothing while disconnected; the takeover flag lives only in memory

- [x] `newAddress()` always takes the old address back with `hello.revokeAll` before it
  rotates, connected or not, taken over or not; nothing to take back when the page never
  had a secret (`SecretStore.current()`)
- [x] The old secret is the stored one, read when `newAddress()` is called; a tab that
  rotated it before took its own old address back (DEC-136)
- [x] `#takenOver` and the `grants.revokeAll`-then-`bye` branch removed; `#stayOn` only
  decides whether to connect afterwards (taken over while on, or a failed `newAddress()`)
- [x] The take-back connection is never the page's session: no `connected` for the old
  address, `state` goes `connecting` once; `disconnect()` cancels it
- [x] Rejects and keeps the secret when the take-back fails (unreachable, refused, taken
  over again); one run at a time, `connect()` meanwhile waits for it
- [x] Tests: connected, disconnected with and without a secret, unreachable relay, a
  rotation in another tab, `connect()`, a second call and `disconnect()` during the
  take-back

### CC 5: sibling detection counts claims that cannot have caused the replacement

- [x] `claimed` carries the address id; a claim of another address does not count (one
  without an address, from a tab on 0.15 or older, still does)
- [x] Claims heard before the tab's own `session` are ignored
- [x] Tests for both; the channel test now expects the address id and no secret

### CC 6: `hello` sends `document.title` to the relay, which never reads it

- [x] The client sends `page: { title: "" }` (relays up to 0.9 require the field)
- [x] The relay accepts `hello` without `page` and ignores it (`HelloMessage.page` gone)
- [x] Tests in both packages; `docs/protocol.md`

### CC 7: the client ignores `limits.maxBodyBytes`

- [x] The MCP handler measures the encoded `tools/call` event against the session's
  `maxBodyBytes` and answers a larger result as an error result with both sizes
- [x] The check runs before `toolcallend`, so the event says `error`; a result that is
  not JSON goes the same way (it used to report `ok`)
- [x] The event is encoded once (kept from the check)
- [x] Tests: too large, fits, not JSON

### CC 10: reconnecting can stop for good after a `connect()` from a `statechange` listener

- [x] `#pageWaits` removed: a refusal that stops reconnecting always emits `error`,
  also when the page's `connect()` waits on the attempt
- [x] A failed attempt schedules the next one only when no other attempt runs, and reads
  `reconnecting` when it settles
- [x] Test of the review's sequence (fails on the old code); two tests changed to expect
  the `error`

### CC 11: close codes 1001, 1011, 1012, 1013 end reconnecting; the waits have no jitter

- [x] 1001, 1011, 1012 and 1013 map to `shutdown`
- [x] Each wait varies by up to 20 % either way
- [x] Tests: close codes, jitter bounds (`Math.random` stubbed), the growing waits within
  20 %

### CC 12: the take-back wait for relays of 0.4 and older has no timeout

- [x] The fallback deleted (`revoking`, the wait for `grant.removed`, the "taken over
  again" rejection of `ready` after `session`); `ready` resolves at `session`
- [x] A relay that lists grants after `hello.revokeAll` fails the connection with
  `policy`, so `newAddress()` rejects and keeps the secret instead of rotating with the
  grants still in place
- [x] Test replaces the two tests of the fallback

### CC 14: `mcp.grants` keeps revoked apps after `newAddress()`

- [x] `grants` is cleared (and `grantschange` fires) once the old address was taken back
- [x] Test (disconnected `newAddress()`)

### CC 15: the tab answers malformed relay frames with `error` messages

- [x] `frameInfo`, `KNOWN_TYPES` and the echo deleted; such a frame is dropped
- [x] The relay still accepts and debug-logs a tab `error` (older libraries); not touched
- [x] Test; `docs/protocol.md` (errors only from the relay)

### Docs and records

- [x] Client README (new address, sibling channel, reconnecting), `types.ts`,
  `docs/protocol.md`, `docs/threat-model.md`
- [x] DEC-136, DEC-137, DEC-138; `log.md`

## Outcome

- The take-back is one path, `#renew()`, instead of two (the take-back after a takeover
  and `grants.revokeAll` then `bye` otherwise). `#open(generation, takeBack)` opens the take-back connection with a host
  whose callbacks are never current, so its session, grants and close stay unseen, but
  `#end` still closes it.
- `ui.ts` was not changed: its "taken over again" text still matches the rejection
  (`reason: "replaced"` when the take-back is replaced before its `session`).
- A `newAddress()` with a stored secret now opens a WebSocket also when the page is off
  (for example on logout). It takes no user activation, as before; the connection only
  revokes and closes (DEC-136).
- After the relay with the optional `page` is everywhere, the client can drop the field.
- The core grows by about 50 B gzipped (6293 B against 6242 B; on top of iteration 31,
  6396 B of the 6400 B budget):
  `SecretStore.get()` gave way to `current()` plus `rotate()`, and remembering the last
  connected secret was dropped (23 B) to pay for the `newAddress()` guard the review
  asked for.
- Review of PR 119 (claude 4 findings): the `newAddress()` guard, `#stayOn` reset at
  `session`, a cancelled call whose result is not JSON no longer throws in a promise
  handler, and addressless claims of older tabs count.
