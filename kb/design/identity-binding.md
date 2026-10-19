---
type: design
title: "Identity binding (planned for 0.2+)"
description: Planned extension in which the relay connects an AI app to a tab only if both are signed in as the same person at the same OpenID Connect provider; replaces the pairing code as a pairing method.
tags:
  - design
  - security
  - oauth
  - future
timestamp: 2026-10-19T23:30:00+02:00
---

# Identity binding (planned for 0.2+)

Owner request of 2026-10-19. Not part of 0.1. Plan:
[iteration 7](/iterations/iteration-7-identity-binding.md). Open points:
[research needed](/research/identity-binding-research-needed.md).

## Idea

The relay connects an AI app to a tab only if both are signed in as the same person at the
same OpenID Connect provider (Google, GitHub, an organisation's own login such as
comparis.ch's). The pairing code (DEC-028) is one **pairing method**; identity binding is
another. Iteration 3 builds pairing as a replaceable interface so this extension fits
without rebuilding the OAuth server (DEC-042).

## Tab side: who is the page's user?

- The web app's own backend issues a short-lived signed assertion for the relay: a JWT with
  `iss` (the app's issuer), `sub` (the user at the identity provider, or the app's mapping
  of it), `aud` = this relay and address, `exp` about 60 s, `iat`, `jti`.
- The tab sends it to the relay (e.g. in `hello` or a new `identity` message). The relay
  verifies it with the app's JWKS URL (configured), checks `aud`, `exp` and single use of
  `jti`, and binds the address to (`iss`, `sub`).
- The app's ID token is **not** forwarded: its audience is the app, not the relay, and
  accepting it would let any party that received it impersonate the user.
- Logout in the app tells the relay (a signed logout assertion or a back-channel call); the
  relay revokes every grant of that address.

## AI side: who is the AI app's user?

### Variant 1: the relay as broker (any OIDC provider)

- The relay is a registered OIDC client at the provider (client id and secret configured).
- `/authorize` (still the relay's MCP authorization server) redirects the user's browser to
  the provider, gets the ID token back, and compares its `iss` + `sub` with the tab's.
- On a match the relay issues the MCP authorization code and tokens as today; the code step
  is replaced by the identity check.
- Works with any OIDC provider; the AI app sees no difference (still CIMD, PKCE, the
  relay's tokens).

### Variant 2: the organisation's authorization server is the MCP AS

- The relay's protected-resource metadata names the organisation's authorization server in
  `authorization_servers`.
- The AI app obtains tokens there; the relay validates them as a resource server: JWT
  signature via that AS's JWKS, `aud` = this address, `sub` = the tab's user, expiry,
  scope.
- Requires that AS to support MCP clients (CIMD or dynamic client registration) and
  per-address audiences (RFC 8707 `resource`).

## Mismatch

When the identities differ, `/authorize` (variant 1) or the MCP endpoint (variant 2) answers
with a clear error: "This AI tool is logged in as someone else than the page." Nothing is
issued or forwarded.

## Threat model addition

With identity binding the AI app acts with exactly the rights of the tab's user: tool calls
run in that user's page with that user's session. A compromised identity-provider account
therefore also gives control of the AI connection; the binding adds no rights, it removes
the need for a code. The app's assertion key and the relay's OIDC client secret become
secrets of the operator (to be added to the release/operations notes).

## Configuration sketch

| Variable | Meaning |
|---|---|
| `TAB_MCP_IDENTITY` | `code` (default, DEC-028) or `oidc` |
| `TAB_MCP_OIDC_ISSUER` | the provider's issuer URL (discovery) |
| `TAB_MCP_OIDC_CLIENT_ID` / `TAB_MCP_OIDC_CLIENT_SECRET` | the relay's client at the provider (variant 1) |
| `TAB_MCP_OIDC_AS` | external authorization server for the protected-resource metadata (variant 2) |
| `TAB_MCP_TAB_ASSERTION_JWKS_URL` | JWKS of the web app's backend that signs tab assertions |
| `TAB_MCP_TAB_ASSERTION_ISSUER` | expected `iss` of those assertions |

# Citations

- [Decision log](/decision-log.md)
- [Architecture](/design/architecture.md)
- [Threat model](/design/threat-model.md)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [RFC 8707 resource indicators](https://www.rfc-editor.org/rfc/rfc8707)
