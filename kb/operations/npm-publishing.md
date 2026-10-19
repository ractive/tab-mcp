---
type: operations
title: "npm publishing: bootstrap and releases"
description: The owner's one-time steps to put @ractive-ch/tab-mcp-client on npm from a CI-signed tarball and switch on trusted publishing, and how every later release works.
tags:
  - release
  - operations
  - npm
timestamp: 2026-10-20T00:30:00+02:00
---

# npm publishing: bootstrap and releases

How `@ractive-ch/tab-mcp-client` gets to npm (DEC-055). The relay `@ractive-ch/tab-mcp`
follows the same steps later with the tag `relay-v<version>`.

npm trusted publishing (GitHub OIDC, no token) only works for a package that already
exists. So the first version is uploaded once by the owner, from a tarball that CI built,
packed and signed with provenance; every later version is published by the release
workflow.

## What protects a publication

- The workflow refuses to bootstrap from anything but `main`, and refuses to bootstrap or
  publish a commit that is not on `main`. This catches mistakes only: a release runs the
  workflow file of the tagged commit, so a tag on an unreviewed commit could carry a
  changed workflow without these checks.
- What actually guards publishing: only the owner can create, move or delete release tags
  (a tag ruleset), the trusted publisher on npm accepts only `release.yml` in the
  environment `release`, and that environment accepts only release tags and waits for the
  owner's approval. Set these up (step 1) before the trusted publisher exists (step 7).

## One-time bootstrap (owner)

Needs: an npm login as `ractive.ch` (owner of the `ractive-ch` organisation, two-factor
authentication on); npm 11.5.1 or newer and Node 22.14 or newer on the computer. Run the
commands in an up-to-date checkout of `main`.

1. Protect release tags and the `release` environment:

   ```sh
   # Only repository admins (the owner) may create, move or delete client-v*/relay-v* tags.
   gh api -X POST repos/ractive/tab-mcp/rulesets --input - <<'EOF'
   {"name": "release tags", "target": "tag", "enforcement": "active",
    "conditions": {"ref_name": {"include": ["refs/tags/client-v*", "refs/tags/relay-v*"], "exclude": []}},
    "rules": [{"type": "creation"}, {"type": "update"}, {"type": "deletion"}],
    "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]}
   EOF
   # Environment `release`: the owner (GitHub user id 783861) approves each run; release tags only.
   gh api -X PUT repos/ractive/tab-mcp/environments/release --input - <<'EOF'
   {"reviewers": [{"type": "User", "id": 783861}], "prevent_self_review": false,
    "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
   EOF
   gh api -X POST repos/ractive/tab-mcp/environments/release/deployment-branch-policies \
     -f name='client-v*' -f type=tag
   ```

   (Same in the web UI: Settings → Rules → Rulesets → New tag ruleset; Settings →
   Environments → `release`.)

2. Start the bootstrap run on `main` and wait for it:

   ```sh
   gh workflow run release.yml --repo ractive/tab-mcp --ref main \
     -f package=client -f mode=bootstrap -f version=0.1.0-alpha.0
   gh run list --repo ractive/tab-mcp --workflow release.yml --event workflow_dispatch --limit 1
   gh run watch <run-id> --repo ractive/tab-mcp
   ```

   Jobs `plan`, `client-pack` (on-main check, verify, build, pack, checks, dry-run publish,
   install test) and `client-bootstrap` (signs the tarball) must be green.

3. Download the artifact `npm-bootstrap-tab-mcp-client-0.1.0-alpha.0` into a new, empty
   directory:

   ```sh
   dir=$(mktemp -d)
   gh run download <run-id> --repo ractive/tab-mcp \
     -n npm-bootstrap-tab-mcp-client-0.1.0-alpha.0 -D "$dir"
   ls "$dir"   # ractive-ch-tab-mcp-client-0.1.0-alpha.0.tgz, .sigstore.json, pack.json
   ```

4. Check the bundle and the tarball (nothing is uploaded):

   ```sh
   node scripts/npm-provenance.mjs verify \
     "$dir/ractive-ch-tab-mcp-client-0.1.0-alpha.0.tgz" \
     "$dir/ractive-ch-tab-mcp-client-0.1.0-alpha.0.sigstore.json"
   npm publish "$dir/ractive-ch-tab-mcp-client-0.1.0-alpha.0.tgz" --dry-run \
     --tag alpha --access public
   ```

   The first command runs npm's own check (`--provenance-file` runs the same), prints
   repository, workflow, ref, commit and run, and ends with `signer accepted` only for
   `https://github.com/ractive/tab-mcp`, `.github/workflows/release.yml` and
   `refs/heads/main` (or `refs/tags/client-v0.1.0-alpha.0`).

5. Publish that unchanged tarball with the CI-signed provenance:

   ```sh
   npm login
   npm publish "$dir/ractive-ch-tab-mcp-client-0.1.0-alpha.0.tgz" \
     --provenance-file "$dir/ractive-ch-tab-mcp-client-0.1.0-alpha.0.sigstore.json" \
     --tag alpha --access public --registry https://registry.npmjs.org
   ```

   Do not add `--provenance` (it cannot be combined with `--provenance-file`). npm asks for
   the browser login or a one-time password.

6. Check it:

   ```sh
   npm view @ractive-ch/tab-mcp-client dist-tags
   npm view @ractive-ch/tab-mcp-client@0.1.0-alpha.0 dist.integrity  # equals pack.json's integrity
   ```

   The package page on npmjs.com shows "Provenance". Expect `latest: 0.1.0-alpha.0` next to
   `alpha` (see "Known issue: latest" below).

7. Configure the trusted publisher. On npmjs.com: package `@ractive-ch/tab-mcp-client` →
   Settings → Trusted publishing → GitHub Actions, with

   | Field | Value |
   |---|---|
   | Organization or user | `ractive` (the GitHub owner, not the npm organisation) |
   | Repository | `tab-mcp` |
   | Workflow filename | `release.yml` |
   | Environment | `release` |

   Or from the command line (needs `npm trust`, present in npm 11.17):

   ```sh
   npm trust github @ractive-ch/tab-mcp-client --repo ractive/tab-mcp \
     --file release.yml --env release --allow-publish
   npm trust list @ractive-ch/tab-mcp-client
   ```

   Then, under Settings → Publishing access, choose "Require two-factor authentication and
   disallow tokens"; trusted publishing keeps working.

8. Create the GitHub release for the version, on the commit the bootstrap run built
   (`gh run view <run-id> --repo ractive/tab-mcp --json headSha --jq .headSha`):

   ```sh
   gh release create client-v0.1.0-alpha.0 --repo ractive/tab-mcp --target <head-sha> \
     --prerelease --title "tab-mcp-client 0.1.0-alpha.0" --notes "First alpha of the browser library."
   ```

   Approve the run's `client-publish` job (environment `release`) in the Actions tab. It
   rebuilds the same bytes, finds the version on npm with the same integrity and skips. The
   first OIDC publication happens with the next version.

## Later releases

1. Set the new version in `packages/tab-mcp-client/package.json`,
   `packages/tab-mcp-client/src/version.ts` and the CDN link in
   `packages/tab-mcp-client/README.md` (tests keep all three equal), run `bun install`
   (the lockfile records it), add a `CHANGELOG.md` entry, merge to `main`.
2. Create a GitHub release with the tag `client-v<version>` on exactly that merge commit,
   not on whatever `main` points to by then. Mark it as a pre-release exactly when the
   version is one (`0.1.0-alpha.1`, `0.2.0-beta.0`, `1.0.0-rc.1`); a stable version is a
   normal release:

   ```sh
   sha=$(gh pr view <pr-number> --repo ractive/tab-mcp --json mergeCommit --jq .mergeCommit.oid)
   gh release create client-v0.1.0-alpha.1 --repo ractive/tab-mcp --target "$sha" \
     --prerelease --title "tab-mcp-client 0.1.0-alpha.1" --notes-file notes.md
   ```

3. Approve the `client-publish` job. The run checks that the commit is on `main` and that
   the tag matches the version, builds, tests, packs, dry-runs, then publishes with
   `npm publish --provenance --tag <alpha|beta|rc|latest>` through OIDC. Pre-releases never
   get `latest`; a stable version lower than the current `latest` is refused, so `latest`
   never moves backwards.
4. To retry a failed publication without a new release, run the workflow on the tag:

   ```sh
   gh workflow run release.yml --repo ractive/tab-mcp --ref client-v0.1.0-alpha.1 \
     -f package=client -f mode=publish -f version=0.1.0-alpha.1
   ```

A dry run of everything except signing and publishing runs on every pull request that
touches the client package or the workflow, and by hand with `-f mode=dry-run` on any
branch.

## Known issue: latest

A package cannot exist without a `latest` dist-tag: the registry sets it on the first
publication even with `--tag alpha`, and does not let it be removed (`npm dist-tag rm …
latest` is refused; not tried here, since it cannot be undone); it can only be pointed at
another version. So `latest` stays at
`0.1.0-alpha.0` while the workflow puts later alphas on `alpha` only, until the first
stable version moves it. `npm install @ractive-ch/tab-mcp-client` therefore gets
`0.1.0-alpha.0`; the README says to install `@alpha`.

Decision (DEC-055): leave it there. If an old alpha behind `latest` becomes a problem, the
owner may move it by hand, logged in:

```sh
npm dist-tag add @ractive-ch/tab-mcp-client@<newest-alpha> latest
npm dist-tag ls @ractive-ch/tab-mcp-client
```

## When it fails

- `E403`/`E404` from the registry on publish: the trusted publisher must name repository
  `ractive/tab-mcp`, workflow `release.yml` and environment `release` exactly.
- "is not on main": tag the merge commit on `main`, not a branch commit.
- "already published with other bytes": npm versions are immutable; release a new version.
- "would move latest backwards": a stable version below `latest` (a backport) needs its own
  dist-tag, which the workflow does not support yet.
- "release tag … does not match" or "marked as a pre-release": fix the GitHub release, or
  the version in `package.json`.
- The run waits: approve the `release` environment in the Actions tab.

# Citations

- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
- [npm trust](https://docs.npmjs.com/cli/commands/npm-trust)
- [npm dist-tag](https://docs.npmjs.com/cli/commands/npm-dist-tag)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub rulesets](https://docs.github.com/en/rest/repos/rules)
- [Release workflow](https://github.com/ractive/tab-mcp/blob/main/.github/workflows/release.yml)
