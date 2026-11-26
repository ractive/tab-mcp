# Tab–relay protocol, `tab-mcp.v1`

This is the WebSocket protocol between a web page (the *tab*) and a tab-mcp relay. The
browser library `@ractive-ch/tab-mcp-client` implements the tab side; the relay
`@ractive-ch/tab-mcp` implements the other. Read this if you write your own tab
implementation or want to know what passes over the connection.

The protocol tunnels the AI app's MCP HTTP requests to the tab and the tab's HTTP
responses back. It also carries the session's control messages: pairing, connected apps,
the heartbeat and, for a browser extension that asks for it, its sign-in. It knows nothing about MCP tools. The tab runs the MCP server itself
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
session's address id to the account and keeps the group's members informed; what a
group's members do together beyond that is not part of the protocol yet.

Only a session whose `hello` named `signin.v1` in `capabilities`, and whose app the
relay lets sign in (`TAB_MCP_SIGN_IN_APPS`, [configuration](configuration.md#browser-sign-in)),
gets any message of this section, and only for it are `signin.*` and `member.*`
messages. For every other session they are unknown types (`unknown_type` when they carry
an `id`, else ignored), and its `session` has no `signIn`: it is answered byte for byte
as by a relay without sign-in.

| Type | Dir | Fields | Meaning |
|---|---|---|---|
| `session` | R→T | `signIn: {providers, member?}` | `providers`: the providers this relay offers, in the order to show them, each `{id, name}` (`google` "Google", `microsoft` "Microsoft", `github` "GitHub"). `member`: this browser's member id while it is signed in; a `group` message follows the `session`. Without `member` the browser is not signed in (or the relay could not read its sign-in, logged as `store.error`; it then counts as signed out until it connects again). |
| `signin.start` | T→R | `provider`, `redirectUrl`, `label?` | Start a sign-in. `redirectUrl` is the extension's `identity.getRedirectURL()` without a path, and must be its own: `https://<extension id>.chromiumapp.org/` for a page of `chrome-extension://<extension id>` (Chrome, Edge), `https://<40 hex digits>.extensions.allizom.org/` for a page of `moz-extension://` (Firefox). `label` (1-64 characters, cleaned of invisible characters) names the browser in its group, e.g. "Chrome on macOS"; default "Browser". A new `signin.start` ends the session's open sign-in. Answered with `signin.url` or `signin.failed`. |
| `signin.url` | R→T | `provider`, `url`, `expiresAt` | The URL to open with `identity.launchWebAuthFlow` (interactive): the relay's own, `https://<relay>/signin?flow=…`. It works once, until `expiresAt` (10 minutes). |
| `signin.done` | R→T | `provider`, `displayName`, `member` | The browser is signed in. `displayName` is what to show as "Signed in as …": Google's `email`, Microsoft's `preferred_username`, GitHub's login. The relay does not keep it and sends it only here; the tab keeps it if it wants to show it later. `member` is this browser's member id. A `group` message follows. |
| `signin.failed` | R→T | `provider?`, `reason`, `message` | The sign-in did not happen. `reason`: `not_offered` (no such provider here), `bad_redirect` (the redirect URL is not the extension's, or the page is no extension), `rate_limited`, `busy` (too many sign-ins open on the relay), `provider_unavailable` (its metadata cannot be fetched), `provider_error` (the provider sent the browser back without a code: cancelled, refused), `unchecked` (the code or the ID token did not check out), `browser` (the sign-in came back in another browser than the one that opened the URL), `group_full` (the account has 16 browsers), `store_unavailable`. `message` is a fixed text per reason. A binding the browser had stays. |
| `signin.out` | T→R | none | Sign out: the binding ends. Answered with `signin.ended` `signed_out` (also when the browser was not signed in), or `error` `store_unavailable` with `for: "signin.out"`, the binding then kept. |
| `signin.ended` | R→T | `reason` | The browser is no longer signed in: `signed_out` (its own `signin.out`), `removed` (another member removed it), `expired` (90 days after its sign-in). It may sign in again. |
| `group` | R→T | `provider`, `self`, `expiresAt`, `maxMembers`, `members` | The group's state: to every online member when a member joins, leaves, is renamed, connects or goes offline, and to a member when it connects. `self` is this browser's member id, `expiresAt` when its sign-in ends unless it signs in again, `maxMembers` 16. `members`, oldest sign-in first, this browser included: `{id, label, online, signedInAt}`. A member id is random (`m_…`) and tells nothing about the address id. A tab ignores fields it does not know: later relays add some. |
| `member.rename` | T→R | `member`, `label` | Rename a member of this browser's group, itself or another (1-64 characters, cleaned; nothing visible left is `bad_message`). Every member then gets `group`. |
| `member.remove` | T→R | `member` | Remove a member of this browser's group: its binding ends and, if it is online, it gets `signin.ended` `removed`; every member left gets `group`. Removing itself is `signin.out`. |

A `member.rename` or `member.remove` for a member that is not in this browser's group,
or from a browser that is not signed in, gets `error` `unknown_id` with `for` and
`member`; a store failure gets `store_unavailable` the same way. The relay handles a
session's sign-in messages, and a sign-in that comes back for it, one after another in
the order they came. They count against the control budget like every other message.

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
   binding's by it.
3. The provider sends the browser back. The relay checks the cookie (without it:
   `browser`, and an error page instead of the redirect below), redeems the code and
   checks the account: the ID token as for identity binding (signature, `iss`, `aud`,
   `azp`, `exp`, `iat`, `nonce`; Microsoft's `iss` must be
   `https://login.microsoftonline.com/{tid}/v2.0` with the token's own `tid`), or for
   GitHub one `GET https://api.github.com/user` with the access token, which the relay
   then drops.
4. The relay binds the session's address id to the account, sends `signin.done` and
   `group`, and sends the browser to `redirectUrl?signin=done` (or `signin=failed`),
   which ends `launchWebAuthFlow`. Nothing secret is in that URL: the result reaches the
   extension over its session.

A sign-in belongs to the session that started it. If that session is gone when the
provider sends the browser back, or another session of the same address replaced it,
the relay redeems nothing, binds nothing and sends the browser to
`redirectUrl?signin=failed`. The relay's URL and the callback each work once.

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
or `member.remove` ([Browser sign-in](#browser-sign-in)) names it in `for` too, and the
member of the last two in `member`:

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
| `unknown_id` | relay | A `grant.revoke` named a grant that is not this page's or has no usable token left (it expired, or was revoked elsewhere); the error has no `id`, and names the grant (`for`, `grantId`, above). The library removes that grant from its list. A `member.rename` or `member.remove` named a member that is not in the browser's group, or came from a browser that is not signed in (`for`, `member`). Late `http.response*` messages for a finished or cancelled `id` get no answer: the relay drops them. |
| `too_large` | relay | A message exceeded `maxMessageBytes`; the relay answers the AI app with 502. The relay refuses it by its length, without parsing it; the error's `id` is taken from the start of the message (send `type` and `id` first). A frame over four times the largest `maxMessageBytes` of any site closes the socket with 1009 instead. |
| `rate_limited` | relay | The tab sent more control messages than its budget: every message except `pong` and `http.response*` counts, 30 at once, then 2 a second per session. Followed by close 4008. A page sends a handful of these when its dialog opens or its user signs in. |
| `identity_refused` | relay | An `identity` assertion was refused (bad signature, type, issuer, audience, expiry, a reused `jti`), or `identity`/`identity.logout` came on a site without identity binding. |
| `store_unavailable` | relay | A `grant.revoke`, `grants.revokeAll`, `identity.logout`, `signin.out`, `member.rename` or `member.remove` failed because the relay's token store failed (for `identity.logout` the binding and the requests in flight end anyway). Nothing was wrong with the message; the session stays, and the tab may send it again later. Relays up to 0.9 answered `bad_message`. |
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
| Open sign-ins | 1 per session, 10 000 in all, 10 minutes each | relay (`signin.failed` `busy`) |
| Members per group | 16 | relay (`signin.failed` `group_full`) |

All are configurable on the relay; see [configuration](configuration.md). The
[threat model](threat-model.md) explains why each exists.
