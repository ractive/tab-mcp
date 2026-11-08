---
type: iteration
title: "Iteration 19: the extension's skeleton and its reading tools"
status: planned
description: "packages/tab-mcp-extension: an MV3 extension whose side panel connects to a tab-mcp relay and offers read-only tools about the tab in front (page_info, page_outline, find_elements); build, test harness and CI after Overmark's."
timestamp: 2026-11-08T20:00:00+01:00
tags: [iteration, extension]
---
# Iteration 19: the extension's skeleton and its reading tools

The first usable piece of tab-mcp for Chrome ([design](/design/extension.md), DEC-109): an
AI app connects through the relay and can read the page in front, but not act on it yet.
Overmark (its own repository) already does each part of this; its code is the model.

## Scope

1. **Package** `packages/tab-mcp-extension` in the workspace, private (not published to
   npm), depending on `@ractive-ch/tab-mcp-client` from the workspace.
2. **Manifest V3**: side panel, background service worker, content script injected on a
   click on the icon (`activeTab` + `scripting`); optional host access for "Allow on all
   sites"; no remote code.
3. **Side panel**: relay address (default the hosted relay), Connect, the connection
   state, pairing through the library's dialog, Stop; the tab in front and whether the
   extension may run there.
4. **Tools**, read-only and marked `untrustedContentHint`, acting on the tab in front:
   - `page_info`: address, title, language, size;
   - `page_outline`: landmarks, headings, forms with fields and labels, buttons and links
     with their accessible names, each with a short element reference, cut to a limit;
   - `find_elements`: by text, role, label or test id, with references.
   A tab the extension may not run on answers with the reason and how to allow it.
5. **Build** after Overmark's `scripts/build.ts`: a test build (manifest key for a stable
   id, host access for tests) and a store package (no key, no host access, minified).
6. **Tests**: unit tests for the outline and element finding (happy-dom); end-to-end with
   Chrome for Testing after Overmark's harness: the test build, and the store package with
   real icon clicks. A relay from `@ractive-ch/tab-mcp/testing` and an MCP client call the
   tools.
7. **CI**: the extension's end-to-end tests only when `packages/tab-mcp-extension/**` or
   the client changed, so relay-only PRs stay fast.
8. **Docs**: README of the package; how to load it unpacked; the relay's
   `TAB_MCP_ALLOWED_ORIGINS` entry for its id (DEC-108).

## Tasks

- [ ] Package, manifest, build script with test and store outputs, icons
- [ ] Side panel with connect, pairing, state; tools registered through the library
- [ ] Content script: outline and element finding, with references valid until the page
      changes
- [ ] Unit tests; end-to-end harness copied from Overmark and adapted; store-package test
- [ ] CI path filter; `bun run verify` and the type checks include the package
- [ ] README; review; merged on the owner's word

## Out of scope

Acting on the page and recipes (iteration 21), the WebMCP bridge (iteration 20), the
Chrome Web Store (iteration 23).

# Citations

- [Chrome extensions: side panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chrome extensions: activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
