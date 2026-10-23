---
type: research
title: "Identity binding: research findings"
description: The five questions for identity binding answered from primary sources — identity providers as MCP authorization servers, assertion standards, AI apps with third-party authorization servers, pairwise subjects and logout — and what they mean for the design.
tags:
  - research
  - oauth
timestamp: 2026-10-21T18:00:00+02:00
---

# Identity binding: research findings

The research list of 2026-10-19 for [identity binding](/design/identity-binding.md) and
[iteration 7](/iterations/iteration-7-identity-binding.md), worked through on 2026-10-21.
The choices are DEC-075 to DEC-079 in the [decision log](/decision-log.md).

## 1. Identity providers as MCP authorization servers (variant 2)

Variant 2 needs an authorization server that (a) registers MCP clients it has never seen
(CIMD, or DCR, which 2026-07-28 deprecates), (b) issues tokens whose audience is one tab
address (RFC 8707 `resource`; the MCP spec says the server MUST validate that the token was
issued for it), and (c) does PKCE.

| Provider | Client registration for unknown MCP clients | Per-resource audience | Note |
|---|---|---|---|
| Keycloak 26.6+ | CIMD experimental (`--features=cimd`) | **not supported** (its own MCP table lists RFC 8707 as unsupported) | closest, still short |
| Auth0 | DCR (tenant setting); CIMD not documented | `resource` only with the "Resource Parameter Compatibility Profile", and the audience must be a registered API | one API per tab address is not workable |
| Okta | DCR in some editions | audience fixed per custom authorization server | as Auth0 |
| Microsoft Entra ID | no DCR, no CIMD, no RFC 8414 metadata | `scope=<resource>/.default`, resources registered in the tenant | unusable without a shim |
| Google | none | none | unusable |
| GitHub | OAuth only, no OIDC ID tokens for users | none | unusable for either variant |

Tab addresses are created by pages at will (DEC-027), so "an audience per address" means
an unbounded set of resources that no hosted provider registers on the fly. Variant 2
would have to fall back to one audience for the whole relay, binding the address only by
`sub`, and the relay could neither list those tokens in the page nor revoke them
(Disconnect, DEC-029) because another server issued them. **Variant 2 is not worth
building now.**

The MCP-native route for enterprise identity providers is the **Enterprise-Managed
Authorization** extension (`modelcontextprotocol/ext-auth`, stable since June 2026). The
AI app signs in at the organisation's IdP, gets an **ID-JAG** (Identity Assertion JWT
Authorization Grant, IETF draft) through RFC 8693 token exchange with
`audience` = the resource AS's issuer and `resource` = the MCP server, and presents it at
the resource AS's token endpoint with the RFC 7523 grant
`urn:ietf:params:oauth:grant-type:jwt-bearer`; the issued token "MUST be
audience-restricted to the MCP Server identified by the resource claim". That fits the
relay's own authorization server (it would accept ID-JAGs at `/token` and compare their
`sub` with the tab's), keeps the relay's tokens, the page's list and Disconnect, and needs
no consent page. Support at launch: Okta as IdP; Claude (generally available 2026-08-24)
and VS Code as clients. It is the better later step for organisations; not built now
because only one IdP issues ID-JAGs and the draft is still moving.

## 2. Standards for the tab assertion

- **RFC 7523** (JWT profile for authorization grants) gives the claim rules that fit a web
  app backend vouching for its user: `iss` = the signer, `sub` = the user, `aud` = the
  party that must accept it, `exp` required and short, `jti` for replay protection. The
  tab assertion follows these rules, but it is presented over the tab's WebSocket, not at
  a token endpoint: the tab is not an OAuth client and gets no token.
- **RFC 8693** (token exchange) would make the relay a token-exchange endpoint for tabs;
  nothing is exchanged (the tab needs no token), so it adds parameters without adding
  security.
- **Identity and Authorization Chaining Across Domains** (IETF draft) and its profile
  **ID-JAG** describe the same shape one level up: one domain's AS signs a short JWT that
  another domain's AS accepts by key. The tab assertion is that pattern with the web app's
  backend as the signer.
- **RFC 8725** (JWT best current practice) §3.11: use explicit typing so a JWT of one kind
  cannot be passed off as another. The web app may sign its ID tokens or access tokens
  with the same key; the assertion therefore carries `typ: tab-mcp-identity+jwt`, which the
  relay requires.
- The web app's ID token must not be forwarded instead: its `aud` is the app, and any
  party holding it could replay it (OIDC Core §2, §16.11).

## 3. AI apps with a third-party authorization server

The 2026-07-28 spec allows the AS to live elsewhere (RFC 9728 `authorization_servers`).
Claude and ChatGPT register by CIMD only when the AS metadata advertises
`client_id_metadata_document_supported` and `none` auth
([AI app support](/research/ai-app-support.md)); against Entra or Google they would fall
back to DCR and fail. Variant 1 does not depend on this: the AI app still talks only to the
relay's AS (CIMD, PKCE, `iss`, the relay's tokens), and the relay is an ordinary
confidential OIDC client at the provider, which every OIDC provider supports.

## 4. Pairwise subjects

OIDC Core §8 lets a provider give each client (or each sector identifier) its own `sub`.

- **Google**: `sub` is the account's id, the same for every client.
- **Keycloak, Auth0, Okta**: public subjects by default.
- **Microsoft Entra ID**: `sub` is pairwise per application; `oid` is the user's id
  across the tenant's applications (with `tid` for the tenant).

Two ways to compare across the web app's client and the relay's client: register both as
one sector (same `sector_identifier_uri`) or the same client, or compare a claim that is
stable across clients. The relay takes the subject from a configurable claim
(`TAB_MCP_OIDC_SUBJECT_CLAIM`, `sub` or `oid`); mutable claims such as `email` or
`preferred_username` are refused, since a renamed or recycled address would map to
another person.

## 5. Session and logout propagation

- **OIDC Back-Channel Logout 1.0**: the provider POSTs a signed logout token (`events`
  claim, `sub` and/or `sid`) to each client's registered endpoint. **Front-Channel
  Logout** and **RP-Initiated Logout** run in the browser. All three concern the
  provider's sessions; the relay has none (it uses the ID token once, at pairing).
- What has to end at logout is the AI connection to the page. The page is already
  authenticated to the relay (the address secret over TLS) and can revoke all grants
  today (`grants.revokeAll`). A logout message from the tab therefore needs no signature,
  and it acts at once.
- Logout that happens while the page is closed (or in another tab) does not need its own
  channel: the binding is re-proved by a fresh assertion on every connection and checked on
  every MCP request, so a grant only works while a page signed in as the same person is
  open. A back-channel endpoint would add a public endpoint, a second token type and an
  index by subject for little gain; it can be added later if an operator needs logout at
  the provider to cut connections while no page is open.

# Citations

- [OpenID Connect Core 1.0 (ID token validation §3.1.3.7, pairwise §8)](https://openid.net/specs/openid-connect-core-1_0.html)
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html)
- [OpenID Connect Back-Channel Logout 1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html)
- [RFC 7523 JWT profile for OAuth client authentication and authorization grants](https://www.rfc-editor.org/rfc/rfc7523)
- [RFC 8693 OAuth 2.0 token exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [RFC 8707 resource indicators](https://www.rfc-editor.org/rfc/rfc8707)
- [RFC 8725 JWT best current practices](https://www.rfc-editor.org/rfc/rfc8725)
- [RFC 9068 JWT profile for access tokens](https://www.rfc-editor.org/rfc/rfc9068)
- [RFC 9700 OAuth 2.0 security best current practice](https://www.rfc-editor.org/rfc/rfc9700)
- [OAuth Identity and Authorization Chaining Across Domains (draft)](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-chaining/)
- [MCP authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [MCP Enterprise-Managed Authorization extension](https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/stable/enterprise-managed-authorization.mdx)
- [Keycloak: integrating with MCP](https://www.keycloak.org/securing-apps/mcp-authz-server)
- [Auth0: resource parameter compatibility profile](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile)
- [WorkOS: enterprise-managed authorization GA](https://workos.com/blog/enterprise-managed-auth-ga-mcp-server-builders)
- [Zuplo: MCP identity provider support](https://zuplo.com/learn/mcp/compatibility/identity-providers)
