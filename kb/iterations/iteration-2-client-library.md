---
type: iteration
title: "Iteration 2: browser library"
description: "The tab-side library: a small eager core with WebMCP-style registerTool, and on connect() the lazily loaded connection and MCP handler, pairing UI and consequential-tool confirmation."
status: planned
tags:
  - iteration
  - client
timestamp: 2026-10-19T23:00:00+02:00
---

# Iteration 2: browser library

Goal: a page can register tools, connect with a click, pair an AI app with a code, and
serve tool calls through the relay from iteration 1, paying nothing until it connects.

Read first: [architecture](/design/architecture.md), [protocol](/design/protocol.md),
[WebMCP registerTool](/research/webmcp-register-tool.md),
[SDK research](/research/mcp-typescript-sdk-v2.md), DEC-010, 013, 020, 022, 023, 027, 028,
035.

## API sketch

```ts
import { TabMcp } from "@ractive-ch/tab-mcp-client"; // small core only

const mcp = new TabMcp({
  relay: "wss://relay.ractive.ch",
  server: { name: "Calculator", version: "1.0.0", instructions: "…" },
  onConfirm: (call) => Promise<boolean>,             // optional; default dialog
});
mcp.registerTool({ name, title, description, inputSchema, execute, annotations }, { signal });
button.onclick = async () => { const { address } = await mcp.connect(); … }; // loads the rest
mcp.startPairing(); mcp.stopPairing();                // the dialog's code stream
mcp.addEventListener("statechange" | "pairingcode" | "grantschange", …);
mcp.revoke(grantId); mcp.disconnect(); mcp.newAddress();
```

## Tasks

- [ ] Measure first (DEC-035): what makes up the SDK's ~82 KB gzipped for `createMcpHandler` + `McpServer` + `fromJsonSchema` (bundle metafile by package and module); record the result and the choice in the decision log: keep the SDK, or write the tab-side stateless subset (`server/discover`, `tools/list`, `tools/call`, `subscriptions/listen`, errors, header/body checks) and keep the SDK client only in tests
- [ ] Split: an eagerly loaded core (registry, events, pairing state, `localStorage` secret) and a lazily loaded part (connection, tunnel, MCP handler) behind a dynamic `import()` in `connect()`; report both sizes (core target ≤ 5 KB gzipped)
- [ ] Tool registry mirroring WebMCP: name rules (1–128 of `[A-Za-z0-9_.-]`), non-empty description, `inputSchema` default `{ "type": "object" }`, duplicate names rejected, `signal` abort unregisters, registration allowed before and after `connect()`
- [ ] MCP handler (SDK `createMcpHandler(factory, { legacy: "reject" })` or our subset, per the measurement): tools from the registry, argument validation against `inputSchema`, tools-changed notification on registry change, SSE for `tools/call` (DEC-020); if our subset, a conformance test with the SDK client
- [ ] Result and annotation mapping (DEC-022, DEC-023)
- [ ] Tunnel client: `http.request` → `Request` (+ `parsedBody`, `authInfo`, `AbortController`) → stream the `Response` back as `http.response` or `start`/`chunk`/`end`; `http.cancel` aborts
- [ ] `connect()` only with transient user activation (where supported), opens `wss://…/tab` with `tab-mcp.v1`, sends `hello` with the secret from `localStorage` (DEC-027; try/catch, a page-lifetime secret without storage), resolves with the address; `disconnect()` sends `bye`; `newAddress()` sends `grants.revokeAll`, makes a new secret and reconnects; no automatic reconnect
- [ ] Heartbeat: answer `ping`; treat two missed pings as dead
- [ ] Pairing (DEC-028): default "Connect your AI tool" `<dialog>` with the address, copy button, short instructions per AI app and "When asked, enter the code 123456"; `pairing.start` on open and `pairing.stop` on close, the code replaced as `pairing.code` messages arrive; connected apps from `session.grants`, `grant.added`/`grant.removed`, each with Disconnect (`grant.revoke`)
- [ ] Consequential tools: confirmation before `execute` via `onConfirm` or the default dialog (tool title, client, argument summary); refusal → `isError` result "The user declined"
- [ ] Default UI is small, unstyled-by-default (CSS custom properties), accessible (`<dialog>`, focus, Escape closes), and fully replaceable through the events and methods above
- [ ] Public types self-contained (no imports from private workspace packages); `isolatedDeclarations` clean
- [ ] Unit tests in Bun against a relay from iteration 1 (in-process); pairing messages against a scripted relay stub until iteration 3 implements them in the relay

## Acceptance criteria

- The library, run in Bun against an in-process relay, serves `tools/list` and `tools/call`
  to the SDK client; aborting a tool's signal produces `notifications/tools/list_changed`
  on a listen stream; a consequential tool runs only after `onConfirm` resolves true.
- Importing the library without calling `connect()` loads only the core.
- A browser smoke test (headless Chrome over CDP, DEC-025) loads a test page, connects to a
  local relay, and serves one call; Firefox checked by hand with `ff-rdp`.
- Sizes of the core and the lazily loaded part reported in the PR (lazy part ≤ 100 KB
  gzipped with the SDK, much less with our subset).
- `bun run verify` green.

## Test approach

`bun test` for registry, mapping, tunnel and lazy-loading logic; one CDP-driven browser test
for the real `WebSocket`, `Request`, dynamic import and `<dialog>`.

# Citations

- [WebMCP registerTool](/research/webmcp-register-tool.md)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
- [Decision log](/decision-log.md)
