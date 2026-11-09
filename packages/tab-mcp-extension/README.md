# tab-mcp for Chrome

A Chrome extension that offers the page in front to your AI app outside the browser,
through a tab-mcp relay. It is the WebMCP bridge of tab-mcp (DEC-114 in `kb/`): pages that
register tools with WebMCP (`document.modelContext.registerTool()`) offer them only to
agents in the browser; the extension passes them on (iterations 19 and 20).

Not published yet; load it unpacked.

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
- A tool the page marks read-only runs at once; every other one asks you in the side
  panel each time (the library's dialog: click into the panel, then Allow). "Always
  allow" in that dialog stops asking for that tool on this page until the page changes
  (navigation, reload, another tab). In the panel's list, a click on "asks first" turns
  the tool into "allowed" for that site (exact origin), kept until you click it again.
- A call runs only on the page its tool was listed from, and only if the tool still
  makes the read-only claim it was offered with; after a navigation, or a tool that
  changed, the AI app is told to list the tools again.
- Arguments are checked against the tool's schema before the call (without the schema's
  regular expressions, which a page could make freeze the panel; the page checks those
  itself). A call that the page does not answer in 60 s ends for the AI app, also when
  the page is stuck; cancelling in the AI app cancels it in the page. Results are marked
  untrusted; their text, all blocks together, is cut to 100,000 characters. A page that
  answers with an MCP result (as `@mcp-b/global` pages do) gets its text blocks and up
  to 1 MB per image through, at most 32 blocks.
- Names: `page_<name>`, other characters than letters, digits, `_` and `-` as `_`, at most
  64 characters in all: the Anthropic API takes no other tool names, and Claude drops the
  rest without a word.
- Left out: tools whose `page_<name>` would be longer than 64 characters or the same as
  another's, a schema that is no
  object schema or over 16 KB, more than 64 tools, and tools a tab-mcp page offers itself
  (listed in `<html data-tab-mcp-webmcp>`).
- Only the top frame, and only the browser's own WebMCP: a page's replacement
  `document.modelContext` (or a polyfill without native WebMCP) is not used.

## Load it unpacked

```sh
bun run build            # in packages/tab-mcp-extension: writes dist/
```

Then `chrome://extensions`, Developer mode on, "Load unpacked", choose `dist/`.

- Click the extension's icon on a tab: the side panel opens, and the extension may read
  that tab, also after navigations on the same origin, until the tab goes to another
  origin (`www.example.com` is another origin than `example.com`).
  "Allow on all sites" in the side panel lets it read every tab without a click.
- "Connect your AI app" connects to the relay and shows the address for your AI app and a
  pairing code, as on any page with tab-mcp. The relay address is under "Relay".

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
- `bun scripts/build.ts --store` builds the Chrome Web Store package (no key, no host
  access); `--test` the end-to-end tests' build (no key, host access at install).

## Tests

- `test/unit.test.ts`: manifests, the key's id, reading a page, the tool, the refusals.
- `test/bridge.test.ts`: the bridge's names, descriptions, schemas, results and how its
  tools follow the page.
- `test/e2e.test.ts`: the test build and the store package in Chrome for Testing 156 or
  newer (`CHROME_PATH`), the side panel opened by a real click on the icon, a relay in
  the test process, an MCP client calling `page_info`, `webmcp_tools` and the page's
  tools (confirmation in the panel, cancellation, `toolchange`, a forged
  `document.modelContext`) across navigations and tab switches. Pages are served
  through the DevTools Protocol on made-up https origins. They take a few seconds and
  run in CI on every change.
- `test/hosted.ts` (by hand): the development build connects to the hosted relay and
  shows an address and a pairing code.

## Licence

MIT, see the repository's `LICENSE` and `AI_NOTICE`. The build's `LICENSES.txt` lists
what it bundles.
