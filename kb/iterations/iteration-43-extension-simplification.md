---
type: iteration
title: "Iteration 43: simplification of tab-mcp for Chrome"
status: completed
description: >-
  The owner's decisions on the extension's rows of the review's simplification table
  (DEC-178) and on the question card's buttons. The question's own window is gone: where
  Chrome refuses the side panel after a click on a notification, the notification asks
  again (EQ 18, DEC-181). Starter and attachWhenStarted are gone: a panel's messages wait
  on the start as callbacks of one promise, with no buffer and no cap (EQ 19, DEC-181).
  "Allow once" is a default button like "Don't allow" (DEC-180). About 420 lines of
  source and 330 of tests fewer.
timestamp: 2026-11-14T20:00:00+01:00
tags: [iteration, extension, review, simplification]
---
# Iteration 43: simplification of tab-mcp for Chrome

The owner decided, on 2026-11-14, the two extension rows of the simplification table of
the [review of 2026-11-13](../research/review-2026-11-13.md) (EQ 18, EQ 19; DEC-178 left
them to a separate extension PR), and that the question card must not nudge towards
allowing. Branch `simplify/extension`.

## EQ 18: the question's own window

A click on a notification's body opened the side panel of the tab's window, or, where
Chrome refused `sidePanel.open` (or the tab was gone), a popup window of the extension's
with the one question. That window was about 330 lines and a second answering channel
(its own port, sender check, window bookkeeping), for a case the e2e tests reached only
because the DevTools Protocol gives no user gesture.

- [x] Remove `src/question/*`, `src/worker/question-windows.ts`, `QUESTION_PORT`,
  `QUESTION_PATH`, `isQuestionSender`, `parseQuestionAnswer`, the `question` worker
  message, the port and `windows.onRemoved` glue in `background.ts` and
  `connection.ts`, the build entry and the two `.question-window` rules
- [x] Where the panel does not open, `Questions.notificationClicked` sends a new
  notification ("Allow once", closing it is Don't allow, its own 500 ms guard); the
  tab's window is brought to the front either way, so the icon's "?" is at hand. The
  panel's card stays the other way to answer
- [x] Kept: ES 5's guard (`movedUntil` in the panel, untouched) and EQ 13's countdown and
  "Not answered in time" notice (`updateCountdowns`, `expired`, the panel's own code)
- [x] Tests: unit test for both refusals (panel refused, tab unknown), e2e test of the
  refused path (the notification asks again, the first one's closing answers nothing,
  Allow once from the new one, closing the new one is Don't allow); the window's unit
  and e2e tests removed
- [x] Docs: package README, `docs/threat-model.md`, `kb/design/threat-model.md`,
  `kb/design/extension.md`, `kb/design/extension-look.md`. PRIVACY.md and the store
  listing text do not name the window

## EQ 19: `Starter` and `attachWhenStarted`

- [x] `background.ts` keeps one start promise (`ready()`), forgotten when it rejects, so
  the next Chrome event or panel message tries again; `started` holds the connection
  for the notification click, which must not wait
- [x] A panel's port: the worker listens from the moment it connects; each message waits
  on the port's attachment (`attach()`, one promise per port, reset on a failed start),
  so Chrome's order is kept by the order of the callbacks. `Connection.addPanel` returns
  the receiver instead of taking an `early` list
- [x] The cap on early messages (64) is not needed and is gone: nothing is buffered by
  hand; the waiting callbacks live only while one start runs (opening IndexedDB), and
  only the extension's own panel page can send them
- [x] Tests: the `Starter` and `attachWhenStarted` unit tests removed; the e2e suite
  opens panels through this path in every block

What changes on a failed start: messages that waited on it are dropped (before, they were
kept and replayed), and a panel that connected meanwhile is attached at its next message,
not as soon as another event's start succeeds. Its `hello` (its window) can be lost that
way; the panel says "Close and open this panel to try again", which sends it again.

## The question card's buttons (DEC-180)

- [x] "Allow once" without the `strong` class: all three answers are default buttons;
  the 750 ms guard (`aria-disabled`) stays
- [x] Unit test (`navigation.test.ts`: no class on any answer) and the e2e look test
  ("Allow once" and "Don't allow" have the same computed fill, text, edge and weight)
- [x] `kb/design/extension-look.md` (Amber, components table, As built), DEC-161 amended
- [x] Store screenshots `3-question.png` and `4-navigation.png` taken again with
  `bun scripts/screenshots.ts` (Chrome for Testing 157) and looked at; the other two do
  not show a question card and were left as they were

## Lines

| | removed | added | net |
|---|---|---|---|
| Source (`src/`, `scripts/build.ts`) | 548 | 130 | −418 |
| Tests (`test/`) | 413 | 87 | −326 |

## Checks

- [x] `bun run verify`
- [x] Extension e2e suite with Chrome for Testing 157 (`CHROME_PATH`): 52 pass, 1 skip
  (the idle test, `TAB_MCP_E2E_IDLE`)

## Not done

- The question pictures in `kb/design/extension-look/` are iteration 39's and still show
  "Allow once" filled; As built says so.

# Citations

- [Full review of 2026-11-13 (EQ 18, EQ 19, the ES list)](../research/review-2026-11-13.md)
- [Decision log: DEC-178, DEC-180, DEC-181](../decision-log.md)
- [tab-mcp for Chrome: the look](../design/extension-look.md)
