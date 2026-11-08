# tab-mcp for Chrome

A Chrome extension that offers the page in front to your AI app outside the browser,
through a tab-mcp relay. It is the WebMCP bridge of tab-mcp (DEC-114 in `kb/`): pages that
register tools with WebMCP (`document.modelContext.registerTool()`) offer them only to
agents in the browser; the extension passes them on. This first version (iteration 19)
has one tool, `page_info`; the page's own WebMCP tools follow (iteration 20).

Not published yet; load it unpacked.

## Tools

| Tool | What it does |
|---|---|
| `page_info` | The tab in front: address, title, language, whether WebMCP is available on the page and how many tools it registered. Read-only; its text is the page's own (untrusted). |

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
- `test/e2e.test.ts`: the test build and the store package in Chrome for Testing 156 or
  newer (`CHROME_PATH`), the side panel opened by a real click on the icon, a relay in
  the test process, an MCP client calling `page_info` across navigations and tab
  switches. Pages are served through the DevTools Protocol on made-up https origins.
  They take a few seconds and run in CI on every change.
- `test/hosted.ts` (by hand): the development build connects to the hosted relay and
  shows an address and a pairing code.

## Licence

MIT, see the repository's `LICENSE` and `AI_NOTICE`. The build's `LICENSES.txt` lists
what it bundles.
