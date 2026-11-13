---
type: iteration
title: "Iteration 38: the client API before 1.0"
status: completed
description: >-
  Iteration J of the review of 2026-11-13 (CU 10, 17, 18, 5, 20, 11, 16, 24, 19). One
  event convention (object details, undefined), reconnecting as a ConnectionState and
  statechange as the one connection event, revoke/signOut/refreshIdentity/newAddress
  as promises that settle on the outcome, the delays as constants, three getters and
  useTool's deps gone; every dialog text in one table with ui.strings, ui.setup for the
  help; "Allow until reload" listed in the connect dialog with Ask again and kept across
  useTool re-registration; the styling contract cut to the dialog classes and button
  kinds; a StrictMode-safe provider; ui.ts split into confirm, connect and a shared
  chunk with one render(). Breaking changes, no shims.
timestamp: 2026-11-14T03:00:00+01:00
tags: [iteration, client, api, ui, review]
---
# Iteration 38: the client API before 1.0

Iteration J of [the review of 2026-11-13](../research/review-2026-11-13.md), client UI
report. Owner: "We don't need to watch out for incompatibilities"; breaking changes
allowed, no compatibility shims. Builds on iterations 31, 32, 33 (C, D, E), 34 (F) and
37 (I). Decisions: DEC-149 to DEC-153.

## CU 10: the public API is inconsistent

- [x] Every event detail is an object, `undefined` never `null`: `pairingcode`
  `{ pairingCode }`, `identitychange` `{ identity, identityMessage }`; a change event names
  its values like the properties (DEC-149)
- [x] `ConnectionState` has `"reconnecting"`, through the attempts too; the `reconnecting`
  event is gone, `statechange` fires for each scheduled attempt
- [x] `statechange` stays, `connected` and `disconnected` go; `statechange` carries the
  `reason` when a session ended (DEC-149 says why this one)
- [x] A refusal that stops reconnecting: `error` with `state` already `disconnected`, then
  the `statechange` (a `connect()` from the listener starts afresh and is not undone)
- [x] `revoke()` resolves on the grant's removal; rejects while not connected, when the
  session ends first, and with the relay's error (`store_unavailable`, iteration B)
- [x] `signOut()` resolves once the grants are gone; `refreshIdentity()` resolves with the
  new `identity`; `newAddress()` with nothing; all reject with `InvalidStateError` where
  they cannot ask (DEC-150)
- [x] `confirmInPage(request, { document })`
- [x] ui.ts's `ConfirmAnswer` is `DialogAnswer` (in `confirm.ts`)
- [x] `registerTool`: DEC-010 kept (a rejection); the class's doc example awaits it
- [x] Tests: `tab-mcp.test.ts`, `reconnect.test.ts` (rewritten for the state), `protocol`,
  `relay`, `identity`, `identity-e2e`, `serve`, `react` tests

## CU 17/18: options and parameters nothing uses

- [x] `confirmDelayMs`, `identityTimeoutMs`, `reconnect.delaysMs` are constants; tests
  change `timing` of `tab-mcp.ts` (`setTiming` in the helpers) or pass `allowDelayMs` to
  the internal `confirmDialog`; `delayOption`, `reconnectDelays`, `allowDelay`, the 500 ms
  floor and `ReconnectOptions` gone (DEC-151)
- [x] `reconnect` is a boolean
- [x] The getters `address`, `appName` and `pairing` gone; `exposedTo` kept (owner,
  iteration F passes it on)
- [x] `useTool(tool, options?)`: `deps` gone (DEC-081 amended)
- [x] `connectLabel` no longer exported (it was undocumented); `ConnectButton`'s
  `data-state` is the state
- [x] `useToolCalls` kept: `examples/react-todo` and the live todo example use it
- [x] `TabMcpSnapshot.address` gone (`session?.address`)

## CU 5/20: strings and setup

- [x] Every dialog text in `STRINGS` (`src/strings.ts`, type `DialogStrings`), with `{name}`
  placeholders filled as isolated names; `lang` and `dir` are keys of it (DEC-152)
- [x] `ui: { strings }` replaces texts key by key
- [x] `ui: { setup: { guide, instructions } }`: the help's link (or `null`) and steps
- [x] The default steps are the minimum: ChatGPT's Mac app and turning the Codex feature
  off are left to the guide
- [x] Copy buttons: per-noun labels as keys; while they say "Copied"/"Press Ctrl+C" that is
  their name and what is announced
- [x] Tests: strings and `lang`, setup with `guide: null`, own steps and own guide;
  `setup.test.ts`, the extension's panel test

## CU 11: Always allow

- [x] "Allow until reload", left of Allow; the note "X will run for <app> without asking,
  with any arguments, until you reload this page or disconnect <app>."
- [x] The connect dialog lists "Runs without asking: …" under each app, with "Ask again"
- [x] An entry survives `useTool` re-registration of an unchanged tool: a tool's absence
  counts after the current task, and an entry remembers the title and description the
  user saw (DEC-153)
- [x] Tests: `always-allowed.test.ts`, the dialog's list and Ask again

## CU 16: the styling contract

- [x] One sentence in the README: override with `.tab-mcp-dialog .tab-mcp-x`, one class
  does not win; documented classes cut to the four dialogs and the three button kinds

## CU 24: StrictMode

- [x] The provider disconnects its instance in a microtask, skipped when the effect ran
  again for the same instance
- [x] Test: a child's `connect({ resume: true })` under StrictMode connects (fails on the
  old code)

## CU 19: ui.ts restructured

- [x] Split into `dialog.ts` (shared: CSS, elements, strings, Copy), `confirm.ts` and
  `connect.ts` (with the replaced notice); a page without a relay loads no connect dialog
  or setup steps (build test)
- [x] The connect dialog's five render functions folded into one `render()` from `mcp` and
  a few flags; `pairedGrants`, `known` and `session` bookkeeping gone, the confirmation
  names every connected app
- [x] `checkIcon` replaced by a span with a stylesheet check mark

## Iteration B's `store_unavailable`

- [x] A relay `error` carries its `code` in the `error` event; a pending `revoke()` rejects
  with it; the connect dialog says "The relay could not save this. Try again."

## Users in this repository

- [x] Client README (own UI with tables of methods and events, reconnecting, identity,
  texts and help, styling, React), CHANGELOG with a Breaking section and migrations
- [x] `docs/threat-model.md`, root README, `examples/react-todo`, `test/e2e`, tab-mcp for
  Chrome's worker (`statechange`, `session.address`, `revoke()` errors, `panelStatus`),
  the skill and its references

## Outcome

- The core: 6322 B gzipped of 6400 on top of main's 6298 (the getters, the delay options
  and the `reconnecting` event out pay for most of the promises of `revoke` and `signOut`
  and their answer wait).
- The dialogs: a shared chunk of about 5.7 KB gzipped, the confirmation 1.9 KB, the
  connect dialog 4.7 KB; before, one 10.7 KB chunk for both.
- Not done: nothing of the scope. The class names inside the dialogs stay as they were;
  only the documentation promises fewer.

## Review of PR 127

- [x] `signOut()` could wait forever (a relay store failure sent nothing, an expired grant
  never leaves `grants`): the relay now answers `store_unavailable` for a failed
  `identity.logout`, and `revoke()`/`signOut()` reject with a `TimeoutError` after 15 s
  (`timing.answerTimeoutMs`, which `identityTimeoutMs` became)
- [x] Only `store_unavailable` and `unknown_id` reject a pending `revoke()`/`signOut()`, not
  any coded relay error (claude, glm)
- [x] A page string that is `undefined` keeps the English text
- [x] `disconnect()` from `connecting` or `reconnecting` carries `reason: "user"`, so the
  README's keep-on example clears its flag then too
- [x] `refreshIdentity()` without the hook rejects with a `TypeError` that says so
- [x] `setup.guide: null` documented: pass `instructions` too (the default steps refer
  to the guide)
