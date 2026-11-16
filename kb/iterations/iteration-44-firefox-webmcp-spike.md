---
type: iteration
title: "Iteration 44: can an extension give Firefox the WebMCP a page needs?"
status: planned
description: "A spike: a Firefox build of tab-mcp for Chrome that supplies document.modelContext itself, defined for each page by its content script, so pages that register WebMCP tools where the API exists register them in Firefox too, and the extension passes them on to AI apps through the relay. Researches the ways Firefox allows it and what each lets the page do, finds out whether real sites (Shopify above all) register with it, what Firefox's extension APIs need, and what the relay must accept for a moz-extension:// origin; decides whether it is built."
timestamp: 2026-11-16T12:00:00+01:00
tags: [iteration, extension, firefox, webmcp, research]
---
# Iteration 44: can an extension give Firefox the WebMCP a page needs?

Firefox has no WebMCP: there is no `document.modelContext`, so a page that registers its
tools only where the API exists registers nothing, and tab-mcp for Chrome has nothing to
read there (it reads only the browser's own WebMCP, DEC-113). Pages built on
`tab-mcp-client` already work in Firefox, through the relay and with no extension; what
Firefox lacks are the pages that use **WebMCP alone**: about 13,000 sites, Shopify's
Liquid storefronts above all, on by default since August 2026
([adoption](/research/webmcp-adoption.md)).

The idea (owner, 2026-11-16): the extension supplies the missing API itself. At
`document_start` it defines `document.modelContext` for the page (`registerTool()` with
its `signal`, `getTools()`, `executeTool()`, `toolchange`), the page registers its tools
with it as in Chrome, and the extension offers them to AI apps through the relay as
tab-mcp for Chrome does. MCP-B, the project WebMCP grew out of, was an extension of this
kind (a polyfill and a bridge). The first candidate is Firefox's own way for a content
script to define objects for the page (question 2), which needs no channel through the
page; question 0 weighs it against the others.

A spike: a research note and a decision, not a feature.

## Questions

0. **The ways Firefox allows it.** Research before building, from Mozilla's documentation,
   Firefox's source and bugs, with versions: `exportFunction`/`cloneInto` from the
   content script (question 2); a `"world": "MAIN"` content script with a channel
   (question 6); the `userScripts` API (its worlds, and whether its messaging reaches
   the extension without passing through the page); `wrappedJSObject`; how MCP-B's
   extension and `@mcp-b/global` did it (their transport over `postMessage`), and what
   went wrong for them. For each: what the page can read, forge or break, whether it
   runs before the page's scripts, what Manifest V3 and AMO's review allow, and whether
   Mozilla plans to keep it. Also Mozilla's own plans for WebMCP (standards position,
   bugs), since a native `document.modelContext` in Firefox would make the polyfill
   step aside, as in question 6.
1. **Do pages register?** The polyfill only helps where a page registers whenever
   `document.modelContext` is there. A page may also need its origin trial token to be
   valid (which only Chrome checks), test for Chrome, or register late. Try it on the
   diagram example (`tab-mcp-client` with `webmcp: true`), a few Shopify storefronts and
   other sites from the adoption crawl; count how many register, and with which tools.
   Also **when**: a page that looks for `document.modelContext` only while it loads has
   decided before a click on the icon could inject anything (`activeTab`), so the
   polyfill must be there at `document_start`, which needs lasting host access to the
   site and a reload after it is granted. Whether pages look again later (Shopify above
   all) decides whether a click can ever be enough. The answer shapes the design rather
   than deciding whether to go on (owner, 2026-11-16: WebMCP will spread fast): which
   pages register on any `document.modelContext`, which bring their own polyfill (and
   whether it wraps ours or replaces it), and which only register for Chrome or a valid
   token. Reading the sites' scripts answers most of it before any extension runs.
2. **The polyfill, from the content script.** Firefox lets a content script, in its own
   isolated world, define objects in the page's world: `exportFunction()` and
   `cloneInto()` ([sharing objects with page scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Sharing_objects_with_page_scripts)).
   The content script puts a getter for `modelContext` on the page's
   `Document.prototype` (where `tab-mcp-client` looks for the browser's own WebMCP,
   `nativeContext()`, DEC-115) whose object's `registerTool()` (with its `signal`),
   `getTools()` and `executeTool()` are exported functions of the content script, and
   which is an `EventTarget` of the page's world for `toolchange`. The API as the WebMCP
   draft has it now (the draft of 2026-11-12, iteration 34). To find out: whether
   `exportFunction` is there for Manifest V3 content scripts and in which Firefox
   version; what the Xrays let through (a tool's `execute` is a function the page made,
   called through `wrappedJSObject`; its `inputSchema` copied out, the page's getters
   running; promises and events made in the page's world); a page's own polyfill (does
   `@mcp-b/global` wrap the getter as it wraps Chrome's own object); frames;
   `SecureContext` only.
3. **From the page to the extension.** With exported functions there is no channel: the
   page calls the API and the call runs in the content script, as with Chrome's own
   WebMCP. The page cannot read or forge messages, nor change the content script's
   globals (`JSON`, `Promise`), and `registerTool()` rejects at once for a name that is
   taken (it returns a promise in the draft of 2026-11-13). The content script keeps the tools itself and gives
   `content.ts` an object with the `ModelContext` it uses today (in Firefox
   `document.modelContext` is `undefined` there: the Xrays hide what is defined for the
   page), so the reading, the timeout and the result mapping stay as they are. What
   stays on the extension's side whatever the page does: the site from the tab's
   address, the check that a call goes to the page its tools were listed from (the
   content script's id per document), the questions before a tool that is not
   read-only and before another site. What no mechanism avoids: in Firefox a
   `document.modelContext` tells every page it runs on that the user has the extension,
   which DEC-113 counted against registering recipes; the owner decides whether that is
   acceptable, and on which sites the polyfill runs.
4. **Firefox's extension APIs.** `sidebar_action` for the side panel; Manifest V3's
   background as an event page instead of a service worker, and whether the WebSocket
   to the relay survives it (iteration 26 relies on the connection staying with the
   panel closed); notifications, `activeTab`, optional host access, `scripting`; how
   much of `packages/tab-mcp-extension` builds for both browsers unchanged.
5. **The relay and `moz-extension://`.** The relay refuses that origin (DEC-108): Firefox
   gives every installation its own id, so no list can name it, and only an open relay
   (`TAB_MCP_ALLOWED_ORIGINS=*`) admits it. What accepting any `moz-extension://` origin
   as "a Firefox extension" would mean: websites still cannot send it, but any Firefox
   extension could connect under that name. DEC-108 already says a Chrome id is no proof
   of the publisher either; the pairing code still ties the AI app to the panel the user
   reads. A Firefox extension could also connect from a page whose requests carry
   another origin; find out what Firefox sends.
6. **Chrome without WebMCP.** The same polyfill would help Chrome users who have neither
   the flag nor a site with a token. Whether that is worth it, and how it steps aside
   when Chrome's own `document.modelContext` is there. Chrome has no `exportFunction`,
   so there it is a main-world script (`"world": "MAIN"`) with a channel to the content
   script: not `window.postMessage` (any frame or opener posts into the window, and
   every listener of the page reads it) but a `MessageChannel` port handed over at
   `document_start`, before any page script runs, and kept in the script's closure,
   which also keeps its own copies of the built-ins it uses. The channel carries data
   only (the tools, a call, its result), never anything that makes the extension act on
   its own; what the page could forge on it, the page can already do by registering.
7. **Distribution.** addons.mozilla.org: its review and signing, what the listing must
   say about a script in every page.

## Tasks

- [x] Question 0: the ways, compared in the research note, with sources
- [x] The test harness: `ff-rdp` (the owner's Firefox Remote Debugging Protocol CLI)
      launches Firefox, opens the sites and reads what the page sees (`eval`,
      `console`). It does not install an unsigned extension yet: a profile's
      `extensions/` folder takes only signed ones (as `--auto-consent` does with
      Consent-O-Matic) in release Firefox. Either `ff-rdp` gains a temporary install
      (the root actor's `installTemporaryAddon`, what `web-ext run` and
      `about:debugging` use), or the spike uses `web-ext`; decide by which one CI can run
- [x] Questions 1 and 2: a minimal polyfill that only records registrations,
      defined from the content script with `exportFunction` at `document_start`, run in
      Firefox on the diagram example and on a list of WebMCP sites; write down which
      register, how and when, and whether `@mcp-b/global` registers through it
- [x] A test extension in `test/firefox-spike/` (the polyfill, its object
      for `content.ts`, a sidebar, the connection to a relay), run automatically in
      Firefox with that harness
- [-] Only if question 6 is worth it: the main-world script and its `MessageChannel` in
      Chrome without WebMCP
- [x] Try a local relay with an open origin list and a `moz-extension://` origin
- [x] Research note `research/firefox-webmcp.md` with versions, quotes and the counts
      of question 1
- [ ] A decision: whether a Firefox build goes ahead, with or without the polyfill for
      Chrome (question 6), and what the relay accepts (question 5, owner)

## Out of scope

Releasing the Firefox build (addons.mozilla.org); Safari (`safari-web-extension://`, an
App Store app). Built after all, on the owner's request (2026-11-16): a working Firefox
build as the spike's sample, and the relay's `moz-extension://*` (DEC-189).

## Results

2026-11-16, Firefox 160 on macOS. The owner asked for a sample by the morning: a Firefox
build that gives Firefox WebMCP through a tab-mcp relay. It works, end to end.

- **The way (questions 0, 2, 3): DEC-188.** Not a test extension in `test/firefox-spike/`
  but a Firefox build of tab-mcp for Chrome itself (`bun scripts/build.ts --firefox`):
  the content script defines `document.modelContext` for the page with `exportFunction`
  (`src/firefox/webmcp.ts`) and hands `content.ts` the same interface Chrome's WebMCP
  has, so the bridge, the panel, the questions and the relay connection are unchanged.
  Confirmed in Firefox, the research note's open points: the export helpers in a
  Manifest V3 content script; the page's tool object read through `wrappedJSObject`
  (`execute` is hidden by the Xray); promises, errors (`InvalidStateError` for a name
  taken) and events (`toolchange`) made in the page's realm reach the page intact; a page
  `AbortSignal` handed to `execute` (`instanceof AbortSignal` in the page).
- **Real sites (question 1)**, `test/firefox-sites.ts`: allbirds, kyliecosmetics,
  brooklinen, colourpop (Shopify Liquid, 12 tools each), launchdarkly and openrouter docs
  (Mintlify, 5), gitbook.com/docs (3), developer.themoviedb.org (ReadMe, 3) register in
  Firefox. gymshark.com and fashionnova.com register nothing: their pages have no WebMCP
  loader at all (the research read Gymshark's checkout host).
- **Page polyfills on top**: `@mcp-b/global` 6.2.0, 4.0.0 and 2.2.0 and
  `@mcp-b/webmcp-polyfill` 6.2.0, 5.1.0 and 3.0.0 all bring the page's tool into the
  extension's object, and a call with a signal works. `@mcp-b/global` 5.1.0 fails in
  Firefox with or without the extension: its own polyfill throws `SecurityError`
  (npm-packages#357).
- **Firefox's extension APIs (question 4)**: the sidebar for the side panel; the event
  page is stopped after 30 s idle, WebSocket and all, unless an extension API is called
  (every 20 s while AI access is on; a content script's port and `persistent` do not
  help); notifications without buttons; Firefox's default extension CSP upgrades
  `ws://127.0.0.1` to `wss:` (the build sets Chrome's CSP).
- **The relay (question 5)**: Firefox sends `Origin: moz-extension://<UUID>`, a UUID
  per installation (the add-on id is not in it). On the owner's request a relay now
  takes `moz-extension://*` (DEC-189), released as relay 0.11.0 and set on the hosted
  relay the same day; the build connects to tab-mcp.ractive.ch with its defaults.
- **Harness**: WebDriver BiDi, built into Firefox (`test/firefox.ts`): temporary
  install (`webExtension.install`), evaluation in pages and, with
  `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS`, in the panel. BiDi cannot open or reach the sidebar,
  navigate to an extension page or focus a second window in headless Firefox, so the test
  build opens the panel in a tab and the tests open their pages in another window. CI
  runs it where Firefox is installed. ff-rdp's `launch --temporary-addon` (ff-rdp#371)
  installs the build too and found allbirds' 12 tools on the first page.
- **Review** (Claude 5, GLM 2): Firefox's notifications close by themselves, and a close
  counted as Don't allow; on Linux CI the question was gone before the panel showed it
  (the confirmation test failed twice). In the Firefox build a close is no answer now.
  Also fixed: the polyfill keeps the page's order of calls, `provideContext` checks
  every tool and the limit before it changes anything, a late injection leaves a page's
  own polyfill alone, and Firefox's restricted hosts and words in `noAccess`.
- **The owner's test in a real Firefox**: the development build paired with Claude Code
  through tab-mcp.ractive.ch, "Give access to all sites" and Firefox's prompt, the
  diagram example's 8 tools (shapes and connectors added) and allbirds.ch's tools
  (search_catalog, get_cart, ask_business). Allow seemed dead: it counts only after a
  click into the sidebar (DEC-087), and Firefox leaves the focus in the page, so the
  question now says "Click into the sidebar to answer."
- **An extension reload or update takes open pages' tools**: they lived in the content
  script that ended, and the page registered them once as it loaded. Firefox makes the
  old script's getters dead objects: every read of `document.modelContext` or
  `navigator.modelContext` throws "can't access dead object" in the page. The new
  content script (put in when the worker next reads the tab) replaces them, so the
  page's reads work and new tools register, and marks the page `stale` while it has no
  tools: the sidebar and `page_info` ask for a reload, the only thing that brings the
  old tools back (Chrome, and Chrome's page-world polyfill, keep them). Reloading the
  user's tabs unasked is not an option. Once on addons.mozilla.org, every automatic
  update does this. Firefox test: "an extension reload or update".
- **Second review** (Claude 2, GLM 3): the dead getters above; Chrome's polyfill had
  one second to answer the handover, so a page busy after its load had no WebMCP (no
  time limit now); a question's notification clicked while another Firefox window is in
  front opened that window's sidebar (the question's window first now, and a refusal
  when the sidebar is not open there); the restricted-sites wording in the panel.
- **Open for the owner**: whether the Firefox build goes on (to addons.mozilla.org), the
  fingerprint every page sees.

# Citations

- [MDN: content_scripts (world)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts)
- [MDN: Sharing objects with page scripts (Xray vision)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Sharing_objects_with_page_scripts)
- [MDN: sidebar_action](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/sidebar_action)
- [WebMCP draft](https://webmachinelearning.github.io/webmcp/)
- [Shopify: WebMCP on Liquid and Hydrogen storefronts](https://shopify.dev/changelog/webmcp-liquid-hydrogen)
