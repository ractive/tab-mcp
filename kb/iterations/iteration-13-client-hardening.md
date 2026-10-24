---
type: iteration
title: "Iteration 13: browser library fixes"
status: planned
description: "Fixes from the 2026-10-24 review of the browser library: the Allow delay in a background tab, argument spoofing with direction characters, Always allow, result and schema edge cases, a tool removed during its confirmation, two connect dialogs, React provider stability."
timestamp: 2026-10-24T21:00:00+02:00
tags: [iteration, security, client]
---
# Iteration 13: browser library fixes

From the review of `packages/tab-mcp-client` of 2026-10-24 (and architecture F5). Seven
findings were confirmed with scratch tests in the session scratchpad
(`client-review/`); each fix needs a test in the repository. Only the client package
changes, so this can run in parallel with iterations 11, 12 and 14. Iteration 10's
library step also changes `src/ui.ts`: do it in this iteration or after it, not at the
same time. Releases as a client patch or minor version.

## Findings and fixes

1. **Medium: the Allow delay runs out while the user is not looking** (`src/ui.ts:213-219`).
   The 750 ms starts at `showModal()`, whatever the tab's visibility or focus. Tools are
   called while the user is in the AI app's window, so the dialog usually opens in a
   background tab; when the user comes back, Allow is enabled, and the click that brings
   the window forward can approve the call. Fix: keep Allow and Always allow disabled
   while `document.hidden` or `!document.hasFocus()`, and start the delay again on
   `visibilitychange` to visible and on `focus`.
2. **Medium: the AI app can disguise the arguments shown for approval**
   (`src/ui.ts:114-120`, `171-175`). `JSON.stringify` keeps U+202E, U+2066-2069 and
   zero-width characters, so `"evil‮moc.elpmaxe@ecila"` shows reordered. The relay
   strips `\p{Cf}` from client names (`cimd.ts:88`) but nothing does it for arguments.
   Fix: show `\p{Cf}`, `\p{Co}` and other invisible characters as visible `\uXXXX`
   escapes in `showArguments`; mark the names of app and tool `dir="ltr"`.
3. **Medium (architecture F5): "Always allow" is on by default** (`src/ui.ts:151-168`,
   `always-allowed.ts`). It lifts the only brake at run time for a tool until reload or
   disconnect, which is what a prompt injection needs. Fix to decide: opt-in for the page
   author (an option like `alwaysAllow: true`), or keep it with a shorter scope. Say in
   the threat model that consent per tool is the page's, not the relay's (one `tools`
   scope covers every tool).
4. **Low: a tool result with an `invalid` key becomes a JSON-RPC error**
   (detected in `src/mcp.ts:357-360`; `src/mapping.ts:78-79` passes the key through). `{content: [...], invalid: "rows
   skipped"}` is sent as `-32602` while `toolcallend` reports "ok". Fix: a tagged union
   from `runTool` (`{kind: "invalid"}` or `{kind: "result"}`).
5. **Low: registration accepts a schema the validator throws on**
   (`registry.ts:55-92` vs `mcp.ts:221-226`, `273-283`). A `$ref` next to a nested `$id`
   passes `schemaProblem` but `@cfworker/json-schema` throws `Unresolved $ref` at call
   time, outside any `try`: every call answers `-32603`, the validator is never cached,
   and `observe.start` has no `observe.end`, so `useToolCalls` shows a call that runs
   forever. Fix: build the validator once at registration (or first list) and refuse the
   tool if it throws; wrap `validate()` so `end` always fires.
6. **Low: a consequential tool removed during its confirmation still runs**
   (`src/mcp.ts:295-318`). A `useTool` component unmounts while the dialog is open, the
   user clicks Allow, `execute` runs. Fix: after `confirm`, check
   `tools.get(tool.name) === tool`, else answer "The tool is no longer available".
7. **Low: two connect dialogs at once** (`src/tab-mcp.ts:586-597`, pairing at `561-566`, `src/ui.ts:604`, `619`,
   `src/react.ts:382`). `showConnectDialog` awaits the UI chunk before `showModal()` with
   no guard, so a double-click on `ConnectButton` opens two; pairing is one boolean, so
   closing either stops the code for both. Fix: one in-flight dialog promise per `TabMcp`,
   or count pairing users.
8. **Low: `confirmDelayMs: NaN` turns the delay off** (`src/ui.ts:140-143`,
   `src/tab-mcp.ts:187`). `Math.max(500, NaN)` is NaN and `setTimeout(NaN)` waits 1 ms.
   Fix: validate in the constructor.
9. **Low: identity stays "pending" if the page's hook never settles**
   (`src/tab-mcp.ts:295-324`). `identityTimeoutMs` starts only after the assertion is
   sent. Fix: start it when the hook is called.
10. **Low: the README `onConfirm` example shows only the self-declared name**
    (`README.md:106-107`, `client.name ?? client.host`). Fix: show name and verified host, as
    `clientLabel` in `ui.ts` does.

## Code quality

- `react.ts:176` holds the provider's `TabMcp` in `useMemo`, which React may discard; use
  a lazy `useState` initialiser or a ref.
- The `grants` getter (`tab-mcp.ts:247`) returns the internal array that also decides
  Always allow (`tab-mcp.ts:704`); return a frozen copy.
- "Nothing happened" tests rely on fixed sleeps (`reconnect.test.ts:141`, `162`,
  `identity.test.ts:31`, `102`); replace with an event or a fake clock where practical.
- Optional: one explicit state type for `#connecting`, `#reconnecting`, `#pageWaits` and
  `#generation`.
- Missing tests named by the review: a consequential call while the page is hidden, the
  result-shape passthrough, a tool removed mid-call, a second dialog.

## Tasks

- [ ] 1: Allow delay counts only while the page is visible and focused
- [ ] 2: invisible and direction characters shown escaped in the confirmation
- [ ] 3: decide on Always allow (opt-in or narrower); threat model sentence on consent scope
- [ ] 4: tagged outcome from `runTool`
- [ ] 5: schema compiled at registration; `end` always fires
- [ ] 6: tool re-checked after confirmation
- [ ] 7: one connect dialog at a time
- [ ] 8: `confirmDelayMs` validated
- [ ] 9: identity timeout starts with the hook
- [ ] 10: README example shows the host
- [ ] Code quality items and the missing tests
- [ ] Changelog, client release, vendored copies (ractive.ch examples, saturnus) updated

# Citations

- [Unicode Bidirectional Algorithm (UAX #9)](https://www.unicode.org/reports/tr9/)
- [React: useMemo caveats](https://react.dev/reference/react/useMemo#caveats)
