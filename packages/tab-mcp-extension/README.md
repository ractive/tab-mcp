# tab-mcp for Chrome

A Chrome extension that offers the page in front to your AI app outside the browser,
through a tab-mcp relay. It is the WebMCP bridge of tab-mcp (DEC-114 in `kb/`): pages that
register tools with WebMCP (`document.modelContext.registerTool()`) offer them only to
agents in the browser; the extension passes them on (iterations 19 and 20).

Not in the Chrome Web Store yet; load it unpacked. Privacy policy: [PRIVACY.md](PRIVACY.md).

## Tools

| Tool | What it does |
|---|---|
| `page_info` | The tab in front: address, title, language, whether WebMCP is available on the page and how many tools it registered. Read-only; its text is the page's own (untrusted). |
| `webmcp_tools` | The page's WebMCP tools: each one's `page_<name>`, title, description, whether it only reads, and why a tool is left out; empty with the reason when the tab has none or may not be read. |
| `page_<name>` | One per tool the page in front registered. The list follows the tab in front and the page's `toolchange`. |
| `webmcp_call` | Calls a tool of the page in front by its name, with the same rules. For AI apps that read their tool list once (Claude, Codex): a `page_<name>` tool that came with a later tab is not in their list, but `webmcp_call` reaches it. |

The page's tools are the page's word:

- Their descriptions reach the AI app starting with the page's origin (`From
  https://shop.example: …`), cut to 1000 characters; titles to 100.
- A tool the page marks read-only runs at once; every other one asks you each time
  (see "Questions" below). "Always allow" stops asking for that tool, for that AI app on
  this page, until the page changes (navigation, reload, another tab). In the panel's
  list, a click on "asks first" turns the tool into "allowed" for that site (exact
  origin), kept until you click it again. "Allow all" over the list allows every tool
  listed at that moment that asks first, in one step; once they all are, it reads "Ask
  for all" and turns them all back. A tool the page registers later asks first. When the
  page changes what the button would do, it waits 750 ms before it takes a click. Both only for pages of an http(s) site: pages
  with an opaque origin (`null`, such as sandboxed or `data:` pages) always ask.
- A call runs only on the page its tool was listed from, and only if the tool still
  makes the read-only claim it was offered with; after a navigation, or a tool that
  changed, the AI app is told to list the tools again.
- Arguments are checked against the tool's schema before the call (without the schema's
  regular expressions, which a page could make freeze the extension; the page checks those
  itself). A call that the page does not answer in 60 s ends for the AI app, also when
  the page is stuck; cancelling in the AI app cancels it in the page. Results are marked
  untrusted; their text, all blocks together, is cut to 100,000 characters. A page that
  answers with an MCP result (as `@mcp-b/global` pages do) gets its text blocks and
  images through, at most 32 blocks, each image up to 1 MB of base64 (about 750 KB of
  image data).
- Names: `page_<name>`, other characters than letters, digits, `_` and `-` as `_`, at most
  64 characters in all: the Anthropic API takes no other tool names, and Claude drops the
  rest without a word.
- Left out: tools whose `page_<name>` would be longer than 64 characters, the same as
  another's or the same as one of the extension's own tools (a page tool `info` would be
  `page_info`), and tools the client library refuses (none of them can be called through
  `webmcp_call` either), a schema that is no
  object schema or over 16 KB, more than 64 tools, and tools a tab-mcp page offers itself
  (listed in `<html data-tab-mcp-webmcp>`), once the library mirrors its tools into
  WebMCP (iteration 25); until then no tab-mcp page sets the attribute.
- Only the top frame, and only the browser's own WebMCP: a page's replacement
  `document.modelContext` (or a polyfill without native WebMCP) is not used.

## Load it unpacked

```sh
bun run build            # in packages/tab-mcp-extension: writes dist/
```

Then `chrome://extensions`, Developer mode on, "Load unpacked", choose `dist/`.

- Click the extension's icon on a tab: the side panel opens (also over another
  extension's panel for that tab, such as Claude in Chrome's), and the extension may read
  that tab, also after navigations on the same origin, until the tab goes to another
  origin (`www.example.com` is another origin than `example.com`).
  "Allow on all sites" in the side panel lets it read every tab without a click.
- "Turn on AI access" (or the "AI access" switch) connects to the relay. With no AI app
  paired yet, the panel shows the address for your AI app and a pairing code at once.
  "How do I add it?" under the address says how to add it in Claude, ChatGPT, Claude Code
  and Codex (the client library's steps, the commands each with a Copy), and links to the
  [connect page](https://ractive.ch/tab-mcp/connect/). Paired apps are listed, each with a dot (green while connected,
  grey while off or connecting) and a Disconnect button (which asks first, and takes no double click); "+ Add another AI app" shows the address and a code again. The
  address shows only while pairing. Off, the panel says "AI access is off · paired apps
  stay paired". The relay address is under "Settings".
- The connection lives in the extension's service worker, not in the side panel: close
  the panel and AI access stays on, until the switch turns it off. It comes back by itself after a
  browser start, an update or a reload of the extension when you left it on. The icon
  shows "on" while it is connected, "…" while it connects, "?" while a tool asks. If
  another tab or program takes the address over, the extension does not take it back by
  itself, also after a restart: the panel says so and offers "New address" (or Connect,
  to take it back).

## Questions

A tool that asks first asks in the side panel when the panel is open in the window of the
tab the tool acts on, that window is in front, and the panel is not covered by another
extension's panel for the tab (a question it shows goes out as a notification once it is
covered): Allow and Always allow work once the
panel has been in front for 750 ms, so the click that brings it forward cannot approve.
The panel's question names the AI app and the tool, then, each on a line of its own, the
site the tool acts on ("Site (verified)") and the page's title for the tool ("Title (from
the page)"), and the arguments in full (they scroll when long).

Otherwise it asks in a Chrome notification, "Allow <tool>?" (the page's title of the tool,
cut to 60 characters) with "On <site>" below, naming the AI app (its name and its
verified host) and the arguments in short (cut to 150 characters; when they are cut, the
notification says "Arguments cut: click to see them in full."), with the buttons Allow
and Always allow, also when the arguments are cut (the same memory as the panel's: this
tool, this AI app, this page; only Allow for pages without a site of their own). A click
on the notification's body opens the whole question, the arguments in full, with Allow,
Always allow and Don't allow: in the side panel of the tab's window, or, where Chrome
does not open the panel, in a small window of its own (closing that window is Don't
allow). The question waits there, its 60 s still running. Don't allow is closing the
notification or no answer in 60 s. A click on either button within half a second of
the notification showing does not count (it shows again). A notification answers only
its own call. Questions also show in every open side panel, so with notifications off
(Focus, Do Not Disturb, notifications off for Chrome) open the panel when the icon shows
"?". A question nobody answers in 60 s is Don't allow. At most 5 questions of one AI app wait at
once; a further call of that app is declined without asking, and the app is told why.

"Always allow" holds for the tool on the page the question was about (its site and that
very page load) and the AI app that asked; if the page changed while the question was
open, the answer still counts for that call, but nothing is kept.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read the tab you click the icon on (its WebMCP tools), without access to other sites. |
| `scripting` | Put the content script, which lists and calls the page's WebMCP tools, into that tab. |
| `sidePanel` | The side panel: the connection's state, pairing, the tab's tools, the questions. |
| `notifications` | Ask before a tool that is not read-only runs while the side panel is not in front. |
| `alarms` | Wake the service worker once a minute while AI access is on, so a connection lost while the computer slept comes back. |
| `<all_urls>` (optional) | Only after "Allow on all sites": read every tab without a click. |

No `storage` permission: the relay address, whether AI access is on, the tools allowed per
site and the secret behind the connection's address are in IndexedDB, used by the service
worker only, which content scripts (in the page's origin) cannot reach; there is no
`chrome.storage` area for them to read or write.

WebMCP is on in Chrome only where a site takes part in Chrome's origin trial, or after
you turn on `chrome://flags/#enable-webmcp-testing`.

## The relay and the extension's id

The relay accepts an extension only if its origin, `chrome-extension://<id>`, is allowed
(`TAB_MCP_ALLOWED_ORIGINS` or `TAB_MCP_SITES`, relay 0.7.0 or later; see "Browser
extensions" in `docs/configuration.md`). An unpacked extension's id comes from the public
key in its manifest, or, without one, from the folder it was loaded from.

- `bun run build` writes the owner's key into the manifest, read from
  `~/.config/tab-mcp/extension-key.txt` (or `TAB_MCP_EXTENSION_KEY_FILE`). That build's
  id, `handeaggdjdkpniflkjlknlcfbjifkng`, is the one the hosted relay
  (`https://tab-mcp.ractive.ch`, the side panel's default) allows. The key is not in this
  repository: anyone with it could load an extension with that id.
- Without the key the build gets an id of its own; run your own relay
  (`docs/self-hosting.md`) and allow that id, or use the relay's development mode.
- `bun scripts/build.ts --store` builds the Chrome Web Store package into `dist-store/`
  (no key, no host access, no source maps); `--store --zip` also packs it as
  `tab-mcp-for-chrome-<version>-store.zip` and refuses a build with a key, host access or
  source maps. `--test` builds the end-to-end tests' build (no key, host access at
  install).

## Releases

A tag `extension-v<version>` on main (the version in `package.json`) builds the store zip
and creates the GitHub release with it (`.github/workflows/extension-release.yml`); the
"Extension publish" workflow uploads a release's zip to the Chrome Web Store. The owner's
setup, the listing, the permission justifications and the review notes:
`kb/operations/chrome-web-store.md`.

## Tests

- `test/unit.test.ts`: manifests, the key's id, reading a page, the tool, the refusals.
- `test/build.test.ts`: the store build has no key, no `host_permissions` and no source
  maps; its zip lists the build's files; a build with a key, host access or source maps
  is not packed; `--zip` needs `--store`.
- `test/panel.test.ts`: the side panel's AI app card (the next step, the address only
  while pairing), "How do I add it?" and its Copy buttons, its clicks (Disconnect's double
  click, the switch) and "Allow all".
- `test/worker.test.ts`: who may send the service worker what (only the side panel's
  port gives commands; a content script can only say its page's tools changed), the
  questions (notifications, the guard, late clicks, a click on the body, cut arguments,
  the panel, the time limit), invisible characters, the address secret's storage, Always
  allow per page (and not kept when the page changed during the question), a failed
  start tried again, a bundle without dynamic `import()`.
- `test/bridge.test.ts`: the bridge's names (also one that becomes the extension's own),
  descriptions, schemas, results and how its tools follow the page.
- `test/e2e.test.ts`: the test build and the store package in Chrome for Testing 156 or
  newer (`CHROME_PATH`), the side panel opened by a real click on the icon, a relay in
  the test process, an MCP client calling `page_info`, `webmcp_tools` and the page's
  tools (confirmation in the panel, cancellation, `toolchange`, a forged
  `document.modelContext`) across navigations and tab switches; with the panel closed
  (tools still run, questions as notifications, a panel closed during a question, a click
  on a notification's body opening the question's own window, reopening it) and after a restart of the same profile (the same address connects
  again by itself). `TAB_MCP_E2E_IDLE=1` adds a two-minute check that the service
  worker keeps running on a quiet connection and stops once AI access is off. Pages are served
  through the DevTools Protocol on made-up https origins. They take a few seconds and
  run in CI on every change.
- `test/hosted.ts` (by hand): the development build connects to the hosted relay and
  shows an address and a pairing code.

## Licence

MIT, see the repository's `LICENSE` and `AI_NOTICE`. The build's `LICENSES.txt` lists
what it bundles.
