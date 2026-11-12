---
type: iteration
title: "Iteration 25: tab-mcp tools also as WebMCP tools"
status: planned
description: "When a page asks for it, the client library registers its tools also with document.modelContext.registerTool() where the browser has WebMCP, so agents in the browser (ChatGPT's browser, Gemini in Chrome when it comes, extensions) can use the page's tools; consequential tools only when the page says so per tool, because an agent in the browser can answer the page's own confirmation."
timestamp: 2026-11-09T15:00:00+01:00
tags: [iteration, client, webmcp]
---
# Iteration 25: tab-mcp tools also as WebMCP tools

A page that uses `tab-mcp-client` offers its tools to AI apps outside the browser through
the relay. WebMCP is how a page offers tools to agents inside the browser: ChatGPT's
built-in browser calls them, Gemini in Chrome is announced
([adoption](/research/webmcp-adoption.md)). The library's tools already have the WebMCP
shape, so it can register them there too. MCP Apps' SDK does the same for the tools of
its views since ext-apps#829, which is the precedent, not a caller: MCP Apps hosts read a
view's own `document.modelContext`, not a tab-mcp page in a browser tab (DEC-115).

## The two callers are not alike

- An AI app through the relay is remote: it was paired by the user, it is named and
  verified (its grant), and it cannot touch the page, so the page's dialog is a real
  question to the user.
- An agent in the browser is not paired and has no verified identity; it often drives
  this very tab, so it can click Allow in the page's dialog itself (input from the
  DevTools Protocol or an extension is trusted input, and the delay before Allow only
  needs the tab visible and focused). For it, the page's confirmation is weaker.

Hence: off by default, and consequential tools stay out unless the page names them.

## Scope

1. **Opt-in.** `new TabMcp({ webmcp: true })` mirrors the tools that are not
   consequential; a tool registered with `{ webmcp: true }` in its options is mirrored
   even if consequential (the page decides that its own dialog, or the agent's own
   confirmation, is enough for it). Off by default (DEC-115): mirroring makes read-only
   tools answer every in-browser caller without pairing, which a page should choose.
2. **Mirroring.** For each mirrored tool, `registerTool()` on the native object with the
   same name, title, description, `inputSchema` and the WebMCP annotations
   (`readOnlyHint`, `untrustedContentHint`, `consequentialHint`, `debugging`; the
   MCP-only hints are left out). Each mirror has its own `AbortController`, aborted
   whenever the tool leaves the registry, by the page's signal or by the registry itself
   (`compileRegistry()` removes tools the validator refuses). Before and after `connect()`
   alike.
3. **Native only, found the same way every time.** The native object is read through the
   `modelContext` getter of `Document.prototype` (captured when the library loads),
   called on `document`, and checked to be a `ModelContext`; an own property on
   `document` (a polyfill such as `@mcp-b/global`, or any page script) is not used. With
   native WebMCP and the polyfill both present, the tools go to the native object, under
   the polyfill. A page that changes `Document.prototype` before the library loads can
   still fool this; that page owns the tools anyway.
4. **Every failure stays with the mirror.** Any rejection of the native `registerTool()`
   (`InvalidStateError` for a name the page or a platform script holds, `NotAllowedError`
   in a frame without `allow="tools"`, anything else) is caught, warned once per tool in
   the console, and never touches the tab-mcp registration. A duplicate right after an
   abort (React's `useTool` aborts and registers again when its dependencies change; if
   Chrome unregisters asynchronously) is retried once. The reverse case is documented: a
   mirrored name is taken, so the page's own later native `registerTool()` of that name
   fails; a page that registers tools natively itself leaves `webmcp` off or uses other
   names.
5. **The same check, a weaker question.** A WebMCP call checks the arguments against
   `inputSchema` (Chrome does not) and, for a consequential tool, asks with the
   library's dialog or the page's `onConfirm`, saying the caller is an agent in this
   browser. "Always allow" is never offered or applied for WebMCP callers: they have no
   identity to remember it for. `toolcall` and `toolcallend` events fire.
6. **Who is calling.** `ToolExecuteOptions.client`, `ConfirmRequest.client` and the
   events become a union with a `kind`: `"relay"` (grant id, client id, host, name as
   today) or `"webmcp"` (nothing more is known). Pages that read `client.host` get a type
   error, not a silent `undefined`. To change with it: `ui.ts` (`clientLabel`,
   `confirmInPage` and its always-allowed list keyed by grant), the React bindings, the
   README's description of `client`, `examples/react-todo` (`call.client.name ??
   call.client.host`) and `test/e2e`. Decided in the protocol document.
7. **Results and errors.** A WebMCP caller gets what `execute` returned; an MCP result
   with `isError: true` becomes a rejection carrying its text; invalid arguments reject
   with a `TypeError`, a declined confirmation with a `NotAllowedError`, a tool that is
   gone with an `InvalidStateError`. `toolcallend` reports the same outcome.
8. **The extension's bridge.** The library lists the names it mirrored in
   `<html data-tab-mcp-webmcp="…">`; the bridge (iteration 20) leaves those names out,
   so an AI app connected to the page and to the extension does not get each tool twice
   (and a consequential call is not asked twice). Only the page can set the attribute,
   and it only hides its own tools.
9. **Size.** The core is 5.4 KB gzipped of its 6 KB budget (DEC-103): it keeps only the
   detection, the mirroring and a thin `execute` stub. The argument check, the
   confirmation and running the tool move out of `createMcpHandler` (`mcp.ts`) into one
   function in the lazy chunk that both callers use, so the two paths cannot drift; the
   first WebMCP call loads it and runs `compileRegistry()`, which may remove (and so
   unmirror) tools the validator refuses.

## Tasks

- [x] Detection, opt-in (`webmcp` on `TabMcp` and per tool), mirroring with its own
      abort, failure handling and the one retry
- [x] The shared check-confirm-run function in the lazy chunk; the WebMCP `execute` stub
- [x] The caller union; `ui.ts`, React bindings, README, react-todo example, e2e
- [x] The library sets the `data-tab-mcp-webmcp` attribute on `<html>` with the tools it
      mirrors
- [x] The extension reads the attribute (iteration 20): `src/content.ts` leaves out the
      tools it lists, so a tab-mcp page's tools do not reach the AI app twice; it takes
      effect once the library sets it (checked 2026-11-09, `docs/pre-release`)
- [x] Unit tests with a fake native object; a browser test with Chrome for Testing and
      `--enable-features=WebMCP` (pages served as in `test/webmcp-spike/`): `getTools()`
      lists the mirrored tools and not the consequential ones (unless named); a call
      runs; a bad argument and a declined call reject with their names; no "Always
      allow" for WebMCP callers; aborting and `compileRegistry()` unmirror; abort then
      register again; a native duplicate in either order; a frame without `allow="tools"`;
      the polyfill present over native; `webmcp` off registers nothing
- [ ] Threat model: in-browser agents as a new caller beside the AI apps (no pairing,
      can operate the page's dialog); CHANGELOG notes it as a change in what a page
      exposes when turned on; a client release on the owner's word
- [ ] Review; merged on the owner's word

## Out of scope

Reading the page's own WebMCP tools into tab-mcp (the other direction of ext-apps#829).

# Citations

- [MCP Apps: WebMCP interoperability, modelcontextprotocol/ext-apps#829](https://github.com/modelcontextprotocol/ext-apps/pull/829)
- [WebMCP draft (2 November 2026)](https://webmachinelearning.github.io/webmcp/)
