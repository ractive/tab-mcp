---
type: operations
title: "Release credentials and how to renew them"
description: Which secrets and variables the release workflow uses, when they expire, and the steps to renew them when a publication fails.
tags:
  - release
  - operations
  - secrets
timestamp: 2026-10-20T07:10:00+02:00
---

# Release credentials and how to renew them

Start here when a publication fails with an authentication error.

## Docker Hub

| Name | Kind | Value |
|---|---|---|
| `DOCKERHUB_TOKEN` | repository secret (GitHub Actions) | Docker Hub personal access token, description "tab-mcp GitHub Actions", permission Read & Write |
| `DOCKERHUB_USERNAME` | repository variable | `ractive` |
| `DOCKERHUB_TOKEN_EXPIRES` | repository variable | `2027-10-19` |

Planned (DEC-101): `DOCKERHUB_TOKEN` becomes a secret of the `release` environment, so
only the release jobs can read it. A secret cannot be read back, so the token has to be
entered again (the current one, or a new one created as below):

1. `gh secret set DOCKERHUB_TOKEN --repo ractive/tab-mcp --env release` and paste the
   token at the prompt.
2. `gh secret delete DOCKERHUB_TOKEN --repo ractive/tab-mcp` (the repository secret).
3. Change the table above to "secret of the `release` environment". The variables stay
   at repository level: `token-expiry.yml` has no environment and reads the expiry.

- Created: 2026-10-19.
- **Expires: 2027-10-19 00:00:00** (valid 2026-10-19 → 2027-10-19).
- Symptom when expired: the Docker login or push step of the release workflow fails with
  an authentication error (`unauthorized` / `incorrect username or password`).
- Early warning: the workflow `token-expiry.yml` runs on the first of every month and
  fails when `DOCKERHUB_TOKEN_EXPIRES` is 30 days away or less, or not set; the release's
  image job warns then and fails once the date has passed (DEC-070). Run it by hand with
  `gh workflow run token-expiry.yml --repo ractive/tab-mcp` after a renewal.

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

## GitHub Container Registry

Pushes to `ghcr.io/ractive/tab-mcp` use the workflow's own `GITHUB_TOKEN` with
`packages: write`; nothing to renew. The package is private after its first push until
the owner makes it public ([npm publishing](/operations/npm-publishing.md), relay step 5).

# Citations

- [Docker Hub personal access tokens](https://docs.docker.com/security/for-developers/access-tokens/)
- [gh secret set](https://cli.github.com/manual/gh_secret_set)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers)
- [npm publishing](/operations/npm-publishing.md)
