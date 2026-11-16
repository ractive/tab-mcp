# Changelog of the tab-mcp browser extension

All notable changes to the tab-mcp browser extension (called tab-mcp for Chrome up to
0.1.0), released with the Git tag `extension-v<version>`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

The browser extension (`packages/tab-mcp-extension`), in the Chrome Web Store. Each release
attaches its store package, `tab-mcp-browser-extension-<version>-store.zip` (up to 0.1.0
`tab-mcp-for-chrome-<version>-store.zip`), to the GitHub release `extension-v<version>`.

## Unreleased

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

[extension-0.2.0]: https://github.com/ractive/tab-mcp/releases/tag/extension-v0.2.0
[extension-0.1.0]: https://github.com/ractive/tab-mcp/releases/tag/extension-v0.1.0
