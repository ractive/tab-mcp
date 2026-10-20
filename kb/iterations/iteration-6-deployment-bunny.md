---
type: iteration
title: "Iteration 6: deployment documentation and examples"
description: Generic, secret-free deployment docs and examples for running a tab-mcp relay (Docker, a bunny.net Magic Containers example); the owner's ractive.ch instance is deployed from the private ractive/ractive.ch repository.
status: planned
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

- [ ] `docs/deploy.md`: running the relay with Docker (`docker run`, volume for the SQLite store, every `TAB_MCP_*` setting, sites/origins, TLS termination by a proxy or CDN, health endpoint, the 60 s header limit of some CDNs and the keep-alives)
- [ ] An example OpenTofu module for bunny.net Magic Containers in `examples/deploy-bunny/` (no state, no secrets, placeholders only), documented as an example, not as the owner's setup
- [ ] Operations notes: backups of the SQLite file, upgrading between versions, what a restart does to sessions and tokens
- [ ] Privacy template: what an operator should tell users (what passes through the relay, what is stored)
- [ ] Manual compatibility checks against the deployed relay (moved from iteration 4): claude.ai custom connector, Claude Desktop, ChatGPT developer mode; record app, version, date, revision, auth and result in `docs/compatibility.md`

# Citations

- bunny.net Terraform provider resources: <https://docs.bunny.net/integrations/terraform/resources>
- bunny.net Magic Containers: <https://bunny.net/docs/magic-containers>
