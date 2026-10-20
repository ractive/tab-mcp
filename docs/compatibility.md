# Compatibility

Which AI apps work with tab-mcp, as tested. tab-mcp speaks only the stateless MCP
revision 2026-07-28 and registers AI apps only through OAuth Client ID Metadata
Documents (CIMD), with no dynamic client registration and no older protocol revision.
An app that cannot do both cannot connect.

"Revision" is the tab-mcp commit that was tested.

## Tested

| App | Version | Date | Revision | Auth | Result |
|---|---|---|---|---|---|
| MCP TypeScript SDK client (`@modelcontextprotocol/client`, pinned to 2026-07-28) | 2.3.1 | 2026-10-20 | `b2901a9` | full OAuth flow: CIMD client id, PKCE, the pairing code typed on `/authorize` in headless Chrome 155 | works: lists and calls the calculator's tools, `clear_memory` waits for the page's confirmation, Disconnect in the page ends the token (`examples/calculator/test/e2e.test.ts`, part of CI) |
| Claude Code, headless (`claude -p --mcp-config … --strict-mcp-config`) | 2.1.296 | 2026-10-20 | `b2901a9` | bearer token in `"headers": {"Authorization": "Bearer ${TABMCP_TOKEN}"}`, obtained by the SDK client's OAuth flow | works: "Use the calculator to compute 12*12" pressed the keys and the page showed 144 (`bun run e2e:claude`) |
| Claude Code with `MCP_PROTOCOL_NEGOTIATION=legacy` | 2.1.296 | 2026-10-20 | `b2901a9` | bearer token as above | refused as intended: its `initialize` gets HTTP 400 with JSON-RPC error `-32022` "Unsupported protocol version: 2025-11-25", `supported: ["2026-07-28"]`; the server shows as failed and no tool runs |

## Pending

These need a manual run. None has been tested yet.

| App | Why pending |
|---|---|
| claude.ai custom connector (web) | claude.ai connects from Anthropic's servers, so it needs the relay at a public HTTPS address. That comes with the deployment on ractive.ch (iteration 6). No public tunnel was opened for this. |
| Claude Desktop (custom connector) | Custom connectors go through claude.ai's servers, so it needs a public HTTPS relay as well (iteration 6). |
| ChatGPT developer mode | OpenAI's servers connect, so it needs a public HTTPS relay (iteration 6). |
| Claude Code, interactive (`claude mcp add --transport http`, then `/mcp` → Authenticate with its CIMD client id) | This works with a local relay, but someone has to type the pairing code into the browser during the sign-in. Not yet run by hand. Iteration 3 completed `/authorize` in Firefox with Claude Code's published client metadata document, but not the whole sign-in from Claude Code. |

## Known issues in supported apps

- Claude Desktop and Claude Code via claude.ai connectors send the header
  `MCP-Protocol-Version: 2025-11-25` with a 2026-07-28 request body (claude-code #93290).
  The relay accepts exactly this case and counts it in `/healthz`.

## Not supported

| App | Why |
|---|---|
| VS Code / GitHub Copilot | speaks only MCP 2025-11-25, with no 2026-07-28 support |
| Cursor | has no CIMD support (only dynamic client registration) |
| Gemini CLI | supports neither 2026-07-28 (its SDK is on 2025-06-18) nor CIMD |
| Codex CLI (default settings) | uses the older protocol unless `mcp_2026_07_28 = true` is set; untested with that flag |

They stay unsupported until they support both 2026-07-28 and CIMD. This list is
re-checked with each release.
