# Threat model

What tab-mcp protects, from whom, how, and what it cannot protect against. It describes
relay `@ractive-ch/tab-mcp` 0.4.0 and browser library `@ractive-ch/tab-mcp-client` 0.7.0,
with the changes listed under "Unreleased" in the changelog. To report a vulnerability,
see [SECURITY.md](../SECURITY.md).

## How it works, in short

A web page registers tools with the browser library. When the user clicks Connect, the
page opens a WebSocket to a relay and gets an MCP address. The user adds the address to an
AI app. The AI app signs in with OAuth on the relay, and the user proves that they can see
the page by typing a 6-digit code from the page into the relay's `/authorize` page. The AI
app then calls the tools; the relay forwards each request to the page, which runs the tool
and answers. See the [protocol](protocol.md) for the details.

## Assets

1. **The page's capabilities:** whatever its tools can read or do in the user's tab.
2. **Tool arguments and results** on their way through the relay.
3. **Tokens.** An access token lets its holder call the page's tools while the page is
   open, for up to 1 hour. A refresh token gives new access tokens for up to 30 days, and
   never beyond 90 days after pairing.
4. **The address secret** in the page's `localStorage`. Whoever has it can take over the
   address from anywhere: the AI apps already paired with it then talk to them instead of
   the page, until the page gets a new address (A4). They get no token and cannot pair a
   new app without a code.
5. **The token store** (a SQLite file by default): token hashes and grant details.
6. **The user's attention:** pairing dialogs and confirmations must not be spammed or
   confusing.
7. **The relay's availability** and its operator's bill.

## Who sees what

| Party | Sees | Trusted for |
|---|---|---|
| The page and its author | its own tools, the pairing codes | defining tools honestly; it already runs in the user's browser (see A10) |
| The relay operator | **every tool argument and result in clear text** (TLS ends at the relay), client ids, IP addresses, timing | not logging or changing traffic |
| The AI app | the tools it may call and their results | following the user's intent (a model drives it) |
| The model provider behind the AI app | the same as the AI app | nothing |
| The network | nothing: TLS everywhere, `wss:` and `https:` only outside development | nothing |

The relay cannot be made blind. The AI app speaks HTTPS to the relay, and the relay must
read the MCP request to forward it. If you do not trust a relay's operator, run your own
relay ([self-hosting](self-hosting.md)).

## Attackers and what stops them

### A1: Someone who learns the address

From a shared screenshot, a chat log or over the user's shoulder.

- The address alone grants nothing. Every MCP request needs a token, and a token needs
  the pairing code that only the page shows.
- The pairing code has 6 digits, works once, is valid for 2 minutes and allows 5
  attempts. The relay issues codes only while the page's "Connect your AI app" dialog is
  open. Without a view of the page, an attacker has 5 guesses in a million per code.
- Guesses are also limited per address and network (10, then 1 a minute) and per address
  overall (30, then 1 every 30 seconds). Only a well-formed code against an active code
  counts, so junk input cannot lock the owner out. Even an attacker who keeps fresh codes
  coming gets about 2 880 guesses a day per address against a million codes, and only
  while the user keeps the dialog open.
- An attacker on many networks can use up the per-address allowance and make the owner
  wait. "New address" in the page ends that, because the attacker does not learn the new
  address. Per-IP limits count an IPv6 /64 as one network.
- `/authorize` opens a connection request only while the dialog is open, and an address
  holds at most 20, at most 5 per network. Past that the oldest request of the network
  holding the most is dropped (on a tie, of the network that came last), so knowing an
  address is not enough to keep its owner from connecting. Left over: an attacker who
  keeps the address full from many networks can push out a request the owner opens
  after the flood began; "New address" ends it. With identity binding, each request has one sign-in at a time, and
  each Connect that starts one counts like a guess.
- Without a token, every address looks the same: no 404 for unknown addresses, so
  addresses cannot be probed.
- "New address" in the page revokes the old address's connections and replaces the
  secret.
- Left over: a user who reads the code out to someone else, or types it for an AI app an
  attacker started. The pairing page names the AI app and the page origin.
- On a page that pairs by code, grants follow the browser profile, not the person: the
  address secret is in the profile's `localStorage`, and the relay knows nobody else. On
  a shared profile, or in a web app with accounts that pairs by code, the next user of the
  page gets the AI apps the previous one paired. Use identity binding (A12) for such
  pages, or call `newAddress()` when the user logs out.

### A2: A malicious or impersonating AI app (OAuth client)

- AI apps register only through Client ID Metadata Documents. The `client_id` is an
  HTTPS URL that the relay fetches. The document's `client_id` must equal that URL, and
  the `redirect_uri` must be listed in it, exactly. Only loopback redirects ignore the
  port (RFC 8252).
- The pairing page shows the declared name **and** the verified host of the client id.
  A client that calls itself "Claude" from `evil.example` shows `evil.example`. The
  heading reads "Connect <name> from <verified host>".
- PKCE S256 is required. Authorization codes work once, live 60 seconds, are bound to the
  client id, redirect URI and resource, and are used up by their first presentation even
  if a check then fails. A code presented twice revokes the grant made with it. Every
  response carries `iss` (RFC 9207) against mix-up attacks.
- The `client_id` must be its own canonical URL, so look-alike spellings (case, dot
  segments, explicit ports) are refused.
- Redirect URIs must be `https:`, `http:` on a loopback host, or a native app scheme in
  reverse-domain form (`com.example.app:/callback`). Invalid requests are shown on a relay
  page with a link back instead of being redirected, so the relay cannot be used as an
  open redirector. Only the user's own Cancel redirects at once.
- Shown names lose invisible and format characters. Names with a web address in
  parentheses are refused, because they would look like the verified host, and so are
  names with any domain other than the client's own host ("Claude · claude.ai" from
  `evil.example`), also when combining marks or look-alike dots hide it. A domain
  spelled in words ("claude dot ai") still passes; the verified host in the heading is
  the defence there.
- "Verified host" means only that the document was served from that host over HTTPS;
  any host qualifies. An operator can limit which AI apps may connect with
  `TAB_MCP_CLIENT_ID_HOSTS`.

### A3: Server-side request forgery through client metadata fetches

The relay fetches a URL chosen by an unauthenticated party. Guards:

- `https:` only, default port only, no credentials in the URL;
- the host is resolved first. Private, loopback, link-local, CGNAT and multicast ranges
  (IPv4 and IPv6) are refused, and a host name is refused if any of its addresses is not
  public;
- the fetch connects to the address that passed the check, with the original `Host` and
  TLS server name, so DNS rebinding between check and connect cannot reach another
  address;
- no redirects, a 5 second timeout, a 64 KiB limit, `application/json` only;
- responses are cached as their `Cache-Control` says (at least 5 minutes, at most 24
  hours);
- fetches are rate-limited per host (5, then 1 every 5 seconds), per domain (the last
  two labels of the host, so subdomains share one limit: 15, then 3 every 5 seconds) and
  overall (30, then 1 a second); a fetch the overall limit refuses costs its host and
  domain nothing, and the cache drops the least recently used document first. Left
  over: all clients under a multi-label suffix such as `co.uk` or `pages.dev` share one
  domain limit, so an attacker with many hosts there can keep their uncached fetches
  refused;
- every failure from resolving to parsing shows the same message, so the page cannot be
  used to probe what answers where.

### A4: Token theft and replay

- Tokens are 256-bit random values. The store keeps only their SHA-256 hashes, so a stolen
  store file contains no usable token. Tokens are accepted only in the `Authorization`
  header and only for their own address.
- Access tokens live 1 hour. Refresh tokens live 30 days, rotate on every use, and never
  outlive the grant's absolute end, 90 days after pairing. Reusing an old refresh token
  revokes the whole grant: that cuts off the thief and the victim alike and shows the
  theft. Marking a refresh token as used is atomic, so of two racing refreshes exactly one
  wins and the other counts as reuse. A used refresh token is kept for 24 hours to detect
  that; replayed later, it is unknown and refused without revoking. A refresh token
  presented by another client id is refused without revoking.
- Revocation leaves a tombstone in the store, and the store refuses new tokens for a
  revoked grant atomically. A refresh that races Disconnect cannot bring the grant back.
- Disconnect in the page revokes at once. "New address" revokes all grants of the old
  address.
- Tokens are useless while the page is closed: requests get "the page is not open" (HTTP
  200 with a JSON-RPC error or tool error, after waiting up to `TAB_MCP_PAGE_WAIT_S` for
  the page). Waiting requests are bounded per address and in total, only requests
  with a valid token for that address wait, and only requests of at most 16 KiB, so
  all waiting requests together hold a few MiB. One actor with many self-made addresses
  can fill the total and so switch the wait off for others: they then get the immediate
  answer, as before the wait existed. There is no per-IP share, because AI apps' requests
  come from a few shared addresses (all claude.ai users from Anthropic's).
- The relay never forwards the `Authorization` header to the page.

**A stolen address secret.** The page keeps its address secret in `localStorage`, one
per relay and page. Whoever has the secret can send `hello` with it from anywhere, with
any `Origin`, and the newest session for an address wins: the page gets `replaced` and
does not reconnect by itself.

- **Who can get it:** script on the page's origin (cross-site scripting, a compromised
  third-party script or dependency, another page on the same origin, such as other pages
  of the same site or a shared `*.github.io` origin), or access to the device or browser
  profile (malware, an extension with access to the page, a shared computer). A network
  attacker cannot (TLS); the relay operator sees it anyway.
- **What the holder gets:** every AI app already paired with the address talks to them
  instead of the page. They see every argument the AI app sends, which can carry data
  from the chat. They write the tool descriptions and results, so they can put
  instructions into the user's AI session, which may have other tools (mail, files,
  code). That is the real damage; fake results for the page's own tools are minor next to
  it.
- **What the holder does not get:** no token (tokens stay with the AI apps, the store
  keeps only hashes), no new AI app without a code the page shows, and nothing at all on
  a page that pairs by identity binding, where a session needs a fresh assertion from the
  site's backend (A12).
- **How long it lasts:** after the XSS is fixed, the page is closed or the script is
  removed, until the page gets a new address. "New address" first takes the address back
  with the old secret and `hello.revokeAll`, so the relay revokes the grants of the old
  address in the same step as it hands the address back; whoever claims it again right
  after gets no grant back. Only once the relay confirmed it (no grants in `session`)
  does the page make the new address; taken over again first, the page says so and the
  user tries again.
- **What the page sees:** the library tells a takeover by a second tab of the same page
  from one by someone else. Tabs that share the secret say on a `BroadcastChannel` (per
  relay origin and storage key, never the secret or the address) when the relay accepted
  their session; a tab whose `hello` failed says nothing. A replaced tab that heard a
  sibling within 10 seconds (waiting up to a second for it) reports `sibling: true` and
  the default UI shows "Opened in another tab". Otherwise, and in browsers without
  `BroadcastChannel`, it warns that another tab or program took over and offers "New
  address". A message on the channel from script on the page's origin can make a
  takeover look harmless, but such script can read the secret and change the page
  anyway, so the channel adds no new attacker. With a `storage` other than
  `localStorage` that tabs do not share (say `sessionStorage`), a sibling that connects
  within those 10 seconds can make an unrelated takeover look harmless.
- **What helps:** identity binding for pages with user accounts; the page on its own
  origin, without third-party scripts; `newAddress()` on logout on a shared device.
  A backend-signed claim of the address was considered and not built (DEC-094): without a
  signed-in user it proves nothing, and with one, identity binding already gives most of
  it.

### A5: Other websites using someone's relay

- Pages may connect only from allowed origins, and the list is empty by default. An open
  relay needs `TAB_MCP_ALLOWED_ORIGINS=*` and logs a warning at start. This stops other
  websites in a browser. A non-browser client can fake `Origin`, so the list controls
  abuse; it is not a security boundary for users.
- Limits: sessions per IP (5) and in total (500), message and body size (1 MiB),
  concurrent requests per session (8), request timeout (300 seconds), idle timeout and
  session lifetime.

### A6: The AI app, or a prompt injection, misuses the tools

- Read-only and harmless tools run directly. Tools marked `consequentialHint` ask in the
  page before each run, showing the AI app and the arguments. The page's question does
  not depend on the AI app.
- Consent per tool is the page's, not the relay's: the relay has one OAuth scope,
  `tools`, which covers every tool of the page. "Always allow" in the page's confirmation
  is off unless the page turns it on (`alwaysAllow: true`, DEC-096), since it lifts the
  only brake at run time for that tool and AI app until the page is reloaded or the app
  disconnected, which is what a prompt injection needs.
- Annotations reach the AI app as MCP hints (`readOnlyHint`, `destructiveHint`), so the
  AI app can ask too.
- Tools marked `untrustedContentHint` are announced with `openWorldHint: true` and the
  original hint in the tool's `_meta`, so AI apps can treat that tool's results as
  untrusted data. The results themselves carry no marker.
- The page lists the connected AI apps; the user can disconnect each at any time.

### A7: Cross-site attacks on the relay's pages

- `/authorize` sends a strict Content Security Policy (`default-src 'none'`, styles from
  the relay only, `frame-ancestors 'none'`, `form-action` limited to the relay and the
  client's redirect origin), `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` and
  `Cache-Control: no-store`. The page has no JavaScript. Framing is refused, so the code
  field cannot be overlaid.
- The form posts only the id of a pending request. Its CSRF token is bound to that
  request and to a first-party `HttpOnly`, `SameSite=Lax` cookie. Posts with a foreign
  `Origin` or `Sec-Fetch-Site` are refused. The page sets no `Cross-Origin-Opener-Policy`,
  because claude.ai opens it in a popup and needs its opener back.
- Every value shown on the page (client name, page origin) is HTML-escaped and
  length-limited.
- The metadata, token, revoke and MCP endpoints answer CORS requests from any origin
  without credentials (`Access-Control-Allow-Origin: *`, never `Allow-Credentials`).
  They use no cookies, and tokens travel only in the `Authorization` header, so another
  website can do nothing a server could not. `TAB_MCP_CORS=off` turns CORS off.

### A8: Denial of service

In-memory rate limits cover `/authorize` page loads and posts per IP, code guesses per
address and network and per address, `/token` and `/revoke` per IP, refreshes per grant,
and metadata fetches per domain and overall. IPv4 counts per address, IPv6 per /64. Sessions are limited per IP
on `/tab`, and concurrent requests per session on the MCP endpoint. Requests waiting for
a page that is not open are limited per address and in total, and only a valid token for
that address makes a request wait. Pending
authorizations and codes live in bounded maps that expire. Every WebSocket send is
checked: a send dropped under backpressure fails its request instead of hanging it. A
single relay can still be flooded; put a CDN or proxy in front of it against volumetric
attacks.

### A9: Logs and privacy

Logs are JSON lines with the event, a shortened address id, the session id, the MCP
method, the HTTP status, the duration, the client id host and coarse error codes. They
never contain bodies, tool names, arguments, results, tokens, codes or secrets. Client
IPs appear only in rate-limit warnings, shortened to /24 (IPv4) or /48 (IPv6). An
operator should tell users this in a privacy notice.

### A10: A page that misleads (phishing)

**Connecting an AI app to a page means trusting that page,** as with any MCP server. The
page's tool descriptions and results reach the model. A page can describe a tool in
misleading ways, or return text that steers the model. tab-mcp cannot judge a page's
honesty. The pairing page names the page's origin so that the user knows whom they
trust; that origin is what the page's browser reported, and a program can claim any
(A11). The closed origin list keeps other sites from borrowing a relay's domain to look
trustworthy.

### A11: Several sites on one relay

- One relay may serve several sites, each configured by origin. The relay takes the
  origin from the `Origin` header of the page's WebSocket and checks it against the
  list. The app name a page sends is its own claim, so the pairing page shows the name
  next to the origin: "saturnus on `https://ractive.ch`".
- **The origin on the pairing page is reported, not verified.** A browser sends the
  page's true origin, but a program can claim any origin, including a listed one, and
  then shows its own code under that origin. The origin tells the user which page
  connected only when the code came from a page they opened themselves. Only identity
  binding (A12) ties a session to the site's backend.
- Pages on the same origin can claim each other's names. That is acceptable: they share
  a trust domain anyway (same-origin pages can read each other's `localStorage`).
- A configured site `name` replaces the page's claim.
- Sites on one relay share one operator, one store and one log. A project that needs
  separation runs its own relay.

### A12: Identity binding (sites with `pairing: "oidc"`)

Instead of a code, the user proves at `/authorize` that they are the page's user by
signing in at the configured OpenID Connect provider. Two statements are compared: the
web app's backend says who is signed in to the page (a tab assertion), the provider says
who signed in at `/authorize` (an ID token).

- **Someone else signs in.** Another person, or someone who only knows the address, gets
  "This AI tool is logged in as someone other than the page." and nothing is issued. The
  comparison happens when the provider sends the browser back, against the page's
  binding at that moment, so a page that signed out meanwhile pairs nobody.
- **Forged or replayed tab assertions.** The relay accepts only JWTs signed by a key of
  the configured JWKS, with `typ` `tab-mcp-identity+jwt` (so an ID token or access token
  signed with the same key is refused), the configured `iss`, `aud` exactly the page's
  address, `exp` at most 60 s ahead and a `jti` it has not seen. `none`, HMAC and keys
  embedded in the token are refused; each algorithm is tied to its key type. An assertion
  for one address is useless at another, and sending one at all needs the address
  secret. The web app's own ID token is never accepted: its audience is the web app.
- **Forged ID tokens or a hijacked sign-in.** The relay is an ordinary OIDC client:
  authorization code with PKCE S256, `state` and `nonce`, both random and single-use,
  bound to the pending request and to the browser's visit cookie (a callback in another
  browser is refused), and `iss` in the response checked when present. The ID token is
  validated as OpenID Connect Core says (signature with the provider's keys, `iss`, `aud`,
  `azp`, `exp`, `iat`, `nonce`).
- **Phishing the user into a sign-in.** Someone who sends the user an `/authorize` link
  for their own AI app would only need a click on Connect if the user is signed in at the
  provider. The page's "Connect your AI app" dialog must be open, as with codes, and the
  pairing page names the AI app and its verified host. The same click-through risk exists
  for every OAuth consent page.
- **A different person later uses the same browser.** Grants remember a hash of the
  person they were made for. MCP requests reach the page only while it is bound to that
  person; a page that proves another person revokes the previous person's grants and ends
  their requests in flight. A page that is open but not signed in gets nothing forwarded.
- **Logout.** `signOut()` in the page revokes every grant of the address at once and ends
  requests in flight. A logout while no page is open needs nothing: the grants work only
  while a page signed in as the same person is open. The web app must call `signOut()` in
  its open pages when its user logs out.
- **What it does not protect.** The AI app then acts with exactly the rights of the
  page's user, so a taken-over provider account also gives the AI connection. A web app
  backend that signs assertions for users who are not signed in, or a leaked assertion
  key, lets anyone pair with that user's pages: keep the key like a session-signing key.
  The relay's client secret lets its holder act as the relay at the provider; keep it in
  the platform's secret store. Pairwise subjects can make the same person look like two
  (see [configuration](configuration.md#identity-binding)); comparing an e-mail address
  instead is refused, because e-mail addresses change hands.

## Safe defaults

- No page origin is allowed until configured; `*` only explicitly, with a warning.
- `TAB_MCP_PUBLIC_URL` must be `https:` unless `NODE_ENV=development`.
- There is no unauthenticated MCP mode, not even as a setting.
- The browser library talks to `http:` relays only on `localhost`, `127.0.0.1` and
  `[::1]`.
- Sessions start only from a click: `connect()` refuses to run without a user action
  where the browser reports it (`navigator.userActivation`). This guards against
  accidental connects; it is not a security boundary, since a page can always open a
  WebSocket itself.

See [configuration](configuration.md#why-the-defaults-are-safe) for the reasons behind
each default.

## Risks that remain

- The relay operator can read and change all traffic. What helps: the code is open,
  you can run your own relay, and the relay logs no bodies. It cannot be solved with MCP
  over HTTPS.
- Users who give the pairing code to someone else, or type it for an AI app they did not
  start.
- A page that misleads the AI app (A10).
- Whoever copies the address secret (script on the page's origin, or access to the
  device or browser profile) can take over the address, also while the page is open. The
  AI apps paired with it then send their arguments to them and get their tool
  descriptions and results, which can steer the user's AI session; this lasts until the
  page gets a new address. They get no token and cannot pair a new app without a code.
  The page says that its address was taken over and offers a new one, but cannot prevent
  it; identity binding does (A4, A12). Pages must keep cross-site scripting out, as for
  any session secret.
- The page origin shown at pairing is what the page's browser reported; a program can
  claim any origin (A11).
- On a page that pairs by code, the next user of the same browser profile gets the AI
  apps the previous one paired (A1).
- A model can be steered by content (prompt injection) into calling tools the user did
  not intend. The page's confirmation covers consequential tools only, and consent per
  tool is the page's: one `tools` scope covers every tool (A6).
- AI app names are self-declared; only hosts are verified.
- The relay accepts one known client bug: the header `MCP-Protocol-Version: 2025-11-25`
  with a body that declares `2026-07-28`. It is limited to this exact pair.

- With identity binding: a taken-over account at the provider, a leaked assertion key or
  a web app that vouches for the wrong user (A12).
