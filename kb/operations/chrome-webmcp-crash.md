---
type: operations
title: "Chrome crash in the store package's e2e tests (SIGILL in CI)"
description: >-
  Why tab-mcp for Chrome's e2e tests lost Chrome with SIGILL in CI (SIGTRAP on macOS):
  a bug in Chrome's WebMCP when a content script on activeTab alone has getTools()
  pending while its tab goes to another origin; how it was found, the evidence, and the
  test's wait that avoids it.
tags:
  - operations
  - ci
  - extension
  - webmcp
timestamp: 2026-11-14T13:30:00+01:00
---

# Chrome crash in the store package's e2e tests (SIGILL in CI)

## Symptom

In CI (`verify`, and `client-pack`/`relay-pack` in release.yml) the block "the store
package (no host access)" of `packages/tab-mcp-extension/test/e2e.test.ts` failed in
about one run in ten on 2026-11-13 (runs 43421002233, 43464281451, 43465298651, PR 121):
"another origin of the same site needs a click too" waited 15 s for
`https://www.site.test/plain.html` and reported "Chrome exited (exit code null, signal
SIGILL)", the stack at `chrome+0x6712aca` every time; the next two tests failed at once on
the closed pipe. Locally Chrome for Testing 157 on macOS arm64 ended with SIGTRAP at the
same navigation (iteration 36), about once in twenty runs.

## Cause

A bug in Chrome, not the runner or the flags. The browser process fails a libc++
hardening assertion, `optional operator* called on a disengaged value`. Official builds
trap without the message: `ud2` (SIGILL) on Linux x64, `brk` (SIGTRAP) on macOS arm64.
Same place every time, so it is not an instruction the runner's CPU lacks. A Chromium
snapshot build (157.0.8103.0, not official) prints the assertion and crashed in 8 of 18
runs; Chromium 160.0.8162.0 (trunk, 2026-11-14) crashes too. So no newer Chrome fixes it
yet.

The trigger, narrowed with worker logs (`--enable-logging=stderr`) and experiments in the
snapshot build:

- The tab's content script runs on `activeTab` only (the store package, injected after a
  click) and has `document.modelContext.getTools()` pending (from `page-info` or
  `webmcp-list`) when the tab navigates to another origin, here `site.test` to
  `www.site.test`, which ends the click's grant. After a load the worker reads the page
  several times within some 30 ms (the load, the page's `toolchange`, the panel), and the
  test navigated right after one of those reads.
- `getTools()` left out of `page-info`: 0 crashes in 8 runs (4 of 5 with it). The same call
  replaced by a 5 ms timer: 0 in 6. Waiting 1.5 s before the navigation: 0 in 6. Two
  injections at once made no difference.
- The test build's blocks (host access) navigate with reads pending too and never crash.
  `getTools()` from the page's own world or a DevTools isolated world, around a renderer-
  or browser-initiated navigation, did not crash in 120 rounds. Only an extension's
  content script on `activeTab` hits it.

Users can hit this too: tab-mcp for Chrome from the store, WebMCP on in Chrome, and a
navigation to another origin while the extension reads the page's tools. It needs a
report to Chromium (follow-up; the owner decides, it is public).

## Fix in the tests

`readsSettled(tab)` in `e2e.test.ts` waits, before each navigation to another origin in
the store block, until the content script has had no `getTools()` pending and started none
for 300 ms. It wraps `document.modelContext.getTools` in the content script's isolated
world through the DevTools Protocol, so the build has no hook (ES 7). What the tests check
is unchanged: the same navigations, the same refusals and clicks. Not a retry: the crash
has a known trigger, and the wait takes it out.

With the wait: Chromium snapshot 20 of 20 and, with Chrome's log on (worse timing), 10 of
10, against 4 of 6 passing without it. CI on `ci/chrome-sigill`: CI_RESULTS.
CI keeps Chrome for Testing 156.0.8078.80: 157 and 160 crash alike (DEC-172).

The other timeout of that day ("a takeover is kept across a restart", once in CI, 19.8 s)
did not reproduce in 27 local runs; its wait now says what the panel showed when it
times out.

# Citations

- [Decision log, DEC-172](../decision-log.md)
- [Iteration 36: the panel (the first sighting, SIGTRAP)](../iterations/iteration-36-extension-panel.md)
