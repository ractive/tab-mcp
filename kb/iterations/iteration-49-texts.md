---
type: iteration
title: "Iteration 49: one wording for one thing, Intl for plurals and lists, translated texts in one step"
status: completed
description: >-
  Every text a person or an AI app reads in the client library, the tab-mcp browser
  extension and the relay follows one glossary (kb/design/wording.md, DEC-208). The
  library ships English only, writes plural forms with Intl.PluralRules and lists with
  Intl.ListFormat in the table's language, and takes a page's translation once as
  ui.strings, for the dialogs, the setup steps and ConnectButton; a new ./strings entry
  has the typed English table and pickStrings. One pull request on top of the
  handshake (pull request 180); no release.
timestamp: 2026-11-21T12:00:00+01:00
tags: [iteration, client, extension, relay, wording, i18n]
---
# Iteration 49: one wording for one thing, Intl for plurals and lists, translated texts in one step

The owner, 2026-11-21: "Make it coherent" (after a wording audit of the library, the
extension, the relay and the ractive.ch examples that found 23 of 29 concepts written
more than one way), the library's core carries no translations and no hand-made
grammar, and translated texts should be "very simple" to hook in. Branch
`texts/coherent`, stacked on `handshake/page-extension` (pull request 180). The decision
is DEC-208; the glossary is [`kb/design/wording.md`](/design/wording.md).

## What changed

- **Wording**, by the glossary, on all three surfaces (the audit's certain items, the
  owner's choices for the taste items, its recommendation for the rest; the texts the
  handshake added after the audit too). The extension's card is “Connect your AI app”
  under the heading "AI access", like the library's dialog that the relay's help names;
  "connect" instead of "pair"; "AI app" in full; "type the code"; "Allow once"; the
  library's switches under "Always allow" (or "Allow until reload") with "Always allow
  everything"; "Connection lost. Reconnecting…"; the relay's code page, errors and index
  for a page or browser extension; what an AI app reads: "The user did not allow this
  call.", "The call was cancelled.", "This AI app was disconnected from the page.",
  "This AI app is signed in as someone other than the page's user.".
- **Client, texts** (`src/strings.ts`, entry `./strings`, `cdn/strings.min.js`): English
  only; `waiting`, `connected`, `connectedNext`, `disconnectAllQuestion`,
  `viaExtension`, `viaExtensionInFront` and `buttonConnected` are plural texts
  (`{ one, other }`, chosen by `Intl.PluralRules`); `and` is gone (lists by
  `Intl.ListFormat`); `runsWithoutAsking` is gone (the switches' heading is the
  confirmation's label); `dir` is optional (the direction of `lang` where the browser
  knows it). The setup steps' texts and `ConnectButton`'s labels are keys of the table.
  `src/text.ts` fills placeholders, plural forms and lists without the DOM.
- **Client, the hook**: `ui.strings` stays the one place, now read by `ConnectButton`
  too (internal `_ui` getter); `pickStrings(tables, languages?)`, `withEnglish(strings)`,
  `STRINGS`, `PluralText`; `setupInstructions(serverName, address, strings?)`.
- **Docs**: the client's README section "Translating" (the three lines, a German table,
  placeholders, plural forms, lists, language and direction, keeping a translation
  complete with the type check, AI-facing texts stay English, browser support) and "Help
  in the connect dialog"; READMEs, `docs/`, `kb/design/*`, `PRIVACY.md`, the store
  listing texts, the developer skill and `examples/react-todo` where they quote a text.

## Tasks

### Wording

- [x] Library: L1 to L19 (L7 "Always allow everything", L9 "Allow once", L15 "type",
  L17 "The user did not allow this call.", the other taste items as recommended)
- [x] Extension: E1 to E21 (E19 heading "AI access", the switch labelled by it; E20 the
  Firefox sidebar's title "tab-mcp browser extension")
- [x] Relay: R1 to R8 and R10; R9 left as it is (owner)
- [x] The handshake's texts: `viaExtension…`, the panel's lines about tab-mcp built in and
  an AI app connected both ways
- [x] Tests and docs that quote a changed text

### English only, Intl

- [x] Plural texts and `Intl.PluralRules`, lists with `Intl.ListFormat`, in the table's
  `lang`; a `lang` the browser cannot read uses English rules
- [x] `dir` from `lang` (`Intl.Locale` text info) unless the table sets it
- [x] `test/build.test.ts`: the core carries none of the texts; the texts are in one lazily
  loaded chunk; no built file has a `lang` other than `en` or characters outside ASCII
  and English typography
- [x] Core size measured before (6260 B) and after (6268 B) gzipped; its limit (6400 B)
  unchanged

### The hook

- [x] One table, given once: dialogs, setup steps, `ConnectButton`
- [x] `./strings` entry and `cdn/strings.min.js`; `pickStrings`, `withEnglish`
- [x] Tests: `test/strings.test.ts` (plural categories of Polish, a missing category,
  lists in German, a malformed `lang`, the direction, wrong kinds of values, the dialogs'
  `lang` and `dir`, the setup steps translated, `pickStrings`' matching and lazy loading),
  `ConnectButton` in German (`test/react.test.tsx`), the consumer's type check (a
  misspelt key, a missing key in a complete table, a plural text without `other`)
- [x] README section "Translating"

### Records

- [x] DEC-208; `kb/design/wording.md`; this file; changelogs of the client, the extension
  and the relay

## Results

- `bun run verify` exits 0: 1773 tests pass, 1 skipped (1774 in 82 files).
- The client's core is 6268 B gzipped of its 6400 B limit (6260 B before); the React entry
  2.9 KB of 3 KB.

## Choices this iteration made

- **Where the hook lives.** `ui.strings` already was one place every dialog read; it
  stays, and `ConnectButton` reads it too, so there is one way. A top-level `texts`
  option would have been a rename for its own sake.
- **`lang` in the table**, not beside it: the table knows its language, and
  `pickStrings` sets it to the matched tag when the table has none.
- **`dir`** has no default: the browser's text info for `lang` where it has one (Chrome,
  Safari), else left to right, so an Arabic table should still say `dir: "rtl"` for
  Firefox. A list of right-to-left languages in the library would have been grammar by
  hand.
- **The setup steps' texts** moved into the table (product names stay in the code), so
  that translating the dialog translates its help.
- **`ConnectButton`'s labels** reuse `connectTitle`, `connecting` and `reconnecting`; only
  the short "Reconnecting…" and the count of connected AI apps are keys of their own.
- **The English table is one chunk**, shared by the confirmation, the connect dialog,
  `./setup` and `./react`: a confirmation alone now loads the setup steps' texts too
  (a few hundred bytes), which beats a second table.
- **Wording not settled by the audit**: the library's list heading "Connected" became
  "Connected AI apps" (glossary 24); the takeover notice lost "with a new code" (the same
  reason as L3 and L4: with identity binding there is no code); the panel's line about an
  AI app connected both ways says "on the page"; the extension's state line reads
  "Connection lost · reconnecting…" in its own "·" style.
- **`examples/react-todo`** follows the library's labels ("Always allow", "Always allow
  everything"), as the ractive.ch examples will (X items, another repository).

# Citations

- [Decision log](/decision-log.md), DEC-184, DEC-193, DEC-200, DEC-201, DEC-207, DEC-208
- [Wording](/design/wording.md)
