---
type: iteration
title: "Iteration 7: identity binding (0.2+)"
description: >-
  Binding a tab and an AI app to the same OpenID Connect identity, as a second
  pairing method next to the code.
status: completed
tags:
  - iteration
  - oauth
  - security
timestamp: 2026-10-23T18:00:00+02:00
---

# Iteration 7: identity binding (0.2+)

Goal: an operator can configure the relay so that an AI app is connected to a tab only if
both are signed in as the same person at the same OpenID Connect provider. Design:
[identity binding](/design/identity-binding.md). Research:
[findings](/research/identity-binding-research-needed.md); decisions DEC-075 to DEC-079.

Depends on [iteration 3](/iterations/iteration-3-oauth.md)'s replaceable pairing method
(DEC-042).

## Tasks

- [x] Work through the research list and record the choices in the decision log: variant 1 only (DEC-075), assertion format (DEC-076), binding (DEC-077), logout (DEC-078), the OIDC method and settings (DEC-079)
- [x] Tab assertion: `identity` message carrying the web app's typed JWT; relay verifies with the configured JWKS (`aud` = the address, `exp` ≤ 60 s, single-use `jti`) and binds the address to (provider, `sub`)
- [x] Grants record the subject (token store field, SQLite column, conformance); MCP requests only reach a page bound to the same person; a new identity revokes the old grants
- [x] Logout: `identity.logout` from the page revokes the address's grants and fails requests in flight
- [x] Variant 1: OIDC pairing method — `/authorize` redirects to the provider as a registered client (PKCE, `state`, `nonce`), verifies the ID token, compares the subject, issues the MCP code on a match
- [x] Variant 2: dropped (DEC-075: no provider issues per-address audiences to unknown MCP clients; Enterprise-Managed Authorization is the later candidate)
- [x] Mismatch error "This AI tool is logged in as someone other than the page." on the pairing page and the MCP endpoint
- [x] Configuration (`TAB_MCP_IDENTITY=oidc` and provider settings) with validation; docs and threat model update
- [x] Browser library: `identityAssertion` hook, `refreshIdentity()`, `signOut()`, no code in the dialog for `oidc`
- [x] Tests with a local OIDC provider fixture; end-to-end with the MCP SDK client
- [x] Security review of the PR (self-review; independent review by Claude and GLM on 2026-10-23: five findings, all fixed)

## Acceptance criteria

- With `TAB_MCP_IDENTITY=oidc`, an AI app signed in as the tab's user connects without a
  code; any other identity gets the mismatch error.
- Logout in the web app cuts the AI connection at once.
- `code` remains the default and unchanged.

# Citations

- [Identity binding design](/design/identity-binding.md)
- [Research needed](/research/identity-binding-research-needed.md)
