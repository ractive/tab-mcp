---
type: research
title: "Test browsers and the owner's desktop: notifications off, never the installed browsers"
description: "Tried on 2026-11-22 against Chrome for Testing 156.0.8078.80 and Firefox 160.0.1 on macOS: --disable-features=NativeNotifications keeps Chrome's notifications off the macOS desktop while chrome.notifications create, getAll and clear answer as before; Firefox's alerts.useSystemBackend=false does too but its alert windows take the focus from the panel, so the Firefox test build records its notifications instead; how it was observed (usernoted's log), and the pinned test browsers from Puppeteer's cache."
timestamp: 2026-11-22T08:10:00+01:00
tags: [tests, browser, notifications, chrome, firefox, macos]
---
# Test browsers and the owner's desktop

Iteration 50's third pull request (DEC-220). The audit
([research](/research/browser-test-audit-2026-11-22.md), section 5) counted about 16 real
system notifications per run of the extension's browser tests, each with
`requireInteraction: true`, and could not name a browser switch that keeps them off the
desktop. The tests also started the owner's own browsers when `CHROME_PATH` or
`FIREFOX_PATH` was not set.

## How a delivery shows

macOS's notification daemon `usernoted` logs every notification it delivers, readable
without extra rights:

```sh
/usr/bin/log show --last 5m --predicate 'process == "usernoted"' --style compact | grep Delivering
```

- Chrome for Testing: `Delivering <NotificationRecord app:"com.google.chrome.for.testing.framework.AlertNotificationService" … req:"r|Default|<extension id>-<notification id>" …>`,
  so a test's notification can be told by its id.
- Firefox: `Delivering <NotificationRecord app:"org.mozilla.firefox" … req:"" …>`: no id,
  only the time tells a test's from the owner's own Firefox.
- The notification database itself
  (`~/Library/Group Containers/group.com.apple.usernoted/db2/db`) is closed to an agent
  ("Operation not permitted").
- Over the three hours before the experiment the log held many deliveries of
  `com.google.chrome.for.testing` (the browser tests) and of `com.google.Chrome` (tests
  that had fallen back to the owner's Chrome).

## The experiment

One script per browser (not kept; the check that stays is
`packages/tab-mcp-extension/test/notifications.browser.test.ts`). It did the following, once
without and once with the switch, the Chrome pair twice in both orders:

1. Start the test build headless.
2. Create one notification like a question's (`type: "basic"`, two buttons,
   `requireInteraction: true`, `priority: 2`).
3. Read it back with `getAll`, wait 2 s, `clear` it, read `getAll` again.
4. Read usernoted's log for the window.

| Browser | Setting | `getAll` | `clear` | `getAll` after | Delivered to macOS |
|---|---|---|---|---|---|
| Chrome for Testing 156.0.8078.80 | none | `["experiment"]` | `true` | `[]` | yes (07:56:09, 08:00:07) |
| Chrome for Testing 156.0.8078.80 | `--disable-features=NativeNotifications` | `["experiment"]` | `true` | `[]` | no (07:56:29, 07:59:46) |
| Firefox 160.0.1 (Puppeteer's) | none | `["experiment"]` | `true` | `[]` | yes (07:58:38) |
| Firefox 160.0.1 (Puppeteer's) | `alerts.useSystemBackend: false` | `["experiment"]` | `true` | `[]` | no (07:59:00 to 07:59:29) |

- **Chrome:** without `NativeNotifications` Chrome keeps its notifications in its own
  notification center, which a headless Chrome does not draw. The extension API answers
  as before.
- **Firefox:** with `alerts.useSystemBackend` false, Firefox uses its own alert windows,
  which headless Firefox does not show, but **they change behaviour**. In the first
  browser run with the pref, `firefox.browser.test.ts` "a tool not marked read-only asks
  in the panel first" failed: the panel's focus hint was still showing when the question
  was answered. Its helper's comment already says headless Firefox hands the focus "to a
  window it created after the panel's, at times", and an alert window is such a window.
  The test had passed with the system backend. So Firefox keeps its system backend, and
  the **Firefox test build records its notifications** instead (`src/background.ts`,
  `src/worker/notifications.ts`, `tabMcpNotificationRecorder()`). The recorder is in the
  Firefox test build only: `build.test.ts` checks the store and development builds of both
  browsers. `firefox.browser.test.ts` (review of PR 213) reads it from the panel through
  `runtime.getBackgroundPage()`:
  - a question shows up as a notification with its title, message, context line and icon,
    and with neither buttons nor `requireInteraction`, as `notificationOptions` strips them
    for Firefox;
  - answered through the hook (button 0 is Allow), the call runs and the notification is
    cleared;
  - and one test passes those recorded options to Firefox's real `notifications.create`,
    then `getAll` and `clear` at once.

  That real call is the one Firefox notification of a run that could reach a desktop. In
  the run of 2026-11-22 08:52, usernoted logged no Firefox delivery at all: the
  reinstalled test Firefox has perhaps never been allowed to notify. That cannot be told
  from here.
- **Clicks:** the tests answer a notification through the worker's own handlers
  (`tabMcpNotificationButton`, `tabMcpNotificationClicked`, `tabMcpNotificationDismissed`,
  the same functions the `chrome.notifications` events call); no test clicks a macOS
  notification. So nothing a test asserts depends on the desktop. Chrome needs no recorder:
  its tests keep the real API, `create`, `getAll` and `clear` included.
- **Limits:** one machine (macOS, arm64), one version of each browser, two tries for
  Chrome and one for Firefox. A Chrome that renames or drops the feature would show
  notifications again.
- **What the macOS guard can and cannot see** (`notifications.browser.test.ts`): it has
  no positive control, since a control would put a notification on the owner's desktop at
  every run. So it also passes when macOS would not show Chrome for Testing's
  notifications anyway (never allowed in System Settings), when usernoted hides the
  request id (`<private>`) or logs in another format, or when `log show` has no line for
  it. On a machine like the experiment's it fails if the switch stops working. The weight
  is carried without a browser: `scripts/browsers.test.ts` fails when a Chrome launch list
  in the code lacks `chromeSwitches(…)`. `log show` gets 15 s; past that the test fails as
  "could not check".
- The experiment ran at a load of about 14 (another session's tests); it does not depend
  on load.

## The browsers the tests start

- **Chrome:** Chrome for Testing in the pinned version (`CHROME_VERSION`, the same as
  CI's), from `CHROME_PATH` or `~/.cache/puppeteer/chrome/<platform>-<version>/`. Never an
  installed Chrome. Before, `cdp.ts` fell back to `/Applications/Google Chrome.app`, and
  the other harnesses took the newest Chrome for Testing in Puppeteer's or Playwright's
  caches.
- **Firefox:** a test Firefox in the pinned version from Puppeteer's cache
  (`bunx @puppeteer/browsers@3.2.7 install firefox@stable_160.0.1 --path ~/.cache/puppeteer`
  puts it at `~/.cache/puppeteer/firefox/mac_arm-stable_160.0.1/Firefox.app`; its bundle id
  is `org.mozilla.firefox`, as the owner's). Or `FIREFOX_PATH`. An installed Firefox only
  with `TAB_MCP_SYSTEM_FIREFOX=1` (`test:browser --system-firefox`), and then even when
  the pinned one is cached, said on stderr. Before, the tests used
  `/Applications/Firefox.app`, the owner's own.
- **CI:** Chrome for Testing from `browser-actions/setup-chrome` (`CHROME_PATH`), and
  since the review of PR 213 the same pinned test Firefox, installed in each job with the
  same `bunx @puppeteer/browsers` line (`scripts/browsers.test.ts` checks every job that
  runs the browser tests). The first version named the runner image's Firefox instead
  (`/usr/bin/firefox`, 160 on 2026-11-22, not pinned).

# Citations

- [The audit of the browser tests, section 5](/research/browser-test-audit-2026-11-22.md)
- [Decision log](/decision-log.md), DEC-220
- [@puppeteer/browsers on npm](https://www.npmjs.com/package/@puppeteer/browsers)
