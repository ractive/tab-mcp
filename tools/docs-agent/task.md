Do the open Documentation and Developer skill tasks of kb/iterations/iteration-5-packaging-release.md
in tab-mcp. The packaging half of that iteration is merged and released (relay
@ractive-ch/tab-mcp 0.1.0-alpha.1 on npm, images ractive/tab-mcp and ghcr.io/ractive/tab-mcp
0.1.0-alpha.1); the client is @ractive-ch/tab-mcp-client 0.1.0-alpha.1.

Documentation:
- README.md: what it is, how it works (an ASCII or Mermaid diagram), quick start for page
  authors and for users, self-hosting, status. Keep the link to docs/compatibility.md.
- docs/protocol.md from kb/design/protocol.md, versioned `tab-mcp.v1`.
- SECURITY.md (reporting via GitHub private advisories, supported versions, the phishing
  note of DEC-038: connecting an AI app to a page means trusting the page) and
  docs/threat-model.md from kb/design/threat-model.md.
- docs/token-store.md: the TokenStore interface, its guarantees (hashes only, atomic
  markUsed), how to run the conformance suite (`@ractive-ch/tab-mcp/testing`), a sketch of
  a Redis or Prisma store.
- docs/configuration.md (every TAB_MCP_* variable from the code, defaults, why the
  defaults are safe, the open-relay warning) and docs/self-hosting.md (Docker with the
  published image, reverse proxy notes: WebSockets, SSE buffering, 60 s first-byte limits).
- docs/compatibility.md already exists; keep it, link it.
- CHANGELOG.md (Keep a Changelog): entries for the released versions of both packages.
- Package READMEs: packages/tab-mcp/README.md (new) and the client's (check and update);
  LICENSE and AI_NOTICE in both packages' published files. Adding packages/tab-mcp/README.md
  means adding README.md to the relay's expected file list in scripts/npm-pack.ts (the pack
  check fails otherwise); check the client's list the same way.

Developer skill:
- plugins/tab-mcp/skills/tab-mcp/SKILL.md in the open Agent Skills format
  (agentskills.io/specification), under about 200 lines: install the client, register
  tools WebMCP-style, the connect and pairing flow (address plus code typed on /authorize),
  consequential tools, security defaults, self-hosting the relay; references/ only if needed.
- Packaging like hyalo's (mounted read-only at /workspace/hyalo: plugins/hyalo/ and
  .agents/plugins/marketplace.json): plugins/tab-mcp/.claude-plugin/plugin.json and a root
  .claude-plugin/marketplace.json for Claude Code (`/plugin marketplace add ractive/tab-mcp`;
  check the format on code.claude.com), plugins/tab-mcp/.codex-plugin/plugin.json and
  .agents/plugins/marketplace.json for Codex, and agents/openai.yaml if hyalo has one. For
  claude.ai, document the zip upload in the skill's README or the main README.
