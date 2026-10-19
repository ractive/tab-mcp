---
type: iteration
title: "Iteration 4: calculator example and end-to-end tests"
description: The four-function calculator page as the minimal example, an automated browser end-to-end test, a headless Claude Code run, and the first compatibility matrix.
status: planned
tags:
  - iteration
  - example
  - e2e
timestamp: 2026-10-19T23:00:00+02:00
---

# Iteration 4: calculator example and end-to-end tests

Goal: the whole chain works with a real page in a real browser and a real AI app.

Read first: [architecture](/design/architecture.md),
[AI app support](/research/ai-app-support.md) (driving Claude Code), DEC-025, 028, 032,
033, 037.

## Tasks

- [ ] `examples/calculator`: plain HTML + TypeScript, four functions, display, memory (M+, MR, MC), a "Connect your AI tool" button opening the library's pairing dialog, connected apps list with Disconnect
- [ ] Tools: `press_keys` (sequence of keys, returns the display), `read_display` (read-only), `clear` (C), `clear_memory` (consequential: asks in the page)
- [ ] Dev script `bun run example` starting a local relay (development mode, origin `http://localhost:…` allowed, memory store) and serving the page with an HTML import route; README shows the same with `docker run ractive/tab-mcp` (the example never uses the hosted relay, DEC-032)
- [ ] E2E test: relay + page in headless Chrome (CDP helper) + SDK client doing the full OAuth flow; the test clicks Connect in the page via CDP, reads the pairing code from the dialog and types it on the `/authorize` page; checks `press_keys` "12+30=" → 42 and that `clear_memory` waits for the page confirmation
- [ ] Headless Claude Code check (local-only script, never in CI: it needs a Claude login, DEC-037): obtain a token through the e2e helper, then `claude -p --mcp-config cfg.json --strict-mcp-config --allowedTools "mcp__calc__*" "Use the calculator to compute 12*12"` with `"headers": {"Authorization": "Bearer ${TABMCP_TOKEN}"}`; assert the page shows 144
- [ ] Negative check: `MCP_PROTOCOL_NEGOTIATION=legacy` Claude Code gets the documented 400 error
- [ ] Manual checks over a tunnel to a public HTTPS relay (or the iteration-6 instance if earlier): claude.ai custom connector, Claude Desktop, Claude Code `claude mcp add --transport http` with interactive CIMD sign-in, ChatGPT developer mode; record results in `docs/compatibility.md` (app, version, date, revision, auth, result), including the knowingly unsupported clients (VS Code/Copilot, Cursor, Gemini CLI, default Codex) and why (DEC-033)
- [ ] Upstream issue for the SDK's Firefox `Request.body` bug if still present

## Acceptance criteria

- `bun test` e2e (gated by an environment variable for the browser binary) passes locally
  and in CI.
- The headless Claude Code script prints the result and the page shows it.
- `docs/compatibility.md` lists at least Claude Code and the SDK client as tested, and the
  manual results for claude.ai and ChatGPT (or why they are pending).

## Test approach

CDP-driven headless Chrome in CI (installed by the workflow), Firefox via `ff-rdp` by hand;
Claude Code run locally only (needs an account).

# Citations

- [AI app support research](/research/ai-app-support.md)
- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
