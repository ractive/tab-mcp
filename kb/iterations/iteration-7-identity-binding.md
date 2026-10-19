---
type: iteration
title: "Iteration 7: identity binding (0.2+)"
description: Backlog plan for binding a tab and an AI app to the same OpenID Connect identity, as a second pairing method next to the code.
status: planned
tags:
  - iteration
  - oauth
  - security
  - future
timestamp: 2026-10-19T23:30:00+02:00
---

# Iteration 7: identity binding (0.2+)

Goal: an operator can configure the relay so that an AI app is connected to a tab only if
both are signed in as the same person at the same OpenID Connect provider. Design:
[identity binding](/design/identity-binding.md). Not before the research list
([research needed](/research/identity-binding-research-needed.md)) is worked through;
the tasks below are provisional.

Depends on [iteration 3](/iterations/iteration-3-oauth.md)'s replaceable pairing method
(DEC-042).

## Tasks

- [ ] Work through the research list and record the choices in the decision log (variant 1, variant 2 or both; assertion format)
- [ ] Tab assertion: protocol message carrying the web app's signed assertion; relay verifies with the configured JWKS (`aud` = relay and address, `exp` ≤ 60 s, single-use `jti`) and binds the address to (`iss`, `sub`)
- [ ] Logout propagation from the web app; the relay revokes the address's grants
- [ ] Variant 1: OIDC pairing method — `/authorize` redirects to the provider as a registered client (PKCE, `state`, `nonce`), verifies the ID token, compares `iss` + `sub`, issues the MCP code on a match
- [ ] Variant 2 (if chosen): external AS in the protected-resource metadata; JWT validation at the MCP endpoint (JWKS, `aud` = address, `sub` = tab user)
- [ ] Mismatch error "This AI tool is logged in as someone else than the page" on the pairing page and the MCP endpoint
- [ ] Configuration (`TAB_MCP_IDENTITY=oidc` and provider settings) with validation; docs and threat model update
- [ ] Browser library: hook for the page to supply the assertion
- [ ] Tests with a local OIDC provider fixture; conformance with the MCP SDK client; security review

## Acceptance criteria

- With `TAB_MCP_IDENTITY=oidc`, an AI app signed in as the tab's user connects without a
  code; any other identity gets the mismatch error.
- Logout in the web app cuts the AI connection at once.
- `code` remains the default and unchanged.

# Citations

- [Identity binding design](/design/identity-binding.md)
- [Research needed](/research/identity-binding-research-needed.md)
