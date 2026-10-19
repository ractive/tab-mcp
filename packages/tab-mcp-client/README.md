# @ractive-ch/tab-mcp-client

Offer a web page's functions as [MCP](https://modelcontextprotocol.io) tools to AI
apps (Claude, ChatGPT, Claude Code, Cursor, …) through a
[tab-mcp](https://github.com/ractive/tab-mcp) relay. The page connects to the relay
and gets an address; the user adds that address to their AI app, which then calls the
page's tools while the tab stays open.

**Status: alpha.** The API can still change. The relay is not on npm yet; run it from
the [repository](https://github.com/ractive/tab-mcp).

## Install

```sh
npm install @ractive-ch/tab-mcp-client@alpha
```

Or without a bundler, from a CDN as an ES module:

```html
<script type="module">
  import { TabMcp } from "https://cdn.jsdelivr.net/npm/@ractive-ch/tab-mcp-client@0.1.0-alpha.0/cdn/tab-mcp-client.min.js";
</script>
```

## Use

```ts
import { TabMcp } from "@ractive-ch/tab-mcp-client";

const mcp = new TabMcp({
  relay: "https://relay.example",
  server: { name: "calculator", version: "1.0.0" },
  appName: "calculator",
});

await mcp.registerTool({
  name: "add",
  description: "Add two numbers",
  inputSchema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  annotations: { readOnlyHint: true },
  execute: ({ a, b }) => Number(a) + Number(b),
});

// From a click: connects and shows the address to add to the AI app.
button.addEventListener("click", () => mcp.showConnectDialog());
```

Importing the library loads only a small core; `connect()` loads the rest.

## License

MIT, see [LICENSE](LICENSE) and [AI_NOTICE](AI_NOTICE). The CDN build bundles
third-party code; see [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
