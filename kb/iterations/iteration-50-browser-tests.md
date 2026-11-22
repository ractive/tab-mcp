---
type: iteration
title: "Iteration 50: browser tests out of the default run, then fewer and lighter"
status: in-progress
description: >-
  One `bun run verify`, the rule before every commit, started 27 browsers and built the
  extension 12 times, and several agents ran it at once. The audit of 2026-11-22 plans
  nine pull requests; the first takes the browsers out of the default run: every file
  that launches one is a *.browser.test.ts behind a gate, `bun run test:browser` runs
  them, and CI runs both in two jobs that the required check `verify` waits for
  (DEC-218).
timestamp: 2026-11-22T06:00:00+01:00
tags: [iteration, tests, browser, ci, extension, client]
---
# Iteration 50: browser tests out of the default run, then fewer and lighter

The owner, 2026-11-22: the local browser tests "got completely out of hand": many
browsers at once, notifications, a machine at load 96. The read-only audit
([research](/research/browser-test-audit-2026-11-22.md)) found 134 browser tests in 14
files, all of them in every `bun run verify`, and planned nine pull requests, the one
that saves the most first. The decision on the split and the rule is DEC-218.

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
- **The convention test** (`scripts/test-browser.test.ts`). The harnesses are the
  modules that define a `static async launch(`. A test file (any name `bun test`
  discovers) can launch a browser when it reaches a harness through its relative
  imports and it, or a module on the way that is not a harness, finds or starts one
  (a `find…()`, `launch(`, `startStack(`, `CHROME_PATH`, `FIREFOX_PATH`); such a file is
  named so, and only such a file. An import that resolves to no file fails the test.
  Each browser file imports the gate and looks for a browser only behind it. At run
  time, every browser file under plain `bun test` with `CHROME_PATH` and `FIREFOX_PATH`
  pointing at a stand-in that records a start must start nothing. CI and the release
  workflows run what they should.
- **Scripts.** `verify` keeps its text and starts no browser. `test:browser
  [--no-chrome] [--no-firefox] [filter…]` (`scripts/test-browser.ts`) runs the browser
  files, or those whose name contains a filter, in one `bun test`. Before the run it
  finds the browsers they need with the harnesses' lookup, prints path and version, and
  fails for a missing or too old one (Chrome for Testing 156, Firefox 128) unless a
  `--no-…` leaves those files out, which it reports as not tested. After the run a file
  without a passed test fails it. It forwards SIGINT, SIGTERM and SIGHUP to the run.
  `verify:all` runs both.
- **CI** (`ci.yml`): the jobs `fast` (`bun run verify`) and `browser` (`bun run
  test:browser`, Chrome for Testing 156 and the runner image's Firefox) run in
  parallel; the job `verify`, the required check of `main`, needs both, runs always and
  passes only when both passed, so no ruleset change was needed. No path filter; a pull
  request that changes only `kb/` passes both test jobs at once (`scripts/ci-changes.sh`,
  without rename detection). The Firefox files fail in CI without Firefox 128 or newer,
  as the Chrome files do without Chrome. `release.yml` (`client-pack`, `relay-pack`)
  and `extension-release.yml` (`build`) run `verify:all`.
- **The rule** in `CLAUDE.md`: `verify` before every commit, docs included; nothing for
  `kb/` alone; `test:browser` with the filters for the part touched before a commit
  that changes code a browser test runs (the extension, the client's browser code, the
  relay's pages, server and protocol, test pages and harnesses); never several browser
  runs at once.

## Tasks

- [x] 1. Browsers out of the default run: the renames, the gate, the convention test,
  `test:browser` and `verify:all`, the two CI jobs and the required check over both, the
  rule
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

# Citations

- [The audit of the browser tests](/research/browser-test-audit-2026-11-22.md)
- [Decision log](/decision-log.md), DEC-216, DEC-218
- [CI of main at 9f11a91, before the split: 1,890 tests, bun test 242.65 s](https://github.com/ractive/tab-mcp/actions/runs/44984541830)
- [CI of main at aab7ad3, before the split: 1,915 tests, the job 4 min 14 s](https://github.com/ractive/tab-mcp/actions/runs/44986990412)
