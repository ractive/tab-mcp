---
type: iteration
title: "Iteration 3: OAuth authorization server with pairing"
description: "Our own authorization server: metadata, CIMD client validation, pairing codes typed on the authorize page, token endpoint with PKCE and rotating refresh tokens, revocation, spec tests, conformance runs and a security review."
status: in-progress
tags:
  - iteration
  - oauth
  - relay
timestamp: 2026-10-20T01:15:00+02:00
---

# Iteration 3: OAuth authorization server with pairing

Goal: a real MCP client obtains tokens through the standard MCP authorization flow, with
the user typing the code shown in the tab on the relay's `/authorize` page, and nothing
else can. Written by us without an OAuth library (DEC-031).

Read first: [MCP spec research](/research/mcp-2026-07-28-spec.md) (Authorization),
[AI app support](/research/ai-app-support.md) (requirements list),
[threat model](/design/threat-model.md) A1–A4, A7 and A10, DEC-006, 015, 027–031, 033,
036, 040, 041, 042, 045.

## Tasks

- [x] `/.well-known/oauth-protected-resource/a/:id/mcp` (RFC 9728): `resource`, `authorization_servers`, `scopes_supported: ["tools"]`, `bearer_methods_supported: ["header"]`; CORS (DEC-036)
- [x] `/.well-known/oauth-authorization-server` (RFC 8414): issuer, endpoints, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true`, `revocation_endpoint`, `scopes_supported`; no `registration_endpoint`; CORS
- [x] CIMD fetcher: SSRF guards (https, resolve and refuse private ranges, no redirects, 5 s, 64 KiB, JSON), validation (`client_id` equality, `client_name`, `redirect_uris`, `token_endpoint_auth_method` `none`), cache by `Cache-Control` (5 min–24 h), optional host allow-list
- [x] Redirect URI matching: exact, except loopback `localhost`/`127.0.0.1`/`[::1]` with any port (RFC 8252)
- [x] Sites (DEC-045): per-origin configuration `{ origin, name?, pairing: "code" | "oidc", limits overrides }` with instance-wide defaults; the sites are the origin allow-list (empty = nobody, `*` open relay as before); a format for the binary and Docker (e.g. `TAB_MCP_SITES` JSON or a config file) and for `createRelay({ sites })`; the session's limits and pairing method come from its site; `hello.app.name` accepted (≤ 64 characters, unverified) and a configured name preferred, sent back as `session.appName`
- [x] Pairing as a replaceable **pairing method** interface (DEC-042), chosen per site (DEC-045): the authorization server asks the configured method whether a browser at `/authorize` may pair with an address (render its step, check the submission, report the outcome) and knows nothing about codes; today's only method is the 6-digit code, the planned [identity binding](/design/identity-binding.md) is the next; tests run the OAuth flow against a stub method too
- [x] The code method in the relay (DEC-028): `pairing.start`/`pairing.stop` from the tab, `pairing.code` with 6 uniform random digits, single-use, 2 minutes, 5 attempts, a fresh code by itself while pairing is on; codes never logged
- [x] `/authorize`: parameter validation; errors before a trusted redirect URI shown on the page; tab offline → "Open the page and click Connect your AI tool" with a retry; otherwise "You're connecting <client name> (<client host>) to <app name> on <page origin>" (DEC-045; without an app name: "to tools from <page origin>") and a code field; form protected with `Bun.CSRF`; wrong code counts an attempt; success → redirect with `code`, `state`, `iss`; Cancel → `error=access_denied`; server-rendered with escaping, CSP and security headers
- [x] `/token` `authorization_code`: PKCE S256 (`Bun.CryptoHasher`), single-use 60 s codes bound to client id, redirect URI and resource; constant-time comparisons; creates a grant bound to the address; access token 1 h + refresh token 30 days (DEC-029); RFC 6749 error responses; `Cache-Control: no-store`; CORS
- [x] `/token` `refresh_token`: rotation through `markUsed` (atomic), a new refresh token each time, reuse of a used one revokes the grant (`grant.removed` `reuse_detected`); `resource` and `client_id` must match the grant
- [x] `/revoke` (RFC 7009), `grant.revoke` and `grants.revokeAll` from the tab; `session.grants`, `grant.added`, `grant.removed` to the tab
- [x] Rate limits for `/authorize` (per IP and address), `/token`, CIMD fetches (token buckets)
- [x] Spec tests: one test group per requirement of RFC 6749 §4.1/§5.2/§6, RFC 7636, RFC 8414, RFC 9728, RFC 9207, RFC 7009, RFC 8707 and the MCP authorization pages, citing the section
- [x] Conformance runs: `oauth4webapi` (dev dependency, pinned) as client for discovery, authorization code with PKCE, refresh rotation and revocation; the MCP SDK client for the full MCP flow
- [ ] Separate security review of the OAuth diff (fresh-context reviewer, threat model A1–A4, A7) before merging; findings fixed or recorded in the decision log
- [x] Configuration floor for `maxMessageBytes` (e.g. 16 KiB): the relay accepts any positive value today, but the browser library refuses a session whose limit cannot frame a response chunk (below 896 bytes, found in the review of PR #2), and MCP requests need room too
- [x] Replace the iteration-1 store-level token helper with real flows in tests where it matters (keep it as an internal test helper)

## Acceptance criteria

- The SDK `Client` (pinned 2026-07-28, `clientMetadataUrl` served by a test fixture over
  HTTPS-equivalent test mode) completes discovery → authorize → code typed (the test reads
  the code from the scripted tab and posts the form) → token → tool call → refresh.
- `oauth4webapi` completes the same flow and the refresh rotation.
- Negative tests: wrong PKCE verifier, reused code, expired code, mismatched redirect URI,
  `client_id` document mismatch, private-IP CIMD host, oversized CIMD, wrong pairing code
  (5 times → new code), expired pairing code, tab offline, token for another address,
  revoked grant, reused refresh token (grant revoked) → each fails with the right error.
- The authorize page renders hostile client names escaped (test).
- The security review is done and its findings handled.
- `bun run verify` green.

## Results

- Code: `packages/tab-mcp/src/oauth/` (`server.ts` endpoints and pages, `cimd.ts` client
  metadata and SSRF guards, `pairing.ts` the pairing-method interface and the code method,
  `html.ts` escaping, headers and the stylesheet), `ip.ts`, `ratelimit.ts`, sites in
  `config.ts`. No OAuth library; the relay still has no runtime dependencies.
- Decisions taken while building: DEC-056 (sites as JSON, message floor), DEC-057 (the
  form: pending request, `Bun.CSRF` with a cookie, no scripts, no COOP), DEC-058 (token
  endpoint rules), DEC-059 (CIMD details and the test-only switch), DEC-060 (attempt
  limits).
- Tests: `oauth.test.ts` (one group per RFC section and the pairing rules, including every
  negative case of the acceptance criteria and a stub pairing method), `cimd.test.ts`
  (URL rules, SSRF targets, document rules, caching, redirect matching), `pairing.test.ts`,
  `sites.test.ts`, `conformance-oauth4webapi.test.ts` (oauth4webapi 3.8.8), and in the
  client package `oauth-e2e.test.ts`: the SDK client discovers, uses a CIMD client id from
  a local HTTPS fixture, the test types the code shown in the library's dialog, the client
  calls a tool and refreshes, and reusing the old refresh token revokes the grant.
- Real browser: headless Firefox (`ff-rdp`) completed `/authorize` with Claude Code's
  published client metadata document (fetched from claude.ai) and a loopback redirect; the
  run found that `Referrer-Policy: no-referrer` makes browsers post `Origin: null`, now
  `same-origin`. Contrast checks pass.
- Open: the separate security review of the OAuth diff (task above) before merging.
- Manual check with Claude Code: relay on `http://localhost:8080`, a page that runs the
  library on an allowed origin, `claude mcp add --transport http <name> <address>`, then
  `/mcp` → Authenticate in Claude Code and the code from the page (steps in the PR).

## Test approach

`bun test` with a local CIMD fixture server (the relay's CIMD fetcher gets a test-only
override to allow `http://127.0.0.1` fixtures; production configuration refuses it),
scripted tab, SDK client with a custom `OAuthClientProvider` that completes the authorize
page by posting the code, and `oauth4webapi` driven the same way.

# Citations

- [MCP 2026-07-28 research](/research/mcp-2026-07-28-spec.md)
- [AI app support research](/research/ai-app-support.md)
- [RFC 6749 OAuth 2.0](https://www.rfc-editor.org/rfc/rfc6749)
- [RFC 7009 token revocation](https://www.rfc-editor.org/rfc/rfc7009)
- [RFC 7636 PKCE](https://www.rfc-editor.org/rfc/rfc7636)
- [RFC 9700 OAuth security best current practice](https://www.rfc-editor.org/rfc/rfc9700)
- [oauth4webapi](https://github.com/panva/oauth4webapi)
