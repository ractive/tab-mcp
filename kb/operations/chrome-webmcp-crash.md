---
type: operations
title: "Chrome crash in the store package's e2e tests (SIGILL in CI)"
description: "Why the tab-mcp browser extension's e2e tests lost Chrome with SIGILL in CI (SIGTRAP on macOS): a bug in Chrome's WebMCP when a document with a tool has getTools() pending while it goes into the back/forward cache (Chromium issue 585631961); how it was found, the evidence, the test's wait that avoids it, and how the extension reads less (DEC-177)."
tags:
  - operations
  - ci
  - extension
  - webmcp
timestamp: 2026-11-14T18:00:00+01:00
---

# Chrome crash in the store package's e2e tests (SIGILL in CI)

## Symptom

In CI (`verify`, and `client-pack`/`relay-pack` in release.yml) the block "the store
package (no host access)" of `packages/tab-mcp-extension/test/extension.browser.test.ts` failed in
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

Users can hit this too: the tab-mcp browser extension from the store, WebMCP on in Chrome, and a
navigation to another origin while the extension reads the page's tools. It needs a
report to Chromium (follow-up; the owner decides, it is public).

## Root cause (standalone repro, 2026-11-14)

The narrowing above was too narrow. A standalone repro (one page, no extension; and a
minimal extension with only `activeTab` and `scripting`) shows the trigger is the
back/forward cache:

- Any document with at least one WebMCP tool registered that has
  `document.modelContext.getTools()` pending while it navigates away crashes the whole
  browser: the page's own world, an extension on `activeTab` or with host permissions,
  same-origin or cross-origin, browser- or renderer-initiated. A page that registers a
  tool, loops `getTools()` and sets `location.href` to a same-origin page after 0.5 s
  crashes 5/5 to 10/10 in Chrome for Testing 157 and 159 and Chromium 157 and 160.
- No crash without a pending call, without a navigation, without a tool, or with
  `--disable-features=BackForwardCache`. The earlier "page world and host access do not
  crash" results most likely came from setups where the page was not eligible for the
  back/forward cache (not tested).
- Frames from an ASan build at the trunk revision: `__libcpp_verbose_abort` in a lambda of
  `content::ModelContextUserData::GetScriptTools`, under
  `RenderFrameHostImpl::ForEachRenderFrameHostWithAction`, from
  `ModelContextHostStubDispatch`. In `content/browser/renderer_host/model_context_user_data.cc`
  the lambda dereferences `GetFrameTokenForSiteInstanceGroup()` under the comment "token
  will never be nullopt"; for a call that arrives from the old document after commit, its
  SiteInstanceGroup has no proxy and the optional is empty (read from the code, not
  checked in a debugger).

Reported as [Chromium issue 585631961](https://issues.chromium.org/issues/585631961)
(component Blink > Agentic Platform > WebMCP), with the repro attached.

The test's wait (below) stays as it is: it removes the pending call, which the crash
needs. What the extension can do on its own is only to make its reads rarer; it cannot
close the window for a user's navigation.

## Fix in the tests

`readsSettled(tab)` in `extension.browser.test.ts` waits, before each navigation to another origin in
the store block, until the content script has had no `getTools()` pending and started none
for 1 s (a read that began before the first poll is not counted; `getTools()` takes milliseconds). It wraps `document.modelContext.getTools` in the content script's isolated
world through the DevTools Protocol, so the build has no hook (ES 7). What the tests check
is unchanged: the same navigations, the same refusals and clicks. Not a retry: the crash
has a known trigger, and the wait takes it out.

With the wait (300 ms, then 1 s after review), both store blocks passed locally on the
Chromium snapshot in 35 of 35 runs, and in 16 of 16 with Chrome's log on (worse timing).
Without the wait, 4 of 6 passed. CI on `ci/chrome-sigill`: 9 of 9 green (run 43594333418 with 300 ms; run 43594833642, attempts 1 to 8, with 1 s), against about one failure in ten on 2026-11-13.
CI keeps Chrome for Testing 156.0.8078.80: 157 and 160 crash alike (DEC-172).

The other timeout of that day ("a takeover is kept across a restart", once in CI, 19.8 s)
did not reproduce in 27 local runs; its wait now says what the panel showed when it
times out.

## Fewer reads in the extension (DEC-177)

Users hit the crash too, so the extension reads less (`extension/fewer-tool-reads`):

- The content script shares one `getTools()` (`ToolReads`, `src/content.ts`): a read
  that started less than 1 s ago answers `page-info` and `webmcp-list`, unless the page
  fired `toolchange` since; a call to a tool shares only a read in flight.
- The worker reads the page only while the side panel is open or the connection to the
  relay is not `disconnected`.

Measured with an instrumented test build (host access; a few lines put before
`content.js` count its `getTools()` calls in the DOM), Chrome for Testing 157.0.8103.78,
macOS arm64, 10 loads each:

| Setup | `getTools()` per load, before | after |
| --- | --- | --- |
| no panel, AI access off | 2.1 (at about 20 and 265 ms) | 0 |
| panel open, AI access off | 4 (two at about 30 ms, two at about 260 ms) | 1 |
| panel open, connected to a relay | 4 | 1 |

The second pair came from the content script's first `webmcp-changed` (250 ms after it
started), the first from the load (`tabs.onUpdated`); each was doubled by the panel's
`page-info` after the bridge's `webmcp-list`.

Crash rate: each round loads `https://site.test/webmcp.html` (five tools), waits a random
0 to 400 ms after its load event and navigates to `plain.html` on the same origin (the
first page goes into the back/forward cache).

| Setup | Crashes before | after |
| --- | --- | --- |
| panel open, connected to a relay, 0 to 400 ms | 16 in 600 (2.7 %) | 0 in 600 |
| no panel, AI access off, 0 to 400 ms | 9 in 300 (3 %) | 0 in 300 (no reads) |
| panel open, connected to a relay, 0 to 50 ms | 26 in 300 (8.7 %) | 2 in 300 (0.7 %, at 5 and 7 ms) |

Before, the crashes fell at 7 to 44 ms and at 233 to 242 ms after the load event: where
the two pairs of reads were. After, none in 0 to 400 ms, but the run that navigates
within 50 ms of the load, where the one remaining read is, still crashes.

Fewer reads make the crash rarer; they cannot rule it out. A navigation while the one
remaining read is pending still crashes Chrome (2 in 300 above), and the AI app's own
calls (`page_info`,
`webmcp_tools`, the navigation tools) read when it asks. Only a fix in Chrome removes
it. `readsSettled` in the e2e tests stays.

The e2e block "reading the page's tools rarely (DEC-177)" checks both parts through the
same isolated-world wrapper as `readsSettled`: a `toolchange` with the AI app's
`page_info` and `webmcp_tools` around it costs one `getTools()` (five before), and with
AI access off and the panel closed a `toolchange` costs none (one before).

# Citations

- [Decision log, DEC-172](../decision-log.md)
- [Decision log, DEC-177: fewer reads in the extension](../decision-log.md)
- [Iteration 36: the panel (the first sighting, SIGTRAP)](../iterations/iteration-36-extension-panel.md)
