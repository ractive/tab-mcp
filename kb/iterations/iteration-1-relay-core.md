---
type: iteration
title: "Iteration 1: protocol and relay core"
description: >-
  The relay's tab WebSocket, stable addresses, the token store, the HTTP tunnel
  with limits, timeouts and keep-alives, and the health endpoint, tested with a
  scripted tab and the MCP SDK client.
status: planned
tags:
  - iteration
  - relay
timestamp: 2026-10-19T23:00:00+02:00
---

# Iteration 1: protocol and relay core

Goal: an MCP client can call tools of a scripted (non-browser) tab through the relay.
OAuth and pairing come in [iteration 3](/iterations/iteration-3-oauth.md); here the relay
already requires a bearer token, and tests issue tokens by writing them into the token
store (no unauthenticated mode, ever — DEC-009).

Read first: [architecture](/design/architecture.md), [protocol](/design/protocol.md),
[decision log](/decision-log.md) DEC-013, 014, 020, 021, 027, 029, 030, 032–034, 036,
039–041, [Bun research](/research/bun-runtime-and-publishing.md).

## Tasks

- [ ] Protocol types in `packages/tab-mcp/src/protocol.ts` (message unions, close codes, limit defaults) with a hand-written runtime validator for incoming messages (no schema library)
- [ ] Config from environment (`TAB_MCP_*`, table in the architecture), validated at start with the defaults from DEC-034; refuse a non-https public URL outside development; empty origin list refuses all tabs, `*` only explicitly and with a warning (DEC-032)
- [ ] `TokenStore` interface (DEC-041) with `memory` and `sqlite` (`bun:sqlite`) implementations, a periodic `deleteExpired` sweep, and the conformance suite exported as `@ractive-ch/tab-mcp/testing`, run by both built-ins
- [ ] `createRelay({ store, … })` library API (exported from `@ractive-ch/tab-mcp`); `Bun.serve` with `development: false`, `maxRequestBodySize`, routes for `/tab`, `/a/:id/mcp`, `/healthz`, `/`
- [ ] `/tab` upgrade: origin allow-list, subprotocol `tab-mcp.v1` (426 otherwise), per-IP and global session limits, client IP per `TAB_MCP_TRUST_PROXY`
- [ ] Session lifecycle: `hello` with `secret` → address id `base32(sha256(secret))` (DEC-027) → `session`; hello timeout; replacement with `bye` `replaced` and close 4005; heartbeat `ping`/`pong` with close 4003; idle timeout 4002; lifetime 4001; `bye`
- [ ] MCP endpoint in the DEC-040 order: 405 for GET/DELETE, protocol-version pre-check (400 / `-32022`), body size (413), JSON single object (400), bearer token valid for this address (401 with `WWW-Authenticate: Bearer resource_metadata=…`), tab online (503 "the page is not open"), concurrency limit (429)
- [ ] CORS without credentials on the MCP endpoint (preflight, exposed headers), off with `TAB_MCP_CORS=off` (DEC-036)
- [ ] Claude header tolerance (DEC-033) with a log counter
- [ ] Tunnel: `http.request` with filtered headers and grant; `http.response` and `start`/`chunk`/`end` streaming to the AI app; `server.timeout(req, 0)`; request timer 300 s (504 + `http.cancel`); `req.signal` abort → `http.cancel`; listen streams exempt from the timer
- [ ] Keep-alives: SSE comments every 20 s at event boundaries (DEC-020), and the relay starts the event stream itself when the tab has not answered within 20 s (DEC-039)
- [ ] Backpressure: check every `ws.send`, fail the request with 503 on a dropped send (DEC-021)
- [ ] Session end: pending requests 503, streams closed; grants and tokens stay (DEC-029)
- [ ] Structured JSON logging without bodies, tool names, tokens, codes or secrets (threat model A9)
- [ ] `bin` entry `tab-mcp` (`bun packages/tab-mcp/src/main.ts`), `--help`, graceful shutdown on SIGTERM (close 4004)
- [ ] Add `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.3.1 as dev dependencies (pinned) for tests; a test helper that issues an access token for an address directly through the store

## Acceptance criteria

- With a scripted tab (Bun `WebSocket` + `createMcpHandler`, `legacy: "reject"`) and the SDK
  `Client` pinned to 2026-07-28 with a test token, against a real relay process:
  `server/discover`, `tools/list`, `tools/call` work end to end; a streamed tool response
  arrives in chunks.
- A legacy `initialize` gets 400 / `-32022` with `supported: ["2026-07-28"]`.
- Missing, unknown, expired or revoked token → 401; token of another address → 401; a
  valid token while the tab is offline → 503 "the page is not open".
- Disallowed origin → 403; no origins configured → 403; wrong subprotocol → 426; session
  limits enforced.
- A tool that answers after 30 s still works and the AI app sees keep-alives; a tool
  exceeding the request timeout gets 504 (or an error event on a started stream) and the
  tab receives `http.cancel`; a client abort sends `http.cancel`.
- Closing the tab socket ends the session and fails in-flight requests; the token works
  again after the same secret reconnects.
- The same secret gives the same address; a second session replaces the first.
- Both store implementations pass the conformance suite.
- `bun run verify` green; no log line contains a request body or a token (asserted in a
  test that captures logs).

## Test approach

`bun test` in `packages/tab-mcp/test/`: unit tests with an in-process relay on port 0 and
the memory store; one integration test that starts the relay as a separate process with a
SQLite store in a temporary file, issues a token by writing into the same file, and drives
it with a scripted tab and the SDK client. Timers are shortened through config. No browser.

# Citations

- [Protocol](/design/protocol.md)
- [Bun runtime research](/research/bun-runtime-and-publishing.md)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
- [Decision log](/decision-log.md)
