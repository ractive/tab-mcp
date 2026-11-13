---
type: iteration
title: "Iteration 37: examples, skill and READMEs"
status: completed
description: >-
  Fixes from the review of 2026-11-13 (iteration I): one rule for consequentialHint in
  docs and examples, local callers and serve in the skill and the READMEs, typed tool
  snippets, the react-todo example brought in line with the live one, the browser's-AI
  line on ractive.ch and the client's data-tab-mcp-webmcp attribute removed, and the
  diagram editor usable from the keyboard, readable on a phone, safe across tabs and
  with an unreadable stored copy kept.
timestamp: 2026-11-13T18:00:00+01:00
tags: [iteration, docs, examples, client, review]
---
# Iteration 37: examples, skill and READMEs

Iteration I of [the review of 2026-11-13](../research/review-2026-11-13.md). Two pull
requests: this repository (skill, READMEs, `examples/react-todo`, the client's WebMCP
attribute) and ractive.ch (the example pages; it keeps the client version it pins, 0.15.0).
EX 1 was fixed and deployed before (ractive.ch PR 103). Decisions: DEC-157 (the
consequential rule), DEC-158 (no attribute), DEC-159 (keep-on after the first pairing).

## EX 2: the rule for consequentialHint

- [x] README, skill (sections 2 and 4) and the overview's snippet: ask for what the user
      cannot undo in the page or what acts outside it (DEC-157)
- [x] The three `add_note` snippets are one: typed, `title`, `minLength`/`maxLength`, no
      cast, no hint; the overview's snippet adds `delete_note` as the consequential one
- [x] `examples/react-todo` leaves `alwaysAllow` off; its e2e test checks that the
      question has no "Always allow"
- [x] The mermaid step "opt the tool changes something" is "cannot be undone in the page"
      (README and ractive.ch's copy)

## EX 3: the diagram from the keyboard

- [x] The canvas is focusable (`tabindex="0"`, `role="application"`, described by the
      help text); `]` and `[` select the next and previous shape or arrow; `A` starts an
      arrow from the selected shape, `]`/`[` and Enter pick the target
- [x] The canvas's label names the counts and the selection; the status line announces
      each selection; the label editor gives the focus back to the canvas
- [x] Help text says how; browser check in ractive.ch's `check:tab-mcp`

## EX 4: the skill and the 0.15.0 features

- [x] Section 4: `onConfirm` returns `ConfirmAnswer`, with `"unanswered"`
- [x] Section 2: `client.kind` `local`, and a three-way label
- [x] Section 3: a short part on `serve` without a relay; the description mentions it
- [x] Root README: a paragraph on `serve`; `examples/react-todo`: three-way caller label

## EX 5: clear_diagram asks, delete_elements does not

- [x] Kept as the demonstration of the question; the page says so and that Undo takes
      back every change until a reload (DEC-157)

## EX 6: the todo page's button

- [x] "Show address and code" once connected, as on the diagram page; the status with no
      app paired no longer speaks of a code that is not shown (both pages)

## EX 7: layout rearranges what the user placed

- [x] `add_shapes`, `layout` and the server instructions: layout only for a diagram drawn
      from scratch or when asked; next to existing shapes give x and y

## EX 8: labels too small on a phone

- [x] The canvas never goes below 0.6 CSS px per unit; beyond, the SVG gets its size and
      a scroller around it scrolls (at most 75vh high); a finger pans on empty canvas and
      drags on a shape (`touch-action`), the label editor follows the scroll
- [x] Browser check at 375 px; not tried on a real phone (iOS Safari's `touch-action` on
      SVG children is the open question)

## EX 9: untrustedContentHint

- [x] `list_todos` (both copies) and `get_diagram`; the overview's `list_notes`

## EX 10: two todo examples

- [x] `examples/react-todo`: `useTool<…>` generics, titles, `maxLength` 200, a cap of 200
      todos (with a test), `role="status"`, the casts gone; `complete_todo` takes `done`
- [x] README: the live page is "based on" the example; the casts in README, skill and
      `references/react.md` are gone

## EX 11: the browser's-AI line and the attribute

- [x] ractive.ch: `shared/browser-ai.ts`, its test, both call sites, `#ai-browser` and the
      CSS deleted (grep: nothing else in either repository reads the attribute; the
      extension's test page keeps it to check that the extension ignores it)
- [x] Client: `webmcp.ts` no longer writes `data-tab-mcp-webmcp` (unit, browser and build
      tests changed); CHANGELOG "Removed", client README, skill and threat model updated
      (DEC-158)

## EX 12: control characters in labels

- [x] `checkLabel` drops what XML does not allow (C0 controls except tab, LF, CR;
      U+FFFE, U+FFFF; unpaired surrogates), `escapeXml` as a second layer; tests

## EX 13: the sign-in page waits longer than the library

- [x] The page waits 12 s for Google's new token, within the library's 15 s. Not
      `identityTimeoutMs: 25_000`: iteration J makes the delays internal

## EX 14: the Edge Script's Origin check

- [x] Comments in `handler.ts` say what the check does (browsers) and does not
      (programs); `references/sign-in.md` says a real web app signs for its session's
      user, not for an ID token from the page

## EX 15: small disagreements

- [x] README: `diagram` in the Claude Code command, Bun 1.4.4, "read, add and delete
      notes"; overview: "a WebMCP hint that MCP does not have"

## EX 16: keep-on after one click

- [x] Diagram, todo and sign-in pages and the client README's snippet set the flag only
      with an app paired (DEC-159); browser check that opening the dialog does not set it

## EX 17: two tabs of the diagram

- [x] A `storage` event takes the other tab's diagram as one undo step; browser check

## EX 1 follow-up: a stored diagram that cannot be read

- [x] `loadDiagram` keeps it under `tab-mcp.diagram.unreadable` before the next save
      overwrites it, and the status line says so; unit test and browser check

## EX 18: code that repeats itself

- [x] The diagram page's six copy buttons come from one loop over the front matter
- Not done: the label editor as `contenteditable` (kept for the password managers'
      buttons), the explicit `storageKey` (needed until 2027-01-21, DEC-062), the
      hand-written "AI access" panels and the keep-on logic (a library option would be
      iteration J's or later), the two near-identical example servers (different
      packages, 37 lines each)

## CU 21: the client README's `client`

- [x] `client` described with `local`; the `onConfirm` and `toolcallend` samples name a
      `local` caller correctly
- Not done here: the reorder, the reference table and the moves to `docs/` (CU 21's
      other points). Iterations E and J rewrite large parts of the client README at the
      same time; the reorder belongs after them

## Checks

- [x] `bun run verify`; ractive.ch: `bun test`, `typecheck`, `lint`, `check:tab-mcp`
