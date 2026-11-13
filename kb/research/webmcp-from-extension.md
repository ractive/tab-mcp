---
type: research
title: "WebMCP from a Chrome extension (Chrome 156)"
description: "Iteration 18's spike: a content script reaches a page's WebMCP tools on the native document.modelContext (list, call, toolchange), also when the page turns WebMCP on with an origin trial token; it can register tools the page sees; how to turn WebMCP on, frames, forgery, edges and the @mcp-b/global polyfill."
timestamp: 2026-11-08T22:00:00+01:00
tags: [webmcp, extension, chrome, spike, research]
---
# WebMCP from a Chrome extension (Chrome 156)

Iteration 18 asked whether an extension can reach a page's WebMCP tools, and from which
world. It can, from its content script, with nothing in the page's world. Everything
below was observed in Chrome for Testing 156.0.8078.80 (the version CI pins) with
`test/webmcp-spike/` (`bun test/webmcp-spike/spike.ts` prints the full report as JSON);
`test/webmcp-spike/webmcp.test.ts` keeps the main findings as a canary.

## 1. Turning it on

| How | `document.modelContext` |
|---|---|
| nothing (Chrome 156 stable and Chrome for Testing) | `undefined` |
| `--enable-features=WebMCP` (also `WebMCPTesting`, or `--enable-blink-features=WebMCP`) | present |
| `chrome://flags/#enable-webmcp-testing` set to Enabled (`Local State`: `enable-webmcp-testing@1`) | present |
| the same entry without `@1` | `undefined` |
| the page sends an origin trial token for feature `WebMCP` | present, in both worlds |
| a token for `WebMCPTesting` | `undefined` (not a trial name) |

- Branded Chrome 156 stable behaves the same (checked for the page API with the flag;
  it ignores `--load-extension`, so the extension part was run in Chrome for Testing).
- Headless (`--headless=new`) has it: CI can test it. `--enable-features=WebMCP` is the
  switch the spike and the canary use.
- The origin trial was tried with a token signed by the spike's own Ed25519 key and
  `--origin-trial-public-key=<key>`, as Chromium's own tests do (token format 3: version,
  signature, payload length, JSON payload with `origin`, `feature`, `expiry`). So
  in stable Chrome a page's tools exist when the page is in the trial or the user turned
  the flag on; the extension cannot turn WebMCP on for a page.
- The pages were served through the DevTools Protocol (`Fetch.fulfillRequest`) on
  `https://spike.test` and `https://other.test`: secure origins without a server or
  certificates. (In a sandbox where Chrome's network service cannot reach a local server
  this is the only way that works; `file://` pages work too but have no real origin.)

## 2. From a content script (isolated world)

- `document.modelContext` is the native `ModelContext` (`getTools`, `executeTool`,
  `registerTool`, `ontoolchange`, `ontoolactivated`, `ontoolcancel`). No `unregisterTool`:
  aborting the registration signal unregisters.
- `getTools()` returns plain objects, sorted by name, with exactly `name`, `title`,
  `description`, `inputSchema`, `annotations` (all four: `readOnlyHint`,
  `consequentialHint`, `untrustedContentHint`, `debugging`; missing when the page gave
  none), `origin` and `window`. **No `outputSchema`**: Chrome 156 drops it at
  registration (DevTools' `WebMCP.toolsAdded` has none either).
- `executeTool(tool, input, { signal })` runs the page's `execute` (in the page's world,
  with a signal) and resolves to a **string**: a string result as it is, anything else
  JSON-encoded (`{ ordered: "tea" }` → `'{"ordered":"tea","quantity":1}'`). This
  differs from the draft (12 November 2026), which JSON-encodes every result, a string
  too (`"Hello"` → `'"Hello"'`). Since iteration 34 the bridge decodes a result that is
  a JSON string (`resultOf`, WM 7), so either way reaches the AI app as the text; a
  string result that is itself the JSON of a string loses its quotes in Chrome 156.
- Chrome does **not** check the input against `inputSchema`: `{ name: 42 }` for a
  `string` property reached the page.
- `toolchange` fires in the isolated world (one event per registration; a tool registered
  a second later gave one more).

## 3. From the page's own world

- What any main-world script sees: the same native object and tools, as long as the
  page has not replaced it.
- `chrome.scripting.executeScript({ world: "MAIN", func })` works; `func`'s promise
  result comes back to the service worker through the extension API, which the page
  cannot answer in its place (it can still change what the script finds in its world).
- A content script declared with `"world": "MAIN"` answers the isolated world over
  `CustomEvent`s; the page sees those events and can answer them too.
- Two Chrome details met on the way: a file listed in both a normal and a `"MAIN"`
  `content_scripts` entry ran only in the isolated world; and a main-world content
  script's top-level declarations are not globals of the page.

## 4. Registering from the extension

- `registerTool()` works from the content script and from `executeScript` in the main
  world. The tool is in the page's `getTools()` (from every world) and in DevTools'
  `WebMCP.toolsAdded`, whose stack trace names `chrome-extension://<id>/…` for the
  content script's tool.
- Its `execute` runs where it was registered: the content script's tool runs in the
  isolated world, with `chrome.*` at hand.
- **The page can call it**: the page's own `executeTool()` ran the content script's tool
  with input the page chose. Any agent that sees the page's tools sees it too. The
  browser's own agent was not tested; DevTools (which reads the same per-document list
  through its `WebMCP` domain) sees it.
- Names are one list per document: whoever registers a name first keeps it. The
  extension registering a name the page holds, and the page registering a name the
  extension holds, both fail with `InvalidStateError: Duplicate tool name`.
- A `getTools()` entry does not say who registered it; the extension has to remember the
  names it registered to tell its own tools from the page's.

## 5. Edges

| Case | What happened |
|---|---|
| Tool unregistered during a call | The call finished ("slow done" after 2 s); the tool was gone from `getTools()` afterwards |
| `execute` never answers | Still pending after 30 s: no timeout of Chrome's own that short; the caller needs its own |
| Caller aborts its signal | `executeTool` rejects with `AbortError` at once; the page's `execute` sees its signal abort just after |
| No WebMCP | `document.modelContext` is `undefined` in both worlds |
| Page replaces `document.modelContext` (own property on `document`) | Only main-world code is fooled (`executeScript` MAIN included). The isolated world still has the native object, which lists only what was registered on it; a main-world script that kept the native object at `document_start` still has it |
| Cross-origin frame without `allow="tools"` | Its `registerTool()` and `getTools()` throw `NotAllowedError` (permissions policy `tools`), also in its content script |
| Cross-origin frame with `allow="tools"` | Its tools are in its own `getTools()` (the content script there can call them), not in the top page's, not even with `fromOrigins` |
| … and `exposedTo: [top origin]` | The top page lists and calls it with `getTools({ fromOrigins: [frame origin] })` |

## 6. The `@mcp-b/global` polyfill (6.0.3)

It puts its own object (minified class `Gg`) on `document.modelContext` in the page's
world.

- **With WebMCP on** it wraps the native object and registers there: the content script
  lists and calls the page's tools as with native WebMCP.
- Its tools return MCP results (`{ content: [{ type: "text", text }] }`), so
  `executeTool()` gives the JSON encoding of one:
  `'{"content":[{"type":"text","text":"from the polyfill page"}]}'`.
- **Without WebMCP** its tools exist only in the page's world: the content script sees no
  `document.modelContext`; `executeScript` in the main world lists and calls them, on an
  object the page controls.

## What it means for the extension

- The bridge can use the content script alone: no main-world script and no message
  channel through the page, so a page cannot forge the object or the answers.
- It has to bring what Chrome leaves out: a timeout and abort for calls, input
  validation against `inputSchema`, and a result mapping from a string (a string that is
  the JSON of an MCP result, as polyfill pages give, is one to unwrap; since iteration 34
  the JSON of another object reaches the AI app as `structuredContent` too, which MCP
  allows without an `outputSchema`).
- Frames: tools of cross-origin frames are reachable from a content script in that frame
  (`all_frames`) when the page allows `tools` there; the top page's list does not have
  them.
- Pages that use only the polyfill, without native WebMCP, are out of reach without
  trusting the page's world.
- Recipes registered through WebMCP would run in the content script but could be called
  by the page itself (and every in-browser agent) with inputs of its choosing, and the
  page would see their names, descriptions and inputs; the extension would also have to
  leave its own tools out of what it bridges.

# Citations

- [WebMCP draft, W3C Web Machine Learning Community Group (2 November 2026)](https://webmachinelearning.github.io/webmcp/)
- [Chrome: WebMCP origin trial (9 June 2026)](https://developer.chrome.com/blog/ai-webmcp-origin-trial)
- [Chrome: WebMCP docs](https://developer.chrome.com/docs/ai/webmcp) and [imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api) ("Chrome Extensions can query and execute WebMCP tools with content scripts")
- [Chrome extensions: content script worlds](https://developer.chrome.com/docs/extensions/reference/api/scripting#type-ExecutionWorld)
- [@mcp-b/global 6.0.3 on npm](https://www.npmjs.com/package/@mcp-b/global)
