# Log

## 2026-10-31

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
