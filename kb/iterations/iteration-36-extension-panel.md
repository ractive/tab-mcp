---
type: iteration
title: "Iteration 36: tab-mcp for Chrome, the panel's wording and accessibility"
status: completed
description: >-
  Iteration H of the review of 2026-11-13: the side panel names its controls by what
  they act on (Read all sites without a click, Don't ask for these tools, an "Ask first"
  switch per tool, Allow once), says in the user's words why a tab cannot be read and
  what works on a page without tools, says what the extension does on a first look,
  lists the paired apps while off without a Disconnect that does nothing, keeps the
  keyboard focus, announces a question in one line, counts a question down and says when
  it ran out, keeps a failed Copy's text, and gives the AI access switch 3:1 contrast.
timestamp: 2026-11-13T16:00:00+01:00
tags: [iteration, extension, review, accessibility]
---
# Iteration 36: tab-mcp for Chrome, the panel's wording and accessibility

Iteration H of the [review of 2026-11-13](../research/review-2026-11-13.md), on top of
[iteration 35](iteration-35-extension-store.md) (iteration G, which dropped the
ephemeral "Always allow", DEC-139). Branch `iteration/36-extension-panel`. Decisions
DEC-154 to DEC-156. Mostly `packages/tab-mcp-extension/src/sidepanel/*`; in the worker
only what the panel needs (`tabs.ts`'s refusal reasons, the question's end, the kept
list of paired apps, the notification's wording).

## Tasks

### EQ 2: an AI app in the same Chrome profile becomes "the tab in front"

- [x] Changed differently: no skipping of the AI app's tab (DEC-156). The pairing box says
  to use the AI app outside this Chrome profile, and why; the README too
- [x] Test: panel (the note in the pairing box)

### EQ 6: the unreadable-tab text is written for the AI app

- [x] `NoAccessError` carries a reason (`hidden`, `no-grant`, `browser-page`,
  `web-store`, `not-site`); `TabView.noAccess` passes it to the panel, which writes its
  own sentence ("Click the tab-mcp icon in Chrome's toolbar to let it read this tab.").
  A hidden address may be a browser page, so the panel adds that Chrome's own pages
  cannot be read; with host access on all sites a hidden address is one, and the panel
  says only that
- [x] The AI app's text names the icon in the toolbar, not "on the tab", and the host
  access button by its new label
- [x] Tests: unit (reasons, the AI app's text), panel (the panel's texts), e2e (store
  package: the panel's line on a tab without a click)

### EQ 7: first run and pages without tools are dead ends

- [x] While no app is paired, a line under the heading says what the extension does and
  names the relay
- [x] "AI access is off · paired apps stay paired" only with apps paired
- [x] "No WebMCP" replaced: "This page offers no WebMCP tools" or "WebMCP is off in this
  tab" (origin trial, `chrome://flags/#enable-webmcp-testing`, a link to Chrome's WebMCP
  docs), each saying that `page_info` and the navigation tools still work
- [x] Tests: panel (`cardView`, `introText`, `webmcpNote`, `index.html`), e2e (store
  package: a page without tools)

### EQ 8: Disconnect while not connected, and the list that vanishes

- [x] Disconnect only while connected; off, connecting or retrying the list says why
  there is none ("Turn on AI access to disconnect an app.")
- [x] The worker keeps the relay's last list of paired apps in IndexedDB (`grants`) and
  shows it while off, also in a new worker; a new relay empties it (DEC-155)
- [x] A `revoke` the library refuses (not connected) sets the problem instead of doing
  nothing in silence
- [x] Tests: panel (`cardView`), worker (`loadGrants`/`saveGrants`), e2e (off: no
  Disconnect, the note; after a restart of the extension the app is still listed)

### EQ 9: "allow" controls with near-identical labels

- [x] Renamed by what they act on (DEC-154): "Read all sites without a click" / "Reads all
  sites without a click. Stop reading all sites", with a line before the button on what
  Chrome will ask; "Don't ask for these tools" / "Ask first for these tools" over the
  list; the "allowed"/"asks first" pill is an "Ask first" switch; the question's and the
  notification's Allow is "Allow once" beside "Don't ask again on <host>"
- [x] The AI app's texts (`noAccess`, the navigation tools' description), README,
  PRIVACY.md, the threat models, `kb/design/extension.md`, the store listing
- [x] Tests: panel, navigation (the card's buttons), worker (the notification), e2e

### EQ 11: focus and other accessibility gaps

- [x] The tool list is made anew with each state; the focus goes back to the same tool's
  switch (`data-tool`)
- [x] `aria-disabled` instead of `disabled` during the 750 ms waits (the question's
  buttons in the panel and the question's window, the switches, the button over the
  list); a click then does nothing
- [x] `#questions` is no live region; a visually hidden `role="status"` line says "<app>
  asks to run <tool>" (also in the question's window, whose `aria-live` went)
- [x] `#problem` and the panel's own problems `role="alert"`, `#tab-access`
  `role="status"`; texts set only when they change, so nothing is read out again
- [x] The pill is a native checkbox with `role="switch"`, labelled "Ask first: <tool>",
  styled as a control and unlike the static badges
- [x] Tests: navigation (`aria-disabled`, `setReady`), panel (roles in `index.html`, the
  announcement), e2e (focus kept, the switch's role and label, a waiting switch ignores a
  click, the status line)

### EQ 13: a question shows neither its time limit nor its outcome

- [x] `QuestionView.expiresAt`; the card counts down ("47 s left to answer; no answer is
  Don't allow."), in the panel and in the question's window
- [x] A card the worker says ran out (`PanelState.expired`, the questions that timed out
  in the last 10 s) leaves "Not answered in time: <tool> did not run." for 6 s
- [x] The notification's context line: "On <site> · Closing this is Don't allow"
- [x] Not done: a record of what ran (the review's last sentence names the gap but
  suggests nothing for it)
- [x] Tests: worker (`expiresAt`, `expired`, the notification), navigation (the
  countdown), panel (`countdownText`), e2e (the countdown in the panel)

### EQ 16: a failed Copy's fallback text is erased by the next state

- [x] A refused clipboard selects the address or the code in place, as for the setup
  commands, and says so in the Copy status; the address and the code are set only when
  they change, so a state keeps the selection
- [x] The panel's own problems (a refused permission, an extension that was reloaded) in
  an element of their own (`#local-problem`), which the worker's states do not overwrite
- [x] Test: e2e covers the elements; the selection path is the setup commands' (panel
  test)

### EQ 17: the switch's contrast

- [x] Dark: the knob takes the card's colour (`--knob-color`); light: `--off` is
  `#7b8494`. Measured in Chrome for Testing 157 from the computed colours: light on
  5.02:1, off 3.77:1; dark on 9.48:1, off 3.42:1, knob on track and track on card (before:
  dark on 1.74:1, light off 2.54:1)
- [x] Test: e2e (both themes, both positions, at least 3:1)

### Simplification items of the review that touch the panel

- [x] Not done, candidates for the owner: EQ 20 (one button instead of the switch and its
  intent state machine), "Don't ask for these tools" removed (the per-tool switch and the
  question's third button remain), EQ 18 (the question's own window). See Outcome

## Outcome

- **EQ 2 changed differently** (DEC-156): skipping tabs of a paired app's host works only
  with host access, since Chrome hides the address of a tab the extension may not read,
  and the host of a client id need not be the host the chat runs on; a heuristic that
  works in one mode and not the other would make the tab in front harder to predict. The
  pairing box says where to run the AI app instead.
- **EQ 17 found a bug of its own**: the first try named the colour `--knob`, which
  `.switch input` already uses for the knob's size, so the knob had no background at
  all. The e2e test read the computed colours and caught it before it shipped.
- **EQ 20 kept** (the switch): the owner had the knob's geometry fixed and tested in three
  colour modes, so the switch is a look the owner chose; one button would save about
  45 TS, 90 CSS and 110 test lines. "Don't ask for these tools" stays: removing it
  drops a capability (a site's tools allowed in one step) and is the owner's call. EQ 18 (the question's
  window) is worker and bridge code, outside this iteration.
- Follow-up for ractive.ch: the published privacy page
  (`src/pages/tab-mcp/privacy/index.vto`) still says "Allow on all sites"; it should say
  "Read all sites without a click", as PRIVACY.md now does.

# Citations

- [Review of 2026-11-13, tab-mcp for Chrome: code quality and UX](../research/review-2026-11-13.md)
- [WCAG 2.2, 1.4.11 Non-text Contrast](https://www.w3.org/TR/WCAG22/#non-text-contrast)
