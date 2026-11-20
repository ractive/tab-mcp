---
type: iteration
title: "Iteration 48: the page and the tab-mcp browser extension know of each other"
status: completed
description: >-
  A plain handshake over DOM events between a page that uses the client library with
  webmcp: true and the tab-mcp browser extension (DEC-205): the extension vouches for
  each call the user allowed there, right before it runs, so the page does not ask
  again; the page shows which AI apps reach it through the extension; the panel says
  the page has tab-mcp built in and when an AI app is connected both ways. No proof of
  either side, on purpose. One pull request, no release; client 0.19.0 with it.
timestamp: 2026-11-20T23:30:00+01:00
tags: [iteration, client, extension, webmcp, security]
---
# Iteration 48: the page and the tab-mcp browser extension know of each other

The owner, 2026-11-20: a page with the client library (`webmcp: true`) asked about a tool
call that the user had just allowed in the extension ("When the tab-mcp-extension sets
'Allow always all' or allows single tools the website must not ask again"), and said
"Off" and "Connect your AI app" while an AI app was connected through the extension.
Branch `handshake/page-extension`. `main` held client 0.18.1 with unreleased changes
(DEC-201 to DEC-203); this joins them in client 0.19.0. The decision is DEC-205.

## What changed

- **Client** (`src/handshake.ts`, in the WebMCP mirror's chunk): the page announces
  itself (`hello`, `update` on `grantschange`, `<html data-tab-mcp-handshake>`), takes
  the extension's state into `TabMcp.extension` (event `extensionchange`, React
  snapshot), keeps vouches 2 s for the tool registered then and uses each once for the
  next WebMCP call of that tool with equal arguments; that call runs without the page's
  question or `onConfirm`, its caller `{ kind: "webmcp", via: "tab-mcp-extension", name,
  host }`. `trustExtension: false` asks anyway. The connect dialog says first which AI
  apps are connected through the extension, "while this tab is in front".
- **Extension**: the content script's side (`src/page-handshake.ts`) speaks only to a
  page that announced the library; the worker tells the content scripts its state when
  it changes and answers their request for it (top frame only); the bridge makes the
  vouch after the user's answer and the same-tool check, and the content script sends
  it right before `executeTool`; the panel shows "This page has tab-mcp built in." and
  the line about an AI app connected both ways.
- **Docs**: both threat models (A13, A14), `kb/design/extension.md`, the client's and
  the extension's README, `PRIVACY.md`, the store listing's description, changelogs.

## Tasks

### Client

- [x] `handshake.ts`: events, marker, extension state, vouches (2 s, once, bound to the
  tool registered when the vouch came, at most 16, a nonce once), canonical arguments
- [x] `webmcp.ts`: joins the handshake, looks the vouch up as a call arrives; defines
  `extension` on the instance and sends `extensionchange`
- [x] `connection.ts`/`mcp.ts`: a vouched call confirms without asking, with its caller
- [x] `types.ts`: `WebMcpClient.via`, `name`, `host`; `BrowserExtension`;
  `trustExtension`; `extensionchange`
- [x] Connect dialog and `strings.ts`: `viaExtension…`; React snapshot: `extension`
- [x] Core size measured before (6252 B) and after (6261 B); limit unchanged
- [x] Tests (`test/handshake.test.ts`): announcement, marker, answers, frames, state and
  its event, malformed input, `trustExtension`; the vouch: unasked with the caller,
  other arguments or tools asked, used once, equal calls twice, two calls at once,
  nonce once, key order, expiry and a vouch never used, a tool registered anew after the
  vouch, a tool unregistered, a page that reloads, the argument check; the dialog's
  line; React's snapshot

### Extension

- [x] `src/page-handshake.ts` in the content script; `extension-state` and `handshake`
  messages; `isHandshakeAsk`
- [x] Bridge: the vouch in `#allowedThenRun` only; `callInTab` and the content script
  pass it on and dispatch it after the checks, before `executeTool`
- [x] Worker: `handshakeState()`, sent to the tabs when it changes
- [x] Panel: `libraryNotes`, two lines in the tab card
- [x] Tests (`test/handshake.test.ts`): silent without the library, answers, the marker,
  no answer from the worker, several apps, the page's input checked; the vouch before
  the tool and never for a call that does not run; the bridge's vouch (allowed, both
  ways of calling; none for read-only, a refusal or a page that changed); the worker's
  sender check; the panel's lines; both sides together with the real library
- [x] End to end (`test/e2e.test.ts`, `test/firefox-e2e.test.ts`, page
  `test/pages/library.html` with the library bundled): Chrome's own WebMCP (the page's
  state with the app's name; the panel's line; the switch on: no question in the page;
  off: the extension asks once and the page not at all, also for Don't allow; a WebMCP
  call from the page itself is asked by the page; the state follows when the app is
  disconnected in the extension), Chrome with the extension's stand-in and Firefox (a
  call allowed in the panel is not asked by the page)

### Records

- [x] DEC-205; this file; both threat models; `kb/design/extension.md`; READMEs;
  `PRIVACY.md`; `kb/operations/chrome-web-store.md`; changelogs

## Results

- `bun run verify` exits 0: 1742 tests pass before the merge of main (see the pull request for the merged tree).
- The client's core is 6261 B gzipped of its 6400 B limit (6252 B before); the mirror's
  chunk 1.6 KB gzipped (0.5 KB before), its limit in `test/build.test.ts` raised from
  1 KB to 2 KB; the connection chunk 16.4 KB.

## Choices this iteration made

- **The marker.** The extension must not speak before a page announced the library,
  and its content script often starts after the page's `hello` (Chrome's
  `document_idle`, a click). So the page marks `<html data-tab-mcp-handshake>`, and the
  content script speaks first only when the mark is there. A knock on every page would
  have told every page that the extension is installed.
- **Names.** Events `tab-mcp-page` and `tab-mcp-extension`; `TabMcp.extension` with
  `{ name, version, apps, whileInFront }` and `extensionchange`; option
  `trustExtension`; caller fields `via: "tab-mcp-extension"`, `name`, `host` (as a relay
  client's).
- **Equal arguments** are equal canonical JSON (object keys sorted, arrays in order).
- **One rule for "the same tool"**: the bridge's existing check after the question
  decides whether the call runs, and a vouch goes only with a call that runs. The
  library binds a vouch to the tool registered under its name when the vouch comes, so
  a tool registered anew between vouch and call is asked; one registered anew while the
  user was asked (a new description) is the bridge's case, and runs as before.
- **"On"** is AI access connected; the page's `extension` is `undefined` otherwise. The
  extension tells a page that announced also when it goes off, so the page does not
  keep a stale "connected".
- **Several apps** of one page announce each app id; the panel joins their apps.
- **The dialog's line** has an "in front" form and a plain one, for an extension that
  serves every tab (none does today).
- **Size**: `extension` is declared in the core and defined on the instance by the
  mirror's chunk; the library's version is passed to the chunk, not imported there (a
  chunk shared with the core cost it 88 B).
- **Not changed**: `ConnectButton`'s label and the example pages' "Off"; they can read
  `extension` now.

## Residual risk

No proof of either side: a page script can fake the extension to its own page (and skip
the page's question anyway), and any page the extension may read can learn the names of
the AI apps connected to it by announcing the library. An agent in the browser that
calls the same tool with equal arguments between a vouch and the extension's call uses
the vouch, for exactly the call the user allowed. A page keeps the last state it was
told when the extension is removed or disabled without telling it (its calls are then
asked as before, as no vouch comes).

# Citations

- [Decision log](/decision-log.md), DEC-119, DEC-140, DEC-141, DEC-191, DEC-200, DEC-205
- [The tab-mcp browser extension](/design/extension.md)
- [Threat model](/design/threat-model.md)
