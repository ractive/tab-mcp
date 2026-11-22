---
type: research
title: "Audit of tab-mcp's browser tests, 2026-11-22"
description: A read-only audit of the 134 browser tests in 14 files after one `bun run verify` started 27 browsers; a verdict per test (keep, merge, unit, drop), the Firefox files, browser start-ups, slow tests without a browser, notifications, a structure with *.browser.test.ts files and a gate, and a plan in nine pull requests.
tags:
  - tests
  - browser
  - ci
  - extension
  - client
timestamp: 2026-11-22T06:00:00+01:00
---

# Audit of tab-mcp's browser tests (2026-11-22)

The owner, 2026-11-22: the local browser tests "got completely out of hand" (many
browsers at once, notifications, a machine at load 96). A Claude agent read the tests
and wrote this report; nothing was run. The plan's pull requests are the tasks of
[iteration 50](/iterations/iteration-50-browser-tests.md); the split and the rule are
DEC-218. The report follows unchanged, with the file names as they were before the
renames of its section 6; where pull request 1 did otherwise is under "Afterwards" at
the end.

Read at origin/main 9f11a91 in a detached worktree (`/Users/james/devel/tab-mcp-wt/test-audit`).
No test was run and no browser was started. Every time below is either the CI number from
the brief or an estimate, and each estimate says what it rests on.

## Summary

- 134 browser tests in 14 files (one of them, the idle test, only runs on request).
  Verdicts: **KEEP 54, MERGE 43, UNIT 35, DROP 2.**
- The real problem is the process, more than the tests themselves. `bun run verify` is the
  rule before every commit, and it runs every browser file. One run starts **27 browsers**
  (22 Chrome, 5 Firefox). It also does **12 builds of the extension**, 10 of them the same
  test build. Several agents run it at the same time. Nothing serialises those runs and
  nothing cleans up after a killed run.
- Four harnesses use the owner's own apps when `CHROME_PATH`/`FIREFOX_PATH` are not set:
  `packages/tab-mcp-client/test/cdp.ts` falls back to `/Applications/Google Chrome.app`, and
  `test/firefox.ts` uses `/Applications/Firefox.app`. Headless runs of the owner's daily
  browsers explain part of "so many browsers".
- The extension's notifications use `requireInteraction: true, priority: 2`
  (`src/worker/connection.ts:1012`), so each one stays on screen until it is cleared. The
  e2e tests raise roughly 15 per run.
- Expected times (reasoning in section 6): the default `bun test` goes from about 242 s on
  CI to about 70 s with no browser. The browser suite per code change goes from about
  155 s to about 70 s. Locally, an agent runs no browser unless its change needs one.

---

## 1. Verdict per browser test

Abbreviations: "dup" means a unit test already covers it, and that test is named. "ext"
means `packages/tab-mcp-extension`, and "client" means `packages/tab-mcp-client`.

### 1.1 `ext/test/e2e.test.ts` (65 tests, 64 run by default)

**Block "the test build (host access)": one Chrome, 25 tests**

| # | Test | Verdict | Why |
|---|---|---|---|
| 1 | the AI app gets page_info, webmcp_tools and the page's tools | KEEP | The one real round trip from Chrome's WebMCP through the content script, worker and relay to an MCP client. This becomes the smoke scenario that #3, 4, 5, 19 and 20 fold into. |
| 2 | there is no chrome.storage | UNIT | The property is "no `storage` permission in the manifest". Add that assertion to `unit.test.ts` "manifest" (none checks it today). That `chrome.storage` is undefined without the permission is documented Chrome behaviour, so nothing is lost. |
| 3 | page_info tells the page in front and its WebMCP tools | MERGE→1 | `pageInfo` is dup: `unit.test.ts` "a page with WebMCP and its tools, and its language". |
| 4 | webmcp_tools lists them with their input schemas | MERGE→1 | dup: `bridge.test.ts` "webmcp_tools gives each offered tool's input schema, as offered (EQ 1)". Keep one schema assertion in the smoke, which also proves Chrome's `inputSchema` form is parsed. |
| 5 | a read-only tool runs at once | MERGE→1 | This is the core call, so it belongs in the smoke. |
| 6 | arguments are checked against the page's schema (Chrome does not) | UNIT | dup: `bridge.test.ts` "webmcp_call: arguments are checked against the page's schema" and "page_<name> asks in the bridge…". That Chrome does not check is pinned by the spike canary ("executeTool … input is not checked"). |
| 7 | an MCP result from the page passes as its content | UNIT | dup: `bridge.test.ts` "the JSON of an MCP result passes as its text and image blocks". Chrome's JSON encoding is pinned by the spike canary. |
| 8 | a tool not marked read-only asks in the side panel first | KEEP (trimmed) | Keep one confirmation round trip (worker → panel port → real click → page call), with allow and with deny. The card texts are dup (`navigation.test.ts` "a page tool's card: Don't allow, Allow once, Always allow on <host>"), and so are the full arguments (`worker.test.ts` "a panel gets each question's arguments once"). |
| 9 | Always allow on <host> … (EQ 10) | UNIT | dup: `worker.test.ts` "Always allow on <host>: the tool is allowed on its site, for every AI app and page (EQ 10)". The panel drawn from state is covered by `panel.test.ts`. |
| 10 | webmcp_call calls a page tool by name, with the same confirmation | UNIT | dup: the 5 tests of `bridge.test.ts` "webmcp_call (by name)". |
| 11 | the AI access switch: its knob sits flush… | MERGE→14 | Real layout (pseudo-element transform, padding box), so it is browser-only. Fold it into one "look" test with 12, 13 and 14. |
| 12 | … knob on track and track on paper at least 3:1 (EQ 17) | MERGE→14 | The ratio maths duplicate `contrast.test.ts` (token pairs). Only the browser can say which rule wins the cascade, so keep a computed-colour snapshot and drop the hard-coded ratios. |
| 13 | How do I add it? … the commands fit, Copy keeps its width | MERGE→14 | The texts are dup (`panel.test.ts` "each app with its steps; Claude Code and Codex with a command…"). Overflow and Copy's width are layout. |
| 14 | the look: nothing past the panel's edge at 345/360/420 px… | KEEP | Real layout. It caught a regression: 813a7ff, where the `100vw` dialog covered the scrollbar on Linux CI. "No amber" and the token values are dup of `contrast.test.ts` and can go. |
| 15 | Always allow all, a switch: on allows, off asks again | UNIT | Panel and worker logic: `panel.test.ts` "Always allow all, over the tool list" (4 tests). The "changed under the pointer: a click allows nothing" quiet time is panel logic that happy-dom can drive. |
| 16 | Allow all takes only tools the worker offers on that origin | UNIT | **No unit test today.** The filter is `connection.ts:711-736`. Add a test to `worker.test.ts` against `Connection` with a fake bridge state. Nothing is lost: the test already sends raw port commands and never touches Chrome. |
| 17 | Ask for all also takes away a tool the page dropped since | UNIT | Same code, same gap: no unit test. |
| 18 | a tool whose Always allow is switched on in the panel runs without asking | UNIT | Logic is dup of #9. Focus kept after the redraw (EQ 11) can be checked in happy-dom with `document.activeElement`. |
| 19 | cancelling a call cancels it in the page | MERGE→1 | Cross-process cancel (relay → worker → content script → Chrome's signal). Keep it as one smoke step. The bridge side is dup: `bridge.test.ts` "cancelling the AI app's call cancels the page's". |
| 20 | the list follows toolchange, without a navigation | MERGE→1 | Chrome's real `toolchange` event. Keep it as one smoke step. |
| 21 | destructiveHint is the page's consequentialHint (DEC-214) | UNIT | dup twice: `bridge.test.ts` "destructiveHint is the page's consequentialHint, true when it said nothing (DEC-214)", and the spike canary for Chrome's annotations. |
| 22 | a page that replaces document.modelContext fools only itself | KEEP | The isolated world, with our content script's way of reaching the native object. The spike's "forged" test is the duplicate, not this one. |
| 23 | a page tool that takes the tab to another page answers with that page (WM 2) | KEEP | Depends on how Chrome tears down a content script during a call. The logic is unit-tested (`bridge.test.ts` "a tool that navigates the tab is not a failure"), but the trigger is Chrome's. |
| 24 | it follows a navigation | KEEP (trimmed) | Real `tabs` events and re-injection. The panel's "no tools" text is dup (`panel.test.ts` "no tools: whether WebMCP is off or the page offers none"). |
| 25 | it follows a tab switch, tools included | KEEP | `tabs.onActivated`. |

**Block "the connection without the side panel": one Chrome, 8 tests**

| # | Test | Verdict | Why |
|---|---|---|---|
| 26 | a question in the panel of the tab's focused window sends no notification | KEEP | `panelInFocus` reads `chrome.windows.get().focused` and the panel's visibility as Chrome reports them. The routing logic is dup (`worker.test.ts` "with the panel of the tab's focused window open, no notification…"). Badge and countdown texts are unit-tested. |
| 27 | questions are a modal dialog; a click right after it closed allows nothing… | UNIT | The quiet time and "Allow waits again" are panel logic. The only real part is `:modal`/inert, and that is lost only if happy-dom lacks `:modal` (not checked). |
| 28 | a panel closed during a question hands it to a notification | KEEP | The real side-panel lifecycle (`sidePanel.close` → port disconnect). It becomes one scenario with 29 and 32. Logic dup: `worker.test.ts` "after the click, a panel closing hands the question to a new notification". |
| 29 | with the panel closed the AI app still calls the page's tools | MERGE→28 | The connection lives in the worker. One step. |
| 30 | with the panel closed a question is a notification: Allow, closing it, late clicks, no second button | UNIT | Everything goes through the test hooks (`tabMcpNotificationButton` …), so it calls our own functions. dup: `worker.test.ts` "Don't allow is closing it", "a click answers only its own call; one on a settled call is dropped", "without a panel in front, a notification asks: Allow only…", "an Allow within the guard does not count". It costs about 3 s of `Bun.sleep(600)`. |
| 31 | a click on a notification's body where Chrome refuses the side panel (EQ 18) | UNIT | dup: `worker.test.ts` "where the panel does not open, a new notification asks again… (EQ 18)" and "arguments cut in a notification". Move the one real fact ("`sidePanel.open` without a gesture is refused") into 28 as a one-line canary. |
| 32 | reopening the panel shows the same connection | MERGE→28 | The panel reattaching to the worker's state. One step. |
| 33 | a panel covered by another extension's panel for the tab hands its questions to notifications | KEEP | `visibilityState` of a covered side panel: only Chrome decides that. |

**Block "panel commands, and the address taken over": one Chrome, 3 tests**

| # | Test | Verdict | Why |
|---|---|---|---|
| 34 | commands run one after another: a connect then a stop ends off… | UNIT | dup: `worker.test.ts` "a panel's messages wait on the start and arrive in their order (EQ 19)". Port ordering is Chrome's guarantee. |
| 35 | a takeover is kept across a restart… | KEEP (trimmed) | Keep the real worker restart (`Extensions.loadUnpacked` reload), the takeover from a real relay, the alarm not taking the address back, and "Disconnect all apps" with a new secret. The panel texts, the double-click guard, the armed red and the focus are dup or happy-dom-able (`panel.test.ts` "off with apps paired…(EQ 8)", "the second click of a double click does not confirm Disconnect"). |
| 36 | the database deleted under the worker: the next write opens it again | KEEP | Real IndexedDB `versionchange` in a service worker. Bun has no IndexedDB, and a fake would be a new package. It is cheap once it shares a browser. |

**Block "a restart": its own launches, 2 tests**

| # | Test | Verdict | Why |
|---|---|---|---|
| 37 | the same profile connects again by itself, with the same address | KEEP | Service-worker start at browser start, with a persisted profile. |
| 38 | with the relay out of reach at a start, it keeps trying… (EQ 3, EQ 14) | MERGE→37 | One scenario: start, close, relaunch (reconnects), close, stop the relay, relaunch (retrying, alarm set). That is 3 launches instead of 4. The state text is dup: `worker.test.ts` "down with AI access left on is retrying, not off (EQ 3)". |

**Block "the service worker on a quiet connection": opt-in (`TAB_MCP_E2E_IDLE`), 1 test**

| # | Test | Verdict | Why |
|---|---|---|---|
| 39 | it keeps running while connected, and stops once AI access is off | KEEP (scheduled) | Service-worker lifetime: only real Chrome. Over 2 minutes long. Run it nightly, not per commit. |

**Block "the store package (no host access)": one Chrome, 5 tests**

| # | Test | Verdict | Why |
|---|---|---|---|
| 40 | the tab the icon was clicked on can be read | KEEP | The real `activeTab` grant. |
| 41 | on the same origin after a navigation too | KEEP | Chrome's rule that the grant survives a same-origin navigation. The Chrome crash was found around here (`kb/operations/chrome-webmcp-crash.md`, Chromium issue 585631961, DEC-177). |
| 42 | another origin of the same site needs a click too | KEEP | The `activeTab` origin rule. The panel's words are dup: `panel.test.ts` "an unreadable tab in the user's words…(EQ 6)". |
| 43 | on another site it may not, until the next click there | MERGE→42 | The same rule (the grant drops on an origin change). One test. |
| 44 | a click shows the panel over another extension's panel for the tab… | KEEP | Side-panel options per tab or per window: Chrome's behaviour. |

**Block "reading the page's tools rarely (DEC-177)": one Chrome, 2 tests**

| # | Test | Verdict | Why |
|---|---|---|---|
| 45 | a toolchange and the reads around it … cost one getTools() | MERGE→1 | dup per component: `unit.test.ts` "reading the page's tools rarely (DEC-177)" (5 tests). Keep one bound on the count in the smoke, because only there do the worker, the panel and the AI app read together. |
| 46 | with AI access off and the panel closed the page is not read… | UNIT | Worker logic (`#readTab` returns early without panels). Add to `worker.test.ts`. |

**Block "navigation (iteration 27, test build)": one Chrome, 6 tests**

| # | Test | Verdict | Why |
|---|---|---|---|
| 47 | navigate on the page's origin runs at once… | KEEP | Real `tabs.update` and waiting for the load. This is the one navigation scenario that 49–52 fold into. |
| 48 | only http(s) addresses; the tab stays | UNIT | dup: `navigation.test.ts` "no other scheme, no user name or password, nothing too long". |
| 49 | to another origin it asks in the side panel… | MERGE→47 | Logic dup: `navigation.test.ts` "to another origin it asks first: From, To, no Always allow on <host>". |
| 50 | back to another origin asks too, its address not known | MERGE→47 | dup: `navigation.test.ts` "back or forward the content script cannot see: asked, the address unknown". Keep the real history step. |
| 51 | back and forward on the page's origin run at once | MERGE→47 | |
| 52 | reload stays and never asks; within the page (#part)… | MERGE→47 | dup: `navigation.test.ts` "reload never asks…" and "a navigation that never starts loading (within the page) counts as done". |

**Block "navigation in the store package": one Chrome, 2 tests**

| # | Test | Verdict | Why |
|---|---|---|---|
| 53 | on the page's origin the click's access holds | MERGE→41 | The same rule as #41, reached through `navigate`. Run it in the store build's browser. |
| 54 | to another origin, once allowed, the result says the new page needs a click | KEEP | `activeTab` is lost after a cross-origin `tabs.update`. |

**Block "Chrome without WebMCP: the page-world polyfill": one Chrome, 4 tests**

| # | Test | Verdict | Why |
|---|---|---|---|
| 55 | Chrome has no WebMCP here; the page finds the polyfill's as it loads | KEEP | A MAIN-world content script at `document_start`. The registry is unit-tested (`unit.test.ts` "Chrome's page-world polyfill: the content script's port", "the polyfill's registry…"). |
| 56 | the AI app gets the page's tools and calls them | MERGE→55 | |
| 57 | cancelling a call aborts the page's signal | MERGE→55 | |
| 58 | the list follows toolchange | MERGE→55 | |

**Block "a page with the client library, Chrome's own WebMCP (DEC-207)": one Chrome, 6 tests**

| # | Test | Verdict | Why |
|---|---|---|---|
| 59 | the page shows the AI app connected through the extension… | KEEP | Cross-world `postMessage` between the page and the content script. The handshake logic is dup: `handshake.test.ts` "both sides together: the extension's state reaches TabMcp.extension; a vouched call is not asked again". This is the one library scenario that 61, 62 and 64 fold into. |
| 60 | the library's mirror: no hints is not destructive… (DEC-214) | UNIT | dup: client `webmcp.test.ts` "destructiveHint counts as consequentialHint…", plus `bridge.test.ts`. |
| 61 | with the extension's Always allow on, the call runs with no question in the page | MERGE→59 | The vouch's timing across worlds. One allowed call is enough. |
| 62 | with it off, the extension asks once and the page not at all | MERGE→59 | Keep one decline. |
| 63 | a WebMCP call not from the extension runs without the page's question (DEC-215) | UNIT | dup: client `webmcp.test.ts` "a tool that asks runs for an agent in the browser without onConfirm…(DEC-215)". It is also in `webmcp-browser.test.ts`. |
| 64 | the page's state follows when the app is disconnected in the extension | MERGE→59 | |

**Block "a page with the client library, the extension's own WebMCP": one Chrome, 1 test**

| # | Test | Verdict | Why |
|---|---|---|---|
| 65 | the page knows the extension, and a call allowed there is not asked again | KEEP | The vouch through the page-world polyfill. Run it in the same no-WebMCP browser as 55. |

**Counts for `e2e.test.ts`: KEEP 23, MERGE 24, UNIT 18, DROP 0.**

### 1.2 `ext/test/firefox-e2e.test.ts` (18 tests)

| # | Test | Verdict | Why |
|---|---|---|---|
| 1 | the page finds document.modelContext as it loads, and registers | KEEP | `exportFunction` at `document_start`: Firefox only. |
| 2 | the panel speaks of Firefox, not Chrome | UNIT | The texts are ours. Render the panel in `panel.test.ts` with the Firefox strings; none does today. |
| 3 | the AI app gets page_info, webmcp_tools and the page's tools | KEEP | The Firefox round trip, including the relay admitting `moz-extension://` (DEC-189). |
| 4 | page_info tells the page in front | MERGE→3 | |
| 5 | a read-only tool runs at once | MERGE→3 | |
| 6 | arguments are checked against the page's schema | UNIT | dup of shared code (`bridge.test.ts`). |
| 7 | an MCP result from the page passes as its content | UNIT | dup (`bridge.test.ts` results). `resultText` in `webmcp/registry.ts` needs its own unit test. |
| 8 | a tool not marked read-only asks in the panel first | KEEP | Firefox's focus rules for the panel (`windows.update` focus, BiDi cannot activate it). |
| 9 | cancelling a call aborts the page's signal | MERGE→3 | A page-realm `AbortController` across compartments: Firefox only, as one step. |
| 10 | the list follows toolchange: later, and one whose signal aborts | MERGE→3 | The signal through an Xray: Firefox only, as one step. |
| 11 | destructiveHint as in Chrome (DEC-214) | UNIT | dup: `unit.test.ts` "annotations are listed as Chrome lists them (DEC-214)" and `bridge.test.ts`. |
| 12 | the page can break only its own object | KEEP | Xray vision. |
| 13 | registerTool then unregisterTool in one tick | KEEP | `pagePromise`'s synchronous executor through `exportFunction`. Fold in one assertion that a `PageError` arrives as a page-realm `DOMException` with the right `name`. |
| 14 | provideContext with an invalid tool changes nothing; at most 1024 | UNIT | Pure `ToolRegistry.provide`/`#add` logic (`webmcp/registry.ts:185-240`). **No unit test today** (no `QuotaExceededError` in any test). It also registers 1000 tools over BiDi. |
| 15 | the event page: with the panel open, the connection outlasts the idle timeout | KEEP (extension changes/schedule) | Event-page lifetime: Firefox only. It is `Bun.sleep(10_000)`. |
| 16 | … with the panel closed too | DROP→15 | Keep only the panel-closed case, which is the stricter one: nothing else holds the page. Its own 10 s sleep then goes. |
| 17 | an extension reload or update: the page's tools outlive the content script | KEEP | Dead objects (DEC-188): Firefox only. |
| 18 | a page with the client library, the Firefox build's WebMCP | KEEP | Cross-world messaging in Firefox (Xrays on `event.data`, senders without `origin`). |

**Counts: KEEP 8, MERGE 4, UNIT 5, DROP 1.**

### 1.3 `ext/test/fill-e2e.test.ts` (11 tests, one Chrome)

| # | Test | Verdict | Why |
|---|---|---|---|
| 1 | off by default…; Fill in the code for me turns it on | KEEP | `permissions.request` needs a real gesture, and `scripting.registerContentScripts` is real. Fold #11 in, so on and off are one test. |
| 2 | a look-alike of the page on another origin is ignored | UNIT | The refusal is ours. dup: `fill.test.ts` "access to the relay's site; the script registered for /authorize only, without a port" plus `pairingMatches`. That a pattern with no port matches every port is documented match-pattern behaviour. Lost: nothing of ours. |
| 3 | the page going withdraws the question | MERGE→5 | dup in part: `fill.test.ts` "Remove withdraws a fill…; the page going or the tab closing drops it". |
| 4 | a question stays in place … (classic scrollbars) | KEEP | Real layout. The regression test for a real click-miss bug (cf338ff, 813a7ff). |
| 5 | Don't allow fills in nothing, and typing the code by hand pairs | KEEP | A real form post on the relay's page, with OAuth. Becomes one scenario with 6. |
| 6 | Allow fills in the code and the AI app is paired | KEEP | The feature's core. |
| 7 | Always allow (DEC-213): … the fourth in ten minutes asks | MERGE→6 | The brake is dup: `fill.test.ts` "the brake: at most 3 fills without a question per host in 10 minutes", and the notice is dup: "the notice after a fill without a question…". Keep one unasked fill in 6. It raises 3 real notifications. |
| 8 | removing the host under the switch: its next page asks again | UNIT | dup: `fill.test.ts` "remembered … listed; removed" and "the panel lists the remembered hosts, each with Remove". |
| 9 | with AI access off, the page gets no question | UNIT | Worker logic. **No unit test found**. Add one to `fill.test.ts`. |
| 10 | turning AI access off withdraws a question that waits | UNIT | Same: no unit test found. |
| 11 | the switch turned off: … the page has no script | MERGE→1 | `unregisterContentScripts`. |

**Counts: KEEP 4, MERGE 3, UNIT 4, DROP 0.**

### 1.4 `ext/test/firefox-fill-e2e.test.ts` (3 tests, one Firefox)

| # | Test | Verdict | Why |
|---|---|---|---|
| 1 | off by default; a real click … turns it on | KEEP | Firefox's gesture rule for `permissions.request`. |
| 2 | a look-alike gets no question; the relay's page, Allow fills in and pairs | KEEP | Firefox's port senders carry no `origin`, so the address decides. That is a separate code path. |
| 3 | Always allow (DEC-213) … removed, it asks again | MERGE | Repeats the Chrome test on shared `fill.ts` logic, beyond a smoke check. |

**Counts: KEEP 2, MERGE 1.**

### 1.5 `client/test/browser.test.ts` (6 tests, one Chrome, the owner's branded Chrome by default)

| # | Test | Verdict | Why |
|---|---|---|---|
| 1 | a page connects with a click and serves tool calls through the relay | KEEP | Real `WebSocket`, the relay's origin check, `NotAllowedError` without user activation, the lazy chunk load, and revocation. |
| 2 | the connect dialog with its code fits 320 and 360 px, also with 18 px text | KEEP | Layout. |
| 3 | a confirmation in a background tab waits until the tab is in front | UNIT | dup: `ui.test.ts` "opened in a hidden tab: Allow waits for the tab to be shown, then the full delay" (fake timers). `visibilitychange` is the platform's. |
| 4 | a second tab of the page takes over: BroadcastChannel | UNIT | dup: `protocol.test.ts` "telling a sibling tab from an impostor (review of PR 39, DEC-095)". |
| 5 | a page's rules for button:hover, :focus and :disabled do not change the dialogs | KEEP | The real cascade with `:hover`/`:focus-visible`. |
| 6 | confirmations one at a time, Allow after the arguments were seen, … page colours and pointer-events kept out | MERGE→5 | The queue and Enter are dup: `ui.test.ts` "confirmDialog: one at a time, arguments seen, no stray keys (iteration 31)". Keep the cascade, `pointer-events` and the overflow-scroll gate in 5. |

**Counts: KEEP 3, MERGE 1, UNIT 2.**

### 1.6 `client/test/webmcp-browser.test.ts` (12 tests, one Chrome for Testing)

Client `webmcp.test.ts` covers the same tests against a fake native `ModelContext`, which is
its stated purpose. The real-browser file is only worth keeping as a **contract test of that
fake**.

| # | Test | Verdict | Why |
|---|---|---|---|
| 1 | getTools() lists the mirrored tools … (DEC-209) | KEEP | The contract: the shape and annotations Chrome reports for a mirrored tool. |
| 2 | a call runs; the first one loads the validator… | UNIT | dup: `webmcp.test.ts` "a tool the validator refuses is unmirrored when the lazy chunk loads". |
| 3 | a bad argument, Don't allow and a throw reach the agent… (DEC-120) | UNIT | dup: "bad arguments resolve with an error…", "a consequential tool asks onConfirm…", "an isError result and a throw…". |
| 4 | without onConfirm a tool that asks runs … (DEC-215) | UNIT | dup: "a tool that asks runs for an agent in the browser without onConfirm…". |
| 5 | a call the agent cancels while onConfirm decides ends cancelled | UNIT | dup: "a call cancelled while asked stays cancelled…", "a call the browser cancels still rejects with an AbortError". |
| 6 | results as the agent reads them (WM 4, 5, 6) | MERGE→1 | One assertion on how Chrome serialises results belongs in the contract. The rest is dup: "…'Done.'…", "an MCP result goes out as its structuredContent…". |
| 7 | aborting unmirrors; registering again mirrors again | UNIT | dup: "aborting the tool's signal unmirrors it", "abort and register again, as React's useTool does". |
| 8 | a native duplicate in either order keeps its owner | MERGE→1 | Chrome's `InvalidStateError`. The spike canary pins it too. |
| 9 | a frame without allow="tools" warns… | KEEP | Permissions Policy in a cross-origin frame. |
| 10 | with @mcp-b/global over native WebMCP… | MERGE→1 | The polyfill is pinned (6.0.3 with SRI) but **downloaded from unpkg.com during the test**, a network dependency in CI and in the sandbox. Unit dup: "a polyfill's own document.modelContext is not used". Vendor the file if it stays. |
| 11 | webmcp off registers nothing | UNIT | dup: "without webmcp: true nothing is registered…". |
| 12 | exposedTo: a document of that origin lists and runs a tool… | KEEP | `getTools({ fromOrigins })` across origins: native only. |

**Counts: KEEP 3, MERGE 3, UNIT 6.**

### 1.7 `test/webmcp-spike/webmcp.test.ts` (6 tests, one Chrome for Testing with the spike extension)

A canary for the pinned Chrome (CI: `CHROME_VERSION: "156.0.8078.80"`). Its answers can only
change when that pin changes. Locally it runs the newest Chrome for Testing in the owner's
cache, which is not the pinned one.

| # | Test | Verdict | Why |
|---|---|---|---|
| 1 | the content script sees the page's tools on the native object | KEEP (on a Chrome pin change and nightly) | Diagnostic for the bridge's main assumption. |
| 2 | executeTool from the content script returns the result as a string | KEEP (same) | The bridge depends on both facts (string result, input not checked). |
| 3 | toolchange reaches the content script, and an abort rejects the call | MERGE | Covered by the extension smoke (e2e #19, #20). |
| 4 | a page replacing document.modelContext does not fool the content script | MERGE | Duplicate of e2e #22, which tests our code too. |
| 5 | annotations: none listed without, all four as booleans with (DEC-214) | KEEP (same) | DEC-214's reading of Chrome. |
| 6 | a tool the content script registers is the page's to list and call | DROP | The product never registers on Chrome's native WebMCP from the content script (`registerTool` appears only in the polyfills, `chrome/webmcp-main.ts` and `firefox/webmcp.ts`, and in the worker's `TabMcp`). An iteration-18 answer that no longer matters. |

**Counts: KEEP 3, MERGE 2, DROP 1.**

### 1.8 The remaining files

| File / test | Verdict | Why |
|---|---|---|
| `test/e2e/test/e2e.test.ts`: an AI app pairs with the calculator page… | KEEP | The only end-to-end test of the human pairing flow (code typed on `/authorize`, OAuth). |
| `client/test/serve-browser.test.ts` 1: a chat in a frame on another origin lists and calls the page's tools over a port | KEEP | Cross-origin `postMessage` origin check, plus a `MessagePort` transfer. |
| serve-browser 2: the chat's frame goes away: the port's close event ends the serve (CC 1) | KEEP | `MessagePort` close event, real Chrome only. |
| serve-browser 3: with webmcp: true, one tool reaches the chat and an agent | MERGE | Same harness and flags as `webmcp-browser.test.ts`. Run both files in one Chrome. |
| `examples/react-todo/test/e2e.test.ts`: an AI app uses the React page's tools, also after the relay restarted | MERGE | Repeats browser.test #1's round trip. The React parts are unit-tested (`react.test.tsx`), and so is reconnect (`reconnect.test.ts`). Keep it as an example smoke in the same Chrome as the calculator test. |
| `packages/tab-mcp/test/code-field-browser.test.ts` 1: the script runs under the page's policy, no violation, draws the boxes | KEEP | CSP enforcement. |
| code-field 2: typing, Backspace and Delete across the dash… | MERGE→6 | The edit logic is dup: `code-field.test.ts` "Backspace and Delete" (6 tests). Keep one typing/backspace/paste sequence as a wiring check. |
| code-field 3: paste of abcd-efgh … | MERGE→6 | dup: `code-field.test.ts` "paste". |
| code-field 4: undo after typing and after a paste | KEEP | The native undo stack against programmatic `value` changes. |
| code-field 5: a full code fits … at 320 px and at desktop width | KEEP | Layout. |
| code-field 6: Connect submits the typed code, and Enter does too… | KEEP | Implicit form submission. |
| code-field 7: an extension that writes the code and submits (DEC-199) works unchanged | MERGE→6 | fill-e2e #6 does this with the real extension. Keeping it here is cheap and protects relay-only changes. |
| code-field 8: without the script the field is a plain input that fits the code and submits it | KEEP | The fallback without JS, with layout. |

**Counts: calculator KEEP 1. serve-browser KEEP 2, MERGE 1. react-todo MERGE 1.
code-field KEEP 5, MERGE 3.**

### 1.9 Totals

| File | Tests | KEEP | MERGE | UNIT | DROP |
|---|---|---|---|---|---|
| ext e2e.test.ts | 65 | 23 | 24 | 18 | 0 |
| ext firefox-e2e.test.ts | 18 | 8 | 4 | 5 | 1 |
| ext fill-e2e.test.ts | 11 | 4 | 3 | 4 | 0 |
| ext firefox-fill-e2e.test.ts | 3 | 2 | 1 | 0 | 0 |
| client browser.test.ts | 6 | 3 | 1 | 2 | 0 |
| client webmcp-browser.test.ts | 12 | 3 | 3 | 6 | 0 |
| test/webmcp-spike/webmcp.test.ts | 6 | 3 | 2 | 0 | 1 |
| test/e2e e2e.test.ts | 1 | 1 | 0 | 0 | 0 |
| client serve-browser.test.ts | 3 | 2 | 1 | 0 | 0 |
| examples/react-todo e2e.test.ts | 1 | 0 | 1 | 0 | 0 |
| relay code-field-browser.test.ts | 8 | 5 | 3 | 0 | 0 |
| **All** | **134** | **54** | **43** | **35** | **2** |

What history says about the browser tests:

- Bugs caught: the `100vw` regression on Linux (813a7ff), the click that missed when the
  focus hint moved the questions (cf338ff), Chrome crashing on injection into a tab mid-load
  (2a341e9), and Chromium issue 585631961 (`kb/operations/chrome-webmcp-crash.md`).
- All four came from **layout tests or the real lifecycle of tabs and frames**. None came
  from the logic tests marked UNIT above, which already have unit twins.
- A large share of the 64 commits on `e2e.test.ts` and `browser.ts` are fixes to waits and
  flakes ("wait for the worker's write…", "no click before the worker listens or the panel
  has a size", "wait out the content script's tool reads…"). That is the cost of testing
  logic through a browser.

---

## 2. The Firefox files

**How much repeats Chrome on shared code.**

- `firefox-e2e.test.ts`: 9 of 18 tests are Chrome tests run again on code that is the same
  for both: tests 3–7, 9–11 and 18 have Chrome twins, e2e #1, 3, 5, 6, 7, 19, 20, 21 and 65.
  Of those 9, five are logic in `worker/bridge.ts`, which `bridge.test.ts` covers (UNIT).
  Four pin real Firefox-specific wiring and fold into one scenario: the round trip,
  cancelling through a page-realm signal, `toolchange` through an Xray, and cross-world
  library messaging.
- The rest are genuinely Firefox-only: `exportFunction`/Xray behaviour (1, 12, 13), the
  panel's focus rules (8), the event page (15), and dead objects on reload (17).
- `firefox-fill-e2e.test.ts`: 1 of 3 tests repeats Chrome.

**The time goes into sleeps.** Tests 15 and 16 are two `Bun.sleep(10_000)` calls: 20 of the
file's 25.2 s. Merging 15 and 16 removes 10 s. Lowering the wait to "idle timeout (3 s) plus
a margin" would take 10 s to about 5 s. Whether 5 s is reliable on CI can only be found by
running it.

**Smoke subset, per code change (CI only):** one Firefox and one build. The scenario: test 1
(the page finds `document.modelContext`), test 3 with 4 and 5 (the round trip and the relay
admitting `moz-extension://`), test 8 (one question answered in the panel), and test 12 (the
replaced getter). That is 4 tests, an estimated 3–5 s of tests plus about 3 s of start-up.
BiDi start-up is slower than Chrome's, judging by the 30 s retry in `Firefox.launch`.

**Full Firefox, only when** `packages/tab-mcp-extension/**`, the client's `extension` entry,
the relay's allowed origins, the lockfile or the Firefox harness change, **and nightly:** the
smoke plus 9, 10, 13, 15, 17 and 18, and both of `firefox-fill-e2e`.

**Locally: never by default.** `findFirefox` picks `/Applications/Firefox.app`, the owner's
own Firefox. If it is ever run locally, point `FIREFOX_PATH` at a separate copy (a downloaded
Firefox or Nightly that is not the daily browser).

---

## 3. Browser start-ups

One run today, per file. Every start is a fresh `mkdtemp` profile.

| File | Starts | Builds | Relays | What drives it |
|---|---|---|---|---|
| ext e2e.test.ts | **14 Chrome** | **12** (10 test, 2 store) | 12 | Every one of the 11 default describe blocks calls `start()`, which builds, launches, opens the panel and connects. "a restart" does 2 starts and 2 relaunches. |
| ext firefox-e2e.test.ts | 4 Firefox | 4 | 4 (+4 page servers) | One `start()` per describe block. Two blocks set a profile pref (`extensions.background.idle.timeout`, `keepUuidOnUninstall`). |
| ext fill-e2e.test.ts | 1 Chrome | 1 | 1 (OAuth stack) | |
| ext firefox-fill-e2e.test.ts | 1 Firefox | 1 | 1 | |
| client browser.test.ts | 1 (branded Chrome by default) | (library bundle) | 1 | |
| client webmcp-browser.test.ts | 1 Chrome for Testing | | 0 | |
| client serve-browser.test.ts | 1 Chrome for Testing | | 0 | |
| webmcp-spike | 1 Chrome for Testing + spike extension | | 0 | |
| test/e2e calculator | 1 (branded Chrome by default) | | 1 | |
| react-todo | 1 (branded Chrome by default) | | 1 | |
| code-field-browser | 1 (branded Chrome by default) | | 1 | |
| **Total** | **27 (22 Chrome, 5 Firefox)** | **17 extension builds** | | |

Every browser file also runs `findChromeForTesting()` or `findFirefox()` at load, and that
spawns `<binary> --version` for each candidate. It happens in the default `bun test` too,
even when everything is then skipped.

**What needs its own browser in `e2e.test.ts`.**

- A browser is fixed by the launch flag `--enable-features=WebMCP` and by the build loaded at
  launch. Two copies of tab-mcp in one browser would both inject and both get the questions,
  so the store build cannot share with the test build.
- Minimum: **test build with WebMCP** (blocks 1, 2, 3, 7, 8, 11), **test build without
  WebMCP** (blocks 10, 12), **store build** (blocks 6, 9), plus the profile-restart scenario
  (3 launches after the merge in #38). That is **6 launches instead of 14**, and 2 builds
  instead of 12. Memoise `build()` per variant per process, and use one relay per file.
- Fresh state between blocks without a new browser: remove and load the extension again,
  which drops its IndexedDB, and open a fresh page. Whether `Extensions.uninstall` exists in
  the pinned Chrome, or `Storage.clearDataForOrigin` on the `chrome-extension://` origin
  plus a reload does the same, needs trying.
- Blocks 2 and 3 leave the worker in states that later blocks must not see (takeover,
  deleted database, other-extension loaded). Run them last in their browser, or give them
  the fresh-extension step.
- Expected saving: 8 fewer launches at an estimated 2–3 s each, plus 10 fewer builds. The
  51 s of hooks are mostly these starts (12 extension starts at about 2.5 s is about 30 s),
  so roughly **20–25 s on CI**.

**Firefox.** Blocks A, C and D can share one launch with `keepUuidOnUninstall` set; it does
nothing to the others. B (idle timeout 3 s) stays separate and leaves the per-commit run.
That is 2 launches instead of 4, and 1 per commit. Saving: about 6–9 s.

**The plain-page Chrome files** (browser, webmcp-browser, serve-browser, calculator,
react-todo, code-field) could share one Chrome for Testing with
`--enable-features=WebMCP,…` and `--enable-blink-features=MessagePortCloseEvent`, using a
`Target.createBrowserContext` per file for a fresh profile. That saves 5 launches, about
3–5 s.

- This needs one shared harness (today there are three: `cdp.ts`, `webmcp-spike/browser.ts`
  and `ext/test/browser.ts`) and a browser shared across test files.
- Whether Bun shares module or global state across files in one `bun test` process is
  something I could not confirm (section 8).
- The smaller, certain step: the client files and `code-field` should use **Chrome for
  Testing, not the owner's branded Chrome**. Today `cdp.ts`'s `CANDIDATES` start with
  `/Applications/Google Chrome.app`.
- The spike keeps its own browser, because it loads its own extension at launch.

---

## 4. Slow tests without a browser

**`client/test/ui.test.ts` (16.5 s, 90 tests).** About **8 s is the real 750 ms Allow delay**.

- 11 calls of `await enabled(button)` wait the real `ALLOW_DELAY_MS = 750`
  (`src/confirm.ts:53`), at lines 127, 184, 239, 409, 643, 2842, 3058, 3078, 3099, 3112 and
  3177. Those 11 waits come to 11 × 0.75 s ≈ 8.3 s.
- The code already has a seam: `ConfirmDialogOptions.allowDelayMs` ("Tests only"). Tests at
  lines 401, 462 and 511 use it with fake timers.
- `confirmInPage` does not pass it through (`tab-mcp.ts:1049`). Put the delay into the
  existing test-only `timing` object (`tab-mcp.ts:67`, changed by `setTiming` in
  `helpers.ts:107`) as `allowDelayMs: 750`. Pages still cannot change it, so CU 17 holds.
  Then set it to 0–10 ms in the file's `beforeEach`.
- Keep one test, "is 750 ms, a constant" (line 636). Rewrite it with `jest.useFakeTimers()`:
  advance 749 ms (still disabled), then 1 ms (enabled).
- One more real wait: `Bun.sleep(soon - now + 50)` at line 1535 (about 350 ms). Use
  `setSystemTime` as at line 1582.
- The other about 8 s are spread over 90 new happy-dom `Window`s and `StubRelay` servers. I
  cannot split that without per-test times.

**`relay/test/request-path.test.ts` (13.2 s, 15 tests).** Almost all of it is the three
tests of section 2, "Bun's idle timeout comes back".

- Each starts a relay with `httpIdleTimeoutS: 1` and waits for Bun to close the idle socket.
  The races allow 6 s.
- Bun's `idleTimeout` is in whole seconds. As far as I know uWebSockets checks timeouts on a
  coarse timer (about 4 s), so each test likely waits 1–4 s. That fits about 12 s for three.
  Unverified.
- The value cannot go below 1 s. So run the three probes **in one test, concurrently** (three
  relays, `Promise.all`). That is one wait instead of three: an estimated **−8 s**, still
  checking all three paths of `relay.ts:1287`.
- The other sleeps (80, 100 and 50 ms, 7 in total) add under 1 s.

**`client/test/protocol.test.ts` (7.3 s, 61 tests).** There is no long sleep (30 ms and 20 ms
only). The heartbeat test uses `heartbeatMs: 40`. So the time is about 120 ms per test, most
likely a new `StubRelay` (`Bun.serve` plus a WebSocket handshake) and a new `TabMcp` in every
`beforeEach`. One relay per file with a `reset()` between tests could halve it. That is a
guess; measure first with `bun test --reporter=junit` per test. Low priority (≤ 4 s).

**Total for the fast suite:** about −15 s from ui.test.ts and request-path, which every agent
runs before every commit.

---

## 5. Notifications

**Which tests raise real system notifications** (via `chrome.notifications.create` in
`connection.ts:1012`, `requireInteraction: true`):

- e2e block "the connection without the side panel":
  - #28: 1
  - #30: 4
  - #31: 4
  - #33: 2
- e2e #35: 1, the test's own `"e2e-stale"` notification
- fill-e2e #7: 3 "filled:" notifications
- firefox-fill #3: 1, through Firefox, which here is the owner's own Firefox.app

That is about 16 per run, and more for each agent running in parallel. Questions answered in
an open panel raise none (#26 proves that).

**Do they need the real API?** Only to prove that the real API is called, and that our ids
match what `chrome.notifications.getAll/clear` give back.

- Everything else is our logic and already goes through a seam: `QuestionsHost.notify/clear`
  (`connection.ts:993-1028`). `worker.test.ts` tests it with a fake (the 14 tests of
  "questions").
- Proposal: in the **test build only** (`TAB_MCP_TEST`, as the existing hooks in
  `background.ts:291-299`), a recorder replaces `create/clear/getAll`. Add a hook
  `tabMcpNotifications()` for the e2e helpers `notifications()` and `newNotification()`.
- One test switches back to the real API with a hook `tabMcpRealNotifications(true)`: #28
  after the merge, which creates, reads with `getAll` and clears one. Fill's "filled:"
  notice uses the recorder.
- `build.test.ts` "the test hooks are only in the test build…" keeps the recorder out of the
  store build.

**A switch that keeps them off the desktop.**

- I cannot cite a Chrome command-line switch that turns off macOS system notifications for
  extensions without changing the API's behaviour. That **needs trying** against the pinned
  Chrome for Testing, and is not something I would rely on.
- What does work, is citeable as macOS behaviour, and needs no code: the owner switches off
  notifications for "Google Chrome for Testing" in System Settings › Notifications. That
  app is used only by the tests.
- This does not help for Firefox, because the tests use the owner's real Firefox. Hence:
  use a separate Firefox via `FIREFOX_PATH` (section 2), and add the recorder for the
  Firefox build too.

---

## 6. Structure: a concrete proposal

**Convention: a file that launches a browser is named `*.browser.test.ts`.**

- Renames:
  - `ext/test/e2e.test.ts` → `extension.browser.test.ts`
  - `firefox-e2e` → `firefox.browser.test.ts`
  - `fill-e2e` → `fill.browser.test.ts`
  - `firefox-fill-e2e` → `firefox-fill.browser.test.ts`
  - `client/test/browser.test.ts` → `page.browser.test.ts`
  - `webmcp-browser` → `webmcp.browser.test.ts`
  - `serve-browser` → `serve.browser.test.ts`
  - `relay/test/code-field-browser` → `code-field.browser.test.ts`
  - `test/webmcp-spike/webmcp.test.ts` → `webmcp-canary.browser.test.ts`
  - `test/e2e/test/e2e.test.ts` → `calculator.browser.test.ts`
  - `examples/react-todo/test/e2e.test.ts` → `react-todo.browser.test.ts`
- The client's `identity-e2e.test.ts` and `oauth-e2e.test.ts` launch no browser and keep
  their names. "e2e" in a name says nothing about browsers today, which is part of the
  confusion.
- Each browser file starts with a shared gate, `test/browser-gate.ts`: `const run =
  process.env.TAB_MCP_BROWSER === "1"`. Discovery (`findChromeForTesting`, `findFirefox`)
  happens only after it, and `describe.skipIf(!run || …)`. Plain `bun test` then loads those
  files and spawns nothing.
- **A unit test keeps the convention right.** `test/conventions.test.ts` lists the files
  that import a harness (`browser.ts`, `cdp.ts`, `firefox.ts`, `webmcp-spike/browser.ts`,
  `test/e2e/test/stack.ts`). It fails if one is not named `*.browser.test.ts` or does not
  import the gate. A new browser test therefore cannot slip into the fast suite.

**Scripts (root `package.json`):**

- `verify`: `biome ci . && bun run typecheck && bun test && bun run conformance`. Unchanged
  text, but now no browser. `conformance` starts a relay and a tab in-process and no
  browser.
- `test:browser`: `bun scripts/test-browser.ts [filter…]`. It takes the lock, sweeps, then
  runs `TAB_MCP_BROWSER=1 bun test .browser.test [filter…]`. A filter narrows to one file,
  for example `bun run test:browser fill`.
- `test:browser:full`: the same with `TAB_MCP_BROWSER_FULL=1`, which turns on the full
  Firefox file, the canary and the idle test (`TAB_MCP_E2E_IDLE`).
- `verify:all`: `bun run verify && bun run test:browser`.

**The machine-wide lock** (`scripts/browser-lock.ts`):

- It is an atomic `mkdir` of a fixed directory, `/tmp/tab-mcp-browser-tests.lock`. The path
  is not under `os.tmpdir()`, because the sandboxed agents' `TMPDIR` differs from the
  owner's.
- Inside it: `owner.json` with the PID, the start time, the worktree and the filter.
- A second run prints "browser tests of PID N in <worktree> running since hh:mm; waiting",
  polls every 2 s and waits up to 15 minutes, then fails. `--no-wait` fails at once.
- A lock whose PID no longer runs (`process.kill(pid, 0)` throws) is stale and is taken over.
- It is released in `finally` and on SIGINT/SIGTERM.
- Waiting rather than failing stops agents from retrying in a loop.
- Whether the Bash sandbox lets every agent create `/tmp/…` must be checked (section 8). If
  not, `$HOME/.cache/tab-mcp/` is the fallback.

**The start-up sweep** (in `scripts/test-browser.ts`, before the run):

1. All harnesses put their profiles under one parent,
   `<tmpdir>/tab-mcp-test-browsers/<pid>-<n>/`.
   - Today's prefixes are scattered: `tab-mcp-extension-`, `tab-mcp-ext-`,
     `tab-mcp-ext-profile-`, `tab-mcp-chrome-`, `webmcp-spike-`, `tab-mcp-firefox-`,
     `tab-mcp-firefox-ext-`, `tab-mcp-fill-` and `tab-mcp-firefox-fill-`.
   - Build directories go under the same parent.
2. Kill: every process whose command line has `--user-data-dir=…/tab-mcp-test-browsers/` or
   `--profile …/tab-mcp-test-browsers/`, and whose `<pid>` in the folder name is no longer
   running. Read them with `ps -axo pid,command`.
   - Only orphans are killed, so a single file run without the lock is safe.
   - During the transition, also match the old prefixes.
3. Remove profile folders whose `<pid>` is dead.
4. PR 204 (killing all of a browser's processes) is the per-run half of this; the sweep
   covers runs that were killed with `kill -9` or a closed terminal.

**CI** (`.github/workflows/ci.yml`; any path filter must name what the tests depend on, per
iteration 19's reason for dropping one):

- **Skip the whole workflow when only `kb/**` changed** (`paths-ignore: ['kb/**']`). Biome
  already ignores `kb/`, and no test reads `kb/`. I found no test reading `kb/`; that should
  be confirmed in the PR. READMEs and CHANGELOGs are not ignored: they ship in packages, and
  tests may read them.
- **Job `fast`**: `bun run verify` (no browser).
- **Job `browser`**, in parallel: Chrome for Testing as now, then `bun run test:browser`.
  That is the Chrome suite plus the Firefox smoke, on every code change. A path filter by
  package would miss dependencies (relay, client, lockfile, `CHROME_VERSION`), so there is
  none.
- **Workflow `browser-full.yml`**: `bun run test:browser:full`.
  - `on.pull_request.paths`: `packages/tab-mcp-extension/**`,
    `packages/tab-mcp-client/src/extension*`, `packages/tab-mcp/src/config.ts`,
    `bun.lock`, `.github/workflows/**`.
  - Plus a nightly `schedule`, and `workflow_dispatch`.
  - **Do not make it a required check.** A path-filtered required workflow leaves PRs that
    do not match "waiting" forever.
- The canary runs in `browser-full`. Bumping `CHROME_VERSION` touches `.github/workflows/`,
  so it triggers there.

**What an agent runs before a commit:**

| Change | Run |
|---|---|
| `kb/` or other docs only | nothing (Biome ignores `kb/`) |
| code, no browser-facing change | `bun run verify` |
| extension, the client's dialogs/CSS/WebMCP mirror, the relay's pairing page or code field, a browser harness | `bun run verify`, then `bun run test:browser <the file that covers it>`; the rest is CI's |
| `CHROME_VERSION`, a dependency bump | `bun run verify`; leave the browser suites to CI |

**New wording for the rule in `CLAUDE.md`** (replaces "`bun run verify` (Biome CI, type
check, tests) before every commit"):

> Commands: `bun run verify` (Biome CI, type check, unit tests; starts no browser) before
> every commit that changes code; nothing for changes to `kb/` only. Browser tests are
> `*.browser.test.ts` and run in CI on every code change. Locally run
> `bun run test:browser <file>` (one suite at a time on the machine; a second run waits)
> only for the file that covers what you changed: the extension, a page's dialogs or styles,
> the relay's pairing page, a browser harness. Never run the browser suites "just in case".

**Expected times.**

- Fast suite (`bun test` without browsers), CI:
  - The per-test time of the non-browser files is 191 − 107.6 = **83 s**, plus a few
    seconds of their hooks.
  - Minus about 15 s (section 4), that gives **about 70 s** on CI, against about 242 s now.
  - Biome, typecheck and conformance come on top; I have no times for them.
  - On the owner's Mac alone it is likely faster. With several agents in parallel it is
    slower, but no browsers compete for the CPU any more.
- Browser suite per code change (CI):
  - Today: 107.6 s of tests plus about 46 s of hooks, about **155 s**.
  - After the plan, all estimates from the per-file numbers and the count of kept tests:
    - extension e2e: about 20 s of tests plus 6 starts (about 15 s), so **35 s**
    - fill-e2e: about **8 s**
    - Firefox smoke: about **7 s**
    - client, relay and example files: about **20 s**
  - Total: **about 70 s**, ±50 % until measured.
- Full browser run (extension changes or nightly): **about 100–110 s**, including the Firefox
  file with one 5–10 s event-page wait and the canary.
- In CI the two jobs run in parallel, so wall time is the slower job plus install, against
  about 242 s plus install today.

---

## 7. Work plan, in pull requests, most saving first

1. **Browsers out of the default run.**
   - Files: the 11 browser files (renamed, plus the gate), `test/browser-gate.ts`,
     `test/conventions.test.ts`, root `package.json` (`test:browser`, `verify:all`),
     `.github/workflows/ci.yml` (`verify` then `test:browser` in the same job, for now),
     `CLAUDE.md` (the rule above).
   - Safe because: the CI log shows the same 134 browser tests run, with the same counts as
     before. Locally, `bun test` with no `TAB_MCP_BROWSER` spawns no browser (checked by
     `ps` during a run, and the convention test fails for an ungated file).
   - Saving: all 27 browser starts and about 155 s of every local `verify`.
2. **Lock and start-up sweep, one profile parent.**
   - Files: `scripts/test-browser.ts`, `scripts/browser-lock.ts`, and the profile paths in
     `ext/test/browser.ts`, `ext/test/firefox.ts`, `client/test/cdp.ts`,
     `test/webmcp-spike/browser.ts`, plus the build directories in the extension tests.
   - Safe because: two `bun run test:browser` at once (the second waits and says why), and
     one killed with `kill -9` (the next run's sweep removes its Chrome and folder; `ps`
     shows none left).
   - Builds on PR 204.
3. **Notification recorder in the test build.**
   - Files: `ext/src/background.ts`, `ext/src/worker/connection.ts` (the `QuestionsHost` and
     the start-up clear under `TAB_MCP_TEST`), `ext/test/e2e` helpers `notifications`,
     `newNotification` and `clickNotification`, and `build.test.ts` (the recorder is only in
     the test build).
   - Safe because: the notification tests pass on the recorder, and one test still creates,
     reads and clears through the real API.
   - Also: Chrome for Testing instead of branded Chrome in `cdp.ts` (`CANDIDATES`), and a
     note in the README on `FIREFOX_PATH`.
4. **Fast suite timers.**
   - Files: `client/src/tab-mcp.ts` (`timing.allowDelayMs`), `client/src/confirm.ts` (reads
     it), `client/test/ui.test.ts`, `relay/test/request-path.test.ts`.
   - Safe because:
     - The rewritten "is 750 ms, a constant" test fails if `ALLOW_DELAY_MS` changes or the
       dialog stops waiting.
     - The concurrent idle test fails if `relay.ts:1287` stops restoring the timeout on any
       of its three paths (try: remove the restore, see it time out).
   - Saving: about 15 s on every `verify`.
5. **Extension e2e: logic to unit tests.**
   - The UNIT rows of 1.1 and 1.3 (e2e #2, 6, 7, 9, 10, 15–18, 21, 27, 30, 31, 34, 46, 48,
     60, 63; fill #2, 8, 9, 10).
   - Files: `ext/test/worker.test.ts`, `panel.test.ts`, `unit.test.ts`, `fill.test.ts`, then
     deleting the browser tests.
   - New unit tests where there are none:
     - set-allowed-all's filter (`connection.ts:711`)
     - "Ask for all" taking a dropped tool
     - no read with AI access off and no panel
     - fill with AI access off, and AI off withdrawing a fill
     - no `storage` permission in the manifest
     - the Firefox panel texts
     - `ToolRegistry.provide`'s quota and invalid tool
   - Safe because: each new unit test is written first and shown to fail against a mutant
     of the code the browser test caught. Examples:
     - drop the `state.tools.filter(…)` in `set-allowed-all` (test 16 failed for that)
     - drop the `#provided` bookkeeping in `provide`
     - make `#readTab` read without panels
     - Then delete the browser test.
6. **Extension e2e: merge and share browsers.**
   - The MERGE rows of 1.1. One browser per (build, WebMCP flag), `build()` memoised, one
     relay per file, fresh extension state between blocks. Restart scenario in 3 launches.
   - Files: `ext/test/extension.browser.test.ts`, `ext/test/browser.ts`.
   - Safe because: every assertion of a merged test is still in its target scenario (list
     them in the PR). Run 20 times on CI before merging: flakiness is the risk of a shared
     browser.
7. **Firefox: smoke and full.**
   - Files: `ext/test/firefox.browser.test.ts` (smoke block, full block gated), the
     event-page wait, UNIT moves (registry quota, panel words), and
     `ext/test/firefox-fill.browser.test.ts`.
   - Safe because: the full run nightly is green for a week. The smoke fails when
     `moz-extension://` is removed from the relay's allowed origins (try it).
8. **Client and example browser files.**
   - Trim `webmcp.browser.test.ts` to the contract (1, 9, 12, with 6, 8 and 10 folded in).
   - Vendor the `@mcp-b/global` file instead of downloading it.
   - One Chrome for webmcp and serve if a shared browser across files works (section 8).
   - Merge browser.test #6 into #5. Delete browser.test #3 and #4 (dup).
   - Files: `client/test/*.browser.test.ts`, `examples/react-todo/test/…`, `test/e2e/test/…`.
   - Safe because: client `webmcp.test.ts` has every deleted behaviour (names in 1.6).
9. **Canary to `browser-full`, drop spike #6, CI split.**
   - Files: `test/webmcp-spike/…`, `.github/workflows/ci.yml` (jobs `fast` and `browser`,
     `paths-ignore: kb/**`), `.github/workflows/browser-full.yml`.
   - Safe because: one docs-only PR shows no run. One extension PR shows `browser-full`.
     Branch protection keeps `fast` and `browser` required, not `browser-full`.

---

## 8. What I am unsure about

- **Per-test times.** I had per-file times only. Every saving per test is an estimate from
  the code (sleeps, waits, starts). Run `bun test --reporter=junit` once on CI before PRs 5
  to 8 to rank them.
- **Where the owner's notifications come from.** I assume headless Chrome for Testing, and
  the owner's Firefox for the fill test, raise them as macOS notifications, since the owner
  sees them. I could not check which browser shows them, or whether a killed Chrome leaves
  them in Notification Center.
- **A Chrome switch against system notifications.** I cannot name one with a source; it
  needs trying.
- **Sharing one browser across test files.** I did not confirm how Bun 1.4.4 runs several
  files in one `bun test` process (shared module cache or global object). That decides
  whether the plain-page files can share one Chrome without a preload or a small browser
  daemon. Check it with two files and a counter on `globalThis`.
- **`bun test` filters.** I rely on the positional filter matching path substrings
  (`bun test .browser.test`). I deliberately did not rely on an ignore flag; the env gate
  works without one.
- **Fresh extension state in a shared Chrome.** Whether `Extensions.uninstall`, or
  `Storage.clearDataForOrigin` plus a reload, is available and clean in the pinned Chrome is
  untested.
- **happy-dom.** Whether happy-dom 21 implements `:modal` and `inert` for `showModal()`
  affects how much of e2e #27 a unit test keeps.
- **uWebSockets' idle granularity.** The figure behind the 13 s of request-path is from
  memory.
- **The lock path under the agents' sandbox.** Whether every agent can create a fixed path
  in `/tmp` or `$HOME/.cache` under the Bash sandbox (my memory notes say the sandbox
  restricts some local access) must be tried from an agent.
- **Estimates of start-up cost** (2–3 s per extension start on CI, about 3 s per Firefox
  start) come from dividing the 51 s of hooks by the starts. They are not measured.
- **Whether no test reads `kb/`.** I grepped the test sources and found none. Confirm it in
  the PR that adds `paths-ignore`.

# Afterwards

Pull request 1 ([iteration 50](/iterations/iteration-50-browser-tests.md), DEC-218)
differs from section 6 where these held:

- No `paths-ignore: kb/**`: it would leave the required check without a report on a
  pull request that changes only `kb/`. Both test jobs start and pass at once instead,
  and the required `verify` waits for `fast` and `browser`. `bun run verify` passed with
  the same counts in a copy without `kb/`.
- `bun test .browser.test fill` does not narrow: Bun joins positional filters with "or".
  `scripts/test-browser.ts` picks the files itself; a filter matches the file's name.
- Bun counts the `beforeAll`/`afterAll` of a skipped `describe` as skipped tests (32 in
  the browser files), so "the same counts" means the passes per file.
- Measured on CI: `bun test` without browsers 86 s, the browser files 155 to 170 s.

# Citations

- [CI of main at 9f11a91: 1,890 tests in 86 files, bun test 242.65 s](https://github.com/ractive/tab-mcp/actions/runs/44984541830)
- [The test sources at 9f11a91](https://github.com/ractive/tab-mcp/tree/9f11a91329abe3f88591d71b55365aee6737930a)
