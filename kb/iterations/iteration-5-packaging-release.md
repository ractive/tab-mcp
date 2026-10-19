---
type: iteration
title: "Iteration 5: packaging, documentation and release"
description: npm builds with declarations, trusted publishing with provenance, the multi-arch Docker image, project documentation, the developer skill, dependency updates and the token-expiry warning.
status: planned
tags:
  - iteration
  - release
  - docs
timestamp: 2026-10-19T23:00:00+02:00
---

# Iteration 5: packaging, documentation and release

Goal: version 0.1.0 can be released: npm packages, Docker image, documentation.

Read first: [Bun and publishing research](/research/bun-runtime-and-publishing.md),
[release credentials](/operations/release-secrets.md), DEC-011, 012, 024, 026, 030, 035,
037, 038, and
`/Users/james/devel/hyalo/.github/workflows/release.yml` (bootstrap then trusted
publishing) and `/Users/james/devel/hyalo/plugins/hyalo` (skill packaging).

## Tasks

### Builds

- [ ] Client: `bun build --target=browser --format=esm --packages=external --splitting` to `dist/` (core and lazily loaded chunk, DEC-035), declarations with `tsc -p tsconfig.build.json` (TS 7, `emitDeclarationOnly`, `isolatedDeclarations`), `exports` pointing to `dist/index.js` + `dist/index.d.ts`, `files: ["dist", …]`, `@modelcontextprotocol/server` as a dependency (pinned) only if iteration 2 kept the SDK
- [ ] Client CDN build: self-contained minified ESM with a lazily loaded chunk; if the SDK is bundled, its Apache-2.0 licence and NOTICE in `dist/THIRD-PARTY-NOTICES.txt`
- [ ] Relay: `bun build --target=bun` to `dist/`, `bin` → `dist/main.js` with `#!/usr/bin/env bun`; exports `.` (`createRelay`, `TokenStore` types, built-in stores) and `./testing` (conformance suite)
- [ ] `bun pm pack --dry-run` checks in CI: expected file lists, no `src/`, no `workspace:`

### npm release

- [ ] `.github/workflows/release.yml` on GitHub release `published` and `workflow_dispatch` (dry run): verify, build, pack, check versions match the tag, `npm publish <tgz> --provenance --access public` with npm ≥ 11.5.1 via OIDC (`id-token: write`), skip already-published versions
- [ ] Bootstrap mode (like hyalo's `prepare_npm_bootstrap`): build and upload the tarballs as an artifact for the owner's first manual `npm publish`; then the owner runs `npm trust github <pkg> --file release.yml --repo ractive/tab-mcp --allow-publish` for both packages
- [ ] Document the bootstrap steps in `RELEASING.md`

### Docker

- [ ] `Dockerfile` (multi-stage, `oven/bun:1.4.3-alpine` build, `oven/bun:1.4.3-distroless` runtime, non-root, `HEALTHCHECK` not possible in distroless → documented health endpoint instead), `TAB_MCP_STORE=sqlite` and `TAB_MCP_SQLITE_PATH=/data/tab-mcp.db` with `/data` a volume writable by the non-root user, `.dockerignore`
- [ ] Release job: buildx multi-arch amd64 + arm64, push to `ractive-ch/tab-mcp` (Docker Hub organisation `ractive-ch` from the `DOCKERHUB_NAMESPACE` variable; login with the `DOCKERHUB_USERNAME` variable + `DOCKERHUB_TOKEN` secret) and `ghcr.io/ractive/tab-mcp`, tags `X.Y.Z`, `X.Y`, `latest`, provenance and SBOM attestations, all actions pinned by SHA
- [ ] Token-expiry warning: scheduled monthly workflow (and a step in the release workflow) that reads the repository variable `DOCKERHUB_TOKEN_EXPIRES` (`2027-10-19`) and fails with a clear message, or opens an issue, when the date is within 30 days, pointing to `kb/operations/release-secrets.md`

### Documentation

- [ ] README: what it is, how it works (diagram), quick start for page authors and for users, self-hosting, status
- [ ] `docs/protocol.md` from the [protocol design](/design/protocol.md), versioned `tab-mcp.v1`
- [ ] `SECURITY.md` (reporting via GitHub private advisories, supported versions, the phishing note of DEC-038: connecting an AI app to a page means trusting the page) and `docs/threat-model.md` from the [threat model](/design/threat-model.md)
- [ ] `docs/token-store.md`: the `TokenStore` interface, its guarantees (hashes only, atomic `markUsed`), how to run the conformance suite, and a sketch of a Redis or Prisma store
- [ ] `docs/configuration.md` (every `TAB_MCP_*` variable, defaults, safe-default rationale, the open-relay warning), `docs/self-hosting.md` (Docker, reverse proxy notes: WebSockets, SSE buffering, 60 s first-byte limits)
- [ ] `docs/compatibility.md` carried over from iteration 4
- [ ] `CHANGELOG.md` (Keep a Changelog), package READMEs, `LICENSE` and `AI_NOTICE` in both packages

### Developer skill

- [ ] `plugins/tab-mcp/skills/tab-mcp/SKILL.md` (open Agent Skills format, under ~200 lines): install the client, register tools WebMCP-style, connect/pairing flow (address plus code typed on `/authorize`), consequential tools, security defaults, self-hosting the relay; `references/` only if needed
- [ ] Cheap packaging as in hyalo: `plugins/tab-mcp/.claude-plugin/plugin.json` and root `.claude-plugin/marketplace.json` (Claude Code `/plugin marketplace add ractive/tab-mcp`), `plugins/tab-mcp/.codex-plugin/plugin.json` + `.agents/plugins/marketplace.json` (Codex), `agents/openai.yaml`; a `pi` entry only if it needs no extra package; claude.ai: zip upload documented
- [ ] Lint the skill with `hyalo lint` (SKILL rules) if the folder is in a hyalo vault, else by hand

### Repository hygiene

- [ ] Dependabot (DEC-037) for npm with the Bun lockfile, GitHub Actions and Docker, exact versions
- [ ] CI: add the browser e2e job, `bun pm pack --dry-run` checks, Docker build (no push) on PRs

## Acceptance criteria

- `workflow_dispatch` dry run builds, packs and builds the image for both architectures.
- Bootstrap artifact contains both tarballs with the expected files.
- The expiry check fails when `DOCKERHUB_TOKEN_EXPIRES` is set to a date 10 days ahead
  (tested once with a temporary value) and passes for `2027-10-19`.
- Docs reviewed for plain English; `bun run verify` and `hyalo lint` clean.
- Owner releases 0.1.0 (owner step).

## Test approach

Workflow dry runs on a branch; `docker run` of the built image against the e2e suite;
`npm pack` contents compared with expected lists.

# Citations

- [Bun runtime and publishing research](/research/bun-runtime-and-publishing.md)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers)
- [Agent Skills format](https://agentskills.io/specification)
