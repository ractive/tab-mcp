# Changelog

All notable changes to the published packages. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Each package is released on its own,
with the Git tag `client-v<version>` or `relay-v<version>`.

## @ractive-ch/tab-mcp-client

### [0.8.0][client-0.8.0] - 2026-10-25

#### Changed

- **Visible change: "Always allow" is opt-in** (DEC-096). The default confirmation now
  shows only "Don't allow" and "Allow", so every call of a consequential tool asks.
  `alwaysAllow: true` on `TabMcp` (or `TabMcpProvider`) brings "Always allow" back.
  It lifted the only brake at run time for a tool until a reload, which is what a prompt
  injection needs.
- `replaced` carries `detail: { sibling }` (was `null`): `true` when a tab of the same
  page in this browser said on a `BroadcastChannel` that the relay accepted its session
  for the address, `false` when none did (or without `BroadcastChannel`), which may be a
  program with a copy of the address secret (DEC-095). The channel carries neither the
  secret nor the address. Listeners that ignore the detail work as before.
- **Order of events when replaced:** the session ends at the relay's `bye`;
  `disconnected` (reason `replaced`) comes at once, and `replaced` after it, up to a
  second later while the library waits to hear from a sibling tab. Before, `replaced`
  came first.
- `newAddress()` after `replaced` (from the event, during that second, or later) takes
  the address back first: it connects with the old secret and `hello.revokeAll`, so the
  relay revokes the AI apps that talk to whoever took it over in the same step, and
  makes the new address only once the relay confirmed it (no grants left). Taken over
  again before that, it rejects (`reason: "replaced"`), keeps the old secret, and a retry
  takes it back again. Against a relay of 0.4 or older, which ignores the field, it sends
  `grants.revokeAll` and waits until every grant is gone. It no longer needs a fresh user
  action for the reconnect when the page was connected.
- The tools allowed with "Always allow" are kept in the lazily loaded UI chunk, which
  makes the core smaller.

#### Added

- The default UI says when the page loses its address, once the page has opened the
  connect dialog: "Opened in another tab" after a sibling tab, otherwise a warning that
  another tab or program took over this page, with "New address" (the dialog
  `.tab-mcp-replaced`). The connect dialog closes then.
- The WebSocket URL carries the address id: `wss://<relay>/tab?a=<id>`, never the
  secret. The library computes the id from the secret with Web Crypto before it opens
  the socket, so a load balancer in front of several relay instances can route the page
  by it (see self-hosting, "Running several instances"). Where Web Crypto is missing (a
  page on plain `http:` other than localhost) the URL has no id, which a single relay
  accepts. The hashing is in the lazily loaded chunk; the core is unchanged.
- Close code 4009 (`address_mismatch`: the URL's id is not the secret's) is reported as
  `policy` and not retried.

### [0.7.0][client-0.7.0] - 2026-10-25

#### Changed

- The default dialogs have a designed look: the title, then the one next step as the
  primary button (Copy the address; Done once an app is connected; "Don't allow" in the
  confirmation), the pairing code large in its own box, the steps per AI app one below
  the other, Disconnect buttons marked, visible
  focus rings, and the arguments wrapped (also long words) and scrolling. The look comes
  from a constructed stylesheet (no CSP exception), uses
  system colours and the page's `color-scheme` (light and dark), fits 360 px, and does
  not animate when the user prefers reduced motion. A new code or "Copied" moves nothing.
- More custom properties (`--tab-mcp-muted`, `--tab-mcp-surface`, `--tab-mcp-accent`,
  `--tab-mcp-accent-text`, `--tab-mcp-danger`, `--tab-mcp-focus`, `--tab-mcp-shadow`,
  `--tab-mcp-backdrop`, `--tab-mcp-arguments-height`) and class names on the buttons
  (`.tab-mcp-primary`, `.tab-mcp-danger`, `.tab-mcp-deny`, `.tab-mcp-allow`,
  `.tab-mcp-always`, `.tab-mcp-disconnect`, `.tab-mcp-copy`), all listed in the README.
  Each rule has the specificity of one class, and the rules for hover, focus, disabled
  and the primary and danger buttons have one class and two elements. So the page's rules
  for elements, and for an element in a state (`button:hover`, `button:focus`,
  `button:disabled`), do not change those rules. A page rule with two classes
  (`.tab-mcp-dialog .tab-mcp-primary`) does.
  Until now most values were inline styles that only the custom properties could change.
- The help ("How do I add it?") shows each command as a block with its own Copy, and has
  steps for Codex: `codex features enable mcp_2026_07_28`, which Codex 0.163 needs for the
  relay's MCP revision (for all its MCP servers; `codex features disable mcp_2026_07_28`
  turns it off), then `codex mcp add <name> --url <address>`. The commands for Claude Code
  and Codex name the server by a label made from the page's `server.name` (was always
  `tools`). The label is safe in every shell without quoting: lower case, letters without
  marks, each run of other characters as `-`, no `-` at either end, at most 40 characters,
  `tools` if empty. The help shows commands only for an address made of plain URL
  characters, and plain steps otherwise.
- The connect dialog says what each Copy did in a polite live region ("Address copied",
  "Code copied", "Claude Code command copied", or "Selected: copy it with Ctrl+C or ⌘C" when
  the clipboard is not available).
- The pairing code is `2em` by default (was `1.5em`), the default border is the text
  colour at 22 % (was `GrayText`), the default radius `0.75rem` (was `0.5rem`).

### [0.6.0][client-0.6.0] - 2026-10-24

#### Fixed

- The confirmation's "Allow" and "Always allow" can be clicked only once the page has been
  visible and focused for `confirmDelayMs` with the dialog open. Until now the 750 ms ran
  from when the dialog opened, usually in a tab in the background, so the click that
  brought the tab forward could approve the call. Leaving the page disables both again;
  coming back starts the wait again (DEC-087).
- The confirmation shows characters that are invisible or change the text direction
  (U+202E, U+2066-2069, zero-width characters, tags, private-use and unassigned code
  points, C1 controls) in the arguments as `\uXXXX` escapes, so an AI app cannot make
  `"evil‮moc.elpmaxe@ecila"` read as another address. The text is still JSON for the
  same arguments, and the tool gets them unchanged. The names of the AI app and the tool
  are isolated left to right (`<bdi dir="ltr">`) (DEC-087).
- A tool result with a key `invalid` is passed through as a result; it was sent as a
  JSON-RPC error `-32602` while `toolcallend` said `ok`.
- A schema that passes `registerTool` but that the validator cannot use (a `$ref` next to a
  nested `$id`) no longer makes every call fail with `-32603` and a `toolcall` without its
  `toolcallend`. Once `connect()` has loaded the validator, it compiles each schema at
  registration: `registerTool` rejects such a schema with a `TypeError`, and a tool
  registered before `connect()` with one is unregistered and reported in the event `error`.
  Every `toolcall` now has its `toolcallend` (DEC-086).
- A consequential tool that is unregistered (or replaced under the same name) while the
  user is asked no longer runs when the user allows it: the AI app gets the error result
  "The tool is no longer available".
- `showConnectDialog()` while its dialog is open (a double click on the button) opens no
  second dialog; the call resolves when the open one closes. Two dialogs shared one
  pairing, so closing either stopped the code of both. A call for another `document` while
  the dialog is open rejects with an `InvalidStateError`.
- `confirmDelayMs: NaN` turned the delay off. The constructor now throws a `TypeError` for
  a `confirmDelayMs` or `identityTimeoutMs` that is not a number of milliseconds (finite,
  0 or more, below 2^31).
- `identityTimeoutMs` now counts from when `identityAssertion` is asked, so an assertion
  that never comes no longer leaves `identity` at `pending` for good.

#### Changed

- `grants` (and the `grants` of the event `grantschange`) is a frozen array of frozen
  grants, the same array until the grants change. Pages that changed it in place get a
  `TypeError` in strict mode.
- The core grows to 5.4 KB gzipped (DEC-086).

### [0.5.1][client-0.5.1] - 2026-10-23

#### Fixed

- When the relay refuses an attempt the library made by itself while reconnecting (from
  its timer, or the tab coming back to the front), the event `error` now says why, just
  before `reconnecting` turns `null`. Until now the page only saw `null` and could not
  tell a refusal from a stop. An attempt made by the page's own `connect()` still
  rejects its promise and emits no `error`.

### [0.5.0][client-0.5.0] - 2026-10-23

#### Changed

- The address secret's default storage key is `tab-mcp:secret:<relay origin>:<server.name>`
  instead of `tab-mcp:secret:<relay origin>`, so two pages of one site with different
  server names no longer share an address by accident (the name is URI-encoded in the
  key; renaming `server.name` changes the address). A secret under the old key is copied
  to the new one once, so an existing page keeps its address; on a site with several pages
  the first one to connect keeps it and the others get new addresses. The old key stays,
  for pages still on 0.4 and for a rollback, and a `<old key>#moved` marker records that
  it was taken. An explicit `storageKey` is used as given, without a copy. The core grows
  to 5.1 KB gzipped (DEC-083).

### [0.4.0][client-0.4.0] - 2026-10-23

#### Added

- Identity binding with relays that pair by `oidc`: the option `identityAssertion`, a
  function that returns a tab assertion from your web app's backend for the signed-in
  user and the page's address (or `null` when nobody is signed in). The library asks it
  after every connect and sends the assertion to the relay. `refreshIdentity()` asks
  again (after a sign-in without a page load), `signOut()` tells the relay the user
  signed out, which ends every AI connection of the page at once. `identity` and the
  event `identitychange` say whether the relay accepted the page's user; only the answer
  to the newest assertion counts, and `identityTimeoutMs` (15 s) ends the wait.
- `SessionInfo.pairing` (`code` or `oidc`). With `oidc` the connect dialog shows no code
  but "sign in with the account you use on this page".
- React bindings for single-page apps: `@ractive-ch/tab-mcp-client/react` with
  `TabMcpProvider`, `useTabMcp()`, `useTabMcpState()` (state, address, grants, pairing
  code, identity, reconnecting, tools; renders only on change), `useTool(tool, deps?)`
  (registers while mounted, survives StrictMode, the latest `execute` without registering
  again), `useToolCalls({ limit })` and `ConnectButton`. React 18.3 or 19 is an optional
  peer dependency; the module starts with `"use client"`; not in the CDN build.
- Reconnecting: after the connection broke (reason `network`, `heartbeat` or `shutdown`)
  the library connects again after 5, 10, 20 and 40 s, then every 60 s, and at once when
  the tab comes back to the front or the network returns. The property and event
  `reconnecting` report it; the option `reconnect` (`false`, or `{ delaysMs }`) changes
  it. A reconnect asks `identityAssertion` again like a fresh connect. An attempt the
  relay refuses (not merely unreachable) stops reconnecting.
- `identityMessage`: why the relay refused the page's identity, while `identity` is
  `refused`.
- `confirmInPage(request)`: the library's own confirmation dialog, for an `onConfirm`
  that hands some calls to it.

#### Changed

- The library now reconnects by itself by default (see above). Pages that reconnected in
  their own `disconnected` listener keep working (the library then does not schedule its
  own attempt) but can drop that code; `reconnect: false` keeps the old behaviour.

### [0.3.0][client-0.3.0] - 2026-10-23

#### Added

- A Copy button next to the pairing code in the connect dialog, like the address's Copy
  ("Copied" once copied). It copies the code shown at the time, and is back to "Copy"
  when a new code appears. The code is plain, selectable text (one click selects it).

#### Changed

- The connect dialog has no prominent button under the code until an AI app connects:
  only a small Close at the bottom (and Escape), next to a note that closing stops the
  code while the address stays the same, and that the page can show it again. Once an
  app connects in the dialog, a "Done" button replaces it. Pages and tests that click
  "Close" after pairing should click "Done".
- The connect dialog opens with the focus on the address's Copy instead of Close. The
  two Copy buttons are labelled "Copy address" and "Copy code" for assistive technology.

### [0.2.0][client-0.2.0] - 2026-10-20

#### Added

- "Always allow" in the default confirmation. That tool then runs without asking for that
  AI app until the page is reloaded or the app is disconnected. Like "Allow", it stays
  disabled for a moment after the dialog opens. A custom `onConfirm` is asked every time,
  as before.
- The events `toolcall` and `toolcallend`: every call of a known tool by an AI app as it
  starts (id, tool, arguments, AI app) and as it ends (outcome `ok`, `error`, `declined`
  or `cancelled`, the result, the duration). For an activity log in the page.

### [0.1.0][client-0.1.0] - 2026-10-20

The first stable release, on the npm dist-tag `latest`; install without `@alpha`.

#### Added

- "New address" in the connect dialog. It calls `newAddress()`, which disconnects every
  connected AI app and makes a new address. While apps are connected, the dialog first
  names them and asks.
- The connect dialog notes that a new pairing code appears every 2 minutes and after each
  use, and announces each newly connected AI app.

#### Changed

- The default dialog says "AI app" instead of "AI tool": its title is now "Connect your
  AI app". Pages that quote the old wording should follow.
- `appName` must be 1-64 characters without control characters, as the relay requires
  (before, only the length was checked).
- README: how to get a relay, pairing, consequential tools and your own UI. Cursor is no
  longer named among the AI apps, because it cannot connect yet.

### [0.1.0-alpha.1][client-0.1.0-alpha.1] - 2026-10-20

No changes to the library. Published through the release workflow (trusted publishing)
to validate it; the release step now reads `npm view` output from npm 11 and 12 alike.

### [0.1.0-alpha.0][client-0.1.0-alpha.0] - 2026-10-19

First alpha of the browser library, on the npm dist-tag `alpha`.

#### Added

- `TabMcp`: register tools WebMCP-style (`registerTool` with JSON Schema input, annotations
  and an abort signal), connect to a tab-mcp relay and answer MCP requests in the page.
- A small core; `connect()` loads the connection and the dialogs on demand.
- Default dialogs: "Connect your AI tool" with the address and connected apps, and a
  confirmation for consequential tools.
- ESM build for bundlers with type declarations, and a self-contained build for
  `<script type="module">` under `@ractive-ch/tab-mcp-client/cdn`.
- The connect dialog shows the pairing code from the relay.

## @ractive-ch/tab-mcp

The relay. Each relay release is also a Docker image, `ractive/tab-mcp` and
`ghcr.io/ractive/tab-mcp`, tagged with the version.

### Unreleased

#### Added

- An icon: `/favicon.ico` (16, 32 and 48 px), `/favicon.svg` and
  `/apple-touch-icon.png`, linked from the index and the sign-in pages. AI apps show it
  for a connector where they showed a placeholder (Claude Desktop showed "@"). It is the
  relay's, the same for every page; `scripts/favicon.ts` renders it from
  `scripts/favicon.svg`.

### [0.5.0][relay-0.5.0] - 2026-10-25

#### Added

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

#### Changed

- Authorization codes and the `state` sent to the identity provider are longer: the
  address id, a dot, and the random part as before. They stay opaque to clients.

### [0.4.0][relay-0.4.0] - 2026-10-24

#### Fixed

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

#### Changed

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

### [0.3.1][relay-0.3.1] - 2026-10-24

#### Fixed

- An `initialize` request in a 2026-07-28 envelope (the `MCP-Protocol-Version: 2026-07-28`
  header and `_meta`) now reaches the page, which answers 404 with `-32601` (method not
  found), as the Streamable HTTP transport requires for a method the server does not
  have. Until now the relay answered 400 with `-32022`. An old-style `initialize`
  (2025-11-25 and earlier) still gets 400 with `-32022` and the supported version.

### [0.3.0][relay-0.3.0] - 2026-10-23

#### Added

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

#### Changed

- A site without `pairing` now takes `TAB_MCP_IDENTITY` (default `code`, so nothing
  changes unless you set it); `resolveConfig()` no longer fills in `pairing: "code"`.

### [0.2.1][relay-0.2.1] - 2026-10-21

#### Fixed

- `/healthz` sends `cache-control: no-store` and `/` a cache time of one hour. Without
  them bunny's CDN kept both for 30 days, so after the deploy of 0.2.0 `/healthz` still
  reported 0.1.0.

### [0.2.0][relay-0.2.0] - 2026-10-21

#### Added

- `TAB_MCP_PAGE_WAIT_S` (default 10, at most 60, 0 = off): an MCP request whose page is
  not open waits that long for the page to open or reconnect, then is forwarded as usual.
  Phones pause a tab in the background, so this covers switching apps. The wait ends when
  the AI app closes the request; at most `TAB_MCP_MAX_CONCURRENT_REQUESTS` requests wait
  per address and `TAB_MCP_MAX_SESSIONS` in all. `server/discover` does not wait.

#### Changed

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

### [0.1.0][relay-0.1.0] - 2026-10-20

The first stable release, on the npm dist-tag `latest`; install without `@alpha`. The
image is `ractive/tab-mcp:0.1.0` and `ghcr.io/ractive/tab-mcp:0.1.0`, also tagged `0.1`
and `latest`.

#### Added

- The `RevokeOptions` type is exported, for custom token stores.
- Package README with the quick start, the `tab-mcp` command and the library API.
- Documentation: configuration, self-hosting, token store, protocol, threat model and
  security policy, and the tab-mcp agent skill.

#### Changed

- The relay's pages say "AI app" instead of "AI tool" and name the page's "Connect your
  AI app" dialog.

### [0.1.0-alpha.1][relay-0.1.0-alpha.1] - 2026-10-20

No changes to the relay. The first version published through the release workflow
(trusted publishing) to validate it, and the first Docker image:
`ractive/tab-mcp:0.1.0-alpha.1` and `ghcr.io/ractive/tab-mcp:0.1.0-alpha.1` for
linux/amd64 and linux/arm64, with provenance and SBOM attestations.

### [0.1.0-alpha.0][relay-0.1.0-alpha.0] - 2026-10-20

First alpha of the relay, on the npm dist-tag `alpha`, uploaded by hand from the
CI-signed tarball (no GitHub release, no Docker image). It runs on Bun 1.4.3 or newer.

#### Added

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

[client-0.8.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.8.0
[client-0.7.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.7.0
[client-0.6.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.6.0
[client-0.5.1]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.5.1
[client-0.5.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.5.0
[client-0.4.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.4.0
[client-0.3.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.3.0
[client-0.2.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.2.0
[client-0.1.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.1.0
[client-0.1.0-alpha.1]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.1.0-alpha.1
[client-0.1.0-alpha.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.1.0-alpha.0
[relay-0.5.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.5.0
[relay-0.4.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.4.0
[relay-0.3.1]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.3.1
[relay-0.3.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.3.0
[relay-0.2.1]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.2.1
[relay-0.2.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.2.0
[relay-0.1.0]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.1.0
[relay-0.1.0-alpha.1]: https://github.com/ractive/tab-mcp/releases/tag/relay-v0.1.0-alpha.1
[relay-0.1.0-alpha.0]: https://www.npmjs.com/package/@ractive-ch/tab-mcp/v/0.1.0-alpha.0
