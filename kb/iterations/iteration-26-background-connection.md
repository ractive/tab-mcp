---
type: iteration
title: "Iteration 26: the connection without the side panel"
status: planned
description: "The connection to the AI app moves from the side panel into an offscreen document, so it stays while the panel is closed; the side panel becomes a view and the place for settings. A tool that asks first asks in the side panel when it is open, else in a Chrome notification with Allow and Don't allow."
timestamp: 2026-11-09T02:30:00+01:00
tags: [iteration, extension]
---
# Iteration 26: the connection without the side panel

Today the connection lives in the side panel's page (`TabMcp` and the bridge run there):
closing the panel ends it, and the AI app's next call fails (the owner's try on
2026-11-09). The connection moves into an offscreen document, a hidden page Chrome keeps
for the extension; the side panel shows what is going on and holds the settings (DEC-116).

## Design

```text
AI app ──MCP──▶ relay ◀──WebSocket── offscreen document (TabMcp, bridge)
                                        │ runtime messages
                         service worker ┤ (chrome.tabs, scripting, notifications)
                                        │
                     side panel (view) ─┘        content script in the tab
```

- **Offscreen document** (`chrome.offscreen`, one per extension): runs `TabMcp`, the
  extension's tools and the bridge. It has only `chrome.runtime`, so everything about tabs
  goes through the service worker: which tab is in front, sending to the content script,
  injecting it.
- **Service worker**: creates the offscreen document when the user turns AI access on and
  at browser start when it was on; proxies the tab calls; shows notifications. Chrome may
  stop it between calls; every call starts it again.
- **Side panel**: a view. It asks the offscreen document for the state (connection, apps,
  the tab and its tools, allowed tools) and shows changes it is told about; Connect, Turn
  off, the "allowed" switches and the relay address are messages to the offscreen
  document. Closing it changes nothing.
- **Pairing**: the library's own dialog would open in the invisible offscreen page. The
  side panel shows the address and the pairing code itself, from the library's events
  ("Your own UI" in the client README: `pairingcode`, `grantschange`, `stopPairing()`).
- **Connect needs a click**: the library's `connect()` refuses without user activation,
  which only the side panel has. A click there asks the offscreen document to
  `connect({ resume: true })`; after a browser restart it reconnects the same way if the
  user left AI access on.
- **Confirmation** (`onConfirm` in the offscreen document): read-only and "allowed" tools
  run (as now); otherwise, with the side panel open, the question is shown there (as now);
  with the panel closed, a Chrome notification ("Allow Run RPL on ractive.ch?") with Allow
  and Don't allow. No answer before the call's timeout means Don't allow. The library's
  focus delay does not apply to a notification: a click on a notification's button is the
  user's own action outside the page.
- **"Always allow"** (for this tool on this page) stays in the side panel's dialog: a
  notification has at most two buttons, Allow and Don't allow. To stop being asked with
  the panel closed, the user sets the tool to "allowed" in the panel.

## Questions to settle first

1. Which `chrome.offscreen` reason fits and passes the Chrome Web Store's review: the
   document keeps a WebSocket open and uses `localStorage` (the library's address secret),
   so `LOCAL_STORAGE` or `WORKERS`; whether Chrome closes an offscreen document on its own
   (it does for audio after silence; for others not, as far as documented).
2. Whether the WebSocket in an offscreen document survives long idle times and sleep, and
   how the library's reconnect behaves there.
3. Notifications on macOS, Windows and Linux: buttons shown, how long they stay, what a
   click on the notification's body does (open the side panel? `sidePanel.open` needs a
   user gesture, which a notification click is).

## Tasks

- [ ] Spike the three questions; write the answers into this file
- [ ] Offscreen document with `TabMcp`, the tools and the bridge; the service worker's
      tab proxy; the content script unchanged
- [ ] Side panel as a view: state, events, actions as messages; pairing UI of its own
- [ ] Confirmation: side panel when open, notification when closed, timeout as Don't allow
- [ ] AI access on at browser start if the user left it on
- [ ] Permissions: `offscreen`, `notifications`; the README and the store listing say why
- [ ] End-to-end: the panel closed after connecting, the AI app still calls tools; a
      consequential call answered through the notification (clicked over CDP, or the
      notification API's click event in a test build); closing and reopening the panel
      shows the same state; a browser restart reconnects
- [ ] Threat model (A13): notifications as a place to confirm, a closed panel
- [ ] Review; merged on the owner's word

## Out of scope

Confirmations anywhere else (in the page); keeping the connection when Chrome is closed.

# Citations

- [Chrome extensions: offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Chrome extensions: notifications](https://developer.chrome.com/docs/extensions/reference/api/notifications)
