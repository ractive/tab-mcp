---
type: iteration
title: "Iteration 6: deployment documentation and examples"
description: Generic, secret-free deployment docs and examples for running a tab-mcp relay (Docker, a bunny.net Magic Containers example); the owner's ractive.ch instance is deployed from the private ractive/ractive.ch repository.
status: in-progress
tags:
  - iteration
  - deployment
timestamp: 2026-10-20T00:45:00+02:00
---

# Iteration 6: deployment documentation and examples

**Changed 2026-10-19 (DEC-046):** this open-source repository holds no
deployment secrets and no owner infrastructure. The owner's hosted relay for
`https://ractive.ch` is planned and deployed from the private repository
`ractive/ractive.ch` (its `kb/iterations/iteration-07-infra-bunny.md`,
`infra/relay/`), using a released `ractive/tab-mcp` image. The research and
OpenTofu work from the earlier version of this iteration moved there.

What stays here, generic and secret-free:

## Tasks

- [x] Deployment docs: running the relay with Docker (`docker run`, volume for the SQLite store, every `TAB_MCP_*` setting, sites/origins, TLS termination by a proxy or CDN, health endpoint, the 60 s header limit of some CDNs and the keep-alives). Done by extending and reorganising `docs/self-hosting.md` (it already covered Docker) instead of a parallel `docs/deploy.md`: one instance, data volume and permissions, production settings, proxy/CDN checklist, `/healthz` and log events, resource limits, lessons from the CDN deployment
- [-] ~~An example OpenTofu module for bunny.net Magic Containers in `examples/deploy-bunny/`~~ Dropped by the owner (2026-10-21): too specific; the deployment docs cover bunny.net generically
- [x] Operations notes: backups of the SQLite file, upgrading between versions, what a restart does to sessions and tokens (`docs/self-hosting.md`, "Operations": backups, upgrading, rollback, restarts, ending every connection)
- [x] Privacy template: what an operator should tell users (what passes through the relay, what is stored) (`docs/privacy-template.md`)
- [ ] Manual compatibility checks against the deployed relay (moved from iteration 4): claude.ai custom connector, Claude Desktop, ChatGPT developer mode; record app, version, date, revision, auth and result in `docs/compatibility.md`. The claude.ai custom connector (2026-10-20), Codex (2026-10-23) and Claude Desktop (2026-10-25) are recorded there already, all work; ChatGPT needs the owner's account

# Citations

- bunny.net Terraform provider resources: <https://docs.bunny.net/integrations/terraform/resources>
- bunny.net Magic Containers: <https://bunny.net/docs/magic-containers>
