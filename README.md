# tab-mcp

Connect your AI app to a web page open in a browser tab.

A web page offers some of its functions as [MCP](https://modelcontextprotocol.io) tools.
The page connects to a tab-mcp relay and gets an address. You add the address to your AI
app (Claude, ChatGPT, Claude Code; see [compatibility](docs/compatibility.md) for which
apps work) and type a code that the page shows. The AI app then calls the page's tools
through the relay while the tab stays open. Nothing has to be installed on your
computer.

## How it works

```text
 AI app (Claude, ChatGPT, Claude Code)
   │  HTTPS: MCP requests to https://relay.example.com/a/<id>/mcp, with a token
   │  OAuth sign-in: you type the page's code on the relay's /authorize page
   ▼
 tab-mcp relay: checks tokens and limits, forwards requests, knows no tools
   ▲
   │  WebSocket /tab (protocol tab-mcp.v1), opened when you click Connect;
   │  requests go to the page, results come back
   │
 Web page with @ractive-ch/tab-mcp-client, open in your browser tab
```

1. You click "Connect your AI app" in the page. The page opens a WebSocket to the relay
   and shows an address and a 6-digit code.
2. You add the address to your AI app. The AI app opens the relay's sign-in page in your
   browser. It names the AI app and the page; you type the code.
3. The AI app gets a token for that address. The page lists it as connected, with a
   Disconnect button.
4. When the AI app calls a tool, the relay forwards the request to the page. The page
   runs the tool and answers. Tools that change something ask you in the page first.
5. When you close the tab, the tools are gone. The AI app stays paired and can use the
   tools again the next time you connect the page.

The relay sees tool arguments and results but does not log or store them. It stores
only hashes of tokens. More in the [threat model](docs/threat-model.md).

## Quick start for users

You need a page that offers tab-mcp, such as the [calculator example](examples/calculator).

1. In the page, click "Connect your AI app" and copy the address.
2. Add it to your AI app:
   - **Claude Code:** `claude mcp add --transport http calc <address>`, then run `/mcp`
     in Claude Code and choose Authenticate.
   - **Claude (claude.ai and the desktop app):** Settings → Connectors → Add custom
     connector, then paste the address.
   - **ChatGPT:** Settings → Apps and connectors → Advanced settings, turn on developer
     mode, then Create and paste the address.
3. Your browser opens the relay's page "Connect … from …". Check the AI app and the
   page's address, then type the code shown in the page.
4. Ask your AI app to use the page. To stop, click Disconnect in the page, or close the
   tab.

claude.ai, Claude Desktop and ChatGPT connect from their own servers, so they need a
relay with a public HTTPS address; they have not been tested yet. See
[compatibility](docs/compatibility.md).

**Connecting an AI app to a page means trusting that page.** The page decides what its
tools do and how they are described. Connect only pages you trust, and type a code only
for an AI app you started yourself. See [SECURITY.md](SECURITY.md).

## Quick start for page authors

1. Run a relay that allows your page's origin. For local development with Docker:

   ```sh
   docker run --rm -p 8080:8080 \
     -e NODE_ENV=development \
     -e TAB_MCP_PUBLIC_URL=http://localhost:8080 \
     -e TAB_MCP_ALLOWED_ORIGINS=http://localhost:3000 \
     -e TAB_MCP_STORE=memory \
     ractive/tab-mcp:0.1.0
   ```

2. Install the browser library:

   ```sh
   npm install @ractive-ch/tab-mcp-client
   ```

3. Register tools and add a button:

   ```ts
   import { TabMcp } from "@ractive-ch/tab-mcp-client";

   const mcp = new TabMcp({
     relay: "http://localhost:8080",
     server: { name: "notes", version: "1.0.0" },
     appName: "notes",
   });

   await mcp.registerTool({
     name: "add_note",
     description: "Add a note to the list on the page",
     inputSchema: {
       type: "object",
       properties: { text: { type: "string" } },
       required: ["text"],
     },
     execute: ({ text }) => addNote(String(text)),
   });

   connectButton.addEventListener("click", () => mcp.showConnectDialog());
   ```

4. Open your page on `http://localhost:3000`, click the button and connect an AI app.

Mark tools that change or delete things with `annotations: { consequentialHint: true }`:
the page then asks the user before each call. The
[client README](packages/tab-mcp-client/README.md) covers the whole API, and the
[calculator example](examples/calculator) is a complete page (`bun run example`).

There is no public relay for other sites: run your own (next section).

### Agent skill

The repository has an [Agent Skill](plugins/tab-mcp/skills/tab-mcp/SKILL.md) that
teaches a coding agent to add tab-mcp to a web app. In Claude Code:

```text
/plugin marketplace add ractive/tab-mcp
/plugin install tab-mcp@tab-mcp
```

For Codex and claude.ai, see the [plugin README](plugins/tab-mcp/README.md).

## Self-hosting

The relay is one process with a SQLite file. Run it with Docker:

```sh
docker run -d --name tab-mcp -p 127.0.0.1:8080:8080 -v tab-mcp-data:/data \
  -e TAB_MCP_PUBLIC_URL=https://relay.example.com \
  -e TAB_MCP_ALLOWED_ORIGINS=https://app.example.com \
  ractive/tab-mcp:0.1.0
```

Put it behind a reverse proxy with TLS. [Self-hosting](docs/self-hosting.md) explains
WebSockets, event streams and proxy time limits; [configuration](docs/configuration.md)
lists every setting and why the defaults are safe. The relay also runs without Docker on
Bun (`bun add --global @ractive-ch/tab-mcp`, then `tab-mcp`).

## Packages

| Path | Published as | What |
|---|---|---|
| `packages/tab-mcp` | npm `@ractive-ch/tab-mcp`, Docker `ractive/tab-mcp` and `ghcr.io/ractive/tab-mcp` | the relay ([README](packages/tab-mcp/README.md)) |
| `packages/tab-mcp-client` | npm `@ractive-ch/tab-mcp-client` | the browser library a page uses ([README](packages/tab-mcp-client/README.md)) |
| `examples/calculator` | – | a small calculator page as an example ([README](examples/calculator/README.md)) |
| `plugins/tab-mcp` | – | the agent skill and its plugin manifests ([README](plugins/tab-mcp/README.md)) |

## Documentation

- [Compatibility](docs/compatibility.md): which AI apps work, as tested
- [Configuration](docs/configuration.md): every `TAB_MCP_*` setting
- [Self-hosting](docs/self-hosting.md): Docker, reverse proxies, upgrades
- [Token store](docs/token-store.md): the `TokenStore` interface and its conformance suite
- [Protocol](docs/protocol.md): the WebSocket protocol `tab-mcp.v1` between page and relay
- [Threat model](docs/threat-model.md) and [security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Status

**0.1.0**, the first stable release. Until 1.0, a new minor version can still change
settings, the protocol or the API; the [changelog](CHANGELOG.md) says what changed.

- Released: relay `@ractive-ch/tab-mcp` 0.1.0 (npm and Docker) and browser library
  `@ractive-ch/tab-mcp-client` 0.1.0, on the npm tag `latest`.
- tab-mcp speaks only MCP revision 2026-07-28 and accepts only AI apps that register
  through OAuth Client ID Metadata Documents. Claude Code works (tested headless with a
  token; its interactive sign-in is not tested yet); VS Code, Cursor and Gemini CLI
  cannot connect yet. Details in [compatibility](docs/compatibility.md).
- Planned: tests with claude.ai, Claude Desktop and ChatGPT against a public relay, and
  deployment guides.

## Development

Requires [Bun](https://bun.sh) 1.4.

```sh
bun install
bun run verify     # Biome, type check, tests
bun run fix        # format and apply safe lint fixes
```

## Licence

MIT, see [LICENSE](LICENSE) and [AI_NOTICE](AI_NOTICE).
