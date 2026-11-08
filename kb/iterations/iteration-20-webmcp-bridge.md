---
type: iteration
title: "Iteration 20: a page's WebMCP tools for AI apps"
status: planned
description: "When the page in front registers WebMCP tools, the extension offers them to the connected AI app through the relay: listed, called, kept in step with toolchange, results marked untrusted, consequential calls confirmed. Built as DEC-113 (iteration 18) decides."
timestamp: 2026-11-08T20:00:00+01:00
tags: [iteration, extension, webmcp]
---
# Iteration 20: a page's WebMCP tools for AI apps

A page that registers tools with WebMCP offers them only to agents in the browser. The
extension passes them on to AI apps outside it ([design](/design/extension.md)). How it
reaches the tools (content script or a script in the page's world) is what iteration 18
finds out; this plan assumes it can, and is adjusted or put off by DEC-113.

## Scope

1. `webmcp_tools` (read-only): the page's tools with names, descriptions and schemas.
2. Each page tool is also offered as a tool of its own, named `page.<name>` so it cannot
   clash with the extension's tools; its schemas pass through, its annotations map to
   the library's (the same names: `readOnlyHint`, `untrustedContentHint`,
   `consequentialHint`). Calling it calls `executeTool()` with the call's abort signal.
3. The list follows `toolchange` and the tab in front: switching tabs or navigating
   replaces the page tools; a call to a tool that is gone says so.
4. **Trust.** A page's hints can lie (the draft says so). Every result is marked
   `untrustedContentHint`; every tool not marked read-only asks the user in the side
   panel each time, naming the page's origin; and a page can mark at most its own tools
   read-only, which harms only that page's own user session, as the page's JavaScript
   could anyway.
5. Limits on the number of tools, schema size and result size, as the library has.

## Tasks

- [ ] Reach the tools as DEC-113 says (content script, or a main-world script and a
      message channel the page cannot forge answers on)
- [ ] `webmcp_tools`; the `page.<name>` tools; `toolchange` and tab changes
- [ ] Mapping of results (text, structured content) and errors; abort on cancel
- [ ] Confirmation and untrusted marking; tests that a page's forged hints change neither
- [ ] End-to-end: a test page with WebMCP tools, an MCP client through the relay calls
      them; skipped where Chrome for Testing lacks WebMCP, with the reason
- [ ] Docs; review; merged on the owner's word

# Citations

- [WebMCP draft (2 November 2026)](https://webmachinelearning.github.io/webmcp/)
