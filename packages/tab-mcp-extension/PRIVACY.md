# tab-mcp for Chrome: privacy policy

tab-mcp for Chrome passes the WebMCP tools of the page in front on to an AI app the user
connects, through a tab-mcp relay, and lets that AI app open pages in that tab. This page
says what the extension reads, stores and sends. It is published by Jean-Pierre Bergamin,
Zurich, Switzerland (james@ractive.ch), and online at
https://ractive.ch/tab-mcp/privacy/#chrome.

## What it reads

Only tabs the user gave it, and only pages of http(s) sites (no `file:` pages, no
Incognito tabs): the tab where the user clicked the extension's icon (until that tab goes
to another origin), or every tab after the user turned on "Read all sites without a click". From such
a tab it reads the page's address (with its query and fragment, as the browser shows it),
title and language, and the tools the page registered itself with WebMCP
(`document.modelContext`): their names, titles, descriptions, input schemas and
annotations (such as read-only). Apart
from that and what the page's own tools return when the AI app calls them, it reads
nothing else of the page: no page text, no form fields, no cookies, no screenshots. It
reads no browsing history, with one exception: when the AI app asks to go back or forward
in the tab, it checks, in the page, whether the page before or after is on the same
origin (and its address if so), and how many entries the tab's history has; that stays
in the browser.

## What it stores

In the extension's own IndexedDB in the browser, used by its service worker only:

- the address of the relay the user chose (by default `https://tab-mcp.ractive.ch`);
- whether AI access is on, and whether another tab or program took the connection's
  address over;
- a random secret from which the connection's address is derived;
- the tools the user allowed per site (with "Don't ask again" in a question or in the
  side panel's tool list): the site's origin and the tool names.

None of this is synced to a Google account or kept outside the browser, and removing the
extension deletes it. The grants the relay holds for paired AI apps end when the user
disconnects an app, and 90 days after pairing at the latest.

## What leaves the browser

Only while AI access is on, and only to the relay the user chose:

- the connection to the relay and the pairing of an AI app (the relay stores a grant for
  each paired app; see the relay's own policy below);
- what the paired AI app asks for: the address, title and language of the tab in front
  (`page_info`; the address with its query and fragment, so a link that carries a token
  in it is sent as it is), the list of its WebMCP tools (`webmcp_tools`), for each tool
  call the tool's name, the arguments the AI app sent and the page's result, and after
  the AI app opened a page in the tab, went back or forward or reloaded it, or a page
  tool took the tab to another page, the same as `page_info` for the new page.

The AI app can open pages in the tab in front (`navigate`, `go_back`, `go_forward`,
`reload`). A page tool that the page does not mark read-only runs only after the user
allowed it, in the side panel or a notification, or after the user allowed that tool on
that site. A navigation to another origin runs only after the user allowed it, each time;
a navigation on the page's own origin runs without a question, as a link on the page
would. The relay passes the requests and
results between the extension and the AI app; the AI app's own privacy policy applies to
what it does with them.

The hosted relay `tab-mcp.ractive.ch` is run by the same developer. What it passes on,
stores and logs: https://ractive.ch/tab-mcp/privacy/. A relay the user runs or chooses
themselves has its operator's policy.

## What it does not do

- No analytics, no tracking, no advertising, no crash reports.
- No data is sold or given to third parties, other than the relay and the AI app the user
  chose, as above, and the relay's host (for the hosted relay bunny.net).
- No use of the data for anything but passing a page's tools to the user's AI app and
  opening pages in the tab for it, and none to determine creditworthiness or for lending.
- No remote code: all the extension's code is in its package.

## Questions

Open an issue at https://github.com/ractive/tab-mcp/issues.
