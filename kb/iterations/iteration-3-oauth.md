---
type: iteration
title: "Iteration 3: OAuth authorization server with tab consent"
description: Protected-resource and authorization-server metadata, CIMD client validation, the authorize page with code comparison, token endpoint with PKCE, revocation.
status: planned
tags:
  - iteration
  - oauth
  - relay
timestamp: 2026-10-19T20:00:00+02:00
---

# Iteration 3: OAuth authorization server with tab consent

Goal: a real MCP client obtains a token through the standard MCP authorization flow, with
the user approving in the tab, and nothing else can.

Read first: [MCP spec research](/research/mcp-2026-07-28-spec.md) (Authorization),
[AI app support](/research/ai-app-support.md) (requirements list),
[threat model](/design/threat-model.md) A1–A4 and A7, DEC-006, 007, 015, 016.

## Tasks

- [ ] `WWW-Authenticate: Bearer resource_metadata="…", scope="tools"` on 401
- [ ] `/.well-known/oauth-protected-resource/a/:id/mcp` (RFC 9728): `resource`, `authorization_servers`, `scopes_supported: ["tools"]`, `bearer_methods_supported: ["header"]`
- [ ] `/.well-known/oauth-authorization-server` (RFC 8414): issuer, endpoints, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true`, `revocation_endpoint`, `scopes_supported`
- [ ] CIMD fetcher: SSRF guards (https, resolve and refuse private ranges, no redirects, 5 s, 64 KiB, JSON), validation (`client_id` equality, `client_name`, `redirect_uris`, `token_endpoint_auth_method` `none`), cache by `Cache-Control` (5 min–24 h), optional host allow-list
- [ ] Redirect URI matching: exact, except loopback `localhost`/`127.0.0.1`/`[::1]` with any port (RFC 8252)
- [ ] `/authorize`: parameter validation; errors before a trusted redirect URI shown on the page; `resource` must be a known address; waits up to 5 min for the tab to connect; pending authorization with a 4-digit code (crypto random), cap 3 per address, 5 min expiry; `auth.request` to the tab; server-rendered page with escaping, CSP and security headers, `__Host-` cookie binding
- [ ] `/authorize/wait` long-poll (with `server.timeout`), bound to the cookie; on allow redirect with `code`, `state`, `iss`; on deny/expiry `error=access_denied`; a no-JS "Continue" form protected with `Bun.CSRF`
- [ ] `/token`: `authorization_code` with PKCE S256 (`Bun.CryptoHasher`), single-use 60 s codes bound to client id, redirect URI and resource; constant-time comparisons; opaque 256-bit token; `expires_in` = remaining session lifetime; RFC 6749 error responses; `Cache-Control: no-store`
- [ ] `/revoke` (RFC 7009) and `grant.revoke` from the tab
- [ ] Rate limits for `/authorize`, `/token`, CIMD fetches (token buckets)
- [ ] Replace the iteration-1 test grant API with real flows in tests (keep it only as an internal test helper)

## Acceptance criteria

- The SDK `Client` (pinned 2026-07-28, `clientMetadataUrl` served by a test fixture over
  HTTPS-equivalent test mode) completes discovery → authorize → tab approval (scripted
  tab auto-approves after checking the code) → token → tool call.
- Negative tests: wrong PKCE verifier, reused code, expired code, mismatched redirect URI,
  `client_id` document mismatch, private-IP CIMD host, oversized CIMD, tab denies, token
  for another address, revoked grant, session ended → each fails with the right error.
- Two concurrent authorizations for one address are both flagged to the tab.
- The authorize page renders hostile client names and page titles escaped (test).
- `bun run verify` green.

## Test approach

`bun test` with a local CIMD fixture server (the relay's CIMD fetcher gets a test-only
override to allow `http://127.0.0.1` fixtures; production builds refuse it), scripted tab,
SDK client with a custom `OAuthClientProvider` that follows the authorize page's redirect
by calling `/authorize/wait` directly.

# Citations

- [MCP 2026-07-28 research](/research/mcp-2026-07-28-spec.md)
- [AI app support research](/research/ai-app-support.md)
- [RFC 7009 token revocation](https://www.rfc-editor.org/rfc/rfc7009)
- [RFC 7636 PKCE](https://www.rfc-editor.org/rfc/rfc7636)
