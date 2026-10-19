---
type: iteration
title: "Iteration 1: protocol and relay core"
description: The relay's tab WebSocket, addresses, the HTTP tunnel with limits and timeouts, and the health endpoint, tested with a scripted tab and the MCP SDK client.
status: planned
tags:
  - iteration
  - relay
timestamp: 2026-10-19T20:00:00+02:00
---

# Iteration 1: protocol and relay core

Goal: an MCP client can call tools of a scripted (non-browser) tab through the relay.
OAuth comes in [iteration 3](/iterations/iteration-3-oauth.md); here the relay already
requires a bearer token, and tests create grants through the relay's in-process grant
store (no unauthenticated mode, ever — DEC-009).

Read first: [architecture](/design/architecture.md), [protocol](/design/protocol.md),
[decision log](/decision-log.md) DEC-013, 014, 017–021,
[Bun research](/research/bun-runtime-and-publishing.md).

## Tasks

- [ ] Protocol types in `packages/tab-mcp/src/protocol.ts` (message unions, close codes, limit defaults) with a runtime validator for incoming messages (hand-written, no schema library)
- [ ] Config from environment (`TAB_MCP_*`), validated at start, with the defaults from the architecture document; refuse non-https public URL outside development
- [ ] `Bun.serve` with `development: false`, `maxRequestBodySize`, routes for `/tab`, `/a/:id/mcp`, `/healthz`, `/`
- [ ] `/tab` upgrade: origin allow-list, subprotocol `tab-mcp.v1` (426 otherwise), per-IP and global session limits, client IP per `TAB_MCP_TRUST_PROXY`
- [ ] Session lifecycle: `hello` → address id from `addressKey` (or random) → `session`; replacement with close 4005; heartbeat `ping`/`pong` with close 4003; idle timeout 4002; lifetime 4001; `bye`
- [ ] Grant and token store (in memory, token hashes only, bound to address + session), with a test-only in-process API to add grants
- [ ] MCP endpoint: 405 for non-POST, 404 for unknown address or tab not connected, protocol-version pre-check (400 / `-32022`), bearer check (401 with `WWW-Authenticate` placeholder until iteration 3), body size, JSON, single object, concurrency limit (429)
- [ ] Claude header tolerance (DEC-019) with a log counter
- [ ] Tunnel: `http.request` with filtered headers and grant; `http.response` and `start`/`chunk`/`end` streaming to the AI app; `server.timeout(req, 0)`; request timer (504 + `http.cancel`); `req.signal` abort → `http.cancel`; listen streams exempt from the timer
- [ ] SSE keep-alive comments every 20 s at event boundaries (DEC-020)
- [ ] Backpressure: check every `ws.send`, fail the request with 503 on a dropped send (DEC-021)
- [ ] Session end: pending requests 503, streams closed, grants and tokens deleted
- [ ] Structured JSON logging without bodies, tool names, tokens or keys (threat model A9)
- [ ] `bin` entry `tab-mcp` (`bun packages/tab-mcp/src/main.ts`), `--help`, graceful shutdown on SIGTERM (close 4004)
- [ ] Add `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.3.1 as dev dependencies (pinned) for tests

## Acceptance criteria

- With a scripted tab (Bun `WebSocket` + `createMcpHandler`, `legacy: "reject"`) and the SDK
  `Client` pinned to 2026-07-28 with a test grant's token: `server/discover`, `tools/list`,
  `tools/call` work end to end; a streamed tool response arrives in chunks.
- A legacy `initialize` gets 400 / `-32022` with `supported: ["2026-07-28"]`.
- Missing/foreign token → 401; token of another address → 401; unknown address → 404.
- Disallowed origin → 403; wrong subprotocol → 426; session limits enforced.
- A tool that answers after 30 s still works (idle timer handled); a tool exceeding the
  request timeout gets 504 and the tab receives `http.cancel`; a client abort sends
  `http.cancel`.
- Closing the tab socket ends the session, fails in-flight requests and invalidates tokens.
- The same `addressKey` gives the same address; a second session replaces the first.
- `bun run verify` green; no log line contains a request body (asserted in a test that
  captures logs).

## Test approach

`bun test` in `packages/tab-mcp/test/` starting the relay on port 0 per test file,
a scripted tab helper and the SDK client. Timers are shortened through config. No browser.

# Citations

- [Protocol](/design/protocol.md)
- [Bun runtime research](/research/bun-runtime-and-publishing.md)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
