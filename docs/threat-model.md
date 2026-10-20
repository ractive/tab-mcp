# Threat model

What tab-mcp protects, from whom, how, and what it cannot protect against. It describes
relay `@ractive-ch/tab-mcp` and browser library `@ractive-ch/tab-mcp-client`
0.1.0-alpha.1. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

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
   address, but not the tokens of apps already connected.
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
- Without a token, every address looks the same: no 404 for unknown addresses, so
  addresses cannot be probed.
- "New address" in the page revokes the old address's connections and replaces the
  secret.
- Left over: a user who reads the code out to someone else, or types it for an AI app an
  attacker started. The pairing page names the AI app and the page origin.

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
  parentheses are refused, because they would look like the verified host.
- An operator can limit which AI apps may connect with `TAB_MCP_CLIENT_ID_HOSTS`.

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
- fetches are rate-limited per host (5, then 1 every 5 seconds) and overall (30, then 1 a
  second);
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
  wins and the other counts as reuse. A refresh token presented by another client id is
  refused without revoking.
- Revocation leaves a tombstone in the store, and the store refuses new tokens for a
  revoked grant atomically. A refresh that races Disconnect cannot bring the grant back.
- Disconnect in the page revokes at once. "New address" revokes all grants of the old
  address.
- Tokens are useless while the page is closed: requests get 503 "the page is not open".
- The relay never forwards the `Authorization` header to the page.

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
address and network and per address, `/token` and `/revoke` per IP, and metadata fetches
per host and overall. IPv4 counts per address, IPv6 per /64. Sessions are limited per IP
on `/tab`, and concurrent requests per session on the MCP endpoint. Pending
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
trust. The closed origin list keeps other sites from borrowing a relay's domain to look
trustworthy.

### A11: Several sites on one relay

- One relay may serve several sites, each configured by origin. The relay verifies the
  origin from the browser's `Origin` header. The app name a page sends is its own claim
  and is not verified, so the pairing page shows the name next to the verified origin:
  "saturnus on `https://ractive.ch`".
- Pages on the same origin can claim each other's names. That is acceptable: they share
  a trust domain anyway (same-origin pages can read each other's `localStorage`).
- A configured site `name` replaces the page's claim.
- Sites on one relay share one operator, one store and one log. A project that needs
  separation runs its own relay.

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
- Whoever copies the address secret out of `localStorage`, for example with a script
  injected into the page, can take over the address while the page is closed. Without a
  token they can call nothing, but they can pair a new app if the user then types a code
  for them. Pages must keep cross-site scripting out, as for any session secret.
- A model can be steered by content (prompt injection) into calling tools the user did
  not intend. The page's confirmation covers consequential tools only.
- AI app names are self-declared; only hosts are verified.
- The relay accepts one known client bug: the header `MCP-Protocol-Version: 2025-11-25`
  with a body that declares `2026-07-28`. It is limited to this exact pair.

## Planned: identity binding

A later version may connect an AI app to a page only if both are signed in as the same
person at the same OpenID Connect provider. The AI app would then act with exactly the
rights of the page's user. A taken-over provider account would then also give the AI
connection. Until it exists, sites that set `"pairing": "oidc"` are refused at start.
