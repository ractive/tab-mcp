---
type: iteration
title: "Iteration 4: calculator example and end-to-end tests"
description: The four-function calculator page as the minimal example, an automated browser end-to-end test, a headless Claude Code run, and the first compatibility matrix.
status: completed
tags:
  - iteration
  - example
  - e2e
timestamp: 2026-10-20T02:10:00+02:00
---

# Iteration 4: calculator example and end-to-end tests

Goal: the whole chain works with a real page in a real browser and a real AI app.

Read first: [architecture](/design/architecture.md),
[AI app support](/research/ai-app-support.md) (driving Claude Code), DEC-025, 028, 032,
033, 037.

## Tasks

- [x] `examples/calculator`: plain HTML + TypeScript, four functions, display, memory (M+, MR, MC), a "Connect your AI tool" button opening the library's pairing dialog, connected apps list with Disconnect
- [x] Tools: `press_keys` (sequence of keys, returns the display), `read_display` (read-only), `clear` (C), `clear_memory` (consequential: asks in the page)
- [x] Dev script `bun run example` starting a local relay (development mode, origin `http://localhost:…` allowed, memory store) and serving the page with an HTML import route; README shows the same with `docker run ractive/tab-mcp` (the example never uses the hosted relay, DEC-032)
- [x] E2E test: relay + page in headless Chrome (CDP helper) + SDK client doing the full OAuth flow; the test clicks Connect in the page via CDP, reads the pairing code from the dialog and types it on the `/authorize` page; checks `press_keys` "12+30=" → 42 and that `clear_memory` waits for the page confirmation
- [x] Headless Claude Code check (local-only script, never in CI: it needs a Claude login, DEC-037): obtain a token through the e2e helper, then `claude -p --mcp-config cfg.json --strict-mcp-config --allowedTools "mcp__calc__*" "Use the calculator to compute 12*12"` with `"headers": {"Authorization": "Bearer ${TABMCP_TOKEN}"}`; assert the page shows 144
- [x] Negative check: `MCP_PROTOCOL_NEGOTIATION=legacy` Claude Code gets the documented 400 error
- [-] Manual checks over a tunnel to a public HTTPS relay (or the iteration-6 instance if earlier): claude.ai custom connector, Claude Desktop, Claude Code `claude mcp add --transport http` with interactive CIMD sign-in, ChatGPT developer mode; record results in `docs/compatibility.md` (app, version, date, revision, auth, result), including the knowingly unsupported clients (VS Code/Copilot, Cursor, Gemini CLI, default Codex) and why (DEC-033). **Deferred:** `docs/compatibility.md` is written with the tested and unsupported clients; the four manual checks are pending (claude.ai, Desktop and ChatGPT moved to iteration 6, interactive Claude Code by hand), see Results
- [-] Upstream issue for the SDK's Firefox `Request.body` bug if still present. **Deferred to the owner:** still present in 2.3.1; the issue is drafted under Results, not filed

## Acceptance criteria

- `bun test` e2e (gated by an environment variable for the browser binary) passes locally
  and in CI.
- The headless Claude Code script prints the result and the page shows it.
- `docs/compatibility.md` lists at least Claude Code and the SDK client as tested, and the
  manual results for claude.ai and ChatGPT (or why they are pending).

## Test approach

CDP-driven headless Chrome in CI (installed by the workflow), Firefox via `ff-rdp` by hand;
Claude Code run locally only (needs an account).

## Results

- Code: `examples/calculator/` (`src/` page and `calculator.ts` logic, `server.ts` HTML
  import route plus `/config.json`, `dev.ts` for `bun run example`, `README.md` with the
  Docker variant), tests in `examples/calculator/test/` (`stack.ts` helper, `e2e.test.ts`,
  `calculator.test.ts`, `claude-code.ts`). CI installs Chrome with
  `browser-actions/setup-chrome` and passes `CHROME_PATH`; without Chrome the browser
  tests fail in CI and are skipped elsewhere.
- The external relay variant (`TAB_MCP_RELAY=…`) was smoke-tested against
  `bun packages/tab-mcp/src/main.ts` with the same settings as the README's
  `docker run`. The `ractive/tab-mcp` image is not on Docker Hub yet (iteration 5); the
  README says so.
- Headless Claude Code (`bun run e2e:claude`, Claude Code 2.1.296, 2026-10-20): "Use the
  calculator to compute 12*12" pressed the keys, the page showed 144, and the answer said
  144. With `MCP_PROTOCOL_NEGOTIATION=legacy` the relay answered `initialize` with 400 /
  `-32022` "Unsupported protocol version: 2025-11-25", `supported: ["2026-07-28"]` (seen
  through a recording proxy in the script, because Claude Code logs only the status).
  Claude Code then reported the server as failed, and no key was pressed.
- `docs/compatibility.md`: the SDK client and Claude Code (headless, legacy refusal) as
  tested, the pending manual checks with reasons, and the unsupported clients (DEC-033).
- **Deferred: the manual checks.** claude.ai, Claude Desktop and ChatGPT connect from
  their vendors' servers and need a public HTTPS relay. No tunnel was opened, so they move
  to the iteration-6 deployment. The interactive Claude Code CIMD sign-in works against a
  local relay but needs a person at the keyboard; it is still to be done by hand.
- **Open: the upstream SDK issue.** The bug is still present in
  `@modelcontextprotocol/server` 2.3.1, the pinned and latest version, and on the SDK's
  `main` (`readRequestBody` checks only `request.body === null`). Firefox 158 has no
  `Request.body` (`"body" in Request.prototype` is `false`, checked with `ff-rdp`). tab-mcp
  no longer runs the SDK server in the tab (DEC-049), so this does not affect us. The
  owner decides whether to file the draft below.

### Draft upstream issue (not filed)

Title: `createMcpHandler().fetch()` fails with -32700 in Firefox: `readRequestBody`
assumes `Request.body` exists

> **Version:** `@modelcontextprotocol/server` 2.3.1 (also `main` as of 2026-10-20),
> Firefox 158.
>
> **What happens:** Calling `createMcpHandler(...).fetch(request)` in Firefox with a
> `Request` made by `new Request(url, { method: "POST", body: json, headers })` answers
> every POST with a JSON-RPC parse error (`-32700`).
>
> **Why:** Firefox does not implement the `Request.body` getter (`"body" in
> Request.prototype` is `false`), so `request.body` is `undefined`, not `null`.
> `readRequestBody` in `packages/server/src/server/requestBody.ts` checks only
> `request.body === null` and then calls `request.body.getReader()`, which throws.
>
> **Workaround:** pass the body yourself: `handler.fetch(request, { parsedBody })`.
>
> **Suggested fix:** if `request.body` is `null` or `undefined`, fall back to
> `await request.text()` (respecting `maxBytes` through `content-length` and the text
> length), or read with `request.arrayBuffer()` when no stream is available.
>
> **Reproduction:** in Firefox's console,
> `String(new Request("http://localhost/", { method: "POST", body: "{}" }).body)` gives
> `"undefined"`; Chrome gives `"[object ReadableStream]"`.

# Citations

- [AI app support research](/research/ai-app-support.md)
- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
