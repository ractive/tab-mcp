# Log

## 2026-11-09

- ext/storage-hardening: the extension's settings and address secret moved from chrome.storage.local (open to content scripts by default) into IndexedDB in the extension's origin, worker only, with a one-off crash-safe migration; `TRUSTED_CONTEXTS` on the local area kept as an extra layer, best effort; notifications cleared only after their `create` finished, one per question; threat model A13
- ext/panel-clarity: the icon opens the side panel over another extension's panel for the tab (`sidePanel.open` with the tab; `openPanelOnActionClick` would lose `activeTab`); the "AI app" card shows the next step (an "AI access" switch, "Turn on AI access", the address and code at once with no app paired, "+ Add another AI app", Disconnect asks first, the address only while pairing); notifications offer Allow and Always allow, declining is closing them; threat model A13
- Iteration 26 on iter-26/background-connection: the extension's connection lives in its service worker (the spike: the relay's heartbeat keeps it running, no offscreen document; DEC-116), stays with the side panel closed and comes back after a restart; the side panel is a view over a checked port with its own pairing; questions in the panel of the tab's focused window or as Chrome notifications, Always allow of its own, a 60 s limit, a badge on the icon; permissions `notifications` and `alarms`; threat model A13
- Iteration 20 merged (tab-mcp#79): the bridge works with Claude after renaming page tools to page_<name>; "Always allow" and per-site "allowed" tools; iteration 26 planned: the connection out of the side panel (service worker or offscreen document), questions by notification when the side panel is closed; DEC-116
- Iteration 20 on iter-20/webmcp-bridge: the WebMCP bridge (page.<name> tools, webmcp_tools, toolchange, confirmation of tools not marked read-only, timeout, cancellation, limits), the side panel redesigned, the connector's icon; threat model A13

## 2026-11-08

- Planned tab-mcp for Chrome, a browser extension in this repository ([design](/design/extension.md)): iteration 18 tests whether an extension can reach a page's WebMCP tools, 19 the skeleton with reading tools, 20 the WebMCP bridge, 21 recipes (tools an AI app builds for a site, Overmark's matcher copied in), 22 managing them, 23 the release; DEC-109 to DEC-112
- Iteration 18 on spike/webmcp-from-extension: a content script reaches a page's WebMCP tools on the native `document.modelContext` in Chrome 156 (flag, or the page's origin trial token) and can register tools the page sees; test page, test extension and a canary in `test/webmcp-spike/`; [research](/research/webmcp-from-extension.md); DEC-113
- The extension is cut to a small WebMCP bridge (iterations 19, 20, 23); recipes (iterations 21, 22) dropped; iteration 24 added, an experiment with user scripts; DEC-114
- WebMCP adoption researched ([research](/research/webmcp-adoption.md)); iteration 25 planned: the client library can also register its tools with WebMCP (opt-in, consequential tools only when named); iteration 20 treats page tool lists as advisory; DEC-115
- Iteration 19 on iter-19/extension-skeleton: packages/tab-mcp-extension with the side panel, page_info, the build (development key outside the repository), unit and end-to-end tests (real icon clicks, test relay, MCP client); relay 0.7.0 deployed to tab-mcp.ractive.ch and the development build's id allowed there (ractive.ch#85)

## 2026-11-04

- Iteration 17 on relay/extension-origins: the relay accepts Chrome and Edge extension origins (`chrome-extension://<id>`) in TAB_MCP_ALLOWED_ORIGINS and TAB_MCP_SITES, refuses moz-extension and safari-web-extension with a reason, and names an extension on the pairing page; DEC-108; for Overmark

## 2026-10-31

- Iteration 16 on iter-16/game-feedback: the comparis game's feedback (dialog centring under CSS resets, the development public URL, 'Connection lost, retrying…', startTestRelay and tokenFor in @ractive-ch/tab-mcp/testing, Tool<Input>, README sections); DEC-107 (no development pairing endpoint); the hosted relay allows the game's origin (ractive.ch PR 73)
- Iteration 15 on iter-15/private-key-jwt: `private_key_jwt` client authentication at `/token` and `/revoke` (RFC 7523) for ChatGPT's connectors, grants bound to the method they were made with, `TokenStore.claimNonce` for single-use `jti`s; DEC-106; relay release open

## 2026-10-25

- Iteration 6 completed: Claude Desktop, ChatGPT for Mac (Codex inside, with its flag) and ChatGPT on the web (after relay 0.5.1, DEC-104) work; relay 0.5.1 released and deployed (icon, DEC-104)
- The core's size budget raised to 6 KB gzipped (DEC-103)
- Iterations 11 and 13 completed: relay 0.5.0 deployed; client 0.8.0 in the ractive.ch examples, the sign-in page and saturnus (PR 234); session slots deferred (DEC-097)
- Iteration 14 completed: `DOCKERHUB_TOKEN` in the `release` environment (a token without expiry), the Docker Hub expiry check removed; DEC-102
- Iteration 11 on iter-11/multi-instance: the address id in the `/tab` URL (`?a=`, checked against the secret, close 4009), the id on every request that needs the address's instance, "Running several instances" in docs/self-hosting.md, `/healthz` checks the token store; DEC-097 (session slots deferred), DEC-098, DEC-099
- Iteration 10 and iteration 13 finding 3 on iter-10/address-takeover: docs on a stolen address secret and the reported origin, `replaced` with `detail.sibling` from a BroadcastChannel and a notice in the default UI, `newAddress()` takes a taken-over address back first, "Always allow" opt-in (`alwaysAllow`); DEC-094 (no backend-signed address claim), DEC-095, DEC-096; client release open

## 2026-10-24

- Relay 0.3.1 released and deployed (modern-envelope initialize 404/-32601); Codex recorded in docs/compatibility.md
- Codebase review (architecture, auth, relay, library, CI): iterations 10 (stolen address secret), 11 (relay), 12 (authorization server), 13 (browser library), 14 (CI and settings) planned

## 2026-10-23

- Iteration 9 on iter-9/react: `@ractive-ch/tab-mcp-client/react` (provider, useTabMcp, useTabMcpState with identity and reconnecting, useTool, useToolCalls, ConnectButton; optional peer react >=18.3.0 <20, tested with React 18.3 and 19), reconnecting in the core (5, 10, 20, 40, then 60 s; at once on visibility or online), examples/react-todo with a Chrome e2e including a relay restart; DEC-081, DEC-082; skill, release and saturnus still open

## 2026-10-21

- Iteration 8 on iter-8/page-not-open: the relay waits up to TAB_MCP_PAGE_WAIT_S for the page, then answers "the page is not open" at HTTP 200 (tool error, stand-in server/discover, JSON-RPC error), DEC-074; headless Claude Code before/after

## 2026-10-20

- Iteration 5 packaging on iter-5/relay-docker: relay build to `dist/` and pack checks, relay npm jobs (pack, bootstrap, publish), Dockerfile (build platform stage, distroless, uid 65532, /data), image dry run with smoke test on pull requests and push to Docker Hub and ghcr.io after npm, token-expiry check, Dependabot; DEC-068 to DEC-071; relay bootstrap steps for the owner; documentation and skill still open
- Iteration 4 on iter-4/calculator-e2e: calculator example, Chrome e2e in CI, headless Claude Code run (144, legacy refused with 400 / -32022), docs/compatibility.md; manual checks with claude.ai, Desktop and ChatGPT deferred to iteration 6; SDK Firefox issue drafted, not filed

## 2026-10-19

- Security review of PR #4: eight findings fixed, DEC-061 to DEC-067
- Iteration 3 built on iter-3/oauth: OAuth authorization server with pairing codes and sites, DEC-056 to DEC-060; real-browser check with Claude Code's metadata document
- Review of PR #3: release guards (main-only bootstrap, commits on main, tarball hash, signer check, latest never backwards), owner steps reordered, latest known issue
- Iteration 5a: npm release workflow for @ractive-ch/tab-mcp-client 0.1.0-alpha.0 (bootstrap proven on the branch), npm publishing steps, DEC-055 (release tags and dist-tags)
- Iteration 2: browser library built; DEC-049 (own MCP subset after measuring the SDK) to DEC-054
- Review of PR #1 fixed: DEC-047 (crash logging), DEC-048 (body-read deadline), Bun idle-timeout finding
- Iteration 1 implemented on iter-1/relay-core; DEC-040 order and relay error codes documented
- One relay serves several sites: app name from the tab, per-origin site configuration (DEC-045)
- Iteration 6: OpenTofu state in a bunny storage zone over S3 with client-side encryption (DEC-044)
- Iteration 6: hosted relay as infrastructure as code with OpenTofu and the BunnyWay/bunnynet provider (DEC-043), with research items
- Identity binding planned for 0.2+ (design, iteration 7, research list); pairing becomes a replaceable method in iteration 3 (DEC-042)
- Owner decisions DEC-027 to DEC-038 recorded (plus DEC-039 to DEC-041); open questions closed; design docs and iteration plans adjusted
- Initial plan: research notes, architecture, protocol, threat model, decision log, six iterations, open questions, release credentials
