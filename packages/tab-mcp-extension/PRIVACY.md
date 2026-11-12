# tab-mcp for Chrome: privacy policy

tab-mcp for Chrome passes the WebMCP tools of the page in front on to an AI app the user
connects, through a tab-mcp relay. This page says what the extension reads, stores and
sends. It is published by Jean-Pierre Bergamin, Zurich, Switzerland
(james@ractive.ch), and online at
https://ractive.ch/tab-mcp/privacy/#chrome.

## What it reads

Only tabs the user gave it: the tab where the user clicked the extension's icon (until
that tab goes to another origin), or every tab after the user turned on "Allow on all
sites". From such a tab it reads the page's address, title and language, and the tools
the page registered itself with WebMCP (`document.modelContext`): their names, titles,
descriptions and input schemas. Apart from what the page's own tools return when the AI app calls
them, it reads nothing else of the page: no page text, no
form fields, no cookies, no screenshots, no browsing history.

## What it stores

In the extension's own IndexedDB in the browser, used by its service worker only:

- the address of the relay the user chose (by default `https://tab-mcp.ractive.ch`);
- whether AI access is on, and whether another tab or program took the connection's
  address over;
- a random secret from which the connection's address is derived;
- the tools the user allowed per site: the site's origin and the tool names.

"Always allow" in a question is kept in memory only, for that page load. None of this is
synced to a Google account or kept outside the browser, and removing the extension
deletes it. The grants the relay holds for paired AI apps end when the user disconnects
an app, and 90 days after pairing at the latest.

## What leaves the browser

Only while AI access is on, and only to the relay the user chose:

- the connection to the relay and the pairing of an AI app (the relay stores a grant for
  each paired app; see the relay's own policy below);
- what the paired AI app asks for: the address, title and language of the tab in front
  (`page_info`), the list of its WebMCP tools (`webmcp_tools`), and for each tool call the
  tool's name, the arguments the AI app sent and the page's result.

A tool that the page does not mark read-only runs only after the user allowed it, in the
side panel or a notification. The relay passes the requests and results between the
extension and the AI app; the AI app's own privacy policy applies to what it does with
them.

The hosted relay `tab-mcp.ractive.ch` is run by the same developer. What it passes on,
stores and logs: https://ractive.ch/tab-mcp/privacy/. A relay the user runs or chooses
themselves has its operator's policy.

## What it does not do

- No analytics, no tracking, no advertising, no crash reports.
- No data is sold or given to third parties, other than the relay and the AI app the user
  chose, as above, and the relay's host (for the hosted relay bunny.net).
- No use of the data for anything but passing a page's tools to the user's AI app, and
  none to determine creditworthiness or for lending.
- No remote code: all the extension's code is in its package.

## Questions

Open an issue at https://github.com/ractive/tab-mcp/issues.
