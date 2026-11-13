# Threat model

What tab-mcp protects, from whom, how, and what it cannot protect against. It describes
relay `@ractive-ch/tab-mcp` 0.9.0, browser library `@ractive-ch/tab-mcp-client` 0.15.0
and the browser extension tab-mcp for Chrome 0.1.0 (not yet in the Chrome Web Store,
A13).
To report a vulnerability,
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
   the page, until the page gets a new address (A4). They get no token of those apps, but
   the relay sends them the pairing codes, so they can pair an AI app of their own, which
   later reaches the real page once it holds the address again (A4).
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
| An agent in the browser (only with `webmcp: true`, A14) | the tools the page mirrors into WebMCP and their results | nothing |
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
- An AI app may authenticate at `/token` with `private_key_jwt` (DEC-106): a JWT signed
  with a key it publishes at the `jwks_uri` of its document, which must be on the client
  id's own host. The relay accepts only asymmetric algorithms, each tied to its key type,
  takes keys only from that JWKS (never from the token's header), and requires `iss` and
  `sub` equal to the client id, `aud` naming the relay, `exp` at most an hour ahead, use
  within five minutes of `iat`, and a `jti` it has not seen. This proves the request
  comes from whoever controls the client id's host; it says no more about who that is
  than the verified host does. Client secrets are refused. A document whose keys the
  relay cannot use but that lists `none` is a public client (DEC-104).
- Another client cannot spend a code it did not get: the code's client id is checked
  before the code is used up or its reuse revokes anything, so a leaked code presented
  with a valid assertion for the attacker's own client changes nothing.

### A3: Server-side request forgery through client metadata fetches

The relay fetches a URL chosen by an unauthenticated party. Guards:

- `https:` only, default port only, no credentials in the URL;
- the host is resolved first. Private, loopback, link-local, CGNAT and multicast ranges
  (IPv4 and IPv6) are refused, and a host name is refused if any of its addresses is not
  public;
- the fetch connects to the address that passed the check, with the original `Host` and
  TLS server name, so DNS rebinding between check and connect cannot reach another
  address;
- no redirects, a 5 second timeout for the DNS lookup and the fetch together, a 64 KiB
  limit, `application/json` only;
- responses are cached as their `Cache-Control` says (at least 5 minutes, at most 24
  hours);
- fetches are rate-limited per host (5, then 1 every 5 seconds), per domain (the last
  two labels of the host, so subdomains share one limit: 15, then 3 every 5 seconds) and
  overall (30, then 1 a second); a fetch the overall limit refuses costs its host and
  domain nothing, and the cache drops the least recently used document first. Left
  over: all clients under a multi-label suffix such as `co.uk` or `pages.dev` share one
  domain limit, so an attacker with many hosts there can keep their uncached fetches
  refused;
- a fetch for a client id the relay has not seen is charged to the requesting network
  first (5, then 1 a minute, per IPv4 address or IPv6 /56; DEC-129), before the overall
  limit, at `/authorize`, `/token` and `/revoke`. One network can therefore no longer keep
  the overall budget empty; doing so now takes about 60 networks, and with the client
  host list set (`TAB_MCP_CLIENT_ID_HOSTS`) none of this is reachable;
- every failure from resolving to parsing shows the same message, so the page cannot be
  used to probe what answers where.

The `jwks_uri` of a `private_key_jwt` client is fetched under the same guards and limits
(also `application/jwk-set+json`), and only on the host of the client id, so it reaches
no host the metadata fetch could not. It is fetched when a token or revocation request
carries a client assertion, cached 10 minutes, and fetched again for an unknown key id at
most every 5 seconds (at most every 30 seconds after a failure). Anyone can send token
requests for made-up client ids, so the protection of AI apps that already have grants
is layered (DEC-106):

- a failed or refused fetch, a key id the relay could not look for yet, and a client id
  on a private address all answer 503 (try again) at `/token` and `/revoke`, never
  `invalid_client`, so a client keeps its grant;
- documents the relay already holds are refreshed from their own budget, and keys are
  fetched from another, so requests for unknown client ids cannot use up either, and
  key fetches (anyone can cause one every 5 seconds with a made-up key id) cannot use up
  document refreshes; a failed fetch is answered again for a minute per client id, so
  made-up paths on a real host cost one fetch each per minute;
- `/token` and `/revoke` use the last good document for up to an hour past its cache
  lifetime, and the old keys for an hour after a failed key fetch;
- the caches of documents and keys give each domain at most 100 of their 1000 places,
  and a new entry pushes out the least recently used of the domain that holds the most.

What is left: an attacker can still delay such a client. Made-up key ids for a real
client keep that client's key budget near empty, so a key rotation may be seen a few
attempts late; with about 17 registrable domains of its own it can use up the totals of
the known-client budgets; with about 1000 it can push a rarely used client out of the
caches; a relay that has just started knows no client, so made-up ids on a real AI
app's host can keep that app's first fetch waiting; and an attacker with about 60
networks can keep the overall budget for new client ids empty, so an AI app the relay
has not cached cannot pair ("The relay is busy"). Each of these gives the AI app 503s,
which it retries, not a lost grant, unless they last longer than the grace hour. A relay
that sets `TAB_MCP_CLIENT_ID_HOSTS` is not exposed to any of them.

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
- A grant made or refreshed with a `private_key_jwt` client assertion is bound to it
  (DEC-106): its refresh tokens are refused without a valid assertion, before reuse is
  checked, and `/revoke` refuses its tokens without one, so a stolen refresh token alone
  can neither be redeemed nor end the grant; the thief also needs the AI app's private
  key. A client whose document lists only `private_key_jwt` needs an assertion for every
  code too. One that also lists `none` (ChatGPT) can still make public grants, which are
  as exposed as any public client's. Each assertion's `jti` is accepted once while the
  assertion is usable (at most five minutes); with several instances that holds across
  them only with a store that implements `claimNonce`. Anyone can be a client, so each
  AI app host may hold only its share of the replay store (10 000 live entries per
  instance); one that fills it gets 503 alone.
- Revocation leaves a tombstone in the store, and the store refuses new tokens for a
  revoked grant atomically. A refresh that races Disconnect cannot bring the grant back.
- Disconnect in the page revokes at once. "New address" revokes all grants of the old
  address. A revocation also ends what the grant has under way: its requests in flight
  and open listen streams end (HTTP 401 or an error event, and the page is told to stop
  them), and a request that was authenticated before but is still waiting for its page
  checks its token again before it is forwarded, so it does not reach the page either.
  A grant's creation time is that of its authorization code, so a code issued before
  "New address" or "revoke all" makes no grant afterwards; the relay also drops the
  address's open authorization requests and codes then. With several instances, a
  request in flight on the page's instance ends only when the revocation happens there
  (the page's Disconnect, "New address"); after a revocation on another instance
  (`/revoke`) a request already forwarded runs to its end, a listen stream until the
  page's session ends.
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
- **They can also pair an AI app of their own, and it outlasts the takeover.** To the
  relay, the session that holds the address *is* the page: when it starts pairing, the
  relay sends the pairing codes to it, so the holder can connect any AI app they control,
  with the code they were sent. That grant belongs to the address, not to the session.
  When the owner's page connects again later without having seen `replaced` (it was
  closed during the takeover, is reloaded, or the browser extension reconnects on its
  own), the relay hands the address back to it, and the holder's AI app then calls the
  **real page's tools**, with the page's data and the user's signed-in state, until that
  grant is disconnected or the page gets a new address. Consequential tools still ask in
  the page before each run (A6); everything else runs. The page lists the AI app among
  its connected apps (by the name and host the app declared at pairing), which is the
  only sign of it.
- **What the holder does not get:** no token of the AI apps the user paired (tokens stay
  with the AI apps, the store keeps only hashes), and nothing at all on a page that pairs
  by identity binding: a session needs a fresh assertion from the site's backend to take
  requests, and pairing needs a sign-in as the page's user (A12).
- **How long it lasts:** after the XSS is fixed, the page is closed or the script is
  removed, until the page gets a new address, and an AI app the holder paired lasts until
  it is disconnected or the page gets a new address (a grant ends 90 days after pairing at
  the latest). "New address" (`newAddress()`) always first takes the address back with
  the old secret and `hello.revokeAll`, connected or not, taken over or not (DEC-136), so
  the relay revokes the grants of the old address in the same step as it hands the
  address back; whoever claims it again right after gets no grant back. It takes back
  the stored secret's address; a tab that rotated the secret before took its own old
  address back the same way. Requests already on their way under a revoked grant are
  refused before they reach the page, requests in flight and open listen streams of the
  grant end, and authorization codes the address was given before are void, so a pairing
  the holder finished just before does not become a grant either. Only once the relay
  confirmed it (no grants in `session`)
  does the page make the new address; taken over again first, or the relay unreachable,
  the page keeps the old secret, says so, and the user tries again.
- **What the page sees:** the library tells a takeover by a second tab of the same page
  from one by someone else. Tabs that share the secret say on a `BroadcastChannel` (per
  relay origin and storage key, with the address id, never the secret) when the relay
  accepted their session; a tab whose `hello` failed says nothing. A replaced tab that
  heard a sibling claim its own address within 10 seconds, after its own session started
  (waiting up to a second for it), reports `sibling: true` and
  the default UI shows "Opened in another tab". Otherwise, and in browsers without
  `BroadcastChannel`, it warns that another tab or program took over and offers "New
  address". A message on the channel from script on the page's origin can make a
  takeover look harmless, but such script can read the secret and change the page
  anyway, so the channel adds no new attacker. The address id is in the MCP address,
  which is no secret either. A tab on another address, or one that claimed while this
  tab was still connecting, does not count. A claim without an address, from a tab on
  a library up to 0.15, still counts while both versions run.
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
- Limits: sessions per IP (5; IPv6 per /64 and per /56) and in total (500), message and
  body size (1 MiB), concurrent requests per session (8), request timeout (300 seconds),
  a short idle timeout for sessions nobody paired with (10 minutes), idle timeout and
  session lifetime.

### A6: The AI app, or a prompt injection, misuses the tools

- Read-only and harmless tools run directly. Tools marked `consequentialHint` ask in the
  page before each run, showing the AI app and the arguments. The page's question does
  not depend on the AI app. A `consequentialHint` that is not a boolean is refused at
  registration, not dropped, so a typo cannot turn the question off.
- The library's dialog shows one question at a time, and Allow is enabled only after
  the page was seen for the delay with that dialog on top and the arguments were
  scrolled to their end: the AI app chooses the order of the keys, so it could put the
  one that matters below the fold.
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
and metadata fetches per domain and overall. IPv4 counts per address, IPv6 per /64
(per /56 where noted below).

- Only wrong code guesses are charged; a right code gives its share back. The cap per
  address never forgets a bucket that still counts something to make room: when its map
  is full (100 000 addresses), guesses at new addresses are refused until buckets have
  refilled, so cycling through many keys cannot reset an address's allowance. Filling it
  takes wrong guesses at 100 000 addresses with a live code and an open request each.
  The share per address and network drops its oldest bucket when full: that only lets a
  network use more of the allowance the per-address cap still limits, and refusing there
  would let a few networks block everyone's first guess.
- `/token` and `/revoke` have two limits per IP. Failed requests (client errors) are
  limited to 30, then one a second; past that a request that fails is answered 429, but a
  request that succeeds (a valid code, refresh token or token to revoke of its client) is
  never refused by it. The users of one hosted AI app, who come from a few shared
  addresses, therefore do not block each other with stale tokens. Every request, success
  or not, counts against a ceiling of 600, then 20 a second: about 72 000 connected users
  of one AI app per egress address, each refreshing once an hour. It bounds the work and
  store writes from one network, also from someone rotating through many grants. Neither
  is keyed by `client_id`, which any request can name: that would let anyone use up a
  well-known AI app's allowance.

Sessions are limited per IP
on `/tab` (an IPv6 /64 and its /56 must each stay under the limit, since one subscriber
often gets a whole /56), and concurrent requests per session on the MCP endpoint. A
session that never had a grant, never started pairing, never had its user signed in and
never got a request is closed after 10 minutes (`TAB_MCP_UNPAIRED_IDLE_TIMEOUT_S`). Any
program that sends an allowed `Origin` can still hold session slots, from enough
networks, by doing what a real page does (see [self-hosting](self-hosting.md#known-limit-session-slots)). Requests waiting for
a page that is not open are limited per address and in total, and only a valid token for
that address makes a request wait. Pending
authorizations and codes live in bounded maps that expire. Every WebSocket send is
checked: a send dropped under backpressure fails its request instead of hanging it. A
single relay can still be flooded; put a CDN or proxy in front of it against volumetric
attacks.

- **Open authorization requests** (DEC-129) are capped at 10 per network, where an IPv6
  network is a /56 (one subscriber's), 20 per address and 10 000 per instance. When the
  instance is full, a new request evicts one instead of being refused: first the oldest
  request whose page is gone or whose dialog is closed (it cannot pair now), else the
  oldest of the network holding the most. A party that fills the total therefore pushes
  out its own requests, not the one of a user whose dialog is open.
- **Control messages from a tab** (everything but `pong` and the `http.response*`
  answers) have a budget per session: 30, then 2 a second. Past it the relay sends
  `rate_limited` and closes with 4008. A second "revoke all" of an address within a
  second does not write to the store again.
- **Request bodies** at `/token`, `/revoke`, `POST /authorize` and the MCP endpoint must
  arrive within `TAB_MCP_BODY_TIMEOUT_S` (10 seconds), else the answer is 408 and the
  connection closes (DEC-128): Bun's idle timeout does not fire while a handler waits for
  a body (DEC-048).
- **The MCP endpoint** looks the token up before it reads the body. Without a valid token
  it reads at most 16 KiB (every version probe fits); a larger body is not parsed, and
  the answer is the 401 (or 503) it would get anyway. Bodies are counted while they
  arrive, so one sent without a `Content-Length` is refused once it passes the limit.
  The endpoint still has no per-IP limit (AI apps share egress addresses).
- **Client assertions** that fail verification count per network (an IPv6 /56; 30, then one every 2
  seconds); once that is used up, further assertions from the network are refused with
  429 before any key is fetched or tried. A client's key set is read up to its first 20
  keys, and at most 3 keys that fit a token's `kid` and algorithm are tried.
- **Proxy headers** (`TAB_MCP_TRUST_PROXY`): a value with a port (`203.0.113.7:51234`,
  `[2001:db8::1]:443`) counts as its address. A value that is not an address falls back
  to the socket's address and is logged once (`relay.bad_forwarded_ip`), so a
  misconfigured proxy never gives each connection a limiter key of its own.

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
- **A browser extension is a site too** (DEC-108): its pages send
  `Origin: chrome-extension://<id>`. No website can send that origin, since browsers set
  `Origin` themselves, so listing an extension admits that extension's pages in a
  browser and no website. Its content scripts are not among them: their requests carry
  the origin of the website they run in, so an extension runs the library from its
  service worker or one of its own pages (such as its side panel). A service worker
  stays alive while connected: the relay's heartbeat is WebSocket traffic, which keeps
  it running in Chrome 116 and later while the heartbeat is under 30 s. An unpacked extension keeps its id only with a `key` in
  its manifest, and that key is public: anyone can load other code under the same id in
  their own browser. So the id keeps websites and other extensions out; it does not prove
  who wrote the code a user installed. A program can claim the origin like any other
  (above). The pairing page names such a page "the
  browser extension `chrome-extension://<id>`". Firefox and Safari give every
  installation its own id, so the relay refuses their schemes in its lists.

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

### A13: tab-mcp for Chrome and the pages it bridges

tab-mcp for Chrome, a browser extension, offers the WebMCP tools of the page in front to
the user's AI app, through a relay. That page did not choose the relay or the AI app: the
user did, by turning on AI access in the extension. To the relay the extension is a site
like any other, `chrome-extension://<id>` (A11).

- **The page is untrusted, all of it.** Tool names, titles, descriptions and schemas
  reach the AI app's tool list, where no hint can mark them, and a description can carry
  instructions. Descriptions start with the page's origin (`From https://…:`) and are cut
  to 1000 characters, titles to 100; schemas over 16 KB and tools beyond 64 are left out,
  as is a tool whose name would become one of the extension's own (`info` as
  `page_info`), so a page cannot stand in for them. Every result is marked untrusted
  (`openWorldHint`); its text, all blocks together, is
  cut to 100,000 characters, with at most 32 blocks and the images of one result up to
  640 KiB of base64 together, so a result fits the relay's default 1 MiB per response;
  a result over 2 MiB is refused. The page's title and language are cut.
- **The site is the one Chrome reports.** The origin shown with a page's tools, and
  under which they are allowed, is checked against the address Chrome reports for the
  tab; a page that claims another site gets no tools.
- **Hints can lie.** A tool the page marks read-only runs without asking; every other
  tool asks the user each time, naming the page's origin. "Don't ask again on <host>" in
  a question, or "allowed" in the side panel, stops the questions for a tool of one
  exact http(s) origin, for every paired AI app, until the user takes it back. A tool
  that changed while the question was open does not run. An allowed tool runs whatever
  the AI app, or a prompt injection steering it, asks of it. A page can mark only its
  own tools read-only, so a lie harms that page's own user session, which its scripts
  could reach anyway.
- **A call runs only where its tool was listed.** A call carries the id of the page its
  tool was listed from and the read-only claim it was offered with; the extension
  refuses it if the tab navigated since or the claim changed. So a page cannot offer a
  "read-only" tool and then send the tab to a site whose tool of that name changes
  things.
- **Arguments are checked** against the page's schema before the call, without its
  regular expressions, so a page's catastrophic pattern cannot freeze the connection. A
  call ends for the AI app after 60 s or on its cancellation, even if the page never
  answers, and a page that does not answer the extension's other questions within 5 s
  is given up, so a stuck page cannot hold the other tabs. The page's tool changes are
  read at most every 250 ms, and the number and size of what a page sends are capped.
- **A forged `document.modelContext`** in the page's own scripts does not reach the
  extension, which sees only the browser's own object.
- **Which pages.** The extension asks for no host access at install. Without it, it
  reads a tab only after a click on its icon there, and only on that origin. With "Allow
  on all sites" it reads every page in front: the AI app then gets the tools of whatever
  site the user looks at, each call to a tool not marked read-only still asked. Only
  http(s) pages, no `file:` pages and no Incognito tabs. The page's address goes to the
  AI app (`page_info`, navigation results) with its query and fragment, without a
  question, so a token in a link (a magic link, an OAuth callback) goes with it.
- **Navigation.** `navigate`, `go_back`, `go_forward` and `reload` act only on a tab the
  extension may read. A page's text could tell the AI app to open another site: on the
  page's own origin a navigation runs without asking (as a link on the page would), to
  another origin it asks the user, showing the site the tab is on and the address, with
  Allow and Don't allow only. Back or forward to a page the extension cannot see asks
  too. Only `http:` and `https:` addresses, without a user name or password. An open
  redirect on the page's own origin can still lead elsewhere without a question; the
  answer then shows where the tab landed, or that the extension may not read it.
- **Only the side panel gives commands.** The connection lives in the extension's service
  worker, which the extension's scripts in every page it may read can message. Commands
  (turning AI access on or off, pairing, disconnecting an AI app, a new address, the
  relay, allowing tools, answers to questions) are taken only from the extension's own
  side panel, as Chrome reports the sender; anything else is dropped. Besides the panel,
  only the buttons of the extension's own notifications and a question's own window,
  which the extension opened for that one question and which can answer only it, answer
  questions (see Questions). "Allow all" allows
  only the tools the extension itself offers on that site at that moment that are not
  read-only, so a tool the page registers later still asks. From a page, the one message
  accepted says that the page's tools changed. A compromised page can therefore not turn
  AI access on, allow a tool or answer a question.
- **Questions.** When the side panel is open, on screen and in front in the window of the
  tab the call acts on, the question is there: its Allow buttons take a click only after
  the panel has been in front for 750 ms, so the click that brings it forward cannot
  approve, and the page's scripts cannot reach the panel. Otherwise a Chrome notification
  asks. It names the AI app (its declared name beside its verified host), the tool and,
  on a line of its own, the page's site, and the arguments in short, saying so when they
  are cut; its one button is Allow ("Don't ask again" needs the full question), and a
  click on the notification's body opens the full
  question with all its arguments in the side panel of the tab's window, or in a small
  window of its own where Chrome does not open the panel; the question waits there, its
  60 s still running. Closing the notification is Don't allow, as is closing that
  window. Invisible, blank and direction characters in the arguments and names are shown
  as `\uXXXX`, with the same set as the client library's dialog (controls, format and
  other default-ignorable characters such as variation selectors, private-use and
  unassigned code points, every space but U+0020). In the side panel the page's site
  and the page's title for the tool are on lines of their own, labelled. Only Allow
  allows from a notification, and
  a click on it right after the notification appeared does not count, so a click meant
  for something that was there before cannot allow. Each notification answers only its
  own call. A notification is outside any page, so a page cannot cover or click it;
  another program on the computer could, as it could click the panel. No answer in 60 s
  is Don't allow; with notifications off the icon shows "?" and the panel asks.
- **AI access with no panel on screen.** AI access stays on with the panel closed and
  comes back after a browser start, an update or a reload when the user left it on; it
  is turned on only from the side panel. The icon shows "on" while connected. Read-only
  and allowed tools run with nothing on screen.
- **The extension's settings are out of web pages' reach.** The address secret, the
  relay, the tools allowed per site and whether AI access is on are kept in IndexedDB in
  the extension's own origin and opened by the service worker only. The extension's
  scripts in a page run in that page's origin and cannot open that database, so a page
  whose renderer is compromised can neither read the secret (and take over the address
  from anywhere, A4) nor allow its own tools. The extension asks for no `storage`
  permission, so there is no `chrome.storage` area those scripts could read or write.
- **A takeover is kept.** After another tab or program takes the address over, the
  extension does not take it back by itself, also after a restart, so it does not trade
  the address back and forth with whoever has the secret; the side panel says so and
  offers a new address.
- **The extension's id.** The relay allows the extension by its origin. The Chrome Web
  Store item's id comes from the store, which keeps its key; the store package carries no
  key, no host access at install and no source maps. The key of the owner's development
  build is kept out of the public repository, so nobody else can load an extension with
  the id the hosted relay allows for it; a build without that key gets an id of its own,
  which a relay must allow on its own.

### A14: Agents in the browser calling a page's mirrored tools (WebMCP)

With `webmcp: true` (off by default), the client library also registers the page's
tools with the browser's own [WebMCP](https://webmachinelearning.github.io/webmcp/)
(`document.modelContext`), where an agent in the browser calls them: one built into the
browser, or an extension. This caller sits beside the AI apps of A2 and A6, and differs
from them.

- **No pairing, no identity.** Any agent the browser lets call the page's WebMCP tools
  can call the mirrored ones; the relay, its grants and its pairing are not involved,
  and the page learns nothing about the caller (`client.kind` is `"webmcp"`). Turning
  `webmcp` on is a change in what the page exposes; the library treats it as one (off by
  default, the CHANGELOG says so).
- **It can operate the page's dialog.** Such an agent often drives the very tab it calls
  into: input it sends through the DevTools Protocol or an extension is trusted input,
  and the delay before Allow only needs the tab visible and focused. So the page's
  confirmation is weaker against it than against a remote AI app. Hence consequential
  tools are not mirrored unless the page registers them with `{ webmcp: true }`, which
  says that its own dialog, or the agent's own confirmation, is enough for that tool.
  "Always allow" is never offered or applied for these calls.
- **The same check.** Arguments are checked against the tool's schema before `execute`
  (Chrome does not), a consequential tool asks the page's `onConfirm` or the library's
  dialog ("An agent in this browser wants to run …"), and the calls appear in the
  page's `toolcall`/`toolcallend` events like an AI app's.
- **Only the browser's own object.** The library reads `document.modelContext` through
  `Document.prototype`'s getter, captured when it loads, and checks that it is a
  `ModelContext`; an own property (a polyfill, any page script) is passed by. A page that
  changes `Document.prototype` before the library loads can fool this; it owns the tools
  anyway. Who may call into the page's WebMCP at all (cross-origin frames need
  `allow="tools"`; which agents and extensions) is the browser's decision.
- **Names keep their owner.** A name the page or another script registered natively
  first stays theirs (the mirror only warns), and once a name is mirrored the page's own
  native registration of it fails. tab-mcp for Chrome (A13) offers mirrored tools like
  any other page tool, since it cannot know whether the AI app is also paired with the
  page: an AI app connected to both sees such a tool twice, and a consequential one asks
  in the extension and again in the page.

### A15: The site's own assistant calling the page's tools over a port (`serve`)

With `mcp.serve(port, { client })` the page answers MCP requests on a message port,
without a relay: for the site's own assistant, e.g. a chat in a frame whose backend
runs the MCP client ([protocol](protocol.md#the-tunnel-without-a-relay)). This caller
sits beside the AI apps of A2 and A6 and the agents of A14.

- **A port is a capability.** Whoever holds the other end calls the page's tools
  without pairing, and the library cannot check who that is. The page decides it when
  it hands the port out: it must check the frame's origin (and that the message came
  from that frame) first, and post the port with that origin as the target, never
  `"*"`. A port given to a frame on another origin, or to a script the page does not
  control, gives that party the tools. The library has no handshake of its own on
  purpose: it would have to guess what the page knows.
- **The caller cannot pass for a paired AI app.** The library sets the grant of every
  request on a port itself and ignores one that is sent; the page's tools, its
  confirmation and its events see `client.kind` `"local"` with the id and name the
  page gave to `serve`. The name is the page's claim about its own assistant, not
  something verified; the page controls it, as it controls everything else it shows.
- **Consequential tools still ask.** The same argument check and confirmation as for
  an AI app; the library's dialog says "(this site's assistant)" and never offers
  "Always allow". A page may answer `onConfirm` itself for `kind: "local"` and so let
  its own assistant run such tools without a question; that is the page's decision
  about its own backend, with A6's consequences if the assistant follows injected
  instructions.
- **A6 applies in full.** The assistant's model reads the tools' results and whatever
  the user or other content tells it; `untrustedContentHint` stays on the results that
  have it, and the page's tools must not do more for this caller than for the user.
- **No relay, no relay limits.** There is no request size limit, rate limit or
  concurrency limit on a port: the other end is the site's own code. A page that
  serves a port to code it does not trust has given up more than a limit would save.
  The library's confirmations are shown one at a time per document, so many
  consequential calls at once become a row of questions, each with its own delay, not
  a stack of dialogs.
- **Nothing is stored.** A `TabMcp` without `relay` creates no address secret and opens
  no `BroadcastChannel` or WebSocket.

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
- The browser library registers tools with the browser's WebMCP only with
  `webmcp: true`, and consequential ones only when the page names them (A14).

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
  page gets a new address. The relay sends them the pairing codes like to any page, so
  they can also pair an AI app of their own; once the owner's page holds the address
  again (reconnected without having seen the takeover), that AI app calls the real
  page's tools until it is disconnected or the page gets a new address. The page lists it
  among its connected AI apps and cannot tell it from one the user paired. The page says
  that its address was taken over when it sees it happen and offers a new one, but cannot
  prevent it; identity binding does (A4, A12). Pages must keep cross-site scripting out, as for
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
- With tab-mcp for Chrome: a tool that runs without asking (marked read-only by the page,
  or "allowed" on its site) does whatever the AI app asks of it, and another program on
  the computer can click a notification or the side panel (A13).
- With `webmcp: true`: any agent in the browser calls the mirrored tools without
  pairing, and one that drives the tab can click Allow in the page's dialog for a
  consequential tool the page chose to mirror (A14).
