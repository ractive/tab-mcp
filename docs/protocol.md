# Tab–relay protocol, `tab-mcp.v1`

This is the WebSocket protocol between a web page (the *tab*) and a tab-mcp relay. The
browser library `@ractive-ch/tab-mcp-client` implements the tab side; the relay
`@ractive-ch/tab-mcp` implements the other. Read this if you write your own tab
implementation or want to know what passes over the connection.

The protocol tunnels the AI app's MCP HTTP requests to the tab and the tab's HTTP
responses back. It also carries the session's control messages: pairing, connected apps,
the heartbeat and, for a browser extension that asks for it, its sign-in and its group.
It knows nothing about MCP tools, except for a group grant's requests, of which it reads
the method, the tool name and its `tab` argument ([Group grants](#group-grants)). The tab runs the MCP server itself
(MCP revision 2026-07-28, stateless); the relay authenticates AI apps and forwards their
requests.

```text
AI app ──HTTPS POST /s/{app}/mcp──▶ relay ──WebSocket /tab (tab-mcp.v1)──▶ page
       ◀──JSON or event stream────        ◀──http.response* messages─────
```

## Connection

- URL: `wss://<relay>/tab`. Query parameters are ignored.
- The relay checks the `Origin` header against its allow-list first (empty by default).
  An origin that is not on it gets HTTP 403 with `{"error":"origin_not_allowed"}` and no
  upgrade.
- Version negotiation: the tab offers the WebSocket subprotocol `tab-mcp.v1`
  (`Sec-WebSocket-Protocol`). The relay accepts it, or refuses the upgrade with HTTP 426
  and `{"error":"unsupported_protocol","supported":["tab-mcp.v1"]}`. A future
  `tab-mcp.v2` will be offered alongside v1 during a transition.
- Too many sessions in total or from one client IP: HTTP 429 with
  `{"error":"too_many_sessions"}`.
- Frames are UTF-8 text, one JSON object each, with a string `type`. Binary frames are a
  protocol error.
- Unknown `type` values from the peer are ignored, for forward compatibility. If such a
  message from the tab carries an `id` that expects an answer, the relay answers with
  `error` code `unknown_type`. The library drops an unknown or malformed message from the
  relay without an answer.
- A session begins only after a user action in the page. The library opens the WebSocket
  only from `connect()`, which pages call from a click handler.
- The tab must send `hello` within 10 seconds of the open, or the relay closes with 1008.

## Message types

T→R is tab to relay, R→T is relay to tab.

### Session

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `hello` | T→R | `library: {name, version}`, `app: {id, name?}`, `secret`, `revokeAll?`, `capabilities?` | First message after the open. `app.id` names the app whose address the page serves, `https://<relay>/s/<app.id>/mcp` (see [the app id](#session)): 1 to 32 characters of `a-z`, `0-9` and `-`, not starting or ending with `-`. A `hello` without it (libraries before 0.17 send none) gets `bad_message` and close 1008. If the relay's configuration does not let the page's origin serve that app ([`sites[].apps`](configuration.md#sites)), the relay answers `error` `app_not_allowed` and closes with 1008; no session opens, and no open session is replaced. The relay ignores a `page` field, which libraries before 0.17 sent. `app.name` (for example `saturnus`) must be 1-64 characters without control characters, else `bad_message` and close 1008. It is the page's own claim, a name for people; the relay uses it in its ["the page is not open"](#when-the-page-is-not-open) answers unless the relay configures a name for the site. The relay removes bidi, zero-width and other invisible characters from it, and ignores a name that is empty then or names a domain other than the page origin's host (`session` then has no `appName`). Any dotted word that ends in two or more letters counts as a domain, as in AI apps' names (DEC-092): "Node.js tools" on `https://example.com` is ignored; a page that wants such a name configures it as the site's `name`. `revokeAll: true` takes the page's address id back after a takeover (DEC-095): the relay claims the address id for this session and revokes every grant of it before it lists the grants for `session`, whatever session claims it next, and `session` then lists none, which confirms it. A store error ends the session with 1008 instead. Anything but a boolean is `bad_message`. Only a holder of the secret can send it, and it could send `grants.revokeAll` anyway. Relays 0.4 and older ignore the field and list the grants: the library then closes the connection and `disconnectAll()` rejects (DEC-136). `capabilities` lists what the tab understands beyond the messages of this document's other sections: at most 16 names of 1 to 32 characters of `a-z`, `0-9`, `.` and `-`, starting with a letter or digit; anything else is `bad_message` and close 1008. The relay ignores names it does not know. The one name so far is `signin.v1` ([Browser sign-in](#browser-sign-in)). A tab that sends no list, or a list without a name, gets none of the messages that name brings, and the relay answers it as a relay without them would. A name stands for one form of its messages; an incompatible change gets a new name (`signin.v2`), and a tab may offer both during a transition. |
| `session` | R→T | `sessionId`, `address`, `origin`, `appName?`, `pairing`, `expiresAt`, `limits`, `grants`, `signIn?` | The session exists. `address` is the MCP URL the user gives to the AI app: the app's, `https://<relay>/s/<app.id>/mcp`, the same for every page of the app. `pairing` is `code` or `oidc` (identity binding). `signIn` only for a tab that named `signin.v1` and whose app may sign in ([Browser sign-in](#browser-sign-in)). |
| `ping` | R→T | `t` | Heartbeat, every `limits.heartbeatMs`. |
| `pong` | T→R | `t` | Answer to `ping` with the same `t`. |
| `bye` | both | `reason` | Orderly end; the sender closes the socket after it. Reasons from the relay: `replaced`, `expired`, `idle`, `shutdown`. |

**The app id.** `app.id` is the page's own word for which app it is, and the `<app>` of
its address `https://<relay>/s/<app>/mcp`. Every page of an app has that one address, so
the address names no tab; which page an AI app talks to is decided when it pairs (see
[Pairing and grants](#pairing-and-grants)). The library takes the id from its `app`
option, or derives it from the server name: lower case, letters without their marks,
each run of other characters as one `-`, at most 32 characters. An app that no site of
the relay's configuration lists may be served by any origin the relay allows.

**The address secret.** `secret` is what makes a page the same page across sessions. It
is 32 random bytes as base64url without padding (43 characters), kept by the library in
the page's `localStorage` under `tab-mcp:secret:<relay origin>:<server name>`. The relay
derives the address id from the app id and the secret together, as
`base32(sha256(app.id + "\n" + secret))`: SHA-256 over the UTF-8 text of the app id, a
line feed and the secret, RFC 4648 base32, lower case, no padding, 52 characters.
Sessions, grants and tokens are keyed by the address id, so the relay stores nothing to
recognise a page, and a page that connects again with its secret and its app id has its
grants again. A page is one pair of secret and app: the same secret under another app id
is another page, with its own session and none of the first one's grants, and it does
not replace the first. The address id is part of no URL; the relay's logs name it by its
first 8 characters. A `hello` without a well-formed `secret` gets `error` `bad_message`
and close 1008.

If a session with the same address id is already connected, the new one replaces it: the
old tab gets `bye` with reason `replaced` and close 4005.

**The session message.** `sessionId` is a fresh random id per WebSocket. It appears only
in logs and in this protocol, never in URLs. `origin` is the page origin the relay saw on
the upgrade. On an open relay (`TAB_MCP_ALLOWED_ORIGINS=*`) only a serialised web origin
(`https://host[:port]`, as browsers send it) or a browser extension's origin of at most
255 characters is kept; anything else is `""`, as for a client that sends no `Origin`.
`appName` is the name the relay uses for the page in "the page is not open" answers: the
site's configured name, else the page's `app.name`, absent if neither exists. `pairing`
says how AI apps pair with this page: `code` (the tab shows codes) or `oidc` (the same
sign-in, see [Identity binding](#identity-binding)). `grants` lists the AI apps already
connected to this page, that is, the grants of its address id (see below).

`limits` carries `maxMessageBytes`, `maxBodyBytes`, `requestTimeoutMs`, `idleTimeoutMs`,
`heartbeatMs`, `keepAliveMs` and `maxConcurrentRequests`, so the tab can show and respect
them. `maxMessageBytes` is at least 16 384. The library sends a tool result whose
response would exceed `maxBodyBytes` as an error result that gives both sizes instead,
so that the AI app does not read a transport error (`-31006`) for a tool that ran.

```json
{"type":"session","sessionId":"s_6Gx…","origin":"https://ractive.ch","pairing":"code",
 "address":"https://relay.ractive.ch/s/saturnus/mcp",
 "expiresAt":"2026-10-20T08:00:00.000Z","grants":[],
 "limits":{"maxMessageBytes":1048576,"maxBodyBytes":1048576,"requestTimeoutMs":300000,
           "idleTimeoutMs":3600000,"heartbeatMs":25000,"keepAliveMs":20000,
           "maxConcurrentRequests":8}}
```

### Pairing and grants

Pairing works like signing in on a TV: the tab shows a code, and the user types it on the
relay's `/authorize` page when the AI app opens it. The address the AI app was given
names the app; the code selects the page among the app's pages, and the grant is made
for that page's address id.

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `pairing.start` | T→R | none | The page's "Connect your AI app" dialog is open; the relay starts issuing codes (only on sites whose pairing method is `code`). Sent again while codes are on, it repeats the current code. With `oidc` it marks the dialog as open for 10 minutes from now and answers `pairing.open`: a sign-in pairs the page only while that time lasts (DEC-202). Sent again, also after the time is up, it counts 10 minutes from then; a session that ends, or `pairing.stop`, ends it. The relay cannot tell why a page sends it: libraries from 0.19 on send it on an `oidc` session only when their user opens the dialog, continues or connects with a click, never by a timer or on a reconnect they make by themselves; libraries before 0.19 also send it after every reconnect, so with them each reconnect starts the 10 minutes again. |
| `pairing.code` | R→T | `code`, `expiresAt`, optional `reason` | The code to show: 8 letters of `BCDFGHJKLMNPQRSTVWXZ`, sent as `XXXX-XXXX`; single-use, valid 2 minutes, and no two pages of the relay show the same code at once. A fresh one follows by itself after expiry or use while pairing is on. `/authorize` takes it in any case, with or without the dash and spaces. A code counts only at the address of its page's app; typed at another app's address it is a wrong code and stays valid. Wrong codes are limited per network (10, then one a minute), not per code or page; input that is not 8 of these letters does not count. `reason` says why this code comes: `start` (after `pairing.start`, a new code or the current one again), `used` (the last code was entered; its AI app is about to finish pairing) or `expired`. A tab treats a missing or unknown `reason` as no reason given. |
| `pairing.open` | R→T | `expiresAt`, `expiresInMs` | From relay 0.13 on, to sites with `oidc` only: the answer to each `pairing.start`. For `expiresInMs` (600 000, 10 minutes) from now, until `expiresAt` on the relay's clock (ISO time), a sign-in of the page's user pairs this page; a sign-in that comes back later gets the answer that no page is connecting, as for a closed dialog. Nothing is sent when the time is up: the page counts `expiresInMs` on its own clock from the message's arrival (its clock may differ from the relay's; the library takes `expiresAt` only when `expiresInMs` is missing or not a number from 0 to 2 147 483 647), shows the end, and offers to continue, which sends `pairing.start` again. Libraries before 0.19 ignore the message (an unknown type) and re-send `pairing.start` after every reconnect, so for their pages the limit holds only between reconnects; it is complete with a library from 0.19 on. |
| `pairing.stop` | T→R | none | The dialog closed; the current code becomes invalid and no more codes come. |
| `grant.added` | R→T | `grant` | An AI app finished pairing (the token endpoint issued its first tokens). |
| `grant.revoke` | T→R | `grantId` | The user pressed Disconnect for one app; its tokens stop working at once. A grant that does not belong to this page's address id, or has expired, gets `error` `unknown_id` with `for` and `grantId` ([Errors](#errors-between-tab-and-relay)). |
| `grants.revokeAll` | T→R | none | Revoke every grant of this page's address id. |
| `grant.removed` | R→T | `grantId`, `reason` | A grant ended: `revoked` (Disconnect, `/revoke`, "Disconnect all apps", sign-out, another user signed in to the page) or `reuse_detected` (an authorization code or refresh token was presented twice). `expired`: the grant has no usable token left (not refreshed in time, or at the latest 90 days after pairing); the relay's sweep (every 10 minutes) tells each connected page of its grants that no longer have a usable token, so it comes up to that long after the last token ran out (relays before the third 0.10 release did not announce it). The grant's requests in flight on this session, listen streams included, end with it: the AI app gets `-31009` (HTTP 401, or an error event on a stream already open) and the page gets `http.cancel` for each. |

A grant as the tab sees it:

```json
{"grantId":"g_…","client":{"id":"https://claude.ai/oauth/claude-code-client-metadata",
 "name":"Claude Code","host":"claude.ai"},"createdAt":"2026-10-19T20:00:00.000Z"}
```

`client.name` is what the AI app declares in its Client ID Metadata Document, cleaned (no
control, format or bidi characters, at most 64 characters). `client.host`, the host of the
verified `client_id` URL, is the verified part. Codes are never logged. A session that
ends, for any reason, stops its codes; grants stay.

### Identity binding

On a site with `pairing: "oidc"`, the relay pairs an AI app only with the person who is
signed in to the page, proved by the web app's backend
([configuration](configuration.md#identity-binding)).

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `identity` | T→R | `assertion`, `round?` | A tab assertion for the page's signed-in user: a JWT of at most 8 192 bytes, `typ` `tab-mcp-identity+jwt`, `aud` this session's `address` (the app's address, so the assertion names the app and not one page), `exp` at most 60 s ahead, a single-use `jti`. Sent after `session` (every connection) and again after a sign-in. `round` (a non-negative integer) is the page's number for this assertion; the answer echoes it. |
| `identity.bound` | R→T | `round?` | The assertion was accepted; the session is bound to this person. `round` is the one of the `identity` it answers, when that had one. |
| `identity.logout` | T→R | none | The page's user signed out: the relay revokes every grant of the page's address id (`grant.removed` for each), ends their requests in flight (`-31009`) and forgets the binding. A store failure is answered with `error` `store_unavailable`. |

The relay handles `identity` and `identity.logout` one after another, in the order they
came, and answers every `identity` exactly once. A refused assertion gets `error`
`identity_refused` with the reason in `message`, a fixed text per reason (and the `round`); the session stays, and the
binding it had ends (fail closed), with its requests in flight. Grants made by identity
binding remember the person (as a hash of issuer and subject). An MCP request on such a
grant, or any request on an `oidc` site, reaches the page only while it is bound to the
same person; another person gets HTTP 401 `invalid_token` with "This AI app is signed
in as someone other than the page's user.", and a page that is open but not signed in is waited
for like a closed page (below), then answered with "The page is open, but nobody is
signed in to it. …". When the page proves another person than before, the relay revokes
the grants of the previous one and ends their requests in flight.

### Browser sign-in

From relay 0.14 on (DEC-231): a browser extension can sign in at the relay with an
account at Google, Microsoft or GitHub. Every browser signed in with the same account is
a member of that account's *group*. This section is the relay's side: it binds the
session's address id to the account and keeps the group's members informed. An AI app
connected to the whole group, and where its calls go, is the next section,
[Group grants](#group-grants).

Only a session whose `hello` named `signin.v1` in `capabilities`, and whose app the
relay lets sign in (`TAB_MCP_SIGN_IN_APPS`, [configuration](configuration.md#browser-sign-in)),
gets any message of this section and the next, and only for it are `signin.*`,
`member.*`, `group.*` and `focus` messages. For every other session they are unknown types (`unknown_type` when they carry
an `id`, else ignored), and its `session` has no `signIn`: it is answered byte for byte
as by a relay without sign-in.

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `session` | R→T | `signIn: {providers, member?}` | `providers`: the providers this relay offers, in the order to show them, each `{id, name}` (`google` "Google", `microsoft` "Microsoft", `github` "GitHub"). `member`: this browser's member id while it is signed in; a `group` message follows the `session`. Without `member` the browser is not signed in (or the relay could not read its sign-in, logged as `store.error`; it then counts as signed out until it connects again). |
| `signin.start` | T→R | `provider`, `redirectUrl`, `label?` | Start a sign-in. `redirectUrl` is the extension's `identity.getRedirectURL()` without a path, and must be its own: `https://<extension id>.chromiumapp.org/` for a page of `chrome-extension://<extension id>` (Chrome, Edge), `https://<40 hex digits>.extensions.allizom.org/` for a page of `moz-extension://` (Firefox). `label` (1-64 characters, cleaned of invisible characters) names the browser in its group, e.g. "Chrome on macOS"; default "Browser". A new `signin.start` ends the session's open sign-in. Answered with `signin.url` or `signin.failed`. |
| `signin.url` | R→T | `provider`, `url`, `expiresAt` | The URL to open with `identity.launchWebAuthFlow` (interactive): the relay's own, `https://<relay>/signin?flow=…`. It works once, until `expiresAt` (10 minutes). |
| `signin.complete` | T→R | `code` | The completion code from the redirect URL that ended `launchWebAuthFlow` (`redirectUrl?signin=<code>`). Only now does the relay bind: the code must come from a sign-in this same session started, be unused and at most 2 minutes old. Any use spends it. Answered with `signin.done`, or `signin.failed` (`code_refused`, `group_full`, `store_unavailable`). |
| `signin.done` | R→T | `provider`, `displayName`, `kind?`, `member` | The browser is signed in. `displayName` is what to show as "Signed in as …": Google's `email`, Microsoft's `preferred_username`, GitHub's login. `kind`, for Microsoft only: `personal` (the token's `tid` is the consumer tenant `9188040d-6c67-4c5b-b112-36a304b66dad`) or `work` (work or school). One address can name both a personal account and a work account; they are two accounts and two groups, with the same `displayName`, so a tab shows the kind beside the name. The relay keeps neither and sends them only here; the tab keeps them if it wants to show them later. `member` is this browser's member id. A `group` message follows. |
| `signin.failed` | R→T | `provider?`, `reason`, `message` | The sign-in did not happen. `reason`: `not_offered` (no such provider here), `bad_redirect` (the redirect URL is not the extension's, or the page is no extension), `rate_limited`, `busy` (too many sign-ins open on the relay), `provider_unavailable` (its metadata cannot be fetched), `code_refused` (a `signin.complete` whose code is unknown, used, expired or another session's), `group_full` (the account has 16 browsers), `store_unavailable`. `message` is a fixed text per reason. A binding the browser had stays. What goes wrong between the relay's URL and the redirect back is not sent here: it comes back in the redirect URL (below). |
| `signin.out` | T→R | none | Sign out: the binding ends. Answered with `signin.ended` `signed_out` (also when the browser was not signed in), or `error` `store_unavailable` with `for: "signin.out"`, the binding then kept. |
| `signin.ended` | R→T | `reason` | The browser is no longer signed in: `signed_out` (its own `signin.out`), `removed` (another member removed it), `expired` (90 days after its sign-in). It may sign in again. |
| `group` | R→T | `provider`, `self`, `expiresAt`, `maxMembers`, `members`, `mode`, `pin?`, `focus?`, `grants` | The group's state: to every online member when a member joins, leaves, is renamed, connects or goes offline, when the mode, the pin, the member calls go to or the group's grants change, and to a member when it connects. `self` is this browser's member id, `expiresAt` when its sign-in ends unless it signs in again, `maxMembers` 16. `members`, oldest sign-in first, this browser included: `{id, label, online, signedInAt}`. A member id is random (`m_…`, `m_` and 16 characters of `A-Z`, `a-z`, `0-9`, `-`, `_`) and tells nothing about the address id. `mode`, `pin`, `focus` and `grants` (relay 0.14 on, DEC-232): see [Group grants](#group-grants). A tab ignores fields it does not know: later relays add some. |
| `member.rename` | T→R | `member`, `label` | Rename a member of this browser's group, itself or another (1-64 characters, cleaned; nothing visible left is `bad_message`). Every member then gets `group`. |
| `member.remove` | T→R | `member` | Remove a member of this browser's group: its binding ends and, if it is online, it gets `signin.ended` `removed`; every member left gets `group`. Removing itself is `signin.out`. |

A `member.rename` or `member.remove` for a member that is not in this browser's group,
or from a browser that is not signed in, gets `error` `unknown_id` with `for` and
`member`; a store failure gets `store_unavailable` the same way. The relay handles a
session's sign-in and group messages one after another, in the order they came. They
count against the control budget like every other message, except `focus`, which has a
budget of its own ([Group grants](#group-grants)).

**The flow.** The relay is the only OAuth client at the providers.

1. The extension sends `signin.start`; the relay answers `signin.url`.
2. The extension opens the URL with `identity.launchWebAuthFlow`. The relay sets a
   cookie for this sign-in (`HttpOnly`, `SameSite=Lax`, at most 10 minutes) and sends
   the browser to the provider: OpenID Connect for Google (scopes `openid email`) and
   Microsoft (the multi-tenant `common` endpoint, scopes `openid profile`), OAuth 2.0
   for GitHub (an OAuth App, no scope), always with PKCE S256 and a `state`, and with a
   `nonce` for OpenID Connect. The `state` of a browser's sign-in starts with
   `browser.` and names the provider; on the one callback
   `https://<relay>/authorize/callback` the relay tells its sign-ins from identity
   binding's by it. Opened from another network than the session's (the relay's
   network key of the address, an IPv6 /56), the URL first shows a page of the relay:
   it names the browser's `label` and the app, says "Only continue if you started this
   yourself in the tab-mcp panel of that browser." and warns never to paste or send the
   address one lands on afterwards to anyone. Its Continue (a form post with the page's
   single-use token and the sign-in's cookie) goes on to the provider; Cancel ends the
   sign-in and sends the browser to `redirectUrl?signin_error=cancelled`. Opened from the
   same network, the URL goes straight to the provider.
3. The provider sends the browser back. The relay checks the cookie (without it: an
   error page, and no redirect), redeems the code and checks the account: the ID token
   as for identity binding (signature, `iss`, `aud`, `azp`, `exp`, `iat`, `nonce`;
   Microsoft's `iss` must be `https://login.microsoftonline.com/{tid}/v2.0` with the
   token's own `tid`), or for GitHub one `GET https://api.github.com/user` with the
   access token, which the relay then drops. It binds nothing yet and sends nothing to
   the session.
4. The relay sends the browser to `redirectUrl?signin=<code>`: a random completion
   code, single use, valid 2 minutes, for this sign-in and its session. On a failure it
   sends `redirectUrl?signin_error=<reason>` instead: `provider_error` (the provider
   sent no code: cancelled, refused), `admin_approval` (Microsoft refused because the
   account's organisation must approve the relay first: AADSTS65001, AADSTS90094 or
   AADSTS90095 in the callback's `error_description` or in the token endpoint's
   `error_description` or `error_codes`; relay 0.14 on, DEC-232), `unchecked` (the code
   or the account did not check out), `session_gone` (the session that started the sign-in is gone, or another
   session of its address replaced it; nothing is redeemed then), `cancelled` (Cancel
   on the relay's page). Either URL ends `launchWebAuthFlow`. The provider's own
   description is never passed on; a tab shows its own text for each reason.
5. The extension sends `signin.complete` with the code. The relay binds the session's
   address id to the account and sends `signin.done` and `group`.

The redirect URLs (`*.chromiumapp.org`, `*.extensions.allizom.org`) are never loaded:
the browser hands such a URL to the `launchWebAuthFlow` of the extension that started
it, and only that extension sees the code. So someone who gets another person to open
their sign-in link and finish it gets nothing unless that person also hands them the
code: it stays in that person's address bar, the stranger's session is never told,
nothing is bound, and the display name never leaves the relay. Whoever has the code and
holds the session that started the sign-in can complete it within its 2 minutes: then
their browser joins the person's group. That is why the relay's page warns where the
link was opened from another network. The relay's URL and the callback each work once.
A session's sign-in that nobody opened yet ends with the session; at most 3 such are
open per network.

**The account and the group.** The relay keeps a hash of the provider and the account's
stable id, never the id itself, the e-mail address or the name: Google `iss` and `sub`,
Microsoft `tid` and `oid` (personal accounts have the tenant
`9188040d-6c67-4c5b-b112-36a304b66dad`), GitHub the numeric user id (the login can
change). Accounts are not linked across providers: one person's Google and GitHub
accounts are two groups. A group has at most 16 members. A browser that signs in again
with the same account keeps its member id and label, and its 90 days start again; with
another account it leaves its group for that account's. A binding outlasts reconnects
and restarts of the browser (its address secret stays) and ends 90 days after the
sign-in: the relay then sends `signin.ended` `expired`, at the latest one sweep (10
minutes) later. A signed-in browser's session is not closed early as unpaired
(`TAB_MCP_UNPAIRED_IDLE_TIMEOUT_S`).

### Group grants

From relay 0.14 on (DEC-232): an AI app can be connected to a whole group, every browser
signed in with one account, instead of to one browser. Its calls then go to the member
the relay chooses, and within the member to the tab the extension chooses. Only the
sessions of [Browser sign-in](#browser-sign-in) take part; a page grant, also one of a
signed-in browser, is tunnelled exactly as before (below), byte for byte.

**Pairing.** The pairing page (`/authorize`) of an app in `TAB_MCP_SIGN_IN_APPS` offers
"Sign in with Google / Microsoft / GitHub" (the providers configured) beside the code
field; a code still pairs with one browser. The sign-in uses the providers of the
browsers' sign-in, the one callback `https://<relay>/authorize/callback` with a `state`
that starts with `account.` (a browser's starts with `browser.`, identity binding's has
neither), PKCE, and the pairing page's rules otherwise: the AI app's verified host, the
page's cookie, a sign-in counts as a guess against the network's limit and is given back
when it pairs. The account's key (as for a browser's sign-in) selects the group. It pairs
when the group exists, that is when at least one browser is signed in with the account,
online or not; the page says so beside the buttons. Without one the page says: "No
browser is signed in with this … account. In the tab-mcp browser extension, sign in with
the same account, then sign in here again, or type the code." A Microsoft sign-in refused
for an administrator's approval (as `admin_approval` above) gets "This account's
organisation requires an administrator to approve tab-mcp relay first.", never
Microsoft's text. The grant is the group's:
its token record names the group (`group`) and has the group's own address id,
`group:<group key>`, which no page has. Members never see one another's address ids, and
an AI app sees only the members' ids and labels.

**The id of a tab.** A browser's own tab ids are decimal strings (1 to 15 digits, the
tab-mcp browser extension's `list_tabs`, DEC-230). For a group, `<member>:<tab>`: the
member id, a colon and the browser's tab id, for example `m_Q2x4…:1234`. The relay takes
the member off before a call reaches the member, so a member only ever sees its own ids.

**Where a group grant's request goes.** The relay reads only the JSON-RPC method of a
POST to `/s/<app>/mcp` and, for `tools/call`, the tool name and, for the tab-mcp browser
extension's own tools that take one (`page_info`, `webmcp_tools`, `webmcp_call`,
`navigate`, `go_back`, `go_forward`, `reload`, `use_tab`), the argument `tab`. Every
other tool's arguments, a `page_<name>` tool's (the web page's own input schema, where
a `tab` means what the page says) among them, are neither read nor changed: such a call
goes by rules 2 and 3.

1. A call of one of those tools with a `tab` argument: the member it names. The relay sets the argument
   to the browser's own tab id (and an `mcp-param-tab` header, if the AI app sent one)
   and tunnels the call. A `tab` that is not `<member>:<tab>`, or names no member of the
   group, is answered by the relay: a tool result with `isError` that ends with "Call
   list_tabs for the tabs you may use, then pass tab with the call, or use_tab to pin
   one."
2. Otherwise, in mode `pinned` with a pin: the pin's member. The relay does not add a
   `tab` argument: the pinned member holds the pin itself (it has it from `group`) and
   sends a call without `tab` to the pinned tab, the `page_<name>` tools included, which
   cannot take one. A pinned tab that was closed is the member's to answer, as without
   a group.
3. Otherwise (mode `front`, or mode `pinned` without a pin): the member whose window had
   the focus last, by the relay's clock of the `focus` messages; without one online,
   the member that came online last, and the result says so. In mode `pinned` that
   member pins the tab in front of its window at the call, as without a group, and sends
   `group.pin` for it.

`tools/list`, `server/discover`, `subscriptions/listen`, notifications and every other
method go by rules 2 and 3. A listen stream stays on the member it was opened on until
it ends. Two exceptions:

- `list_tabs` goes to every member online: the relay sends each of them the same
  request (tunnelled requests it makes itself, with the AI app's grant) and joins the
  answers. Each member lists its own tabs only and gets nothing of another's. The joined
  result is a tool result whose `structuredContent` (and first text, the same JSON) is
  `{mode, tabs, browsers, more?, note}`: `mode` "the tab in front" or "a pinned tab";
  `tabs`, member by member in the order of `members`, each `{tab, browser, title, url,
  inFront?, pinned?}` with `tab` the group's id, `browser` the member's label, `inFront`
  the tab in front of that browser's window as it said, `pinned` the group's pin; at
  most 256 KiB of tabs, the rest counted in `more`; `browsers`, every member, offline
  ones too, `{browser, member, online, tabs?, more?, notReadable?, error?}`, where
  `error` says why it lists none (not online, busy, it did not answer within 15
  seconds, its answer was no list); `note` where calls without `tab` go. A member's
  answer is checked like any answer (tab ids of the browser's form, titles cut at 200
  characters, addresses at 2048, at most 100 tabs).
- `use_tab` with `<member>:<tab>` goes to that member as in rule 1. When the member's
  result is not an error (it pins only a tab it may read), the relay sets the group's
  pin to that member and tab, switches the group to mode `pinned` (also from `front`:
  an explicit request does not fail on a setting the AI app cannot see) and sends
  `group` to every member.

The relay waits for the member as for a page that is not open (`TAB_MCP_PAGE_WAIT_S`,
at most 64 requests per group, the relay's session cap in all), then answers:

- the member a `tab` argument or the pin names is not online: a tool result with
  `isError`, "The pinned tab is in the browser “<label>”, which is not online; nothing
  was done in another tab." (or "The tab … is in …") and the `list_tabs` hint; other
  methods get JSON-RPC error `-31001` with that text (HTTP 200, a notification 503). It
  never goes to another browser by itself. A pin to a member that was removed from the
  group fails the same way, "The pinned tab was in a browser that is no longer signed in
  with the user's account; …".
- no member online (rules 3 and `list_tabs`): the answers of [When the page is not
  open](#when-the-page-is-not-open) with the text "No browser signed in with the user's
  account in the tab-mcp browser extension is online. Ask the user to open one of them
  and turn on AI access there, then try again." A tool call whose member went away while
  it ran: "The browser closed its connection while the tool was running, so it may or
  may not have finished. …" (`-31003` for other methods).

**Who answered.** Every result the relay passes on for a group grant names the member:
a tool result gets one more text at the end of `content`, "Answered by the browser
“<label>” (its tabs are <member>:<id> in list_tabs).", followed, for rule 3's fallback,
by why it was not the browser whose window had the focus last; every result (`tools/list`
and `server/discover` too) gets `_meta["ch.ractive.tab-mcp/answeredBy"] = {member,
label}` (`list_tabs`: `{members: [{member, label}, …]}`). The rest of the result,
`structuredContent` included, is the member's: an output schema still holds. JSON-RPC
errors pass unchanged. The relay edits the text, not a parsed copy: it
replaces the `tab` value where it stands and inserts the text item and the `_meta` key
before the closing brackets, so every other byte is the AI app's or the member's (a
number JavaScript cannot hold, such as an integer above 2^53, stays as it was written).
A body of a shape it does not expect passes unchanged. In an event stream only the event with the request's response is
rewritten; the other events, comments and keep-alives pass as they came.

**The mode, the pin and the focus.** One setting per group, the same in every panel:

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `group.mode` | T→R | `mode` | `front` or `pinned` (anything else is `bad_message`). Any member sets it; `front` drops the pin; `pinned` keeps none until a call or `group.pin` pins. The relay keeps the mode in its token store (it survives a restart); a store failure is `error` `store_unavailable` with `for: "group.mode"`, the mode unchanged. Every member gets `group`. |
| `group.pin` | T→R | `tab` | Pin a tab of this browser for the group: its own tab id, 1 to 15 digits (else `bad_message`). Sent by "Work here" in a panel and by the member that pins the tab in front at a call in mode `pinned`. Switches the group to `pinned`; every member gets `group`. |
| `focus` | T→R | none | A window of this browser gained the focus: no URL, no title, no tab. A member sends it in mode `front` only (and once after it connects, if one of its windows has the focus); in mode `pinned` the relay ignores it and learns nothing of the user's switching. The relay stamps it with its own clock. It does not count against the control budget: 20, then two a second per session, past that it is dropped (logged once as `group.focus_limited`), never an error or a close. |
| `group.grant.revoke` | T→R | `grantId` | Disconnect an AI app from the whole group: any member revokes any of the group's grants. Its tokens stop working at once, its requests in flight on every member end (`-31009`, as for a page grant), and every member gets `group` without it. A grant that is not the group's: `error` `unknown_id` with `for` and `grantId`; a store failure: `store_unavailable` the same way. |

The `group` message carries the state:

- `mode`: `front` or `pinned`, from the store when the group's first member connects
  (`front` if none was ever set).
- `pin`: in mode `pinned`, once there is one, `{member, tab}` with the browser's own tab
  id. The relay keeps it in memory: a relay that restarts forgets it, and the next call
  pins again. The pinned member sends calls without `tab` to that tab; every other
  member gets none of them while the pin is there.
- `focus`: in mode `front`, the member calls without `tab` go to now (rule 3, the
  fallback included); sent again when it changes.
- `grants`: the AI apps connected to the whole group, as `session.grants` lists a page's:
  `{grantId, client: {id, name, host}, createdAt}`, oldest first. A group grant that
  expires leaves the list at the latest one sweep (10 minutes) later. There is no
  `grant.added` or `grant.removed` for a group grant: the next `group` lists them.

Messages of this section from a browser that is not signed in get `error` `unknown_id`
with `for` (and `grantId` for `group.grant.revoke`); `focus` is ignored.

### Tunnelled MCP requests

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `http.request` | R→T | `id`, `method`, `path`, `headers`, `body`, `grant` | One HTTP request to the session's MCP address. |
| `http.response` | T→R | `id`, `status`, `headers`, `body` | A complete response in one message (JSON or empty). |
| `http.response.start` | T→R | `id`, `status`, `headers` | Start of a streamed (SSE) response. |
| `http.response.chunk` | T→R | `id`, `data` | The next piece of the body (UTF-8 text). |
| `http.response.end` | T→R | `id` | End of a streamed response. |
| `http.cancel` | R→T | `id`, `reason` | The AI app closed the connection or the request timed out. |

- `id` is chosen by the relay and unique per session.
- `headers` is an object with lower-case names, limited to `content-type`, `accept`,
  `mcp-protocol-version`, `mcp-method`, `mcp-name`, `mcp-param-*`, `traceparent` and
  `tracestate`. The relay never forwards `authorization`, `cookie`, IP addresses or
  `x-forwarded-*`.
- `body` is the request body as a string. The relay has checked its size and that it is
  JSON, and forwards it unchanged.
- `grant` identifies the caller:
  `{"grantId":"g_…","clientId":"https://…","scopes":["tools"]}`. Nothing about the token
  reaches the tab. The client library hands it to the page's tools as `client` with
  `kind: "relay"` (`grantId`, `id`, `host`, `name`); a call from an agent in the browser
  through WebMCP, which never passes the relay, has `kind: "webmcp"` and nothing more
  (DEC-115), and a call over a port the page serves has `kind: "local"`
  ([The tunnel without a relay](#the-tunnel-without-a-relay)).
- The relay keeps only `content-type` and `cache-control` from the tab's response headers.
  It sets the rest itself (`x-accel-buffering: no` and `cache-control: no-cache` on
  streams, CORS headers).
- A response must end within `requestTimeoutMs` (300 s by default), except for
  `subscriptions/listen` (recognised by `mcp-method`), which may stay open for the
  session's lifetime. Streams count against `maxConcurrentRequests`. One grant may hold
  at most 2 listen streams on a page at once; a third gets 429 (`-31004`), so one AI app
  cannot take every slot of the page.
- A streamed answer to `subscriptions/listen` must be an event stream
  (`content-type: text/event-stream`): it has no total size limit. Any other content type
  is a protocol error (`bad_message`, `-31007`, `http.cancel`).
- The library answers `tools/call` with an event stream that starts at once. Other
  methods may answer with one `http.response`.
- If the tab has not started a response within `keepAliveMs` (20 s) for a request with a
  JSON-RPC `id`, the relay answers the AI app with `200 text/event-stream` itself. A later
  `http.response` is then sent as one SSE event (`event: message`, `data: <body>`); a
  later `http.response.start` continues on the same stream, and its status and headers
  are dropped. The tab does not need to know. This keeps proxies and CDNs that drop
  requests without response headers after 60 s from cutting long tool calls.
- On streamed responses that are event streams (the relay's own, or the tab's with
  `content-type: text/event-stream`) the relay writes an SSE comment (`: keep-alive`) to
  the AI app every `keepAliveMs` while the tab is silent, but only at an event boundary
  (when the bytes forwarded so far end with a blank line; a line ends with LF, CRLF or
  CR, and the tab's chunks may split a line end or the blank line anywhere). An error
  or "page closed" event at the end goes into event streams only as well. A streamed
  body of any other type gets the tab's bytes and nothing else; if it ends early, it is
  cut off. The tab never sends keep-alives.
- A request gets either one `http.response`, or one `http.response.start` followed by
  any number of `http.response.chunk` and one `http.response.end`. An `http.response`
  after `http.response.start`, a second `http.response.start`, or a chunk before
  `http.response.start` once the relay started the event stream, is a protocol error:
  the relay answers `error` `bad_message` with the `id`, fails the request (`-31007`) and
  sends `http.cancel`.
- `http.cancel` aborts the tab's `Request.signal`; the tab sends nothing more for that
  `id`. Late messages for a cancelled `id` are dropped silently.

Example:

```json
{"type":"http.request","id":"r42","method":"POST","path":"/mcp",
 "headers":{"content-type":"application/json","accept":"application/json, text/event-stream",
            "mcp-protocol-version":"2026-07-28","mcp-method":"tools/call","mcp-name":"press_keys"},
 "body":"{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{…}}",
 "grant":{"grantId":"g_1","clientId":"https://claude.ai/oauth/claude-code-client-metadata","scopes":["tools"]}}
```

### Errors the relay sends to the AI app

When the relay itself ends an MCP request, the AI app gets a JSON-RPC error with the
request's id: as an HTTP error, or as a final SSE event if the stream had started. The
codes are outside the JSON-RPC reserved range. The page not being open is the exception,
see [When the page is not open](#when-the-page-is-not-open).

| Code | HTTP | Meaning |
|---|---|---|
| `-31001` | 200 | The page is not open (valid token, no tab connected). |
| `-31002` | 504 | The page did not answer within `requestTimeoutMs`. |
| `-31003` | 200 | The page closed its connection while the request was in flight. |
| `-31004` | 429 | Too many concurrent requests for this page. |
| `-31005` | 503 | The WebSocket send was dropped under backpressure. |
| `-31006` | 502 | The page's response exceeded `maxMessageBytes` (one message) or `maxBodyBytes` (the whole body; the event stream of a `subscriptions/listen` excepted). |
| `-31007` | 502 | The page sent an invalid response (malformed message, a header value that is not an RFC 9110 field value, a body with status 204, 205 or 304). |
| `-31008` | 503 | The token store is unavailable. Sent with `Retry-After`, so clients keep their tokens. |
| `-31009` | 401 | The request's grant was revoked while the request was in flight (also an open listen stream), the page's user signed out or changed while the request was in flight, or the page's new assertion was refused (identity binding). Sent with `WWW-Authenticate` (`error="invalid_token"`). A request still waiting for its page when its grant was revoked gets the ordinary 401 `invalid_token` instead. |
| `-31009` | 503 | The same, when the relay could not check the page's assertion (signing keys or token store unavailable, or its replay cache full). New requests get this answer too, after the usual wait for the page, until an assertion is checked; nothing reaches the page meanwhile. Sent with `Retry-After`, so clients keep their tokens. |
| `-31010` | 200 | The relay is restarting (see [When the page is not open](#when-the-page-is-not-open)). |

The relay notices that an AI app closed a streamed response when it next writes to it,
so at the latest after one keep-alive interval. It then sends `http.cancel`.

Before a request reaches the tab, the relay checks, in this order: the method (POST,
else 405), the body size and JSON (413, 400), the `MCP-Protocol-Version` header (400 with
JSON-RPC error `-32022` naming the supported version `2026-07-28`, or `-32020` when the
header is missing), the bearer token (401 with `WWW-Authenticate`), that
the tab is online (see below), the concurrency limit and, for
`subscriptions/listen`, the listen streams of the grant (429, `-31004`). The last two are
checked in the same step as the request is counted and sent, after any wait for the page:
requests that waited for the page and are let go together when it connects get no more
slots than the page allows (the first two 0.13 releases and older relays let them all through). The token's
record names the page the request is for (its address id) and the app; a token is valid
only at the address of its app, and gets 401 at any other. Without a valid token every
address `/s/<app>/mcp` with a well-formed app id answers alike, whether or not a page of
that app is connected, so the address tells nothing about open pages. A path whose app
id is not well-formed is 404.

### When the page is not open

Phones pause a tab in the background, so "not open" is often brief. A request with a valid
token whose page has no connected tab waits up to `TAB_MCP_PAGE_WAIT_S` (10 s by
default; 0 turns it off) for the page's session and is then forwarded as usual. The wait
ends when the AI app closes its request. At most `maxConcurrentRequests` requests wait per
page (the limit of the page's site, as far as the relay has seen the page since it
started) and at most `maxSessions` in all; beyond that the relay answers at once.
`server/discover` does not wait: clients use it as a quick protocol-version probe.

If the page does not come, the relay answers with **HTTP 200** and a JSON-RPC message,
never with an HTTP error status: MCP clients that also speak older protocol versions take
an HTTP error without a known MCP error as a sign of an old server and fall back to the
old handshake, which this relay refuses (DEC-074).

| Request | Answer (HTTP 200) |
|---|---|
| `tools/call` | A tool result with `isError: true`: "The page is not open, or not in front. Ask the user to open *app name* and keep it in front (on a phone, in split screen), then try again." The app name is the site's or the page's, else "the web page". |
| `server/discover` | A stand-in result: `supportedVersions: ["2026-07-28"]`, `capabilities: {"tools": {"listChanged": true}}`, the text above as `instructions`, `ttlMs: 0`, `cacheScope: "private"`, `serverInfo` `tab-mcp`. |
| any other request (`tools/list`, `subscriptions/listen`, …) | A JSON-RPC error `-31001` with the text above. For `tools/list` this keeps the AI app's last tool list; an empty list would replace it. |
| a notification (no `id`) | HTTP 503 with error `-31001`: the spec requires an error status for a notification the server cannot accept. |

While the relay shuts down (a deploy), requests that wait for the page or are in flight
get the same kinds of answers with the text "The relay is restarting. Try again in a few
seconds." and code `-31010` instead of `-31001`, so the model does not ask the user to
open the page. A `tools/call` that was in flight gets a tool result saying the relay
restarted while the tool was running and the result should be checked. A notification
gets HTTP 503 with `-31010` and `Retry-After`.

If the page closes its connection while a request waits for its answer, a `tools/list`
waits for the page once more and is sent again. A `tools/call` is never sent twice, since
the page may have run it: it gets a tool result with `isError: true` saying the page
closed while the tool was running and the result should be checked. Other requests get
the answers above, with code `-31003` instead of `-31001`. If the relay had already
started an event stream, the answer is its last event.

One exception exists for a known client bug: a request with the header
`MCP-Protocol-Version: 2025-11-25` whose body declares `2026-07-28` is accepted and
counted in `/healthz` (`counters.claudeHeaderWorkaround`).

### The tunnel without a relay

The six `http.*` messages need no relay. With `serve(port, { client })` the client
library answers them on any channel that delivers messages in order, for example a
`MessagePort` to a chat frame of the site's own assistant, and
`createTunnelFetch` (`@ractive-ch/tab-mcp-client/tunnel`) speaks the caller's end. On such
a port:

- The messages are objects, not JSON text (a `MessagePort` clones them). Whoever passes
  them on over a text channel encodes and decodes them.
- The caller sends `http.request` and `http.cancel`, the page `http.response`,
  `http.response.start`, `.chunk` and `.end`, with the fields and rules above. The
  caller chooses `id` (at most 128 characters, unique among the requests in flight on
  the port) and sends only the listed `headers`. An `http.request` whose `id` is still
  in flight ends the earlier request (as `http.cancel` would) and starts the new one.
  `createTunnelFetch` gives each of its instances a random prefix, so two of them on
  one port do not share ids.
- `grant` is not needed, and one that is sent is ignored: the library runs every request
  of a port as the client the page named in `serve`
  (`{"grantId":"local:<n>","clientId":"<client.id>","scopes":["tools"]}`, one `n` per
  `serve`), and the page's tools see `client` with `kind: "local"`, `id` and `name`.
  The other end cannot pass for an AI app of a relay.
- There is no `hello`, `session`, heartbeat or limits message, and nothing about
  pairing, grants or identity. The page splits a response body into chunks of at most
  `maxChunk` characters (65536 by default).
- When the page stops serving the port (`close()` or its `signal`), it aborts the
  requests in flight, sends nothing more for them, and sends one `bye` with the reason
  `closed`. `createTunnelFetch` then ends its requests in flight, and every later one,
  with `-31003`. A port carries no news of its own closing, so without the `bye` the
  caller would wait for each request's timeout. In the other direction, the page closes
  the serve itself when the port fires `close` (its other end is gone), where the
  runtime has that event (Bun; Chrome only with the `MessagePortCloseEvent` Blink
  feature); otherwise the page has to call `close()`.
- To anything but `http.request` and `http.cancel` the page answers `error` with
  `bad_message` (and the `id`, if the message had one); an `error` message is never
  answered. `createTunnelFetch` ends the request a `bad_message` names with `-31007`.
- The relay's errors have no relay to send them. `createTunnelFetch` produces the ones
  that apply, with the same codes at HTTP 200, or as the last event of a stream that
  had started: `-31002` when a response has not ended within its `requestTimeoutMs`
  (it sends `http.cancel` first; `subscriptions/listen` is not limited), `-31003` once
  its `close()` was called (it sends `http.cancel` for each request in flight) or the
  page said `bye`, `-31005` when its `send` throws, `-31007` for a response that breaks
  the rules above. A response body that came in pieces without being an event stream
  ends with the error as its body if no piece had come, else the body breaks off.
- The page limits each request too (`serve`'s `requestTimeoutMs`, 300 s by default;
  `subscriptions/listen` is not limited). When a request has not ended in time, the page
  aborts it, sends nothing more for it, and answers the same `-31002` error itself: as
  `http.response` with status 200 and the JSON-RPC error as its body if no response had
  started, else as a last `http.response.chunk` with that error as an event
  (`event: message`, between two events) followed by `http.response.end`. A caller
  therefore gets `-31002` from whichever end's limit runs out first.

Who holds the other end of the port is the page's decision when it hands the port out;
see A15 in the [threat model](threat-model.md).

### Errors between tab and relay

`{"type":"error","code":"…","message":"…","id":"r42"}` from the relay. `id` is optional
and names the request the error concerns. The relay accepts `error` from the tab and
only logs it at debug level; libraries up to 0.15 sent one for a message they could not
read.

An `unknown_id` or `store_unavailable` that answers a `grant.revoke`, `grants.revokeAll`
or `identity.logout` names that message in `for` (relays from the third 0.10 release on), and the
grant of a `grant.revoke` in `grantId`. One that answers a `signin.out`, `member.rename`
or `member.remove` ([Browser sign-in](#browser-sign-in)), or a `group.mode`, `group.pin`
or `group.grant.revoke` ([Group grants](#group-grants)), names it in `for` too, the
member of `member.rename` and `member.remove` in `member`, and the grant of
`group.grant.revoke` in `grantId`:

```json
{"type":"error","code":"store_unavailable","message":"the relay cannot change grants right now; try again shortly","for":"grant.revoke","grantId":"g_…"}
{"type":"error","code":"store_unavailable","message":"…","for":"identity.logout"}
{"type":"error","code":"unknown_id","message":"no such member in this group","for":"member.remove","member":"m_…"}
```

A page with several of these pending settles only the one named. Without `for` (old
relays: the first two 0.10 releases and older) the error may answer any of them; the
library then settles every pending one, as it did before it knew the two fields (the
first 0.16 release and older, which ignore them).

| Code | Sent by | Meaning |
|---|---|---|
| `bad_message` | relay | Not JSON, missing fields, a binary frame, a malformed `secret`, a missing or malformed `app.id`, a malformed `hello.capabilities`. The library sends none to the relay: it drops a message it cannot read. |
| `unknown_type` | relay | Message type not understood, but an answer was expected. |
| `unknown_id` | relay | A `grant.revoke` named a grant that is not this page's or has no usable token left (it expired, or was revoked elsewhere); the error has no `id`, and names the grant (`for`, `grantId`, above). The library removes that grant from its list. A `member.rename` or `member.remove` named a member that is not in the browser's group, or came from a browser that is not signed in (`for`, `member`). A `group.grant.revoke` named a grant that is not the group's, or a `group.*` message came from a browser that is not signed in (`for`, and `grantId`). Late `http.response*` messages for a finished or cancelled `id` get no answer: the relay drops them. |
| `too_large` | relay | A message exceeded `maxMessageBytes`; the relay answers the AI app with 502. The relay refuses it by its length, without parsing it; the error's `id` is taken from the start of the message (send `type` and `id` first). A frame over four times the largest `maxMessageBytes` of any site closes the socket with 1009 instead. |
| `rate_limited` | relay | The tab sent more control messages than its budget: every message except `pong` and `http.response*` counts, 30 at once, then 2 a second per session. Followed by close 4008. A page sends a handful of these when its dialog opens or its user signs in. |
| `identity_refused` | relay | An `identity` assertion was refused (bad signature, type, issuer, audience, expiry, a reused `jti`), or `identity`/`identity.logout` came on a site without identity binding. |
| `store_unavailable` | relay | A `grant.revoke`, `grants.revokeAll`, `identity.logout`, `signin.out`, `member.rename`, `member.remove`, `group.mode` or `group.grant.revoke` failed because the relay's token store failed (for `identity.logout` the binding and the requests in flight end anyway). Nothing was wrong with the message; the session stays, and the tab may send it again later. Relays up to 0.9 answered `bad_message`. |
| `app_not_allowed` | relay | The relay's configuration does not let the page's origin serve the app named in `hello.app.id`: the app is reserved for other origins, or the origin's site lists other apps ([`sites[].apps`](configuration.md#sites)). Followed by close 1008, before a session exists. The library reports it as `policy` and does not reconnect by itself. |

Failures of an MCP request inside the tab are not protocol errors: the tab answers with
an HTTP status and a JSON-RPC error body, as its MCP handler produced it.

## Close codes

| Code | Meaning |
|---|---|
| 1000 | Normal close (`bye`, the user pressed Disconnect). |
| 1008 | Policy violation (bad message, no `hello` in time, `app_not_allowed`). |
| 1009 | Message too large. |
| 4001 | Session expired (absolute lifetime). |
| 4002 | Idle timeout: no MCP request for `idleTimeoutMs` and nothing in flight. An open `subscriptions/listen` stream counts as activity. |
| 4003 | Heartbeat lost. |
| 4004 | The relay is shutting down. |
| 4005 | Replaced by a newer session with the same address id (the same secret and app id). |
| 4008 | Rate limited (see `rate_limited`). The library does not reconnect by itself. |

On any close the relay ends the session: pending HTTP requests get the answers in
[When the page is not open](#when-the-page-is-not-open), listen streams end, and the
pairing code becomes invalid. Grants and tokens stay: they belong to the address id, not
to the WebSocket. While the page's tab is not connected, MCP requests with a valid token get "the page
is not open". After a close with 4003 or 4004 (or `bye` `shutdown`) or a broken
connection, the library opens a new session by itself with growing waits (5, 10, 20,
40 s, then every 60 s, each varied by up to 20 % so that tabs do not all come back at
once), since the user already started this one; after the other reasons it waits for
the user. The library treats 1001, 1011, 1012 and 1013 like 4004: a proxy or platform in
front of the relay sends them when the relay behind it restarts without its own `bye`.

## Heartbeat

Browsers cannot send WebSocket pings from JavaScript, so the heartbeat is part of the
protocol. The relay sends `ping` every `heartbeatMs` (25 s by default) and the tab
answers `pong`. The relay closes with 4003 after two missed pongs. The tab treats two
missed pings as a dead connection and shows the session as ended. The relay also sends
WebSocket protocol pings, so proxies keep the connection open.

## Limits (defaults)

| Limit | Default | Enforced by |
|---|---|---|
| WebSocket message | 1 MiB | both |
| MCP request body | 1 MiB | relay (HTTP 413) |
| Request timeout | 300 s | relay (504 and `http.cancel`; keep-alives throughout) |
| Keep-alive interval | 20 s | relay |
| Concurrent requests per session | 8 | relay (429) |
| Listen streams per grant and session | 2 | relay (429) |
| Idle timeout | 60 min | relay (close 4002) |
| Session lifetime | 12 h | relay (close 4001) |
| Sessions per IP / in total | 5 / 500 | relay (HTTP 429 on upgrade) |
| Sign-in starts per session / per network | 5, then 1 every 30 s / 20, then 1 every 30 s | relay (`signin.failed` `rate_limited`) |
| Open sign-ins | 1 per session, 3 not yet opened per network, 10 000 in all, 10 minutes each | relay (`signin.failed` `rate_limited`, `busy`) |
| Members per group | 16 | relay (`signin.failed` `group_full`) |
| `focus` messages per session | 20, then 2 a second | relay (dropped) |
| A member's answer to a group's `list_tabs` | 15 s | relay (listed without its tabs) |
| Tabs in a group's `list_tabs` | 256 KiB, 100 per member | relay (counted in `more`) |
| Requests waiting for a group's member | 64 per group | relay (answered at once) |

All are configurable on the relay; see [configuration](configuration.md). The
[threat model](threat-model.md) explains why each exists.
