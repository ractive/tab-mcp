# Changelog of the tab-mcp browser extension

All notable changes to the tab-mcp browser extension (called tab-mcp for Chrome up to
0.1.0), released with the Git tag `extension-v<version>`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

The browser extension (`packages/tab-mcp-extension`), in the Chrome Web Store. Each release
attaches its store package, `tab-mcp-browser-extension-<version>-store.zip` (up to 0.1.0
`tab-mcp-for-chrome-<version>-store.zip`), to the GitHub release `extension-v<version>`.

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

[extension-0.3.0]: https://github.com/ractive/tab-mcp/releases/tag/extension-v0.3.0
[extension-0.2.1]: https://github.com/ractive/tab-mcp/releases/tag/extension-v0.2.1
[extension-0.2.0]: https://github.com/ractive/tab-mcp/releases/tag/extension-v0.2.0
[extension-0.1.0]: https://github.com/ractive/tab-mcp/releases/tag/extension-v0.1.0
