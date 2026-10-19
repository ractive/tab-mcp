---
type: questions
title: "Open questions for the owner"
description: Decisions the plan made provisionally or could not make, each with a recommendation.
tags:
  - questions
timestamp: 2026-10-19T20:00:00+02:00
---

# Open questions for the owner

Each question has a recommendation; the plan follows it until the owner decides otherwise.

1. **Stable addresses (DEC-017).** Keep the address the same across visits via a key in the
   page's `localStorage`, or a new address per session? A new address per session means
   re-adding the connector in claude.ai/ChatGPT every time. *Recommendation: stable, with a
   "New address" button.*
2. **Compare or type the code?** The plan has the user compare the 4-digit code shown on
   `/authorize` with the one in the tab. Typing the code from `/authorize` into the tab
   prevents blind approval at the cost of one more step. *Recommendation: compare (as
   decided), and switch to typing if usability tests show people click without looking.*
3. **Claude header bug workaround (DEC-019).** Accept `MCP-Protocol-Version: 2025-11-25`
   when the body says `2026-07-28`? Without it claude.ai connectors in Desktop and Claude
   Code fail today (claude-code #93290). *Recommendation: yes, narrowly, removed once
   fixed.*
4. **Clients locked out.** 2026-07-28-only locks out VS Code/Copilot, Gemini CLI and default
   Codex; CIMD-only locks out Cursor. Accept for now and list them in the compatibility
   matrix? *Recommendation: yes; revisit when Cursor ships CIMD.*
5. **Refresh tokens (DEC-016).** None; the access token lives as long as the session.
   Acceptable? *Recommendation: yes.*
6. **Default limits.** Request timeout 120 s, idle 60 min, session lifetime 12 h, 5 sessions
   per IP, 1 MiB messages. Long enough for saturnus (e.g. long-running programs on the
   emulated calculator)? *Recommendation: these defaults; saturnus can ask for more on the
   hosted instance.*
7. **SDK licence.** The MCP SDK v2 is Apache-2.0. The client package depends on it (not
   bundled) and the CDN build bundles it with its notice. Fine? *Recommendation: yes.*
8. **Bundle size.** The SDK adds about 82 KB gzipped to pages. Acceptable for saturnus, or
   should a later iteration replace it with a small hand-written handler?
   *Recommendation: accept for 0.1; measure in saturnus.*
9. **ghcr.io in addition to Docker Hub?** *Recommendation: yes, it costs one login step.*
10. **Dependabot or Renovate?** *Recommendation: Dependabot (already used in your other
    repositories, supports `bun.lock`); Renovate only if Dependabot's Bun support falls
    short.*
11. **Hosted relay origin allow-list.** Which page origins should `relay.ractive.ch` accept
    (ractive.ch, the example's GitHub Pages origin, others on request)?
12. **Browser-based MCP clients.** No CORS on the MCP endpoint in version 1, so MCP clients
    running in a web page cannot connect. Needed? *Recommendation: no.*
13. **Claude Code CI run.** The headless Claude Code check needs an account and costs
    tokens; keep it local-only? *Recommendation: local-only script, not in CI.*

## What tab-mcp must offer saturnus (for the later integration)

- Tools with JSON Schema inputs and text/image results (screen dumps as PNG `image`
  content).
- Consequential tools (e.g. "reset calculator", "delete file") confirmed in the page.
- Tool-list changes when the emulated model changes (register/abort).
- A replaceable consent and status UI that fits saturnus's design.
- A stable address across visits (question 1) and the hosted relay allowing
  `https://ractive.ch`.

# Citations

- [Decision log](/decision-log.md)
- [AI app support research](/research/ai-app-support.md)
- [MCP TypeScript SDK v2 research](/research/mcp-typescript-sdk-v2.md)
