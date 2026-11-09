# Configuration

The relay (`tab-mcp` command, Docker image `ractive/tab-mcp` and
`ghcr.io/ractive/tab-mcp`) reads its settings from environment variables. `tab-mcp --help`
prints the same list. A value the relay cannot use stops it at start with
`tab-mcp: configuration error: …` and exit code 2, so a wrong value never runs with a
silent default. A misspelled variable name is not detected: the relay ignores variables
it does not know and uses the default.

If you embed the relay with `createRelay()` from `@ractive-ch/tab-mcp`, pass the same
settings as options (`publicUrl`, `allowedOrigins`, `sites`, `maxSessionsPerIp`, …, in
milliseconds and bytes instead of seconds) and, if you like, your own token store
(see [token store](token-store.md)).

## The two settings you must set

```sh
TAB_MCP_PUBLIC_URL=https://relay.example.com
TAB_MCP_ALLOWED_ORIGINS=https://app.example.com
```

- `TAB_MCP_PUBLIC_URL` is the address AI apps and browsers use to reach the relay. The
  relay builds the MCP addresses (`https://relay.example.com/a/<id>/mcp`) and its OAuth
  issuer from it. It must be `https:` unless `NODE_ENV=development`.
- `TAB_MCP_ALLOWED_ORIGINS` lists the web pages that may connect, and browser extensions
  (see [Browser extensions](#browser-extensions)). Without it the relay starts, logs
  `relay.no_origins` and refuses every page.

## All variables

Times are in seconds, sizes in bytes. Every number except the port must be greater
than 0.

| Variable | Default | What it does |
|---|---|---|
| `TAB_MCP_PUBLIC_URL` | required | External origin of the relay, e.g. `https://relay.example.com`. Only the origin counts: no path, query or credentials. `https:` unless `NODE_ENV=development`. |
| `TAB_MCP_PORT` | `8080` | Port to listen on. |
| `TAB_MCP_HOST` | `0.0.0.0` | Address to listen on. |
| `TAB_MCP_ALLOWED_ORIGINS` | empty: no page may connect | Comma-separated page origins (`https://app.example.com`, or a Chrome or Edge extension's `chrome-extension://<id>`, see [Browser extensions](#browser-extensions)) allowed to open tab sessions with the default limits. `*` admits any website and any extension (an open relay, see below). |
| `TAB_MCP_SITES` | empty | JSON array of sites with their own app name or limits (see [Sites](#sites)). A site listed here needs no entry in `TAB_MCP_ALLOWED_ORIGINS`; an origin may appear in only one of the two. |
| `TAB_MCP_CLIENT_ID_HOSTS` | empty: any AI app | Comma-separated hosts whose AI apps may connect, compared exactly with the host of the app's client id URL. For example `claude.ai` admits Claude Code, whose client id is `https://claude.ai/oauth/claude-code-client-metadata`. An app that authenticates with `private_key_jwt` (ChatGPT) publishes its keys on the same host, so the list covers them too (DEC-106). |
| `TAB_MCP_TRUST_PROXY` | `none` | Where the client IP for rate limits comes from: `none` (the TCP peer), `x-real-ip`, or `x-forwarded-for` (its last entry, the one your proxy added). Set it only behind a proxy that sets the header; otherwise clients can choose their own IP. |
| `TAB_MCP_CORS` | `on` | `on` answers cross-origin requests to the MCP, OAuth metadata, token and revoke endpoints without credentials, so browser-based MCP clients work. `off` drops the CORS headers. |
| `TAB_MCP_STORE` | `sqlite` | Where grants and token hashes are kept: `sqlite` or `memory` (lost on restart). |
| `TAB_MCP_SQLITE_PATH` | `tab-mcp.db` | The SQLite file. The Docker image sets `/data/tab-mcp.db`. |
| `TAB_MCP_MAX_SESSIONS` | `500` | Tab sessions in total. |
| `TAB_MCP_MAX_SESSIONS_PER_IP` | `5` | Tab sessions per client IP (IPv6: per /64). |
| `TAB_MCP_MAX_CONCURRENT_REQUESTS` | `8` | MCP requests in flight per tab session; more get HTTP 429. |
| `TAB_MCP_REQUEST_TIMEOUT_S` | `300` | Longest time one MCP request may take; then HTTP 504 and the tab is told to stop. |
| `TAB_MCP_KEEPALIVE_S` | `20` | Interval of the `: keep-alive` comments on event streams. It is also how long the relay waits for the tab before it starts the event stream itself. |
| `TAB_MCP_IDLE_TIMEOUT_S` | `3600` | A tab session that gets no MCP request for this long is closed (close code 4002). |
| `TAB_MCP_UNPAIRED_IDLE_TIMEOUT_S` | `600` | A tab session that never had a grant, never started pairing, never had its user signed in and never got an MCP request is closed after this long instead (close code 4002, `bye` `idle`). A page with its pairing dialog open or an AI app paired is not affected. The browser extension connects again by itself; a web page shows that it is disconnected. See [self-hosting](self-hosting.md#sizing-the-session-limits). |
| `TAB_MCP_SESSION_LIFETIME_S` | `43200` | Longest life of one tab session (12 hours; close code 4001). |
| `TAB_MCP_HEARTBEAT_S` | `25` | Interval of the protocol `ping` to the tab. |
| `TAB_MCP_BODY_TIMEOUT_S` | `10` | Deadline for receiving an MCP request body; a slower client gets HTTP 408. |
| `TAB_MCP_PAGE_WAIT_S` | `10` | How long an MCP request waits for its page to open or reconnect (a phone pauses a tab in the background) before the relay answers "the page is not open". `0` answers at once; at most `60`. Waiting requests count against `TAB_MCP_MAX_CONCURRENT_REQUESTS` per address and `TAB_MCP_MAX_SESSIONS` in total; beyond that the relay answers at once. |
| `TAB_MCP_MAX_MESSAGE_BYTES` | `1048576` | Largest MCP request body and largest WebSocket message from the tab (1 MiB). At least `16384`. |
| `TAB_MCP_ACCESS_TOKEN_TTL_S` | `3600` | Access token lifetime (1 hour). |
| `TAB_MCP_REFRESH_TOKEN_TTL_S` | `2592000` | Refresh token lifetime (30 days). Every refresh issues a new refresh token. |
| `TAB_MCP_GRANT_LIFETIME_S` | `7776000` | Absolute end of a connection, counted from pairing (90 days). Refreshes never go beyond it; then the user pairs again. |
| `TAB_MCP_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`. Logs are JSON lines on stdout and never contain request or response bodies. |
| `TAB_MCP_IDENTITY` | `code` | How AI apps pair with pages of sites that do not set their own `pairing`: `code` (the code shown in the page) or `oidc` (the same sign-in, see [Identity binding](#identity-binding)). |
| `TAB_MCP_OIDC_ISSUER` | none | The OpenID Connect provider's issuer, e.g. `https://login.example.com`. Required when any site uses `oidc`. |
| `TAB_MCP_OIDC_CLIENT_ID` | none | The relay's client at that provider. Required for `oidc`. |
| `TAB_MCP_OIDC_CLIENT_SECRET` | none | Its client secret. Without it the relay is a public client (PKCE only). Keep it in your platform's secret store. |
| `TAB_MCP_OIDC_SUBJECT_CLAIM` | `sub` | The ID token claim compared with the page's user: `sub`, or `oid` for Microsoft Entra ID (whose `sub` differs per application). |
| `TAB_MCP_TAB_ASSERTION_ISSUER` | none | The `iss` of the tab assertions your web app's backend signs. Required for `oidc`. |
| `TAB_MCP_TAB_ASSERTION_JWKS_URL` | none | The URL of the public keys (JWKS) that sign those assertions. Required for `oidc`. |

`NODE_ENV=development` is for local testing only. It allows an `http:` public URL and,
without `TAB_MCP_PUBLIC_URL`, uses `http://localhost:<port>`, or
`http://127.0.0.1:<port>` or `http://[::1]:<port>` when `TAB_MCP_HOST` is that address. The Docker image sets
`NODE_ENV=production`.

The browser library refuses `http:` relays except on `localhost`, `127.0.0.1` and
`[::1]`, because the page sends its address secret to the relay.

## Sites

One relay can serve several pages. `TAB_MCP_SITES` gives a page origin its own settings:

```sh
TAB_MCP_SITES='[{"origin":"https://ractive.ch","name":"saturnus","limits":{"maxConcurrentRequests":4}}]'
```

Each site is an object with these keys:

| Key | Meaning |
|---|---|
| `origin` | The page origin: `https://…`, `http://…`, or `chrome-extension://<id>` for an extension. Required. |
| `name` | The app name the pairing page shows (1-64 characters). Without it the page's own `appName` is shown, which the page declares itself. |
| `pairing` | `code` (the code shown in the page) or `oidc` (identity binding). Without it the site uses `TAB_MCP_IDENTITY`. |
| `limits` | Overrides of the instance limits, in milliseconds and bytes: `maxMessageBytes`, `maxConcurrentRequests`, `requestTimeoutMs`, `keepAliveMs`, `idleTimeoutMs`, `sessionLifetimeMs`, `heartbeatMs`. |

Unknown keys stop the relay at start. With `TAB_MCP_ALLOWED_ORIGINS=*`, configured sites
keep their settings and every other origin gets the defaults.

## Browser extensions

A Chrome or Edge extension can offer tools too: the library runs in the extension's
service worker or one of its own pages (such as its side panel), and the relay sees the
extension's origin, `chrome-extension://` followed by its 32-letter id (DEC-108). A
service worker stays alive while it is connected: the relay's heartbeat (`ping` every
25 s by default, `heartbeatMs`) is WebSocket traffic, which keeps a service worker
running in Chrome 116 and later, as long as `heartbeatMs` stays under 30 s (Chrome
stops a worker after 30 s without events). A service worker has no `localStorage` and
no document, so pass two options there: `storage`, a synchronous `SecretStorage` kept
somewhere persistent (otherwise the address changes each time the worker starts), and
`onConfirm`, a question of your own (otherwise every tool marked `consequentialHint` is
refused). tab-mcp for Chrome keeps the secret in IndexedDB behind a cache and asks in
its side panel or a notification. List it like a
website, best as a site with a name, so the pairing page says "Overmark on the browser
extension `chrome-extension://…`" rather than only the id:

```sh
TAB_MCP_SITES='[{"origin":"chrome-extension://abcdefghijklmnopabcdefghijklmnop","name":"Overmark"}]'
```

- **Use a stable id, one per store.** An extension from a store has the same id on every
  installation from that store, but each store gives its own: the Chrome Web Store one,
  Microsoft Edge Add-ons another. An extension published in both needs both origins
  listed, one site per id with the same name (Edge users who install from the Chrome Web
  Store get its id). An unpacked extension gets an id from its folder path, unless its
  `manifest.json` has a `key`: set one, or every installation has another id and the
  relay refuses it.
- **Connect from an extension page, not a content script.** A content script's requests
  carry the origin of the website it runs in, so the relay would see that website.
- **Chrome and Edge only.** Firefox (`moz-extension://`) and Safari
  (`safari-web-extension://`) give every installation of an extension its own id, so no
  list can name them; the relay refuses those schemes at start. On a relay of your own,
  `TAB_MCP_ALLOWED_ORIGINS=*` admits them anyway (see [Open relay](#open-relay)).
- **Pairing.** Pair by code. Identity binding (`pairing: "oidc"`) works only if a backend
  signs tab assertions for the extension's user (see [Identity binding](#identity-binding)),
  which an extension usually does not have.

## Why the defaults are safe

- **No page can connect until you list it.** The origin list is empty by default. This
  keeps other websites from using your relay's address to look trustworthy. A non-browser
  program can fake the `Origin` header, so the list controls abuse; it does not protect
  users on its own.
- **Every MCP request needs a token,** and a token needs the pairing code shown only in
  the page, or, with identity binding, a sign-in as the page's own user. There is no
  setting that turns this off.
- **HTTPS is required** outside development, for the public URL and in the browser
  library.
- **Tokens are short-lived and stored as hashes.** Access tokens last 1 hour, refresh
  tokens rotate on every use, and a connection ends 90 days after pairing at the latest.
  The store keeps only SHA-256 hashes, so a copy of the database file contains no usable
  token.
- **Limits are on.** Sessions per IP and in total, message size, concurrent requests,
  request time, idle time and session lifetime all have limits, so one page or one client
  cannot hold the relay.
- **Logs contain no content.** Tool names, arguments, results, tokens, codes and secrets
  are never logged. Client IPs appear only in rate-limit warnings, shortened to /24
  (IPv4) or /48 (IPv6).
- **CORS has no credentials.** The relay sets no cookies on its API endpoints, and tokens
  travel only in the `Authorization` header, so another website gains nothing a server
  could not do. Set `TAB_MCP_CORS=off` if no browser-based MCP client needs the relay.

## Identity binding

With identity binding, an AI app connects to a page without a code if the person signing
in to the AI app's connection is the person signed in to the page, at the same OpenID
Connect provider (your organisation's login, Google, Keycloak, Auth0, Okta, Microsoft
Entra ID). Anyone else gets "This AI tool is logged in as someone other than the page."
and nothing is connected. Logging out of the page ends the AI connection at once.

It needs three things:

1. **The relay as a client of your provider.** Register a web application (confidential
   client) with the redirect URI `<TAB_MCP_PUBLIC_URL>/authorize/callback` and the scope
   `openid`. Set its issuer, client id and secret.
2. **Tab assertions from your web app's backend.** For the signed-in user, the backend
   signs a short JWT that the page hands to the library (see the client README):

   | Part | Value |
   |---|---|
   | header `typ` | `tab-mcp-identity+jwt` (required, so no other token of yours can be used instead) |
   | header `alg` | RS256/384/512, PS256/384/512, ES256/384/512 or EdDSA (Ed25519), with a `kid` from your JWKS |
   | `iss` | `TAB_MCP_TAB_ASSERTION_ISSUER` |
   | `sub` | the user's subject **at the provider**: the same value the provider puts in the claim `TAB_MCP_OIDC_SUBJECT_CLAIM` |
   | `aud` | the page's MCP address, `https://relay.example.com/a/<id>/mcp` (the library passes it to your code) |
   | `exp` | at most 60 seconds ahead |
   | `jti` | a unique id; the relay accepts each one once |

   Publish the public keys at `TAB_MCP_TAB_ASSERTION_JWKS_URL`. Only your backend may hold
   the private key, and it must sign only for its own signed-in user.
3. **A subject that is the same for both clients.** Your web app and the relay are two
   clients of the provider. Providers with pairwise subjects give each client its own
   `sub`: use the same sector identifier for both, or compare a claim that is the same
   across clients (`oid` with Entra ID). Never compare an e-mail address or a user name:
   they can change or be given to someone else.

```sh
TAB_MCP_IDENTITY=oidc
TAB_MCP_OIDC_ISSUER=https://login.example.com
TAB_MCP_OIDC_CLIENT_ID=tab-mcp-relay
TAB_MCP_OIDC_CLIENT_SECRET=…            # from your secret store
TAB_MCP_TAB_ASSERTION_ISSUER=https://app.example.com
TAB_MCP_TAB_ASSERTION_JWKS_URL=https://app.example.com/.well-known/tab-mcp-jwks.json
```

The relay checks these settings at start (`https:` URLs outside development, a client id,
`sub` or `oid`) and refuses `oidc` together with `TAB_MCP_ALLOWED_ORIGINS=*`. It loads the
provider's discovery document and keys when the first pairing page opens. One relay has
one provider and one assertion signer; a site with another needs its own relay. With
`TAB_MCP_SITES` a single site can use `oidc` while the others keep `code`.

The page's "Connect your AI app" dialog must be open while the AI app connects, as with
codes. Grants made this way remember (a hash of) the person: they work only while a page
signed in as that person is open, and a page that signs in as someone else ends them.
See the [threat model](threat-model.md) for what this does and does not protect.

## Open relay

> **Warning:** `TAB_MCP_ALLOWED_ORIGINS=*` lets any website open tab sessions on your
> relay. Its pages can then show your relay's address to their users and send their
> users' tool traffic through your server. The relay logs `relay.open_relay` at start.
> Use it only on a relay that you run for yourself, for development, or when you accept
> that any website can use it.

Users still have to pair each AI app with a code, and all limits still apply. Prefer a
list of origins or `TAB_MCP_SITES`.

## Examples

A relay for one site behind a reverse proxy, with the SQLite store:

```sh
TAB_MCP_PUBLIC_URL=https://relay.example.com
TAB_MCP_ALLOWED_ORIGINS=https://app.example.com
TAB_MCP_TRUST_PROXY=x-forwarded-for
TAB_MCP_SQLITE_PATH=/var/lib/tab-mcp/tab-mcp.db
```

A local relay for development, with tokens in memory:

```sh
NODE_ENV=development TAB_MCP_PUBLIC_URL=http://localhost:8080 \
  TAB_MCP_ALLOWED_ORIGINS=http://localhost:3000 TAB_MCP_STORE=memory tab-mcp
```

A local relay for an extension under development, whose `manifest.json` has a `key`:

```sh
NODE_ENV=development TAB_MCP_PUBLIC_URL=http://localhost:8080 TAB_MCP_STORE=memory \
  TAB_MCP_SITES='[{"origin":"chrome-extension://abcdefghijklmnopabcdefghijklmnop","name":"Overmark"}]' \
  tab-mcp
```

See [self-hosting](self-hosting.md) for Docker and reverse proxies.
