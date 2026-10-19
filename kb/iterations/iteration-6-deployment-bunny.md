---
type: iteration
title: "Iteration 6: hosted relay on bunny.net"
description: Run the owner's public relay as a single Magic Containers instance behind the bunny CDN with a custom domain, health checks and a privacy notice.
status: planned
tags:
  - iteration
  - deployment
timestamp: 2026-10-19T20:00:00+02:00
---

# Iteration 6: hosted relay on bunny.net

Goal: a public relay (e.g. `relay.ractive.ch`) that saturnus and the calculator example can
use.

Read first: [bunny.net research](/research/bunny-magic-containers.md),
[threat model](/design/threat-model.md) A5, A8, A9.

## Tasks

- [ ] Verify first: WebSockets through a Magic Containers CDN endpoint (pull-zone toggle), SSE with `Cache-Control: no-cache`, a 3-minute tool call with keep-alives; if WebSockets fail, switch to the Anycast endpoint with TLS terminated in the relay (`Bun.serve` `tls`) and record it in the decision log
- [ ] App: image `ractive/tab-mcp:X.Y.Z` (amd64), one region, min = max = 1 replica, termination grace 30 s
- [ ] Env: `TAB_MCP_PUBLIC_URL=https://relay.ractive.ch`, `TAB_MCP_ALLOWED_ORIGINS` (ractive.ch/saturnus origin, calculator example origin), `TAB_MCP_TRUST_PROXY=x-real-ip`, limits
- [ ] Pull zone: WebSockets on, request coalescing off, no caching for the relay paths, custom hostname with TLS, IPv6 per zone policy
- [ ] Health checks on `/healthz` (startup, readiness, liveness)
- [ ] Privacy notice page at `/privacy` (what the relay sees and logs, retention, operator contact) and link from `/`
- [ ] Deploy workflow (manual dispatch) with `BunnyWay/actions/container-update-image` pinned by SHA; API key as a secret, recorded in `kb/operations/release-secrets.md` with renewal steps
- [ ] Re-run the iteration-4 manual compatibility checks against the hosted relay and update `docs/compatibility.md`
- [ ] Publish the example page (e.g. GitHub Pages) pointing at the hosted relay

## Acceptance criteria

- claude.ai, Claude Code and ChatGPT connect to the hosted example and call tools; a tool
  call longer than 60 s succeeds.
- A restart ends sessions cleanly (pages show "disconnected").
- `/healthz` monitored; privacy notice online.

## Test approach

Manual checks with each AI app, the e2e suite pointed at the hosted relay (smoke run), and
a load smoke (100 sessions, 10 req/s) against the limits.

# Citations

- [bunny.net research](/research/bunny-magic-containers.md)
