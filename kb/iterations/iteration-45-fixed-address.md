---
type: iteration
title: "Iteration 45: one fixed address per app"
status: in-progress
description: >-
  The MCP address no longer names the tab: every page of an app gets
  https://<relay>/s/<app>/mcp, the pairing code alone selects the tab, and the access
  token routes the tool calls. For organisations whose Claude admin can only allow one
  exact connector URL (owner, 2026-11-19). The code grows to 8 letters, guess limits are
  per network, the token record carries the app, the pairing page gets hooks an
  extension can fill in, and running several instances is dropped. No backwards
  compatibility: /a/{id}/mcp, the 6-digit code and existing pairings are gone.
timestamp: 2026-11-19T12:00:00+01:00
tags: [iteration, relay, client, oauth, pairing, security]
---
# Iteration 45: one fixed address per app

The owner gave Sitegloss to a colleague whose company does not let members add custom
connectors to Claude. An Owner can add one for the organisation, but only by one exact
URL (no pattern), and every member then signs in to it by themselves
([add a custom connector](https://claude.com/docs/connectors/custom/add-unlisted),
read 2026-11-19). An address that names the tab (`/a/{id}/mcp`, DEC-027) cannot be
allowed that way. Request headers exist there too (beta), but as one credential for the
whole organisation, so the per-user part has to be the OAuth sign-in, which the relay
already has. Owner, 2026-11-19: "Let's do it. No backwards compatibility. We can start
fresh." Branch `relay/fixed-address`.

## What changes (DEC-196 to DEC-199)

- **Address** `https://<relay>/s/<app>/mcp`. `<app>` is the app id: 1 to 32 characters
  of `a-z`, `0-9` and `-`, not starting or ending with `-`. The page names it in
  `hello.app.id`; the library derives it from `server.name` (lower case, every run of
  other characters becomes `-`), which already decides the address secret's storage key.
  The relay's site list cannot name it: Firefox gives every installation its own
  origin, and one origin can run several apps (the examples on ractive.ch).
- **The address secret stays**, and the address id is of the app and the secret
  together (`base32(sha256(app + "\n" + secret))`): it still keys the session and the
  grants, and is no longer part of any URL. The same secret under another app is
  another page.
- **Pairing**: `/authorize` gets the app's address as `resource` and always shows the
  form. The typed code finds the session among the app's pages that are pairing; the
  grant is bound to that session's address id as before.
- **Tool calls**: bearer token → token record → address id → session. The record
  carries the app, and a token is refused at another app's address.
- **Code**: 8 letters of `BCDFGHJKLMNPQRSTVWXZ` (RFC 8628 §6.1), shown `XXXX-XXXX`,
  typed in any case with or without the dash; unique among the relay's live codes;
  2 minutes; single use. No attempts per code and no `locked`: a wrong guess does not
  belong to a code any more. Wrong guesses are limited per network (10, then 1 a
  minute).
- **Open requests** are capped per network (the eleventh pushes out the network's own
  oldest) and in all, no longer per address.
- **Identity binding** (`oidc`): the sign-in comes first; the session is the app's page
  whose user is the signed-in person and whose dialog is open.
- **Sites may reserve apps** (`sites[].apps`): a listed app id is served only by the
  origins that list it. What the page shows before a code is typed comes from the
  relay's configuration, never from a page.
- **The pairing form has hooks** for an extension in the same browser to fill in the
  code after asking its user: `data-tab-mcp-pairing="1"`, `data-client-name`,
  `data-client-host`, `data-app` on the form, `data-tab-mcp-field="code"` on the field,
  `data-tab-mcp-action="connect"` on the button. Typing the code stays the way that
  always works (another browser, another device).
- **Several instances are no longer supported** (DEC-098 withdrawn): a typed code
  cannot be routed to the instance that holds its tab. `/tab?a=`, close code 4009,
  `address_mismatch` and the address id in front of the authorization code and the
  OIDC state go.

## Tasks

### Relay

- [x] `config.ts`: app id rule, `sites[].apps`, which pairing methods an app can have
- [x] `protocol.ts`, `session.ts`: `hello.app.id` required, checked against the site's
  apps; `session.address` is the app's; no `?a=`, no 4009
- [x] `pairing.ts`: 8-letter codes, one index of live codes, no attempts, no `locked`
- [x] `oauth/server.ts`: `resource` is an app's address; requests without an address
  until paired; guesses per network; hooks on the form; `oidc` by identity
- [x] `relay.ts`: routes `/s/:app/mcp` and its protected-resource metadata; the token's
  address; `WWW-Authenticate` per app
- [x] Token store: `TokenRecord.app` (memory, SQLite schema, conformance suite, docs)
- [x] Tests

### Client library

- [x] `hello.app.id` from `server.name`; no `?a=`; code shown as `XXXX-XXXX`; texts
- [x] Tests, stub relay

### Extension, e2e, docs

- [x] tab-mcp browser extension: whatever shows the address or the code
- [x] `test/e2e`
- [x] `docs/` (protocol, connecting, configuration, self-hosting, threat model, token
  store), READMEs, `kb/design` (architecture, threat model, identity binding), decision
  log

### After the release (other repositories)

- [x] ractive.ch: relay deploy with `apps` for the sites, examples on the new client
  (2026-11-19 and 20: relay 0.12.1; examples, sign-in and saturnus on client 0.18.1;
  only `sign-in` is reserved so far)
- [x] Reserve the other apps on the hosted relay: `todo`, `diagram` and `saturnus` for
  ractive.ch, `comparis-the-game` for the game's origin, the extension's ids
  (`TAB_MCP_SITES` in ractive.ch `infra/tab-mcp/container.tf`; all reserved, checked
  2026-11-21)
- [x] The relay's code field no longer invites password managers (relay 0.12.1, pull
  request 166): the owner confirmed on 2026-11-21 that Enpass's button is gone
- [ ] tab-mcp browser extension: a store release; the published copies have the old
  client and cannot connect (2026-11-21: 0.3.1 is tagged and built, its publish to the
  Chrome Web Store and Edge Add-ons waits for the owner's approval; 0.3.0 was never
  published and must not be, see its changelog)
- [ ] The comparis game: client 0.18.1 (its own session, in the owner's other account)
- [x] Sitegloss: new client; the extension fills in the code on the relay's pairing
  page after "Connect <app>?" in the side panel (optional access to the relay's
  origin, asked on "Turn on AI access") (it uses the library's filler,
  `@ractive-ch/tab-mcp-client/extension`, DEC-206; owner, 2026-11-21)

## Residual risks to record in the threat model

- The code is the only thing that selects a tab. With N pairing dialogs open, one
  network's 1 450 guesses a day hit one of them with probability N × 5.7 × 10⁻⁸.
- A user who reads their code out to someone gives that person's AI app access; before,
  the address was needed too. Identity binding is the cure where a site has it.
- Where an app is not reserved, any origin the relay allows can serve it.
- A tab assertion's audience is the app's address, so it no longer names one page.
- With identity binding, a link with someone else's client, one click on Connect and a
  silent single sign-on pair that client with the user's page while its dialog is open.
- Everyone behind one address shares its guess limit and its ten open requests.

## Found by the reviews of the first version

Four agents moved the tests under a brief that forbade changes to the source and asked
for what looked wrong. What they found, and what was done:

- A token's app was compared with the URL only; a page with the same secret under
  another app took over the session and the calls (three agents, independently). The
  address id is now of the app and the secret together.
- A sign-in that paired stayed charged as a guess: the eleventh person of an office got
  429. It is given back when it pairs.
- Old tokens stayed listed as connected apps after the store's step to schema 6. The
  step deletes them.
- A network's eleventh open request was refused for ten minutes. It now pushes out that
  network's own oldest.
- The relay-wide eviction did not pick the oldest request among equals, as its comment
  said. It does now.
- The pairing page of an app that pairs by sign-in only spoke of a code; the dialog
  asked for a code after "Disconnect all apps" with identity binding; the library took
  a non-string `app`. All three fixed.
- `tokenFor` could no longer serve a relay in another process: it takes a token store
  with the page's secret too.
- Not changed: `appIdOf` turns letters without a decomposition into `-` ("Straße" →
  `stra-e`); set `app` for such names.

# Citations

- [Claude: add a custom connector](https://claude.com/docs/connectors/custom/add-unlisted)
- [Claude: custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
- [RFC 8628, OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628) (§6.1 user codes, §5.1 brute force, §5.4 remote phishing)
- [Decision log](/decision-log.md), DEC-196 to DEC-199
