# Compatibility

Which AI apps work with tab-mcp, as tested. tab-mcp speaks only the stateless MCP
revision 2026-07-28 and registers AI apps only through OAuth Client ID Metadata
Documents (CIMD), with no dynamic client registration and no older protocol revision.
An app that cannot do both cannot connect.

"Revision" is the tab-mcp commit that was tested.

## Tested

| App | Version | Date | Revision | Auth | Result |
|---|---|---|---|---|---|
| MCP TypeScript SDK client (`@modelcontextprotocol/client`, pinned to 2026-07-28) | 2.3.1 | 2026-10-20 | `aebc41f` | full OAuth flow: CIMD client id, PKCE, the pairing code typed on `/authorize` in headless Chrome 155 | works: lists and calls the calculator's tools, `clear_memory` waits for the page's confirmation, Disconnect in the page ends the token (`examples/calculator/test/e2e.test.ts`, part of CI) |
| Claude Code, headless (`claude -p --mcp-config … --strict-mcp-config`) | 2.1.296 | 2026-10-20 | `aebc41f` | bearer token in `"headers": {"Authorization": "Bearer ${TABMCP_TOKEN}"}`, obtained by the SDK client's OAuth flow | works: "Use the calculator to compute 12*12" pressed the keys and the page showed 144 (`bun run e2e:claude`) |
| Claude Code with `MCP_PROTOCOL_NEGOTIATION=legacy` | 2.1.296 | 2026-10-20 | `aebc41f` | bearer token as above | refused as intended: its `initialize` gets HTTP 400 with JSON-RPC error `-32022` "Unsupported protocol version: 2025-11-25", `supported: ["2026-07-28"]`; the server shows as failed and no tool runs |
| claude.ai custom connector, model Fable 5.1 | web app as of 2026-10-20 | 2026-10-20 | relay `relay-v0.1.0`, client `client-v0.1.0` (`711dda5`) | full OAuth flow against the hosted relay https://tab-mcp.ractive.ch: CIMD, the pairing code typed on `/authorize` | works: on https://ractive.ch/saturnus/app/ (HP 48GX) "Draw a graph for sin(x)*x in RAD" set the mode, EQ and PPAR and showed the plot, then "draw axes" ran `DRAX` (owner's run). Whether the pairing survives a relay restart is not yet checked |

## Pending

These need a manual run.

| App | Why pending |
|---|---|
| Claude Desktop (custom connector) | Custom connectors go through claude.ai's servers like the web app's, which works; not yet run in the desktop app itself. |
| ChatGPT developer mode | OpenAI's servers connect; the hosted relay https://tab-mcp.ractive.ch is up since 2026-10-20, not yet tried. |
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
