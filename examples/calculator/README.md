# Calculator example

A four-function calculator page (with M+, MR and MC) that offers its keys to AI apps
through tab-mcp. It is the page the end-to-end tests drive.

The page registers four tools with `@ractive-ch/tab-mcp-client`:

| Tool | What it does |
|---|---|
| `press_keys` | presses keys in order (`0-9 . + - * / = C`, e.g. `12+30=`) and returns the display |
| `read_display` | returns the display and the memory without pressing anything (read-only) |
| `clear` | presses C: clears the display and the pending operation, keeps the memory |
| `clear_memory` | sets the memory to 0 (MC); consequential, so the page asks you first |

"Connect your AI app" opens the library's dialog with the address for your AI app and
the pairing code. Connected apps are listed under the calculator, each with Disconnect.

The example only ever talks to a relay on your own machine, never to the hosted relay.

## Run it

From the repository root:

```sh
bun install
bun run example
```

This starts a relay on `http://localhost:8080` (development mode, tokens in memory,
only the page's origin allowed) and the page on `http://localhost:3000`. Open the page,
click "Connect your AI app", and add the address to your AI app. With Claude Code:

```sh
claude mcp add --transport http calc <address>
```

Then run `/mcp` in Claude Code, choose Authenticate, and enter the code from the page.

Set `PORT` and `RELAY_PORT` to use other ports.

## With the relay in Docker

To run the page against a relay you start yourself, set `TAB_MCP_RELAY`; the
example then starts no relay of its own:

```sh
docker run --rm -p 8080:8080 \
  -e NODE_ENV=development \
  -e TAB_MCP_PUBLIC_URL=http://localhost:8080 \
  -e TAB_MCP_ALLOWED_ORIGINS=http://localhost:3000 \
  -e TAB_MCP_STORE=memory \
  ractive/tab-mcp:0.1.0-alpha.1

TAB_MCP_RELAY=http://localhost:8080 bun run example
```

Or start the same relay from the repository:

```sh
NODE_ENV=development TAB_MCP_PUBLIC_URL=http://localhost:8080 \
  TAB_MCP_ALLOWED_ORIGINS=http://localhost:3000 TAB_MCP_STORE=memory \
  bun packages/tab-mcp/src/main.ts
```

Open the page as `http://localhost:3000`, not `127.0.0.1`: the relay only accepts the
origins in `TAB_MCP_ALLOWED_ORIGINS`.

## Tests

- `test/calculator.test.ts`: the calculator logic.
- `test/e2e.test.ts`: the relay, this page in headless Chrome, and the MCP SDK client as
  the AI app. The client does the whole OAuth flow, and the test types the pairing code
  from the page's dialog on the relay's `/authorize` page. Then it calls the tools and
  checks that `clear_memory` waits for your answer in the page. Needs Chrome
  (`CHROME_PATH` or a usual install location). It runs in CI and is skipped
  elsewhere if no Chrome is found.
- `test/claude-code.ts` (`bun run e2e:claude`): local only, never in CI, because it needs a
  Claude login and spends tokens. It pairs like the e2e test and hands the access token to
  `claude -p` through `${TABMCP_TOKEN}` in the MCP config. Then it checks that "Use the
  calculator to compute 12*12" makes the page show 144. A second run with
  `MCP_PROTOCOL_NEGOTIATION=legacy` must get the relay's 400 / `-32022`.
