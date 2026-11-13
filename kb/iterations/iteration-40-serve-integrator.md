---
type: iteration
title: "Iteration 40: serve for a site's own assistant, integrator feedback"
status: completed
description: >-
  Iteration L, from the feedback of an integrator whose site's own assistant uses serve
  and createTunnelFetch (a chat in an iframe forwards the port over its WebSocket to the
  backend). serve gets its own onConfirm (asked in the site's chat, never over the port)
  and a page-side requestTimeoutMs; callers per tool replaces the webmcp registration
  option, with tools/list, list_changed and calls filtered per caller; every result of an
  untrustedContentHint tool carries a marker in _meta; a cancelled call ends at once; the
  README has a tested backend recipe next to an agent framework and page context in a
  read-only tool.
timestamp: 2026-11-14T12:00:00+01:00
tags: [iteration, client, serve, protocol]
---
# Iteration 40: serve for a site's own assistant, integrator feedback

Not from the review of 2026-11-13: feedback from an integrator (a site's own assistant)
whose chat runs in an iframe and forwards the port of `serve` over its WebSocket to the
backend, where `createTunnelFetch` and an MCP client call the page's tools. Owner-approved
scope (2026-11-13), all additive except the folding of `webmcp` into `callers`; it ships
in the same client minor as iteration 38 and builds on its API. Builds on
[iteration 28](iteration-28-tunnel-without-relay.md) (DEC-122 to DEC-126). Decisions:
DEC-164 to DEC-167.

## 1. A question per served port (DEC-164)

- [x] `ServeOptions.onConfirm`: answers the confirmations of that port's calls instead of
  `TabMcpOptions.onConfirm` and the dialog; relay and WebMCP calls keep the page's
- [x] Same answers as the page's `onConfirm` (`true`, `false`, `"unanswered"`; anything
  else and a throw a refusal); `request.signal` aborts on cancel, time limit and close
- [x] Never sent over the port (no message for it); validated (`TypeError`)
- [x] README: "Asking in your chat" as the recommended pattern; the advice to answer
  `true` for `kind === "local"` replaced by why not (third-party text in tool results)
- [x] Tests: `serve.test.ts` (own question vs. a second port with the page's, the five
  answers, signal on cancel and on close), `relay.test.ts` (the relay's call asks the
  page's `onConfirm` while a port has its own)

## 2. Which callers see a tool (DEC-165)

- [x] `RegisterToolOptions.callers` (`ToolCaller[]`), copied and checked at registration
- [x] `webmcp` folded in (breaking, CHANGELOG with migration); the WebMCP default for
  consequential tools unchanged; `exposedTo` untouched (owner)
- [x] `tools/list` and calls filtered per caller (`toolsFor`), a hidden tool answered as
  an unknown one; `list_changed` only when the caller's own list changed (`watchTools`)
- [x] React `useTool` registers again when `callers` changes by value
- [x] Tests: `registry.test.ts` (validation, copy, `toolsFor`), `serve.test.ts` (list,
  call as unknown, `list_changed` per port), `relay.test.ts` (the same from the relay),
  `webmcp.test.ts` and `webmcp-browser.test.ts` moved to `callers`, `react.test.tsx`

## 3. A time limit per request on the page's side (DEC-167)

- [x] `ServeOptions.requestTimeoutMs`, 300 s, above 0 and below 2^31, listen streams not
  limited
- [x] On expiry: abort (`execute` and the question), `toolcallend` `cancelled`, late
  answer dropped, `-31002` to the other end as `createTunnelFetch` sends it
- [x] A cancelled call ends at once even when `onConfirm` or `execute` ignore the signal
  (needed for "end the call"; applies to every caller)
- [x] `docs/protocol.md`: the page's own `-31002`
- [x] Tests: `serve.test.ts` (the page's limit with a longer tunnel limit, a late answer,
  a question that waits too long, listen and `tools/list` not cut, bad values);
  `serve-browser.test.ts` waits for the dialog's `close` event

## 4. The untrusted marker on every result (DEC-166)

- [x] `markUntrusted` in `mapping.ts`, applied in `runCall` for every result of an
  `untrustedContentHint` tool, before the size check and `toolcallend`; the tool's own
  `_meta` kept
- [x] End-to-end test through `createTunnelFetch` and the MCP SDK client pinned to
  2026-07-28: `tools/list` has `openWorldHint` and the `_meta` hints, a result has the
  marker next to its own `_meta`, another tool's result has none; the relay path in
  `relay.test.ts`; `mapping.test.ts`
- [x] README "Untrusted results": what a consumer reads

## 5. README recipe (no new API)

- [x] "The backend and an agent framework": the MCP SDK client pinned to 2026-07-28 next
  to a framework, the page's tools as function tools, untrusted results delimited;
  the code is `test/assistant-backend.ts`, and `assistant-backend.test.ts` checks that
  the README has it word for word and runs it against a served page
- [x] Page context in a read-only tool (`get_page_context`): MCP has no notification for
  changed instructions
- [x] Not built (owner): `createTunnelClient` without the SDK, a runtime `setInstructions`

## Users in this repository

- [x] Client README (tools, WebMCP, the assistant section rewritten, React), root README,
  CHANGELOG, `docs/protocol.md`, `docs/threat-model.md` A14/A15, `kb/design/threat-model.md`,
  `kb/design/architecture.md`, the skill and its React reference

## Review of PR 129

- [x] A leftover `webmcp` registration option was silently ignored, so `{ webmcp: false }`
  put the tool into WebMCP (claude): `registerTool` now refuses an options object with
  `webmcp` (`TypeError`), tested
- [x] The time limit's exemption for `subscriptions/listen` read the `mcp-method` header
  case-sensitively (claude, glm): any case now, tested with `Mcp-Method`
- [x] Stale `offeredTo` references in comments (claude); the README's path to the recipe
  (claude) is the full repository path, linked
- [x] A time limit that fires in the middle of an SSE event sends no error (glm):
  answered, the handler enqueues whole events and each read goes out in one task, so
  the timer always finds the stream between two events; a comment says so

## Outcome

- Core 6399 B gzipped of 6400 (iteration 38: 6322): the `callers` check and copy in the
  registry, the refusal of `webmcp`, and the mirror's rule. A helper shared by the core and the lazy chunk would
  have split the core into two files (6.8 KB); the relay and the port filter in the lazy
  chunk instead. The connection chunk grew by about 0.5 KB (15.9 KB); the tunnel entry is
  unchanged (1.7 KB).
- Outside this repository: ractive.ch's examples register a consequential tool with
  `{ webmcp: true }` (DEC-157); on the next client release they move to
  `callers: ["relay", "webmcp"]`, as do saturnus and Overmark if they use the option.
