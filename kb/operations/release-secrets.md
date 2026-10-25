---
type: operations
title: "Release credentials and how to renew them"
description: Which secrets and variables the release workflow uses and the steps to renew them when a publication fails.
tags:
  - release
  - operations
  - secrets
timestamp: 2026-10-25T16:45:00+02:00
---

# Release credentials and how to renew them

Start here when a publication fails with an authentication error.

## Docker Hub

| Name | Kind | Value |
|---|---|---|
| `DOCKERHUB_TOKEN` | secret of the `release` environment (GitHub Actions) | Docker Hub personal access token, description "tab-mcp GitHub Actions", permission Read & Write, no expiry |
| `DOCKERHUB_USERNAME` | repository variable | `ractive` |

Only the jobs in the `release` environment can read the token (DEC-101); it moved there
on 2026-10-25, and the repository secret was deleted.

- Created: 2026-10-25, without an expiry date, so there is no expiry check (DEC-102).
- Symptom when it stops working (revoked, or the account changed): the Docker login or
  push step of the release workflow fails with an authentication error (`unauthorized` /
  `incorrect username or password`).

### Renewal

1. hub.docker.com → avatar → Account settings → Personal access tokens → Generate new
   token, description "tab-mcp GitHub Actions", permission Read & Write.
2. `gh secret set DOCKERHUB_TOKEN --repo ractive/tab-mcp --env release` and paste the
   token at the prompt (it is not echoed; never pass it as an argument or put it in a file).
3. Delete the old token on Docker Hub.
4. Re-run the failed release job.

## npm

Both packages (`@ractive-ch/tab-mcp`, `@ractive-ch/tab-mcp-client`) publish through npm
trusted publishing (OpenID Connect from GitHub Actions) with provenance. There is no
stored npm token, so nothing expires. The owner uploads the first version of each package
by hand; afterwards a trusted publisher (repository `ractive/tab-mcp`, workflow
`release.yml`, environment `release`) is configured per package on npmjs.com. If publishing
fails with a 403/404 from the registry, check that the trusted-publisher entry still names
the right repository, workflow file name and environment. Steps:
[npm publishing](/operations/npm-publishing.md).

## GitHub Container Registry

Pushes to `ghcr.io/ractive/tab-mcp` use the workflow's own `GITHUB_TOKEN` with
`packages: write`; nothing to renew. The package is private after its first push until
the owner makes it public ([npm publishing](/operations/npm-publishing.md), relay step 5).

# Citations

- [Docker Hub personal access tokens](https://docs.docker.com/security/for-developers/access-tokens/)
- [gh secret set](https://cli.github.com/manual/gh_secret_set)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers)
- [npm publishing](/operations/npm-publishing.md)
