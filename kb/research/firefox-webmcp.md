---
type: research
title: "WebMCP in Firefox through an extension: the ways, and which sites register"
description: "Iteration 44, questions 0 and 1, then confirmed in Firefox 160: an isolated content script that defines document.modelContext for the page with exportFunction at document_start is the way (no channel through the page); a main-world script with a channel is for Chrome only, userScripts is barred by AMO; Mozilla is neutral and has only an old prototype behind a pref. Shopify storefronts, Hydrogen, the MCP-B and W3C polyfills, Mintlify, GitBook and ReadMe detect WebMCP by presence alone and register with it (eight real sites did in Firefox); what the object must do for them; what Firefox sends to the relay and how its event page lives."
timestamp: 2026-11-16T18:00:00+01:00
tags: [webmcp, extension, firefox, research]
---
# WebMCP in Firefox through an extension

Iteration 44's questions 0 and 1, answered from documentation, Firefox's source, bugs and the
sites' own scripts on 2026-11-16 (Firefox 160 is the release); the last section is what the
spike then confirmed in Firefox.

## The way: `exportFunction` from the content script

The content script stays in its isolated world and defines the API for the page:

```js
const context = new window.EventTarget();            // made in the page's realm
exportFunction(registerTool, context.wrappedJSObject, { defineAs: "registerTool" });
// … getTools, executeTool, the on… handlers likewise
Reflect.defineProperty(window.wrappedJSObject.Document.prototype, "modelContext", {
  get: exportFunction(() => context, window), configurable: true, enumerable: true,
});
```

- **There in Manifest V3.** Firefox creates every content script's sandbox with
  `wantExportHelpers: true`, with no condition on the manifest version
  (`ExtensionContent.sys.mjs`); Firefox's own test checks only Manifest V2. Maintained: fixes
  in 2026 (bug 2033173, in 151, shows this very pattern on `Navigator.prototype`), no bug about
  removing it. Firefox only.
- **Before the page's scripts.** For `document_start` Firefox blocks the parser until the
  content scripts have run (`document.blockParsing`). Not in empty frames: Firefox does not
  inject into `about:blank` frames at `document_start`, so a page can get an untouched
  `Document.prototype` from one and tell that the extension is there.
- **No channel.** The page's calls run in the content script. The page sees only that
  `document.modelContext` exists; it can forge only its own registrations (the API's purpose)
  and break only its own tools (by replacing the getter or the methods). The content script's
  `JSON`, `Promise` and the rest are its own.
- **What the Xrays ask of the code** (MDN, `ExportHelpers.cpp`):
  - A tool object from the page arrives as an Xray that hides functions and getters: read
    `execute` and every member through `wrappedJSObject`, then convert with the content
    script's own `String()` and `JSON` (the page's getters run, as in Chrome's conversion).
  - Objects from another origin are refused (`allowCrossOriginArguments` stays off).
  - An `async` exported function gives the page a promise it cannot use (bug 1757066): the
    functions return `new window.Promise(…)` with values cloned into the page
    (`cloneInto`, or `window.structuredClone` since 149). `RegisteredTool.window` needs
    `cloneInto(…, { wrapReflectors: true })`.
  - An error made in the content script reaches the page as `"An exception was thrown"`:
    errors for the page are made there (`new window.DOMException(…, "InvalidStateError")`).
  - Events are made in the page's realm (`new window.Event("toolchange")`) and dispatched
    through the Xray, which calls the native `dispatchEvent`.
- **Native WebMCP later.** Through the Xrays `"modelContext" in document` is true only for a
  native attribute, never for the extension's own getter: the content script can tell when to
  step aside.

### The other ways, and why not

| Way | Firefox | The page can | Verdict |
|---|---|---|---|
| `exportFunction` from the content script | 49+, in MV3 | see that it exists | **the way** |
| `"world": "MAIN"` script and a channel | 128+ (bug 1736575) | read and change its code, data and the built-ins it did not keep; read and forge the channel once it has it | Chrome only (question 6): MDN, "the web page can detect and interfere" |
| `userScripts`, `USER_SCRIPT` world | 136+ | see that it exists | no: an optional-only permission, and AMO allows it "for user script managers only" |
| MCP-B (`@mcp-b/global` over `window.postMessage`) | page library only, no Firefox extension | read and forge everything; its extension's README: "same-page code can observe or forge the channel" | a library pages bring, not a model |

## Mozilla

- Standards position **neutral** ([standards-positions#1412](https://github.com/mozilla/standards-positions/issues/1412),
  closed 2026-08-05): "a potentially valuable abstraction … but it also opens a surface whose
  real-world dynamics leave too many open questions to wholeheartedly endorse", and it asks
  for "WebExtension and WebDriver BiDi integrations".
- A prototype landed in 150 (bugs 2018320, 2018323): `navigator.modelContext` behind
  `dom.modelcontext.enabled`, off by default, in the early 2026 shape (no `signal`, no
  events, `unregisterTool(name)`), with no work on it since March. Chrome and the draft have
  moved to `document.modelContext`.
- "Add WebMCP extension API" (bug 2019124) is open and unassigned: "Chrome uses content scripts
  and chrome only APIs for this. Let's be legit."

So nothing native is close; the polyfill would be the way for a while.

## Host access

- Since 127 Firefox grants Manifest V3 `host_permissions` and every `content_scripts.matches`
  at install (bug 1889402, `extensions.originControls.grantByDefault`, on by default), shown
  in the install prompt. The user can revoke them; new origins in an update are not shown
  (bug 1893232). Bug 1889402 calls it "a temporary stopgap": broad patterns may stop being
  granted at install. **A risk for a script on every site.**
- Temporary installs (`about:debugging`, `web-ext`) get them silently; what a reload of a
  temporary add-on keeps is open.
- Without the grant, a click on the icon injects the scripts once, after the page has loaded:
  too late for the sites below.

## AMO

Code in the package is fine (no remote code). Changing pages is allowed when the listing says
it plainly ("No Surprises"); running only on sites the user picks satisfies even a strict
reading. Nothing that identifies the user across sessions may reach pages: the object carries
no id. New add-ons declare `data_collection_permissions` (since 2025-11-03); a bundled build
needs its sources uploaded. The policy taking effect on 2026-12-01 has the same text here.

## Which sites register

Every site and library read detects WebMCP by **presence alone**: `"modelContext" in
document`, a truthy `document.modelContext`, or `typeof …registerTool == "function"`. None
checks the browser, `instanceof ModelContext`, a `ModelContext` global or whether the origin
trial worked. All check **once**, while loading.

| Site or library | Registers with the extension's getter | When |
|---|---|---|
| Shopify Liquid storefronts (5 read: same loader, also served to Firefox) | yes, 12 tools (`search_catalog`, `get_product`, cart, checkout, orders, `ask_business` …), MCP results | after `DOMContentLoaded` (at parse on later visits), after Shopify's origin trial script, then a module registers at once, without a signal |
| Hydrogen 2026.10 (`ShopifyScripts`, on by default) | yes, the same script | after hydration |
| `@mcp-b/webmcp-polyfill` 3–6.2, `@w3c/webmcp-polyfill` 0.1 | yes: they step aside; 6.x adds `<form toolname>` tools on the extension's object | on load |
| `@mcp-b/global` 3–6.2 | yes: it wraps the object and copies every tool into it with `{signal, exposedTo}` | on load, then at each registration |
| `@mcp-b/global` 2.x | only through `navigator.modelContext` | on load |
| Mintlify, GitBook, ReadMe docs | yes, with `{signal}`; Mintlify and ReadMe register again on a route change | after hydration |

Not read: Cloudflare's bridge (no site found serving it), Shopify's checkout tools (they need
a cart), SEOPress Pro, Tambourine. Browser Use's crawl (October 2026) put a recorder in the
pages before load, the same idea, and found 13,352 sites registering; of 400 it checked again,
70 registered only through the older `navigator.modelContext` or `provideContext()`.

### What the extension's object must do for them

1. Be an `EventTarget` with `registerTool`, `getTools`, `executeTool` and the events
   `toolchange`, `toolactivated`, `toolcancel`: `@mcp-b/global` 6.x calls `addEventListener`
   without checking (without it the page gets no tools at all), and the 6.x polyfill
   dispatches on it.
2. Take `registerTool(tool, {signal, exposedTo})` and unregister when the signal aborts
   (Mintlify, GitBook, ReadMe, `@mcp-b/global`); return a promise (the draft of 2026-11-13;
   Shopify collects them with `Promise.allSettled`, `@mcp-b/global` awaits them).
3. Call `execute(input, { signal })` with a real `AbortSignal` always: `@mcp-b/global` 6.x
   calls `signal.throwIfAborted()`.
4. Be `navigator.modelContext` too, and perhaps take `provideContext()`, for the older pages.
5. Take both an MCP `CallToolResult` (Shopify, Mintlify, GitBook) and a plain object (ReadMe)
   as a result: the bridge already maps both (DEC-113, iteration 34).

## Confirmed in Firefox 160 (the spike)

Iteration 44 built the Firefox build and ran it headless over WebDriver BiDi (and with
ff-rdp's `launch --temporary-addon`):

1. `exportFunction`, `cloneInto` and `wrappedJSObject` are there in a Manifest V3 content
   script; `execute` is hidden by the Xray and reached through `wrappedJSObject`.
2. Events: an `EventTarget` made with `new window.EventTarget()` is one in the page;
   `toolchange` dispatched from the content script reaches the page's listeners.
3. The content script awaits the page's promise from `execute`; a signal made with
   `new window.AbortController()` is `instanceof AbortSignal` in the page, and its abort
   reaches the page.
4. Errors: `InvalidStateError` for a taken name reaches the page with its name and
   message (made with the page's `DOMException`).
5. `@mcp-b/global` 6.2.0, 4.0.0 and 2.2.0 and `@mcp-b/webmcp-polyfill` 6.2.0, 5.1.0 and
   3.0.0 register through the getter; `@mcp-b/global` 5.1.0 throws `SecurityError` in
   Firefox on its own (npm-packages#357). Four Shopify storefronts, two Mintlify, a
   GitBook and a ReadMe site register; two pages without a WebMCP loader do not.
6. No `moz-extension://` URL in what the page sees: the exported functions read as
   `[native code]`, errors made for the page have an empty stack, and a stack taken in
   `execute` has only the page's frames. The page learns that the extension is there,
   not which installation.
7. Not checked: host access after reloading a temporary add-on.

Also found: Firefox sends `Origin: moz-extension://<UUID>` on the background's
WebSocket; an idle event page is stopped after 30 s, WebSocket and all, unless an
extension API is called (a content script's port and `persistent` do not keep it);
Firefox's default extension CSP upgrades `ws://127.0.0.1` to `wss:`.

# Citations

- [MDN: Sharing objects with page scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Sharing_objects_with_page_scripts)
- [MDN: exportFunction](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts/exportFunction)
- [MDN: content_scripts (world, run_at)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts)
- [MDN: userScripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts)
- [MDN: host_permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions)
- [Firefox source docs: Xray vision](https://firefox-source-docs.mozilla.org/dom/scriptSecurity/xray_vision.html)
- [ExtensionContent.sys.mjs](https://hg.mozilla.org/mozilla-central/file/tip/toolkit/components/extensions/ExtensionContent.sys.mjs), [ExportHelpers.cpp](https://hg.mozilla.org/mozilla-central/file/tip/js/xpconnect/src/ExportHelpers.cpp), [Extension.sys.mjs](https://hg.mozilla.org/mozilla-central/file/tip/toolkit/components/extensions/Extension.sys.mjs), [ModelContext.webidl](https://hg.mozilla.org/mozilla-central/file/tip/dom/webidl/ModelContext.webidl)
- Bugs [2033173](https://bugzilla.mozilla.org/show_bug.cgi?id=2033173), [1757066](https://bugzilla.mozilla.org/show_bug.cgi?id=1757066), [1736575](https://bugzilla.mozilla.org/show_bug.cgi?id=1736575), [1943050](https://bugzilla.mozilla.org/show_bug.cgi?id=1943050), [1889402](https://bugzilla.mozilla.org/show_bug.cgi?id=1889402), [1893232](https://bugzilla.mozilla.org/show_bug.cgi?id=1893232), [2018306](https://bugzilla.mozilla.org/show_bug.cgi?id=2018306), [2018320](https://bugzilla.mozilla.org/show_bug.cgi?id=2018320), [2019124](https://bugzilla.mozilla.org/show_bug.cgi?id=2019124)
- [Mozilla standards position on WebMCP (#1412)](https://github.com/mozilla/standards-positions/issues/1412)
- [Mozilla add-ons blog: Manifest V3 updates (2024-05-14)](https://blog.mozilla.org/addons/2024/05/14/manifest-v3-updates/), [data collection consent (2025-10-23)](https://blog.mozilla.org/addons/2025/10/23/data-collection-consent-changes-for-new-firefox-extensions/)
- [Extension Workshop: Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/), [Test permission requests](https://extensionworkshop.com/documentation/develop/test-permission-requests/)
- [WebMCP draft](https://webmachinelearning.github.io/webmcp/)
- [MCP-B packages (WebMCP-org/npm-packages)](https://github.com/WebMCP-org/npm-packages), [@mcp-b/webmcp-extension README](https://github.com/WebMCP-org/npm-packages/tree/main/packages/webmcp-extension), [npm-packages#357](https://github.com/WebMCP-org/npm-packages/issues/357)
- [Shopify: WebMCP on Liquid and Hydrogen](https://shopify.dev/changelog/webmcp-liquid-hydrogen), [Web MCP docs](https://shopify.dev/docs/api/web-mcp), [Hydrogen webmcp.ts](https://github.com/Shopify/hydrogen/blob/main/packages/hydrogen/src/core/shopify-scripts/webmcp.ts)
- [Browser Use: WebMCP crawl](https://browser-use.com/webmcp)
- [Cloudflare: WebMCP](https://blog.cloudflare.com/webmcp/)
