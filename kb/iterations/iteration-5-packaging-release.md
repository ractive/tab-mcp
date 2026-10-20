---
type: iteration
title: "Iteration 5: packaging, documentation and release"
description: npm builds with declarations, trusted publishing with provenance, the multi-arch Docker image, project documentation, the developer skill, dependency updates and the token-expiry warning.
status: in-progress
tags:
  - iteration
  - release
  - docs
timestamp: 2026-10-20T07:10:00+02:00
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

- [x] Client: the build writes `dist/` with its own `package.json` (DEC-053): ESM with lazily loaded chunks (DEC-035), declarations from `tsc -p tsconfig.build.json`, no SDK (DEC-049); done in iteration 2, metadata and `publishConfig` in iteration 5a
- [x] Client CDN build: self-contained minified ESM with lazily loaded chunks; the bundled `@cfworker/json-schema` licence in `THIRD-PARTY-NOTICES.txt` (a test keeps its version in step)
- [x] Relay: `bun build --target=bun` to `dist/`, `bin` → `dist/main.js` with `#!/usr/bin/env bun`; exports `.` (`createRelay`, `TokenStore` types, built-in stores) and `./testing` (conformance suite)
- [x] Pack checks in CI: client done in iteration 5a (`scripts/npm-pack.ts` in `release.yml` on pull requests: expected file list, no `src/`, no `workspace:`, exact versions); relay added with its own file list, `bin` and declarations (DEC-068)

### npm release

- [x] `.github/workflows/release.yml` (iteration 5a, DEC-055): GitHub release `client-v<version>` and `workflow_dispatch` (`dry-run`, `bootstrap`, `publish`), dry run on pull requests; verify, build, pack, checks against tag and pre-release flag, dry-run publish, install test, then `npm publish <tgz> --provenance --tag <alpha|beta|rc|latest>` with npm 12.2.0 via OIDC in environment `release`; skips a version already published with the same integrity
- [x] Bootstrap mode: signs the exact tarball with GitHub OIDC provenance and uploads it with the bundle (artifact `npm-bootstrap-tab-mcp-client-<version>`); proven on the branch in run 39328703960
- [x] Document the bootstrap and release steps: [npm publishing](/operations/npm-publishing.md) (instead of `RELEASING.md`)
- [ ] Owner: bootstrap `@ractive-ch/tab-mcp-client@0.1.0-alpha.0`, configure its trusted publisher and the `release` environment, create the GitHub release `client-v0.1.0-alpha.0` ([steps](/operations/npm-publishing.md))
- [x] Relay `@ractive-ch/tab-mcp` (after OAuth, iteration 3): a `relay` entry in `scripts/npm-pack.ts`, `relay-pack`/`relay-bootstrap`/`relay-publish` jobs for `relay-v*` releases, the Docker jobs on the same tag (DEC-068, DEC-069)
- [ ] Owner: bootstrap `@ractive-ch/tab-mcp@0.1.0-alpha.0`, configure its trusted publisher, the `relay-v*` policy of `release`, the Docker Hub repository and variables, create the GitHub release `relay-v0.1.0-alpha.0`, make the ghcr.io package public ([steps](/operations/npm-publishing.md))

### Docker

- [x] `Dockerfile` (multi-stage, `oven/bun:1.4.3-alpine` build, `oven/bun:1.4.3-distroless` runtime, non-root, `HEALTHCHECK` not possible in distroless → documented health endpoint instead), `TAB_MCP_STORE=sqlite` and `TAB_MCP_SQLITE_PATH=/data/tab-mcp.db` with `/data` a volume writable by the non-root user, `.dockerignore`
- [x] Release job: buildx multi-arch amd64 + arm64, push to `ractive/tab-mcp` (Docker Hub, `DOCKERHUB_USERNAME` variable + `DOCKERHUB_TOKEN` secret) and `ghcr.io/ractive/tab-mcp`, tags `X.Y.Z`, `X.Y`, `latest`, provenance and SBOM attestations, all actions pinned by SHA
- [x] Token-expiry warning: scheduled monthly workflow (and a step in the release workflow) that reads the repository variable `DOCKERHUB_TOKEN_EXPIRES` (`2027-10-19`) and fails with a clear message, or opens an issue, when the date is within 30 days, pointing to `kb/operations/release-secrets.md`

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

- [x] Dependabot (DEC-037) for npm with the Bun lockfile, GitHub Actions and Docker, exact versions
- [x] CI: add the browser e2e job, `bun pm pack --dry-run` checks, Docker build (no push) on PRs: the browser tests and the calculator e2e run inside `verify` in `ci.yml` (Chrome set up there since iteration 4); the pack checks are `scripts/npm-pack.ts` in the release dry run; the image builds for both architectures and passes `scripts/docker-smoke.ts` (DEC-069)

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
