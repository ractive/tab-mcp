---
type: iteration
title: "Iteration 44: can an extension give Firefox the WebMCP a page needs?"
status: planned
description: "A spike: a Firefox build of tab-mcp for Chrome that supplies document.modelContext itself, as a script in each page's own world, so pages that register WebMCP tools where the API exists register them in Firefox too, and the extension passes them on to AI apps through the relay. Finds out whether real sites (Shopify above all) register with it, how the polyfill reaches the extension, what Firefox's extension APIs need, and what the relay must accept for a moz-extension:// origin; decides whether it is built."
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

The idea (owner, 2026-11-16): the extension supplies the missing API itself. A script
injected into each page's own world at `document_start` defines `document.modelContext`
(`registerTool()` with its `signal`, `getTools()`, `executeTool()`, `toolchange`), the
page registers its tools with it as in Chrome, and the extension offers them to AI apps
through the relay as tab-mcp for Chrome does. MCP-B, the project WebMCP grew out of, was
an extension of this kind (a polyfill and a bridge).

A spike: a research note and a decision, not a feature.

## Questions

1. **Do pages register?** The polyfill only helps where a page registers whenever
   `document.modelContext` is there. A page may also need its origin trial token to be
   valid (which only Chrome checks), test for Chrome, or register late. Try it on the
   diagram example (`tab-mcp-client` with `webmcp: true`), a few Shopify storefronts and
   other sites from the adoption crawl; count how many register, and with which tools.
   This answer decides the rest.
2. **The polyfill.** Firefox's main-world content scripts (`"world": "MAIN"` in
   `content_scripts` or `scripting.registerContentScripts`; which version), run at
   `document_start`, before the page's scripts. The API as the WebMCP draft has it now
   (the draft of 2026-11-12, iteration 34), on `Document.prototype` as a getter, since
   that is where `tab-mcp-client` looks for the browser's own WebMCP (`nativeContext()`,
   DEC-115); a page's own polyfill (such as `@mcp-b/global`) next to it; frames;
   `SecureContext` only.
3. **From the page's world to the extension.** Firefox's content scripts see the page's
   objects through Xray wrappers, so the content script cannot read what the polyfill put
   on `document` (unless through `wrappedJSObject`). The channel: `postMessage` or a
   `CustomEvent`, which the page can read and forge. What stays on the extension's side
   whatever the page sends: the site from the tab's address, the check that a call goes
   to the page its tools were listed from (the content script's id per document), the questions before
   a tool that is not read-only and before another site.
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
   when Chrome's own `document.modelContext` is there.
7. **Distribution.** addons.mozilla.org: its review and signing, what the listing must
   say about a script in every page.

## Tasks

- [ ] Question 1 first: a minimal main-world polyfill that only records registrations,
      run in Firefox on the diagram example and on a list of WebMCP sites; write down
      which register and how
- [ ] If enough do: a test extension in `test/firefox-spike/` (the polyfill, the channel
      to the content script, a sidebar, the connection to a relay), run automatically in
      Firefox (Firefox's WebDriver BiDi or `web-ext`; which one CI can run)
- [ ] Try a local relay with an open origin list and a `moz-extension://` origin
- [ ] Research note `research/firefox-webmcp.md` with versions, quotes and the counts
      of question 1
- [ ] A decision: whether a Firefox build goes ahead, with or without the polyfill for
      Chrome (question 6), and what the relay accepts (question 5, owner)

## Out of scope

Building the Firefox extension; Safari (`safari-web-extension://`, an App Store app);
changing the relay before the decision.

# Citations

- [MDN: content_scripts (world)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts)
- [MDN: Sharing objects with page scripts (Xray vision)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Sharing_objects_with_page_scripts)
- [MDN: sidebar_action](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/sidebar_action)
- [WebMCP draft](https://webmachinelearning.github.io/webmcp/)
- [Shopify: WebMCP on Liquid and Hydrogen storefronts](https://shopify.dev/changelog/webmcp-liquid-hydrogen)
