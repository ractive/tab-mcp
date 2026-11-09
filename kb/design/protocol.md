---
type: design
title: "Tab↔relay protocol, version 1"
description: >-
  Pointer to docs/protocol.md, the normative description of the versioned WebSocket
  protocol `tab-mcp.v1` between the browser library and the relay.
tags:
  - protocol
  - design
timestamp: 2026-11-09T15:00:00+01:00
---

# Tab↔relay protocol, version 1

The normative description of `tab-mcp.v1` is `docs/protocol.md` in the repository: the
connection and version negotiation, every message type with its JSON shape, the errors and
close codes, the heartbeat and the limits. It is the contract third-party tab
implementations follow, and the protocol modules of both packages
(`packages/tab-mcp/src/protocol.ts`, `packages/tab-mcp-client/src/protocol.ts`) name it.

This page held the design draft until [iteration 5](/iterations/iteration-5-packaging-release.md)
moved it to `docs/protocol.md`; the two then drifted, so since 2026-11-09 (`docs/pre-release`)
it only points there. The draft is in git history. Changes to the protocol go to
`docs/protocol.md` and the decision log; the [architecture](/design/architecture.md) shows
where the protocol sits.

# Citations

- [Decision log](/decision-log.md)
- [RFC 6455 WebSocket close codes](https://www.rfc-editor.org/rfc/rfc6455#section-7.4)
