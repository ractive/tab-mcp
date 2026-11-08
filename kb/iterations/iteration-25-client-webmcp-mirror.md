---
type: iteration
title: "Iteration 25: tab-mcp tools also as WebMCP tools"
status: planned
description: "The client library registers each tool a page gives it also with document.modelContext.registerTool() where the browser has WebMCP, so agents in the browser (ChatGPT's browser, Gemini in Chrome, MCP Apps hosts, extensions) can use a tab-mcp page without extra work; calls from there go through the same argument check and confirmation as calls from AI apps."
timestamp: 2026-11-08T23:45:00+01:00
tags: [iteration, client, webmcp]
---
# Iteration 25: tab-mcp tools also as WebMCP tools

A page that uses `tab-mcp-client` offers its tools to AI apps outside the browser through
the relay. WebMCP is how a page offers tools to agents inside the browser, and those are
arriving: ChatGPT's built-in browser, Gemini in Chrome (announced), MCP Apps hosts, which
since ext-apps#829 read a view's `document.modelContext` ([adoption](/research/webmcp-adoption.md)).
The library's tools already have the WebMCP shape, so it can register each of them there
too, as MCP Apps' SDK does for app tools (DEC-115).

## Scope

1. **Mirroring.** Where `document.modelContext` exists (native WebMCP: the page's origin
   trial token or the user's flag), every tool registered with `TabMcp.registerTool()` is
   also registered with `document.modelContext.registerTool()`: same name, title,
   description, `inputSchema`, the WebMCP annotations (`readOnlyHint`,
   `untrustedContentHint`, `consequentialHint`, `debugging`; the MCP-only hints are left
   out). Unregistering in tab-mcp (its signal) unregisters the mirror. Before and after
   `connect()` alike: the mirror does not need the relay.
2. **The same rules for both callers.** A call through WebMCP checks the arguments against
   `inputSchema` (Chrome does not) and asks the user before a consequential tool, with
   the library's dialog or the page's `onConfirm`, exactly as a call from an AI app does.
   The question says the call comes from an agent in this browser, not from a connected
   AI app. `toolcall` and `toolcallend` events fire for it too.
3. **Who is calling.** `ToolExecuteOptions.client` and `ConfirmRequest.client` describe a
   relay grant today (grant id, client id, host). A WebMCP call has none: the type grows
   a second kind (for example `{ via: "webmcp" }` beside the relay's), designed so pages
   that read `client.host` keep compiling or fail loudly, not silently. Decided in this
   iteration, in the protocol document.
4. **Results.** WebMCP callers get what the tool's `execute` returned (it is already the
   WebMCP shape); a thrown error stays a thrown error. Chrome turns a non-string result
   into JSON for the caller (iteration 18).
5. **Conflicts.** A name the page already registered natively makes the mirror fail
   (`InvalidStateError`, iteration 18): the tab-mcp tool stays, without a mirror, and the
   library warns once in the console. Polyfills: only a native `ModelContext`
   is mirrored into, so a page's `@mcp-b/global` is not doubled.
6. **Opt-out.** On by default; `new TabMcp({ webmcp: false })` turns it off (DEC-115).
7. **Size.** The mirroring is in the core (a few hundred bytes); the argument check and
   the dialog stay in the lazily loaded chunks, loaded on the first WebMCP call. The core
   stays within its 6 KB budget (DEC-103).

## Tasks

- [ ] Mirroring and unregistering in the core; the `webmcp` option; conflicts
- [ ] WebMCP calls through the argument check, the confirmation and the events
- [ ] The caller type for WebMCP calls; protocol document, types, React bindings
- [ ] Unit tests with a fake `document.modelContext`; a browser test with Chrome for
      Testing and `--enable-features=WebMCP` (pages served as in `test/webmcp-spike/`):
      the page's `getTools()` lists the tools, `executeTool()` runs them, a consequential
      one waits for the dialog, a bad argument is refused, aborting unregisters, a native
      duplicate is skipped, `webmcp: false` registers nothing
- [ ] README (the two audiences: AI apps through the relay, agents in the browser), the
      threat model (in-browser agents can now call the page's tools, each consequential
      call still asks), CHANGELOG; a client release on the owner's word
- [ ] Review; merged on the owner's word

## Out of scope

Reading the page's own WebMCP tools into tab-mcp (the other direction of ext-apps#829);
the extension's bridge (iteration 20), which would see a tab-mcp page's mirrored tools
like any page tools.

# Citations

- [MCP Apps: WebMCP interoperability, modelcontextprotocol/ext-apps#829](https://github.com/modelcontextprotocol/ext-apps/pull/829)
- [WebMCP draft (2 November 2026)](https://webmachinelearning.github.io/webmcp/)
