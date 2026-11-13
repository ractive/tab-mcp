---
type: iteration
title: "Iteration 39: tab-mcp for Chrome, the look"
status: completed
description: >-
  Overmark's design language on the side panel and the question window of tab-mcp for
  Chrome (owner, 2026-11-13): paper and ink with tokens whose every used pair is held to
  its contrast in light and dark, sections on paper instead of cards, buttons and fields
  with an edge that reaches 3:1, no amber button, the switches in ink, a tool's "Ask
  first" drawn as a switch, pills and notices on tints, an armed second click in red,
  one focus ring, reduced motion and forced colours, nothing in a tooltip alone, the
  badge's colours in one constant, and tests that hold the look.
timestamp: 2026-11-13T19:00:00+01:00
tags: [iteration, extension, ui, accessibility]
---
# Iteration 39: tab-mcp for Chrome, the look

The owner, 2026-11-13: "Overmark did a redesign of the Chrome extension. Apply the same
design language and best practices to tab-mcp-extension as well." The design is
[tab-mcp for Chrome: the look](../design/extension-look.md), written before
[iteration 36](iteration-36-extension-panel.md) (the panel's wording and accessibility)
landed and built on top of it. Branch `iteration/39-extension-look`. Decisions DEC-160
to DEC-163. `packages/tab-mcp-extension/src/sidepanel/style.css` is rewritten; the
markup and scripts change by class names, two attributes and one line of text.

No behaviour of the worker, no message of the protocol and no stored value changes.

## Tasks

### The tokens and the style sheet (DEC-160)

- [x] `style.css` on Overmark's token block (paper, sheet, wash, ink, rule, edge, strong,
  link, focus, danger, warning) with `--ok` and `--ok-bg` for this extension's states;
  every colour of a rule is a token
- [x] Sections on paper with a rule between them; the pairing step and a question are
  sheets; no card, no shadow
- [x] One type scale (13/19 body, 15/20/700 `h2`, 12/16/600 `h3`, 12/17 meta and mono);
  the uppercase labels are plain headings; "Tools" is an `h3`
- [x] Buttons: default with a `--edge` border, strong (ink) for Turn on AI access, Done,
  Save and Allow once, quiet for Copy, New address and the links; a button that takes
  no click (`disabled` and `aria-disabled`) is flat in colours of its own, not dimmed
- [x] One `:focus-visible` ring for every control; `prefers-reduced-motion` stops the
  three transitions; forced colours name the hover and unavailable states too
- [x] The address is shown whole on a wash, without a `title`; what a tool's "Ask first"
  does is a line over the tool list (`askFirstNote`, `aria-describedby` on each switch)
  in place of a tooltip on each label
- [x] An armed second click (Disconnect, New address with apps paired) carries
  `data-armed` and is filled in red
- [x] The toolbar icon's badge colours in `src/look.ts` (`BADGE_LOOK`), the light tokens'
  values, with the text set to white (`setBadgeTextColor`)

### No amber button (DEC-161, owner)

- [x] `primary` is `strong` in `index.html` and `question.ts`; amber is the waiting dot
  only, with its ring

### What a colour says (DEC-162)

- [x] The state's dot: grey off, amber with a ring while connecting, retrying or
  waiting for an app, green on; a paired app's dot green only while connected
- [x] Pills: plain for "reads", "left out" and "Not readable", the warning's tint for
  "asks first", green for "WebMCP · n tools" (`badge ok`)
- [x] The AI access switch and a tool's "Ask first" in ink (off: `--edge`), with this
  extension's geometry; the tokens replace iteration 36's `--off` and `--knob-color`
- [x] A problem is a red notice with its text in ink; "address in use elsewhere" is the
  warning notice; an unanswered question's line is a note on a wash

### Tests (DEC-163)

- [x] `test/contrast.test.ts` (new): every pair of the design's tables from the two
  token blocks, light and dark, the exact ratio and its threshold; the badge's colours;
  and the style sheet's rules (no colour literal outside the blocks, no token unused or
  undefined, no opacity or blurred shadow, hover never reaches an unavailable button,
  amber on the dot only, one focus rule, reduced motion names every transition, forced
  colours name the states that outweigh them)
- [x] `test/e2e.test.ts`, "the look" (Chrome for Testing): nothing past the panel's
  edge at 345, 360 and 420 px with the tools, the address and code, "How do I add it?"
  and Settings open, both notices and a question with unbreakable arguments; no amber
  button; the tokens as computed in light and dark (paper, ink, a button's and a field's
  edge, strong, armed); a question is a sheet with an edge and no shadow, "Allow once"
  flat while it waits; no `title` on the address or an "Ask first" label
- [x] The switch's contrast test of iteration 36 (EQ 17) measures both switches against
  the paper and expects the tokens' ratios: light 16.07 / 14.61 on and 3.86 / 3.51 off,
  dark 15.89 / 15.89 on and 4.39 / 4.39 off (knob on track / track on paper)
- [x] An armed Disconnect is `data-armed` and red (e2e); the question window is on paper
  with the question as a sheet and nothing past its edge (e2e)

### Docs

- [x] `kb/design/extension-look.md`: as built, with screenshots in light and dark
- [x] `kb/design/extension.md` and the package README point to it and name the tests
- [x] `kb/operations/chrome-web-store.md`: the listing's screenshots are of the old
  look and are to be taken again before the next submission

## Not done

- The top bar, the margin rail, chips, banners and the page overlay's rules of Overmark:
  they are for its views and its marks (the design's "Not adopted").
- EQ 18 (the question window) and EQ 20 (the switch beside "Turn on AI access") stay
  open simplifications; the look keeps both as they are.
- No new store screenshots and no release: the coordinating session's.
