---
type: iteration
title: "Iteration 41: client 0.16 follow-ups"
status: completed
description: >-
  Iteration M, from Overmark's migration to client 0.16.0 against relay 0.10.1. The
  relay names the message an error answers (for, grantId), so the client settles only
  the matching revoke() or signOut(); the relay's sweep announces expired grants and the
  client drops a grant the relay does not know; the tools/list sentence about the page's
  tab is left out when an onConfirm answers; revoke() and newAddress() reject
  distinguishably; statechange's reason documented; the WebMCP mirror moved out of the
  core into a chunk of its own (6400 to 6082 B). Ships as client 0.16.1 and relay
  0.10.2.
timestamp: 2026-11-14T12:00:00+01:00
tags: [iteration, client, relay, protocol]
---
# Iteration 41: client 0.16 follow-ups

Overmark drove client 0.16.0 against relay 0.10.1 and found these. Owner-approved on
2026-11-13 (iteration M). Branch `iteration/41-client-016-fixes`.

## 1. A relay error settles every pending revoke()

`#ask` settled every pending `revoke()` / `signOut()` on any `store_unavailable` or
`unknown_id`, because the relay's `error` named no grant. With two revocations in flight
the wrong one was rejected.

- [x] Relay: `error` `unknown_id` / `store_unavailable` that answers `grant.revoke`,
      `grants.revokeAll` or `identity.logout` carries `for` (the message's type) and, for
      `grant.revoke`, `grantId` (`TabSession.refused`; the sign-out's store failure too)
- [x] Client: `#ask` settles on an error only when it names this message (type and
      grant), or names none (relay 0.10.1: every pending one, as before)
- [x] Compatible both ways: a 0.16.0 client ignores the fields; a new client against
      0.10.1 keeps 0.16.0's behaviour
- [x] `docs/protocol.md`: the frame, with examples
- [x] Tests: relay (`for`/`grantId` on each of the three), client (only the named
      `revoke()` settles; without `for` both settle; `signOut()` ignores another
      message's error)

## 2. Expired grants stay listed

- [x] Relay: the sweep tells each connected page of its grants that expired
      (`grant.removed` `expired`, log `grant.expired`): the session keeps the ids it told
      the page, and the sweep compares them with `listGrants` (one call per page with a
      grant, one run at a time; only ids known before the read count), and ends their
      requests in flight (review: a grant revoked through another instance looks the
      same)
- [x] Relay: "revoke all" and sign-out also remove the grants the page still lists
      (expired since the last sweep), so `signOut()` settles (review)
- [x] Client: `unknown_id` for a `grant.revoke` with `grantId` drops the grant from
      `grants` (`grantschange`) before the `error`, so its `revoke()` resolves
- [x] Tests: the sweep's `grant.removed` once; the client's drop and `grantschange`

## 3. The sentence about the page's tab

"The page may ask the user to allow each call, usually in the page's browser tab." was
appended to every consequential tool in `tools/list`. Wrong for Overmark, which asks in
its side panel through `onConfirm`.

- [x] Left out when an `onConfirm` answers: the page's (relay and ports), or a served
      port's own (that port's `tools/list` only). DEC-169 says why this and not a
      `ui.strings` entry
- [x] CHANGELOG: the 0.16.0 section did list the sentence (under Changed, "While a
      confirmation is open in a hidden tab…"); the brief's "missing" was not right. The
      change is in Unreleased, Fixed
- [x] Test through ports: dialog, port's `onConfirm`, page's `onConfirm`

## 4. Errors that cannot be told apart; statechange's reason

- [x] `revoke()` / `signOut()`: `InvalidStateError` only when nothing was sent;
      `NetworkError` when the session ended after sending (DEC-170)
- [x] `newAddress()`: every rejection has `addressChanged` (`false`: the old address is
      kept; `true`: only connecting with the new one failed)
- [x] `statechange`'s `reason`: documented exactly (README, CHANGELOG); behaviour kept
      (setting it on every attempt would make `reason !== undefined` fire per attempt)
- [x] `timing` stays unexported: no change
- [x] Tests for each

## 5. Core budget

The core was at 6400 B of 6400 gzipped (measured on `origin/main`; the brief said 6399).

- [x] The WebMCP mirror (`mirror` in `webmcp.ts`) is a chunk of its own, imported by the
      constructor once `nativeContext()` (now in `tab-mcp.ts`) found native WebMCP
      (DEC-119's plan, DEC-171). The getter rule (DEC-115) and the read in the
      constructor (WM 10, DEC-143) stay
- [x] `build.test.ts`: the core has no mirror text, the `webmcp-` chunk has it and stays
      under 1 KB; the test prints the core in bytes
- [x] Sizes: before 6400 B; mirror moved 6082 B; with the fixes of 1 to 4 6216 B (184 B
      under the budget, which is unchanged)

## Outcome

Relay: `for`/`grantId` on the revocation errors, the expiry sweep. Client: the matching,
the drop, the sentence, the errors, the chunk. DEC-168 to DEC-171.
