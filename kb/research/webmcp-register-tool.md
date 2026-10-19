---
type: research
title: "WebMCP registerTool shape"
description: The WebMCP draft's tool registration API that the browser library mirrors.
tags:
  - webmcp
  - client
timestamp: 2026-10-19T20:00:00+02:00
---

# WebMCP registerTool shape

The WebMCP draft (W3C Web Machine Learning Community Group, Draft Community Group Report of
2026-10-16, not on the standards track) exposes `document.modelContext` (earlier drafts and
articles say `navigator.modelContext`):

```webidl
Promise<undefined> registerTool(ModelContextTool tool,
                                optional ModelContextRegisterToolOptions options = {});

dictionary ModelContextTool {
  required DOMString name;          // 1–128 of ASCII alphanumerics, "_", "-", "."
  USVString title;
  required DOMString description;   // must not be empty
  object inputSchema;               // JSON Schema
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
  sequence<USVString> exposedTo;
  AbortSignal signal;               // aborting it unregisters the tool
};
```

Notes for tab-mcp:

- There is no `unregisterTool`; aborting the registration signal removes the tool.
  Unregistering does not cancel a running execution; the per-call `signal` does that.
- `execute` returns any value; the user agent turns it into the agent's result. tab-mcp
  must define that mapping (string → one text block, object → JSON text plus
  `structuredContent`; an MCP `CallToolResult`-shaped object passes through).
- WebMCP annotations differ from MCP's (`destructiveHint`, `idempotentHint`,
  `openWorldHint` exist only in MCP; `consequentialHint`, `untrustedContentHint` only in
  WebMCP). The library accepts the union and maps them (see the protocol document).
- `exposedTo` (cross-document exposure) has no meaning for tab-mcp and is ignored.

# Citations

- [WebMCP draft specification](https://webmachinelearning.github.io/webmcp/)
