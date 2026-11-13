---
type: iteration
title: "Iteration 35: tab-mcp for Chrome, correct before the store"
status: completed
description: >-
  Iteration G of the review of 2026-11-13: webmcp_tools gives input schemas, the ReDoS
  guard keeps parameters named pattern, a stuck page no longer holds the bridge, the
  panel says "retrying" instead of "off", page tools say why a call did not run, the
  ephemeral Always allow gives way to "Don't ask again on <host>" (owner, DEC-139),
  mirrored tools are offered (DEC-140), a navigating page tool is no failure, the origin
  comes from Chrome, http(s) only and no Incognito, test hooks only in the test build,
  and the store listing and both privacy pages describe the navigation tools.
timestamp: 2026-11-13T14:00:00+01:00
tags: [iteration, extension, review, security]
---
# Iteration 35: tab-mcp for Chrome, correct before the store

Iteration G of the [review of 2026-11-13](../research/review-2026-11-13.md): what had to
be right in tab-mcp for Chrome before its first submission to the Chrome Web Store.
Branch `iteration/35-extension-store`; the published privacy page in ractive/ractive.ch
on its own branch `tab-mcp/extension-privacy-navigation`. Decisions DEC-139 (owner) to
DEC-142. The panel's wording and accessibility (EQ 2, 6, 7, 8, 9, 11, 13, 16, 17) are
iteration H.

## Tasks

### EQ 1 (high): `webmcp_tools` gives no input schemas

- [x] `Offered` carries the schema as offered (patterns stripped, the same object the
  `page_<name>` tool has); a tool that is not offered, or that the library refused, has
  none
- [x] `webmcp_tools`, `webmcp_call` and the server instructions say so
- [x] Tests: bridge (state and `webmcp_tools`), e2e (`get_greeting`'s schema)

### ES 2: the ReDoS guard deletes properties named `pattern`

- [x] The walk follows `@cfworker/json-schema`'s own idea of where a schema is
  (`schemaMapKeyword`, `schemaArrayKeyword`, `ignoredKeyword`, plus `dependencies`):
  names under `properties`, `$defs`, `dependentSchemas` stay; `enum`, `const`, `default`,
  `examples` are data and stay untouched; an unknown keyword with an object value is
  walked, as the validator would reach it by `$ref`
- [x] Test with a parameter `pattern`, `$defs`, `dependentSchemas`, `dependencies`, data
  keywords and an unknown keyword

### ES 1: a page that does not answer blocks the bridge for every tab

- [x] `ask()` (list, `page_info`, history) gives up after 5 s (`ASK_TIMEOUT_MS`), so a
  read ends and the single-flight refresh is free again; this also covers `page_info`
  and the navigation tools
- [x] `webmcp_call` races its refresh against the AI app's cancel
- [x] Tests: `ask` with a content script that never answers; `callByName` cancelled while
  the list hangs

### EQ 3: "AI access is off" while the extension keeps reconnecting

- [x] `panelStatus`: down while AI access is on (and not taken over) is "retrying";
  switch on, badge "…"
- [x] Tests: unit (`panelStatus`), e2e (a restart with the relay out of reach)

### EQ 4: a timeout or "busy" reaches the AI app as "The user declined"

- [x] Changed differently from the review's first suggestion: `page_<name>` is no longer
  `consequentialHint`; it carries `destructiveHint` and asks in the bridge's `execute`
  through `confirm`, as `webmcp_call` and the navigation tools do (DEC-141). `decide`
  rejects with the reason (not allowed, not answered within 60 s, not asked). After the
  answer the tool runs only if it is still the same tool of the same page and tab
- [x] Tests: bridge (the reasons reach the AI app; a page that changed during the
  question), worker (`decide`)

### EQ 5: Always allow lost on a tab switch

- [x] Moot: the ephemeral Always allow is gone (EQ 10). Nothing done for it

### EQ 10: two overlapping "don't ask again" mechanisms (owner decision)

- [x] `always.ts`, its key logic in `decide`, `sameTool` in `decide`, the
  `keepGrants`/`keepTools` wiring removed (DEC-139)
- [x] The question's third button "Don't ask again on <host>" (`Answer` `"site"`) writes
  the per-site "allowed" entry through the panel's command queue
- [x] The notification has Allow only; its second button is gone
- [x] Tests: worker (decide writes "allowed"; notifications), navigation (the card's
  buttons), e2e (the panel's third button, the notification's buttons)

### EQ 12: the tool list disappears after a same-document navigation

- [x] `BridgeState.tabId`; the panel shows the bridge's tools when its last read was of
  the same tab and origin, not the same address
- [x] Test: bridge (`state.tabId`); the panel's read is covered by the e2e tool list
  tests

### EQ 14: the keep-up alarm is created only on a successful connection

- [x] `Connection.start()` creates the alarm when AI access is on
- [x] Test: e2e (alarm cleared, relay gone, restart: the alarm is there)

### EQ 15: under `activeTab`, a page that never reaches "complete" cannot be read

- [x] `ask()` injects whatever the tab's status; only a failed injection on a loading
  page answers "still loading"
- [x] Tests: unit (`ask` with a stubbed `chrome`)

### ES 4: "Site (verified)" is the content script's word

- [x] The bridge compares the list's origin with the origin of `tab.url` and offers no
  tools when they differ (DEC-142)
- [x] Test: bridge

### ES 5: a new question moves "Allow all" and the switches

- [x] A question card that is added sets `movedUntil` too
- [x] Test: e2e (the switch is disabled right after the first question appears)

### ES 6: size limits

- [x] The images of one result share 640 KiB of base64 (`MAX_IMAGES_BASE64`); an image
  beyond is replaced by a text note; text 100 000 characters: under the relay's 1 MiB
- [x] The content script refuses a result over 2 MiB with its own error
  (`MAX_SEND_RESULT`) and cuts the title (300) and language (64)
- [x] Tests: bridge (budget), unit (result size, title and language)

### ES 7 / EQ 22: test hooks in the store build

- [x] `TAB_MCP_TEST` (a `define` in `bundle()`): the `tabMcpNotification*` globals only in
  the test build; `storeProblems` refuses a script that contains them
- [x] `data-relay` removed from the panel in every build; the e2e `setRelay` waits on the
  relay field the panel fills from a state with a new relay
- [x] Tests: build (hooks only in the test build, the store check)

### ES 9: the optional host permission is wider than what the extension acts on

- [x] `http://*/*` and `https://*/*` for `optional_host_permissions`, the test build's
  `host_permissions` and the registered content script; `"incognito": "not_allowed"`
  (DEC-142)
- [x] Test: unit (manifest)

### WM 1: the dedupe attribute hides a tab-mcp page's tools

- [x] The extension no longer reads `data-tab-mcp-webmcp` (content script, messages,
  bridge state, panel) and offers mirrored tools (DEC-140). Client side: only the
  comments and README say that the extension does not read it; the attribute stays for
  ractive.ch (iteration F / EX 11 decide its future)
- [x] Tests: unit (a mirrored tool is listed and called), e2e (`page_mirrored_tool`)

### WM 2: a page tool that navigates the tab is reported as a failure

- [x] `callFailed`: a rejected call whose content script was there (the channel closed)
  is `navigated`, one that never reached it is `gone`
- [x] The bridge answers `navigated` and Chrome's `null` the same way: `{ navigated, note,
  page }`, the new page's `page_info` once it has loaded (`settledPage`), its tools
  offered before the answer
- [x] Tests: bridge, unit (`callFailed`), e2e (`test/pages/checkout.html`, a tool that
  calls `location.assign()` and never answers)

### ES 3 and ES 8: store listing and privacy pages

- [x] `kb/operations/chrome-web-store.md`: navigation in the description, the single
  purpose, the `activeTab`, notifications and host access rows, the data usage (address
  with query and fragment, the history check), the review notes and screenshots
- [x] `PRIVACY.md`: navigation, the history exception, the query and fragment, http(s)
  only and no Incognito, "Don't ask again" instead of Always allow, no
  `data-tab-mcp-webmcp`
- [x] ractive.ch `src/pages/tab-mcp/privacy/index.vto` `#chrome`: the same, in a PR of its
  own
- [x] Threat model A13/A14 (`docs/` and `kb/design/`), `kb/design/extension.md`, README,
  CHANGELOG

## Outcome

- Not done as the review suggested: ES 8's "send `origin + pathname + search` only". The
  fragment is how single-page apps route; it stays and is documented (DEC-142).
- `resultOf(null)` is gone: Chrome's `null` and a channel closed mid-call give the same
  answer with the new page.
- Chrome for Testing 157 passes the new e2e test of a navigating tool.
- **Review of PR 120** (claude 2, glm 2; all fixed). `webmcp_tools` lists at most
  192 KB of schemas together (`MAX_LISTED_SCHEMAS`, `listing()`): the library sends a
  result as text and as `structuredContent`, so 64 schemas of 16 KB would pass the
  relay's 1 MiB; a tool past the budget says where its schema is (`schemaLeftOut`). A
  tab whose address is not http(s) (a `file:` page a click granted with "Allow access to
  file URLs") is refused in `ask()` and not injected at a click (`isSitePage`).
  `callFailed` calls a call `navigated` only on Chrome's closed-channel and
  back/forward-cache messages; any other error is a plain failure. The wait for the new
  page after a navigating tool ends with the AI app's cancel only, not with what is left
  of the call's 60 s.
- **Review of ractive.ch PR 104** (claude 2, glm 3): tool annotations named among what
  is read, the allowed tools stored by origin, "allowed on that site" for tools only
  (a navigation to another origin asks each time), the navigations worded as actions;
  the same in PRIVACY.md. Answered: a one-time Allow keeps nothing, so there is nothing
  to disclose for it.
