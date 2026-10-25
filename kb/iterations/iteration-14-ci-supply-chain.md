---
type: iteration
title: "Iteration 14: CI, release and repository settings"
status: completed
description: "Fixes from the 2026-10-24 supply-chain review: the Docker Hub token in the release environment, the release approval, Dependabot alerts and SHA pinning, Chrome in the client release job, pinned Chrome, job timeouts, source maps."
timestamp: 2026-10-24T21:00:00+02:00
tags: [iteration, security, ci]
---
# Iteration 14: CI, release and repository settings

From the CI, release and supply-chain review of 2026-10-24. Its first finding, `main`
without protection or required checks, the owner fixed the same day with branch
protection. The rest are GitHub settings (owner's call, applied with `gh api` once
approved) and workflow edits in `.github/`; nothing touches the packages, so this runs in
parallel with iterations 11 to 13.

## Findings and fixes

1. **Medium: the `release` environment has no required reviewer** (its only rule is the
   tag branch policy; `can_admins_bypass` is true). `release.yml:20-22` says the
   environment needs the owner's approval; it does not since the pause of 2026-10-20
   (`kb/operations/npm-publishing.md`). Fix: turn the reviewer back on with the command in
   that doc, or correct the comment and give the pause an end date.
2. **Medium: `DOCKERHUB_TOKEN` is a repository secret** (the environment has none;
   `kb/operations/release-secrets.md:20`). Every workflow can read it, including one added
   on a branch by anyone with write access. Fix: move the secret `DOCKERHUB_TOKEN` into
   the `release` environment; only `relay-image-publish` uses it. The variables
   `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN_EXPIRES` stay at repository level
   (`token-expiry.yml` has no environment and reads the expiry). Update
   `release-secrets.md`.
3. **Medium: Dependabot alerts and security updates are off; SHA pinning is not
   enforced** (`dependabot_security_updates: disabled`, `vulnerability-alerts` 404;
   `actions/permissions`: `sha_pinning_required: false`, `allowed_actions: all`). Fix:
   enable alerts and security updates; require SHA pinning (every action is already
   pinned); optionally allow only selected actions.
4. **Low: `client-pack` runs `bun run verify` without Chrome** (`release.yml`, the step
   guarded by `if: github.event_name != 'pull_request'`; `relay-pack` installs Chrome and
   sets `CHROME_PATH`). The client's browser tests pass on a release only because the
   runner image ships Chrome. Fix: the same `setup-chrome` step.
5. **Low: Chrome is installed as `stable`** (`ci.yml:22` and `release.yml`). A Chrome
   release can fail a run with no commit to blame. Fix: pin a version; let Dependabot or a
   deliberate bump move it.
6. **Low: no job timeouts** (no `timeout-minutes` anywhere; a hung step runs six hours).
   Fix: a timeout per job.
7. **Low: source maps ship in the Docker image and the npm tarballs** (`Dockerfile:29`
   copies `main.js.map`; `scripts/npm-pack.ts` lists `*.js.map`). The source is public, so
   this is size only. Decide: keep in npm (useful for debugging), drop from the image.

## Tasks

- [x] Ruleset on `main`: pull requests only, `verify` required (DEC-101)

- [x] 1: release approval stays off for now (owner); the comment in `release.yml` corrected (DEC-101)
- [x] 2: the secret `DOCKERHUB_TOKEN` moved into the `release` environment by the owner (a new token without expiry); the expiry check removed (DEC-102); `release-secrets.md`
- [x] 3: Dependabot alerts and security updates on; SHA pinning required (owner approves)
- [x] 4: Chrome in `client-pack`
- [x] 5: Chrome version pinned in CI and release
- [x] 6: `timeout-minutes` on every job
- [x] 7: source maps stay in the image (DEC-101)

# Citations

- [GitHub: deployment environments](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment)
- [GitHub: allowing actions and requiring SHA pinning](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
