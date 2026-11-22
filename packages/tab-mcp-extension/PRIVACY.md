# tab-mcp browser extension: privacy policy

The tab-mcp browser extension passes the WebMCP tools of the page in front on to an AI app the user
connects, through a tab-mcp relay, and lets that AI app open pages in that tab. This page
says what the extension reads, stores and sends. It is published by Jean-Pierre Bergamin,
Zurich, Switzerland (james@ractive.ch), and online at
https://ractive.ch/tab-mcp/privacy/#chrome.

## What it reads

Only tabs the user gave it, and only pages of http(s) sites (no `file:` pages, no
Incognito tabs): the tab where the user clicked the extension's icon (until that tab goes
to another origin; example.com and www.example.com are two origins), or every tab after the user clicked "Give access to all sites". From such
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

After the user clicks "Give access to all sites", every https page (and localhost) can
tell that it is installed. Where the browser has no WebMCP of its own (Firefox, and
Chrome or Edge without their WebMCP flag or a site's origin trial), the extension then
gives each page `document.modelContext` as it starts loading, so that it can register
its tools; in Firefox, a tab the user gave it by clicking its icon gets it then. A page's
script can see that the API is there and, from how it behaves, that it is this
extension's. It learns nothing else from it: not who the user is, not the relay, not the
AI app.

A page that uses the tab-mcp client library and offers its tools to agents in the
browser announces that to the extension (any page script could pretend to). Such a page,
and only such a page among those the extension may read, learns from the extension its
name and version, whether AI access is on, and the names and verified hosts of the AI
apps connected to the extension now, while it is open; and, right before one of its own
tools runs because the user allowed the call in the extension, that tool's name, the
arguments the page gets anyway, and which of those AI apps made the call. So the page
does not ask the user a second time. It learns nothing else: not who the user is, not
the relay, not the extension's address, not other tabs. From the page the extension
reads only what it announced: the library's version, its app id and the names and hosts
of the AI apps connected to the page directly, which the panel shows and which stay in
the browser.

After the user turns on the "Fill in the code for me" switch (off by default, also with
access to all sites), the extension sees the pairing page of the relay the user chose, and only that
page of it (`<relay>/authorize`). There it reads three attributes of the pairing form
(the app the AI app asks to connect to, the AI app's name and its host, which the relay
put there for this) and the form's hidden request id (the relay's id of that sign-in,
so that it can tell a page shown again after a wrong code from a new one). It reads
nothing else of the page. While AI access is on, it asks the user whether to connect
that AI app, and only after the user's Allow it writes its own pairing code into the
form's code field and submits the form, as the user would by typing it; for an AI app
whose host the user chose "Always allow" for, it does so without asking and tells the
user each time. The code goes to the relay, which already knows it; nothing else leaves
the browser, and nothing of the page is stored. The extension stores only that the user
turned this on, and for which relay, and the hosts chosen for "Always allow" (see
below); or, when it went off because the user took the relay's site away in the
browser's settings, for which relay, so that the panel can say why it is off.

## What it stores

In the extension's own IndexedDB in the browser, used by its service worker only:

- the address of the relay the user chose (by default `https://tab-mcp.ractive.ch`);
- whether AI access is on, and whether another tab or program took its place at the
  relay;
- for each relay it connected to, a random secret that identifies this installation to
  that relay (the address the AI app is given is the same for every installation; the
  secret is what tells them apart);
- the AI apps connected to it, as the relay last listed them: for each, the relay's id of
  its grant, the name the AI app gives itself and its verified host (for example
  `claude.ai`), so that the panel can show them while AI access is off; replaced by the
  relay's list whenever it connects, emptied by "Disconnect all apps" and when the relay
  changes;
- the tools the user allowed to run without asking, per site: the site's origin and the
  tool names;
- with "Fill in the code for me" on, the relay it is on for; when it went off because the
  user took the relay's site away in the browser's settings, that relay instead, for the
  panel's note;
- with "Fill in the code for me" on, the AI apps' hosts the user chose "Always allow"
  for (for example `claude.ai`) and the times of the last fills without a question (at
  most the last 3 per host, for the limit of 3 in 10 minutes); forgotten when the
  setting goes off or the relay changes.

None of this is synced to a Google account or kept outside the browser, and removing the
extension deletes it. The grants the relay holds for connected AI apps end when the user
disconnects an AI app, and 90 days after it connected at the latest.

## What leaves the browser

Only while AI access is on, and only to the relay the user chose:

- the connection to the relay and the connecting of an AI app (the relay stores a grant for
  each connected AI app; see the relay's own policy below);
- what the connected AI app asks for: the address, title and language of the tab in front
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
