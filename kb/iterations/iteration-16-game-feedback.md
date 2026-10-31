---
type: iteration
title: "Iteration 16: feedback from the comparis game"
status: in-progress
description: "Fixes and developer-experience changes from integrating the React client into the comparis office game: dialog centring under CSS resets, the development public URL, a 'connection lost' label, published test helpers, typed tool inputs, and README sections."
timestamp: 2026-10-31T22:00:00+01:00
tags: [iteration, client, relay, react, docs]
---
# Iteration 16: feedback from the comparis game

The comparis office game "comparis 2027" (Vite, React 19, Tailwind v4) added client 0.9.1
and tested it against relay 0.6.0; its notes are in
[research/feedback-comparis-game.md](../research/feedback-comparis-game.md). The hosted
relay allows the game's origin since 2026-10-31 (ractive.ch PR 73, with
`TAB_MCP_MAX_SESSIONS_PER_IP` 50 for players behind one office address).

## Scope, by item of the feedback

1. The dialogs lose their centring under a CSS reset (`margin: 0`): `margin: auto` in
   `DIALOG_CSS`.
2. Without `TAB_MCP_PUBLIC_URL` in development, addresses always used `localhost`: they
   use the loopback address the relay listens on (`developmentUrl`).
3. "Reconnecting…" forever: `ConnectButton`'s default label says "Connection lost,
   retrying…" after three failed attempts; `reconnecting` (attempt, time) was already in
   `useTabMcpState()`. The library keeps trying (README, reconnecting).
4. Test helpers: `startTestRelay()` and `tokenFor()` in `@ractive-ch/tab-mcp/testing`; the
   client's tests use them.
5. A development pairing endpoint: not built (DEC-107).
6. The user-action rule of `connect()`: documented next to `ConnectButton` and in
   "Connecting and pairing", with `connect({ resume: true })` for automation.
7. Tools in a `useState` app: a README section (a ref changed with the state through one
   function; `flushSync` only to read the DOM).
8. Typed inputs: `Tool<Input>`, `registerTool<Input>`, `useTool<Input>`.
9. A label per state: `ConnectButton`'s `children` already takes a function of the state
   (since 0.4.0); the README shows an example.
10. Who may use the hosted relay: the game's origin was added; a README paragraph is still
    open (owner).

## Tasks

- [x] `margin: auto` on `.tab-mcp-dialog`, with a test
- [x] `developmentUrl()` for the default public URL, with tests; docs/configuration.md
- [x] "Connection lost, retrying…" after three failed reconnect attempts, with a test
- [x] `startTestRelay()` and `tokenFor()` in `@ractive-ch/tab-mcp/testing`, with tests; client test helpers use them
- [x] `Tool<Input>` and the generic `registerTool` and `useTool`, with a type test
- [x] READMEs: user action, label function, `useState` tools, typed input, testing
- [x] CHANGELOG (client and relay, Unreleased), DEC-107
- [ ] Review, merge; client 0.10.0 and relay 0.6.1 releases on the owner's word
