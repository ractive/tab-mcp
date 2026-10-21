---
type: iteration
title: "Iteration 8: the relay's answer when the page is not open"
description: When the page is not open, the relay waits a short grace period for it and then answers with HTTP 200 and a JSON-RPC message instead of 503, so an AI app's connector keeps its session.
status: completed
tags:
  - iteration
  - relay
  - mcp
timestamp: 2026-10-21T10:00:00+02:00
---

# Iteration 8: the relay's answer when the page is not open

## Problem

The owner's test on 2026-10-20 (hosted relay, CDN log, times UTC): claude.ai paired with
saturnus on Firefox Android and made four MCP calls (200). At 18:30:09 a `tools/call` got
503 `page_not_open`: the phone had paused the tab when the owner switched apps. From then
on every call came as POST 400 (an `initialize`, refused by the version check) and GET 405
(the old HTTP+SSE transport), also after the page had reconnected (`/tab` 101 at 18:30:30,
18:31:25, 18:34:40) and in split screen. Nothing worked again in that chat. The MCP
2026-07-28 spec explains it: a client that also speaks older versions re-probes the
server's era when a request fails with a 4xx without a recognised modern JSON-RPC error,
and falls back to `initialize` and then to HTTP+SSE.

## Design

See DEC-074 in the [decision log](/decision-log.md).

1. **Grace period.** A request for an address whose page is not open waits up to
   `TAB_MCP_PAGE_WAIT_S` (default 10 s, 0 turns it off) for the page's session. If the
   page connects, the request is forwarded as usual. The wait ends when the AI app aborts
   its request. Waiting requests are bounded: per address at most
   `TAB_MCP_MAX_CONCURRENT_REQUESTS`, in total at most `TAB_MCP_MAX_SESSIONS`; beyond that
   the relay answers at once. `server/discover` does not wait: Claude Code gives its
   era probe 5 s and then falls back to the legacy handshake.
2. **Page gone mid-request.** If the page's session ends while a request waits for its
   answer, a `tools/list` waits for the page again (once) and is forwarded again. A
   `tools/call` is not sent twice: the page may have run it. `server/discover` gets the
   stand-in at once.
3. **Answer at HTTP 200.** If the page stays away, the relay answers with HTTP 200 and a
   JSON-RPC message: a tool result with `isError: true` for `tools/call`, a minimal
   `server/discover` result with `ttlMs: 0`, and a JSON-RPC error (`-31001`) for every
   other request. Notifications keep the 503 (the spec requires an HTTP error status for a
   notification the server cannot accept). The log line keeps `reason: page_not_open`.

## Claude Code headless (2.1.296, local relay, not claude.ai)

Page closed before the run: before, `server/discover` got 503 and Claude Code sent
`initialize` 2025-11-25 at once (400) and failed to connect; after, it connected on
2026-07-28 with the stand-in discover result, its `tools/list` and `subscriptions/listen`
got the `-31001` error after the 10 s wait, and the model said the calculator was not
available. Page closed after the first `tools/call` of two: before, each 503 was logged
as "HTTP connection dropped"; after, the second `tools/call` got the `isError` result
after 10 s, the model passed the text on ("bring the Calculator tab to the front"), the
connection stayed on 2026-07-28 and closed cleanly, and Claude Code kept the previous tool
set when `tools/list` failed. A first version also let `server/discover` wait: Claude
Code's probe timed out after 5 s and it reconnected pinned to the legacy protocol, which
is why `server/discover` does not wait.

## Tasks

- [x] `pageWaitMs` setting, `TAB_MCP_PAGE_WAIT_S` (0 allowed), `--help` and docs/configuration.md
- [x] Wait for the page's session before answering page-not-open, bounded and abortable
- [x] Answers at HTTP 200 per method: `tools/call`, `server/discover`, others
- [x] Page gone mid-request: retry `tools/list` once, answer a `tools/call` with `isError`
- [x] DEC-074 with the spec reasons and the CDN-log evidence
- [x] Tests in packages/tab-mcp/test
- [x] docs/protocol.md, docs/threat-model.md, docs/self-hosting.md and kb design pages updated (the READMEs do not mention the 503)
- [x] CHANGELOG entry under the relay (Unreleased)
- [x] Claude Code headless run with the page closed, before and after
- [x] `bun run verify` green; committed on `iter-8/page-not-open`

# Citations

- [MCP 2026-07-28 research](/research/mcp-2026-07-28-spec.md)
- [Streamable HTTP: backward compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility)
- [Versioning: backward compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#backward-compatibility-with-initialization-based-versions)
- [Tools: error handling](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling)
- [Caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching)
