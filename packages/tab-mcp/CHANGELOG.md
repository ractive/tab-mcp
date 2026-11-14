# Changelog of @ractive-ch/tab-mcp

All notable changes to the relay `@ractive-ch/tab-mcp`, released with the Git tag
`relay-v<version>`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). The browser library has its own
[changelog](https://github.com/ractive/tab-mcp/blob/main/packages/tab-mcp-client/CHANGELOG.md).

The relay. Each relay release is also a Docker image, `ractive/tab-mcp` and
`ghcr.io/ractive/tab-mcp`, tagged with the version.

## [0.10.3][relay-0.10.3] - 2026-11-14

### Removed

- The "Already connected" / "Already sent" page and the memory of up to 10 000 paired
  requests behind it. A pairing form sent again after it paired (a double click, the
  back button) gets the page every expired request gets: "This connection request has
  expired or was already used." The first submit's code is not affected.
- `/healthz` no longer counts reads that missed their one-second deadline: each probe
  after the reused second reads the store again, also while an earlier read still
  hangs. Before, a new read was tried only every 30 seconds while one hung. The
  built-in stores answer synchronously and never hang; a custom store that hangs for
  good now collects one pending read per second of probing.

### Changed

- Internal: one module each for random values, SHA-256 and the constant-time
  comparison (`crypto.ts`), the bounded body reader (`body.ts`), the `exp`/`iat`/`nbf`
  checks of tab and client assertions (`checkTimes` in `jwt.ts`) and a client id's
  host; the CIMD fetch takes its URL and address rules as one policy object instead of
  a test-mode flag; unused options (`PairingCodes`' `maxAttempts`, the fetcher's
  `maxBytes`) and the token helper for tests are gone from the production code. No
  change in behaviour.

## [0.10.2][relay-0.10.2] - 2026-11-13

### Fixed

- The sweep (every `sweepIntervalMs`, 10 minutes by default) tells each connected page
  of its grants that expired, with `grant.removed` `expired` (logged as `grant.expired`).
  Before, a page listed an expired app until it connected again. One `listGrants` per
  connected page that lists a grant, per sweep. The grant's requests in flight end then,
  as for a revocation. With several instances, a grant revoked through another instance
  is announced the same way, and its listen streams on the page's instance end at that
  sweep instead of at the session's end.
- "Revoke all" and a sign-out also remove the grants the page lists that expired since
  the last sweep, so the page's list ends empty and `signOut()` no longer runs into its
  15 s timeout.

### Changed

- An `error` `unknown_id` or `store_unavailable` that answers a `grant.revoke`,
  `grants.revokeAll` or `identity.logout` names it: `for` (the message's type) and, for
  `grant.revoke`, `grantId`. A page with several revocations pending can tell which one
  failed (`docs/protocol.md`). Libraries up to 0.16.0 ignore the fields.

## [0.10.1][relay-0.10.1] - 2026-11-13

### Changed

- When the store fails while the page signs its user out (`identity.logout`), the relay
  tells the page with `error` `store_unavailable`, as for a failed revocation; it only
  logged it, and the client's `signOut()` waited for grants that did not go.

## [0.10.0][relay-0.10.0] - 2026-11-13

### Added

- Log events: `oauth.token_refused` (info: a refused `/token` or `/revoke` request with
  its grant type, OAuth error, a fixed reason and the AI app's host), `oauth.rate_limited`
  (warn, once per network and episode: which per-network limit), `relay.stats` (info,
  every sweep: sessions, waiting requests, open authorizations), `relay.start_failed` and
  `relay.unknown_setting` (a `TAB_MCP_*` variable the relay does not read).
- Error log lines carry `errorCode` next to `error` when the error has a code such as
  `SQLITE_FULL` or `EADDRINUSE`.
- The tab error code `store_unavailable`: a `grant.revoke` or `grants.revokeAll` that
  failed because the token store failed (was `bad_message`).
- `describeConfigError` and `unknownEnvNames` in the package; `ConfigError` has `key`.
- Log events `tab.rate_limited`, `relay.bad_forwarded_ip` (a proxy header that is not an
  address, logged once) and `http.handler_error` (an exception in a request handler,
  answered with a plain 500 by the new `Bun.serve` `error` handler).
- `installCrashLogging` is exported and described in the README, for embedders.

### Changed

- A refresh stores the new token pair before it marks the old refresh token used. A token
  store failure during a refresh is answered with 503 and the retry with the same token
  succeeds; before, the retry counted as reuse and revoked the grant. A code exchange whose
  token issue fails makes the code usable again.
- A full instance (10 000 open authorization requests) evicts a request instead of
  answering 429 to everyone: first one whose page is gone or whose dialog is closed,
  otherwise the oldest of the network holding the most. Per-network caps count an IPv6
  /56.
- A metadata fetch for a client id that is not cached is charged to the requesting
  network first (5, then 1 a minute) at `/authorize`, `/token` and `/revoke`, with 429
  when used up. Set `TAB_MCP_CLIENT_ID_HOSTS` to avoid fetching for strangers at all.
- Tab sessions have a message budget (30, then 2 a second) for every frame except `pong`
  and `http.response*`. Past it the relay sends `rate_limited` and closes with 4008. A
  second `grants.revokeAll` within a second of a finished revocation writes nothing.
- `/token`, `/revoke` and `POST /authorize` read their body with a deadline and count its
  bytes as they arrive: a slow body gets 408 with `Connection: close`, an oversized
  chunked body is refused at the limit.
- Timer settings above 2^31-1 ms (about 24.8 days) are refused at start; before, they
  fired at once (a 30-day session lifetime closed every session right after it opened).
- A client's JWKS may hold at most 20 keys, and at most 3 are tried per assertion. Failed
  client assertions have a per-network budget, checked before metadata or keys are
  loaded.
- The MCP endpoint looks up the token before it reads the body: without a valid token at
  most 16 KiB is read, and a larger body gets 401 (or 503) unparsed.
- One timeout covers the DNS lookup and the metadata fetch.
- A port is stripped from `X-Real-IP` / `X-Forwarded-For`; a value that is not an address
  falls back to the socket address.
- Keep-alive comments, error events and the "page gone" event are written only into event
  streams. A streamed body that is not an event stream and ends early is broken off
  instead of ending cleanly.
- The expiry sweep calls the store inside a promise chain, so a store that throws
  synchronously no longer ends the process.

- `hello` no longer needs `page: {title}`; the relay ignores the field, which it never
  read. Libraries up to 0.15 send the page title, newer ones an empty one.
- On an open relay a page origin that is not a serialised origin (or an extension's) of
  at most 255 characters is treated as no origin, on the pairing page and in the log.
- A page's app name is cleaned like an AI app's name (bidi and invisible characters
  removed) and dropped when it names a domain other than the page origin's host (a
  dotted word such as "Node.js" counts as one; a site's configured `name` is not
  checked). Names
  and origins on the pairing page are bidi-isolated.
- `/authorize` answers one "Open the page first" text whether the page is closed or its
  dialog is closed.
- Identity binding: the dialog must still be open when the provider sends the browser
  back; `identity_refused` has a fixed text per reason (no longer the JWKS fetch error).
  Provider discovery serves its last metadata for an hour after a failed refresh and
  waits 30 seconds before it tries again.
- A network's share of an address's code guesses counts an IPv6 /56.
- The visit cookie is renewed with every pairing page, so a second authorization within
  ten minutes no longer fails with "your browser may block cookies".
- A loopback redirect to `[::1]` is allowed in `form-action` as `http:` (Chrome ignored
  the IPv6 literal and blocked the redirect after Connect).
- A token store failure at `/token` and `/revoke` is logged as `store.error` (`op`
  `token`, `revoke`), no longer as `oauth.error`. The fields `message` of `oauth.error`
  and `tab.handler_error` are renamed `error`.
- A failure at start other than a configuration error prints its message on stderr and
  exits with 1, instead of an uncaught exception with the class name only. Configuration
  errors name the environment variable. `store`, `trustProxy`, `logLevel` and `cors` are
  checked when passed to `createRelay`.
- A large request for a site with a raised `maxMessageBytes` gets "the page is not open"
  while its page reconnects, not 413.

## [0.9.0][relay-0.9.0] - 2026-11-11

### Added

- `TAB_MCP_UNPAIRED_IDLE_TIMEOUT_S` (600): a tab session that never had a grant, never
  started pairing, never had its user signed in and never got an MCP request is closed
  after 10 minutes (`bye idle`, close code 4002) instead of after the hour of
  `TAB_MCP_IDLE_TIMEOUT_S`. A page with its pairing dialog open or an AI app paired is
  not affected. See "Sizing the session limits" in `docs/self-hosting.md`.

### Changed

- IPv6 tab sessions count against `TAB_MCP_MAX_SESSIONS_PER_IP` per /64 and per /56; both
  must stay under it. Before, one /56 (256 /64s) could open 256 times the limit.
- `/token` and `/revoke` limit failures per IP (30, then 1 a second; past that a failing
  request gets 429), but never refuse a request that succeeds, so the users of one hosted
  AI app behind shared addresses no longer block each other with stale tokens. Every
  request, success or not, counts against a new ceiling per IP of 600, then 20 a second.
- Only wrong pairing codes count against the guess limits; a right code is given back.

### Fixed

- Security: revoking a grant (the page's Disconnect, "revoke all", "New address",
  `/revoke`, refresh-token reuse, identity binding) now ends its requests in flight and
  open listen streams (HTTP 401 or an error event, code `-31009`; the page gets
  `http.cancel`). A request authenticated before the revocation and still waiting for its
  page (up to `TAB_MCP_PAGE_WAIT_S`) checks its token again and is refused instead of
  being forwarded to the page.
- Security: an authorization code issued before "New address" (`hello.revokeAll`) or
  "revoke all" no longer makes a working grant when it is exchanged afterwards. The
  grant dates from the code's issue time, so the address's tombstone refuses it (also
  after a revocation on another instance), and both now drop the address's open
  authorization requests and codes.
- Security: the per-address pairing-code guess limit no longer forgets a drained bucket
  to make room when full, so cycling through many keys cannot reset an address's
  allowance; while it is full of buckets that still count, guesses at new addresses are
  refused.

## [0.8.0][relay-0.8.0] - 2026-11-09

### Added

- `pairing.code` has an optional `reason`: `start` (after `pairing.start`), `used` (the
  last code was entered), `locked` (5 wrong attempts) or `expired`. The page's dialog
  uses it to wait for the AI app after a code was used instead of showing the next code
  at once. Older clients ignore it.
- When the same browser sends the `/authorize` form again for a request that already
  paired (a double click, a page left open), the page names the AI app and says
  "Already connected" once the app exchanged its code, else "Already sent" (start
  again if the app does not show the connection), instead of "This connection request
  has expired or was already used". Another browser still gets the error.

## [0.7.1][relay-0.7.1] - 2026-11-09

### Changed

- The front page (`/`) is styled like the sign-in pages and shows the relay's version, a
  diagram of the path from AI app to browser tab, and links to the documentation
  (https://ractive.ch/tab-mcp/) and the guide to connecting an AI app. Its CSP adds
  `style-src 'self'`. Both pages load the stylesheet as `/authorize.css?v=<version>`.

## [0.7.0][relay-0.7.0] - 2026-11-05

### Added

- Browser extensions as pages: `TAB_MCP_ALLOWED_ORIGINS` and `TAB_MCP_SITES` accept a
  Chrome or Edge extension's origin, `chrome-extension://<id>` (the 32-letter id, a to p;
  written in lower case, a trailing slash dropped), so an extension can offer tools from
  one of its own pages, such as its side panel. The pairing page names it "the browser
  extension `chrome-extension://<id>`". `moz-extension://` and `safari-web-extension://`
  are refused at start with the reason (every installation has its own id); other
  schemes as before. See "Browser extensions" in docs/configuration.md (DEC-108).

## [0.6.1][relay-0.6.1] - 2026-11-01

### Added

- `@ractive-ch/tab-mcp/testing` exports `startTestRelay()` (a relay in the test process:
  127.0.0.1, a free port, development mode, every origin, a memory store) and
  `tokenFor()` (a token for a page's MCP address, written into the store as if an AI app
  had paired), for end-to-end tests of a page's tools.

### Changed

- In development without `TAB_MCP_PUBLIC_URL`, the public URL is the loopback address
  the relay listens on (`127.0.0.1` or `[::1]`) instead of always `localhost`, so the
  addresses match the URL the page was given. The issuer, the addresses and the sign-in
  callback move with it: AI apps that saved a `localhost` address must add it again, and
  an identity provider needs the new callback. `TAB_MCP_PUBLIC_URL=http://localhost:<port>`
  keeps the old URLs.

## [0.6.0][relay-0.6.0] - 2026-10-31

### Added

- `private_key_jwt` client authentication at `/token` and `/revoke` (RFC 7523,
  DEC-106), for ChatGPT's connectors. The server metadata lists
  `["none", "private_key_jwt"]` and the accepted signing algorithms (RS, PS and ES
  256/384/512, EdDSA; never `none` or HMAC). A Client ID Metadata Document that uses it
  needs a `jwks_uri` on the host of its client id; an inline `jwks` is not accepted. If
  its keys cannot be used (no or another `jwks_uri`, `jwks` beside it, an algorithm the
  relay does not verify) and it lists `none`, it is a public client, as in 0.5.1
  (DEC-104), and the relay logs `oauth.cimd_auth_fallback`. The JWKS is fetched with the
  metadata fetch's SSRF guards and rate limits, and cached. An assertion needs a key of
  that JWKS by `kid`, `iss` and `sub` equal to the client id, `aud` the issuer or the
  endpoint's URL, `exp` at most an hour ahead, use within five minutes of `iat` (without
  `iat`, `exp` at most five minutes ahead; 30 s leeway), and a `jti` that is never
  accepted twice while the assertion is usable. A failed check is `invalid_client` (HTTP
  401), logged as `oauth.client_auth_failed`. When the document or keys cannot be loaded
  right now (also a `kid` the keys lack that could not be looked for again yet, and a
  client id on a private address), the answer is 503 `temporarily_unavailable` with
  `Retry-After`, logged as `oauth.client_auth_unavailable`, and `/token` and `/revoke`
  use the last good document for up to an hour past its cache lifetime. Known clients'
  document refreshes and key fetches have their own fetch budgets, a failed fetch is
  answered again for a minute per client id, and the document and key caches give one
  domain at most 100 of their 1000 places, so requests for made-up client ids cannot
  push a real AI app out.
- Not yet tried against ChatGPT: an assertion without `iat` whose `exp` is more than
  five minutes ahead is refused, and so is a reused assertion (single-use `jti`).
- A grant made or refreshed with a client assertion is bound to it: its refresh tokens
  are refused without one, and so is revoking it, so a stolen refresh token can neither
  be redeemed as a public client nor end the grant. A client whose document does not
  list `none` needs an assertion for every code. One that lists `none` (ChatGPT) can
  still connect as a public client, as since 0.5.1 (DEC-104). Grants from earlier
  versions stay public.
- `TokenStore.claimNonce(key, expiresAt, now)`, optional: remembers used assertion ids,
  atomically, so instances that share a store share them. The memory and SQLite stores
  have it; without it the relay keeps them in its own memory, per instance. Either way
  one AI app host may hold at most 10 000 live entries per instance (then 503 for that
  host only). A
  `TokenRecord` can carry `clientAuth: "private_key_jwt"`, which a store must keep
  unchanged. The conformance suite checks both. The SQLite store upgrades its file to
  schema version 5 when it opens it (a `nonces` table, a `client_auth` column, and a
  `meta` table whose `min_reader_version` makes later relays refuse a file a newer
  release marked as needing more).
- **Rolling back unbinds grants.** A relay older than 0.6.0 opens the upgraded
  SQLite file without complaint and drops `client_auth` when it writes, so
  `private_key_jwt` grants come back unbound (public). Do not roll back, or accept that;
  and run the same version on every instance that shares a store.

### Changed

- A `client_assertion` at `/token` or `/revoke` is checked instead of refused. A public
  client that sends one gets `invalid_client` (401) rather than 400. `client_secret` and
  HTTP Basic are still refused.
- Bun 1.4.4: the Docker image runs on it (was 1.4.3), and the npm package needs Bun
  1.4.4 or newer, the version CI tests.

### Fixed

- A code presented by another client id no longer uses the code up, and a used one no
  longer revokes its grant: the client id is checked first. Before, anyone who saw a
  code could make it fail for the AI app it was issued to.

## [0.5.1][relay-0.5.1] - 2026-10-25

### Added

- AI apps whose Client ID Metadata Document prefers another token endpoint auth method
  but lists `none` in `token_endpoint_auth_methods_supported` are accepted (DEC-104).
  ChatGPT's connectors (`https://chatgpt.com/oauth/client.json`, `private_key_jwt` with
  `["none", "private_key_jwt"]`) were refused at `/authorize`.
- An icon: `/favicon.ico` (16, 32 and 48 px), `/favicon.svg` and
  `/apple-touch-icon.png`, linked from the index and the sign-in pages. AI apps show it
  for a connector where they showed a placeholder (Claude Desktop showed "@"). It is the
  relay's, the same for every page; `scripts/favicon.ts` renders it from
  `scripts/favicon.svg`.

## [0.5.0][relay-0.5.0] - 2026-10-25

### Added

- `hello.revokeAll: true` (DEC-095): the relay revokes every grant of the address as it
  hands the address to this session, before its `session` answer, which then lists no
  grants. A page takes its address back with it after a takeover; before, its
  `grants.revokeAll` came after the `session` and was lost when whoever held the secret
  claimed the address again first. Anything but a boolean in the field is refused with
  `bad_message`.
- Several instances behind one public URL (DEC-098). The address id is now reachable
  from every request that needs the instance holding the address, so a load balancer
  can route by it: `/tab?a=<id>` (new, sent by the client library from 0.8),
  `/a/<id>/mcp`, `GET /authorize` (its `resource`), the pairing form's post (now
  `/authorize?a=<id>`), the identity provider's return to `/authorize/callback` (the
  `state` starts with `<id>.`), and the authorization code (starts with `<id>.`, for a
  load balancer that reads the `/token` body). It also needs a shared token store.
  "Running several instances" in the self-hosting guide has what is per instance, what
  needs a shared store, and routing rules for nginx, Caddy and HAProxy.
- `/tab?a=` is checked: a malformed, percent-encoded or repeated `a` gets HTTP 400 `bad_address` before
  the upgrade; an id that is not the one of the secret in `hello` gets `error`
  `address_mismatch` and close code 4009, and no session opens. The parameter is
  optional: libraries up to 0.7 send none and keep working with a single relay. The
  relay will accept `/tab` without `a` at least until 1.0, and this changelog will say
  so a release ahead if that ever changes.
- `/healthz` reads the token store (one key, one-second deadline, one probe at a time,
  its answer reused for a second) and answers 503
  `{"status":"unhealthy","reason":"store_unavailable"|"store_timeout"}` when the store
  fails, never with the store's error (DEC-099). Logged as `health.store`.

### Changed

- Authorization codes and the `state` sent to the identity provider are longer: the
  address id, a dot, and the random part as before. They stay opaque to clients.

## [0.4.0][relay-0.4.0] - 2026-10-24

### Fixed

- A page that answered `subscriptions/listen` with a stream that is not an event stream
  made the relay buffer it without limit. A listen answer must now be an event stream;
  any other content type fails the request with `-31007` and cancels it in the page. A
  chunk before `http.response.start` on a stream the relay started is refused the same
  way.
- After an authenticated MCP request the connection kept no idle timeout, so a token
  holder could keep any number of idle sockets open. The relay now restores the
  idle timeout (`httpIdleTimeoutS`, 30 s) when a request ends, however it ends.
- `-31009` (the page's user signed out or changed mid-request) now comes with
  `WWW-Authenticate`, as a 401 must. When the relay could not check the page's sign-in
  (signing keys or token store unavailable, or its replay cache full), the answer is 503
  with `Retry-After` instead, so AI apps keep their tokens, and new requests get the same
  answer until the page's next assertion is checked, rather than "ask the user to sign in".
- Requests waiting for a page are capped by the page's own site limit
  (`maxConcurrentRequests`), as far as the relay has seen the page, instead of the
  instance's. Before, more could wait than the page could take, and the rest got 429
  when it came.
- While the relay shuts down, AI apps are told "The relay is restarting. Try again in a
  few seconds." (code `-31010`; a notification, also one already sent to the page, gets 503
  with `Retry-After`) instead of being asked to open the page.
- Store errors are logged with the error's name only (`error`), never its message, which
  a custom store may fill with token hashes or a connection string.
- A page message over the site's `maxMessageBytes` is refused by its length before it is
  parsed.
- The request body timer is cleared when reading the body fails.
- A `client_id` that is not a URL is logged as `(not a URL)` instead of with its text.

### Changed

- One grant (one AI app) may hold at most 2 `subscriptions/listen` streams on a page at
  once; a third gets 429 with `-31004`. Listen streams have no request timer, so one AI
  app could otherwise take every request slot of the page.
- `TokenStore.markUsed(hash, now, keepUntil)`: the relay passes now + 24 hours, and the
  store lowers the token's `expiresAt` to it in the same atomic step, so `deleteExpired`
  removes a used refresh token after one day instead of keeping it for its full 30
  days. A replay inside that window still revokes the grant; a later one is refused
  without revoking. Custom token stores should do the same (the conformance suite checks
  it; a store that ignores the argument keeps working but grows); the SQL and Redis
  sketches in the token store guide show how. The SQLite store (schema version 4) also
  cuts refresh tokens used before the upgrade to `used_at` + 24 hours when it opens the
  file; a custom store can do the same once, for example
  `UPDATE tokens SET expires_at = least(expires_at, used_at + 86400000) WHERE kind = 'refresh' AND used_at IS NOT NULL`,
  or leave them to expire (DEC-091).
- `/authorize` keeps a connection request only while the page's "Connect your AI app"
  dialog is open; otherwise it shows "Open “Connect your AI app” first" with Try again.
  An address holds at most 20 requests, 5 per network; past that the oldest request of
  the network holding the most is dropped instead of answering 429 (on a tie, of the
  network that came last). Someone who knows an address can no longer keep its owner
  from connecting by filling it, and a flood cannot push out a request the owner opened
  before it began (DEC-088).
- Client metadata fetches are limited per host (5, then 1 every 5 s) and per domain (the
  last two labels of the host: 15, then 3 every 5 s), so wildcard subdomains share one
  limit; a fetch the overall limit refuses no longer uses up the host's or domain's
  allowance, and the cache drops the least recently used document instead of the
  oldest (DEC-089).
- With identity binding, a connection request has one sign-in at a time: a new Connect
  replaces the earlier one, and each Connect that starts a sign-in counts against the
  same limits as a code guess. "Too many sign-ins are open" is answered with 429 and
  charges nothing (DEC-090).
- Refreshes are limited per connection: 20, then 1 a minute (`429`,
  `temporarily_unavailable`), which does not use up the refresh token (DEC-091).
- A client name that contains a domain other than the client's own host, such as
  "Claude · claude.ai" from `evil.example`, is refused like one with a web address in
  parentheses. Both checks ignore combining marks, and shown names lose variation
  selectors; an internationalised client may name its own domain in Unicode (DEC-092).

## [0.3.1][relay-0.3.1] - 2026-10-24

### Fixed

- An `initialize` request in a 2026-07-28 envelope (the `MCP-Protocol-Version: 2026-07-28`
  header and `_meta`) now reaches the page, which answers 404 with `-32601` (method not
  found), as the Streamable HTTP transport requires for a method the server does not
  have. Until now the relay answered 400 with `-32022`. An old-style `initialize`
  (2025-11-25 and earlier) still gets 400 with `-32022` and the supported version.

## [0.3.0][relay-0.3.0] - 2026-10-23

### Added

- Identity binding (`TAB_MCP_IDENTITY=oidc`, or `pairing: "oidc"` per site): an AI app
  connects without a code when the person signing in at your OpenID Connect provider is
  the person signed in to the page; anyone else gets "This AI tool is logged in as
  someone other than the page." The relay is a client of the provider
  (`TAB_MCP_OIDC_ISSUER`, `TAB_MCP_OIDC_CLIENT_ID`, `TAB_MCP_OIDC_CLIENT_SECRET`,
  `TAB_MCP_OIDC_SUBJECT_CLAIM`; callback `/authorize/callback`), and the page proves its
  user with a short JWT from the web app's backend (`TAB_MCP_TAB_ASSERTION_ISSUER`,
  `TAB_MCP_TAB_ASSERTION_JWKS_URL`). Settings are checked at start.
- Protocol: `identity`, `identity.bound`, `identity.logout`, error `identity_refused`,
  `session.pairing`, MCP error `-31009`. Logout in the page revokes the address's grants
  at once; a page that signs in as someone else revokes the previous person's grants.
- `TokenRecord.subject` and `GrantSummary.subject`: the hashed identity of a grant made by
  identity binding. Custom token stores must store and return it (the conformance suite
  checks it); a store that drops it refuses those grants. The SQLite store adds the
  column when it opens an older file.

### Changed

- A site without `pairing` now takes `TAB_MCP_IDENTITY` (default `code`, so nothing
  changes unless you set it); `resolveConfig()` no longer fills in `pairing: "code"`.

## [0.2.1][relay-0.2.1] - 2026-10-21

### Fixed

- `/healthz` sends `cache-control: no-store` and `/` a cache time of one hour. Without
  them bunny's CDN kept both for 30 days, so after the deploy of 0.2.0 `/healthz` still
  reported 0.1.0.

## [0.2.0][relay-0.2.0] - 2026-10-21

### Added

- `TAB_MCP_PAGE_WAIT_S` (default 10, at most 60, 0 = off): an MCP request whose page is
  not open waits that long for the page to open or reconnect, then is forwarded as usual.
  Phones pause a tab in the background, so this covers switching apps. The wait ends when
  the AI app closes the request; at most `TAB_MCP_MAX_CONCURRENT_REQUESTS` requests wait
  per address and `TAB_MCP_MAX_SESSIONS` in all. `server/discover` does not wait.

### Changed

- "The page is not open" is answered with HTTP 200 instead of 503, so AI apps keep using
  the 2026-07-28 protocol: an HTTP error made claude.ai and Claude Code fall back to the
  old `initialize` handshake, which the relay refuses, and the connection did not recover
  when the page came back. A `tools/call` gets a tool result with `isError: true` that
  tells the model to ask the user to open the page (by its app name) and keep it in
  front; `server/discover` gets a stand-in result with `ttlMs: 0`; other requests get the
  JSON-RPC error `-31001`. Notifications keep the 503.
- When the page closes its connection during a request, a `tools/list` waits for the page
  once more and is sent again; a `tools/call` is not sent twice and gets a tool result
  saying the page closed while the tool ran. Other requests get `-31003` at HTTP 200.

## [0.1.0][relay-0.1.0] - 2026-10-20

The first stable release, on the npm dist-tag `latest`; install without `@alpha`. The
image is `ractive/tab-mcp:0.1.0` and `ghcr.io/ractive/tab-mcp:0.1.0`, also tagged `0.1`
and `latest`.

### Added

- The `RevokeOptions` type is exported, for custom token stores.
- Package README with the quick start, the `tab-mcp` command and the library API.
- Documentation: configuration, self-hosting, token store, protocol, threat model and
  security policy, and the tab-mcp agent skill.

### Changed

- The relay's pages say "AI app" instead of "AI tool" and name the page's "Connect your
  AI app" dialog.

## [0.1.0-alpha.1][relay-0.1.0-alpha.1] - 2026-10-20

No changes to the relay. The first version published through the release workflow
(trusted publishing) to validate it, and the first Docker image:
`ractive/tab-mcp:0.1.0-alpha.1` and `ghcr.io/ractive/tab-mcp:0.1.0-alpha.1` for
linux/amd64 and linux/arm64, with provenance and SBOM attestations.

## [0.1.0-alpha.0][relay-0.1.0-alpha.0] - 2026-10-20

First alpha of the relay, on the npm dist-tag `alpha`, uploaded by hand from the
CI-signed tarball (no GitHub release, no Docker image). It runs on Bun 1.4.3 or newer.

### Added

- Tab sessions over a WebSocket (`/tab`, protocol `tab-mcp.v1`): page origins from an
  allow-list that is empty by default, a stable MCP address per page derived from a
  secret the page keeps, heartbeat, idle timeout and session lifetime.
- An MCP endpoint per address (`/a/<id>/mcp`) for MCP revision 2026-07-28 only. It
  forwards requests to the page, starts the event stream itself after 20 seconds, sends
  keep-alives, and limits body size, concurrent requests and request time. One exception
  for Claude's mismatched `MCP-Protocol-Version` header, counted in `/healthz`.
- OAuth 2.1 authorization server for AI apps: protected-resource and server metadata,
  clients through Client ID Metadata Documents only, PKCE S256, `iss`, a pairing page
  where the user types the code shown in the page, rotating refresh tokens with reuse
  detection, revocation, and a connection lifetime of at most 90 days after pairing
  (`TAB_MCP_GRANT_LIFETIME_S`).
- Per-site configuration (`TAB_MCP_SITES`): app name, pairing method and limits per page
  origin; `TAB_MCP_CLIENT_ID_HOSTS` to limit which AI apps may connect.
- `TokenStore` interface with SQLite (default) and memory stores, and the conformance
  suite `@ractive-ch/tab-mcp/testing` for custom stores.
- `createRelay()` for embedding, and the `tab-mcp` command configured with `TAB_MCP_*`
  environment variables (`tab-mcp --help`).
- `/healthz` with the version, and JSON-line logs that never contain request or response
  bodies.

[relay-0.10.3]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.10.3
[relay-0.10.2]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.10.2
[relay-0.10.1]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.10.1
[relay-0.10.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.10.0
[relay-0.9.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.9.0
[relay-0.8.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.8.0
[relay-0.7.1]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.7.1
[relay-0.7.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.7.0
[relay-0.6.1]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.6.1
[relay-0.6.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.6.0
[relay-0.5.1]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.5.1
[relay-0.5.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.5.0
[relay-0.4.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.4.0
[relay-0.3.1]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.3.1
[relay-0.3.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.3.0
[relay-0.2.1]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.2.1
[relay-0.2.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.2.0
[relay-0.1.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.1.0
[relay-0.1.0-alpha.1]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.1.0-alpha.1
[relay-0.1.0-alpha.0]: https://www.npmjs.com/package/@ractive-ch/tab-mcp/v/0.1.0-alpha.0
