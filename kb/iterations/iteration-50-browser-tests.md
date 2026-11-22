---
type: iteration
title: "Iteration 50: browser tests out of the default run, then fewer and lighter"
status: completed
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

## What changed (pull request 2)

- **One browser run per machine** (DEC-219, `test/browser-lock.ts`): a lock folder under
  `~/.cache/tab-mcp/browser-tests/`, taken by `test:browser` before it starts anything
  and by the gate for a browser file run on its own; a second run says whose run holds
  it and waits (15 minutes at most), `--no-wait` fails at once; a lock whose run is
  proven gone is taken over (one of two takers); the run's own processes hold it on;
  `test:browser --sweep` and every script that starts a browser by hand take it too.
- **One parent folder** (`test/browser-dirs.ts`): every profile and build of the browser
  tests is `runs/<pid>-<start>/<kind>-XXXXXX`, for the harnesses, the browser files and
  `hosted.ts`; an unsafe `TAB_MCP_BROWSER_DIR` is refused.
- **The sweep** (`test/browser-sweep.ts`), under the lock, before and after a run: only
  inside its own parent folder, only browsers whose profile flag names a run folder of a
  run proven gone, and those folders; in doubt (a listing that fails, is empty, partial
  or unparsable) it keeps everything and says why. No rules for the old temp folders:
  the first sweep had removed this machine's 120. `bun run test:browser --sweep
  --dry-run` lists what it would do.
- **Tests:** the lock with real processes (a second run waits and then runs, `--no-wait`,
  a time limit, a gone holder taken over, a gone holder whose run still has a process
  not, two takers of one stale lock, bad `owner.json` files, no deadlock within a run, a
  bad wait), the sweep's choice on made-up lists (an editor naming a gone run's folder is
  not chosen; an empty, failing or unparsable listing keeps everything; folders listed
  before processes; symbolic links; a second look), an unsafe `TAB_MCP_BROWSER_DIR`,
  `ps` start times the same in every time zone, and one real check
  (`scripts/sweep.browser.test.ts`): a test process killed with SIGKILL leaves its
  Chrome, and the next sweep stops it and removes its folder.
- **`setup.test.ts`:** one test per shell with 30 s each (PowerShell's cold start took
  longer than Bun's 5 s on CI).
- **The rule:** "a second run waits" in place of "never several at once".

## What changed (pull request 3)

- **No notification on the desktop** (DEC-220, [research](/research/test-browser-notifications.md)):
  every test Chrome starts with `--disable-features=NativeNotifications`
  (`test/browsers.ts`, used by the three Chrome harnesses). Tried first, as the team lead
  asked: macOS's log showed a delivery without the switch and none with it, and `create`,
  `getAll` and `clear` answered the same, so Chrome keeps the real API and no test's
  assertion changed. `notifications.browser.test.ts` checks it on macOS on every browser
  run. Firefox's pref for the same (`alerts.useSystemBackend: false`) opened alert
  windows that took the focus from the panel and failed a test. So the Firefox test build
  records its notifications (`src/worker/notifications.ts`); no store or development build
  has the recorder (`build.test.ts`). `firefox.browser.test.ts` reads the recorder (a
  question's notification, answered through it) and calls Firefox's real API once with
  the same options, cleared at once. The macOS guard has no positive control, and says
  so; a unit test fails when a Chrome launch lacks the switch.
- **Only the pinned test browsers:** Chrome for Testing `156.0.8078.80` (CI's) and Firefox
  `stable_160.0.1`, from `CHROME_PATH` / `FIREFOX_PATH` or Puppeteer's cache. Never an
  installed Chrome. An installed Firefox only with `--system-firefox`
  (`TAB_MCP_SYSTEM_FIREFOX=1`), and then over the cached one. `cdp.ts` no longer falls
  back to the owner's Chrome, and the Firefox tests no longer fall back to
  `/Applications/Firefox.app`. `test:browser` prints the install line for a missing one.
  CI and the release jobs install the same pinned Firefox.

## What changed (pull request 4)

- **The fast suite's waits:** `bun test` from 103 s to 60 s on the owner's Mac, with the
  same tests, names and assertions (two expects added, none dropped).
- **Settings only tests change**, the shipped values untouched:
  - `confirmTiming.allowDelayMs` (`confirm.ts`): the Allow delay a dialog gets when its
    caller passes none. ui.test.ts sets it to 20 ms; the tests of the delay set back the
    shipped 750 ms and check it, and the re-arm tests keep their own 600 ms.
  - `timing.siblingGraceMs` (`tab-mcp.ts`, passed to `openConnection`): a replaced tab's
    wait for a sibling's `claimed`. 100 ms in the client's tests; the test of a sibling
    whose hello was never answered keeps the shipped second.
  - `TAB_MCP_BROWSER_POLL_MS` and `TAB_MCP_BROWSER_STALE_WAIT_MS` (`test/browser-lock.ts`):
    the lock's poll and a stale lock's time without waiting, 50 ms and 500 ms in
    `scripts/browser-run.test.ts`, whose holders keep the lock shorter. Every case stays.
- **The clock moved, not waited for** (`setSystemTime`): `/healthz`'s reused second and
  the pairing dialog's time (DEC-202) in identity.test.ts.
- **Bun's idle timeout:** the three cases of request-path.test.ts wait at once, each on a
  relay of its own. Bun closes an idle socket only in steps of a few seconds, so a shorter
  setting would not help.
- **Still slow, on purpose:** where the wait is what is tested: Bun's idle timeout
  (relay.test.ts tunnel, hardening.test.ts), the 1 s store deadline of `/healthz`, the
  late hello (1.5 s) of the extension's polyfill, the shipped Allow delay and sibling
  grace, and the real processes (a nested `bun test`, the relay process, PowerShell).

## What changed (pull request 5)

- **21 of the 22 UNIT rows of the audit's 1.1 and 1.3 moved** (e2e #2, 6, 7, 9, 10, 15
  to 18, 21, 27, 30, 31, 34, 48, 60, 63; fill #2, 8, 9, 10). A browser test went only
  once a unit test failed for the mutant of the code it caught; the PR lists each one.
- **Kept: e2e #46** ("with AI access off and the panel closed the page is not read").
  It counts the page's own `getTools()` calls, from every reader at once. Part of that
  is the content script's `toolchange` handler, which runs only as a real content
  script.
- **Two new unit test files**, for code no unit test reached before:
  - `sidepanel.test.ts`: the side panel's page in happy-dom, with a fake port.
  - `connection.test.ts`: the worker's `Connection`, with settings in memory and a fake
    Chrome.
- **Audit verdicts that did not hold:**
  - #34's twin covered only `attachPanel`'s order, not the Connection's queue.
  - Fill #9 and #10 had twins in the client library's `extension.test.ts`, but the
    worker's wiring had none.
  - #60's "no hints is not destructive" had no unit test in the library.
  - The new tests fill each of these gaps.
- **One real fact kept:** that `sidePanel.open` is refused without a gesture is now a
  line of the kept #28.
- **Two kept tests no longer depend on a removed one:** each now sets up the AI access
  it needs itself.
- **Scope:** the Firefox UNIT rows (1.2) are for pull request 7, and the client's (1.5,
  1.6) for pull request 8.

## What changed (pull request 6)

- **One Chrome per build and WebMCP flag:** `extension.browser.test.ts` has 6 launches
  in place of 14 (the test build with WebMCP, the test build without it, the store
  package, and 3 for the restart scenario) and 2 builds in place of 12. `fill.browser.test.ts`
  keeps its 1 launch.
- **Each test starts from its own state:**
  - The extension is installed anew in its file's Chrome (`Browser.reinstall`:
    `Extensions.uninstall`, which drops its IndexedDB, then loaded again with the same
    id, about 150 ms).
  - Each test gets a relay of its own and a new tab, every other tab closed.
  - The other extension a test loaded goes too.
  - The service worker's lifetime (the opt-in idle test) and a profile that must outlive
    the browser (the restart) keep a Chrome of their own.
- **The audit's MERGE rows of 1.1 and 1.3 are scenarios with named steps** (`step()`;
  a failure names its step). The bodies are unchanged:
  - `extension.browser.test.ts`: 49 tests down to 25.
  - `fill.browser.test.ts`: 7 down to 3.
  - The `expect()` calls are the same, 234 and 39.
  - Every test passes alone (`bun test -t`) and in a random order (`--randomize`).
- **Tests made independent:**
  - "it follows a tab switch" now goes to its page itself.
  - The onClosed test closes the panel itself.
  - The fill tests turn filling in on themselves (`fillOn`).
- **Time:** no faster: CI 142.6 s against main's 133.6 s, locally the same. The owner chose
  independence over the 9 s (22 starts replace 12; a launch costs about 0.6 s locally).
- **A dead Chrome is launched again:** one that is gone (a crash, Bun killing a timed-out
  test's processes) or whose reinstall failed is closed and launched anew at the next
  test's start, and the log says so ("relaunched Chrome … at start N"). Before, the rest
  of the file would have failed. Shown in a scratch run with `Browser.crash` between two
  tests.
- **What a reinstall guarantees** (checked, else the start fails):
  - the other extensions a test loaded are gone;
  - every target of the old install is gone before the new one loads;
  - the extension's settings, alarms and notifications are empty, and its permissions
    are its manifest's.
- **Steps have deadlines:** a step's own (its test's timeout before) comes before the
  scenario's, so a slow step fails named.

## What changed (pull requests 7 and 9)

- **Pull requests run the Firefox smoke, `browser-full.yml` runs everything.**
  - One mechanism: the file's name. `*-full.browser.test.ts` is the full run's only;
    `bun run test:browser --no-full` (ci.yml's browser job) leaves those files out and
    lists them under NOT TESTED. Without the flag, locally and in releases
    (`verify:all`), every file runs: `test:browser firefox` is all of Firefox.
  - A convention test: every browser file that needs Firefox is `*-smoke` or `*-full`.
    An unknown `--` flag fails `test:browser` now, so a typo cannot run everything
    quietly.
  - The full run's files: `firefox-full` (the event page against Firefox's idle
    timeout, two waits of 10 s; no pull request runs it, since the full run follows
    every change to the extension on main within minutes) and `firefox-fill-full`
    (Always allow, which repeats the Chrome test of shared code).
- **The smoke** (`firefox-smoke`, `firefox-fill-smoke`): what is Firefox's own.
  - The polyfill as the page meets it: it is there as the page loads; a round trip over
    the `moz-extension://` relay origin, as one scenario with page_info, a read-only
    tool, an MCP result, a wrong argument refused by the page's schema, a cancel (a
    page-realm signal) and `toolchange`.
  - The panel's focus rules; notifications as the recorder sees them and as Firefox's
    own API takes them; a replaced getter; register and unregister in one tick;
    `provideContext`, whose errors reach the page as its own `TypeError` and
    `QuotaExceededError` with their messages (review of PR 220: only Firefox shows
    an error crossing the worlds).
  - Dead objects after a reload; the client library in Firefox's worlds.
  - In fill: the gesture rule for `permissions.request`, and senders without `origin`.
- **The audit's verdicts that did not hold:**
  - 13, 17 and 18 stay in the smoke (the audit had them in the full run): they test the
    polyfill's own code, which no Chrome test runs, and cost under 1.5 s with their
    starts.
  - 16 (the panel closed) is not dropped: with the panel open, its port may keep the
    event page alive by itself, so 15 does not prove 16. Both run in the full run only.
- **Four tests moved to unit tests, and one got a unit test too**, each unit test
  shown to fail against a mutant first:
  - The panel's Firefox words: `sidepanel.test.ts` builds `main.ts` with
    `TAB_MCP_FIREFOX` and checks what the browser test checked.
  - The arguments check and the hints: the twins from pull request 5 (`bridge.test.ts`,
    the client's `relay.test.ts`, `unit.test.ts`); the smoke keeps one refused call.
  - An MCP result: `resultText`, which had no unit test.
  - `provideContext`: the registry's rules (an invalid tool changes nothing, the
    1024-tool limit over both ways of registering) are a unit test now; the smoke keeps
    the errors as the page gets them.
- **The canary** (`webmcp-canary-smoke`): its test 6 is dropped (the product never
  registers on Chrome's native WebMCP from a content script). It costs about 4 s, so
  it stays in every pull request's run: a Chrome pin bump meets it in the required
  check.
- **`browser-full.yml`:** every browser file, and the opt-in idle test of the
  extension's service worker (`TAB_MCP_E2E_IDLE=1`, over two minutes). It runs
  nightly (in this repository only, not in a fork), on demand, and on a push to main
  that changes the extension, the client, the relay, `test/`, `scripts/`, a
  `package.json`, the lockfile or the workflows. It is not required.
  - A hang is stopped after 25 minutes and counts as a failure, with its log (a job
    past its own limit counts as cancelled, and nobody would hear of it).
  - A red run on main opens an issue labelled `browser-full` with the failing tests
    (each a code span, at most 50, the body capped), or comments on the open ones. A
    green run of main's current head closes them; a green run of an older commit
    only comments. The script finds its own issues by a marker in the body
    (`scripts/browser-full-issue.ts`, in a job of its own with the only write access).
- **Locally:** the Firefox part of the pull request run takes about 20 s (14 s smoke,
  5.6 s fill smoke). Before, it was 44.8 s for the two files. `expect()` calls went from
  70 to 64: 15 went with the moved tests, 9 came with the refused argument and
  `provideContext` in the page.

## What changed (pull request 8)

- **The client's browser files keep what only a browser shows** (the audit's 1.5 and
  1.6). Six tests went, each because a unit test already fails without what it
  showed; each unit test was run against a mutant first:
  - page 3, a confirmation in a background tab: `ui.test.ts` "opened in a hidden tab"
    (the hidden check in `confirm.ts` taken out). Its fake assumes how Chrome brings a
    tab forward (visible and focused before `visibilitychange`); `ui.test.ts` says so.
    Put back as a step it would cost 3.4 s, so only the hand check pins that order.
  - webmcp 2, 3, 5 and 11: `webmcp.test.ts`. The mutants were the validator's
    unmirror, the arguments check, the refusal's message, a throw's message, a cancel
    while asked, and `webmcp` on by default.
- **Three came back as steps** (review of pull request 221): their unit tests' fakes
  assume what only the real browser shows.
  - page 4, a second tab takes over, now with a step that the library's default
    storage is the real `localStorage`: the page's other tabs read the secret, and a
    reload keeps it (every unit test passes a MemoryStorage).
  - webmcp 4: a call without `onConfirm` loads no confirmation chunk (the built
    bundle).
  - webmcp 7: aborting the signal given to Chrome's `registerTool()` removes the tool,
    and the same name registers again at once (React's `useTool`).
- **The MERGE rows are scenarios with steps**, their bodies unchanged:
  - page 1 with 4 and the storage step; page 5 and 6: a page's own styles and the
    dialogs.
  - webmcp 1, 4, 6, 7, 8 and 10: the mirror as Chrome has it, the contract of the unit
    tests' fake `ModelContext`.
  - webmcp 9 (frames) and 12 (`exposedTo`) stay as they are.
- **`step` is shared:** `test/step.ts` (tested in `scripts/step.test.ts`), imported by
  the extension's and the client's browser tests alike.
- **No network:** `@mcp-b/global` 6.0.3 is vendored in `packages/tab-mcp-client/test/vendor/`
  (unchanged, MIT licence, the same SRI; `.gitattributes` keeps its bytes). Biome leaves
  `test/vendor/` alone.
- **The examples: declined, no example file changed.** The audit's MERGE rows for them
  (react-todo with the calculator, and the client's serve 3 with the webmcp file) need
  one Chrome across files, against the independence chosen in task 6: each file keeps
  its own browser.
- **Counts:** 18 tests down to 6, `expect()` calls from 108 to 93. Locally the two files
  take 7.2 s instead of 11.5 s.

## Tasks

- [x] 1. Browsers out of the default run: the renames, the gate, the convention test,
  `test:browser` and `verify:all`, the two CI jobs and the required check over both, the
  rule
- [x] 2. The machine-wide lock and the start-up sweep, one profile parent for every
  harness (`test/browser-lock.ts`, `test/browser-sweep.ts`, `test/browser-dirs.ts`)
- [x] 3. No notification on the desktop (a switch per browser, found by trying, in place
  of the recorder); only the pinned test browsers, never the owner's (`test/browsers.ts`);
  the one-time set-up in the README
- [x] 4. The fast suite's timers (`timing.allowDelayMs`, the relay's idle test)
- [x] 5. The extension's logic tests to unit tests (the UNIT rows of the audit's 1.1 and
  1.3), each new unit test shown to fail against a mutant first
- [x] 6. The extension's browser tests merged, one browser per build and flag
- [x] 7. Firefox: a smoke block on every change, the full file when the extension
  changes and nightly
- [x] 8. The client's browser files trimmed; the examples' declined (one Chrome across
  files, against task 6's independence), no example file changed
- [x] 9. The canary and the full browser run in `browser-full.yml` (path filter,
  nightly, not required); the CI split itself is done in pull request 1

# Citations

- [The audit of the browser tests](/research/browser-test-audit-2026-11-22.md)
- [Decision log](/decision-log.md), DEC-216, DEC-218, DEC-219, DEC-220
- [Test browsers and the owner's desktop](/research/test-browser-notifications.md)
- [CI of main at 9f11a91, before the split: 1,890 tests, bun test 242.65 s](https://github.com/ractive/tab-mcp/actions/runs/44984541830)
- [CI of main at aab7ad3, before the split: 1,915 tests, the job 4 min 14 s](https://github.com/ractive/tab-mcp/actions/runs/44986990412)
