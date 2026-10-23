# End-to-end test

The whole chain in one test: a relay, a page with tab-mcp in headless Chrome, and the MCP
SDK client as the AI app doing the complete OAuth flow with the pairing code. The page is
a small four-function calculator (with M+, MR and MC) that offers four tools:

| Tool | What it does |
|---|---|
| `press_keys` | presses keys in order (`0-9 . + - * / = C`, e.g. `12+30=`) and returns the display |
| `read_display` | returns the display and the memory without pressing anything (read-only) |
| `clear` | presses C: clears the display and the pending operation, keeps the memory |
| `clear_memory` | sets the memory to 0 (MC); consequential, so the page asks you first |

It is a test page, not an example: the live examples are at
<https://ractive.ch/tab-mcp/>. It only ever talks to a relay the test starts on this
machine, never to the hosted relay.

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

`server.ts` serves the page with Bun's HTML import and `/config.json`, which tells the
page its relay; `test/stack.ts` starts the relay, the page, Chrome and the OAuth client.
