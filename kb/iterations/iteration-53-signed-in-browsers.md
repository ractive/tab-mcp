---
type: iteration
title: "Iteration 53: signed-in browsers, one connection for all of them"
status: planned
description: >-
  The tab-mcp browser extension can sign in at the relay with Google, GitHub or
  Microsoft (personal and Entra ID work accounts). Every browser signed in with the same
  account forms one group, and an AI app that signs in on the pairing page gets one
  grant for the whole group instead of one per browser. Calls go to the tab in front of
  the browser used last (default) or to a pinned tab; list_tabs, use_tab and an optional
  tab argument let the AI choose. Codes stay for everyone who does not sign in, and
  older extensions keep working with the new relay (owner, 2026-11-26).
timestamp: 2026-11-26T09:00:00+01:00
tags: [iteration, relay, extension, oauth, pairing, security]
---
# Iteration 53: signed-in browsers, one connection for all of them

The owner, 2026-11-25/26: two browsers (Chrome and Firefox), each with a personal and a
work profile, and the same again under a second macOS user: eight copies of the
extension, each its own page at the relay with its own pairing, so every AI app needs
eight connections and each is paired again every 90 days (DEC-062). And while an AI
app works on something, switching tabs today sends its next call to the tab that came to
the front (the extension works on the tab in front).

Decided in the conversation (DEC-229):

- **Sign-in instead of linking codes**: "nicer design". Google, GitHub and Microsoft.
- **Codes stay** for people who do not want to sign in: such a browser is on its own, as
  today.
- **No linking of accounts** across providers for now: a Google account and a GitHub
  account are two groups.
- **Backwards compatible** where it matters: older extensions keep working with the new
  relay, and existing addresses and grants stay; the new extension need not work with
  an older relay (details below).
- **Mode**: "the tab in front" (default) or "a pinned tab", one setting per group; the
  target changes on purpose, never as a side effect (the owner: "way better").
- **`list_tabs` and `use_tab`**, and an optional `tab` argument (the owner: "would be
  awesome").
- The owner registers the three OAuth apps.

## How it works

### Signing in a browser

- The panel offers "Sign in with Google / GitHub / Microsoft" when the relay's `session`
  message says sign-in is configured for this app (a relay without providers, such as a
  self-hosted one, offers codes only). The extension runs
  `identity.launchWebAuthFlow` (Chrome, Edge and Firefox have it) at a relay URL; the
  relay is the only OAuth client at the providers (it already is one for `oidc`,
  `src/oauth/oidc.ts`, variant 1 of [identity binding](/design/identity-binding.md)), and
  at the end it redirects to the extension's redirect URL
  (`https://<id>.chromiumapp.org/`, Firefox `https://<hash>.extensions.allizom.org/`).
- The relay binds the extension's address id to the identity key (below). The binding
  survives reconnects and restarts (the extension's secret persists); "Sign out" in the
  panel ends it. How long it lasts without a new sign-in: an open decision (90 days, as a
  grant, DEC-062, is the proposal).
- The relay stores a hash of the identity key, not the e-mail address. The e-mail address
  for "Signed in as …" stays in the extension.

### Identity keys per provider

| Provider | Protocol | Key | Notes |
|---|---|---|---|
| Google | OpenID Connect | `iss` + `sub` | as `oidc.ts` today |
| Microsoft | OpenID Connect, multi-tenant (`/common`) | `tid` + `oid` | the issuer names the tenant: check it as `https://login.microsoftonline.com/{tid}/v2.0` with the token's own `tid`; `sub` differs per app, `oid` does not. Personal and Entra ID work accounts. |
| GitHub | OAuth 2.0, no OpenID Connect | numeric `id` from `GET https://api.github.com/user` | a small module of its own in the relay (no ID token to verify): code for access token, one `GET /user`, the token discarded; the login name can change, so it is not the key |

Scopes: `openid email profile` (Microsoft, Google); none at GitHub, where `GET /user`
returns the public profile with the `id` without one. Nothing more.

One callback for every provider and both flows (a browser's sign-in, an AI app's):
`https://<relay>/authorize/callback`, as `oidc.ts` has it; the flow's `state` says which
provider and which sign-in it belongs to.

**Entra ID work accounts**: whether employees may consent is the company's setting. The
default for tenants allows consent only to apps of a verified publisher, so the relay's
Microsoft app needs publisher verification (Microsoft AI Cloud Partner Program
membership, free, and a verified domain such as ractive.ch); otherwise an admin of the
company grants consent once for everyone. Conditional Access applies as the company set
it.

### The group

- Every browser bound to the same identity key is a member of that group. A member has a
  label, "<browser> on <OS>" by default, which the user can rename in any panel ("work
  Chrome"); the extension cannot read the browser profile's name.
- Every panel shows the group: its members (online or not), the mode and the target. A
  new member is announced in every panel (a notice, and a notification). Any member can
  remove any other (its binding ends; it can sign in again, which is announced again).
- The relay sends the group's state (members, labels, mode, pin) to every member when it
  changes and when a member connects. A member never receives another member's tabs.

### Pairing an AI app

- The pairing page of an app whose site allows sign-in (the extension's app ids) shows
  the code field, as today, and "Sign in with Google / GitHub / Microsoft". A sign-in
  pairs the AI app with the group of that identity: one grant for the group (the token
  record names the group instead of an address id).
- A code still pairs with one browser, as today. A group grant and a page grant can
  exist side by side.

### Where a call goes

For a group grant, the relay picks the member; within the member, the extension picks
the tab:

1. A `tab` argument: the member and tab it names (ids from `list_tabs`). It always wins.
2. Mode "a pinned tab": the group's pin (a member and a tab in it). The first call
   without a pin pins the tab in front of the browser used last. `use_tab` and "Work
   here" in a panel set it. Switching tabs or browsers moves nothing.
3. Mode "the tab in front": the tab in front of the browser used last. In this mode
   only, each member tells the relay when one of its windows gains the focus (a message
   without URL or title; the relay stamps it with its own clock). In pinned mode the
   relay does not learn when the user switches browsers.

- The pinned tab closed, or its browser offline: the call fails with that reason and
  asks the AI to call `list_tabs`; nothing lands in a tab the user is using. In mode
  "the tab in front", an offline browser used last falls back to the most recent online
  one, and the result says so.
- Every result of a group grant names the member that answered ("work Chrome"), so the
  AI and the user see a change.
- `list_tabs`: the relay sends it to every online member and joins the answers, with ids
  of the form `<member>:<tab>`; it strips the member part before passing a `tab`
  argument on. Each member lists only its own tabs.
- `use_tab`: the relay sets the group's pin and passes the call to that member. In mode
  "the tab in front" it pins all the same (an explicit request does not fail on a
  setting the AI cannot see) and switches the group to pinned; every panel shows it.
- The `page_<name>` tools follow the mode (the tab in front, or the pin); they cannot
  take a `tab` argument, as it could clash with the page's own arguments. `webmcp_call`
  with `tab` reaches any tab.
- The extension's MCP server is stateless (MCP 2026-07-28): the relay knows the grant,
  not the conversation. The pin is therefore per group, shared by every conversation of
  every AI app; two conversations that work at once keep their own tabs by passing
  `tab`, which the tool descriptions ask for after `list_tabs` or `use_tab`.

### One browser without sign-in

A browser paired with a code gets the same tools for its own tabs: `list_tabs`,
`use_tab`, the `tab` argument, and the mode in its panel (stored in the extension). No
relay change is needed for that part.

### Waiting before the switches take clicks

Everything a page can time stays guarded as today (ES 5, DEC-228): a new member, a
change of the target or of the mode shown in a panel moves its layout, so the controls
there wait as after any other change.

## Backwards compatibility

- **Older extensions with the new relay** (owner, 2026-11-26): the store copies update
  on their own schedule, so the relay keeps serving today's extensions unchanged. The
  protocol only gains messages (sign-in, group state, focus, a tool call to several
  members), which an older extension never sends and never receives: the relay sends
  them only to an extension that announced them in its `hello`.
- **The new extension with an older relay: not supported** (owner, 2026-11-26). The
  extension of this iteration may require a relay of this iteration; the hosted relay is
  deployed before the extension's store release.
- **Addresses and grants**: `/s/tab-mcp-extension/mcp` and
  `/s/tab-mcp-extension-firefox/mcp` stay; every existing grant, token and refresh keeps
  working; the token store gains a group column, existing rows mean "page grant".
- **Pages with the client library**: their pairing methods (`code`, `oidc` with the web
  app's assertions, DEC-075 to DEC-079) are unchanged.
- **Tools**: `list_tabs`, `use_tab` and the `tab` argument are additions; with mode "the
  tab in front" (the default) a call without `tab` goes where it goes today.
- **Two Chrome-family app ids remain one group** when signed in with one account: the
  group is the identity, not the app id. Firefox (`tab-mcp-extension-firefox`) and
  Chrome (`tab-mcp-extension`) members are in the same group.

## Tasks

### Relay

- [ ] Several sign-in providers per relay (config: one entry per provider, client id
      and secret from the environment); Google and Microsoft through the OIDC code of
      `oidc.ts`, Microsoft's issuer checked per tenant
- [ ] GitHub adapter: OAuth 2.0 code flow with PKCE where GitHub supports it, `state`,
      then `GET /user` for the numeric id
- [ ] Binding of an address id to an identity key (hash), with sign-out, removal by
      another member, and its lifetime
- [ ] Groups: members, labels, mode, pin; group state to every member
- [ ] Pairing page: sign-in buttons next to the code field for sign-in sites; group
      grants in the token store (schema step, existing rows stay page grants)
- [ ] Routing of a group grant's calls: `tab` argument, pin, last focused member;
      `list_tabs` fanned out and joined; `use_tab` sets the pin; the member named in
      every result; offline and closed cases
- [ ] Focus messages only in mode "the tab in front"
- [ ] Limits: members per group, sign-ins per network, focus messages per member

### Extension

- [ ] Panel: sign in / sign out, "Signed in as …", the group's members with rename and
      remove, the mode, the target line ("AI apps work in: work Chrome › Shop
      (pinned)"), "Work here"
- [ ] `identity.launchWebAuthFlow` at the relay; the `identity` permission (Chrome,
      Firefox), and what the store listings and privacy pages say about it
- [ ] `list_tabs`, `use_tab`, the `tab` argument on `page_info`, `webmcp_tools`,
      `webmcp_call`, `navigate`, `go_back`, `go_forward`, `reload`; the pin and the
      mode for a browser without sign-in
- [ ] Focus messages (`windows.onFocusChanged`) while the group's mode asks for them
- [ ] Notice and notification when a member joins

### Docs and records

- [ ] Threat model: an account taken over reaches the group's browsers; a member is a
      man in the middle of the group's calls (it can set the pin or claim the focus, see
      their arguments, answer falsely), never a caller; the relay learns focus changes
      in mode "the tab in front"; identity hashes in the store
- [ ] `docs/protocol.md`: the new messages; the extension's README and the store texts
- [ ] Privacy pages of the extension (Chrome, Edge, Firefox): sign-in, what the relay
      keeps

### The owner

- [ ] Register the relay's OAuth app at Google, GitHub and Microsoft, each with the
      callback `https://tab-mcp.ractive.ch/authorize/callback`. GitHub: an OAuth App
      without scopes (a GitHub App without permissions works too). Microsoft:
      multi-tenant, personal and work accounts; publisher verification for Entra ID
      work accounts. Client ids and secrets through tofu and the keychain, never in git
- [ ] Try a sign-in with the work Entra ID account once the app exists

Done or known so far (2026-11-26):

- **GitHub**: OAuth App "tab-mcp relay", client id `Ov23litK0ROOKaHzH01W` (not
  secret; into `variables.tf` as `tab_mcp_relay_github_client_id`). Its secret goes into
  the Keychain item `ractive-ch-tab-mcp-github-client-secret`, and for CI plans into
  the ractive.ch repository secret `TAB_MCP_RELAY_GITHUB_CLIENT_SECRET`, as the Google
  one (`TAB_MCP_RELAY_GOOGLE_CLIENT_SECRET`).
- **Google**: the relay's existing client from identity binding is reused
  (`tab_mcp_relay_google_client_id` in ractive.ch's `infra/tab-mcp/variables.tf`, a web
  application with the callback above; secret in `ractive-ch-tab-mcp-google-client-secret`).
  Its consent screen must be "In production", not "Testing" (testing allows only listed
  test users), and its app name should be what browsers' users recognise
  ("tab-mcp relay").
- **Logos**: the relay's icon (`packages/tab-mcp/scripts/favicon.svg`) as PNG, 512, 240
  and 120 px, for GitHub, Microsoft and Google.
- The Keychain cannot be written from an agent's shell on this Mac ("User interaction is
  not allowed"): the owner adds items in a terminal of their own.

## Open decisions

- How long a browser's sign-in lasts without a new one (proposal: 90 days, DEC-062).
- Whether an AI app's sign-in on the pairing page should also be offered to apps whose
  pages use the client library (their sites have their own `oidc`); proposal: only the
  extension's app ids in this iteration.
- Members per group (proposal: 16).

# Citations

- [Chrome: chrome.identity.launchWebAuthFlow](https://developer.chrome.com/docs/extensions/reference/api/identity#method-launchWebAuthFlow)
- [MDN: identity.launchWebAuthFlow](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity/launchWebAuthFlow)
- [Microsoft identity platform: ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)
- [Microsoft: publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview)
- [Microsoft: configure how users consent to applications](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent)
- [GitHub: authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [Identity binding](/design/identity-binding.md)
- [Threat model](/design/threat-model.md)
- [Decision log](/decision-log.md)
