# Threat model

What tab-mcp protects, from whom, how, and what it cannot protect against. It describes
relay `@ractive-ch/tab-mcp` 0.13.3, browser library `@ractive-ch/tab-mcp-client` 0.24.0-rc.1
and the tab-mcp browser extension 0.3.3 (in the Chrome Web Store and on
addons.mozilla.org, A13).
To report a vulnerability,
see [SECURITY.md](../SECURITY.md).

## How it works, in short

A web page registers tools with the browser library. When the user clicks Connect, the
page opens a WebSocket to a relay. The page's app has one MCP address on the relay,
`https://<relay>/s/<app>/mcp`, the same for every page of the app. The user adds the
address to an AI app. The AI app signs in with OAuth on the relay, and the user says
which page they mean, and proves that they can see it, by typing a code of 8 letters from
the page into the relay's `/authorize` page. The AI app then calls the tools; the relay
forwards each request to the page it was paired with, which runs the tool and answers.
See the [protocol](protocol.md) for the details.

## Assets

1. **The page's capabilities:** whatever its tools can read or do in the user's tab.
2. **Tool arguments and results** on their way through the relay.
3. **Tokens.** An access token lets its holder call the page's tools while the page is
   open, for up to 1 hour. A refresh token gives new access tokens for up to 30 days, and
   never beyond 90 days after pairing.
4. **The address secret** in the page's `localStorage`. It is what a page is to the
   relay: grants belong to the address id derived from it and the page's app id, which
   is part of no URL.
   Whoever has the secret can take the page's place from anywhere: the AI apps already
   paired with the page then use them instead, until the page gets a new secret
   ("Disconnect all apps", A4). They get no token of those apps, but the relay sends them
   the pairing codes, so they can pair an AI app of their own, which later reaches the
   real page once that is connected again (A4).
5. **A pairing code while it is valid.** The address is the same for every page of an
   app, so the code alone decides which page an AI app is paired with (A1).
6. **The token store** (a SQLite file by default): token hashes and grant details.
7. **The user's attention:** pairing dialogs and confirmations must not be spammed or
   confusing.
8. **The relay's availability** and its operator's bill.

## Who sees what

| Party | Sees | Trusted for |
|---|---|---|
| The page and its author | its own tools, the pairing codes | defining tools honestly; it already runs in the user's browser (see A10) |
| The relay operator | **every tool argument and result in clear text** (TLS ends at the relay), client ids, IP addresses, timing | not logging or changing traffic |
| The AI app | the tools it may call and their results | following the user's intent (a model drives it) |
| The model provider behind the AI app | the same as the AI app | nothing |
| A WebMCP caller: an agent in the browser, another extension, an `exposedTo` origin (unless the page sets `webmcp: false`, A14) | the tools the page mirrors into WebMCP and their results | nothing |
| The network | nothing: TLS everywhere, `wss:` and `https:` only outside development | nothing |

The relay cannot be made blind. The AI app speaks HTTPS to the relay, and the relay must
read the MCP request to forward it. If you do not trust a relay's operator, run your own
relay ([self-hosting](self-hosting.md)).

## Attackers and what stops them

### A1: Someone who knows the address

The address names an app, not a page: everyone who uses the app adds the same one, and
an organisation may add it once for all its members. Treat it as public. Whoever knows it can
open the relay's pairing page for it with any AI app.

- The address alone grants nothing. Every MCP request needs a token, and a token needs
  the pairing code that only a page shows, or, with identity binding, a sign-in as the
  page's user (A12).
- **The code is the only thing that selects a page.** It has 8 letters out of 20
  (2.56 × 10¹⁰ values), works once and is valid for 2 minutes. The relay issues codes
  only while a page's "Connect your AI app" dialog is open, and no two pages show the
  same code at once. A code counts only at the address of its page's app.
- A wrong guess does not belong to a code or to a page. A code has no number of
  attempts, and there is no allowance per page that a stranger could use up: wrong
  guesses by others neither end a user's code nor make the user wait.
- Guesses are limited per network: an IPv4 address or an IPv6 /56 (one subscriber's,
  DEC-130) gets 10, then 1 a minute, which is 1 450 a day. Only a well-formed code
  counts, and a right one is given back. With N dialogs of an app open, a guess at that
  app's address hits one of them with probability N ÷ 2.56 × 10¹⁰, so one network's day
  of guessing hits with probability N × 5.7 × 10⁻⁸ (N being the average over the day).
- There is no limit across networks, because a limit that anyone can use up locks the
  owners out. An attacker with M networks therefore has M times the chance: 10 000
  networks against an app with 100 dialogs open on average come to about 0.06 a day.
  The size of the code is what stands against that, not a counter.
- A hit pairs the guesser's AI app with a page the guesser did not choose: the page of
  whoever had that code on screen. The AI app can then call that page's tools, with its
  user's signed-in state, until the user disconnects it; consequential tools still ask
  in the page (A6). The user sees that the code was used and finds the AI app in the
  page's list of connected apps, under the name and host it declared.
- `/authorize` keeps a connection request for every valid request it gets, for 10
  minutes: at most 10 per network and 10 000 in all. Nobody is refused for it: a
  network's eleventh request pushes out that network's own oldest, and past the total
  the oldest request among those of the networks that hold the most is dropped. A
  request names no page, so nobody can hold requests against one page's owner. Left
  over: a party with many networks, each holding as few requests as a user, pushes
  requests out in the order they came; a user's request then lasts as long as it takes
  that party to open 10 000 more. With identity binding, each request has one sign-in
  at a time; a Connect that starts one is charged like a guess and given back when the
  sign-in pairs, so the people of one office signing in one after another use up
  nothing.
- Everyone behind one address (an office or a mobile network behind NAT) shares its
  guess limit and its 10 open requests, as they share the limits on page loads and form
  posts. Someone on the same network can keep the guesses used up, so that the others'
  codes and sign-ins are refused unjudged, or keep opening requests, so that the
  others' are pushed out before they are finished. When every page had an address of
  its own, using up a user's guesses took that address.
- Neither endpoint tells which pages are open. Without a token, the MCP endpoint answers
  every address with a well-formed app id alike. `/authorize` shows the same form for an
  app whatever pages are connected: which pairing methods it offers comes from the
  relay's configuration alone.
- "Disconnect all apps" in the page revokes the page's connections and replaces its
  secret. The address does not change: it is the app's.
- Left over: a user who reads the code out to someone else, or types it for an AI app an
  attacker started. The code is all it takes. Whoever is told a valid code can pair an
  AI app of their own with that page, from anywhere, within the code's 2 minutes, and
  needs nothing else: no address that only the page's user knows. A link to the
  pairing page for an attacker's AI app is the same for every user of the app. The
  pairing page names the AI app and its verified host and says "Only connect AI apps you
  started yourself"; it cannot name the page, which the relay does not know before the
  code is typed. Identity binding (A12) is the cure where a site has it.
- On a page that pairs by code, grants follow the browser profile, not the person: the
  address secret is in the profile's `localStorage`, and the relay knows nobody else. On
  a shared profile, or in a web app with accounts that pairs by code, the next user of the
  page gets the AI apps the previous one paired. Use identity binding (A12) for such
  pages, or call `disconnectAll()` when the user logs out.

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
  header and only at the address of their app; the token's record says which page the
  request is for.
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
  assertion is usable (at most five minutes). Anyone can be a client, so each
  AI app host may hold only its share of the replay store (10 000 live entries); one
  that fills it gets 503 alone.
- Revocation leaves a tombstone in the store, and the store refuses new tokens for a
  revoked grant atomically. A refresh that races Disconnect cannot bring the grant back.
- Disconnect in the page revokes at once. "Disconnect all apps" revokes all grants of
  the page. A revocation also ends what the grant has under way: its requests in flight
  and open listen streams end (HTTP 401 or an error event, and the page is told to stop
  them), and a request that was authenticated before but is still waiting for its page
  checks its token again before it is forwarded, so it does not reach the page either.
  A grant's creation time is that of its authorization code, so a code issued before
  "Disconnect all apps" or "revoke all" makes no grant afterwards; the relay also drops
  the authorization codes it issued for the page then. An open connection request names
  no page: it can become a grant only through a pairing code typed after that, which is
  a new connection the page's user makes.
- Tokens are useless while the page is closed: requests get "the page is not open" (HTTP
  200 with a JSON-RPC error or tool error, after waiting up to `TAB_MCP_PAGE_WAIT_S` for
  the page). Waiting requests are bounded per page and in total, only requests
  with a valid token for that page wait, and only requests of at most 16 KiB, so
  all waiting requests together hold a few MiB. One actor with many self-made pages
  can fill the total and so switch the wait off for others: they then get the immediate
  answer, as before the wait existed. There is no per-IP share, because AI apps' requests
  come from a few shared addresses (all claude.ai users from Anthropic's).
- The relay never forwards the `Authorization` header to the page.

**A stolen address secret.** The page keeps its address secret in `localStorage`, one
per relay and page. The secret is what a page is to the relay: sessions, grants and
tokens belong to the address id derived from the page's app id and the secret. Whoever
has the secret can send `hello` with it and the page's app id from anywhere, and the
newest session for an address id wins: the page gets `replaced` and does not reconnect
by itself. The same secret under another app id is another page, with no session and no
grant of the first, so the holder has to name the page's own app, and the `Origin` they
send must be one that may serve it. For an app reserved with `sites[].apps` (A11) that
stops script on another origin of the relay; a program can send any `Origin`.

- **Who can get it:** script on the page's origin (cross-site scripting, a compromised
  third-party script or dependency, another page on the same origin, such as other pages
  of the same site or a shared `*.github.io` origin), or access to the device or browser
  profile (malware, an extension with access to the page, a shared computer). A network
  attacker cannot (TLS); the relay operator sees it anyway.
- **What the holder gets:** every AI app already paired with the page talks to them
  instead of the page. They see every argument the AI app sends, which can carry data
  from the chat. They write the tool descriptions and results, so they can put
  instructions into the user's AI session, which may have other tools (mail, files,
  code). That is the real damage; fake results for the page's own tools are minor next to
  it.
- **They can also pair an AI app of their own, and it outlasts the takeover.** To the
  relay, the session that holds the address id *is* the page: when it starts pairing,
  the relay sends the pairing codes to it, so the holder can connect any AI app they
  control, with the code they were sent. That grant belongs to the address id, not to
  the session. When the owner's page connects again later without having seen `replaced`
  (it was closed during the takeover, is reloaded, or the browser extension reconnects on
  its own), the relay gives the address id back to it, and the holder's AI app then
  calls the **real page's tools**, with the page's data and the user's signed-in state,
  until that grant is disconnected or the page gets a new secret. Consequential tools
  still ask in the page before each run (A6); everything else runs. The page lists the
  AI app among its connected apps (by the name and host the app declared at pairing),
  which is the only sign of it.
- **What the holder does not get:** no token of the AI apps the user paired (tokens stay
  with the AI apps, the store keeps only hashes), and nothing at all on a page that pairs
  by identity binding: a session needs a fresh assertion from the site's backend to take
  requests, and pairing needs a sign-in as the page's user (A12).
- **How long it lasts:** after the XSS is fixed, the page is closed or the script is
  removed, until the page gets a new secret, and an AI app the holder paired lasts until
  it is disconnected or the page gets a new secret (a grant ends 90 days after pairing at
  the latest). "Disconnect all apps" (`disconnectAll()`) always first takes the address id
  back with the old secret and `hello.revokeAll`, connected or not, taken over or not
  (DEC-136), so the relay revokes the grants of the old secret in the same step as it
  gives the address id back; whoever claims it again right after gets no grant back. It
  takes back the stored secret's address id; a tab that rotated the secret before took
  its own old one back the same way. Requests already on their way under a revoked grant
  are refused before they reach the page, requests in flight and open listen streams of
  the grant end, and authorization codes issued for the page before are void, so a
  pairing the holder finished just before does not become a grant either. Only once the
  relay confirmed it (no grants in `session`) does the page make the new secret; taken
  over again first, or the relay unreachable, the page keeps the old secret, says so,
  and the user tries again. Where storage cannot keep the new secret but still reads
  the old one, the page uses the new one until it is reloaded (clients before 0.21
  read the old one back and connected with it: its grants were revoked, but its holder
  could still take the page's place); after a reload the page has the old secret again,
  without grants. The MCP address stays the same through all of this: the AI apps the
  user wants back pair again with a new code.
- **What the page sees:** the library tells a takeover by a second tab of the same page
  from one by someone else. Tabs that share the secret say on a `BroadcastChannel` (per
  relay origin and storage key, with a hash of the secret, never the secret) when the
  relay accepted their session; a tab whose `hello` failed says nothing. A replaced tab
  that heard a sibling claim with its own hash within 10 seconds, after its own session
  started (waiting up to a second for it), reports `sibling: true` and
  the default UI shows "Opened in another tab". Otherwise, and in browsers without
  `BroadcastChannel`, it warns that another tab or program took over and offers
  "Disconnect all apps". A message on the channel from script on the page's origin can
  make a takeover look harmless, but such script can read the secret and change the page
  anyway, so the channel adds no new attacker. The hash on the channel
  (`base32(sha256(secret))`) is no credential and is not the relay's address id, which
  also takes the app id: the relay accepts it nowhere. A tab with another secret, or one
  that claimed while this tab was still connecting, does not count. A claim without a
  hash, from a tab on a library up to 0.15, still counts while both versions run.
- **What helps:** identity binding for pages with user accounts; the page on its own
  origin, without third-party scripts; `disconnectAll()` on logout on a shared device.
  A backend-signed claim of the address was considered and not built (DEC-094): without a
  signed-in user it proves nothing, and with one, identity binding already gives most of
  it.

### A5: Other websites using someone's relay

- Pages may connect only from allowed origins, and the list is empty by default. An open
  relay needs `TAB_MCP_ALLOWED_ORIGINS=*` and logs a warning at start. This stops other
  websites in a browser. A non-browser client can fake `Origin`, so the list controls
  abuse; it is not a security boundary for users.
- Which app a page serves is the page's own word (`hello.app.id`). An app that no site
  of the relay's configuration lists can be served by every origin the relay allows; an
  app that a site lists under `apps` only by the sites that list it (A11).
- Limits: sessions per IP (5; IPv6 per /64 and per /56) and in total (500), message and
  body size (1 MiB), concurrent requests per session (8), request timeout (300 seconds),
  a short idle timeout for sessions nobody paired with (10 minutes), idle timeout and
  session lifetime.

### A6: The AI app, or a prompt injection, misuses the tools

- Read-only and harmless tools run directly. Tools marked `consequentialHint` ask in the
  page before each run of an AI app, showing the AI app and the arguments (for a WebMCP
  call the library shows no question; only the page's `onConfirm` decides, A14). The page's question does
  not depend on the AI app. A `consequentialHint` that is not a boolean is refused at
  registration, not dropped, so a typo cannot turn the question off.
- The library's dialog shows one question at a time, and "Allow once" is enabled only after
  the page was seen for the delay with that dialog on top and the arguments were
  scrolled to their end: the AI app chooses the order of the keys, so it could put the
  one that matters below the fold.
- Consent per tool is the page's, not the relay's: the relay has one OAuth scope,
  `tools`, which covers every tool of the page. Letting a tool run without asking is off
  unless the page turns it on (`alwaysAllow`, DEC-096, DEC-200), since it lifts the only
  brake at run time for that tool and AI app, which is what a prompt injection needs.
  With `alwaysAllow: true` the confirmation offers "Always allow", and the connect
  dialog a switch per tool and "Always allow everything" under each app,
  which also covers tools the user has not seen and ones the page adds later. Such an
  allowance is kept in the page's `storage` until the relay reports the grant gone
  (disconnected, "Disconnect all apps", expired, signed out): it outlives the user's
  attention for up to the grant's 90 days. `"until-reload"` keeps it in memory only. A
  tool whose title or description changed since it was allowed asks again; a page's own
  `onConfirm` is not asked for an allowed call either. Whoever can write the page's
  `storage` (a script in the page, XSS) can allow tools as it can take the secret.
  Only AI apps through the relay can be allowed; served ports always ask. Unvouched
  WebMCP calls get no question from the library at all (A14, DEC-215).
- Annotations reach the AI app as MCP hints (`readOnlyHint`, `destructiveHint`), so the
  AI app can ask too.
- Tools marked `untrustedContentHint` are announced with `openWorldHint: true` and the
  original hint in the tool's `_meta`, so AI apps can treat that tool's results as
  untrusted data. The results themselves carry no marker.
- The page lists the connected AI apps; the user can disconnect each at any time.

### A7: Cross-site attacks on the relay's pages

- `/authorize` sends a strict Content Security Policy (`default-src 'none'`, styles from
  the relay only, `frame-ancestors 'none'`, `form-action` limited to the relay and the
  client's redirect origin; for a loopback redirect to `[::1]` the scheme `http:`,
  because CSP has no syntax for an IPv6 literal and Chrome drops one), `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` and
  `Cache-Control: no-store`. The only JavaScript on the page is the code field's own
  small inline script: it keeps the typed code in the form `XXXX-XXXX` and draws the
  field as boxes, touches nothing else on the page, loads nothing and sends nothing. The
  policy allows exactly that script by its SHA-256 hash, which the relay computes when it
  starts; no other script, inline event handler or `eval` can run. Without the script the
  field is a plain input and the page works as before. A page that pairs by sign-in only
  has no script at all. Framing is refused, so the code field cannot be overlaid.
- Every response of the relay, not only its pages, carries `X-Content-Type-Options:
  nosniff`, so a browser never takes an answer as a script or style sheet it guessed.
- The relay's home page has the same protection as the sign-in page: the same policy
  with no script and no form (`form-action 'none'`), `X-Frame-Options: DENY` and
  `Referrer-Policy: same-origin`. Both pages take these headers from one function, so
  they cannot drift apart.
- The form posts only the id of a pending request. Its CSRF token is bound to that
  request and to a first-party `HttpOnly`, `SameSite=Lax` cookie. Posts with a foreign
  `Origin` or `Sec-Fetch-Site` are refused. The page sets no `Cross-Origin-Opener-Policy`,
  because claude.ai opens it in a popup and needs its opener back.
- Every value shown on the page is HTML-escaped and length-limited: the client name
  (64 characters, cleaned, DEC-065), the verified host of the client id, and the app id
  from the address (at most 32 characters of `a-z`, `0-9` and `-`). Nothing a page sent
  is shown: not its origin and not its own name for itself. The client name and the app
  id are rendered with `unicode-bidi: isolate`, so a right-to-left character cannot
  reorder the text around them.
- The form carries `data-tab-mcp-*` attributes that repeat what the page says (the AI
  app's name and verified host, the app id) for a browser extension in the same browser
  that is itself the page: after asking its user, it can write its own code into the
  form and submit it (DEC-199). The attributes never hold a code, and the relay checks
  a code written by an extension like one that was typed. An extension must act only on
  a top-level page of its relay's origin, only for its own app id and only after its
  user agreed, showing the verified host: any site can be a client under a name of its
  choice. The tab-mcp browser extension does this (DEC-203, A13), with the client
  library's `./extension` entry, which other extensions can use (DEC-206).
- The metadata, token, revoke and MCP endpoints answer CORS requests from any origin
  without credentials (`Access-Control-Allow-Origin: *`, never `Allow-Credentials`).
  They use no cookies, and tokens travel only in the `Authorization` header, so another
  website can do nothing a server could not. `TAB_MCP_CORS=off` turns CORS off.

### A8: Denial of service

In-memory rate limits cover `/authorize` page loads and posts per IP, code guesses per
network, `/token` and `/revoke` per IP, refreshes per grant,
and metadata fetches per domain and overall. IPv4 counts per address, IPv6 per /64
(per /56 where noted below).

- Code guesses are limited per network only (an IPv6 /56, as sessions are, DEC-130):
  10, then 1 a minute. Only wrong guesses are charged; a right code gives its share
  back, a sign-in is charged when it starts and given back when it pairs, and input
  that is not a well-formed code is not a guess. There is no limit per page or per
  code, so a stranger's guesses cannot make a page's owner wait (A1). The limit keeps
  100 000 networks and drops its oldest bucket when full: refusing new networks instead
  would let a party with that many networks refuse everyone's first guess. Left over: a
  party with more than 100 000 networks gets each network's first ten guesses again
  once its bucket was dropped, as often as the limit on form posts lets a network post.
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
a page that is not open are limited per page and in total, and only a valid token for
that page makes a request wait. Pending
authorizations and codes live in bounded maps that expire. Every WebSocket send is
checked: a send dropped under backpressure fails its request instead of hanging it. A
single relay can still be flooded; put a CDN or proxy in front of it against volumetric
attacks.

- **Open authorization requests** (DEC-129) are capped at 10 per network, where an IPv6
  network is a /56 (one subscriber's), and 10 000 in all; each lives 10 minutes. A new
  request is never refused for either cap. A network's eleventh request pushes out that
  network's own oldest, so loading the page again never locks a user out. When the
  relay holds 10 000, the oldest request among those of the networks that hold the most
  is dropped. A party that fills the total with several requests per network therefore
  pushes out its own requests, not a user's. A request names no page, so there is no
  cap per page and no request is preferred for its page; a party that fills the total
  from many networks with one request each pushes requests out in the order they came
  (A1).
- **Control messages from a tab** (everything but `pong` and the `http.response*`
  answers) have a budget per session: 30, then 2 a second. Past it the relay sends
  `rate_limited` and closes with 4008. A second "revoke all" of a page within a
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

Logs are JSON lines with the event, the app id, a shortened address id, the session id,
the MCP method, the HTTP status, the duration, the client id host, coarse error codes and
the names and codes of errors (`SQLiteError`, `SQLITE_FULL`, never their messages). They
never contain bodies, tool names, arguments, results, tokens, codes or secrets. Client
IPs appear only in rate-limit warnings, shortened to /24 (IPv4) or /48 (IPv6). An
operator should tell users this in a privacy notice.

### A10: A page that misleads (phishing)

**Connecting an AI app to a page means trusting that page,** as with any MCP server. The
page's tool descriptions and results reach the model. A page can describe a tool in
misleading ways, or return text that steers the model. tab-mcp cannot judge a page's
honesty. The pairing page does not name the page: the address names the app, and the
relay does not know which page is meant before the code is typed. The user knows whom
they trust by where they read the code, because the code pairs the AI app with the page
that shows it. A user who types a code from a page that only looks like the one they
mean connects their AI app to that page, also when the address they added is the right
one. The closed origin list and reserved apps (A11) keep other sites from serving an
app's address in a browser.

### A11: Several sites on one relay

- One relay may serve several sites, each configured by origin. The relay takes the
  origin from the `Origin` header of the page's WebSocket and checks it against the
  list.
- **Which app a page serves is the page's own word.** The app id in an address
  (`/s/<app>/mcp`) is what the page sends in `hello`. The relay's site list cannot
  derive it from the origin: one origin can run several apps, and Firefox gives every
  installation of an extension its own origin. So on a relay with several origins, any
  of them can serve an app that nobody reserved, and show codes that pair at that
  app's address. An organisation that allows an address allows an app on that relay,
  whichever origin serves it.
- **Sites may reserve apps** (`sites[].apps`, DEC-197). A site's pages may name only the
  apps on its list, and an app that some site lists is served by no origin that does not
  list it: not another site, not an origin of `TAB_MCP_ALLOWED_ORIGINS`, not a Firefox
  extension, not any origin of an open relay. A page that names an app its origin may
  not serve is refused (`app_not_allowed`) before it claims anything, so it cannot end
  the session of a page that may. An app that no site lists stays open to every origin
  the relay allows.
- **The origin is reported, not verified.** A browser sends the page's true origin, but
  a program can claim any origin, including a listed one, and with it serve an app
  reserved for that origin and show its own codes. Reserving an app keeps other
  websites and other extensions in a browser off its address; it does not prove to a
  user that the code they read comes from the app they mean (A10). Only identity
  binding (A12) ties a session to the site's backend.
- The app name a page sends (`app.name`) is its own claim. The pairing page does not
  show it. The relay uses it in its "the page is not open" answers to the AI apps
  paired with that page, cleaned as it cleans AI apps' names (bidi, zero-width and
  other invisible characters removed), and drops a name that names a domain other than
  the page origin's host (DEC-130). A configured site `name` replaces the page's claim
  and is used as configured.
- Pages on the same origin can claim each other's names and serve each other's apps.
  That is acceptable: they share a trust domain anyway
  (same-origin pages can read each other's `localStorage`).
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
  (above). Firefox and Safari give every
  installation its own id, so the relay refuses their schemes in its lists; the entry
  `moz-extension://*` admits the pages of any Firefox extension, which can serve only
  apps that no site lists. An app reserved for a Chrome extension's origin can therefore
  not be served by the same extension's Firefox build: that build needs an app id of
  its own, and the operator cannot reserve it.

### A12: Identity binding (sites with `pairing: "oidc"`)

Instead of typing a code, the user signs in at the configured OpenID Connect provider
from `/authorize`, and the relay pairs the AI app with the app's page whose user is that
person. Two statements are compared: the web app's backend says who is signed in to a
page (a tab assertion), the provider says who signed in at `/authorize` (an ID token).

- **Someone else signs in.** The sign-in comes first. When the provider sends the
  browser back, the relay looks among the app's pages for one whose user is the
  signed-in person and whose "Connect your AI app" dialog is open (and was opened less
  than 10 minutes ago); of several, it takes
  the one that connected last. Only a page that was connected when the sign-in started
  counts, so a sign-in under way does not pair with the page that "Disconnect all apps"
  has just made new. Anyone without such a page gets "No page is connecting
  with the account you signed in with. …" and nothing is issued. No page, a closed
  dialog, a signed-out page and a page signed in as someone else get this one answer,
  as the relay cannot tell them apart; it therefore says nothing about other people's
  pages. The next sign-in for that request asks for the account again. The lookup uses
  the pages' bindings at that moment, so a page that signed out meanwhile pairs nobody.
- **Forged or replayed tab assertions.** The relay accepts only JWTs signed by a key of
  the configured JWKS, with `typ` `tab-mcp-identity+jwt` (so an ID token or access token
  signed with the same key is refused), the configured `iss`, `aud` exactly the app's
  address, `exp` at most 60 s ahead and a `jti` it has not seen. `none`, HMAC and keys
  embedded in the token are refused; each algorithm is tied to its key type. An assertion
  for one app is useless at another's address. The web app's own ID token is never
  accepted: its audience is the web app.
- **A tab assertion is not bound to one page.** Its audience is the app's address, which
  every page of the app shares. Whoever gets hold of a person's assertion before it was
  used and within its 60 seconds can bind a session of their own, with a secret of their
  own, as that person. An AI app that person then pairs by sign-in may be paired with
  that session instead of their page (of several pages of one person, the one that
  connected last wins), and its requests then go to the holder. The assertion's single
  use, its 60 seconds and its issuer still limit this; the page's grants do not move,
  as they belong to the page's address id.
- **Forged ID tokens or a hijacked sign-in.** The relay is an ordinary OIDC client:
  authorization code with PKCE S256, `state` and `nonce`, both random and single-use,
  bound to the pending request and to the browser's visit cookie (a callback in another
  browser is refused), and `iss` in the response checked when present. The ID token is
  validated as OpenID Connect Core says (signature with the provider's keys, `iss`, `aud`,
  `azp`, `exp`, `iat`, `nonce`).
- **Phishing the user into a sign-in.** Someone who sends the user an `/authorize` link
  for their own AI app would only need a click on Connect if the user is signed in at the
  provider and the provider's single sign-on asks nothing. Anyone can make such a link:
  it names the app, not a page, and is the same for every user of the app; when every
  page had an address of its own, it took that address. The page's "Connect your AI
  app" dialog must be open when the provider sends the browser back, so a sign-in that
  comes back after the user closed the dialog pairs nobody. An open dialog counts for
  10 minutes after the user opened it (a code lasts 2): a sign-in that comes back later
  pairs nobody either. With a client library from 0.19 on only the user starts the 10
  minutes again, with Continue in the dialog or a click on Connect again; neither a
  timer nor a reconnect the library makes by itself does (DEC-202). So the window is
  the 10 minutes after the user last opened the dialog or continued, not the whole time
  a forgotten dialog stays open. Pages with a library before 0.19 send `pairing.start`
  again after every reconnect (a relay restart, a network drop, a laptop waking up),
  and the relay cannot tell that from the user opening the dialog: for them each
  reconnect starts another 10 minutes, so a forgotten dialog stays pairable in windows
  that a reconnect renews. The limit is complete only once a page runs the newer
  library, one reason to update. The pairing page names the AI app and its
  verified host. The same click-through risk exists for every OAuth consent page.
- **A different person later uses the same browser.** Grants remember a hash of the
  person they were made for. MCP requests reach the page only while it is bound to that
  person; a page that proves another person revokes the previous person's grants and ends
  their requests in flight. A page that is open but not signed in gets nothing forwarded.
  A request whose grant was made for another person than the page's gets "This AI app
  is signed in as someone other than the page's user."
- **Logout.** `signOut()` in the page revokes every grant of the page at once and ends
  requests in flight. A logout while no page is open needs nothing: a grant works only
  while its page is open and signed in as the same person. The web app must call
  `signOut()` in its open pages when its user logs out.
- **What it does not protect.** The AI app then acts with exactly the rights of the
  page's user, so a taken-over provider account also gives the AI connection. A web app
  backend that signs assertions for users who are not signed in, or a leaked assertion
  key, lets anyone pair with that user's pages: keep the key like a session-signing key.
  The relay's client secret lets its holder act as the relay at the provider; keep it in
  the platform's secret store. Pairwise subjects can make the same person look like two
  (see [configuration](configuration.md#identity-binding)); comparing an e-mail address
  instead is refused, because e-mail addresses change hands.

### A13: the tab-mcp browser extension and the pages it bridges

The tab-mcp browser extension offers the WebMCP tools of the page in front to
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
  tool asks the user each time, naming the page's origin. "Always allow on <host>" in
  a question, or the tool's "Always allow" switched on in the side panel, stops the questions for a tool of one
  exact http(s) origin, for every connected AI app, until the user takes it back. A tool
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
- **WebMCP on a click** (DEC-223). Where a page the extension may read has no WebMCP
  (in practice a tab given by a click on its icon: with host access a page has the
  extension's from its load, or from the content script's start), it gives that page
  its own `document.modelContext` after the page loaded, only while AI access is on and
  connected, and only a page that can take it (https, or the loopback host's http), and
  says so with the DOM event `tab-mcp-webmcp`, so that the client library looks again.
  Such a page learns that the extension is installed and that the user gave it this
  tab, and when. Until then a content script that a click put in (the worker tells it
  so in its own world, as it has no host access for the page) sends nothing into the
  page and installs nothing: no port, no WebMCP, and in Firefox no takeover of an
  earlier script's state, which a page could fake. The give goes to the document that
  was read: in Chrome to Chrome's id of the document whose content script answered,
  and the message names that content script's page, so another page of the tab gets
  neither. In Chrome the page-world script then gets a port over `window.postMessage`,
  as it does with host access, where the content script posts it at its start
  (`document_idle`): the page's scripts can see the port and answer it, and gain no
  more than registering tools of their own origin gives them.
- **A page with the client library** (DEC-207). A page that announces the library
  (DOM events, or `<html data-tab-mcp-handshake>`) is told, while AI access is on and
  connected, the extension's name and the names and verified hosts of the AI apps
  connected now, again when that changes; a page that does not announce it is told
  nothing. Any page script can announce it, so any page the extension may read can learn
  those names by pretending while AI access is on; nothing else (not the version, the
  relay, the address, other tabs) is told. While AI access is off, the extension
  answers no page and sends it nothing (DEC-221), and does not read what a page sends:
  in Chrome reading an object `detail` from another world runs the page's getters,
  which would show that it listens. A page can still see that the extension is
  installed where it gives the page WebMCP as the page loads (in browsers without their
  own, with access to all sites), and could try to time its own events, which the
  extension still listens to. A page it told
  "on" hears `on: false` once when AI access goes off (also after the back/forward
  cache and after host access was withdrawn; after the extension was disabled or
  updated, the next time the page speaks or is shown). Right before a tool runs that the user allowed (asked, or allowed for the site),
  the extension vouches for that one call to such a page: the tool, the arguments and
  the AI app, after its own checks (the page the tool was listed from, its read-only
  claim). The vouch is made in one place, after the user's answer and the check that
  the tool is still the one asked about, and never for a read-only tool or a call that
  was not allowed; once the call settled, it is withdrawn. Right before an AI app's
  call of a read-only tool, which nobody asks about, the extension tells such a page
  the same as a `claim` (DEC-224), withdrawn the same way: it allows nothing in the
  page, and it and the vouch ask the library for the whole MCP result, so that the AI
  app gets the page's pictures. The page so learns, while AI access is on, which AI
  app calls each of its tools through the extension, read-only ones included, and
  with which arguments (which it gets anyway). What the page announces (the
  library's version, its app id, at most 64 AI apps connected to it directly) is the
  page's word and only feeds two lines in the panel. A page saying `hello` in a loop
  does not keep the extension's one service worker busy: the worker is asked at the
  first `hello`, later ones are answered from the last state it sent (it sends every
  change), and a worker that does not answer is asked again twice, then not until the
  next `hello`. No proof of either side: see A14.
- **Which pages.** The extension asks for no host access at install. Without it, it
  reads a tab only after a click on its icon there, and only on that origin (the relay's
  pairing page, with the relay's site granted, is the exception below). With "Read all
  sites without a click" it reads every page in front: the AI app then gets the tools of whatever
  site the user looks at, each call to a tool not marked read-only still asked. Only
  http(s) pages, no `file:` pages and no Incognito tabs. The page's address goes to the
  AI app (`page_info`, navigation results) with its query and fragment, without a
  question, so a token in a link (a magic link, an OAuth callback) goes with it.
- **Navigation.** `navigate`, `go_back`, `go_forward` and `reload` act only on a tab the
  extension may read. A page's text could tell the AI app to open another site: on the
  page's own origin a navigation runs without asking (as a link on the page would), to
  another origin it asks the user, showing the site the tab is on and the address, with
  "Allow once" and Don't allow only. Back or forward to a page the extension cannot see asks
  too. Only `http:` and `https:` addresses, without a user name or password. An open
  redirect on the page's own origin can still lead elsewhere without a question; the
  answer then shows where the tab landed, or that the extension may not read it.
- **Only the side panel gives commands.** The connection lives in the extension's service
  worker, which the extension's scripts in every page it may read can message. Commands
  (turning AI access on or off, pairing, disconnecting one AI app or all of them, the
  relay, allowing tools, answers to questions) are taken only from the extension's own
  side panel, as Chrome reports the sender; anything else is dropped. Besides the panel,
  only the buttons of the extension's own notifications answer questions (see
  Questions). "Always allow all" over the tool list allows
  only the tools the extension itself offers on that site at that moment that are not
  read-only, so a tool the page registers later still asks. From a page, the one message
  accepted says that the page's tools changed. A compromised page can therefore not turn
  AI access on, allow a tool or answer a question.
- **Questions.** When the side panel is open, on screen and in front in the window of the
  tab the call acts on, the question is there: its Allow buttons take a click only after
  the panel has been in front for 750 ms, so the click that brings it forward cannot
  approve, and the page's scripts cannot reach the panel. Its three answers are buttons
  that look alike, so the card does not lean towards allowing. Otherwise a Chrome notification
  asks. It names the AI app (its declared name beside its verified host), the tool and,
  on a line of its own, the page's site, and the arguments in short, saying so when they
  are cut; its one button is "Allow once" ("Always allow on <host>" needs the full question), and a
  click on the notification's body opens the side panel of the tab's window, where the
  full question with all its arguments waits, its 60 s still running; where Chrome does
  not open the panel, the notification shows again. Closing the notification is Don't
  allow. Invisible, blank and direction characters in the arguments and names are shown
  as `\uXXXX`, with the same set as the client library's dialog (controls, format and
  other default-ignorable characters such as variation selectors, private-use and
  unassigned code points, every space but U+0020). In the side panel the page's site
  and the page's title for the tool are on lines of their own, labelled. Only "Allow once"
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
  whose renderer is compromised can neither read the secret (and take the extension's place
  from anywhere, A4) nor allow its own tools. The extension asks for no `storage`
  permission, so there is no `chrome.storage` area those scripts could read or write.
- **Filling in its code on the relay's page** (DEC-203). When an AI app opens the
  relay's `/authorize` page in the same browser, the extension can write its own code
  into the form and submit it, after its user's Allow. One click is less than opening
  the panel and typing a code, and the page would pair whatever client opened it, under
  the name it chose for itself (A7). So:
  - It is a setting of its own, off by default, also with access to all sites: "Fill in
    the code for me" turns it on for the relay in use and asks for the relay's site
    (one origin of the optional host access) where the extension does not have it. Only
    then is the content script registered, for `<relay>/authorize*` alone. "Stop filling
    in the code" and a change of relay turn it off and give the relay's site back (not
    access to all sites). It reads the form's `data-tab-mcp-*` attributes, its hidden
    `request_id` and that the form has a code field, nothing else of the page, and gets
    no code before the Allow.
  - The origin is the check, not the markup, which any site can copy: the service
    worker takes the page's port only from the extension's own content script, in a
    tab's top frame, at exactly the configured relay's origin (port included) and path,
    and only for the extension's own app id. A look-alike on another origin, also on
    another port of the relay's host, is ignored.
  - Only while AI access is on; turning it off withdraws a question. The question shows the AI app's verified host on a line
    of its own, labelled as verified, and its own name apart, labelled as the AI app's;
    Allow and Don't allow only, the same 60 s, focus wait and notification guard as a
    tool's question. A page that goes, another relay, AI access going off or the AI app
    connecting by a typed code withdraw it.
  - The code goes back only on that page's port, with that page load's nonce, so it
    reaches no other document. The relay checks it like a typed one; nothing about the
    relay changes. Pairing is held on 30 s for the check.
  - No loops: one question per page load. The page of the same relay request (the same
    `request_id`, which the relay keeps on its page after a wrong code) in the same tab
    within 30 s of a fill (a code that had just changed) is filled once more without a
    question, then not again in that window. Any other request asks, so a client that
    sends the tab back to `/authorize` with a new request right after a fill gets no
    second code without a question.
  - What remains: a user who allows a client they did not start pairs it, as one who
    types the code into its page would; the host on the question is the defence, as on
    the relay's page. A program on the computer that can click the panel can click Allow.
  - Where it lives (DEC-206): the content script's part, the sender check and the rules
    of asking and filling in are the client library's entry
    `@ractive-ch/tab-mcp-client/extension`, one reviewed copy that Sitegloss uses too;
    each extension supplies its question, its setting and the permission prompt, and
    the library fills in nothing without the extension's `ask` answering Allow.
- **A takeover is kept.** After another tab or program takes the extension's place, the
  extension does not take it back by itself, also after a restart, so it does not trade
  places back and forth with whoever has the secret; the side panel says so and offers
  "Disconnect all apps".
- **One address for every installation.** The extension's app id is fixed
  (`tab-mcp-extension`; `tab-mcp-extension-firefox` in the Firefox build), so everyone
  who has the extension adds the same address, and the code pairs an AI app with one
  installation (A1). A relay can reserve the first id for the extension's origins; it
  cannot reserve the second, as no list can name a Firefox extension (A11).
- **The extension's id.** The relay allows the extension by its origin. The Chrome Web
  Store item's id comes from the store, which keeps its key; the store package carries no
  key, no host access at install and no source maps. The key of the owner's development
  build is kept out of the public repository, so nobody else can load an extension with
  the id the hosted relay allows for it; a build without that key gets an id of its own,
  which a relay must allow on its own.

### A14: WebMCP callers of a page's mirrored tools (agents in the browser, extensions, other origins)

Unless a page sets `webmcp: false` (on by default, DEC-222; until then only with
`webmcp: true`), the client library also registers the page's tools with the browser's
own [WebMCP](https://webmachinelearning.github.io/webmcp/) (`document.modelContext`),
where the tab has it: Chrome with the origin trial or the flag, and, where the browser
has none, the tab-mcp browser extension's own `document.modelContext`, which it puts on
`Document.prototype` after "Give access to all sites" or, while AI access is on, in a
tab given by a click on its icon (A13, DEC-223), so that the library takes it for the
browser's. Whatever calls them there without the tab-mcp browser
extension's vouch (DEC-207) is one caller to the page, `client: { kind: "webmcp" }`,
which the page cannot tell apart from the others:

- an agent in the browser that drives the tab (built into the browser, or an
  extension that automates it): it can click in the page;
- another extension that passes on calls of an AI app outside the browser (MCP-B, say,
  as the tab-mcp browser extension does with its vouch): the AI app cannot click in the
  page, unless that extension lets it;
- a document of another origin that the page named in a tool's `exposedTo`: Chrome 156
  lets a frame of that origin (`allow="tools"`) list and run the tool
  (`kb/research/webmcp-register-tool.md`); it cannot click in the top page.

These callers sit beside the AI apps of A2 and A6, and differ from them.

- **No pairing, no identity.** Any agent the browser lets call the page's WebMCP tools
  can call the mirrored ones; the relay, its grants and its pairing are not involved,
  and the page learns nothing about the caller (`client.kind` is `"webmcp"`).
- **On by default, and what that costs** (DEC-222, the owner's decision of
  2026-11-23). Until then the mirror was off unless a page set `webmcp: true`, and the
  library treated turning it on as a change in what the page exposes. Now it is on
  unless a page sets `webmcp: false`, so what a page exposes by default includes these
  callers. The owner's reasons: the tab-mcp browser extension sees a page's tools only
  in WebMCP, so a page with a "Connect your AI app" button was invisible to the
  extension's users unless its site had set `webmcp: true`; a page that mirrors also
  offers its tools to the browser's own AI once the browser has WebMCP; and since
  DEC-209 every tool's `callers` include `"webmcp"` by default, which a mirror that was
  off by default did not fit. DEC-209 also found that keeping a tool from an agent that
  drives the tab protects nothing: the agent clicks the page's own controls instead.
  What is lost: the site no longer chooses to face WebMCP callers, it faces them unless
  it opts out. Against an extension that passes on an AI app's calls and asks nothing
  itself, and against script of an `exposedTo` origin, a consequential tool on a page
  without `onConfirm` runs unasked, on a page whose site never chose WebMCP; before,
  only a site that set `webmcp: true` took that on. A page that upgrades the library
  gets this without changing a line; the client's
  [changelog](../packages/tab-mcp-client/CHANGELOG.md) marks it as breaking, and the
  library warns nothing at run time (a warning on every page without the option would
  be noise for every site that is fine with the default, as DEC-215 reasoned). What a
  site does about it: `webmcp: false` for the whole page, `callers: ["relay", "local"]`
  for one tool, or an `onConfirm` that refuses `client.kind === "webmcp"` (the tools
  are still listed). A page that registers tools with `document.modelContext` itself
  under the same names sets `webmcp: false`.
- **It operates the page, its dialogs included.** Such an agent often drives the very
  tab it calls into: input it sends through the DevTools Protocol or an extension is
  trusted input, and the delay before Allow only needs the tab visible and focused,
  which the automation keeps it. Seen 2026-11-22 with ChatGPT's browser on the todo
  example: the call waited on the library's dialog until the agent's own timeout (40 to
  50 seconds), then the agent clicked "Allow once" itself; once it skipped the tool and
  clicked each todo's Delete button, because the description promised a question. So
  the library shows no question for any unvouched WebMCP call (DEC-215, amending
  DEC-209): a tool that asks runs, unless the page's `onConfirm` refuses it in code.
  Against an agent that drives the tab the dialog checked nothing; what checks it is the
  agent asking its user in its own chat, if it heeds the hint: such a tool is registered
  with `consequentialHint: true` (by `consequentialHint ?? destructiveHint`, since WebMCP
  has no `destructiveHint`). Hiding a tool does not help against such an agent either:
  it clicks the page's own controls instead, with no question at all (seen 2026-11-21,
  DEC-209). So every tool is mirrored, those that ask included. "Always allow" is never
  offered or applied for these calls (a call the tab-mcp browser extension vouches for
  was asked there).
- **The other two lose a real check.** Against an extension that passes on an AI app's
  calls, and against script of an `exposedTo` origin, the library's dialog was a check
  that only the user could answer. Now only the calling extension's own question (if it
  has one; the tab-mcp browser extension asks in its side panel, which is why its
  vouched calls run) or the page's `onConfirm` stands between such a caller and a
  consequential tool. A prompt injection that reaches the AI app behind such an
  extension runs the tool unasked when that extension asks nothing. A page that wants a
  tool kept from all of them leaves `"webmcp"` out of its `callers` and gives the tool
  no `exposedTo`, or refuses `client.kind === "webmcp"` in `onConfirm`. A tool that asks,
  with an `exposedTo` naming other origins, on a page without `onConfirm` gets a
  console warning once per tool, when the browser accepted its registration: a page that
  set `exposedTo` before 0.21 lost that check with the upgrade. There is no warning for a
  tool that asks and is mirrored without `exposedTo`, though another extension can call
  it too: it would be noise on almost every page that mirrors and has such a tool,
  for the behaviour DEC-215 chose; the remedy there is the same, `onConfirm` or
  `callers`.
- **The same check, in code only.** Arguments are checked against the tool's schema
  before `execute` (Chrome does not), a tool that asks goes to the page's `onConfirm`
  if it has one (`client.kind` `"webmcp"`), which must decide without showing anything
  an agent could click, and the calls appear in the page's `toolcall`/`toolcallend`
  events like an AI app's. The confirmation's chunk is not loaded for such a call.
- **Only the object behind `Document.prototype`'s getter.** Each `TabMcp` reads
  `document.modelContext` through that getter when it is made; an own property of the
  document (a polyfill such as `@mcp-b/global`, any page script) is passed by. The
  getter is the browser's, or one an extension put there before the page's scripts ran:
  the tab-mcp browser extension does (A13), and any other extension with a script in the
  page's own world at `document_start` can. Such an extension then gets every mirrored
  tool and its `execute`, by default since DEC-222; it could read and drive the page
  without that. A page that changes `Document.prototype` itself owns the tools anyway.
  A `TabMcp` that found none reads the getter again when `document` hears
  `tab-mcp-webmcp` (DEC-223: the tab-mcp browser extension's WebMCP, given at a click).
  So a script of the page, or of an extension in the page's world, that defines a getter
  later and dispatches the event gets the mirrored tools too, where the page had no
  WebMCP when the `TabMcp` was made. It gains no power it did not have: it already runs
  with the page's powers. No event can be told apart (`isTrusted` is false for the
  extension's too), so there is no check. An isolated-world content script can dispatch
  the event but not change the page's prototypes, and gains nothing.
  Who may call into the page's WebMCP at all
  (cross-origin frames need `allow="tools"`; other documents of the tab see a tool only
  if its `exposedTo` names their origin, and can then run it; which agents and
  extensions) is the browser's decision.
- **Names keep their owner.** A name the page or another script registered natively
  first stays theirs (the mirror only warns), and once a name is mirrored the page's own
  native registration of it fails. The tab-mcp browser extension (A13) offers mirrored tools like
  any other page tool, since it cannot know whether the AI app is also paired with the
  page: an AI app connected to both sees such a tool twice.
- **The tab-mcp browser extension vouches; the page believes it** (DEC-207). Right
  before the extension runs a tool the user allowed there, it tells the page (DOM
  events on `document`) the tool, the exact arguments and the AI app; the next WebMCP
  call of that tool with equal arguments within 2 seconds runs without `onConfirm`,
  once, and only for the tool registered under that
  name when the vouch came. There is no proof that the extension sent it: anything that
  could fake it already runs in the page, where it could call `execute` or skip the
  question itself. It is a convenience between two parts the user trusts (the page and
  the extension the user installed), not a security boundary; a proof would cost
  Chrome's `externally_connectable` (every site that takes part listed in the
  extension's manifest) or an attestation signed by the relay (a round trip and keys
  for every call), and script in the page could still answer for the library before it
  hears anything. Once the browser's `executeTool` settled, whatever the outcome, the
  extension withdraws the vouch (`withdraw` with its nonce) and the page drops it if it
  is still there, so a call that failed or was cancelled before it reached the page
  does not leave its vouch for another caller. What is left: an agent in the browser
  that calls the same tool with equal arguments in the moment between the vouch and
  the extension's call reaching the page takes the vouch, and that call is exactly the
  one the user allowed; the extension's call is then treated as an agent in the
  browser's (the page's `onConfirm` decides, without one it runs). A withdrawal
  cannot close that window, as it comes only after `executeTool` settled: until then
  the vouch stays usable for such a call, for a moment after a failure, and for up to
  the 2 seconds when `executeTool` neither runs the tool nor settles, or on a page that
  takes vouches with its own code and ignores `withdraw`. A site whose `onConfirm`
  insists on its own rule sets `trustExtension: false`. The page also learns, while the extension serves it,
  which AI apps are connected to the extension (A13).
- **The extension claims read-only calls and gets the whole result** (DEC-224). For a
  tool the extension runs without asking (read-only), it sends a `claim` with the same
  fields; the call that matches it is named as the AI app's and allows nothing (the
  page's `onConfirm` decides a tool that asks, as for any WebMCP call; only the type
  `vouch` skips it, whatever else a message says). So `client.via` no longer means
  that the user allowed the call; `client.allowed` is `true` only for a vouched call
  and `false` for a claimed one, in `execute`, the events and `onConfirm`'s request
  alike, for a page that asks in `execute` itself. A vouch or claim with
  `result: "mcp"` makes the matching call resolve with the whole MCP result, images
  included, instead of the text any other WebMCP caller gets. The window above now has
  one more consequence: an agent in the browser that calls the same tool with equal
  arguments in that moment also gets the whole result, pictures included, as the
  user's AI app would have, and its call is named as that AI app's; the extension's
  own call then gets the text. Nothing the agent could not get otherwise: the tool runs
  for it anyway, and the pictures are what the page shows. Equal concurrent calls of
  two AI apps can swap their names in the page's events the same way. At most 16
  vouches and claims wait in the page, each at most 2 seconds; a seventeenth drops the
  oldest, whose call then runs as an unannounced one (text, and for a vouched tool that
  asks, `onConfirm`). The relay lets at most 8 requests per tab run at once by
  default, and the extension is one tab of it, so 16 is reached only by a page or a
  script that sends its own. `trustExtension: false` ignores claims too.

### A15: The site's own assistant calling the page's tools over a port (`serve`)

With `mcp.serve(port, { client })` the page answers MCP requests on a message port,
without a relay: for the site's own assistant, e.g. a chat in a frame whose backend
runs the MCP client ([protocol](protocol.md#the-tunnel-without-a-relay)). This caller
sits beside the AI apps of A2 and A6 and the WebMCP callers of A14.

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
  an AI app. `serve`'s own `onConfirm` asks for the calls of that port (in the site's
  chat, say) in place of the page's `onConfirm` and the library's dialog, which says
  "(this site's assistant)" and never offers "Always allow"; relay calls keep the
  page's, WebMCP calls the page's `onConfirm` (A14). The library never sends the question over the port: the other
  end is the caller that wants the tool to run, and a model that follows injected
  instructions would answer yes. The page must take the answer from a user action that
  the assistant's backend cannot produce (a click in the chat's own UI, not a message
  from the backend). A page may still answer `true` for `kind: "local"` and so let its
  own assistant run such tools without a question; that is the page's decision about
  its own backend, with A6's consequences if the assistant follows injected
  instructions, and the README advises against it.
- **A6 applies in full.** The assistant's model reads the tools' results and whatever
  the user or other content tells it; the page's tools must not do more for this caller
  than for the user. A tool marked `untrustedContentHint` says so in `tools/list` and on
  every result (`_meta["ch.ractive.tab-mcp/annotations"]`, DEC-166); the consumer has to
  read the marker and keep such text apart from instructions.
- **Which tools a port sees.** A tool registered with `callers` that leave out
  `"local"` does not exist for a port: not listed, no `list_changed`, a call answered as
  for an unknown tool (DEC-165). That limits what a port can reach; it does not make a
  port safe to give to someone else.
- **No relay, no relay limits.** There is no request size limit, rate limit or
  concurrency limit on a port: the other end is the site's own code. A page that
  serves a port to code it does not trust has given up more than a limit would save.
  Each request has a time limit on the page's side (`requestTimeoutMs`, 300 s by
  default), after which the call is aborted and ends as cancelled; a listen stream has
  none. The library's confirmations are shown one at a time per document, so many
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
- The browser library registers tools with the browser's WebMCP unless a page sets
  `webmcp: false` (DEC-222; this default exposes more than the old one, A14), every tool
  whose `callers` do not leave `"webmcp"` out (DEC-209); tools
  that ask are marked `consequentialHint` there, so that a caller that heeds it asks its
  user, and the library shows an unvouched WebMCP call no question of its own (A14,
  DEC-215).

See [configuration](configuration.md#why-the-defaults-are-safe) for the reasons behind
each default.

## Risks that remain

- The relay operator can read and change all traffic. What helps: the code is open,
  you can run your own relay, and the relay logs no bodies. It cannot be solved with MCP
  over HTTPS.
- The pairing code is the only thing that selects a page: the address is the same for
  every page of an app and is not secret. Guesses are limited per network only. One
  network's 1 450 guesses a day hit one of N open dialogs of an app with probability
  N × 5.7 × 10⁻⁸; an attacker with M networks has M times that. A hit pairs the
  attacker's AI app with the page of a user they did not choose (A1).
- Users who give the pairing code to someone else, or type it for an AI app they did not
  start. Whoever is told a valid code can pair their own AI app with that page and needs
  nothing else; when every page had an address of its own, they needed that too.
  Identity binding is the cure where a site has it (A1, A12).
- A page that misleads the AI app (A10).
- The pairing page does not name the page, which the relay does not know before the
  code is typed. A user who types a code from a page that only looks like the one they
  mean connects their AI app to that page. Where an app is not reserved (`sites[].apps`),
  any origin the relay allows can serve its address; a program can claim any origin and
  with it serve a reserved app too (A10, A11).
- With identity binding, a tab assertion names the app, not one page: whoever holds a
  person's unused assertion within its 60 seconds can bind a session of their own as
  that person (A12).
- Whoever copies the address secret (script on the page's origin, or access to the
  device or browser profile) can take the page's place, also while the page is open. The
  AI apps paired with it then send their arguments to them and get their tool
  descriptions and results, which can steer the user's AI session; this lasts until the
  page gets a new secret. The relay sends them the pairing codes like to any page, so
  they can also pair an AI app of their own; once the owner's page is connected
  again (without having seen the takeover), that AI app calls the real
  page's tools until it is disconnected or the page gets a new secret. The page lists it
  among its connected AI apps and cannot tell it from one the user paired. The page says
  that it was taken over when it sees it happen and offers "Disconnect all apps", but cannot
  prevent it; identity binding does (A4, A12). Pages must keep cross-site scripting out, as for
  any session secret.
- Everyone behind one address shares its guess limit and its ten open requests: someone
  on the same network can keep the others out of pairing (A1). A party with very many
  networks can push other users' connection requests out (A1, A8).
- With identity binding, anyone can open `/authorize` for an app with an AI app of their
  own. A user who follows such a link and clicks Connect within 10 minutes after they
  opened their page's dialog (or chose Continue in it), while it is still open, pairs
  that AI app with their page, if the provider's single sign-on asks nothing. The
  pairing page names the AI app's verified host (A12). With a client library before
  0.19 every reconnect of the page starts another 10 minutes, so a forgotten dialog
  stays pairable; the limit is complete only with a newer library (DEC-202).
- On a page that pairs by code, the next user of the same browser profile gets the AI
  apps the previous one paired (A1).
- A model can be steered by content (prompt injection) into calling tools the user did
  not intend. The page's confirmation covers consequential tools only, and consent per
  tool is the page's: one `tools` scope covers every tool (A6). A tool the user allowed
  for an AI app (or "everything") runs on that app's say until the app is disconnected,
  up to 90 days, with nobody looking (A6).
- AI app names are self-declared; only hosts are verified.
- The relay accepts one known client bug: the header `MCP-Protocol-Version: 2025-11-25`
  with a body that declares `2026-07-28`. It is limited to this exact pair.

- With identity binding: a taken-over account at the provider, a leaked assertion key or
  a web app that vouches for the wrong user (A12).
- With the tab-mcp browser extension: a tool that runs without asking (marked read-only by the page,
  or with its "Always allow" switch on for its site) does whatever the AI app asks of it, and another program on
  the computer can click a notification or the side panel (A13).
- With the mirror on (the default since DEC-222; a page without `webmcp: false`), a page
  without an `onConfirm` that refuses unvouched WebMCP calls, and a consequential tool
  whose `callers` include `"webmcp"` (the default): the library asks no WebMCP caller
  (A14, DEC-215). A site that never thought about WebMCP is in this case once it
  upgrades.
  - An agent in the browser that ignores `consequentialHint` runs the tool without its
    user's word. It could already click the page's own controls, or the library's
    dialog when there was one.
  - An extension that passes on an AI app's calls and asks nothing runs the tool on that
    AI app's say, a prompt injection included. Before DEC-215 the library's dialog
    stopped it until the user answered.
  - Script of an origin named in the tool's `exposedTo` runs it unasked. Before, the
    dialog stopped it.
