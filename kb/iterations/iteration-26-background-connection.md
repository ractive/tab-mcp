---
type: iteration
title: "Iteration 26: the connection without the side panel"
status: completed
description: >-
  The connection to the AI app moves out of the side panel into the service
  worker (the relay's heartbeat keeps it running; no offscreen document), so it stays
  while the panel is closed and comes back after a restart; the side panel becomes a
  view with its own pairing and question UI. A tool that asks first asks in the
  side panel of the tab's focused window, else in a Chrome notification.
timestamp: 2026-11-09T03:00:00+01:00
tags: [iteration, extension]
---
# Iteration 26: the connection without the side panel

Today the connection lives in the side panel's page (`TabMcp` and the bridge run there):
closing the panel ends it, and the AI app's next call fails (the owner's try on
2026-11-09). The connection moves out of the panel, which becomes a view and the place for
settings and questions (DEC-116).

## Where the connection goes

Two candidates; the spike decides, the first wins if it holds:

1. **The service worker.** Since Chrome 116 (the manifest's minimum) a WebSocket that
   carries messages keeps it alive. It has every extension API (tabs, scripting, storage,
   notifications, permissions, events), so no proxy is needed. The library runs without a
   document: its address secret goes into a `SecretStorage` over `chrome.storage` (a
   write-through cache, since the library reads synchronously), confirmations go through
   `onConfirm`, and `connect({ resume: true })` skips the user-activation check (which a
   worker cannot pass anyway). Open: whether the library uses anything else a worker lacks,
   and whether a quiet connection (only the library's keepalive) keeps the worker alive.
2. **An offscreen document** (reason `LOCAL_STORAGE`, for the address secret; not
   `WORKERS`, it spawns none). It has only `chrome.runtime`: tab calls, storage, the
   permission check and the events that drive the bridge (`tabs.onActivated`,
   `tabs.onUpdated`, `windows.onFocusChanged`, `permissions.onAdded/onRemoved`,
   `storage.onChanged`) all come through the service worker, whose listeners sit at its top
   level so they wake it; long calls keep the worker alive through a port. Chrome may stop
   the worker between calls, never in the middle of one.

Either way "the tab in front" is the active tab of the last focused normal window (the
panel's window no longer applies), and the connection is started again on every
service-worker start and on `onInstalled` when the user left AI access on (an update or a
reload must not leave it off while the setting says on).

## Messages and who may send them

- The side panel talks to the connection through one named port (`runtime.connect`), its
  sender checked once: an extension page (`sender.tab` absent) at the side panel's URL.
  Commands (connect, turn off, set allowed, set relay, answers to questions) and the state
  (which holds the address and a live pairing code) go only over such ports.
- Content scripts may send only `webmcp-changed`. A unit test checks that no message from a
  content script can connect, change a setting or answer a question.
- The click is the extension's rule, not the library's: AI access turns on only on the
  panel's command or at a start when the user left it on.

## The side panel as a view

- State on opening, changes as they come; closing the panel changes nothing, except that
  pairing stops (the port's disconnect calls `stopPairing()`).
- **Pairing of its own**, since the library's dialog would draw into a page nobody sees:
  `startPairing()` on "Pair an AI app", the address with Copy, the 6-digit code from
  `pairingcode`, the connected apps from `grantschange` with Disconnect (`revoke`),
  "New address" (`newAddress()`), the `replaced` notice, and short instructions for the
  AI apps (the library's are not exported: either export them from the client library or
  link to the docs; decided in the iteration).

## Questions (confirmation)

The library's `confirmInPage` draws into the connection's own document and keeps "Always
allow" in its own memory; neither works from the service worker or an offscreen document.
So the extension asks itself, in `onConfirm`:

1. Read-only tools and tools set to "allowed" for their site run, as now.
2. "Always allow" for this tool and AI app on this page: the extension's own memory, keyed
   by grant and tool, cleared when the grant goes (`grantschange`) or the tool is
   unregistered (`toolschange`), as the library's is.
3. Otherwise, if a side panel is open in the window of the tab the call acts on and that
   window is focused: the question in that panel (each panel holds a port that says its
   window; a panel that closes during a question hands it to a notification). The panel's
   dialog keeps the library's rule that Allow arms only after the panel was visible and
   focused for 750 ms.
4. Else a Chrome notification: `requireInteraction`, an id per call, title and body
   naming the AI app (its verified host beside its declared name), the tool and its site,
   and the arguments in short; Don't allow first, Allow second; a click on Allow within
   500 ms of showing does not count. A click on the body, closing it or letting it go is
   Don't allow. The notification's id carries the call; the connection keeps what is
   pending and the worker only passes on `{ id, button }`. A click answers only its own
   call, and a click on a call that is already settled (answered, timed out, cancelled)
   is dropped, never taken as an answer to another one.
5. A question of its own times out (60 s, with the AI app's cancel): the notification is
   cleared and the answer is Don't allow, and the AI app is told the user was asked and did
   not answer.

While a question is open the action icon shows a badge, so a user whose notifications are
off (Focus, Do Not Disturb, Chrome's notifications off) can open the panel and answer
there. The icon also shows while AI access is on: tools that need no question run with no
panel on screen.

## Questions to settle first (spike)

1. The service worker as the connection's home: the library without a document, the
   worker's life with a quiet WebSocket, sleep and long idle times. If it does not hold:
   the offscreen document, and whether its reason passes the Chrome Web Store's review.
2. Notifications on macOS, Windows and Linux: buttons, how long they stay, what is shown
   when notifications are off.

## Answers (2026-11-09)

1. **The service worker holds** (DEC-116); no offscreen document. The library runs there
   without a document: the address secret in a write-through cache over
   `chrome.storage.local`, `connect({ resume: true })`, icons read with `fetch`; the
   background bundle has no dynamic `import()` left (Bun inlines it without splitting; a
   unit test checks it). With nothing attached over DevTools, Chrome 156 kept the worker
   running for 70 s of a quiet connection (only the relay's heartbeat, a ping every 25 s
   that the library answers) and stopped it within 70 s once AI access was off; the
   check is in the end-to-end tests behind `TAB_MCP_E2E_IDLE=1`, since it takes two
   minutes. For sleep and long idle times an alarm wakes the worker once a minute while
   AI access is on; each start connects again (the restart test shows the same address
   coming back). The address changes once for whoever used the panel before: its secret
   was in the panel's `localStorage`, which the worker cannot read.
2. **Notifications**: in headless Chrome for Testing the API works as documented
   (`create` with two buttons and `requireInteraction`, `getAll`, `clear`), and the
   end-to-end tests answer through the same function a click calls. How they look and
   stay on macOS, Windows and Linux was not tested here: macOS shows Chrome's buttons
   under the notification's "Options" and may file it in Notification Center, and with
   notifications off `create` still succeeds without showing anything. That is why
   questions also show in every open side panel and the icon shows "?": the user can
   always answer there. To check by hand on the owner's Mac.

The library's timeout message stays "The user declined" for `page_<name>` tools (the
library answers that for every `false`); `webmcp_call` tells the AI app that the user
was asked and did not answer within 60 s.

## Tasks

- [x] The spike; its answers in this file and DEC-116
- [x] The connection and the bridge in their new home; tab calls and events (directly in
      the worker, or proxied for an offscreen document); restart on every worker start
      and on `onInstalled` when AI access was on
- [x] The panel's port, sender checks, the content scripts' one message; the unit test
- [x] The side panel as a view: state, commands, pairing of its own
- [x] Questions: allowed, Always allow, panel of the tab's window, notification, timeout;
      badge on the icon
- [x] Permissions (`notifications`, `offscreen` if used); README and store listing say why
      (`notifications` and `alarms`; the README's table is the store listing's source,
      iteration 23)
- [x] End-to-end: the panel closed after connecting, the AI app still calls tools; a
      question answered in the panel and one through the notification (the test calls the
      extension's own button handler in the service worker over the DevTools Protocol,
      with the id from `chrome.notifications.getAll()`; no test-only answer path in any
      build); a panel closed during a question; closing and reopening the panel shows the
      same state; a restart (the harness relaunches the same profile) reconnects the same
      address; a relay address set in the panel reaches the connection (the harness's
      `dataset.relay` marker becomes a state the panel shows from the connection)
- [x] Threat model (A13): who may send what, notifications as a place to ask, a
      connection on with no panel
- [x] Review: 10 findings, all fixed on the branch; merged on the owner's word

## Out of scope

Questions anywhere else (in the page); keeping the connection while Chrome is closed.

# Citations

- [Chrome extensions: WebSockets in service workers (Chrome 116)](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- [Chrome extensions: offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Chrome extensions: notifications](https://developer.chrome.com/docs/extensions/reference/api/notifications)
