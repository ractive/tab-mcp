---
type: research
title: "Identity binding: research needed"
description: Questions to answer before planning identity binding in detail — identity providers as MCP authorization servers, assertion standards, AI app behaviour with third-party authorization servers, pairwise subjects and logout.
tags:
  - research
  - oauth
  - future
timestamp: 2026-10-19T23:30:00+02:00
---

# Identity binding: research needed

Not researched yet (owner request of 2026-10-19: list only). For
[identity binding](/design/identity-binding.md) and
[iteration 7](/iterations/iteration-7-identity-binding.md).

1. **Identity providers as MCP authorization servers today.** Which support MCP clients
   via CIMD or dynamic client registration, per-resource audiences (RFC 8707) and PKCE:
   Auth0, Okta, Keycloak, WorkOS, Microsoft Entra ID, Google, GitHub. This decides whether
   variant 2 is usable beyond self-hosted Keycloak and similar.
2. **Standards for the tab assertion.** RFC 7523 (JWT bearer assertions), RFC 8693 (token
   exchange), and the IETF draft "OAuth Identity and Authorization Chaining Across
   Domains"; which fits a web app backend vouching for its user to a relay.
3. **AI app behaviour with a third-party AS.** How claude.ai, Claude Code and ChatGPT
   behave when the protected-resource metadata names an authorization server on another
   domain (CIMD support there, consent screens, token audience, refresh).
4. **Account linking with pairwise subjects.** Providers that return a different `sub` per
   client (OIDC pairwise subject identifiers) make the tab's `sub` (seen by the web app's
   client) and the AI side's `sub` (seen by the relay's client) differ for the same person;
   find a stable linking key or a way to share the client (sector identifier).
5. **Session and logout propagation.** OIDC Back-Channel Logout (and front-channel/RP-
   initiated logout) so that logging out at the provider or in the web app revokes the
   relay's grants.

# Citations

- [RFC 7523 JWT profile for OAuth client authentication and authorization grants](https://www.rfc-editor.org/rfc/rfc7523)
- [RFC 8693 OAuth 2.0 token exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [OAuth Identity and Authorization Chaining Across Domains (draft)](https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-chaining/)
- [OpenID Connect Core 1.0, pairwise identifiers](https://openid.net/specs/openid-connect-core-1_0.html#PairwiseAlg)
- [OpenID Connect Back-Channel Logout 1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html)
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
