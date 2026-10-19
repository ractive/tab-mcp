---
type: questions
title: Questions for the owner (closed)
description: >-
  The owner's answers of 2026-10-19 to the plan's open questions, each pointing
  to its decision; no question is open.
tags:
  - questions
timestamp: 2026-10-19T23:00:00+02:00
---

# Open questions for the owner

**Closed on 2026-10-19.** The owner answered every question; each answer is recorded in the
[decision log](/decision-log.md). No question is open.

1. **Stable addresses.** Yes: the address is derived from a secret kept in the page, with a
   "New address" button; the newest tab with the same secret wins. → DEC-027.
2. **Compare or type the code?** Neither as planned: pairing like a TV sign-in. The tab
   shows the address and a 6-digit code; the user types the code on the relay's
   `/authorize` page, which names the AI app and the page's origin. → DEC-028.
3. **Claude header bug workaround.** Yes, exactly the one mismatched case, until Claude fixes
   it. → DEC-033.
4. **Clients locked out.** Accepted: 2026-07-28 only, CIMD only, no dynamic client
   registration; the compatibility matrix tracks VS Code, Cursor, Gemini CLI and default
   Codex. → DEC-033.
5. **Refresh tokens.** Yes after all: 1-hour access tokens and rotating 30-day refresh
   tokens with reuse detection, bound to the stable address; stored as hashes in a
   `TokenStore` (SQLite by default). → DEC-029, DEC-030, DEC-041.
6. **Default limits.** 300 s per request with keep-alives throughout, 60 min idle, 12 h
   session lifetime, 5 sessions per IP, 1 MiB messages; all configurable. → DEC-034,
   DEC-039.
7. **SDK licence.** Apache-2.0 is acceptable; its notice ships with any bundle that contains
   it. → DEC-035.
8. **Bundle size.** The heavy part loads only on `connect()`; iteration 2 starts by measuring
   the SDK and replaces it with our own stateless subset if it is mostly unused code and
   Zod. → DEC-035.
9. **ghcr.io in addition to Docker Hub?** Yes. → DEC-037.
10. **Dependabot or Renovate?** Dependabot. → DEC-037.
11. **Hosted relay origin allow-list.** Exactly `https://ractive.ch`. The calculator example
    uses a local relay. The default list is empty; an open relay needs an explicit setting
    and logs a warning. → DEC-032.
12. **Browser-based MCP clients.** Yes: CORS without credentials on the metadata, token and
    MCP endpoints, configurable off. → DEC-036.
13. **Claude Code CI run.** Local only. → DEC-037.

The owner also decided that the OAuth authorization server is written without an OAuth
library and must pass spec tests, conformance runs against `oauth4webapi` and the MCP SDK
client and a separate security review (DEC-031), and that the security documents carry a
phishing note: connecting an AI app to a page means trusting the page (DEC-038).

## What tab-mcp must offer saturnus (for the later integration)

- Tools with JSON Schema inputs and text/image results (screen dumps as PNG `image`
  content).
- Consequential tools (e.g. "reset calculator", "delete file") confirmed in the page.
- Tool-list changes when the emulated model changes (register/abort).
- A replaceable pairing and status UI that fits saturnus's design.
- A stable address across visits (DEC-027) and the hosted relay allowing
  `https://ractive.ch` (DEC-032).

# Citations

- [Decision log](/decision-log.md)
- [AI app support research](/research/ai-app-support.md)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
