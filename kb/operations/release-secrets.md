---
type: operations
title: "Release credentials and how to renew them"
description: Which secrets and variables the release workflow uses, when they expire, and the steps to renew them when a publication fails.
tags:
  - release
  - operations
  - secrets
timestamp: 2026-10-19T23:45:00+02:00
---

# Release credentials and how to renew them

Start here when a publication fails with an authentication error.

## Docker Hub

| Name | Kind | Value |
|---|---|---|
| `DOCKERHUB_TOKEN` | repository secret (GitHub Actions) | Docker Hub personal access token, description "tab-mcp GitHub Actions", permission Read & Write |
| `DOCKERHUB_USERNAME` | repository variable | `ractive` |
| `DOCKERHUB_TOKEN_EXPIRES` | repository variable | `2027-10-19` |

- Created: 2026-10-19.
- **Expires: 2027-10-19 00:00:00** (valid 2026-10-19 → 2027-10-19).
- Symptom when expired: the Docker login or push step of the release workflow fails with
  an authentication error (`unauthorized` / `incorrect username or password`).
- Early warning: a scheduled workflow warns when the token is within 30 days of
  `DOCKERHUB_TOKEN_EXPIRES` (planned in
  [iteration 5](/iterations/iteration-5-packaging-release.md)).

### Renewal

1. hub.docker.com → avatar → Account settings → Personal access tokens → Generate new
   token, description "tab-mcp GitHub Actions", permission Read & Write, one-year expiry.
2. `gh secret set DOCKERHUB_TOKEN --repo ractive/tab-mcp` and paste the token at the
   prompt (it is not echoed; never pass it as an argument or put it in a file).
3. `gh variable set DOCKERHUB_TOKEN_EXPIRES --repo ractive/tab-mcp --body YYYY-MM-DD`
   with the new expiry date.
4. Delete the old token on Docker Hub.
5. Update the expiry date in this note and commit.
6. Re-run the failed release job.

## npm

Both packages (`@ractive-ch/tab-mcp`, `@ractive-ch/tab-mcp-client`) publish through npm
trusted publishing (OpenID Connect from GitHub Actions) with provenance. There is no
stored npm token, so nothing expires. The owner uploads the first version of each package
by hand; afterwards a trusted publisher (repository `ractive/tab-mcp`, workflow
`release.yml`, environment `release`) is configured per package on npmjs.com. If publishing
fails with a 403/404 from the registry, check that the trusted-publisher entry still names
the right repository, workflow file name and environment. Steps:
[npm publishing](/operations/npm-publishing.md).

## GitHub Container Registry (if used)

Pushes to ghcr.io use the workflow's own `GITHUB_TOKEN` with `packages: write`; nothing to
renew.

# Citations

- [Docker Hub personal access tokens](https://docs.docker.com/security/for-developers/access-tokens/)
- [gh secret set](https://cli.github.com/manual/gh_secret_set)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers)
- [npm publishing](/operations/npm-publishing.md)
