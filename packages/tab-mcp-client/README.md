# @ractive-ch/tab-mcp-client

Offer a web page's functions as [MCP](https://modelcontextprotocol.io) tools to AI apps
(Claude, ChatGPT, Claude Code) through a [tab-mcp](https://github.com/ractive/tab-mcp)
relay. The page connects to the relay and gets an address. The user adds that address to
their AI app and types a pairing code from the page; the AI app then calls the page's
tools while the tab stays open. Nothing is installed on the user's computer.

**Status: 0.1.0.** Until 1.0, a new minor version can still change the API. Which AI apps
work is listed in [compatibility](https://github.com/ractive/tab-mcp/blob/main/docs/compatibility.md).

## You need a relay

The page talks to a tab-mcp relay, which only accepts pages from the origins its operator
allows. Run your own: the relay is on npm as
[`@ractive-ch/tab-mcp`](https://www.npmjs.com/package/@ractive-ch/tab-mcp) and on Docker
Hub as `ractive/tab-mcp`. For local development:

```sh
docker run --rm -p 8080:8080 \
  -e NODE_ENV=development \
  -e TAB_MCP_PUBLIC_URL=http://localhost:8080 \
  -e TAB_MCP_ALLOWED_ORIGINS=http://localhost:3000 \
  -e TAB_MCP_STORE=memory \
  ractive/tab-mcp:0.1.0
```

For production, see
[self-hosting](https://github.com/ractive/tab-mcp/blob/main/docs/self-hosting.md).

## Install

```sh
npm install @ractive-ch/tab-mcp-client
```

Or without a bundler, from a CDN as an ES module:

```html
<script type="module">
  import { TabMcp } from "https://cdn.jsdelivr.net/npm/@ractive-ch/tab-mcp-client@0.1.0/cdn/tab-mcp-client.min.js";
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

### Tools

`registerTool(tool, { signal })` takes a tool in the shape of the WebMCP draft's
`registerTool`:

- `name` (1-128 characters of `A-Z a-z 0-9 _ - .`), `title`, `description` (not empty);
- `inputSchema`: a JSON Schema with `"type": "object"`. Arguments are checked against it
  before `execute` runs;
- `execute(input, { signal, client })`: runs the tool. `signal` aborts when the AI app
  gives up; `client` names the caller (`id`, verified `host`, declared `name`). Return a
  string (one text block), an MCP result with a `content` array (passed through), or any
  other JSON value (sent as JSON text, and as `structuredContent` for an object). A thrown
  error becomes an error result with its message;
- `annotations`: `readOnlyHint`, `consequentialHint`, `untrustedContentHint`, and the
  MCP hints `destructiveHint`, `idempotentHint`, `openWorldHint`.

Abort the `signal` to remove the tool. AI apps that listen for changes learn about
added and removed tools.

### Consequential tools

Mark tools that change or delete something with `consequentialHint: true`. The page then
asks the user before every call ("Allow" or "Don't allow"), showing the AI app and the
arguments. A refusal reaches the AI app as an error result. Pass `onConfirm` to ask in
your own UI:

```ts
const mcp = new TabMcp({
  relay: "https://relay.example",
  server: { name: "calculator", version: "1.0.0" },
  onConfirm: ({ tool, arguments: args, client, signal }) =>
    myDialog.ask(`${client.name ?? client.host} wants to run ${tool.name}.`, args, signal),
});
```

### Connecting and pairing

1. The user clicks your button. `showConnectDialog()` connects (call it from the click
   handler: browsers that report user activation refuse `connect()` without one) and
   opens the "Connect your AI app" dialog.
2. The dialog shows the address and short instructions for Claude, ChatGPT and Claude
   Code. The user adds the address to their AI app.
3. The AI app opens the relay's sign-in page in the browser. The dialog shows a 6-digit
   code, which the user types there. The code changes every 2 minutes.
4. The dialog lists the connected app with a Disconnect button.

The address stays the same across visits: the library keeps a secret per relay in
`localStorage`. "New address" in the dialog calls `newAddress()`, which disconnects every
app and makes a new address; when apps are connected, the dialog asks first. The relay's
sign-in page points users to it when someone else may be guessing codes. A page with its
own UI calls `newAddress()` from a click. Connected apps keep working after a reload once the page connects
again; while the page is closed, they get "the page is not open".

The library never reconnects by itself. A page that offers something like "Keep AI
access on" can call `connect({ resume: true })` on load.

### Your own UI

Instead of `showConnectDialog()`, use `connect()`, `disconnect()`, `newAddress()`,
`startPairing()` and `stopPairing()` (codes come only while pairing is on),
`revoke(grantId)`, the properties `state`, `address`, `pairingCode`, `grants` and
`tools`, and the events `statechange`, `connected`, `disconnected`, `pairingcode`,
`grantschange`, `toolschange`, `replaced` and `error`. The default dialogs take their
colours and sizes from `--tab-mcp-*` CSS custom properties (`--tab-mcp-font`,
`--tab-mcp-color`, `--tab-mcp-background`, `--tab-mcp-border`, `--tab-mcp-radius`, …)
and need no CSP exception.

## Security

Connecting an AI app to a page means trusting that page, as with any MCP server. Keep
cross-site scripting out of your page: a script that reads the address secret can take
over the address. The library sends the secret only over `https:`/`wss:` (plain `http:`
only to `localhost`). See
[SECURITY.md](https://github.com/ractive/tab-mcp/blob/main/SECURITY.md) and the
[threat model](https://github.com/ractive/tab-mcp/blob/main/docs/threat-model.md).

## More

- [Example: a calculator page](https://github.com/ractive/tab-mcp/tree/main/examples/calculator)
- [Tab–relay protocol](https://github.com/ractive/tab-mcp/blob/main/docs/protocol.md)
- [Changelog](https://github.com/ractive/tab-mcp/blob/main/CHANGELOG.md)

## Licence

MIT, see [LICENSE](LICENSE) and [AI_NOTICE](AI_NOTICE). The CDN build bundles
third-party code; see [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
