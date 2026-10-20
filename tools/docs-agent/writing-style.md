---
title: "Writing style for everything people read"
type: doc
status: active
date: 2026-10-19
tags:
  - docs
  - ux
---

# Writing style for everything people read

Applies to every text a person reads: the app (buttons, menus, dialogs,
tooltips, errors, the tour, the command palette), Files, the landing page,
the desktop app's menus and dialogs, the CLIs' help and messages, the
READMEs, crate docs on docs.rs and the changelog's unreleased section.

## Rules

- Plain, short English. One idea per sentence. Say what the thing does or
  what to do, then stop.
- British spelling, as the texts already use: colour, notarised,
  recognised, behaviour, maths.
- The same thing has the same name everywhere: a button's label is the word
  the docs, the tour and the palette use for it. See the glossary.
- Buttons and menu items: sentence case, a verb first ("Save state",
  "Choose a ROM…"). An ellipsis only where a dialog or picker follows.
- Error messages: what happened, then what to do. No blame, no
  apologies, no "Oops".
- Concrete beats abstract: "Drop the ROM file here" beats "Provide a ROM".
- Write for someone who knows the calculator, not the code. No internal
  names (crate names, worker, backend, hub, protocol message names) in the
  app's or the landing page's texts; the READMEs and docs.rs may name them
  where a developer needs them.

## Avoid

- AI tells: "seamlessly", "effortlessly", "robust", "powerful", "leverage",
  "delve", "unlock", "elevate", "dive in", "whether you're …", "it's worth
  noting", "Note that", "Please note", "simply", "just" (as filler),
  "in order to", "utilise", stacked hedges ("may possibly"), rhetorical
  triplets, a colon headline on every sentence, chains of em dashes,
  exclamation marks, emoji.
- Eccentric wording: invented terms, metaphors, telegraphese ("ROM-gated
  e2e binary"), noun stacks, cute jokes, overly formal politeness.
- Marketing superlatives ("the best", "blazing fast").

## Glossary

| Use | Not | Notes |
|---|---|---|
| ROM, ROM file | ROM image, ROM dump, firmware | "read the ROM out of your calculator" for dumping |
| saved state | snapshot, save game | actions: "Save state", "Load state"; the file is a state file (`.sat`) |
| the app | the web app, the page, the site | the calculator app at /saturnus/app/; "the desktop app" for the native one; "in the browser" for where it runs |
| calculator | emulator, device | say "emulator" only to contrast with a real calculator |
| Files | transfer view, transfer page | the app's view for moving files |
| menu keys | softkeys, function keys | the top key row, HP's own term |
| model | variant, machine | "HP 48GX" on first mention, then "48GX" |
| speed: 1×, 2×, 4×, Max | real time, turbo | |
| memory view | explorer, memory browser | the app's view of the calculator's variables |
| AI app | AI tool, AI assistant, agent, LLM | the user's Claude, ChatGPT, Claude Code, Cursor, … that uses the calculators over MCP; "Connect your AI app…" opens its dialog |

When a text needs a term not listed here, keep the one the app already
uses most; when two compete, pick one and note it in the PR body.

## Leave alone

Machine-read strings (JSON keys, CLI flag and subcommand names, protocol
messages, storage keys, file names, CSS classes, test selectors), code
comments (except crate-level docs shown on docs.rs), the changelog's
released sections, `AI_NOTICE`, `LICENSE`, and `kb/`. `web/about.json`,
`web/flags.json` and `web/commands.json` are generated: fix their texts
at the source, not in the JSON. `about.json` takes its sources from the
wiki and its own texts (the ROM notes) from `scripts/about-json.py`
(`just about`); `commands.json` comes from
`crates/saturnus-cli/data/commands/reference.json` (`just commands`);
`flags.json` from the wiki (`just flags`).
