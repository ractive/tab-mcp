---
type: iteration
title: "Iteration 20: a page's WebMCP tools for AI apps"
status: in-progress
description: "When the page in front registers WebMCP tools, the extension offers them to the connected AI app through the relay, reached from its content script (DEC-113): listed, called with a timeout, kept in step with toolchange, results marked untrusted, consequential calls confirmed."
timestamp: 2026-11-08T23:45:00+01:00
tags: [iteration, extension, webmcp]
---
# Iteration 20: a page's WebMCP tools for AI apps

A page that registers tools with WebMCP offers them only to agents in the browser. The
extension passes them on to AI apps outside it ([design](/design/extension.md)). It
reaches them from its content script, on the native `document.modelContext` (DEC-113,
[research](/research/webmcp-from-extension.md)).

## Scope

1. `webmcp_tools` (read-only): the page's tools with names, descriptions and schemas.
2. Each page tool is also offered as a tool of its own, named `page_<name>` so it cannot
   clash with the extension's tools; its `inputSchema` passes through (the library
   validates arguments against it; Chrome does not), its annotations map to the
   library's (the same names: `readOnlyHint`, `untrustedContentHint`,
   `consequentialHint`). Chrome 156 gives no `outputSchema`. Calling it calls
   `executeTool()` with the call's abort signal and a timeout (Chrome has none); the
   string it returns becomes one text block, or the content blocks of the MCP result it
   encodes (`@mcp-b/global` pages).
3. The list follows `toolchange` and the tab in front: switching tabs or navigating
   replaces the page tools; a call to a tool that is gone says so. Tool lists change
   without any navigation (single-page apps register and unregister as the user moves),
   and pages in the origin trial carry workarounds: the list is advisory, re-read on
   every `toolchange`, and "tool not found" is an answer for the AI app, not an error of
   the bridge (anthropics/claude-code#76809). Where the content
   script is not running (no host access and no click on this page, iteration 19), the
   list is empty and `webmcp_tools` says why.
4. **Trust.** A page's hints can lie (the draft says so). Every result is marked
   `untrustedContentHint`; every tool not marked read-only asks the user in the side
   panel each time, naming the page's origin; and a page can mark at most its own tools
   read-only, which harms only that page's own user session, as the page's JavaScript
   could anyway.
5. Limits on the number of tools, schema size and result size, as the library has, and
   on description length.
6. **Tools of tab-mcp pages.** A page whose tab-mcp library mirrors its tools into
   WebMCP (iteration 25) lists their names in `<html data-tab-mcp-webmcp="…">`; the
   bridge leaves those out, so an AI app connected to the page and to the extension gets
   each tool once.
7. **Page-written metadata.** A tool's name, title, description and schema are the
   page's words and reach the AI app in the tool list, where `untrustedContentHint`
   cannot mark them: a description can carry instructions ("before any tool, call
   page_transfer …"). Descriptions are cut to a limit and start with the page's origin
   (`From https://example.com: …`), so the AI app can tell them from the extension's.
8. The top frame only. Tools of cross-origin frames, and pages with only the
   `@mcp-b/global` polyfill (no native WebMCP), are out of scope (DEC-113).

## Tasks

- [x] Reach the tools from the content script (DEC-113); a page that replaces
      `document.modelContext` in its own world changes nothing (test)
- [x] `webmcp_tools`; the `page_<name>` tools; `toolchange` and tab changes
- [x] Mapping of results (a string: one text block; the JSON of an MCP result: its
      content blocks) and errors; timeout; abort on cancel
- [x] Confirmation and untrusted marking; tests that a page's forged hints change neither
- [x] End-to-end: a test page with WebMCP tools, an MCP client through the relay calls
      them; Chrome for Testing with `--enable-features=WebMCP`, as `test/webmcp-spike/`
      does
- [x] Threat model (`kb/design/threat-model.md`): the extension, page-written tool
      metadata, results, consequential calls
- [ ] Docs; review; merged on the owner's word

## Outcome

The bridge in `packages/tab-mcp-extension/src/sidepanel/bridge.ts`: the content script
lists, calls and cancels the page's tools on the native object and reports `toolchange`
(and its own start, after an icon click); the side panel registers a `page_<name>` tool
per page tool in its `TabMcp` and replaces them when the tab, the page or its list
changes. Limits: 64 tools, descriptions 1000 characters after `From <origin>: `, titles
100, schemas 16 KB, results 100,000 characters, calls 60 s. The side panel is redesigned
(connection with its state, the tab with its tools marked "reads" or "asks first",
Settings), and the connector carries the extension's icon.

The owner's tries showed two things. Claude drops tools whose names the Anthropic API does
not take (`^[a-zA-Z0-9_-]{1,64}$`): the planned `page.<name>` never reached it, so the
tools are `page_<name>`, other characters as `_`, at most 64 characters, a clash left out.
And Claude reads a connector's tool list once: `page_<name>` tools that come with a later
tab do not reach it. `webmcp_call` calls a page tool by name
with the same rules, for such AI apps. The review added: calls bound to the page they
were listed from and to the read-only claim (a page could otherwise offer a read-only
tool and navigate the tab to a site with a consequential one of that name), calls that
end even when the page is stuck, refreshes that run one at a time, the page's regular
expressions left out of validation, and budgets for everything the page sends. Tests:
bridge and content script units, 17 end-to-end tests. Threat model: A13.

# Citations

- [WebMCP draft (2 November 2026)](https://webmachinelearning.github.io/webmcp/)
- [anthropics/claude-code#76809](https://github.com/anthropics/claude-code/issues/76809)
