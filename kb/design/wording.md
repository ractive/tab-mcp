---
type: design
title: "Wording: one term for one thing"
description: >-
  The glossary every text a person or an AI app reads follows, in the client library's
  dialogs, the tab-mcp browser extension and the relay's pages and messages: the term for
  each of 31 concepts, the differences that keep two terms on purpose, the texts an AI
  app reads, and how the library writes plural forms and lists (Intl, English only in the
  package). Check new texts against it.
tags:
  - design
  - wording
  - ui
  - client
  - extension
  - relay
timestamp: 2026-11-21T12:00:00+01:00
---

# Wording: one term for one thing

The owner, 2026-11-21: "Make it coherent." An audit of every text in the library, the
extension and the relay found 23 of 29 concepts written more than one way (worst: "pair"
in the extension against "connect" everywhere else; one allowance under three names in
the library; "app" for the AI app, the page's app id and the extension). DEC-208 records
the decision; this file is the reference for new texts.

## Rules

- **One concept, one term, on every surface.** A label that another text quotes is
  quoted verbatim (with curly quotes in user texts: “Connect your AI app”).
- **"AI app" in full** whenever it stands alone. "app" alone only in "Disconnect all apps"
  (the owner's name, DEC-201), where nothing else can be meant.
- **Plain words** over developer words in user texts: "address" (not endpoint, remote MCP
  server), "sign-in page" (not the relay's page), "code" (not pairing code), "connect"
  (not pair). Code, identifiers, message types and developer docs may keep "pair".
- **"type the code"**, never "enter".
- **"on the page"** for the page's own UI and what a person does there; "in the page" only
  for things inside its document.
- **British spelling**, as the files have it.
- A confirmation **repeats the button** that asked for it ("Disconnect all apps" →
  "Disconnect all apps").
- A switch and the button that turns it on **use the same words** (DEC-184), with the
  duration in the note under it.

## Glossary

| # | Concept | Term |
|---|---|---|
| 1 | The AI program (Claude, ChatGPT, …) | **AI app** |
| 2 | Putting the address into the AI app | **add** ("Add this address to your AI app:") |
| 3 | Making an AI app able to use the page (the code step and the act) | **connect** |
| 4 | The box or dialog with the address and the code | **“Connect your AI app”** (library dialog, extension card heading, relay help) |
| 5 | Showing the setup again for one more AI app | **Connect another AI app** (extension: "+ Connect another AI app") |
| 6 | Disconnecting one AI app | **Disconnect** (armed: "Disconnect? Click again"); only while connected: "To disconnect an AI app, connect this page again first." / "Turn on AI access to disconnect an AI app." |
| 7 | Disconnecting every AI app (new secret) | **Disconnect all apps** |
| 8 | The extension's on/off | **AI access** ("Turn on AI access", "AI access is off"; the card's heading) |
| 9 | What the user adds to the AI app | **address** ("connector" only where Claude's own menu is quoted) |
| 10 | The 8 letters | **code**; "The code changes every 2 minutes and after each use." |
| 11 | The relay's page where the code is typed | **sign-in page** |
| 12 | Allowing this one call | **Allow once** (a connection question's "Allow" stays: there is no longer) |
| 13 | Refusing | **Don't allow** |
| 14 | Letting a tool run without asking from now on | label **Always allow** (or **Allow until reload**); explanation "runs without asking" |
| 15 | Letting every tool run without asking | library: **Always allow everything**; extension: **Always allow all** (see below) |
| 16 | Turning an allowance off | switch off; "it asks you before each call" |
| 17 | Tools that ask before each call | **asks first** (user); "consequential" for developers; "destructive" is a second mark (may delete or overwrite) |
| 18 | The thing with the tools | **page**; **site** only where the scope is an origin; **tab** only for the browser tab; "page or browser extension" where both are meant |
| 19 | The extension | **tab-mcp browser extension** in notifications, AI-facing texts and prose; **tab-mcp** inside its own panel |
| 20 | State: off | "AI access is off" (extension); "Not connected." (library, no switch) |
| 21 | State: connecting | **Connecting…** |
| 22 | State: connection lost, trying again | **Connection lost. Reconnecting…** (extension's state line: "Connection lost · reconnecting…") |
| 23 | State: on, no AI app yet | "no AI app connected yet" |
| 24 | The list of AI apps with access | **Connected AI apps** |
| 25 | AI apps that keep their access while AI access is off | they **stay connected** ("your AI apps stay connected for next time") |
| 26 | What AI apps do with a tab or program that took over | **use** |
| 27 | Being signed in | **signed in** |
| 28 | An AI app's access ended by the user (AI-facing) | **disconnected** ("This AI app was disconnected from the page.") |
| 29 | A question that ran out | "Not answered in time" |
| 30 | The extension's setting that fills in its code on the sign-in page | switch **Fill in the code for me** (DEC-210); the line under it: "While this is on, tab-mcp asks you and fills in the code when an AI app opens the sign-in page of <host> …" |
| 31 | Filling in the code for an AI app's host without asking from now on | label **Always allow** beside "Don't allow" and "Allow once" (DEC-213); the hosts listed under "Filled in without asking for:", each with **Remove**; after each such fill: "Filled in the code for <name> (<host>)." |

## Differences that stay

- **"Always allow" covers different things.** In the extension: one site (exact origin),
  for every connected AI app, until switched off in the tool list; its button names the
  site ("Always allow on <host>"). In the library: one AI app on this page, until that AI
  app is disconnected, or until reload (`alwaysAllow: "until-reload"`, `storage: null`),
  then labelled "Allow until reload". The notes under each say the scope and duration.
- **"all" against "everything".** The extension's "Always allow all" selects the tools
  listed now on the site; a tool added later asks and turns it off. The library's "Always
  allow everything" covers every tool for that AI app, also future, changed and
  destructive ones (DEC-200).
- **Other callers are not AI apps:** "An agent in this browser" (WebMCP) and "{name}
  (this site's assistant)" (`serve`).
- **The extension's two "connected"**: AI access (the extension to the relay: on, off,
  connecting) and an AI app's access (connected or not). The state line keeps them apart
  by its structure ("AI access is off · your AI apps stay connected for next time",
  "On · no AI app connected yet").
- **The relay's "page not open" answer** names "the web page" also for the extension's
  app id (the owner, 2026-11-21: it stays).

## What an AI app reads

Tool results, refusals and errors stay English on purpose: the AI app answers the user in
the user's language anyway, and quotes these texts back. A refused call: "The user did
not allow this call." (library and extension alike; over WebMCP the library names the
tool: "The user did not allow {tool} to run."). A call cancelled while the user was
asked: "The call was cancelled." Straight quotes are fine in these texts.

## Plural forms, lists, languages (the client library)

- The package ships **English only** (`STRINGS` in `packages/tab-mcp-client/src/strings.ts`,
  the `./strings` entry, outside the core). A page translates every text in one step:
  its own table as `ui.strings`, partial or complete, English for the rest.
- **No grammar by hand.** A text that depends on a count is one form per plural
  category of the language (`Intl.PluralRules`): `{ one, other }` in English, `{n}` for
  the count. Lists of names are joined by `Intl.ListFormat`. Both follow the table's
  `lang`, as do the dialogs' `lang` and `dir`.
- The extension and the relay are not translated; their texts follow this glossary in
  English and may write their few plurals by hand.

# Citations

- [Decision log](/decision-log.md), DEC-184, DEC-193, DEC-200, DEC-201, DEC-208, DEC-210, DEC-213
- [Iteration 49](/iterations/iteration-49-texts.md)
- [The tab-mcp browser extension: the look](/design/extension-look.md)
