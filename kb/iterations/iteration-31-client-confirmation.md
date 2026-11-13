---
type: iteration
title: "Iteration 31: the client's confirmation and registry"
status: completed
description: >-
  Fixes from the review of 2026-11-13 (iteration C): a non-boolean hint is refused
  instead of dropped, only real MCP results pass through (with their _meta), the schema
  check skips data, confirmations are shown one at a time and Allow waits until the
  arguments were seen, stray keys cannot refuse, the dialogs keep page colours and
  pointer-events out, and serve ends when its port closes.
timestamp: 2026-11-13T12:00:00+01:00
tags: [iteration, client, review, security, ux]
---
# Iteration 31: the client's confirmation and registry

Iteration C of [the review of 2026-11-13](../research/review-2026-11-13.md), client
package only. Decisions: DEC-133 (registration), DEC-134 (results), DEC-135 (the
confirmation, the served port).

## CC 2: a hint that is not a boolean fails open

- [x] `validateTool` rejects a non-boolean `…Hint` or `debugging` with a `TypeError`;
      other keys stay ignored (DEC-133, amends DEC-051)
- [x] `RegisterToolOptions.webmcp` must be a boolean
- [x] Tests: `registry.test.ts` (the old test asserted the unsafe drop)

## CC 3 (= WM 12): result mapping

- [x] `isCallToolResult`: `content` of MCP content blocks by type, `isError`,
      `structuredContent`, `_meta` checked; exported for iteration F (DEC-134)
- [x] A passed-through result's `_meta` is merged with the server info
- [x] `structuredContent` from the parsed JSON text: none for `Date` or `URL`
- [x] `resultText` moved to `mapping.ts`
- [x] Tests: `mapping.test.ts`, `mcp.test.ts`

## CC 13: the schema walk reads data as schema

- [x] `eachSchema` skips `default`, `examples`, `const`, `enum`, and treats the maps
      under `properties` and the like as names; `x-mcp-header` in the same walk
- [x] A malformed `%` in a `$ref` does not resolve (`TypeError`, not `URIError`)
- [x] Tests: `registry.test.ts`

## CU 1: stacked confirmations

- [x] One confirmation shown at a time per document; the others wait, a cancelled one
      leaves the queue; "N more calls are waiting after this one."
- [x] The delay starts again when another dialog closes over the confirmation
- [x] Tests: `ui.test.ts`, `browser.test.ts` (headless Chrome)

## CU 2: Allow without the arguments seen

- [x] The box grows to `min(50vh, 24rem)`; when it overflows, Allow and Always allow
      wait until it was scrolled to its end, with a note and `tabindex="0"`
- [x] Tests: `ui.test.ts` (stubbed layout), `browser.test.ts` (real layout)

## CU 3, CU 8: page rules reach into the dialogs

- [x] `color: inherit` on every element of a dialog; buttons reset `width`,
      `text-transform`, `letter-spacing`; `pointer-events: auto` on the dialog
- [x] Shadow root considered and not taken (styling contract, iteration J; DEC-135)
- [x] Tests: `browser.test.ts` with a dark page and `body { pointer-events: none }`

## CU 13: a stray key refuses

- [x] Before the delay has run out, Enter and Space on a button and Escape are ignored;
      clicks still answer
- [x] Tests: `ui.test.ts`, `browser.test.ts` (a real Enter before and after the delay)

## CU 14: screen readers

- [x] `aria-describedby`: the question, and the arguments up to 500 characters
- [x] Disconnect buttons named `Disconnect <app>`

Not done: an announcement when Allow becomes enabled.

## CC 1 (rest): a served port that drops

- [x] `serve` closes on the port's `close` event where the port has it
- [x] Tests: `serve.test.ts` (Bun's `MessagePort`, an `EventTarget` port),
      `serve-browser.test.ts` (Chrome with `MessagePortCloseEvent`: the chat's frame is
      removed, the open confirmation closes, the call ends `cancelled`)

Chrome 151 does not fire the event without that Blink feature, so the README keeps
telling the page to close a dead serve itself.

## CC 8: a served port has no limits

- [x] No cap: A15 already states it (added after the reviewers' tree); the README says it
      now too, and the queue (CU 1) shows a burst of consequential calls one at a time

## Docs

- [x] Client README (results, hints, schema data, serve, confirmation, styling)
- [x] `docs/protocol.md` (the port's `close`), `docs/threat-model.md` (A6, A15)
- [x] CHANGELOG (client, Unreleased)

## Outcome

The core grew by about 100 B gzipped (6346 of 6400 B; main was 6243 B), all in
`registry.ts`. Not done: an announcement when Allow becomes enabled (CU 14); re-checking
"Always allow" for a queued call of the same tool once the call before it was allowed
always (the user is asked again, the safe direction); an `onConfirm` that ignores the
call's `signal` still keeps a cancelled call waiting (unchanged, the library's own
dialog closes on it).
