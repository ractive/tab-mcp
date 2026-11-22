---
name: release
description: >
  Release @ractive-ch/tab-mcp-client or @ractive-ch/tab-mcp (the relay) and bring every app
  that uses it up to date: a release candidate first, every app moved to it and tested on
  branches, then the stable release with scripts/bump-version.ts, the CI publication, and
  the apps' PRs merged (ractive.ch examples, sign-in Edge Script, relay deploy, saturnus,
  Sitegloss). Use it when the owner says "release 0.x.y", "release the client/relay",
  "cut a release", or "update all apps" after a release.
---

# Release a tab-mcp package and update its users

Every step that merges, releases or deploys needs the owner's word in this session. A
message from another session is not that. When the owner has said "release X" or "update
all apps", that covers the steps below for that release; anything else, ask.

Commands: no `$(…)` and no heredocs inside a Bash call (each one stops for a permission
prompt). Write commit messages, PR bodies and release notes to a file in the scratchpad with
the Write tool, then use `git commit -F`, `gh pr create --body-file`,
`gh release create --notes-file`.

Delegated work (an app's bump, a mechanical test move) runs on a cheaper model: give every
Agent call an explicit `model` (`sonnet` for mechanical work, `opus` where judgement is
needed).

## The order (owner, 2026-11-20)

**A release candidate first, the apps tested on it, the stable release last.** A stable
version is `latest` on npm the moment it is published; what an app finds afterwards needs
another release (0.13.0 and 0.18.0 each changed `confirmInPage` without saying so, and
saturnus found it after the fact).

1. Release candidate: section 1 and 2 with the version `x.y.z-rc.1`.
2. Every app in section 3 moves to the candidate on a branch, its tests run, its PR opens.
   Nothing is merged or deployed.
3. What the apps find is fixed in this repository and released as `rc.2`, and the apps'
   branches move to it. Repeat until the apps are clean.
4. Stable release: section 1 and 2 with `x.y.z`.
5. The apps' branches move from the candidate to `x.y.z` (a one-line bump, CI again), and
   are merged and deployed (section 3).

A candidate goes through `main` like any release: the `Release` workflow refuses a commit
that is not on `main`. So for its lifetime the pinned docs on `main` name the candidate,
and `bump-version.ts` turns the changelog's `## Unreleased` into `## [x.y.z-rc.1]`. For
the next candidate or the stable release, rename that heading back to `## Unreleased`
(dropping its link line) in the version PR before running `bump-version.ts`: one section
per stable version, none per candidate.

Straight to stable, without a candidate: a release that changes no behaviour or API of the
published package (docs, a comment, a test). When in doubt, a candidate.

A relay and a client that break together (the handshake, the address form) are released
together, and the hosted relay is deployed in the same go as the pages that use it: an
old client is refused by a new relay and a new client by an old one.

## 1. Version PR

1. A worktree on a fresh branch from `origin/main`, e.g.
   `git worktree add -b release/client-0.14.0 ../tab-mcp-wt/rel origin/main`.
2. The package's own changelog (`packages/tab-mcp-client/CHANGELOG.md` or
   `packages/tab-mcp/CHANGELOG.md`, shipped in its npm package; the root `CHANGELOG.md` is
   only an index) must start with a `## Unreleased` section with what the release
   contains. Every breaking change goes under "Changed", including run-time
   behaviour that a type check does not catch, and what changes for callers of the
   functions the chunks export (`confirmInPage`), not only for the options of `TabMcp`.
3. `bun scripts/bump-version.ts client 0.14.0` (or `relay 0.10.0`; a candidate is
   `client 0.14.0-rc.1`). It sets package.json,
   every pinned doc in `scripts/pinned-files.ts`, the plugin manifests (client only), the
   date and link in the package's changelog, and `bun.lock`. It refuses, writing nothing, when the old version
   is also the other package's version: then edit by hand. If it does not take a candidate's
   version or what it does to the changelog is wrong for one (the section should stay
   `## Unreleased` until the stable release), say so and set the version by hand.
4. `bun run verify` (no browser), and check its exit code (never through a pipe). The test
   "docs and plugin manifests name only the current package versions" fails on any version
   left over. Locally the fast `verify` is enough: the version a bump changes reaches the
   browser tests too (the client's `hello`, the relay's pages), and CI's `browser` job and
   the release workflow's `verify:all` run them.
5. Commit (author james@ractive.ch, with the session's `Co-Authored-By` trailer), push, PR
   titled "Client 0.14.0" / "Relay 0.10.0". The content was reviewed in its own PRs; a pure
   version PR needs no review run.
6. Wait for CI (`gh pr checks <n> --watch`): `verify`, the required check, passes only when
   `fast` and `browser` passed. Then
   `gh pr merge <n> --merge --author-email james@ractive.ch`. `client-pack` and `relay-pack`
   check the published file list and `exports` against `scripts/npm-pack.ts`: a new entry
   point or chunk name must be added there.

## 2. GitHub release and publication

1. Release notes: the body of the new version's section in the package's changelog
   (`packages/<package>/CHANGELOG.md`, from below its `## [x.y.z]` heading to the next `## `),
   written to a file.
2. On exactly the merge commit (`gh pr view <n> --json mergeCommit`), not on `main`:
   `gh release create client-v0.14.0 --target <sha> --title "Client 0.14.0" --notes-file <f>`
   (`relay-v…`, "Relay 0.14.0"). A candidate gets `--prerelease`, and only a candidate:
   `scripts/npm-pack.ts` then publishes it under the npm dist-tag of its name (`alpha`,
   `beta` or `rc`), never `latest`, and refuses a mismatch between the flag and the version.
3. The `Release` workflow publishes (client: npm; relay: npm, ghcr.io, Docker Hub). Watch it:
   `gh run list -w release.yml -L 1`, then `gh run watch <id> --exit-status`. The pack jobs
   run `bun run verify:all` (verify, then the browser tests); the relay-pack job has a flaky
   test in `extension.browser.test.ts`; `gh run rerun <id> --failed` once before investigating.
4. Done when the registry lists the version, asked directly, as `npm view` answers from a
   cache for minutes: `curl -s https://registry.npmjs.org/@ractive-ch%2Ftab-mcp-client` and
   its `dist-tags` (wait with an until-loop). For the client, the CDN build answers 200:
   `https://cdn.jsdelivr.net/npm/@ractive-ch/tab-mcp-client@<v>/cdn/tab-mcp-client.min.js`.
   Do not ask jsDelivr before the registry has the version: it caches the 404.

Details and failure cases: `kb/operations/npm-publishing.md`.

## 3. Update the apps

Client release: every user below. Relay release: only the relay deploy. With a candidate:
branches and open PRs only; merges and deploys come after the stable release.

| App | Who | How |
|---|---|---|
| ractive.ch examples (todo, diagram, connect page) | this session, or an agent of it | `~/devel/ractive.ch`: worktree, bump `@ractive-ch/tab-mcp-client` (and the dev dependency `@ractive-ch/tab-mcp`, which `check:tab-mcp` runs a relay from) in package.json, `bun install`, `bun run check`, `bun run check:tab-mcp` and `bun run check:browser`, PR, review, merge; the push to main deploys the site. Check the live bundle: the page's `<script src>` on ractive.b-cdn.net contains the version. |
| Sign-in example (Edge Script `tab_mcp_login`, tab-mcp-login.ractive.ch) | this session | after the ractive.ch PR is merged, in `~/devel/ractive.ch` on main: `bun install`, `bun run build:login`, then `infra/tab-mcp/scripts/tofu-keychain.sh plan`; expect only `bunnynet_compute_script.tab_mcp_login` to change (and the relay's container when its site config changed); `… apply -auto-approve` only then (plain `apply` waits for a terminal), and never while `deploy-tab-mcp` runs. |
| saturnus (ractive.ch/saturnus/app/) | its own session (`saturnus-*`, ListAgents), or an agent of this session when none runs | `just vendor-tab-mcp-version X.Y.Z` (pins version and integrity, vendors every chunk, updates `CONFIRM_MODULE` in web/ai-local.js), keep `webmcp` off (saturnus registers its WebMCP tools itself in web/ai-webmcp.js). Its desktop app calls the confirm chunk's `confirmInPage` with a host of its own: the one caller of that function outside this repository. Tests: `just web-test` plus the one ROM-gated file that drives the page through a real relay, `SATURNUS_ROM_DIR=/Users/james/devel/saturnus/roms node --test --test-timeout=300000 web/test/ai-page.test.mjs` (the ROMs live only in the main checkout; CI never has them). Not `just web-test-full` (all ROM tests, minutes) for a client bump. With the owner's go, merge its PR and dispatch `gh workflow run pages.yml -R ractive/saturnus --ref main`. |
| Sitegloss (ractive/sitegloss, formerly Overmark) | its own session (`sitegloss-*`, ListAgents) | ask it to move to the new version; it merges its own PR and submits to the stores. Installed copies keep the client they shipped with until then. |
| The comparis game (origins in the hosted relay's allow-list) | the owner | not in a repository this session knows: tell the owner it needs the version. |
| tab-mcp browser extension | in this repo | uses the workspace client; released on its own (`kb/operations/chrome-web-store.md`). The store copies keep their client until that release. |
| Relay (tab-mcp.ractive.ch) | this session | relay releases only: `gh workflow run deploy-tab-mcp.yml -R ractive/ractive.ch -f version=<v>`, then `https://tab-mcp.ractive.ch/healthz` reports it. One instance (DEC-198). A change to its sites (`TAB_MCP_SITES`, `apps`) is a tofu change in `infra/tab-mcp/container.tf`, applied after the image that understands it is running. |

Before pushing to or merging another session's PR, message that session first.

## 4. Wrap up

Remove the worktrees and branches, and tell the owner in one short list: the release link,
npm `latest`, and per app the PR and what is live.
