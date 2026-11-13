---
type: iteration
title: "Iteration 34: WebMCP, the draft of 2026-11-12"
status: completed
description: >-
  Iteration F of the review of 2026-11-13: the client library and tab-mcp for Chrome
  follow the WebMCP draft of 12 November 2026. outputSchema in the library's Tool and
  through the bridge, exposedTo passed on (owner), an aborted signal rejects, WebMCP
  results mapped (undefined, MCP results), destructiveHint counts as consequential for
  the mirror, the mirror's retry and the load-time capture of the getter gone (owner),
  JSON strings, objects, patterns and debugging tools through the bridge, and the docs
  and research notes brought up to the draft.
timestamp: 2026-11-13T18:00:00+01:00
tags: [iteration, client, extension, webmcp, review]
---
# Iteration 34: WebMCP, the draft of 2026-11-12

Iteration F of the [review of 2026-11-13](../research/review-2026-11-13.md): findings WM 3,
4, 5, 6, 7, 8, 11 and 14, and WM 9 and WM 10, which the owner agreed to. Branch
`iteration/34-webmcp-draft`. Decisions DEC-143 (client) and DEC-144 (tab-mcp for Chrome).
Built on iterations C (PR 118: `isCallToolResult`, `resultText`), D (PR 119) and G
(PR 120: WM 1, WM 2). The draft was read again (`index.bs` on main) for `outputSchema`,
`exposedTo`, the abort and error steps and the serialization of results; the research
note [WebMCP registerTool shape](../research/webmcp-register-tool.md) has what it says.

The `<html data-tab-mcp-webmcp>` attribute stays: iteration I removes the examples'
status line that reads it and may then remove it.

## Core budget

The client core was 6397 B gzipped of 6400 B (`test/build.test.ts`). WM 9 and WM 10 alone
take it to 6313 B (84 B freed); with the rest of this iteration (`outputSchema`'s check,
`exposedTo`, `destructiveHint` in the mirror, the abort reason) it is 6386 B. The result
mapping for WebMCP (WM 4, WM 6) is in the lazy chunk (`webMcpValue` in `mapping.ts`).

## Tasks

### WM 3: `outputSchema`

- [x] `Tool.outputSchema` (optional, an object schema with `"type": "object"`, copied as
  JSON; anything else a `TypeError`); kept on `RegisteredTool`
- [x] `tools/list` carries it; the mirror passes it to the native `registerTool`
- [x] `useTool` registers again when it changes
- [x] tab-mcp for Chrome: `PageTool.outputSchema` (at most 16 KB), shown in
  `webmcp_tools` (patterns noted, within the listing's budget), not declared on
  `page_<name>` (DEC-144)
- [x] Research note's IDL and the canary's comment
- [x] Tests: registry, `tools/list`, mirror, content script, bridge, listing, browser test

### WM 4: a mirrored tool that returns `undefined`

- [x] Resolves as `"Done."` (not `null`: tab-mcp for Chrome reads `null` from
  `executeTool()` as "the tool navigated"); through the relay still `{ content: [] }`
- [x] Tests: unit and browser (a void tool)

### WM 5: `destructiveHint`

- [x] The mirror leaves out a tool with `consequentialHint ?? destructiveHint` true unless
  `{ webmcp: true }`, and registers it natively with that value as `consequentialHint`
- [x] README, `TabMcpOptions.webmcp`, `RegisterToolOptions.webmcp`, threat model A14, root
  README
- [x] Tests: unit and browser

### WM 6: MCP results through WebMCP

- [x] An MCP result (`isCallToolResult`) goes out as its `structuredContent`, else as its
  text (`resultText` with `noted`: each other block a line naming its type), an empty
  one as `"Done."`; domain data with a `content` array as it is
- [x] Tests: unit and browser (an image block is not passed as base64)
- Not done: registering ractive.ch's `get_image` with `{ webmcp: false }`. Its image no
  longer goes out as base64, and ractive.ch is not in this repository.

### WM 7: a JSON-encoded string from `executeTool()`

- [x] `resultOf` decodes a result that is the JSON of a string
- [x] Recorded in `kb/research/webmcp-from-extension.md`
- [x] Test

### WM 8: what a page tool loses through the bridge

- [x] Tools marked `debugging` are listed with their problem, not offered, not callable
- [x] A stripped `pattern` is added to the schema's description (cut to 200 characters)
- [x] The JSON of a plain object without a `content` key, within 100,000 characters,
  goes to the library as that object, so the AI app gets `structuredContent`
- [x] `PageTool` no longer carries `consequentialHint` and `untrustedContentHint`; it
  carries `debugging`
- [x] Names over 59 characters: documented already, unchanged
- [x] README, CHANGELOG, tests

### WM 9: the mirror's retry (owner)

- [x] Deleted; a failed native registration warns at once
- [x] Tests: the retry tests replaced by "a browser that unregisters late loses that
  mirror" and "a genuine duplicate is tried once"; the README says what a late
  unregistration costs

### WM 10: reading the getter (owner)

- [x] `nativeContext()` reads
  `Object.getOwnPropertyDescriptor(Document.prototype, "modelContext")?.get?.call(document)`
  when a `TabMcp` is made; `capture()`, `Native`, the `instanceof ModelContext` check
  and the tests' re-capture are gone. DEC-115 holds: an own `document.modelContext` is
  still passed by
- [x] Tests: no document; WebMCP that appears after the library loaded
- [x] Threat model A14

### WM 11: deviations from the draft

- [x] `exposedTo` passed on to the native registration (owner)
- [x] An already aborted signal rejects with its reason, as the draft (it resolved)
- [x] Documented in the README's Tools section: `TypeError` for an invalid name or
  description (the draft: `InvalidStateError`), `"type": "object"` for both schemas, the
  argument check, MCP results, `exposedTo` only for WebMCP
- [x] Tests

### WM 14: stale statements

- [x] `kb/research/webmcp-register-tool.md`: the draft of 2026-11-12, its IDL with
  `outputSchema`, the steps tab-mcp mirrors
- [x] Iteration 25: `status: completed`, tasks ticked, an outcome
- [x] Extension README: the top frame's WebMCP lists same-origin frames' tools too
- [x] Client README: `debugging` in the annotations list
- [x] Client README and `webMcpCall`: the draft's message-less `OperationError` makes
  `{ error }` the lasting convention, not a workaround for Chrome 156
- [x] Both READMEs: the origin trial runs from Chrome 149 to 162
