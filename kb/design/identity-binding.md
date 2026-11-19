---
type: design
title: Identity binding
description: >-
  The relay connects an AI app to a tab only if both are signed in as the same
  person at the same OpenID Connect provider; a pairing method next to the code
  (DEC-075 to DEC-079).
tags:
  - design
  - security
  - oauth
timestamp: 2026-10-21T18:00:00+02:00
---

# Identity binding

Owner request of 2026-10-19, built in
[iteration 7](/iterations/iteration-7-identity-binding.md) after the
[research](/research/identity-binding-research-needed.md). Decisions: DEC-075 (variant 1
only), DEC-076 (tab assertion), DEC-077 (binding and grants), DEC-078 (logout), DEC-079
(the OIDC method and its settings). The sketch below is the plan as written before the
research; where it differs, the decisions win: the assertion travels in an `identity`
message after `session` with `typ: tab-mcp-identity+jwt`, logout is an `identity.logout`
message from the page, and variant 2 is not built. Since DEC-196 the address names the
app, not a tab: the assertion's `aud` is the app's address, the sign-in at `/authorize`
comes first, and the relay then finds the page among the app's pages.

## Idea

The relay connects an AI app to a tab only if both are signed in as the same person at the
same OpenID Connect provider (Google, GitHub, an organisation's own login such as
comparis.ch's). The pairing code (DEC-028) is one **pairing method**; identity binding is
another. Iteration 3 builds pairing as a replaceable interface so this extension fits
without rebuilding the OAuth server (DEC-042).

## Tab side: who is the page's user?

- The web app's own backend issues a short-lived signed assertion for the relay: a JWT with
  `iss` (the app's issuer), `sub` (the user at the identity provider, or the app's mapping
  of it), `aud` = the app's address on this relay (`https://<relay>/s/<app>/mcp`,
  DEC-196), `exp` about 60 s, `iat`, `jti`.
- The tab sends it to the relay (e.g. in `hello` or a new `identity` message). The relay
  verifies it with the app's JWKS URL (configured), checks `aud`, `exp` and single use of
  `jti`, and binds the session to (`iss`, `sub`). The audience names the app, so the
  assertion is not bound to one page: whoever holds a person's unused assertion could
  bind any session of the app as that person, which before DEC-196 took the page's
  address too.
- The app's ID token is **not** forwarded: its audience is the app, not the relay, and
  accepting it would let any party that received it impersonate the user.
- Logout in the app tells the relay (a signed logout assertion or a back-channel call); the
  relay revokes every grant of that page (its address id).

## AI side: who is the AI app's user?

### Variant 1: the relay as broker (any OIDC provider)

- The relay is a registered OIDC client at the provider (client id and secret configured).
- `/authorize` (still the relay's MCP authorization server) redirects the user's browser to
  the provider, gets the ID token back, and looks among the app's pages for the one whose
  user is that `iss` + `sub` and whose "Connect your AI app" dialog is open; of several,
  the one that connected last; only a page connected when the sign-in started counts
  (DEC-196).
- With such a page the relay issues the MCP authorization code and tokens as today, for
  that page's address id; the code step is replaced by the identity check. An app whose
  pages can pair both ways gets both on one pairing page: the code field, and "Sign in
  instead".
- Works with any OIDC provider; the AI app sees no difference (still CIMD, PKCE, the
  relay's tokens).

### Variant 2: the organisation's authorization server is the MCP AS (dropped, DEC-075)

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
issued or forwarded. Since DEC-196 `/authorize` cannot tell another person's page from no
page: no page of the app, a closed dialog, a signed-out page and another person get one
answer ("No page is connecting with the account you signed in with. …"). The MCP endpoint
still answers a grant made for another person than the page's with "This AI tool is
logged in as someone other than the page."

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
| `TAB_MCP_OIDC_SUBJECT_CLAIM` | `sub` (default) or `oid` (Entra ID), the claim compared |
| `TAB_MCP_TAB_ASSERTION_JWKS_URL` | JWKS of the web app's backend that signs tab assertions |
| `TAB_MCP_TAB_ASSERTION_ISSUER` | expected `iss` of those assertions |

# Citations

- [Decision log](/decision-log.md)
- [Architecture](/design/architecture.md)
- [Threat model](/design/threat-model.md)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [RFC 8707 resource indicators](https://www.rfc-editor.org/rfc/rfc8707)
