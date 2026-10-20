# Rubric for the iteration 5 docs and skill (starter; tune as needed)

1. /mnt/session/outputs/iter-5-docs-skill.bundle exists, `git bundle verify` passes against the repository, and it contains the branch iter-5/docs-skill based on main.
2. Every commit on the branch is authored by james@ractive.ch and its message ends with the Co-Authored-By line.
3. `bun run verify` passes on the branch head (stated in REPORT.md with the test count).
4. Each file the task lists exists: README.md (updated), docs/protocol.md, SECURITY.md, docs/threat-model.md, docs/token-store.md, docs/configuration.md, docs/self-hosting.md, CHANGELOG.md, packages/tab-mcp/README.md, plugins/tab-mcp/skills/tab-mcp/SKILL.md, the Claude Code and Codex plugin and marketplace files.
5. docs/configuration.md lists every TAB_MCP_* variable the code reads (checked with a grep over packages/tab-mcp/src) and no variable the code does not read.
6. Facts agree with the code and kb: protocol version tab-mcp.v1, the published package names and versions, the image names, the pairing flow (address plus code typed on /authorize). No invented options, commands or flags.
7. SKILL.md has valid Agent Skills frontmatter (name, description) and is at most about 200 lines.
8. scripts/npm-pack.ts expects README.md for the relay, and the pack checks in the tests pass.
9. kb/ frontmatter and task checkboxes are unchanged.
10. REPORT.md lists what was checked and anything left unverified.
