---
type: iteration
title: "Iteration 46: tools that run without asking"
status: completed
description: >-
  Every demo page should let the user pick the tools that run without asking and turn on
  "allow everything, no questions asked" (owner, 2026-11-19). The client library keeps
  allowances per AI app until the app is disconnected (alwaysAllow true; "until-reload"
  is the old scope), honours them with its dialog and with a page's own onConfirm, shows
  a switch per tool and "Allow everything" in the connect dialog, and gives pages the
  same allowances as an entry of their own, @ractive-ch/tab-mcp-client/allowed.
timestamp: 2026-11-19T23:30:00+01:00
tags: [iteration, client, ui, security]
---
# Iteration 46: tools that run without asking

The owner, 2026-11-19: "The goal is that we have in every demo app (page) a way to select
which tools to allow always plus a switch to 'allow everything always, no questions
asked'." Until now "Allow until reload" (DEC-096) lived in memory, was offered only in
the confirmation, and a page with its own `onConfirm` could not use it. Branch
`client/allowed-tools`; DEC-200.

## What changes

- **Kept until the app is disconnected.** `alwaysAllow: true` keeps allowances in the
  page's `storage` next to the secret (`<secret key>#allowed`); `"until-reload"` keeps
  them in memory. They end when the relay says the grant ended, and when the secret
  changes; a dropped connection or a reload keeps them.
- **Everything.** Per AI app, "Allow everything, no questions asked": every tool, also
  later, changed and destructive ones.
- **Honoured everywhere.** An allowed call runs without the library's dialog and without
  the page's own `onConfirm`.
- **The dialogs.** "Always allow" (or "Allow until reload") in the confirmation; in the
  connect dialog a switch per tool and "Allow everything" under each connected app.
- **The API.** `allowedTools(mcp)` from `@ractive-ch/tab-mcp-client/allowed`;
  `useAllowedTools(grantId)` in `./react`.

## Tasks

- [x] `always-allowed.ts`: per grant, what the user saw, everything, storage, pruning on
  the relay's grants, the secret's fingerprint
- [x] `confirm.ts`: `confirmCall` for every consequential call; the third button's text
  per mode
- [x] `connect.ts`, `dialog.ts`, `strings.ts`: switches under each connected app
- [x] `allowed.ts` entry, build, declarations, consumer type check; `useAllowedTools`
- [x] Tests: storage, reload, dropped connection, disconnect, expiry on connect,
  `newAddress()`, another tab, a malformed value, memory modes, `onConfirm`, the relay
  end to end, the dialogs, React
- [x] README, changelog, `docs/threat-model.md` (A6), `kb/design/threat-model.md`, the
  plugin's skill

## After the release

- Not in this branch: the demo apps on ractive.ch, saturnus and Overmark turn on `alwaysAllow: true` or
  draw their own switches.

# Citations

- [Decision log](/decision-log.md), DEC-096 and DEC-200
- [Client README: tools that run without asking](https://github.com/ractive/tab-mcp/tree/main/packages/tab-mcp-client#tools-that-run-without-asking)
