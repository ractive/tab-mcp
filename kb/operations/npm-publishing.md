---
type: operations
title: "npm publishing: bootstrap and releases"
description: The owner's one-time steps to put @ractive-ch/tab-mcp-client on npm from a CI-signed tarball and switch on trusted publishing, and how every later release works.
tags:
  - release
  - operations
  - npm
timestamp: 2026-10-19T23:45:00+02:00
---

# npm publishing: bootstrap and releases

How `@ractive-ch/tab-mcp-client` gets to npm (DEC-055). The relay `@ractive-ch/tab-mcp`
follows the same steps later with the tag `relay-v<version>`.

npm trusted publishing (GitHub OIDC, no token) only works for a package that already
exists. So the first version is uploaded once by the owner, from a tarball that CI built,
packed and signed with provenance; every later version is published by the release
workflow.

## One-time bootstrap (owner)

Needs: the release workflow on `main`; an npm login as `ractive.ch` (owner of the
`ractive-ch` organisation, two-factor authentication on); npm 11.5.1 or newer and Node 22.14
or newer on the computer. Run the commands in a checkout of `main`.

1. Start the bootstrap run on `main` and wait for it:

   ```sh
   gh workflow run release.yml --repo ractive/tab-mcp --ref main \
     -f package=client -f mode=bootstrap -f version=0.1.0-alpha.0
   gh run list --repo ractive/tab-mcp --workflow release.yml --event workflow_dispatch --limit 1
   gh run watch <run-id> --repo ractive/tab-mcp
   ```

   Jobs `plan`, `client-pack` (verify, build, pack, checks, dry-run publish, install test)
   and `client-bootstrap` (signs the tarball) must be green.

2. Download the artifact `npm-bootstrap-tab-mcp-client-0.1.0-alpha.0` into a new, empty
   directory:

   ```sh
   dir=$(mktemp -d)
   gh run download <run-id> --repo ractive/tab-mcp \
     -n npm-bootstrap-tab-mcp-client-0.1.0-alpha.0 -D "$dir"
   ls "$dir"   # ractive-ch-tab-mcp-client-0.1.0-alpha.0.tgz, .sigstore.json, pack.json
   ```

3. Check the bundle and the tarball (nothing is uploaded):

   ```sh
   node scripts/npm-provenance.mjs verify \
     "$dir/ractive-ch-tab-mcp-client-0.1.0-alpha.0.tgz" \
     "$dir/ractive-ch-tab-mcp-client-0.1.0-alpha.0.sigstore.json"
   npm publish "$dir/ractive-ch-tab-mcp-client-0.1.0-alpha.0.tgz" --dry-run \
     --tag alpha --access public
   ```

   The first command runs npm's own check (`--provenance-file` runs the same) and prints
   repository `https://github.com/ractive/tab-mcp`, workflow
   `.github/workflows/release.yml @ refs/heads/main`, the commit and the run.

4. Publish that unchanged tarball with the CI-signed provenance:

   ```sh
   npm login
   npm publish "$dir/ractive-ch-tab-mcp-client-0.1.0-alpha.0.tgz" \
     --provenance-file "$dir/ractive-ch-tab-mcp-client-0.1.0-alpha.0.sigstore.json" \
     --tag alpha --access public --registry https://registry.npmjs.org
   ```

   Do not add `--provenance` (it cannot be combined with `--provenance-file`). npm asks for
   the browser login or a one-time password.

5. Check it:

   ```sh
   npm view @ractive-ch/tab-mcp-client dist-tags
   npm view @ractive-ch/tab-mcp-client@0.1.0-alpha.0 dist.integrity  # equals pack.json's integrity
   ```

   The package page on npmjs.com shows "Provenance". A brand-new package always gets a
   `latest` tag, so `latest` may point to `0.1.0-alpha.0` too until the first stable
   version; that is the registry's doing and harmless.

6. Configure the trusted publisher. On npmjs.com: package `@ractive-ch/tab-mcp-client` →
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

7. Limit the GitHub environment `release` to release tags, so a workflow run from any
   branch cannot publish:

   ```sh
   gh api -X PUT repos/ractive/tab-mcp/environments/release --input - <<'EOF'
   {"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
   EOF
   gh api -X POST repos/ractive/tab-mcp/environments/release/deployment-branch-policies \
     -f name='client-v*' -f type=tag
   ```

8. Create the GitHub release for the version, on the commit the bootstrap run built
   (`gh run view <run-id> --repo ractive/tab-mcp --json headSha --jq .headSha`):

   ```sh
   gh release create client-v0.1.0-alpha.0 --repo ractive/tab-mcp --target <head-sha> \
     --prerelease --title "tab-mcp-client 0.1.0-alpha.0" --notes "First alpha of the browser library."
   ```

   Its release run rebuilds the same bytes, finds the version on npm with the same
   integrity and skips it. The first OIDC publication happens with the next version.

## Later releases

1. Set the new version in `packages/tab-mcp-client/package.json` and
   `packages/tab-mcp-client/src/version.ts` (a test keeps them equal), run `bun install`
   (the lockfile records it), add a `CHANGELOG.md` entry, merge to `main`.
2. Create a GitHub release with the tag `client-v<version>` on that commit. Mark it as a
   pre-release exactly when the version is one (`0.1.0-alpha.1`, `0.2.0-beta.0`,
   `1.0.0-rc.1`); a stable version is a normal release:

   ```sh
   gh release create client-v0.1.0-alpha.1 --repo ractive/tab-mcp --target main --prerelease \
     --title "tab-mcp-client 0.1.0-alpha.1" --notes-file notes.md
   ```

3. The release run checks the tag against the version, builds, tests, packs, dry-runs, then
   publishes with `npm publish --provenance --tag <alpha|beta|rc|latest>` through OIDC in
   the environment `release`. Pre-releases never get `latest`.
4. To retry a failed publication without a new release, run the workflow on the tag:

   ```sh
   gh workflow run release.yml --repo ractive/tab-mcp --ref client-v0.1.0-alpha.1 \
     -f package=client -f mode=publish -f version=0.1.0-alpha.1
   ```

A dry run of everything except signing and publishing runs on every pull request that
touches the client package or the workflow, and by hand with `-f mode=dry-run`.

## When it fails

- `E403`/`E404` from the registry on publish: the trusted publisher must name repository
  `ractive/tab-mcp`, workflow `release.yml` and environment `release` exactly.
- "already published with other bytes": npm versions are immutable; release a new version.
- "release tag … does not match" or "marked as a pre-release": fix the GitHub release, or
  the version in `package.json`.

# Citations

- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
- [npm trust](https://docs.npmjs.com/cli/commands/npm-trust)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Release workflow](https://github.com/ractive/tab-mcp/blob/main/.github/workflows/release.yml)
