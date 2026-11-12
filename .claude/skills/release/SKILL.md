---
name: release
description: >
  Release @ractive-ch/tab-mcp-client or @ractive-ch/tab-mcp (the relay) and bring every app
  that uses it up to date: version PR with scripts/bump-version.ts, merge, GitHub release,
  the CI publication, then ractive.ch (examples, sign-in Edge Script, relay deploy), saturnus
  and Overmark. Use it when the owner says "release 0.x.y", "release the client/relay",
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

## 1. Version PR

1. A worktree on a fresh branch from `origin/main`, e.g.
   `git worktree add -b release/client-0.14.0 ../tab-mcp-wt/rel origin/main`.
2. The CHANGELOG must have a `### Unreleased` section under the package's heading with what
   the release contains. Every breaking change goes under "Changed", including run-time
   behaviour that a type check does not catch (0.13.0's `confirmInPage` and hand-built
   clients without `kind` were missed and found by saturnus).
3. `bun scripts/bump-version.ts client 0.14.0` (or `relay 0.10.0`). It sets package.json,
   every pinned doc in `scripts/pinned-files.ts`, the plugin manifests (client only), the
   CHANGELOG date and link, and `bun.lock`. It refuses, writing nothing, when the old version
   is also the other package's version: then edit by hand.
4. `bun run verify`, and check its exit code (never through a pipe). The test "docs and
   plugin manifests name only the current package versions" fails on any version left over.
5. Commit (author james@ractive.ch, trailer `Co-Authored-By: Claude Opus 5.5
   <noreply@anthropic.com>`), push, PR titled "Client 0.14.0" / "relay 0.14.0". The
   content was reviewed in its own PRs; a pure version PR needs no review run.
6. Wait for CI (`gh pr checks <n> --watch`; main has no required checks), then
   `gh pr merge <n> --merge`.

## 2. GitHub release and publication

1. Release notes: the new CHANGELOG section's body, written to a file.
2. On exactly the merge commit (`gh pr view <n> --json mergeCommit`), not on `main`:
   `gh release create client-v0.14.0 --target <sha> --title "Client 0.14.0" --notes-file <f>`
   (`relay-v…`, "Relay 0.14.0"; `--prerelease` exactly for a pre-release version).
3. The `Release` workflow publishes (client: npm; relay: npm, ghcr.io, Docker Hub). Watch it:
   `gh run list -w release.yml -L 1`, then `gh run watch <id> --exit-status`. The relay-pack job
   has a flaky extension e2e test; `gh run rerun <id> --failed` once before investigating.
4. Done when `npm view @ractive-ch/tab-mcp-client dist-tags.latest` shows the version (wait
   with an until-loop) and, for the client, the CDN build answers 200:
   `https://cdn.jsdelivr.net/npm/@ractive-ch/tab-mcp-client@<v>/cdn/tab-mcp-client.min.js`.

Details and failure cases: `kb/operations/npm-publishing.md`.

## 3. Update the apps

Client release: every user below. Relay release: only the relay deploy.

| App | Who | How |
|---|---|---|
| ractive.ch examples (todo, diagram, connect page) | this session | `~/devel/ractive.ch`: worktree, bump `@ractive-ch/tab-mcp-client` in package.json, `bun install`, `bun run check` and `bun run check:tab-mcp` (it found 0.12.0's preload 404s), PR, review, merge; the push to main deploys the site. Check the live bundle: the page's `<script src>` on ractive.b-cdn.net contains the version. |
| Sign-in example (Edge Script `tab_mcp_login`, tab-mcp-login.ractive.ch) | this session | after the ractive.ch PR is merged, in `~/devel/ractive.ch` on main: `bun install`, `bun run build:login`, then `infra/tab-mcp/scripts/tofu-keychain.sh plan`; expect only `bunnynet_compute_script.tab_mcp_login` to change; `… apply` only then, and never while `deploy-tab-mcp` runs. |
| saturnus (ractive.ch/saturnus/app/) | its own session (`saturnus-*`, ListAgents) | ask it to `just vendor-tab-mcp` (it pins integrity, updates `CONFIRM_MODULE` in web/ai-local.js and vendor.test.mjs), keep `webmcp` off (saturnus registers its WebMCP tools itself in web/ai-webmcp.js); with the owner's go, merge its PR and dispatch `gh workflow run pages.yml -R ractive/saturnus --ref main`. |
| Overmark (ractive/overmark) | its own session (`tab-mcp-77`) | ask it to move to the new version; it merges its own PR. |
| tab-mcp for Chrome | in this repo | uses the workspace client; released on its own (`kb/operations/chrome-web-store.md`). |
| Relay (tab-mcp.ractive.ch) | this session | relay releases only: `gh workflow run deploy-tab-mcp.yml -R ractive/ractive.ch -f version=<v>`, then `https://tab-mcp.ractive.ch/healthz` reports it. |

Before pushing to or merging another session's PR, message that session first.

## 4. Wrap up

Remove the worktrees and branches, and tell the owner in one short list: the release link,
npm `latest`, and per app the PR and what is live.
