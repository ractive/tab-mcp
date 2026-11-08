---
type: iteration
title: "Iteration 19: the extension's skeleton"
status: in-progress
description: "packages/tab-mcp-extension: an MV3 extension whose side panel connects to a tab-mcp relay and offers one read-only tool about the tab in front (page_info, with whether the page has WebMCP on); build, test harness and CI after Overmark's."
timestamp: 2026-11-08T23:30:00+01:00
tags: [iteration, extension]
---
# Iteration 19: the extension's skeleton

The first piece of tab-mcp for Chrome, the small WebMCP bridge ([design](/design/extension.md),
DEC-109, DEC-114): an AI app connects through the relay and learns about the page in front;
the page's WebMCP tools follow in iteration 20. Overmark (its own repository) already does
each part of this; its code is the model.

## Scope

1. **Package** `packages/tab-mcp-extension` in the workspace, private (not published to
   npm), depending on `@ractive-ch/tab-mcp-client` from the workspace.
2. **Manifest V3**: side panel, background service worker, content script injected on a
   click on the icon (`activeTab` + `scripting`); optional host access for "Allow on all
   sites"; no remote code. Without host access a click grants that tab for its origin:
   after a navigation to another origin (another subdomain too), or on another tab, the
   extension may not read it until the next click there, and `page_info` says so. With host access the content script is registered for every
   page (`scripting.registerContentScripts`), so it follows navigations and tab switches.
3. **Side panel**: relay address (default the hosted relay), Connect, the connection
   state, pairing through the library's dialog, Stop; the tab in front and whether the
   extension may run there.
4. **One tool**, read-only and marked `untrustedContentHint`: `page_info` for the tab in
   front: address, title, language, whether WebMCP is available on the page
   (`document.modelContext` is there: the page's origin trial token, or the user's flag,
   which makes it available on every page) and how many tools the page registered
   (`getTools().length`), so "available" and "offers tools" stay apart. A tab the extension may not run on answers with the
   reason and how to allow it. Reading or acting on pages beyond that is not planned
   (DEC-114).
5. **Build** after Overmark's `scripts/build.ts`: a test build (manifest key for a stable
   id, host access for tests) and a store package (no key, no host access, minified).
6. **Tests**: end-to-end with Chrome for Testing after Overmark's harness and
   `test/webmcp-spike/` (pages served through the DevTools Protocol, WebMCP turned on
   with `--enable-features=WebMCP`): the test build, and the store package with real icon
   clicks. A relay from `@ractive-ch/tab-mcp/testing` and an MCP client call the tool.
7. **CI**: the extension's end-to-end tests run on every change. They take a few
   seconds, and a path filter would miss what they depend on (the relay, the pinned
   Chrome, dependencies); the plan had one, the review dropped it.
8. **Docs**: README of the package; how to load it unpacked; the relay's
   `TAB_MCP_ALLOWED_ORIGINS` entry for its id (DEC-108).

## Tasks

- [x] Package, manifest, build script with test and store outputs, icons
- [x] Side panel with connect, pairing, state; the tool registered through the library
- [x] Content script answering `page_info`; registered for every page with host access,
      injected on a click without it; end-to-end cases for a navigation and a tab switch
- [x] End-to-end harness after Overmark's and the spike's; store-package test
- [x] `bun run verify` and the type checks include the package (no CI path filter)
- [ ] README; review; merged on the owner's word

## Outcome

`packages/tab-mcp-extension`: the build (development build with the owner's key, kept in
`~/.config/tab-mcp/extension-key.txt` and not in the repository; test build; store
package), the service worker, the content script, the side panel with `page_info`, 12
unit tests and 7 end-to-end tests (test build and store package, real icon clicks, a
relay in the test process, an MCP client). The development build connects to the hosted
relay (`test/hosted.ts`). Found on the way:

- Chrome keeps the `activeTab` grant across navigations on the same origin in that tab;
  another origin needs a new click, another subdomain of the same site too. Without a grant Chrome hides the tab's address
  from the extension, so the refusal cannot say which page it is.
- A click on the icon right after the extension is installed is lost until its service
  worker has run; the harness waits for it.
- Attaching the DevTools Protocol's request interception to the side panel answers its
  own files too; the harness serves only the test pages.
- The side panel, an extension page, reaches a relay on 127.0.0.1 even where Chrome's
  pages cannot (the command sandbox of a coding agent), so the end-to-end tests run there.

## Out of scope

The WebMCP bridge (iteration 20), the Chrome Web Store (iteration 23), user scripts
(iteration 24).

# Citations

- [Chrome extensions: side panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chrome extensions: activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
