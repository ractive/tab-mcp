# Log

## 2026-11-13

- Iteration 34 (iteration F of the review, `iteration/34-webmcp-draft`): the WebMCP draft of 2026-11-12: `Tool.outputSchema` (listed, passed to WebMCP, shown in tab-mcp for Chrome's `webmcp_tools`), `exposedTo` passed on (owner), an aborted signal rejects, a mirrored void tool resolves as "Done." and an MCP result as its `structuredContent` or text, `destructiveHint` counts as consequential for the mirror, no retry and the getter read per `TabMcp` (owner); the bridge decodes JSON strings, passes JSON objects as `structuredContent`, notes patterns in descriptions and leaves out `debugging` tools; deviations from the draft in the client README, research notes and iteration 25 brought up to date; core 6386 of 6400 B; DEC-143, DEC-144
- Iteration 29 (iteration A of the review, `iteration/29-relay-dos`): a refresh stores the new pair before it marks the old token used, so a store failure no longer revokes the grant on retry; a full instance evicts open authorization requests (per /56) instead of refusing everyone; uncached client ids are charged to the requesting network first; tab control messages have a budget (`rate_limited`, 4008); every request body has a deadline; timer settings stop at 2^31-1 ms; JWKS keys and candidates are capped and failed assertions refused early; the MCP endpoint reads a large body only for a valid token; DNS inside the metadata timeout; proxy header ports stripped; keep-alives only in event streams; the sweep survives a throwing store, `installCrashLogging` exported; a `Bun.serve` error handler; DEC-127 to DEC-129
- Iteration 31 (review iteration C, client): a hint that is not a boolean is refused (CC 2); only an MCP result with MCP content blocks passes through, with its `_meta`, and `structuredContent` is the parsed JSON (CC 3); the schema check skips data and property names (CC 13); confirmations one at a time per document, re-armed when another dialog closes, Allow only after the arguments were scrolled to their end, stray Enter, Space and Escape ignored before the delay (CU 1, 2, 13); page colours, button styles and `pointer-events: none` kept out of the dialogs (CU 3, 8); `aria-describedby` and named Disconnect buttons (CU 14); `serve` ends on the port's `close` event (CC 1); a port's missing limits documented (CC 8); DEC-133 to DEC-135
- Iteration 35 (iteration G of the review, `iteration/35-extension-store`): tab-mcp for Chrome before the store: `webmcp_tools` gives input schemas (EQ 1), the ReDoS guard keeps parameters named `pattern` (ES 2), a page that does not answer in 5 s is given up (ES 1), "retrying" instead of "off" and the alarm at every start (EQ 3, EQ 14), page tools ask in the bridge and say why a call did not run (EQ 4), "Don't ask again on <host>" replaces the ephemeral Always allow (EQ 10, owner), mirrored tools offered (WM 1), a navigating page tool answers with the new page (WM 2), the origin from Chrome (ES 4), http(s) only and no Incognito (ES 9), image budget within 1 MiB (ES 6), test hooks only in the test build (ES 7), store listing and both privacy pages with the navigation tools (ES 3, ES 8); DEC-139 to DEC-142
- Iteration 32 built (review iteration D, CC 4, 5, 6, 7, 10, 11, 12, 14, 15): `newAddress()` always takes the old address back, connected or not; the take-back fallback for relays of 0.4 and older, `#takenOver` and `#pageWaits` deleted; sibling claims carry the address id; proxy close codes reconnect, with jitter; oversized results become error results before `toolcallend`; no page title in `hello` (the relay ignores `page`); no error echo; DEC-136 to DEC-138
- Full review of every component (relay, client library, tab-mcp for Chrome, WebMCP integration, example pages) by eight read-only reviewers: 144 findings (1 high, 44 medium, 99 low), a triage and ten proposed iterations in `research/review-2026-11-13.md`
- Client 0.15.0 released (iteration 28); ractive.ch examples, the sign-in example, saturnus and Overmark moved to it
- Iteration 28 built (plan/iteration-28, for client 0.15.0): `mcp.serve(port, { client })`, `@ractive-ch/tab-mcp-client/tunnel` with `createTunnelFetch`, `relay` optional, the caller kind `local`; DEC-122 to DEC-126; threat model A15; the core budget is 6.25 KB

## 2026-11-12

- Iteration 28 planned: the client serves its tools over a message port (`mcp.serve`) and `@ractive-ch/tab-mcp-client/tunnel` speaks the other end (`createTunnelFetch`), so a site's own assistant in an iframe calls the page's tools through its backend's WebSocket with the `http.*` messages and no relay; `relay` optional on `TabMcp`; five open questions for the owner
- ext/navigation (iteration 27): navigate, go_back, go_forward and reload for the tab in front while the extension may read it, each answering with the new page's page_info; the page's origin runs at once, another origin (and a back or forward the Navigation API does not list) asks with From and To, Allow or Don't allow only; http(s) only, no user name or password; the result says when the new page needs a click; no new permission; threat model A13; DEC-121

## 2026-11-10

- client/setup-instructions: `@ractive-ch/tab-mcp-client/setup` exports `setupInstructions` and `SETUP_GUIDE` (the connect dialog's steps per AI app, out of the core); tab-mcp for Chrome's pairing box shows them under "How do I add it?" with a Copy per command; DEC-118

## 2026-11-09

- relay/review-fixes: a revoked grant's requests in flight and listen streams end, and a request that waited for its page re-checks its token; a grant dates from its authorization code, so a code issued before New address or revoke all makes none (those also drop the address's pending requests and codes); IPv6 sessions counted per /64 and /56; sessions nobody paired with close after 10 minutes (TAB_MCP_UNPAIRED_IDLE_TIMEOUT_S); the per-address guess limit fails closed when full and only wrong guesses count; /token and /revoke limit failures per IP without refusing successes, under a per-IP ceiling on all requests; the deterministic unknown-kid test; threat model A4 (the secret's holder can pair an AI app of their own), A8; DEC-117
- ext/review-fixes: Always allow kept per AI app, origin, page (documentId) and tool, and only if the tool is still the one asked about after the answer; a page tool that becomes page_info (or another own tool name) is left out and not callable through webmcp_call, a tool the library refuses is dropped from webmcp_call too; the client library exports escapeInvisible (`@ractive-ch/tab-mcp-client/visible`, out of the core) and the extension uses it (variation selectors, U+034F, private-use, unassigned and C1 characters escaped); a click on a notification body opens the whole question in the side panel of the tab (sidePanel.open in the notification click's gesture; the DevTools Protocol gives none, so the e2e test covers the fallback) or a question window of its own, the arguments in full, notifications say when the arguments are cut; no `storage` permission; the panel question shows the verified site and the page title on labelled lines; a failed worker start is retried and shown in the panel; Disconnect keeps the keyboard focus; the AI access switch flip runs out without a state; threat model A13 (kb and docs)
- docs/pre-release: the pre-release review's documentation and release-path fixes: SECURITY.md and docs/threat-model.md cover tab-mcp for Chrome 0.1.0 (A13 ported); release.yml skips `extension-v*` releases cleanly; the `--store` build has no source maps (test/build.test.ts); iteration 23 tasks for the store id on the hosted relay and the store package checks; kb/design/protocol.md points to docs/protocol.md; webmcp_call in the extension design; image limit worded as base64; the extension in the README and CLAUDE.md
- ext/kv-atomic: a settings write is all or nothing; the worker no longer reads or removes anything in chrome.storage.local (settings live only in its database); its database connection is reopened when Chrome closes it under the worker; threat model A13
- ext/panel-polish: a connected app's row shows a green dot, Disconnect is an outlined button; the AI access switch's knob sits flush (the track took the text fields' padding, border and flex); "Allow all" / "Ask for all" over a site's tool list (set-allowed-all, checked by the worker against the tools it offers); threat model A13
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
