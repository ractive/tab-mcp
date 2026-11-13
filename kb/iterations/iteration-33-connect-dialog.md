---
type: iteration
title: "Iteration 33: the connect dialog for people who are not developers"
status: completed
description: >-
  Iteration E of the review of 2026-11-13 (CU 4, 6, 7, 9, 12, 15, 23, CU 5 in part, CU 22).
  The connect dialog says in plain words why it is not connected and offers Connect
  again, follows reconnecting and identity binding, puts the help between the address
  and the code and New address apart with a line on what it does; the setup steps end
  with the sign-in step; a refused Copy says so on the button; a confirmation in a hidden
  tab marks the tab's title and consequential tools say in tools/list that the user
  confirms in the page's tab; the dialogs carry lang and dir; the code row fits 320 px.
  The guide on ractive.ch gets pages without a code and three answers.
timestamp: 2026-11-13T23:30:00+01:00
tags: [iteration, client, ui, review]
---
# Iteration 33: the connect dialog for people who are not developers

Iteration E of [the review of 2026-11-13](../research/review-2026-11-13.md), client UI
report. Decisions: DEC-146 to DEC-148. Iteration J follows: it moves every dialog string
into one table with a `ui: { strings }` override (the rest of CU 5), adds
`setup: { guide, instructions }` (CU 20) and folds the connect dialog into one `render()`
(CU 19). The new strings of this iteration sit in one `TEXT` table in `ui.ts` for that.

## Tasks

### CU 4: dead ends in the connect dialog

- [x] `connectFailure(error)` maps `reason` to user wording (`network`, `rate_limited`,
  other refusals; no reason: "Not connected."), the error goes to `console.warn`
- [x] "Connect again" (`.tab-mcp-retry`, primary) while the page is not connected; it
  calls `connect()` from its click, so a failed first call without user activation can
  be retried; while reconnecting, it tries at once
- [x] `disconnected` says why: "The session ended." for `expired` and `idle`,
  "The connection was lost." for `network`, `heartbeat`, `shutdown`
- [x] The dialog listens to `reconnecting` ("Connection lost. Reconnecting…") and
  `statechange`
- [x] The replaced notice and New address use the same wording
- [x] Tests: a failed connection, `NotAllowedError` then Connect again, reconnecting,
  a disconnect

### CU 6: the steps stop before the sign-in

- [x] Claude Code: a note after the command, "Then type /mcp in Claude Code and choose
  Authenticate."
- [x] Codex: `codex mcp login <name>` as the third command line, and a note on it
- [x] ChatGPT: its own note with `codex features enable mcp_2026_07_28` for the Mac app
- [x] Tests in `setup.test.ts`, the dialog's and the extension's panel tests

### CU 7: identity binding not reflected

- [x] With `pairing: "oidc"`, the address, help and New address stay hidden until
  `identity` is `bound`; the status says "Checking your sign-in…", "Sign in to this page
  first." or that the sign-in was not accepted, with `identityMessage`
- [x] The sign-in line only once bound; the dialog listens to `identitychange`
- [x] Test against the stub relay: none, pending, refused, bound

### CU 9: a confirmation waiting in a background tab

- [x] While a confirmation is open and the document hidden, the title starts with
  "Allow? – "; put back when shown or closed, unless the page changed it
- [x] `tools/list`: a consequential tool's description ends with "Each call waits until
  the user allows it in the page's browser tab." (`CONFIRMED_IN_TAB`, in the lazy chunk)
- [x] The guide's entry for an AI app that waits on a tool (CU 22)
- [x] Tests: the title, the description

### CU 12: a failed copy is announced only to screen readers

- [x] A refused or missing clipboard: the button says "Press Ctrl+C", "Press ⌘C" on
  Apple platforms, "Selected" on a coarse pointer, for 8 s; the announcement stays
- [x] "Copied" goes back to "Copy" after 2 s
- [x] Test with fake timers

### CU 15: the code row overflows at 320 px

- [x] Confirmed in Chrome: at 320 px the code's Copy and the note stuck out of the code
  box (into the dialog's padding, so the dialog itself did not scroll)
- [x] Below 30rem the code row is one column, Copy under the code
- [x] Browser test at 320 px, 360 px and 360 px with 18 px text; it fails without the fix

### CU 23: first-run layout

- [x] The help ("How do I add it?") between the address and the code
- [x] Not opened by default, unlike the suggestion: open, its four apps push the code
  below the fold even on a 1000 px tall desktop window (checked in Chrome) (DEC-147)
- [x] New address moved from beside Copy to the end of the setup with a line on what it
  does; not under the Connected list, since the relay's lockout page sends users to it
  when no app is connected (DEC-147)
- [x] Tests: the order, the row, the browser test's New address flow unchanged

### CU 5 (part): `lang` and `dir`

- [x] Every dialog has `lang="en"` and `dir="ltr"` (in `newDialog`)
- [x] Test on a page with `lang="ar" dir="rtl"`
- Left out: the strings table and `ui: { strings }` (iteration J)

### CU 22: the guide (ractive.ch)

- [x] "Pages that sign you in (no code)"
- [x] "When it does not work": the AI app waits on a tool, "The user declined", "Another
  tab or program took over this page" and what New address costs, "Could not connect"
  and Connect again
- [x] A separate ractive.ch PR, to merge after the client release

### Docs

- [x] Client README (connecting, consequential tools, identity binding, styling: 320 px,
  `lang`/`dir`, new classes), CHANGELOG
