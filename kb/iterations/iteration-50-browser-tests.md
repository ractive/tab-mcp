---
type: iteration
title: "Iteration 50: browser tests out of the default run, then fewer and lighter"
status: in-progress
description: >-
  One `bun run verify`, the rule before every commit, started 27 browsers and built the
  extension 12 times, and several agents ran it at once. The audit of 2026-11-22 plans
  nine pull requests; the first takes the browsers out of the default run: every file
  that launches one is a *.browser.test.ts behind a gate, `bun run test:browser` runs
  them, and CI runs both in two jobs (DEC-220).
timestamp: 2026-11-22T06:00:00+01:00
tags: [iteration, tests, browser, ci, extension, client]
---
# Iteration 50: browser tests out of the default run, then fewer and lighter

The owner, 2026-11-22: the local browser tests "got completely out of hand": many
browsers at once, notifications, a machine at load 96. The read-only audit
([research](/research/browser-test-audit-2026-11-22.md)) found 134 browser tests in 14
files, all of them in every `bun run verify`, and planned nine pull requests, the one
that saves the most first. The decision on the split and the rule is DEC-220.

## What changed (pull request 1)

- **Names and the gate.** A test file that launches a browser is named
  `*.browser.test.ts` and imports `test/browser-gate.ts`; it looks for its browser only
  when `TAB_MCP_BROWSER=1`. Plain `bun test` loads it and starts nothing: no browser, no
  build of the extension, no relay. Renamed: the extension's `e2e`, `fill-e2e`,
  `firefox-e2e`, `firefox-fill-e2e` (`extension`, `fill`, `firefox`, `firefox-fill`) and
  `harness`; the client's `browser` (`page`), `webmcp-browser` and `serve-browser`; the
  relay's `code-field-browser`; the spike's `webmcp` (`webmcp-canary`) and `browser`
  (`harness`); the calculator's `e2e` (`calculator`); the React example's `e2e`
  (`react-todo`). The client's `cdp.test.ts` (the reap's pattern against stand-in
  processes) launches none and stays.
- **The convention test** (`scripts/test-browser.test.ts`): a test file that can launch
  a browser is named so, and only such a file. It can when it reaches a harness
  (`cdp.ts`, the extension's `browser.ts` and `firefox.ts`, the spike's `browser.ts`)
  through its imports and finds a browser (it, or a module on the way that is not a
  harness, calls a `find…()` or reads `CHROME_PATH`/`FIREFOX_PATH`): every harness
  launches only the binary it is given. Each browser file imports the gate and looks
  for a browser only behind it; CI and the release workflows run what they should.
- **Scripts.** `verify` keeps its text and starts no browser. `test:browser [filter]`
  (`scripts/test-browser.ts`) runs the browser files, or those whose path contains a
  filter, in one `bun test`. `verify:all` runs both.
- **CI** (`ci.yml`): the job `verify` (the required check) runs the fast `verify`; the
  new job `browser` runs `test:browser` with Chrome for Testing and the runner's
  Firefox, in parallel. No path filter; a pull request that changes only `kb/` passes
  both jobs at once. `release.yml` (`client-pack`, `relay-pack`) and
  `extension-release.yml` (`build`) run `verify:all`.
- **The rule** in `CLAUDE.md`: `verify` before every commit; `test:browser` with a filter
  before a commit that changes code a browser runs; never several browser runs at once;
  nothing for `kb/` or docs alone.

## Tasks

- [x] 1. Browsers out of the default run: the renames, the gate, the convention test,
  `test:browser` and `verify:all`, the two CI jobs, the rule
- [ ] 2. The machine-wide lock and the start-up sweep, one profile parent for every
  harness (`scripts/test-browser.ts`, `scripts/browser-lock.ts`)
- [ ] 3. The notification recorder in the test build; Chrome for Testing instead of the
  branded Chrome in `cdp.ts`; `FIREFOX_PATH` in the README
- [ ] 4. The fast suite's timers (`timing.allowDelayMs`, the relay's idle test)
- [ ] 5. The extension's logic tests to unit tests (the UNIT rows of the audit's 1.1 and
  1.3), each new unit test shown to fail against a mutant first
- [ ] 6. The extension's browser tests merged, one browser per build and flag
- [ ] 7. Firefox: a smoke block on every change, the full file when the extension
  changes and nightly
- [ ] 8. The client's and the examples' browser files trimmed
- [ ] 9. The canary and the full browser run in `browser-full.yml` (path filter,
  nightly, not required); the CI split itself is done in pull request 1
