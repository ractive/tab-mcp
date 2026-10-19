---
type: iteration
title: "Iteration 6: hosted relay on bunny.net"
description: Run the owner's public relay as a single Magic Containers instance behind the bunny CDN with a custom domain, health checks and a privacy notice.
status: planned
tags:
  - iteration
  - deployment
timestamp: 2026-10-20T00:15:00+02:00
---

# Iteration 6: hosted relay on bunny.net

Goal: a public relay (e.g. `relay.ractive.ch`) for pages on `https://ractive.ch` (saturnus
first). The calculator example keeps using a local relay (DEC-032).

Read first: [bunny.net research](/research/bunny-magic-containers.md),
[threat model](/design/threat-model.md) A5, A8, A9, DEC-029, 030, 032, 043, 044.

The hosted relay is infrastructure as code (DEC-043): OpenTofu with the official
`BunnyWay/bunnynet` provider, in a bunny account shared with other projects.

## Tasks

### Research first

- [ ] Provider support: does `BunnyWay/bunnynet` manage persistent volumes for container apps (needed for the `bun:sqlite` store at `/data`) and custom domains on container apps (or only through a pull zone)?
- [ ] API keys: does bunny offer API keys limited in scope (per product or per resource)? If not, record that the key in CI can change the whole shared account, and keep its use to the plan/apply jobs
- [ ] State backend on a bunny storage zone (DEC-044): check the S3 API's current status and URL style (preview/beta; the docs disagree on path-style versus virtual-hosted) and the backend settings it needs (custom endpoint, path-style, skipped AWS-specific validations: credentials, region, metadata API, account id)
- [ ] State locking: test with a throwaway state whether bunny's S3 API supports conditional writes (OpenTofu's native S3 locking, `use_lockfile`); if not, rely on the fallback of DEC-044 and record it

### Infrastructure as code (DEC-043)

- [ ] Owner step: create the storage zone `tab-mcp-tfstate` (region `de`) **with S3 compatibility enabled at creation** (it cannot be added later) and an S3 access key for it; set the GitHub Actions secrets `BUNNY_API_KEY`, the zone's S3 access key and secret (e.g. `TOFU_STATE_S3_ACCESS_KEY`, `TOFU_STATE_S3_SECRET_KEY`) and `TOFU_STATE_PASSPHRASE` with `gh secret set`
- [ ] `infra/backend.tf`: S3 backend pointing at the storage zone (custom endpoint, path-style, AWS validations skipped), OpenTofu client-side state encryption (`encryption` block, PBKDF2 key provider from `TOFU_STATE_PASSPHRASE`, enforced for state and plan files) so the zone holds only ciphertext
- [ ] `infra/` with OpenTofu, the `BunnyWay/bunnynet` provider pinned exactly: `bunnynet_compute_container_imageregistry` (Docker Hub or ghcr.io, public image), `bunnynet_compute_container_app` (image, region, replicas, env, health checks), plus pull zone and a single DNS record as needed
- [ ] Shared account rules: every resource name starts with `tab-mcp-`; never manage shared resources (manage one DNS record such as `relay` in the existing zone, never the zone itself); OpenTofu only manages its own state
- [ ] Workflow `infra.yml`: `tofu fmt -check`, `validate` and `plan` on pull requests touching `infra/` (plan as a PR comment or job summary), `apply` on main and by manual dispatch; a workflow-wide `concurrency` group (`tab-mcp-infra`, no cancel-in-progress) so only one plan/apply touches the state at a time; actions pinned by SHA; all bunny and state credentials only as GitHub Actions secrets, never on a developer machine
- [ ] Record `BUNNY_API_KEY`, the storage zone's S3 key pair and `TOFU_STATE_PASSPHRASE` in `kb/operations/release-secrets.md` with renewal steps (a lost passphrase makes the state unreadable: note where the owner keeps a copy)

### Deployment

- [ ] Verify first: WebSockets through a Magic Containers CDN endpoint (pull-zone toggle), SSE with `Cache-Control: no-cache`, a 3-minute tool call with keep-alives; if WebSockets fail, switch to the Anycast endpoint with TLS terminated in the relay (`Bun.serve` `tls`) and record it in the decision log
- [ ] App (in OpenTofu): image `ractive/tab-mcp:X.Y.Z` (amd64), one region, min = max = 1 replica, termination grace 30 s
- [ ] Env: `TAB_MCP_PUBLIC_URL=https://relay.ractive.ch`, `TAB_MCP_ALLOWED_ORIGINS=https://ractive.ch` (exactly; browsers send no path), `TAB_MCP_TRUST_PROXY=x-real-ip`, limits
- [ ] Persistent storage for the SQLite token store (`/data`): verify that Magic Containers offers a persistent volume; if not, record in the decision log that a deploy logs out every AI app (re-pairing needed) or choose a hosted store
- [ ] Pull zone: WebSockets on, request coalescing off, no caching for the relay paths, custom hostname with TLS, IPv6 per zone policy
- [ ] Health checks on `/healthz` (startup, readiness, liveness)
- [ ] Privacy notice page at `/privacy` (what the relay sees and logs, retention, operator contact) and link from `/`
- [ ] Image updates through OpenTofu (the image tag is a variable); `BunnyWay/actions/container-update-image` only if a tag bump through OpenTofu turns out impractical, and then recorded in the decision log
- [ ] Re-run the iteration-4 manual compatibility checks against the hosted relay and update `docs/compatibility.md`
- [ ] A minimal smoke page on `https://ractive.ch` (owner's site) to check the hosted relay until saturnus integrates it

## Acceptance criteria

- claude.ai, Claude Code and ChatGPT pair with the smoke page on `https://ractive.ch` and
  call tools; a tool call longer than 60 s succeeds.
- A tab from any other origin is refused.
- A restart ends sessions cleanly (pages show "disconnected"); AI apps keep their grants if
  the store is persistent.
- `/healthz` monitored; privacy notice online.

## Test approach

Manual checks with each AI app, the e2e suite pointed at the hosted relay (smoke run), and
a load smoke (100 sessions, 10 req/s) against the limits.

# Citations

- [bunny.net research](/research/bunny-magic-containers.md)
- [bunny.net Terraform resources](https://docs.bunny.net/integrations/terraform/resources)
- [BunnyWay/bunnynet provider](https://registry.terraform.io/providers/BunnyWay/bunnynet/latest)
- [OpenTofu state encryption](https://opentofu.org/docs/language/state/encryption/)
- [bunny.net Storage S3 compatibility](https://docs.bunny.net/storage/s3)
- [OpenTofu S3 backend](https://opentofu.org/docs/language/settings/backends/s3/)
