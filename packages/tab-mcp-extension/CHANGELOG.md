# Changelog of the tab-mcp browser extension

All notable changes to the tab-mcp browser extension (called tab-mcp for Chrome up to
0.1.0), released with the Git tag `extension-v<version>`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

The browser extension (`packages/tab-mcp-extension`), in the Chrome Web Store, Microsoft
Edge Add-ons and addons.mozilla.org. Each release attaches its store package,
`tab-mcp-browser-extension-<version>-store.zip` (up to 0.1.0
`tab-mcp-for-chrome-<version>-store.zip`), to the GitHub release `extension-v<version>`;
from 0.3.3 also the Firefox package `tab-mcp-browser-extension-firefox-<version>-store.zip`
and the source archive `tab-mcp-<version>-source.zip` it builds from.

## Unreleased

### Added

- **WebMCP on a click** (DEC-223). Where the browser has no WebMCP (Chrome without its
  flag on a site outside the origin trial, and Firefox), a page the extension may read
  that has no WebMCP, in practice a tab given by a click on its icon, gets the
  extension's own then, while AI access is on (an https page, or the loopback host's
  http one), and is told so with the page event `tab-mcp-webmcp`. A page built with the
  tab-mcp client library (from the release after 0.23 on) looks again and offers its
  tools, with the handshake and the vouch as before. In Chrome the same follows a
  reload or another page of the same origin without another click. A page that looked
  for WebMCP only as it loaded registers nothing: the panel says so in a line of its
  own, and `page_info` in a note. With access to all sites nothing changes: a page gets
  the extension's WebMCP as it loads, or as the content script comes to a page that
  loaded before, whatever AI access.

### Changed

- **The side panel's "This page has no WebMCP" text** says that tab-mcp gives a page its
  own while AI access is on, and that pages which look for it only as they load need
  access to all sites and a reload. It no longer shows while the extension's WebMCP is
  on its way to the page.
- **A tab the extension may not read: new words in the side panel, so that the icon is
  found.** The notice says "tab-mcp may not read this tab yet. Click its icon in
  Chrome's toolbar, or give it access to all sites." with the extension's icon after
  "Click its icon". The line under "Give access to all sites" says what that access
  does ("With access to all sites, tab-mcp reads every tab without a click on its icon
  and gives every page WebMCP as it loads. Chrome asks you first."), and a last line says
  where to pin the icon when it is not in the toolbar.
- **Firefox: a click counts for one page.** Firefox ends the click's access at every
  navigation, a reload and the same origin included; the panel ("Without that access,
  Firefox asks for the click again on every new page."), `page_info`'s refusal and the
  navigation tools now say so (they said, as for Chrome, that the access lasts until the
  tab goes to another origin). The privacy policy says it too. The sidebar's last line
  names Firefox's Extensions button and its Pin to Toolbar.
- **After a click, nothing goes into the page while AI access is off.** The content
  script that a click puts into a page without host access sends nothing into the page
  and installs nothing until AI access is on: in Chrome it no longer posts its port to
  the extension's page-world WebMCP at once (there was none without host access to
  answer it), in Firefox it no longer installs its WebMCP at once, nor takes over a
  state an earlier content script left there (a page could fake it). With host access
  for the page it does what it did before, whatever AI access.

## [0.3.3][extension-0.3.3] - 2026-11-23

### Changed

- **While AI access is off, the extension answers no page and sends it nothing**
  (DEC-221). It does not even read what a page sends then: a page can no longer tell
  from the extension's answer, or from Chrome running the page's own code when the
  extension reads it, that the extension is installed. A page can still see that the
  extension is installed where it provides WebMCP itself (in browsers without their
  own), and could try to time its own events, which the extension still listens to.
- **A page it told that AI access is on is told once that it went off**, also when the
  page comes back from the browser's back/forward cache, when host access to its site
  was withdrawn, and, the next time the page speaks or is shown again, when the
  extension was disabled, removed or updated. No vouch goes to a page that was not told
  "on"; a call that comes before the page was told tells it first, so that the page
  does not ask again.
- **The extension no longer tells such a page its version.** While AI access is on, the
  page learns its name, that AI access is on and the AI apps connected now, as before.
- **With client 0.21.0 and older** a page no longer shows the AI apps connected through
  the extension (the library takes "on" only with a version), and the panel does not
  warn that an AI app connected to the page directly too sees its tools twice (such a
  page does not answer the extension's greeting) until the page's own AI apps change.
  The panel still says "This page has tab-mcp built in.", and calls the user allowed in
  the extension are still not asked again in the page. Client versions after 0.21.0
  have all of it.
- **The side panel while AI access is off** says "This page has tab-mcp built in." for
  a page that announced the library, but the warning about an AI app that sees the
  page's tools twice comes only once AI access is on (a moment after connecting).
- Firefox: needs Firefox 140 or later (was 128), where Firefox reads the data collection
  the add-on declares (DEC-195).
- A release publishes the Firefox package to addons.mozilla.org too, with the source
  archive for its reviewers, as it publishes to the Chrome Web Store and Edge Add-ons.

### Fixed

- **A page tool that takes the tab to another page could take 30 seconds to answer**
  although the page had loaded, and then said it was still loading. The extension now
  notices the finished load whichever of Chrome's two signals arrives first, and it
  does not answer with the page the tab is about to leave.

## [0.3.2][extension-0.3.2] - 2026-11-22

### Added

- **"Always allow" for the sign-in question** (DEC-213), for an AI app whose verified
  host is a public name (not `localhost`, an IP address or a private or test name such as `.lan` or `.test`): "Don't allow",
  "Allow once", "Always allow". After "Always allow", that host's next sign-in pages are
  filled in without a question, each with a notification and a line in the panel
  ("Filled in the code for <AI app> (<host>)."), at most 3 per host in 10 minutes before
  the question comes back. "Filled in without asking for:", under "Fill in the code for
  me", lists the hosts, each with Remove; turning the switch off, losing the relay's
  site or using another relay forgets them. The notification of such a question offers
  "Allow once"; "Always allow" is in the panel.

### Changed

- **A page tool is destructive for the AI app only when the page says so** (DEC-214).
  `page_<name>` carried `destructiveHint: true` for every tool that is not read-only,
  because the extension asks before it runs; the hint should say what the page says
  about the tool. Now `destructiveHint` is the page's `consequentialHint` (false when the
  page says false), and true only when a page that registers its tools with WebMCP
  itself gave the tool no annotations at all. A page built with the tab-mcp client
  library always gives them: a tool without hints is not consequential there, so not
  destructive. Claude sorts tools by it: a page tool that is not consequential is now among "Other
  tools" in its settings, not "Write/delete tools", as on a direct connection to the
  page. `webmcp_tools` lists it as `destructive`. A page that
  registers a tool again with another hint gets it offered anew. The extension still
  asks before every call of a tool that is not read-only. In Firefox, a tool's
  annotations are read as Chrome reads them: all four hints as booleans, an annotations
  value that is no object refused.

- **"Fill in the code for me" is a switch** (DEC-210), in place of the buttons "Fill in
  the code for me" and "Stop filling in the code": it is a setting that stays on, and
  each connection is still asked about. The line under it says what it does. Turning it
  on asks for the relay's site as before (the browser asks first); declined, the switch
  goes back to off. It shows on only while the relay's site is granted: when the site
  is taken away in the browser's settings, filling in goes off and the line says
  "tab-mcp no longer has access to <host>, so this went off."; it does not come back by
  itself when the site does (with access to all sites, say). Turning it on asks for the
  site again.

### Fixed

- **An answer holds only for the tool it was about** (DEC-217). A page that registered a
  tool again while its question waited, under the same name and read-only hint but with
  another title, description, input or output schema or `consequentialHint`, got the
  changed tool run on "Allow". Now such a call does not run, and the AI app is told that
  the tool changed while the user was asked; the content script checks it too, right
  before the call, so a change the extension had not read yet does not slip through.
  A page that registers the same tool again unchanged, also with its fields in another
  order, is not affected. "Always allow on <host>" still covers the site's tool by name,
  whatever its description says.

- **Arguments a page's schema takes are no longer refused** (DEC-217). The extension
  leaves a schema's regular expressions out (`pattern`, `patternProperties`), and that
  could make the schema stricter: with `patternProperties: { "^x-": … }` and
  `additionalProperties: false`, `{ "x-name": "Alice" }` was refused before it reached
  the page. Now what goes with a regular expression is what would turn its absence into
  a refusal: a restricting `additionalProperties` beside `patternProperties`,
  `unevaluatedProperties` and `unevaluatedItems` above it, a `not` or `if` around it
  (with its `then` and `else`), a `maxContains` for its `contains`; a `oneOf` around it
  becomes an `anyOf`, and a `$ref` counts as around it when what it points to lost a
  regular expression. The names `patternProperties` allows are noted in the schema's
  description. A page built with the client library checks its arguments again with its
  full schema; a page that registers with WebMCP itself, or with the extension's own,
  gets no other check, and its tool gets an argument its patterns would refuse, as
  before, since the extension never runs a page's regular expressions.

- **A question no longer moves under the pointer.** Where scrollbars take room (Linux,
  Windows), the panel behind the questions' dialog growing taller or shorter than its
  window while a question waited added or took away its scrollbar; the dialog got
  narrower or wider and the question's text wrapped anew, moving its buttons, so a click
  meant for "Don't allow" could land beside it. The same happened inside the dialog when
  questions stacked past its height. Now, while a question waits, the panel keeps a
  scrollbar (a track shows beside the dimmed panel even when nothing scrolls, and the
  panel can move sideways by its width when the last question is answered), and the
  dialog keeps room for its own, so a question keeps one width and its buttons their
  place.
- **The first click into an unfocused panel reaches "Don't allow".** The line "Click
  into the side panel to answer." stood above the questions and went away as that click
  focused the panel, moving the questions up between the press and the release, so the
  click missed. It now stands under the questions.
- **A tool the page registered on its own is not removed by its next
  `provideContext()`.** Where the extension provides WebMCP itself (Firefox, and Chrome
  without WebMCP), a tool that an earlier `provideContext()` gave, then unregistered and
  registered again with `registerTool()` under the same name, still counted as the
  context's: the next `provideContext()` removed or replaced it, and a content script
  taking over the page's tools kept that mistake. The context now owns the registrations
  it made, not their names (code review 2026-11-22, CR-04).

## [0.3.1][extension-0.3.1] - 2026-11-21

### Fixed

- **Filling in the code while pairing is on already** (the pairing view open, or right
  after another fill): the extension filled in the code shown even with under 5 seconds
  left, as the relay answers starting pairing again with that same code; it now waits
  for the next one (library `takeCode`, client 0.19.0).
- Pairing held on for a fill whose code was not sent (the fill withdrawn while its code
  was on its way, the page gone, no code) ends at once instead of after 30 seconds,
  unless another fill still needs it. An AI app that connected releases pairing only
  once no other AI app's fill needs it.
- A pairing page of the relay used before is no longer asked about when the relay was
  changed while the page loaded.

## [0.3.0][extension-0.3.0] - 2026-11-21

### Added

- **Pages with the tab-mcp client library and the extension know of each other**
  (DEC-207, with the library from 0.19.0 and `webmcp: true`). A call the user allowed
  in the extension (asked, or its "Always allow" switch) is not asked again by the page:
  right before the tool runs, the extension tells the page the tool, the exact
  arguments and the AI app, and the page runs that one call without its own question;
  once the call ended or failed, the extension takes that back, so a call that never
  reached the page leaves nothing another caller could use. The page shows which AI apps are connected through the extension. The extension tells
  such a page only its name and version, whether AI access is on and the AI apps
  connected (name and verified host), and nothing to a page without the library. The
  panel says "This page has tab-mcp built in." and, when an AI app is connected to the
  page directly too, that it sees the page's tools twice and to disconnect it in one of
  the two. In Firefox too.
- **Fills in its own pairing code** on the relay's sign-in page when an AI app opens it
  in the same browser (DEC-203), once turned on: "Fill in the code for me" under the
  code (off by default, also with access to all sites) asks for access to the relay's
  site if needed (the browser asks first). Then, while AI access is on, the panel or a
  notification asks "Connect <AI app> (<host>) to the tab-mcp browser extension?" with
  the AI app's verified host; Allow writes the code into the page and clicks Connect.
  Only on the relay's exact origin and for this extension's own app; one question per
  page load, one more fill for the same request if the code had just changed, never a
  third. Typing the code works as before. "Stop filling in the code" turns it off and
  gives the relay's site back; another relay starts off. In Firefox too.
- The icon's tooltip says "a question waits" (a tool's, or now a pairing page's).

### Changed

- **A new address, the same for every installation** (DEC-196): the extension names its
  app to the relay, `tab-mcp-extension` (`tab-mcp-extension-firefox` in the Firefox
  build), and its MCP address is `<relay>/s/tab-mcp-extension/mcp`. The pairing code
  says which installation an AI app is paired with. The address from before,
  `<relay>/a/<address id>/mcp`, is gone: add the new address to each AI app and pair
  again. Needs a relay with the fixed address (the relay release after 0.11.0).
- The pairing code is 8 letters, shown as `XXXX-XXXX`.
- "New address" in the side panel is "Disconnect all apps": it disconnects every AI app
  and makes a new secret, and the address stays. Each AI app connects again with a new
  code. Its note and the notice after a takeover say so ("Another tab or program took
  over tab-mcp's connection … “Disconnect all apps” ends that.").
- The privacy policy says what the stored secret is now: it identifies this
  installation to the relay; the address is the same for every installation.
- The rules of filling in the code, the pairing page's content script and the messages
  between them are the client library's (`@ractive-ch/tab-mcp-client/extension`,
  DEC-206), shared with Sitegloss; the extension keeps its question, setting, permission
  prompt and the script's registration. Filling in now also stops while the code is on
  its way: turning it or AI access off, another relay or the AI app connecting by a
  typed code in that moment fills in nothing, and two loads of the same sign-in page at
  once get the one more fill only once.
- **One wording with the library and the relay**: an AI app is connected, not paired,
  and "app" alone says "AI app". The side panel's card is "AI access" (its switch is
  named by the heading); the box with the address and the code is "Connect your AI app",
  as the relay's sign-in page calls it, with "Add this address to your AI app:" and
  "When your AI app opens the sign-in page, type this code there:"; "+ Add another AI app"
  is "+ Connect another AI app". The states read "On · no AI app connected yet",
  "Connection lost · reconnecting…" and "AI access is off · your AI apps stay connected
  for next time"; the list is "Connected AI apps" in every state; "Turn on AI access to
  disconnect an AI app." and "An AI app can be disconnected once the connection is
  back." The "Always allow" notes say "for every connected AI app". The connect question
  and its notification say "the sign-in page" (not "the relay's page") and name the
  extension "tab-mcp" in its panel; the takeover notices say "your AI apps use that one
  now" / "may now use it instead". The page notes say "on the page". The icon's tooltip
  while connecting is "tab-mcp browser extension: connecting…", and Firefox's sidebar is
  titled "tab-mcp browser extension".

## [0.2.1][extension-0.2.1] - 2026-11-17

The extension is 0.2.0's. 0.2.0's publish to the Chrome Web Store stopped before the
upload: the release workflow did not pass the environment's secrets to the shared
publish job. It does now (`secrets: inherit`), and 0.2.1 is the release that goes out.

## [0.2.0][extension-0.2.0] - 2026-11-17

### Added

- WebMCP for pages where Chrome has none (no WebMCP flag, no origin trial token): with
  access to all sites, the extension gives every page `document.modelContext` as it
  starts loading (a script in the page's own world, `chrome/webmcp-main.ts`), so pages
  that register their tools wherever the API exists (Mintlify, GitBook and ReadMe docs,
  pages with the MCP-B polyfill) offer them to the AI app. Chrome's own WebMCP wins
  where it is on. A page that loaded before the grant gets it after a reload.

### Changed

- The extension is called "tab-mcp browser extension" (was "tab-mcp for Chrome"), the
  same name in every browser's store: in its manifest, the toolbar button, the side
  panel, its notifications and what it tells AI apps. Its MCP server name, which the
  setup commands use, is `tab-mcp-browser-extension`. The address derives from it, so
  the update gives the extension a new address: pair the AI apps again. The store package is
  `tab-mcp-browser-extension-<version>-store.zip`.
- The first release through the publish workflow: the store gets a CRX signed with the
  item's verified-upload key.
- Open pages keep their WebMCP tools across a reload or update of the extension.
- A page busy for a while after it loaded still gets its tools: no time limit for the
  polyfill's answer.
- A page tool's description is cut at 8000 characters instead of 1000, so a page without
  server instructions (WebMCP has none) can say how to use its tools in them. A page's
  errors stay cut at 1000. All of a page's descriptions together keep at most 64 KiB
  (UTF-8): past it the longest are cut to one common length, the shorter stay whole.
- The side panel: a question waiting while the panel has no focus says "Click into the
  side panel to answer." (Allow counts only from a click into it); a page without
  WebMCP says to give access to all sites and reload the page; the line under "Give
  access to all sites" says pages then get WebMCP as they load.
- Pages it may read can tell that it is installed (`document.modelContext` where Chrome
  has none); `PRIVACY.md` says so.

The repository also builds it for Firefox from the same code (`--firefox`), with a store
package for addons.mozilla.org (`--firefox --store --zip`; README).

## [0.1.0][extension-0.1.0] - 2026-11-15

First release.

### Added

- Passes the WebMCP tools of the page in front (`document.modelContext.registerTool()`,
  Chrome's own WebMCP, the top frame's, with its same-origin frames) on to an AI app outside the browser, through a
  tab-mcp relay (by default `https://tab-mcp.ractive.ch`; another one under "Settings").
- Tools for the AI app: `page_info` (the tab's address, title, language, whether WebMCP is
  available; the server's instructions and its description ask the AI app to call it
  first when the user refers to a page in their browser), `webmcp_tools` (the page's tools with their input schemas, and why a tool is left out), one
  `page_<name>` per page tool, following the tab in front and the page's `toolchange`,
  and `webmcp_call` for AI apps that read their tool list once. Tools a tab-mcp page
  mirrors into WebMCP are offered like any other.
- The page's tools are the page's word: descriptions start with the page's origin (the
  one Chrome reports for the tab) and are cut, results are marked untrusted and cut
  (images up to 640 KiB of base64 together, within the relay's 1 MiB), arguments are
  checked against the tool's schema, a call runs only on the page its tool was listed
  from and ends after 60 s; a page that does not answer the extension within 5 s is
  given up. A tool that takes the tab to another page answers with the new page's
  `page_info`. A schema's `pattern`s are not run but named in the property's
  description; a result that is the JSON of an object reaches the AI app with
  `structuredContent`, and a JSON-encoded string as the string; a tool's `outputSchema`
  is shown in `webmcp_tools`; tools marked `debugging` are left out.
- A tool the page does not mark read-only asks first: in the side panel, or in a Chrome
  notification while the panel is not in front (Allow; a click on its body shows the
  whole question). "Always allow on <host>" in the question, or the tool's "Always allow"
  switch in the panel's tool list, allows a tool on its site for every paired AI app;
  "Always allow all" over the list does it for every tool listed. A question that is not answered in
  60 s, or not asked because 5 of the AI app's calls wait already, says so to the AI app.
- Access per tab: a click on the icon lets the extension read that tab (until it goes to
  another origin); "Give access to all sites" asks for optional access to every http(s) site.
  No `file:` pages, no Incognito tabs.
- Navigation tools for the tab in front, while the extension may read it: `navigate` (an
  http(s) address), `go_back`, `go_forward` and `reload`, each answering with the new
  page's `page_info` once it has loaded (at most 30 s). On the page's own origin they run
  at once; to another origin they ask first (Allow or Don't allow, nothing kept), also
  a back or forward whose target the extension cannot see. The answer says when the new
  page needs a click on the icon. No new permission (DEC-121).
- The side panel: AI access on or off, the address and pairing code for a new AI app with
  "How do I add it?" (Claude, ChatGPT, Claude Code, Codex), the paired apps with
  Disconnect, the tab's tools.
- The connection lives in the service worker: it stays on with the panel closed and comes
  back after a browser start, an update or sleep (an alarm once a minute while AI access is
  on); the panel says "retrying" meanwhile.
- Permissions: `activeTab`, `scripting`, `sidePanel`, `notifications`, `alarms`, and
  `http://*/*` and `https://*/*` only as optional permissions. No `storage` permission: the settings are
  in the service worker's IndexedDB. Privacy policy: `packages/tab-mcp-extension/PRIVACY.md`.

[extension-0.3.3]: https://github.com/ractive/tab-mcp/releases/tag/extension-v0.3.3
[extension-0.3.2]: https://github.com/ractive/tab-mcp/releases/tag/extension-v0.3.2
[extension-0.3.1]: https://github.com/ractive/tab-mcp/releases/tag/extension-v0.3.1
[extension-0.3.0]: https://github.com/ractive/tab-mcp/releases/tag/extension-v0.3.0
[extension-0.2.1]: https://github.com/ractive/tab-mcp/releases/tag/extension-v0.2.1
[extension-0.2.0]: https://github.com/ractive/tab-mcp/releases/tag/extension-v0.2.0
[extension-0.1.0]: https://github.com/ractive/tab-mcp/releases/tag/extension-v0.1.0
