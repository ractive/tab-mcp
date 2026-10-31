---
type: iteration
title: "Iteration 15: private_key_jwt client authentication"
status: completed
description: "The relay's authorization server verifies private_key_jwt client assertions (RFC 7523) at /token and /revoke, for ChatGPT's connectors: CIMD jwks_uri under the SSRF rules, the assertion checks, a jti replay store in the token store, and grants bound to the method they were made with."
timestamp: 2026-10-31T12:00:00+01:00
tags: [iteration, security, relay, oauth]
---
# Iteration 15: private_key_jwt client authentication

ChatGPT's connectors register with `https://chatgpt.com/oauth/client.json`, which prefers
`private_key_jwt` (RS256, `jwks_uri: https://chatgpt.com/oauth/jwks.json`) and lists
`["none", "private_key_jwt"]`. DEC-104 let them in as public clients and deferred
verifying the signature. This iteration builds it, on `jwt.ts` without a JOSE library
(DEC-031, DEC-076). The files are `packages/tab-mcp/src/oauth/` (`server.ts`, `cimd.ts`,
the new `client-auth.ts`), `jwt.ts`, `tokens.ts` and `store/`.

## Scope

1. Metadata: `token_endpoint_auth_methods_supported: ["none", "private_key_jwt"]` and
   `token_endpoint_auth_signing_alg_values_supported` (asymmetric only); the same for
   revocation.
2. CIMD: `private_key_jwt` needs a `jwks_uri` (https, SSRF rules of the CIMD fetch);
   decide on an inline `jwks`; DEC-104 stays for documents that list `none`.
3. `/token` (code and refresh grants): verify `client_assertion` of type
   `urn:ietf:params:oauth:client-assertion-type:jwt-bearer` (key by `kid` from the
   client's JWKS, alg tied to key type, `iss` = `sub` = `client_id`, `aud`, `exp` capped,
   `iat`/`nbf`, `jti` single-use until `exp`, also across instances). Failures are
   `invalid_client` (401); the reason is logged.
4. Binding: how the method used binds a grant, so a stolen refresh token cannot be
   redeemed as a public client; the DEC-104 case (both methods listed); `client_secret_*`
   stays refused.
5. Tests for every rule, the MCP conformance suite still passing.
6. Docs: a decision, this file, the log, the changelog, `docs/`.

## Tasks

- [x] Metadata advertises `private_key_jwt` and the signing algorithms, for `/token` and `/revoke`
- [x] CIMD: `jwks_uri` on the client id's own host, canonical; no inline `jwks`; `token_endpoint_auth_signing_alg` narrows the algorithms; DEC-104 public path kept
- [x] JWKS fetch with the CIMD fetch's SSRF rules and rate limits (`ClientMetadataFetcher.fetchJwks`), cached per `jwks_uri` with `JwksCache` (`load` option)
- [x] Assertion checks (`oauth/client-auth.ts`), `client_id` optional with an assertion (RFC 7521 §4.2), one `invalid_client` text, `oauth.client_auth_failed` with the reason
- [x] Binding: `TokenRecord.clientAuth`; bound grants need an assertion for every refresh, checked before reuse detection; strict clients need one for every code, checked before the code is used
- [x] Replay store: optional `TokenStore.claimNonce`, in the memory and SQLite stores (schema version 5), with a per-instance memory fallback
- [x] Store conformance suite: `clientAuth` round trip, `claimNonce` once and atomic
- [x] Tests: `test/private-key-jwt.test.ts`; oauth4webapi's `PrivateKeyJwt` in the conformance run
- [x] DEC-106; DEC-059 and DEC-104 point to it
- [x] Changelog, `docs/compatibility.md`, `docs/token-store.md`, `docs/self-hosting.md`, `docs/threat-model.md`, `kb/design/architecture.md`

## Progress

DEC-106 holds every decision. In short:

- **Binding:** the method a grant is made with binds it. A grant made or refreshed with
  an assertion needs one for every refresh, so a stolen refresh token alone can neither be
  redeemed as a public client nor trigger reuse revocation. A client whose document lists
  only `private_key_jwt` needs an assertion for every code. One that also lists `none`
  (ChatGPT) may still start a public grant, so an AI app that kept the relay's old
  metadata (only `none`) is not locked out; its first signed request binds the grant.
- **Inline `jwks`:** not accepted.
- **Replay store:** the token store's optional `claimNonce`, shared by instances that
  share a store; without it, per-instance memory.
- **Lifetime:** `exp` at most an hour ahead, 30 s leeway. ChatGPT's real lifetime is not
  known; a shorter cap would risk refusing it.

Not done here: a run against ChatGPT itself (it needs the relay deployed), the relay
release and the deploy (owner).

# Citations

- [RFC 7521: Assertion Framework for OAuth 2.0 Client Authentication](https://www.rfc-editor.org/rfc/rfc7521)
- [RFC 7523: JWT Profile for OAuth 2.0 Client Authentication](https://www.rfc-editor.org/rfc/rfc7523)
- [OpenID Connect Core 1.0 §9: Client Authentication](https://openid.net/specs/openid-connect-core-1_0.html#ClientAuthentication)
- [draft-ietf-oauth-rfc7523bis](https://datatracker.ietf.org/doc/draft-ietf-oauth-rfc7523bis/)
- [RFC 7591 §2: Client Metadata](https://www.rfc-editor.org/rfc/rfc7591#section-2)
- [ChatGPT's Client ID Metadata Document](https://chatgpt.com/oauth/client.json)
