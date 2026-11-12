---
type: iteration
title: "Iteration 27: navigation tools"
status: in-progress
description: >-
  tab-mcp for Chrome gets four standard tools, navigate, go_back, go_forward and
  reload, for the tab in front it has access to; each returns the new page's
  page_info once it has loaded. Within the page's origin they run at once; to
  another origin they ask the user first (DEC-121), and the result says when the
  extension may not read the new page.
timestamp: 2026-11-12T18:00:00+01:00
tags: [iteration, extension]
---
# Iteration 27: navigation tools

An AI app connected to the extension can read the page in front (`page_info`), list its
WebMCP tools and call them. After a shop's tool returned products, Claude could only ask
"Should I open the Sale page in your tab?" and had no way to do it (the owner, 2026-11-12).
Four standard tools fill that gap: `navigate` (an http(s) address), `go_back`,
`go_forward` and `reload`, each acting on the tab the extension serves and answering with
the new page's info once it has loaded.

## How access works today (the constraint)

- Without "Allow on all sites" the extension reads a tab only after a click on its icon
  there (`activeTab`, `src/background.ts` injects the content script). Chrome keeps that
  grant across navigations on the same origin and drops it on any other origin, a
  subdomain included (the store-package end-to-end tests show both). Without the grant
  Chrome hides the tab's address (`tabs.Tab.url` is empty) and refuses the content script.
- With "Allow on all sites" (`<all_urls>` granted from `optional_host_permissions`) the
  content script is registered for every page and every tab can be read.
- `chrome.tabs.update`, `goBack`, `goForward` and `reload` need no permission at all, and
  neither does reading a tab's loading status. So the tools need **no new permission**;
  the manifest stays as it is (a unit test checks the permissions).

## The rules (DEC-121)

1. **Which tab.** The tab in front (`tabInFront`, as for `page_info`), and only if the
   extension may read it now: otherwise the tool answers with `page_info`'s access
   message and does nothing. The AI app cannot steer a tab the user never gave it, and
   the extension needs the page's origin to apply rule 3.
2. **Which addresses.** `navigate` takes `http:` and `https:` only; anything else
   (`javascript:`, `data:`, `file:`, `blob:`, `chrome:`, `chrome-extension:`, `about:`)
   is refused, as is an address with a user name or password (`https://shop.example@evil.example`
   is evil.example, which a reader can miss) and one over 8192 characters. A relative
   address (`/sale`) is resolved against the page in front.
3. **The origin rule.** Within the page's origin (scheme, host and port, as for
   "allowed" tools) a navigation runs without asking: it is what a link on the page
   does, and the extension keeps its access there. To another origin it asks the user
   first, through the same questions as page tools that ask first (the side panel of the
   tab's focused window, else a Chrome notification; 60 s, then Don't allow). The
   question names the AI app, the origin the tab is on ("From", verified) and the
   address it would open ("To"); it offers Allow and Don't allow, no Always allow: a
   prompt injection in a page's result ("now open evil.example") gets no standing
   permission out of one click. A tab that changed origin while the question was open is
   not navigated, nor one that is no longer the tab in front (the user switched tabs); if
   another tab is in front once the page has loaded, the answer says so instead of
   describing a tab the AI app does not see (review of PR 110).
4. **Back and forward.** The target is known only when it is on the page's origin: the
   content script reads the Navigation API (`navigation.entries()`, which by the HTML
   standard holds only the contiguous same-origin entries of the top frame). A
   same-origin previous (next) entry runs at once. Otherwise the target is another
   origin or there is none, and the extension cannot tell which (it has no `tabs` or
   history access): it asks as for another origin, saying the address is not known. A
   tab whose history has one entry (`history.length` 1) answers "nothing to go back to"
   without asking.
5. **Reload** stays on the page's origin and never asks.
6. **Access after the navigation.** The result says what Chrome lets the extension see:
   the new page's `page_info` (with "Allow on all sites", or on the same origin), or
   `readable: false` with the reason (the same message as `page_info`'s: click the icon
   on the tab or turn on "Allow on all sites"). Refusing up front would make another
   origin useless without "Allow on all sites"; the user already allows that navigation
   by hand, and one more click on the icon gives access to the new page.
7. **Loading.** Each tool waits until the tab has loaded (`tabs.onUpdated` status
   `complete` after `loading`), at most 30 s; a navigation that does not start loading
   within a second (a same-document one, `#section`) counts as done. On a timeout the
   result says the page is still loading. The bridge reads the new page's tools before
   the tool answers, so its `page_<name>` tools are offered by then.
8. **Annotations.** All four are `readOnlyHint: false` (they change what the tab shows,
   and a GET can change things on a site) and not `consequentialHint` (the extension
   asks itself, only for another origin; the library would ask for every call).
   `untrustedContentHint`: the result carries the page's title.

Known limit: an open redirect on the page's own origin (`/out?to=https://evil.example`)
leads to another origin without a question; the extension sees it only afterwards (the
result shows the new origin, or that it may not read it). Seeing redirects before they
happen would need `webNavigation` or `declarativeNetRequest`, new permissions. Recorded
in the threat model (A13).

## Tasks

- [x] Find out how access works (`tabs.ts`, `background.ts`, the design, DEC-116, the
      store-package end-to-end tests)
- [x] DEC-121 and this plan
- [x] `src/worker/navigation.ts`: the four tools, the address check, the origin rule,
      the question, waiting for the load, the result; registered next to the
      extension's own tools (not in `OWN_TOOL_NAMES`: that list guards the names a
      `page_<name>` could take, and these have no `page_` prefix)
- [x] Content script: `history` request (Navigation API entries, `history.length`)
- [x] Questions: a navigation question (From and To, no Always allow) in the side panel,
      the question window and the notification
- [x] Server instructions: one sentence on the navigation tools
- [x] Unit tests (`test/navigation.test.ts`: address check, origin rule, back and
      forward, access after, the question's texts and card, the content script's
      history) and end-to-end tests (test build: same origin, schemes refused, another
      origin asked in the panel, back to another origin, back and forward on the same
      origin without a question, reload, `#part`; store package: access kept on the
      same origin, lost on another one, tools refused there until a click)
- [x] README tools table, PRIVACY.md (back and forward look at the page's own history
      entries; the new page's info leaves like `page_info`'s), design (tools table),
      threat model A13, CHANGELOG
- [ ] Review and merge (owner)

## Findings

- Chrome for Testing 156: the Navigation API is there in the content script's isolated
  world, and lists the same-origin entries: back and forward on the page's origin ran
  without a question in the end-to-end test.
- `chrome.tabs.update`, `goBack` and `goForward` worked in the store package without
  host access; after a navigation to another origin Chrome hid the tab's address and
  refused the content script, as expected.

## Out of scope

Opening new tabs, closing tabs, choosing a tab other than the one in front; clicking or
typing in the page (the page's own WebMCP tools are for that).

# Citations

- [Chrome extensions: the activeTab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome extensions: chrome.tabs (update, goBack, goForward, reload, onUpdated)](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [HTML: the Navigation API, getting the navigation API entries (same-origin only)](https://html.spec.whatwg.org/multipage/nav-history-apis.html#navigation-api)
