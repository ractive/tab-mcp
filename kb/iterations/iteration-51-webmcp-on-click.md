---
type: iteration
title: "Iteration 51: WebMCP on a click"
status: completed
description: >-
  In Chrome without WebMCP, on a site outside the origin trial, a page built with the
  client library offers the tab-mcp browser extension nothing after a click on its icon:
  the library looked for WebMCP when its TabMcp was made, long before the click. The
  extension now gives such a tab its own document.modelContext late, while AI access is
  on, and says so with a DOM event; the library, which found none, looks again and starts
  its mirror. Everything after that is today's path. Needs a client and an extension
  release.
timestamp: 2026-11-23T19:00:00+01:00
tags: [iteration, client, extension, webmcp, privacy]
---
# Iteration 51: WebMCP on a click

A user with the tab-mcp browser extension opens a site built with the client library. The
extension reads only what a page registered with WebMCP. The library mirrors its tools
there by default since client 0.23.0 (DEC-222, on main through PR 232, released
2026-11-23), but only where the tab has WebMCP when the `TabMcp` is made. The
tab has it with Chrome's origin trial or flag, or where the extension has access to all
sites and installs its own at `document_start` (DEC-188, DEC-191). The gap: plain
Chrome, a site outside the trial, the extension without access to all sites. The user
clicks the icon (`activeTab`) and the panel shows no tools.

The owner approved this for planning on 2026-11-23: on the click, where the tab has no
WebMCP, the extension installs its own `document.modelContext` in that tab and says so;
the library looks again and starts its mirror. Everything after that is today's path:
`callers` (DEC-209), the hints (DEC-143), the handshake and the vouch (DEC-207, DEC-221),
`onConfirm` (DEC-215).

Line numbers are those of `main` at 98c8a58; the client's `tab-mcp.ts` is cited as it is
on main since DEC-222 (client 0.23.0).

## What the code does today

### A click, in Chrome

- **The manifest** has `activeTab` and `scripting`, no `content_scripts`, and http(s)
  only as `optional_host_permissions` (`scripts/build.ts:146-156`).
- **The click** (`src/background.ts:82-101`) opens the panel. It then injects
  `content.js` into the isolated world with `chrome.scripting.executeScript`
  (`src/tabs.ts:37-43`) and calls `tabChanged()`.
- **Nothing in the page's main world.** The main-world polyfill `webmcp-main.js` is only
  ever *registered* for every page, and only while access to all sites is granted
  (`src/background.ts:104-140`, `runAt: "document_start"`, `world: "MAIN"`). A click
  never injects it.
- **The content script** (`src/content.ts:511-522`) still tries to connect to that
  polyfill. It posts a `MessageChannel` port with `window.postMessage`
  (`src/chrome/webmcp-port.ts:92`). Nothing in the page listens for it, so the promise
  stays pending for ever (`webmcp-port.ts:12-18` says it may). `pageTools()` answers
  `available: false` (`content.ts:245-259`), and the panel shows `no-webmcp`
  (`src/sidepanel/card.ts:122-128`).

### A click, in Firefox

- **The content script installs WebMCP whenever it runs.** It calls
  `installWebMCP(window)` as soon as it runs (`src/content.ts:460-467`), and
  `installWebMCP` does not look at `document.readyState` (`src/firefox/webmcp.ts:125-136`).
  So a click already gives a Firefox tab `document.modelContext` after the page has
  loaded. PRIVACY.md says this ("in Firefox, a tab the user gave it by clicking its
  icon gets it then", line 31). This happens whatever the AI access state is.
- **The library never notices.** It decided when its `TabMcp` was made, so a library
  page still offers nothing. The `FIREFOX_NO_WEBMCP_NOTE` (`content.ts:99-100`) tells
  the user to reload with access to all sites.

### The library (client 0.23.0)

- **One look, at construction.** `nativeContext()` (`src/tab-mcp.ts:47-56`) reads
  `Document.prototype`'s `modelContext` getter once, in the constructor
  (`tab-mcp.ts:344`). Only when it finds an object does the constructor load the
  mirror's chunk (`webmcp.ts`), which joins the handshake (`handshake.ts:259-270`). The
  handshake then sets `<html data-tab-mcp-handshake>` and says `hello`
  (`handshake.ts:118-131`).
- **Without WebMCP the page says nothing.** There is no mark, no `hello` and no
  listener. The extension's content script, which listens from its start
  (`src/page-handshake.ts:168-181`), hears nothing, and the panel's "This page has
  tab-mcp built in." stays hidden.

### After a same-origin navigation or a reload (Chrome, no host access)

- **The new document is read again.** `tabs.onUpdated` with `status: "complete"` for an
  active tab calls `tabChanged()` (`background.ts:194-198`). If reads are wanted (a
  panel is open, or the connection is up or on its way, `worker/connection.ts:535-549`),
  the bridge reads the tab. `ask()` finds no content script, injects one and asks again
  (`tabs.ts:204-232`).
- **The click's grant holds on the same origin.** Chrome keeps the `activeTab` grant
  across navigations on the same origin (iteration 19; iteration 27; the store
  package's test "on the same origin after a navigation too",
  `test/extension.browser.test.ts`, describe "the store package (no host access)").
  The spike (task 0) shows it for a reload too.
- **Firefox keeps no grant across any navigation** (spike, task 0): after a same-origin
  navigation and after a reload, `scripting.executeScript` answers "Missing host
  permission for the tab". In Firefox without access to all sites, the extension
  loses the tab itself at every new page, not only its WebMCP.
- **So the content script returns without a second click, but WebMCP does not.** The
  new document again has no WebMCP, and its new `TabMcp` again found none.
- **The read on connecting.** The bridge also reads when the connection is
  `connecting` or `connected` (`connection.ts:430-440`).

## The design

### 1. Chrome: the late install

- **A new function, `giveWebMCP(tabId)`, in `tabs.ts`.** It calls
  `chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "MAIN",
  files: [WEBMCP_MAIN_SCRIPT] })`, and once that resolves sends the content script
  `{ type: "webmcp-install" }` (frame 0).
- **The content script answers that message**, a new `ContentRequest`
  (`messages.ts`, `REQUESTS` in `content.ts:441-448`). If it has no context yet (no
  native WebMCP, no `ownContext`), it runs `connectPolyfill(window)` again. A port
  posted after the polyfill's listener exists is answered.
- **The first port was posted before the polyfill existed, and nobody answered it.**
  Its promise stays pending, which is harmless. The `then` that sets `ownContext` must
  return early when `ownContext` is already set, so that two ports never both add a
  `toolchange` listener. This is the "both arrive late" case: the content script came
  at the click, the polyfill later.
- **The page is told by `webmcp-main.ts` itself.** It dispatches a plain
  `Event("tab-mcp-webmcp")` on `document` right after it defines the getters
  (`webmcp-main.ts:140-145`). It does this only when it installed; where it steps
  aside (`:34-35`: no secure context, Chrome's own WebMCP, or the page's own) it sends
  nothing. At `document_start` (access to all sites) no page script listens yet, so the
  same code serves both paths.
- **Who installs, and when.** The worker installs, in the one place where it learns that
  a tab it may read has no WebMCP: the bridge's `list` (`connection.ts:322`, today
  `askTools`). This becomes a wrapper: when `askTools` returns `available: false`, the
  handshake state is `on` (§5), and the worker has not tried this document yet, it calls
  `giveWebMCP` and returns what it read. The page's `toolchange`, which reaches the
  worker over the port (`webmcp-changed`), reads the tools again.
- **Once per document.** The worker keeps a `Map<tabId, documentId>` of documents it has
  tried (`PageTools.documentId`), cleared in `tabClosed`. A page whose own polyfill makes
  `install()` step aside therefore costs one `executeScript`, not one per read.
- **The click itself needs no new code.** It opens the panel and calls `tabChanged()`,
  and the bridge's read that follows does the install. The same read does it after a
  navigation (§4), and when AI access comes on later (`connection.ts:430-440`).
- **No flash of the old text.** Between the click and the install, the panel must not
  show the `no-webmcp` text on a tab that is about to get WebMCP (`#readTab` reads
  `page-info` before the bridge's refresh, `connection.ts:651-652`). The implementation
  orders the reads, or marks the view "WebMCP on its way" until the install has
  settled. A browser test checks that the text never appears there (§9).
- **A race, closed (review of PR 234).** If the tab navigated between the read and
  `executeScript`, the polyfill would land in the next document. The give is now pinned
  to the document that was read. The content script puts its id (`DOCUMENT_ID`) on its
  own world. A probe (`executeScript` with a function in the isolated world, frame 0)
  returns it together with Chrome's `documentId` of that document. Only if it matches
  the read does the polyfill go in, with `target.documentIds`, and `webmcp-install`
  goes to that document (`tabs.sendMessage`'s `documentId`) with the read page's id,
  which another page's content script ignores. Firefox has no main-world injection;
  the message's id pins it there.
- **Shown by the spike (task 0):** `executeScript` with `world: "MAIN"` and `files`
  works under `activeTab` alone, right after the click, after a same-origin `goto` and
  after a reload. Without the click, and on another origin, Chrome refuses it. The
  second port is needed: without `webmcp-install` the panel listed no tools, although
  the page had mirrored.

### 2. Firefox: the same late install

- **No main-world script and no port.** The polyfill lives in the content script
  (DEC-188), so the late install is a call to `installWebMCP(window)` at a later moment.
  It already works mechanically: `reviveOpenPages` (`background.ts:160-176`) injects the
  content script into loaded pages after an update, and firefox-smoke's test "the page's
  tools outlive the content script" exercises that late path.
- **When the content script installs** (as built after the review of PR 234; the
  first build's `document.readyState === "loading"` was no safe sign of the registered
  script, a click on a page still loading passes it, and it stopped the install on open
  pages with host access). The worker, before it puts the content script in without
  host access for the page (`permissions.contains` for the page's site), sets
  `tabMcpByClick` in the script's world. The flag goes in with the first injection,
  started at once, and is taken away again with host access. From a click it must run
  in the click's gesture, which reaches the page as a user activation: awaited behind
  the host check, Chrome's history intervention made `go_back` skip to `about:blank`.
  The navigation test caught it.
  - **With the flag** (a click), the content script installs nothing at its start, and
    takes over no earlier script's state either, since a page could fake that state. It
    installs only on `webmcp-install`, which comes only while AI access is on.
  - **Without it** (the registered script, the revive after an update, a page put in
    with host access), it installs at once, as before this iteration, also on a page
    that loaded before, whatever AI access. `keptState` is read once, in
    `installWebMCP`.
  - **Chrome's content script** follows the same flag for its port.
- **The page is told by `installWebMCP`.** It dispatches
  `new PageEvent("tab-mcp-webmcp")` on `win.document` after it defines the getters
  (`firefox/webmcp.ts:342-348`), only on the path that defines them, not on a takeover.
- **Firefox's `activeTab` ends at every navigation** (spike, task 0): after a
  same-origin navigation and after a reload, `executeScript` is refused. So in Firefox
  without access to all sites, a click gives WebMCP to that one document only; each new
  page, the same origin included, needs another click. PRIVACY.md:12 ("until that tab
  goes to another origin") holds for Chrome and is wrong for Firefox. So are the
  navigation tools' description (`worker/navigation.ts:451`, "On the page's own origin
  it runs at once") and its result, where they speak of keeping access. These are
  today's errors; this iteration corrects the words for Firefox (task 4).

### 3. The library: "WebMCP arrived"

The smallest form: one listener in the core, added by a `TabMcp` that found no WebMCP.
When it hears the event, it does what the constructor does.

```ts
if (options.webmcp === false) return;
const look = (): void => {
    const context = nativeContext(); // only Document.prototype's getter, as before
    if (context === undefined) return;
    globalThis.document?.removeEventListener("tab-mcp-webmcp", look);
    mirrorIn(context); // today's import("./webmcp.ts").then(m => m.mirror(...))
};
globalThis.document?.addEventListener("tab-mcp-webmcp", look);
look();
```

- **Which event.** `tab-mcp-webmcp` on `document`, a plain `Event` with no `detail`:
  nothing to parse and nothing to forge but the trigger. It is not `tab-mcp-extension`.
  The handshake keeps that event in the mirror's chunk, and `build.test.ts` checks that
  the core does not contain it. The name is one constant, exported from the client's
  `./extension` entry and imported by `webmcp-main.ts` and `firefox/webmcp.ts`. It is
  documented in the client README in one sentence, so that a page's own polyfill that
  installs after the library may dispatch it too.
- **Which check.** `nativeContext()` again, only `Document.prototype`'s getter. An own
  `document.modelContext` is still passed by, as in DEC-115.
- **What it costs.** Measured with this sketch on main (client 0.23.0; `Bun.build`,
  minified, gzipped, as `test/build.test.ts` counts it): the core grows from 6314 B to
  6358 B, +44 B. The limit is 6.25 KB, 6400 B (`build.test.ts:103`), so 42 B would be
  left. If the final code does not fit, the bytes are found elsewhere; the limit is not
  raised without the owner.
- **Several `TabMcp`s on one page.** Each found nothing, so each has its own listener,
  and each mirrors its own registry on the event. They share one handshake per document
  (`handshake.ts:252-270`), as when WebMCP was there at construction. Name collisions
  between them are as today.
- **`webmcp: false`.** No listener, so the event changes nothing.
- **The event twice.** The first event that finds the getter removes the listener, so a
  second event finds nothing to call: one mirror per `TabMcp`. An event while the
  getter is still missing (forged, or early) leaves the listener for the real one. That
  is why it is not `{ once: true }`.
- **WebMCP already found at construction.** No listener is added, as today.
- **No document** (a worker, server rendering): no listener. The extension's own
  `TabMcp` sets `webmcp: false` (DEC-222).
- **React StrictMode.** The instance StrictMode discards keeps its listener too. On the
  event it mirrors an empty registry and announces the same app id. This is what
  happens today when WebMCP is there at construction; nothing new.

### 4. Navigation

- **No second click on the same origin, in Chrome.** With §1, the read that follows a
  same-origin navigation or reload (`background.ts:194-198`, then `ask()` injects the
  content script) finds `available: false` and installs again. The new document's
  `TabMcp`, made during its load, hears the event and mirrors.
- **A library made after the install** (a page that makes its `TabMcp` late) finds the
  polyfill at construction.
- **Only the tab in front is read.** A tab the user clicked and left is installed into
  when it comes to the front again (`tabs.onActivated`), provided its grant still holds.
- **While AI access is off and no panel is open, nothing is read** (DEC-177), so nothing
  is installed. Once AI access connects, the read on `connected` installs.
- **A page restored from the back/forward cache** keeps its polyfill and its mirror.
  The content script's `pageshow` reads it again (`content.ts:525-527`).
- **Firefox does not behave the same** (spike, task 0): its grant ends at every
  navigation, a reload included, so each new page needs a click. That click brings
  the content script, WebMCP (while on) and the tools, as on the first page.

### 5. Privacy: install only while AI access is on

**Recommendation:** the late install happens only while the handshake state is `on`
(AI access on and connected, `connection.ts:1182-1193`), the same "on" as DEC-221. This
keeps one rule: "While AI access is off, the extension answers no page, sends it nothing,
and gives no page WebMCP that it did not have as it loaded."

- **Why.** A late install tells the page more than the `document_start` install DEC-191
  accepted. It tells the page that the extension is installed, and also that the user
  gave it this tab just now (the event comes seconds after the click). While AI access
  is off, the install does nothing for the user, so the page should not learn either.
- **What it costs.** Firefox's content script no longer installs at a late injection
  while AI access is off (§2), and the `no-webmcp` text gains a line about AI access
  (§8). Today Firefox installs at the click whatever the state; this narrows it.
- **The alternative:** install at every click, whatever the state. It is simpler (no
  gating in either browser) and matches what Firefox does today, but a page learns of
  the click while AI access is off.
- **Words that change.** Under either choice, the following passages say the polyfill
  comes "after 'Give access to all sites' only" or "a click comes too late":
  - **`packages/tab-mcp-extension/PRIVACY.md`.** Lines 27-31 get a sentence: while AI
    access is on, a tab the user gave the extension with a click gets WebMCP then, in
    Chrome and Firefox; such a page can tell that the extension is installed and that
    the user gave it the tab, and when. Lines 41-43, DEC-221's sentence "A page can
    still see that the extension is installed where it provides WebMCP itself (in
    browsers without their own)", becomes "…where it gave the page WebMCP as it loaded
    (with access to all sites)".
  - **`packages/tab-mcp-extension/README.md`:** lines 14-19 (which say "a click on the
    icon comes after the page has looked for it"), 134-136 (DEC-221's sentence again),
    322-328 (Chrome's polyfill, "with access to all sites … at `document_start`"),
    362-367 and 404-407 (Firefox).
  - **The root `README.md:97`.**
  - **The site's privacy page**, `ractive.ch` repository,
    `src/pages/tab-mcp/privacy/index.vto` lines 143-147 and 166, the same sentences as
    PRIVACY.md. As with DEC-191 and DEC-207, it is published before the extension
    release.
  - **DEC-221's one wording** also lives in `docs/threat-model.md` (A13),
    `kb/design/extension.md`, `kb/design/threat-model.md` and the extension's CHANGELOG.
    It changes in every place at once.

### 6. Threat model

**Who can fire `tab-mcp-webmcp`, or put a getter on `Document.prototype`:**

- **The page's own script and third-party script in the page** can do both.
- **Another extension's main-world script** can do both; it is page script as far as
  the page can tell.
- **Another extension's isolated-world content script** can fire the event but cannot
  change the page's prototypes. On its event the library reads the getter and finds
  nothing, or the real object: no gain.

**What they gain that they did not have:**

- **A new opening, small.** Today a script must change `Document.prototype` *before*
  the `TabMcp` is made to receive the mirror. A14 says so: "A page that changes
  `Document.prototype` before that can fool this; it owns the tools anyway"
  (`docs/threat-model.md`, A14, "Only the browser's own object"). With the listener, on
  a page that had no WebMCP at construction, a script that runs later can define a
  getter, fire the event, receive every mirrored tool's `execute` and call it as a
  `webmcp` caller. The page's `onConfirm` decides, and a consequential tool on a page
  without one runs unasked (DEC-215).
- **But no new power.** Such a script already has the page's powers: its DOM, its
  requests with the user's cookies, its controls. No defence is proposed. No event can
  be told apart (`isTrusted` is false for the extension's events too), and DEC-207's
  reasoning ("anything that could fake the extension runs in the page already")
  applies.
- **The port is not new either.** The handover's port is visible to the page's scripts.
  This is already true today: Chrome's content script runs at `document_idle`
  (`background.ts:114`), so even with access to all sites it posts the port after the
  page's scripts have run. A page that answers it can only present tools of its own
  origin, which it could register anyway.

**Sections that need words:**

- **A13** (`docs/threat-model.md`, "A forged `document.modelContext`" and the DEC-221
  paragraph; `kb/design/threat-model.md` likewise): the late install, its gating, and
  what the event tells.
- **A14:** the opening paragraph's "which it puts on `Document.prototype` after 'Give
  access to all sites' (A13)" also says "or, while AI access is on, in a tab given by a
  click". The bullet "Only the browser's own object" says the getter is read when the
  `TabMcp` is made and again on `tab-mcp-webmcp` when it found none then, so a script
  that changes the prototype later and fires the event can fool it too, and still owns
  nothing it did not have.

### 7. Pages that use WebMCP without the library

- **A late install does not help them.** Such pages look for `document.modelContext`
  once, as they load (iteration 44's question 1: Shopify, Mintlify, GitBook, ReadMe;
  `test/pages/webmcp.html:13` does the same). After the install they have WebMCP and no
  tools. Today's `no-tools` text, "This page offers no WebMCP tools", would then be
  wrong about the cause.
- **A new flag, `late`.** The content script marks a context it got from
  `webmcp-install` as late, and reports `late: true` in `PageTools`, `PageInfo.webmcp`
  and `TabView.webmcp`.
- **The panel shows a third text for a late page with no tools**, `late-webmcp` (§8),
  which keeps pointing to "Give access to all sites" and a reload. `page_info` carries
  the matching `note` for the AI app.
- **A page that looks again later** (one that makes its tools on demand) gets its tools
  through the polyfill, as it would at load.

### 8. What the user sees

**Drafts.** The final words go through the owner, as in iteration 49. Chrome has "side
panel" and Chrome's names; Firefox has "sidebar" and its own texts in
`FIREFOX_PANEL_TEXTS` (`src/browser.ts:27-34`) and `FIREFOX_NO_WEBMCP_NOTE`.

A library page, plain Chrome, the store package:

| Moment | Today | With this iteration |
|---|---|---|
| Before the click | badge "Not readable"; "Click the tab-mcp icon in Chrome's toolbar to let it read this tab." (`card.ts:96-97`); "Give access to all sites" | the owner's new words (below): "Click the tab-mcp icon [the icon] in Chrome's toolbar or puzzle-piece menu to let it read this tab."; "Give access to all sites"; "Or let it read every tab without a click. Chrome asks you first." |
| After the click, AI access on | no badge; `no-webmcp` (`index.html:86`); no "built in" line (the library never spoke) | a moment later: "WebMCP · N tools", "This page has tab-mcp built in.", the tools with their switches; never the `no-webmcp` text in between |
| After the click, AI access off | as above | `no-webmcp` (new draft below); once AI access connects, the tools come without another click |
| Same-origin navigation or reload, AI access on | `no-webmcp` again | Chrome: the tools again, without a click. Firefox: "Not readable" and the click text, as on another origin (the grant ends at every navigation, spike task 0) |
| A WebMCP-only page that looked at load, AI access on | `no-webmcp` | "WebMCP" without a count, and `late-webmcp` (draft below) |

- **`no-webmcp`, new draft** (Chrome; shown while AI access is off, or where the install
  stepped aside): "This page has no WebMCP. While AI access is on, tab-mcp gives it its
  own, and pages with tab-mcp built in then offer their tools. Pages that look for
  WebMCP only as they load need access to all sites and a reload. Only https pages (and
  localhost) get it. Chrome's own WebMCP is on for sites in its origin trial, or
  everywhere with `chrome://flags/#enable-webmcp-testing` (WebMCP in Chrome). page_info
  and the navigation tools still work."
- **`late-webmcp`, new:** "tab-mcp gave this page WebMCP after it had loaded, and the
  page registered no tools: it looks for WebMCP only as it loads. With access to all
  sites, tab-mcp gives every page WebMCP as it starts loading; then reload this page.
  page_info and the navigation tools still work."
- **`page_info`'s `note`** (late, no tools): "tab-mcp gave this page WebMCP after it had
  loaded; it registered no tools. A page that looks for WebMCP only while it loads needs
  the user to click "Give access to all sites" in the side panel and reload it."
  `FIREFOX_NO_WEBMCP_NOTE` drops "if it loaded before tab-mcp had access" in favour of
  the same two cases.
- **"Give access to all sites" stays**, shown whenever it is not granted
  (`sidepanel/main.ts`). It is still the only way for WebMCP-only pages, and it spares a
  click per origin. Its label is in one place, `allSitesButton` in `browser.ts`, with a
  suffix per browser that is empty for now (the owner may add "(recommended)").
- **A tab it may not read, the owner's words** (2026-11-23, after his own test: people
  may not find the icon; then shortened by him):
  - Chrome, the notice: "Click the tab-mcp icon in Chrome's toolbar or puzzle-piece menu
    to let it read this tab." with the extension's 16 px icon after "Click the tab-mcp
    icon" (decorative: empty alt, `aria-hidden`).
  - Chrome, under the button: "Or let it read every tab without a click. Chrome asks you
    first."
  - Firefox, the notice: "Click the tab-mcp icon in Firefox's toolbar or extensions panel
    to let it read this page. Firefox asks again on every new page." Firefox's
    Extensions button (a puzzle piece) opens its extensions panel, where an add-on that
    is not pinned sits.
  - Firefox, under the button: "Or let it read every page without a click. Firefox asks
    you first."

### 9. Tests

**Unit tests, the client** (`test/webmcp.test.ts` with its fake `ModelContext`;
`test/build.test.ts`). Each is shown to fail against a mutant first, as in iteration 50:

- With no getter at construction, the getter added later and the event fired: every
  tool is registered once, and the handshake says `hello`.
- An event before the getter exists, then one after: one mirror.
- Two events after the getter: each tool is registered once.
- `webmcp: false`: the event with the getter registers nothing.
- Two `TabMcp`s: each mirrors its own tools, with one mark and both app ids announced.
- An own `document.modelContext` property and the event: nothing (only the prototype's
  getter counts).
- No document: no throw.
- `build.test.ts`: the core contains the event's name and not `tab-mcp-extension`; it
  logs the size; the limit stays 6.25 KB.

**Unit tests, the extension:**

- `webmcp-main.ts` dispatches `tab-mcp-webmcp` once, after the getter exists, and not
  when it steps aside.
- `connectPolyfill` a second time after a pending first gives one context and one
  `toolchange` listener.
- `content.ts` answers `webmcp-install` (Chrome: it connects; Firefox: it installs),
  sets `late`, and does nothing once a context exists.
- The start (after the review of PR 234):
  - Without host access the content script is told it came by a click
    (`unit.test.ts`).
  - In the browser tests, after such a click with AI access off, the page heard no port
    handover (Chrome) and kept a faked state untouched (Firefox).
  - With host access, Firefox installs on a page that loaded before the script came,
    with AI access off.
- The worker's `list` wrapper (`connection.test.ts`, fake Chrome): it installs only
  while `on`, once per document, never where `available` is true, and forgets a closed
  tab.
- `sidepanel.test.ts`: `no-webmcp`, `late-webmcp` and the Firefox texts.

**Chrome browser test** (`test/extension.browser.test.ts`): a new scenario in the store
package (no host access) with Chrome without its WebMCP flag, `start({ store: true,
webmcp: false })`. That is one more shared Chrome, key `store-polyfill`, about 0.6 s; the
existing `store-webmcp` Chrome keeps its native WebMCP tests. With `library.html`, as a
scenario with named steps:

1. With AI access connected, click: the library's tool is listed; the panel shows "This
   page has tab-mcp built in." and never the `no-webmcp` text (a `MutationObserver` in
   the panel); a call the user allows in the panel runs without the page asking (the
   vouch).
2. A reload, then a same-origin `goto`: the tools come back without a click.
3. AI access off, a new tab, a click: `"modelContext" in document` is false in the
   page, and the panel shows `no-webmcp`; AI access on: the tools come without a click.
4. `webmcp.html` on that Chrome, clicked: `available: true` with no tools, and
   `late-webmcp`.
5. Another origin: no install without a click (the grant is gone).

**Firefox browser test** (`test/firefox-smoke.browser.test.ts`, Firefox's own code):
BiDi cannot click the icon, and the test build has host access. So the scenario takes
the registered content script away first, through a test-build hook (the panel's tab
reaches the background with `runtime.getBackgroundPage()`, as the notification recorder
does). It then loads `library.html` (no `modelContext`), connects AI access, and checks
that the worker's read installs WebMCP late and that the library's tools are listed
across Firefox's worlds. This exercises the late install, the event across the Xrays
and the library; not `activeTab` itself.

**By hand in Firefox:** the development build without access to all sites, a click, a
library page (the diagram example), then a same-origin navigation and a reload.

### 10. Releases

**It needs a client release (the listener) and an extension release (the late install
and the event). Either order is safe.**

| Client \ Extension | Old (0.3.x) | New |
|---|---|---|
| Old (no listener) | today | the extension installs (while on), the library ignores the event: no tools, the panel shows `late-webmcp`, whose remedy (all sites, reload) works |
| New | Chrome: nothing installed, as today. Firefox: a click installs (old behaviour) but no event comes, so no mirror, as today | works |

- **The order:** the client first, through a release candidate and then the stable
  release, with the apps on it (the ractive.ch examples, sign-in, saturnus, Sitegloss).
  Then the site's privacy page (§5), then the extension. The extension's gain needs
  pages on the new client.
- **The client's change is additive.** The CHANGELOG lists it under Added, not
  Breaking.

## Known from the code, and assumed

- **Known:**
  - A click in Chrome injects only the isolated-world content script, and its port to
    the polyfill goes unanswered.
  - Firefox already installs WebMCP late at a click.
  - The library looks once.
  - The content script returns after a same-origin navigation without a click (Chrome,
    a tested `goto`).
  - The handshake works when the page speaks after the content script started
    (`page-handshake.ts:253-268`).
  - The core is 6314 B of 6400 B on main (client 0.23.0).
- **Shown by the spike** (task 0):
  - In Chrome, `executeScript` with `world: "MAIN"` works under `activeTab` alone,
    right after the click, after a same-origin navigation and after a reload.
  - In Chrome and Firefox, the library mirrors into a polyfill that arrives late.
  - Firefox's `activeTab` ends at every navigation.
- **Still assumed:** that the action's `triggerAction`, which the Firefox spike used in
  place of a click, grants and ends `activeTab` as a person's click does. It is the
  code a click runs; the hand check (task 6) confirms it with a real click.

## Rejected

- **The extension lists and calls the library's tools directly over the page-extension
  events, past WebMCP.** That would be a second tool transport, with its own list,
  call, result and cancel protocol, and its own `callers` value beside `relay`,
  `local` and `webmcp` (DEC-209). It would need its own tests in two browsers, and the
  library would need it in the core or in a chunk loaded without WebMCP. The late
  install reuses the one path that exists and is tested: WebMCP, the mirror, the
  handshake and the vouch.
- **Injecting the polyfill at the click only, before the content script.** It covers
  neither a navigation, nor AI access coming on later, nor a content script that was
  already in the page. The worker's read covers all of them in one place.
- **The library polling, or looking again at each `registerTool`.** Polling costs every
  page that never gets WebMCP. Looking at `registerTool` misses an install that comes
  after the last registration.

## Tasks

- [x] 0. **Spike, before any code** (by hand, Chrome for Testing without the WebMCP
  flag, the store package; Firefox with the development build without access to all
  sites):
  - **Chrome:** click on `library.html`, then call `chrome.scripting.executeScript({
    world: "MAIN", files: ["webmcp-main.js"] })` from the service worker (DevTools
    Protocol). It must succeed, and `"modelContext" in document` must be true in the
    page. Repeat after a same-origin `goto` and after a reload, without a click. With a
    scratch build of the client carrying §3's listener, the library's tools must appear
    in the panel once the event fires.
  - **Firefox:** after a click, then after a same-origin navigation and a reload, check
    whether `scripting.executeScript` into the tab still succeeds.
  - **What stops the iteration:** Chrome refuses `world: "MAIN"` under `activeTab` right
    after the click. Then there is no Chrome half without host access, and it goes back
    to the owner (Firefox alone is not worth the release).
  - **What changes the plan without stopping it:** Chrome refuses after a reload, or
    Firefox after any navigation. Then a click is needed again there, and §4 and §8 say
    so.
  - The results go into this file.

  **Spike results** (2026-11-23, Chrome for Testing 156.0.8078.80, Firefox 160.0.1).
  Run with `bun run test:browser spike-click-chrome` and `… spike-click-firefox`.
  - **The scratch code, uncommitted.**
    - The client's listener: §3 in `packages/tab-mcp-client/src/tab-mcp.ts`.
    - The event: `webmcp-main.ts` dispatches it at the end of `install()`, and
      `firefox/webmcp.ts` after it defines the getters.
    - In `content.ts`, a `webmcp-install` listener that connects a second port, plus
      the guard against a second `toolchange` listener.
    - Two scratch browser files: `packages/tab-mcp-extension/test/spike-click-chrome.browser.test.ts`
      and `spike-click-firefox-smoke.browser.test.ts`. Each logs what it saw as JSON.
  - **Chrome**, the store package (no host access, `permissions.contains` false), no
    WebMCP flag, `library.html`:
    - Before the click, `executeScript({ world: "MAIN", files: ["webmcp-main.js"] })`
      was refused: "Cannot access contents of the page. Extension manifest must request
      permission to access the respective host."
    - Right after the click it succeeded. `"modelContext" in document` became true, the
      page heard `tab-mcp-webmcp` once, `<html data-tab-mcp-handshake>` was set, and
      the page's `document.modelContext.getTools()` listed `complete_todo`.
    - The same held after a same-origin `goto` (`library.html?again`) and after a
      reload, without a new click. Each new document had no `modelContext` until the
      injection.
    - On another origin, it was refused with the same message as before the click.
  - **The panel, in Chrome.**
    - It said "This page has tab-mcp built in.", and in the same moment still showed
      the `no-webmcp` text, with no tools (that is §1's flash, seen).
    - The tools came only after the worker's `webmcp-install` made the content script
      connect a second port: "WebMCP · 1 tool", "Complete a todo", with its "Always
      allow" switch.
    - This held after the click, after the `goto` and after the reload. Without the
      second port, two seconds after the injection the panel listed nothing. The first
      port, posted at the click, is lost, as §1 says.
  - **Firefox**, the test build with its host access removed at runtime
    (`permissions.remove`; `permissions.contains` false afterwards). The click was the
    action's `triggerAction(window)` run in Firefox's chrome over BiDi with system
    access, since BiDi cannot click the toolbar.
    - Before the click, `scripting.executeScript` was refused: "Missing host
      permission for the tab".
    - After the click it succeeded. The content script, injected by the click,
      installed WebMCP late, the event reached the library, and the page listed
      `complete_todo` and had the mark.
    - After a same-origin navigation it was refused again, and the new page had no
      `modelContext`.
    - A second click on that page made it succeed again. After a reload it was refused
      again.
    - On another origin it was refused.
  - **What it changes.**
    - **The iteration goes on.** Chrome works as planned, the second port is needed as
      planned, and the flash of §1 is real.
    - **In Firefox, each new page needs a click** (§2, §4), including on the same
      origin and after a reload.
    - **A text error that exists today, which task 4 corrects.** The words that say the
      click's access lasts until the tab goes to another origin are wrong in Firefox:
      PRIVACY.md:12, and the navigation tools' description and results
      (`worker/navigation.ts:451`).
    - **Open question 4 becomes a real choice.**
    - **The size:** on main the sketch costs 44 B (6314 to 6358 B of 6400).
- [x] 1. **Client:** the listener (§3) in the constructor, the constant in `./extension`,
  the unit tests, the size measured before and after, the README sentence on the event,
  and the CHANGELOG (Added).
- [x] 2. **Extension, Chrome:**
  - `webmcp-main.ts` dispatches the event.
  - `giveWebMCP` in `tabs.ts`.
  - `webmcp-install` and the second port in `content.ts`, with `late`.
  - The `list` wrapper in `connection.ts`: only while `on`, once per document, forgotten
    with the tab.
  - The types in `messages.ts` and `protocol.ts`.
  - No flash of `no-webmcp` (§1).
- [x] 3. **Extension, Firefox:** with host access the content script installs (or takes
  over) at its start, as before; put in by a click (`tabMcpByClick`) only on
  `webmcp-install` (review of PR 234); `installWebMCP` dispatches the event.
- [x] 4. **Texts:** the panel's `no-webmcp` and the new `late-webmcp` (Chrome and
  `FIREFOX_PANEL_TEXTS`), `webmcpNote` in `card.ts`, `page_info`'s note and
  `FIREFOX_NO_WEBMCP_NOTE`, all agreed with the owner.
- [x] 5. **Docs:**
  - PRIVACY.md, the extension's README, the root README.
  - Both threat models (A13, A14), `kb/design/extension.md`, `kb/design/architecture.md`
    if it describes when the library looks.
  - The CHANGELOGs.
  - A decision-log entry (the late install, its gating, the event).
  - The store listings, where they say "a click comes too late".
- [x] 6. **Browser tests:** the Chrome `store-polyfill` scenario and the Firefox smoke
  scenario (§9), with `bun run test:browser extension firefox`; the hand check in
  Firefox (the owner, 2026-11-23: a real click brings the tool, and after a reload
  Firefox asks for the click again; in Chrome by hand too).
- [x] 7. **The site's privacy page** (ractive.ch repository, pull request 162), merged
  on 2026-11-23, before the extension release; it says "from version 0.4.0 on".
- [x] 8. **Releases** in the order of §10: client 0.24.0 on 2026-11-23 (a candidate
  first, the apps tested on it), the extension 0.4.0 on 2026-11-24.

## Open questions for the owner

1. ~~Install late only while AI access is on and connected (DEC-221's "on"), or at
   every click?~~ **Settled (owner, 2026-11-23: "ok, only while AI access is on"):** the
   late install at a click happens only while the handshake's state is `on`, in Chrome
   and Firefox (`mayGiveLate`, DEC-223). With access to all sites the install at page
   load stays as it is, whatever AI access is (DEC-191).
2. **The panel's texts** (§8): take the drafts for `no-webmcp` and `late-webmcp` as they
   stand, or reword? *Recommendation:* take them, and shorten `no-webmcp` if it reads
   long in the panel at 345 px.
3. ~~Hold the DEC-222 client release for this?~~ **Settled:** DEC-222 is on main
   (PR 232) and was released as client 0.23.0 on 2026-11-23, without a release
   candidate. This listener goes into the next client minor, released before the
   extension.
4. **Firefox drops the click's grant at every navigation, a reload included** (the
   spike showed it). Accept a click per page there, said in Firefox's texts, rather
   than asking Firefox users for access to all sites? *Recommendation:* accept it.
   Access to all sites stays offered either way. Correct PRIVACY.md and the
   navigation tools' words for Firefox in this iteration, since they are wrong today.

# Citations

- [Decision log](/decision-log.md), DEC-115, DEC-143, DEC-177, DEC-188, DEC-191, DEC-207, DEC-209, DEC-215, DEC-221, DEC-222 (client 0.23.0)
- [Iteration 44: WebMCP for Firefox, and Chrome's polyfill](/iterations/iteration-44-firefox-webmcp-spike.md)
- [Iteration 48: the handshake](/iterations/iteration-48-page-extension-handshake.md)
- [Iteration 27: navigation, and the click's grant](/iterations/iteration-27-navigation.md)
- [Iteration 50: browser tests](/iterations/iteration-50-browser-tests.md)
- [Chrome: chrome.scripting.executeScript, `world`](https://developer.chrome.com/docs/extensions/reference/api/scripting#method-executeScript)
- [Chrome: the activeTab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
