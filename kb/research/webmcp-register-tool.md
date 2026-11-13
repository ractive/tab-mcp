---
type: research
title: "WebMCP registerTool shape"
description: The WebMCP draft's tool registration API that the browser library mirrors.
tags:
  - webmcp
  - client
timestamp: 2026-11-13T18:00:00+01:00
---

# WebMCP registerTool shape

The WebMCP draft (W3C Web Machine Learning Community Group, Draft Community Group Report of
12 November 2026, not on the standards track; read again on 2026-11-13 for iteration 34)
exposes `document.modelContext` (earlier drafts and articles say `navigator.modelContext`):

```webidl
Promise<undefined> registerTool(ModelContextTool tool,
                                optional ModelContextRegisterToolOptions options = {});

dictionary ModelContextTool {
  required DOMString name;          // 1–128 of ASCII alphanumerics, "_", "-", "."
  USVString title;
  required DOMString description;   // must not be empty
  object inputSchema;               // JSON Schema
  object outputSchema;              // JSON Schema of the result (since the draft of 2026-11-12)
  required ToolExecuteCallback execute;
  ToolAnnotations annotations;
};
callback ToolExecuteCallback = Promise<any> (object inputObject,
                                             ToolExecuteCallbackOptions options);
dictionary ToolExecuteCallbackOptions { required AbortSignal signal; };
dictionary ToolAnnotations {
  boolean readOnlyHint = false;
  boolean untrustedContentHint = false;
  boolean consequentialHint = false;
  boolean debugging = false;
};
dictionary ModelContextRegisterToolOptions {
  sequence<USVString> exposedTo;    // origins of other documents in the tab's tree
  AbortSignal signal;               // aborting it unregisters the tool
};
```

`RegisteredTool` (what `getTools()` lists) has `name`, `title`, `description`,
`inputSchema`, `outputSchema`, `annotations`, `window` and `origin`. Chrome 156 gives no
`outputSchema` (the canary in `test/webmcp-spike/webmcp.test.ts`).

The steps of `registerTool`, as far as tab-mcp mirrors them:

- An already aborted signal rejects with the signal's abort reason (tab-mcp does the
  same since iteration 34).
- An invalid name, an empty description and a duplicate name reject with an
  `InvalidStateError`; a document not allowed the "tools" feature with a
  `NotAllowedError`. tab-mcp rejects the first two with a `TypeError` (README, Tools).
- `inputSchema` and `outputSchema` must be objects (any object); each is serialized to a
  JSON string, and a failure rejects. tab-mcp wants `"type": "object"` for both, as MCP
  does.
- Each `exposedTo` entry is parsed as a URL whose origin must be potentially
  trustworthy (else `SecurityError`); a caller sees the tool if it is same-origin with
  the tool's owner or with one of the listed origins.

Calls: the value `execute` fulfils with is serialized with "serialize a JavaScript value
to a JSON string" and the caller's `executeTool()` resolves with that string; a value
that cannot be serialized (such as `undefined`) fails the call with an `OperationError`
("unserializable result"), as does a rejection ("tool rejected"), without its message.
Chrome 156 passes a string result on as it is, not JSON-encoded, and hands a rejection on
as `UnknownError` (DEC-120).

Notes for tab-mcp:

- There is no `unregisterTool`; aborting the registration signal removes the tool.
  Unregistering does not cancel a running execution; the per-call `signal` does that.
- `execute` returns any value; through the relay tab-mcp maps it (string → one text
  block, object → JSON text plus `structuredContent`; an MCP `CallToolResult` passes
  through, DEC-134). Through WebMCP an MCP result goes out as its `structuredContent` or
  its text, and `undefined` as `"Done."` (DEC-143).
- WebMCP annotations differ from MCP's (`destructiveHint`, `idempotentHint`,
  `openWorldHint` exist only in MCP; `consequentialHint`, `untrustedContentHint` only in
  WebMCP). The library accepts the union and maps them (see the protocol document); the
  mirror treats `destructiveHint: true` as `consequentialHint: true` (DEC-143).
- `exposedTo` has no meaning for AI apps; the library passes it on to the native
  registration of a mirrored tool (DEC-143).

# Citations

- [WebMCP draft specification](https://webmachinelearning.github.io/webmcp/)
- [The draft's source, `index.bs`](https://github.com/webmachinelearning/webmcp/blob/main/index.bs)
