---
type: iteration
title: "Iteration 19: the extension's skeleton"
status: planned
description: "packages/tab-mcp-extension: an MV3 extension whose side panel connects to a tab-mcp relay and offers one read-only tool about the tab in front (page_info, with whether the page has WebMCP on); build, test harness and CI after Overmark's."
timestamp: 2026-11-08T20:00:00+01:00
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
   sites"; no remote code.
3. **Side panel**: relay address (default the hosted relay), Connect, the connection
   state, pairing through the library's dialog, Stop; the tab in front and whether the
   extension may run there.
4. **One tool**, read-only and marked `untrustedContentHint`: `page_info` for the tab in
   front (address, title, language, whether `document.modelContext` is there, that is
   whether the page has WebMCP on). A tab the extension may not run on answers with the
   reason and how to allow it. Reading or acting on pages beyond that is not planned
   (DEC-114).
5. **Build** after Overmark's `scripts/build.ts`: a test build (manifest key for a stable
   id, host access for tests) and a store package (no key, no host access, minified).
6. **Tests**: end-to-end with Chrome for Testing after Overmark's harness and
   `test/webmcp-spike/` (pages served through the DevTools Protocol, WebMCP turned on
   with `--enable-features=WebMCP`): the test build, and the store package with real icon
   clicks. A relay from `@ractive-ch/tab-mcp/testing` and an MCP client call the tool.
7. **CI**: the extension's end-to-end tests only when `packages/tab-mcp-extension/**` or
   the client changed, so relay-only PRs stay fast.
8. **Docs**: README of the package; how to load it unpacked; the relay's
   `TAB_MCP_ALLOWED_ORIGINS` entry for its id (DEC-108).

## Tasks

- [ ] Package, manifest, build script with test and store outputs, icons
- [ ] Side panel with connect, pairing, state; the tool registered through the library
- [ ] Content script answering `page_info`
- [ ] End-to-end harness after Overmark's and the spike's; store-package test
- [ ] CI path filter; `bun run verify` and the type checks include the package
- [ ] README; review; merged on the owner's word

## Out of scope

The WebMCP bridge (iteration 20), the Chrome Web Store (iteration 23), user scripts
(iteration 24).

# Citations

- [Chrome extensions: side panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chrome extensions: activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
