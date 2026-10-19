---
type: iteration
title: "Iteration 2: browser library"
description: The tab-side library with WebMCP-style registerTool, the MCP SDK handler over the tunnel, connect/disconnect, consent hooks and consequential-tool confirmation.
status: planned
tags:
  - iteration
  - client
timestamp: 2026-10-19T20:00:00+02:00
---

# Iteration 2: browser library

Goal: a page can register tools, connect with a click, show its address and serve tool
calls through the relay from iteration 1.

Read first: [architecture](/design/architecture.md), [protocol](/design/protocol.md),
[WebMCP registerTool](/research/webmcp-register-tool.md),
[SDK research](/research/mcp-typescript-sdk-v2.md), DEC-010, 013, 017, 020, 022, 023.

## API sketch

```ts
import { TabMcp } from "@ractive-ch/tab-mcp-client";

const mcp = new TabMcp({
  relay: "wss://relay.ractive.ch",
  server: { name: "Calculator", version: "1.0.0", instructions: "…" },
  onAuthorizationRequest: (req) => Promise<boolean>, // optional; default dialog
  onConfirm: (call) => Promise<boolean>,             // optional; default dialog
});
mcp.registerTool({ name, title, description, inputSchema, execute, annotations }, { signal });
button.onclick = async () => { const { address } = await mcp.connect(); … };
mcp.addEventListener("statechange" | "grantschange" | "authrequest", …);
mcp.revoke(grantId); mcp.disconnect(); mcp.newAddress();
```

## Tasks

- [ ] Tool registry mirroring WebMCP: name rules (1–128 of `[A-Za-z0-9_.-]`), non-empty description, `inputSchema` default `{ "type": "object" }`, duplicate names rejected, `signal` abort unregisters, registration allowed before and after `connect()`
- [ ] MCP handler: `createMcpHandler(factory, { legacy: "reject" })`; the factory builds an `McpServer` from the registry with cached `fromJsonSchema` objects; `handler.notify.toolsChanged()` on registry change; `responseMode: "sse"` for `tools/call` (DEC-020)
- [ ] Result and annotation mapping (DEC-022, DEC-023)
- [ ] Tunnel client: `http.request` → `Request` (+ `parsedBody`, `authInfo`, `AbortController`) → stream the `Response` back as `http.response` or `start`/`chunk`/`end`; `http.cancel` aborts
- [ ] `connect()` only with transient user activation (where supported), opens `wss://…/tab` with `tab-mcp.v1`, sends `hello` with `addressKey` from `localStorage` (try/catch; works without storage), resolves with the address; `disconnect()` sends `bye`; `newAddress()` rotates the key; no automatic reconnect
- [ ] Heartbeat: answer `ping`; treat two missed pings as dead
- [ ] Consent: `auth.request` → `onAuthorizationRequest` or the default `<dialog>` showing declared name, verified hosts, page title and the code, with a warning when more than one request is pending; `auth.cancelled` closes it; `grant.added`/`grant.removed` keep a list of connected apps
- [ ] Consequential tools: confirmation before `execute` via `onConfirm` or the default dialog (tool title, client, argument summary); refusal → `isError` result "The user declined"
- [ ] Default UI is small, unstyled-by-default (CSS custom properties), accessible (`<dialog>`, focus, Escape = deny), and fully replaceable
- [ ] Public types self-contained (no imports from private workspace packages); `isolatedDeclarations` clean
- [ ] Unit tests in Bun against a relay from iteration 1 (in-process)

## Acceptance criteria

- The library, run in Bun against an in-process relay, serves `tools/list` and `tools/call`
  to the SDK client; aborting a tool's signal produces `notifications/tools/list_changed`
  on a listen stream; a consequential tool runs only after `onConfirm` resolves true.
- A browser smoke test (headless Chrome over CDP, DEC-025) loads a test page, connects to a
  local relay, and serves one call; Firefox checked by hand with `ff-rdp`.
- Bundle size of the npm build plus SDK reported in the PR (target ≤ 100 KB gzipped).
- `bun run verify` green.

## Test approach

`bun test` for registry, mapping and tunnel logic; one CDP-driven browser test for the real
`WebSocket`, `Request` and `<dialog>`.

# Citations

- [WebMCP registerTool](/research/webmcp-register-tool.md)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
