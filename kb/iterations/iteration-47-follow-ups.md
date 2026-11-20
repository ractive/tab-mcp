---
type: iteration
title: "Iteration 47: follow-ups of the fixed address"
status: completed
description: >-
  Three follow-ups of iteration 45: the client's newAddress() is disconnectAll(), with
  every name that went with it (DEC-201); two texts that still spoke of the address
  where the secret is meant; and with identity binding an open sign-in dialog counts for
  ten minutes after the user opened it, with a new pairing.open message and a Continue
  button (DEC-202, closing DEC-196's open point). One pull request, no release.
timestamp: 2026-11-20T21:00:00+01:00
tags: [iteration, relay, client, extension, pairing, security]
---
# Iteration 47: follow-ups of the fixed address

Iteration 45 (DEC-196) made the MCP address the app's, the same for every page and
visitor, and left two things open: the method `newAddress()`, which no longer changes the
address, and a time limit on the open `oidc` dialog. Branch `followups/disconnect-all`.
Client 0.18.1 and relay 0.12.1 were the released versions when it started.

## What changed

- **`newAddress()` is `disconnectAll()`** (DEC-201, amends DEC-095's name for it): also
  `addressChanged` → `secretChanged`, `DisconnectReason` `new_address` →
  `disconnect_all`, the `ui.strings` keys `newAddress…`/`gettingNewAddress` →
  `disconnectAll…`/`disconnectingAll`, the CSS classes `tab-mcp-new-address…` →
  `tab-mcp-disconnect-all…`, the extension's panel command and element ids
  `new-address` → `disconnect-all`. No alias. The wire protocol is unchanged.
- **Texts.** The takeover notice says "another tab or window of this browser" (a page in
  another browser has a secret of its own). The extension's privacy policy and the
  store listing in [the Chrome Web Store notes](/operations/chrome-web-store.md) say the
  stored secret identifies the installation to the relay, not that the address is
  derived from it. A few doc comments that still spoke of "a new address" say "a new
  secret".
- **An open sign-in dialog counts for ten minutes** (DEC-202): the relay pairs a sign-in
  with an `oidc` page only until 10 minutes after its last `pairing.start` and answers
  each with `pairing.open { expiresAt, expiresInMs }`. The library keeps the end, on the
  page's clock, in `pairingUntil` (event `pairinguntil`); the dialog shows until when,
  then Continue. A reconnect the library makes by itself does not ask again once the
  user's start was sent.

## Tasks

### Relay

- [x] `pairing.ts`: `PAIRING_WINDOW_MS` next to the code's lifetime; `pairingWindowMs`
  test hook
- [x] `session.ts`: `#dialogOpenUntil` instead of `#dialogOpen`; `pairing.open` on each
  `pairing.start` of an `oidc` site; `pairing.stop` and the session's end clear it
- [x] `protocol.ts`: `PairingOpenMessage`
- [x] Comments and test names: "Disconnect all apps"
- [x] Tests: the window's edges with a mocked clock (open at its last millisecond,
  closed at its end, a start within it moves the end, stop and the session's end close
  it, code sites get no `pairing.open`); a sign-in that starts in the window and comes
  back after it gets `NO_PAGE_TEXT`, and after another `pairing.start` the same request
  pairs

### Client

- [x] The rename in `tab-mcp.ts`, `types.ts`, `strings.ts`, `connect.ts`, `dialog.ts`,
  comments, tests, README
- [x] `pairing.open` parsed (a non-time `expiresAt` is ignored) and kept in
  `pairingUntil`; `startPairing()` sends on every call while connected; a reconnect
  sends `pairing.start` again only without a known time
- [x] Dialog: "Your AI app can connect until {time}.", then the status "The time to
  connect your AI app is up. To connect it now, continue." and Continue; focus from
  Continue to the address's Copy once the relay answered
- [x] React snapshot: `pairingUntil`
- [x] Core size: the reconnect's `visibilitychange`/`online` listeners moved to the lazy
  chunk (`onWake`) to make room
- [x] Tests: protocol, reconnect (no `pairing.start` after a reconnect with a time;
  still one for codes and for an `oidc` relay that gave none), dialog, React

### Extension, docs, records

- [x] Extension: panel command, ids, comments, `PRIVACY.md`, changelog
- [x] `docs/protocol.md`, `docs/configuration.md`, `docs/threat-model.md`,
  `kb/design/threat-model.md`, `kb/design/identity-binding.md`, `SECURITY.md`, the
  skill and its references, the client README
- [x] DEC-201, DEC-202; changelogs `## Unreleased` of the client, the relay and the
  extension

## Results

- `bun run verify` exits 0: 1649 tests pass, 1 skipped, across 75 files (after the
  review's fixes).
- The client's core is 6257 B gzipped of its 6400 B limit (6369 B before); the
  connection chunk 16.4 KB. The pairing window and its reconnect rules cost the core
  about 120 B; moving the reconnect's wake listeners and the wait for the relay's answer
  (`revoke()`, `signOut()`) to the lazy chunk saved about 240 B; the rename saved 3 B.

## Review of PR 175

Two reviewers, eight findings, all fixed on the branch:

- The docs claimed that libraries up to 0.18.1 stop pairing after 10 minutes; they
  re-send `pairing.start` after every reconnect, so each reconnect renews their window.
  The relay stays as it is; `docs/protocol.md`, `docs/configuration.md`, both threat
  models, DEC-202 and the changelogs now say that the limit is complete only with a
  newer library.
- A reconnect before the relay answered the user's start asked again; now an `oidc`
  session does not ask again once the start was sent, answered or not.
- The reconnect rule now looks at the new session's method: a `code` session asks again.
- Clock skew: `pairing.open` carries `expiresInMs` next to `expiresAt`; the page counts it
  on its own clock from the arrival.
- A background tab could show a stale "can connect until": the dialog looks again when
  the tab comes back to the front, and at least once a minute.
- Connect again while reconnecting is a click: it asks again.
- `pairingUntil` is cleared, with its event, when a session ends.
- With an app connected, "Connect another app" shows the time-up sentence next to
  Continue.

## Choices this iteration made

- The protocol addition is a new message rather than a field: nothing answered
  `pairing.start` on an `oidc` site before. It carries `expiresInMs`, counted on the
  page's clock, and `expiresAt` on the relay's, like `pairing.code`; nothing comes when
  the time is up, the page knows the end.
- A reconnect the library makes by itself does not start the ten minutes again on an
  `oidc` session once the user's start was sent (a relay restart would otherwise renew
  every open dialog); `pairingUntil` is then the reconnect's time, so the dialog shows
  Continue. Connecting from a click (the dialog opening, Connect again, also while
  reconnecting, Disconnect all apps) asks again. With an old relay that never answers,
  the dialog shows Continue after a reconnect too.
- `startPairing()` lost its "already pairing" guard, so Continue is `startPairing()`; on
  a code site a second call gets the same code again.
- The dialog does not say "10 minutes": the client does not know the relay's constant,
  only its answer.
- The rejection property is `secretChanged`: what it says is whether the secret, and
  with it every grant, is gone.

## Residual risk

With identity binding a link with someone else's client, one click on Connect and a
silent single sign-on pair that client with the user's page within 10 minutes after the
user opened its dialog or chose Continue, while it is open. That holds with a client
library after 0.18.1; with an older one each reconnect of the page starts another 10
minutes.

# Citations

- [Decision log](/decision-log.md), DEC-196, DEC-201, DEC-202
- [Iteration 45](/iterations/iteration-45-fixed-address.md)
