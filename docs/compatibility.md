# Compatibility

Which AI apps work with tab-mcp, as tested. tab-mcp speaks only the stateless MCP
revision 2026-07-28 and registers AI apps only through OAuth Client ID Metadata
Documents (CIMD), with no dynamic client registration and no older protocol revision.
An app that cannot do both cannot connect.

"Revision" is the tab-mcp commit that was tested.

## Tested

| App | Version | Date | Revision | Auth | Result |
|---|---|---|---|---|---|
| MCP TypeScript SDK client (`@modelcontextprotocol/client`, pinned to 2026-07-28) | 2.3.1 | 2026-10-20 | `aebc41f` | full OAuth flow: CIMD client id, PKCE, the pairing code typed on `/authorize` in headless Chrome 155 | works: lists and calls the calculator's tools, `clear_memory` waits for the page's confirmation, Disconnect in the page ends the token (`test/e2e/test/e2e.test.ts`, part of CI) |
| Claude Code, headless (`claude -p --mcp-config … --strict-mcp-config`) | 2.1.296 | 2026-10-20 | `aebc41f` | bearer token in `"headers": {"Authorization": "Bearer ${TABMCP_TOKEN}"}`, obtained by the SDK client's OAuth flow | works: "Use the calculator to compute 12*12" pressed the keys and the page showed 144 (`bun run e2e:claude`) |
| Claude Code with `MCP_PROTOCOL_NEGOTIATION=legacy` | 2.1.296 | 2026-10-20 | `aebc41f` | bearer token as above | refused as intended: its `initialize` gets HTTP 400 with JSON-RPC error `-32022` "Unsupported protocol version: 2025-11-25", `supported: ["2026-07-28"]`; the server shows as failed and no tool runs |
| claude.ai custom connector, model Fable 5.1 | web app as of 2026-10-20 | 2026-10-20 | relay `relay-v0.1.0`, client `client-v0.1.0` (`711dda5`) | full OAuth flow against the hosted relay https://tab-mcp.ractive.ch: CIMD, the pairing code typed on `/authorize` | works: on https://ractive.ch/saturnus/app/ (HP 48GX) "Draw a graph for sin(x)*x in RAD" set the mode, EQ and PPAR and showed the plot, then "draw axes" ran `DRAX` (owner's run). The pairing survived a relay restart (bunny, 2026-10-20): after the page connected again, the same chat used the calculator without signing in again |
| Claude Desktop (macOS), custom connector | 3.6556.2 (20c019) | 2026-10-25 | relay `relay-v0.5.0`, client `client-v0.8.0` (saturnus) | full OAuth flow against the hosted relay: Desktop detects "Sign in now" and "Use Claude's published identity" (CIMD) by itself; Connect opens the browser (claude.ai asks "Finish connecting a connector?"), the relay's `/authorize` shows "Connect Claude from claude.ai" (Desktop uses claude.ai's client id), the pairing code, then the browser opens Desktop again | works (owner's run): on https://ractive.ch/saturnus/app/ the calculator's tools ran. The connector tile shows a placeholder icon: the relay serves no favicon |
| Codex desktop, with `mcp_2026_07_28 = true` under `[features]` in `~/.codex/config.toml` | 0.163 | 2026-10-23 | relay `relay-v0.3.0`, client `client-v0.5.0` and `client-v0.5.1` | full OAuth flow against the hosted relay: CIMD; on https://tab-mcp-login.ractive.ch/ Google sign-in at the relay (identity binding), on https://ractive.ch/saturnus/app/ the pairing code | works (owner's run): the sign-in example's notes tools ran, and signing in with a different Google account was refused; on saturnus the calculator's tools ran. Without the feature flag the sign-in succeeds but no tools appear. Codex loads tools when a chat starts, so the chat must start after pairing, and each page needs its own `[mcp_servers.<name>]` entry, since each page has its own relay address |
| ChatGPT for Mac (Codex inside; it keeps its MCP servers in `~/.codex/config.toml`), with `mcp_2026_07_28 = true` under `[features]` there | 26.1016.62342 | 2026-10-25 | relay `relay-v0.5.0`, client `client-v0.8.0` (todo example) | Settings → Plugins → MCPs → Add → custom MCP, type Streamable HTTP, the address; then Authenticate: full OAuth flow with Codex's CIMD client id `https://chatgpt.com/oauth/codex/client.json`, the relay's `/authorize` shows "Connect Codex from chatgpt.com", the pairing code, the redirect to a loopback port on 127.0.0.1 | works (owner's run): the todo example's tools ran. The feature flag is required, as for Codex: without it the sign-in succeeds but no tools appear |

| ChatGPT on the web (chatgpt.com, apps added under https://chatgpt.com/plugins; the connector runs on OpenAI's servers) | web app as of 2026-10-25 | 2026-10-25 | relay `relay-v0.5.1`, client `client-v0.8.0` | full OAuth flow against the hosted relay: CIMD client id `https://chatgpt.com/oauth/client.json`, which prefers `private_key_jwt` and lists `["none", "private_key_jwt"]`; the relay accepts it since 0.5.1 (DEC-104) and ChatGPT then uses `none`; the pairing code on `/authorize` | works (owner's run): the page's tools ran. Relay 0.5.0 and older refused it at `/authorize` ("must use token_endpoint_auth_method \"none\"") |
## Pending

These need a manual run.

| App | Why pending |
|---|---|
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
| Codex (default settings) | uses the older protocol unless `mcp_2026_07_28 = true` is set; with it Codex works (see Tested) |

They stay unsupported until they support both 2026-07-28 and CIMD. This list is
re-checked with each release.
