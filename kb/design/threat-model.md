---
type: design
title: "Security model and threat model"
description: Assets, attackers, what the relay sees, the mitigations and safe defaults, and the risks that remain.
tags:
  - security
  - design
timestamp: 2026-11-12T16:30:00+01:00
---

# Security model and threat model

Becomes `SECURITY.md` (reporting, supported versions) and `docs/threat-model.md` in
[iteration 5](/iterations/iteration-5-packaging-release.md).

## Assets

1. **The page's capabilities**: whatever the tools can read or do in the user's tab
   (calculator state; in saturnus, the emulated calculator's memory and files).
2. **Tool arguments and results** in transit through the relay.
3. **Tokens**: anyone holding an access token can call the tab's tools while the tab is
   open, for up to an hour; a refresh token yields new access tokens for up to 30 days.
4. **The address secret** in the page's `localStorage`: whoever has it can take over the
   address (but not existing grants' tokens).
5. **The token store** (SQLite file): token hashes and grant metadata.
6. **The user's attention**: pairing dialogs and confirmations must not be spammed or
   confusing.
7. **The relay's availability and its operator's bill.**

## Trust boundaries and what each party sees

| Party | Sees | Trusted for |
|---|---|---|
| Page (and its author) | its own tools, pairing codes | defining tools honestly; it already runs in the user's browser (see A10) |
| Relay operator | **every tool argument and result in clear text** (TLS ends at the relay), client ids, IP addresses, timing | not logging or altering traffic |
| AI app | the tools it is allowed to call, their results | following the user's intent (it is driven by a model) |
| Model provider behind the AI app | the same as the AI app | — |
| Agent in the browser (only with `webmcp: true`, A14) | the tools the page mirrors into WebMCP, their results | — |
| Network | nothing (TLS everywhere; `wss:` and `https:` only outside development) | — |

The relay cannot be made blind: the AI app speaks HTTPS to the relay and the MCP payload
must be readable to be forwarded. Users who do not trust a public relay self-host it.

## Attackers and mitigations

### A1: Someone who learns the address (shared screenshot, chat log, shoulder-surfing)

- The address alone grants nothing: every MCP request needs a token, and a token needs the
  pairing code that only the tab shows (DEC-028).
- **Pairing code typed at `/authorize`**: 6 digits, single-use, valid 2 minutes, at most 5
  attempts per code, issued only while the page's dialog is open. An attacker without a
  view of the tab has 5 guesses in a million per code. The page names the AI app and the
  page origin, so the user sees what they are connecting.
- Guesses are also limited per address and network (10, then 1 a minute) and per address
  overall (30, then 1 every 30 s); only a well-formed code against an active code counts,
  so junk cannot lock the owner out (DEC-061). Even an attacker who could keep fresh codes
  coming gets about 2 880 guesses a day per address against a million codes, and only
  while the user keeps the page's dialog open. An attacker on many networks can make the
  owner wait; "New address" in the page ends that, because the attacker does not learn
  the new address. Per-IP limits count an IPv6 /64 as one network.
- No 404 for unknown addresses (DEC-040): without a token every address looks the same.
- "New address" in the page revokes the old address's grants and replaces the secret.
- Residual: a user who reads the code out to someone else (social engineering), or types it
  into a pairing started by an attacker's AI app. The page shows which app is connecting.

### A2: A malicious or impersonating OAuth client

- Client registration only through Client ID Metadata Documents: the `client_id` is an HTTPS
  URL the relay fetches; the document's `client_id` must equal the URL and `redirect_uri`
  must be listed. Exact match, except loopback redirects where the port is ignored
  (RFC 8252).
- The pairing page shows the declared name **and** the verified client id host and redirect
  host; a client calling itself "Claude" from `evil.example` shows `evil.example`.
- PKCE S256 required; codes are single-use, 60 s, bound to client id, redirect URI and
  resource, and burnt by their first presentation even if a check fails; a code presented
  twice revokes the grant made with it. `iss` in every response (RFC 9207) defeats mix-up.
- The `client_id` must be its own canonical URL, so look-alike spellings of one client id
  (case, dot segments, explicit ports) are refused rather than treated as other clients.
- Redirect URIs must be `https:`, loopback `http:` or a reverse-domain native scheme
  (DEC-067). Invalid requests are shown on a relay page with a link back instead of being
  redirected, so a self-published client cannot use the relay as an open redirector
  (DEC-064); only the user's own Cancel redirects at once.
- Shown names lose invisible and format characters, names with a web address in
  parentheses are refused, and the heading reads "Connect <name> from <verified host>"
  (DEC-065).
- Optional operator allow-list of client id hosts (`TAB_MCP_CLIENT_ID_HOSTS`).

### A3: SSRF through CIMD fetches

The relay fetches a URL chosen by an unauthenticated party. Guards: `https:` only, default
port only, no credentials in the URL, resolve the host first and refuse private, loopback,
link-local, CGNAT and multicast ranges (IPv4 and IPv6), no redirects, 5 s timeout, 64 KiB
limit, `application/json` only, response cached per `Cache-Control` (max 24 h, min 5 min),
per-host fetch rate limit (5, then 1 every 5 s) and one for all fetches (30, then 1 a second).
IP literals are judged directly; host names are refused if any resolved address is not
public. The fetch connects to the vetted address itself, with the original `Host` and TLS
server name (DEC-066), so DNS rebinding between check and connect does not reach another
address. Every failure from resolving to parsing shows the same message without upstream
status, so the page cannot be used to probe what answers where. The test-only switch that lets the
fetcher reach a loopback fixture exists only behind `createTestRelay`, which the package
does not export and which refuses to run outside development (DEC-059).

### A4: Token theft and replay

- Tokens are 256-bit random, opaque, stored only as SHA-256 hashes (a stolen store file
  yields no usable token), accepted only in the `Authorization` header and only for their
  own address (audience check against `resource`).
- Access tokens live 1 hour. Refresh tokens live 30 days (at most until 90 days after
  pairing) and rotate on every use; reusing
  an old one revokes the whole grant (RFC 9700), which cuts off a thief and the victim
  alike and shows the theft. `markUsed` is atomic, so two racing refreshes cannot both win;
  the loser counts as reuse (DEC-058). A refresh token presented by another client id is
  refused without revoking.
- Refreshes slide by 30 days, but no token outlives the grant's absolute end, 90 days after
  pairing (DEC-062): a stolen refresh token cannot be kept alive forever.
- Revocation leaves a tombstone in the store and `put` refuses tokens of a revoked grant
  atomically, so a refresh that races Disconnect cannot bring the grant back (DEC-063).
- Disconnect in the page revokes at once; "New address" revokes all grants of the old
  address. A revocation also ends the grant's requests in flight and listen streams
  (401 / an error event, `http.cancel` to the page), and a request authenticated before
  but still waiting for its page re-checks its token before it is forwarded; the
  instance also remembers its own revocations for two minutes and refuses such a request
  right before the forward. A grant dates from its authorization code, so a code issued
  before "New address" or "revoke all" is refused by the address tombstone, and those two
  also drop the address's pending requests and codes (branch relay/review-fixes).
- Tokens are useless while the tab is closed ("the page is not open", HTTP 200 with a
  JSON-RPC error or tool error after a bounded wait; DEC-074).
- The relay never forwards the `Authorization` header to the tab.

### A5: A hostile page or another site using someone's relay

- Tab WebSockets only from allowed origins (default: none; DEC-032). An open relay needs
  `TAB_MCP_ALLOWED_ORIGINS=*` and logs a warning. The owner's hosted relay allows only
  the owner's own pages and extensions. This stops other websites in a browser; a
  non-browser client can forge `Origin`, so it is abuse control, not a security boundary
  for users.
- Limits: sessions per IP (5; IPv6 per /64 and per /56) and in total (500), message and
  body size (1 MiB), concurrent requests per session (8), request timeout (300 s), idle
  timeout (10 minutes for a session that never had a grant, started pairing, signed in or
  got a request; else 1 hour), session lifetime.

### A6: The AI app (or a prompt injection) misuses the tools

- Read-only and harmless tools run directly; tools marked `consequentialHint` ask in the
  page before each run, showing the client and a summary of the arguments.
- Annotations reach the AI app as MCP hints (`readOnlyHint`, `destructiveHint`) so it can
  ask too, but the page's confirmation does not depend on the AI app.
- `untrustedContentHint` tools mark their results so AI apps can treat them as untrusted
  data (mapping in the decision log).
- The user sees connected apps in the page and can revoke them or disconnect at any time.

### A7: Cross-site attacks on the relay's pages

- `/authorize` sends `Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' <redirect origin>`,
  `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Cache-Control: no-store`; the
  page has no JavaScript. Framing is refused so the code field cannot be overlaid.
- The form posts only a pending-request id; its `Bun.CSRF` token is bound to that request
  and to a first-party `HttpOnly`, `SameSite=Lax` cookie, and posts with a foreign `Origin`
  or `Sec-Fetch-Site` are refused (DEC-057). No `Cross-Origin-Opener-Policy`, because
  claude.ai's popup flow needs its opener back.
- All values shown on the page (client name, page origin) are HTML-escaped and
  length-capped.
- CORS without credentials on the metadata, token, revoke and MCP endpoints (DEC-036):
  `Access-Control-Allow-Origin: *`, never `Allow-Credentials`; the relay uses no cookies
  there and tokens are only bearer headers, so a foreign origin can do nothing it could not
  do from a server. The MCP spec's `Origin` check protects local servers from DNS
  rebinding; a public relay with bearer tokens has no ambient authority to protect.
  `TAB_MCP_CORS=off` turns it off.

### A8: Denial of service

In-memory token buckets: `/authorize` page loads and posts per IP, guesses per address
and network and per address, `/token` and `/revoke` per IP, CIMD fetches per host and in
total (DEC-059, DEC-061); IPv4 counts per address, IPv6 per /64. Only wrong guesses
are charged (a right code is refunded). The per-address guess cap fails closed when full
(100 000 addresses): a bucket that still counts something is never dropped, so churning
keys cannot reset it; the per-address-and-network share evicts its oldest when full,
since failing closed there would let a few networks refuse everyone's first guess.
`/token` and `/revoke`: failures per IP (30, then 1/s) turn a further failure into 429
but never refuse a success, so one hosted AI app's users behind shared egress do not
block each other; a ceiling on all requests per IP (600, then 20/s, not refunded) bounds
work and store writes, also grant rotation; keying by `client_id` was rejected because
any request can name a well-known one (DEC-117).
Session limits per IP for `/tab` count IPv6 per /64 and per /56; concurrent requests per
session for the MCP endpoint; pending
authorizations and codes are bounded maps with expiry; WebSocket backpressure checked on every send (a dropped send fails the
request instead of hanging); bounded maps with expiry sweeps. A single-instance relay can
still be flooded; the CDN in front absorbs volumetric attacks.

### A9: Logs and privacy

Logs are JSON lines with event, a shortened address id, session id, MCP method, HTTP
status, duration, client id host and coarse error codes. Never bodies, tool names,
arguments, results, tokens, codes or secrets. Client IPs appear only in rate-limit warnings,
truncated (/24, /48). The hosted instance's privacy notice states this.

### A11: Several sites on one relay (DEC-045)

- One relay may serve several sites, each configured by origin. The relay verifies the
  origin (from the browser's `Origin` header); the app name a page sends is self-declared
  and unverified. The pairing page therefore shows the name next to the verified origin:
  "to saturnus on `https://ractive.ch`". Pages on the same origin can claim each other's
  names; within one's own origin that is acceptable, because they share a trust domain
  anyway (same-origin pages can read each other's `localStorage` and secrets).
- A configured site `name` overrides the page's claim.
- Sites share one operator, one store and one log; a project that needs separation gets
  its own instance.

### A10: A page that misleads (phishing)

Connecting an AI app to a page means trusting that page like any MCP server (DEC-038): its
tool descriptions and results reach the model, and it can describe a tool in misleading
ways or return text that steers the model. tab-mcp cannot judge a page's honesty; the
pairing page names the page's origin so the user knows whom they trust. The closed origin
list (DEC-032) keeps other sites from borrowing a hosted relay's domain to look
trustworthy. `SECURITY.md` says this plainly.

### A13: The browser extension and the pages it bridges (iterations 19, 20 and 26)

tab-mcp for Chrome ([design](/design/extension.md)) offers the WebMCP tools of the page
in front to the user's AI app. That page did not choose the relay or the AI app: the user
did, by connecting the extension.

- **The page is untrusted, all of it.** Tool names, titles, descriptions and schemas
  reach the AI app's tool list, where no hint can mark them; a description can carry
  instructions. Descriptions start with the page's origin (`From https://…:`) and are cut
  to 1000 characters, titles to 100; schemas over 16 KB and more than 64 tools are left
  out, as is a tool whose `page_<name>` equals one of the extension's own tools (`info`
  as `page_info`): not offered and not callable through `webmcp_call`; a tool the
  library refuses to register is not callable through `webmcp_call` either. Every
  result is marked untrusted (`untrustedContentHint`, mapped to MCP's
  `openWorldHint`); its text, all blocks together, is cut to 100,000 characters, with at
  most 32 blocks and the images of one result up to 640 KiB of base64 together (an image
  beyond is replaced by a note), so a result stays within the relay's default 1 MiB per
  response; a result over 2 MiB is refused in the page, and the page's title and
  language are cut to 300 and 64 characters (iteration 35). `webmcp_tools` lists names
  cut to 128 characters, descriptions with the same origin prefix, and each offered
  tool's input schema as offered.
- **The origin is Chrome's (iteration 35).** The origin that prefixes descriptions, keys
  "allowed" and is shown as "Site (verified)" comes from the content script's answer, so
  the bridge compares it with the origin of the address Chrome reports for the tab and
  offers no tools when they differ. A page with a compromised renderer can therefore not
  borrow another site's origin, and with it the tools the user allowed there.
- **Hints can lie.** A tool the page marks read-only runs without asking; anything else
  asks the user every time (see "Questions" below), naming the page's origin. The user
  can stop the questions for a tool of one exact http(s) origin, for every paired AI app
  and kept until taken back: "Don't ask again on <host>" in a question, or the "Ask first" switch in
  the panel; both write the same entry (the ephemeral per-AI-app, per-page "Always
  allow" is gone, DEC-139). A tool that changed while the question was open (a
  navigation, another tab in front with a tool of the same name) does not run. An
  allowed tool runs whatever the AI app (or a prompt injection steering it) asks of it.
  A page can only mark its own tools read-only, so a lie harms that page's own user
  session, which its scripts could reach anyway.
- **A call runs only where its tool was listed.** Each page's content script has its
  own id; a call carries it and the read-only claim its tool was offered with, and the
  content script refuses if the tab navigated since or the claim changed. So a page
  cannot offer a "read-only" tool and then navigate the tab to a site whose tool of that
  name changes things.
- **Arguments are checked by the library** against the page's schema before the call;
  Chrome does not check them. The schema's `pattern` and `patternProperties` are left
  out in keyword position only (a parameter called `pattern` stays), so a page's
  catastrophic regular expression cannot freeze the connection. Calls end for the AI app
  after 60 s or on its cancellation even if the page never answers; a page that does not
  answer the list, `page_info` or history in 5 s is given up, so a stuck page cannot hold
  the bridge for every other tab (iteration 35).
- **Flooding.** The content script reports `toolchange` at most every 250 ms, sends at
  most 256 tools with names cut to 256 and texts to 4000 characters, and drops schemas
  over 16 KB; the bridge reads one list at a time and lists at most 64 tools.
- **A forged `document.modelContext`** in the page's world does not reach the content
  script, which sees only the browser's own object (iteration 18). Only the extension's
  own pages talk to the content script.
- **Which page.** Without host access the extension reads a tab only after a click on its
  icon there, and only on that origin. With "Read all sites without a click" it reads every page in
  front: the AI app then gets the tools of whatever site the user looks at, each call to
  a tool not marked read-only still confirmed. Only http(s) pages (the optional host
  access is `http://*/*` and `https://*/*`, no `file:` pages) and no Incognito tabs
  (`"incognito": "not_allowed"`, DEC-142). `page_info` and every navigation result give
  the page's address with its query and fragment, without a question: a paired AI app
  (and the relay) can read the address of the tab in front, including a token in a
  magic link or an OAuth callback; PRIVACY.md and the store listing say so (the
  fragment is kept, as single-page apps route with it).
- **Navigation (iteration 27, DEC-121).** `navigate`, `go_back`, `go_forward` and `reload`
  act only on the tab in front while the extension may read it, so the AI app cannot
  steer a tab the user never gave it. A page's text (a tool result, a description) can
  tell the AI app to open another site: within the page's origin a navigation runs
  without asking (a link on the page could do the same), to another origin it asks the
  user, with the tab's origin ("From", verified) and the address ("To", invisible
  characters escaped); Allow and Don't allow only, so one click is no standing
  permission, and a tab that changed origin while the question was open is not
  navigated, nor one that is no longer the tab in front. Back or forward to an entry the Navigation API does not list (it lists only
  the page's origin) asks as well, the address not being known. Only `http:` and
  `https:` addresses, without user name or password (`https://shop.example@evil.example`
  is evil.example), at most 8192 characters. Residual: a GET on the page's own origin
  runs without a question and can change things there (`/logout`, a link with an
  action), as a click by the page's own script could; an open redirect on the page's
  origin leads to another origin without a question (seeing it before it happens would
  need `webNavigation` or `declarativeNetRequest`), and the answer then shows where the
  tab landed, or that the extension may not read it there.
- **The extension's id** is the relay origin `chrome-extension://<id>`. The development
  build's key is kept out of the public repository, so nobody else can load an extension
  with the id the hosted relay allows; the Chrome Web Store keeps its own key.
- **Who may send what (iteration 26).** The connection lives in the service worker,
  which content scripts in every granted tab can message too. Commands (connect, turn
  off, pairing, disconnect an app, new address, the relay, the "Ask first" switches,
  "Don't ask for these tools",
  answers to questions) come only over the side panel's named port, whose sender Chrome reports: an
  extension page of this extension at the panel's path, not in a tab; any other port is
  closed at once, and a command that does not parse is dropped. The one other port is a
  question's own window (`question/index.html`, in a tab): the worker takes it only from
  a window it opened for one question, and it can only answer that question. "Don't ask for
  these tools" carries the
  site and the tool names, at most 64, and the worker allows only those it offers on
  that site itself, now, that are not read-only: names from the panel are not taken on
  trust, and a tool the page registers later still asks first. "Ask first for these tools"
  takes away
  every name it carries on that site, offered now or not, so a tool the page dropped
  or marked read-only since cannot come back allowed. When the page changes what the
  button would do (its label, its tools, or it just appeared), the button and the
  switches stay off for 750 ms. The one message a
  content script may send is `webmcp-changed`, which only makes the bridge read the
  tools again. A compromised page can therefore not turn AI access on, allow a tool or
  answer a question; a compromised extension page could, but then the extension is
  lost anyway.
- **Questions (iteration 26).** With the panel open and on screen in the focused window
  of the tab the call acts on (not covered by another extension's panel for the tab,
  which the panel reports as it changes; a covered panel hands its questions to
  notifications), the question is there, and Allow arms only after the panel has been
  visible and focused for 750 ms, so the click that brings it forward cannot approve;
  the page's scripts cannot reach the panel at all. Otherwise a Chrome notification asks.
  It names the AI app by its verified host beside its declared name, the tool (the
  page's title cut to 60 characters on its own) and, on a line of its own, its site, so
  a long title cannot push the site out, and the arguments cut to 150 characters,
  saying so ("Arguments cut: click to see them in full."). Invisible, blank and
  direction characters are written as `\uXXXX`, with the client library's set
  (`escapeInvisible`, shared since ext/review-fixes): controls (C0 and C1 but tab and
  line feed), format and other default-ignorable characters (variation selectors
  U+FE00 to U+FE0F and U+E0100 to U+E01EF, U+034F, the Hangul fillers), private-use,
  unassigned and lone surrogate code points, line and paragraph separators, every space
  but U+0020 and U+2800.
  Its one button is "Allow once", also when the arguments are cut: the owner's decision, as the
  AI app's own chat shows the call and the full arguments are a click away. "Don't ask
  again" is not on the notification (iteration 35): allowing a tool for good needs the
  whole question. A click on its body opens the whole question, the
  arguments in full (scrollable), with Don't allow, "Allow once" and "Don't ask again on
  <host>": in the side
  panel of the tab's window (`sidePanel.open` from `notifications.onClicked`, which
  Chrome dispatches with a user gesture; called before any `await`), or, where Chrome
  refuses that, in a small popup window of the extension's. The question stays pending
  there with its 60 s running; the notification is cleared, and its closing after the
  click answers nothing. Closing the notification, closing that popup window or letting
  the 60 s run out is Don't allow. The end-to-end tests cannot give the gesture (the
  DevTools Protocol's `userGesture` does not reach the worker's `sidePanel.open`), so
  they cover the popup path; the side panel path rests on Chromium dispatching
  `onClicked` with the gesture. In the panel and the popup, the site is on a line of
  its own ("Site (verified)") and the page's title for the tool apart, labelled as the
  page's. Each question's arguments go to a panel once, in a message of their own, not in
  every state (several large ones in one state could pass Chrome's message limit and
  leave the panel without any state); at most 5 questions of one AI app wait at once,
  a further call of that app is declined without asking. A click on Allow within 500 ms of showing does not count (it
  shows again), so a click meant for something that was there before cannot allow. Each notification
  carries its call: a click answers only that call, and one on a call already answered,
  timed out or cancelled is dropped, never taken for another. A notification is outside
  any page, so a page cannot cover or click it; another program on the computer could
  click it, as it could click the panel. Disconnect asks first, and the second click of
  a double click (within 750 ms) does not confirm it. No answer in 60 s is Don't allow; with
  notifications off (Focus, Do Not Disturb) the icon shows "?" and the panel asks.
- **A connection with no panel on screen (iteration 26).** AI access stays on with the
  panel closed and comes back after a browser start, an update or a reload when the
  user left it on; it starts only from the panel's button. The icon's badge says "on"
  while connected, so the user sees it without opening the panel. Read-only and
  "allowed" tools run with nothing on screen, as they did with the panel open but not
  looked at. "Allowed" (and "Don't ask again", which writes it) exists only for http(s)
  origins: every opaque origin is `null`, and one entry would cover them all. Panel
  commands, and the "allowed" a question writes, run one after another, so a stop is
  never overtaken by the connect before it, nor two writes of "allowed" by each other.
  When the panel's questions move (one is answered, or one comes and pushes the panel
  down, iteration 35), its "Allow once" buttons, "Don't ask for these tools" and the
  "Ask first" switches take no click
  for 750 ms, so a click lands on nothing that allows. While AI access is on and the
  relay cannot be reached, the panel says "retrying" (the alarm, also set at every
  start, connects again each minute), not "off" (iteration 35).
- **The extension's settings are out of web pages' reach.** The address secret, the tools
  allowed per site, the relay, whether AI access is on and the takeover flag are in
  IndexedDB in the extension's own origin, opened by the service worker only (the side
  panel asks the worker). A content script runs in the page's origin and cannot open
  that database, in any Chrome version and from the first moment of a browser start, so
  a page's compromised renderer, running code in the content script's world, can neither
  read the secret (and take the address over from anywhere) nor allow its own tools.
  The extension asks for no `storage` permission (ext/review-fixes): without it there is
  no `chrome.storage` area at all, so nothing a content script could write there (where
  the owner's development builds once kept the settings) can be picked up, and the
  `TRUSTED_CONTEXTS` layer is gone with it; an end-to-end test checks that
  `chrome.storage` is undefined in the content script's world and the worker. A one-off
  import from that area was never kept: its "migrated" marker would live in the
  database it guards. The worker's connection to the database is opened again when
  Chrome closes it under the worker (a deletion, a version change), instead of being
  used dead. A worker whose start fails (the database refused, say) keeps the error,
  shows it in a panel that connects and tries the start again at the next event or
  panel message, instead of leaving the panel silently dead; a panel that connected
  while it failed is attached as soon as any start succeeds, and what it said meanwhile
  is kept (at most 64 messages).
- **Notifications cleared once made.** A notification is cleared (answered, timed out,
  cancelled, shown again) only after its `create` has finished, so none stays on screen
  with buttons that answer nothing.
- **A takeover is kept (iteration 26).** After `replaced` the worker stores the fact and
  connects again neither at its next start nor on its alarm, so it does not take the
  address back and forth with whoever has the secret; the panel shows the notice until
  the user connects (taking it back) or makes a new address, which first takes the old
  address back and revokes its grants while connected.

### Identity binding

With [identity binding](/design/identity-binding.md) the AI app acts with exactly the
rights of the tab's user, because both must be signed in as the same person at the same
OpenID Connect provider. A taken-over provider account then also gives the AI connection.
The web app's assertion signing key and the relay's OIDC client secret become operator
secrets. A mismatch is refused with "This AI tool is logged in as someone other than the
page." The threats and mitigations are in `docs/threat-model.md` (A12) and DEC-076 to
DEC-079.

### A14: Agents in the browser calling mirrored tools (WebMCP, iteration 25)

With `webmcp: true` the library also registers the page's tools with the browser's own
[WebMCP](https://webmachinelearning.github.io/webmcp/) (`document.modelContext`). Agents
in the browser call them without pairing and without an identity (`client.kind`
`"webmcp"`). Such an agent often drives the tab and can click Allow itself, so
consequential tools are mirrored only when their `callers` list `"webmcp"`; calls get
the same schema check and confirmation, never "Always allow". Only the native object is
used. tab-mcp for Chrome offers mirrored tools like any page tool (DEC-140): an AI app
connected to both the page and the extension sees such a tool twice, and a consequential
one asks in the extension and in the page. The full analysis is A14 in
`docs/threat-model.md` (DEC-115, DEC-119).

### A15: The site's own assistant over a port (`serve`, iteration 28)

With `mcp.serve(port, { client })` the page answers the tunnel's `http.*` messages on a
message port, without a relay. A port is a capability: whoever holds the other end calls
the tools without pairing, so the page must check the frame's origin before it hands one
out; the library has no handshake of its own. The library sets the grant itself and
ignores one sent on the port, so the caller is always `client.kind` `"local"` and cannot
pass for a paired AI app. Consequential tools still ask ("(this site's assistant)", never
"Always allow"), or `serve`'s own `onConfirm` asks for that port (in the site's chat);
the question never goes over the port, whose other end is the caller, and the answer must
come from the user's click. `callers` without `"local"` hide a tool from every port. No
relay limits apply on a port; each request has a page-side time limit. The full analysis
is A15 in `docs/threat-model.md` (DEC-122 to DEC-126, DEC-164 to DEC-167).

## Safe defaults

- No tab origins allowed until configured; `*` only explicitly, with a warning.
- `TAB_MCP_PUBLIC_URL` must be `https:` unless `NODE_ENV=development`.
- No unauthenticated MCP mode exists, not even as a flag.
- `development: false`, body limits set, `server.timeout` handled explicitly.
- Sessions start only from a click (`connect()` refuses to run without transient user
  activation, `navigator.userActivation.isActive`, where the browser supports it).

## Residual risks

- The relay operator can read and alter all traffic. Mitigation: open source, self-hosting,
  no logs of bodies; not solvable with MCP over HTTPS.
- Users who give the pairing code to someone else, or type it for an AI app they did not
  start.
- A page that misleads the AI app (A10).
- Whoever copies the address secret out of `localStorage` (e.g. a script injected into the
  page) can take over the address, also while the page is open. To the relay that session
  is the page, so the relay sends it the pairing codes and the holder can pair an AI app of
  their own; that grant belongs to the address. When the owner's page later holds the
  address again without having seen `replaced` (closed during the takeover, reloaded, the
  extension reconnecting), the holder's AI app calls the real page's tools until it is
  disconnected or the page gets a new address; the page lists it among its AI apps and
  cannot tell it from the user's own. The relay does not prevent it (pre-release review of
  2026-11-09: documented, no new relay mechanism, DEC-117); identity binding does. Pages must
  keep XSS out, as for any session secret.
- Session slots: the unpaired timeout and the /56 count raise the cost, but a program that
  does what a real page does (start pairing) from enough networks (a free /48 tunnel has
  256 /56s) still holds slots (DEC-097).
- The AI app's model can be steered by content (prompt injection) into calling tools the
  user did not intend; page-side confirmation covers consequential tools only.
- Client-declared names are self-asserted; only hosts are verified.
- With the browser extension, a page's tool metadata and results reach the AI app as the
  page wrote them (cut, prefixed, marked); a read-only claim is the page's (A13).
- The known Claude header bug tolerance (decision log) slightly widens what the relay
  accepts; it is limited to one exact version pair.

# Citations

- [MCP authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [CIMD draft (draft-ietf-oauth-client-id-metadata-document)](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)
- [RFC 8252 §7.3 loopback redirects](https://www.rfc-editor.org/rfc/rfc8252#section-7.3)
- [RFC 9207 issuer identification](https://www.rfc-editor.org/rfc/rfc9207)
- [RFC 9700 OAuth security best current practice](https://www.rfc-editor.org/rfc/rfc9700)
- [WebMCP draft (annotations)](https://webmachinelearning.github.io/webmcp/)
- [MCP 2026-07-28 research](/research/mcp-2026-07-28-spec.md)
