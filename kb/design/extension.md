---
type: design
title: "The tab-mcp browser extension"
description: >-
  A small Chrome extension in this repository that bridges a page's own WebMCP tools
  to AI apps outside the browser, through the relay. Recipes (tools an AI app builds
  for a site) are dropped (DEC-114); user scripts are an experiment of their own.
tags:
  - design
  - extension
  - webmcp
timestamp: 2026-11-21T09:00:00+01:00
---

# The tab-mcp browser extension

## What it is

A page that registers tools with WebMCP (`document.modelContext.registerTool()`, in a
Chrome origin trial since Chrome 149) offers them only to agents in the browser. The
extension offers them to AI apps outside the browser, through the relay. Its content
script reaches them on the native `document.modelContext`, in the top frame (iteration 18,
DEC-113). That is all it does: a small bridge (DEC-114).

- It works only on sites that turn WebMCP on themselves (origin trial token) or for users
  who turned on the flag; the extension cannot turn it on for a page. Many do, mostly
  through platforms: about 1% of Chrome page loads register tools, and a crawl of the
  Tranco top 300k and public lists found about 13,000 sites with tools (1.7% of the top
  100k; Shopify storefronts above all), while agents that call them are still rare
  ([adoption](/research/webmcp-adoption.md)). The bridge brings those tools to AI apps
  outside the browser.
- Tools an AI app builds for a site (recipes) were planned and dropped: guides for
  agents in the browser (Claude in Chrome with site guides such as SiteSkills) give most
  of their benefit without an extension (DEC-114).
- Letting an AI app write user scripts that the extension runs (`chrome.userScripts`) is
  an experiment of its own, iteration 24, not part of the extension until it is decided.

Name: **tab-mcp browser extension**; docs at `ractive.ch/tab-mcp`, no domain of its own (DEC-109).

## How it fits tab-mcp

```text
AI app ──MCP──▶ relay ◀──WebSocket── service worker (tab-mcp-client, the bridge)
                                        │  chrome.tabs.sendMessage     ▲ port: state ▼ commands
                                        ▼                              side panel (a view)
                           content script in the tab
                           └─ bridges WebMCP tools (getTools / executeTool, DEC-113)
```

- The connection lives in the service worker (DEC-116, iteration 26): it connects to the
  relay with origin `chrome-extension://<id>`, which the relay accepts since 0.7.0
  (DEC-108). A content script cannot connect itself: its requests carry the website's
  origin. A WebSocket that carries messages keeps the worker running (Chrome 116), and
  the relay's heartbeat carries some every 25 s, so the connection stays while the side
  panel is closed; an alarm wakes the worker once a minute while AI access is on, and
  every worker start connects again when the user left it on. The address secret and the
  settings are in IndexedDB in the extension's origin, used by the worker only, out of
  content scripts' reach (threat model A13).
- The tools the AI app sees are registered with `tab-mcp-client`'s `registerTool`; their
  `execute` sends a message to the content script of the tab in front (the active tab of
  the last focused normal window) and returns its answer. Overmark does the same in its
  side panel.
- Pairing, grants and the relay are tab-mcp's as they are; the side panel shows them
  with its own pairing view (the address, the code, the connected apps, "Disconnect all
  apps"), since the library's dialog would draw into no page. The extension sets its app
  id itself (`APP_ID` in `src/protocol.ts`: `tab-mcp-extension`, and
  `tab-mcp-extension-firefox` in the Firefox build, as its server name there is longer
  than an app id may be), so its address `<relay>/s/tab-mcp-extension/mcp` is the same
  for everyone who has it, and the code pairs an AI app with one installation (DEC-196).
  A relay can reserve the first id for the extension's origins; the Firefox id stays
  unreserved, as no list can name a Firefox extension (DEC-197). Commands reach the worker only
  over the panel's port (threat model A13).
- A page with the client library registers its tools with WebMCP too (client 0.13.0 with
  `webmcp: true`, DEC-115, DEC-119; by default since DEC-222, unless `webmcp: false`). The extension offers them like any other page
  tool (DEC-140): it cannot know whether the AI app is paired with the page itself. An AI
  app connected to both gets such a tool twice. (Until iteration 35 it left out the names
  listed in `<html data-tab-mcp-webmcp>`, which hid them from an AI app connected only
  to the extension.) Such a page and the extension know of each other since DEC-207:
  see below.
- Tools that ask first ask in the side panel when it is open in the focused window of the
  tab the call acts on, else in a Chrome notification; the extension asks, not the
  library (iteration 26). A click on a notification's body opens the whole question in
  the side panel of the tab's window (`sidePanel.open` at once in `onClicked`, which
  Chrome dispatches with a user gesture); where Chrome refuses the panel, a new
  notification asks again (iteration 43, DEC-181; the popup window of the extension's
  that showed the question in that case is gone).
  The bridge asks itself for both ways of calling a page tool (`page_<name>` is not
  `consequentialHint`, DEC-141), so the AI app hears why a call did not run. What the AI
  app is told about a tool does not depend on that: `page_<name>` carries MCP's
  `destructiveHint` as the page's `consequentialHint` says (true only when a page that
  registers with WebMCP itself gave no annotations at all; a page with the client library
  always gives them, a tool without hints as not consequential), and the bridge asks before every call of a tool that is not
  read-only either way (DEC-214). "Don't ask
  again on <host>" in a question writes the site's "allowed" entry, as the panel's "Always allow"
  switch does; the ephemeral Always allow per AI app and page is gone (DEC-139), and the
  notification has "Allow once" only. An answer is for the tool as it was offered
  (`keyOf`: its tab, document and everything the content script sent for it, title,
  description, schemas and hints included, as `canonicalJson`); a tool offered
  differently by the time the user answers does not run (DEC-217). The bridge checks
  that against its last read, and the content script against the page's tools read
  right before the call: each call carries the definition it was offered with
  (`CallTarget.definition`). The site's "allowed" entry is not tied to a definition: it
  is the user's standing word for the site's tool by name, while a question shows one
  definition and its answer is for that one (DEC-217).
- The origin a page's tools carry (the description's prefix, the "allowed" key, the
  question's "Site (verified)") is checked against the origin of the address Chrome
  reports for the tab; a page that says otherwise gets no tools (iteration 35).

## Pages with the client library (DEC-207)

A page that uses the client library with the WebMCP mirror on (unless `webmcp: false`,
DEC-222) and the extension shake hands,
so that a call the user allowed in the extension is not asked again by the page, and the
page can say that an AI app is connected through the extension
([iteration 48](/iterations/iteration-48-page-extension-handshake.md)).

- **The channel.** `CustomEvent`s on `document` with a JSON string as `detail`:
  `tab-mcp-page` from the page, `tab-mcp-extension` from the content script (top frame
  only). `v: 1`, a `type`; anything else is ignored. The page's side is
  `packages/tab-mcp-client/src/handshake.ts` (in the mirror's chunk), the extension's
  `src/page-handshake.ts` in the content script.
- **Either may start first.** The page says `hello` when its mirror starts and marks
  `<html data-tab-mcp-handshake>`; the content script (at `document_idle` in Chrome,
  after a click, at `document_start` in Firefox) listens from its start, and speaks
  first (`hello`) when the mark is there or the page spoke before it was told "on",
  once AI access is on. Each answers the other's `hello` with an `update` (the page's
  carries what its `hello` did: the library's version, the app id and its AI apps, for
  each of its apps); changes go as `update`.
- **The extension speaks only to pages that announced the library, and only while AI
  access is on and connected** (DEC-221): its name, `on: true`, the AI apps connected
  now (`name`, verified `host`) and `whileInFront: true`; not its version. While AI
  access is off (or connecting), the extension answers no page and sends it nothing,
  not even a vouch. Until a document was told "on", the content script does not read its
  events: it notes that the page spoke, without touching `detail` (in Chrome, reading an
  object `detail` from another world runs the page's getters), and greets the page with
  `hello` once on; told "on", it reads `detail` and takes only a string. A page can still
  see that the extension is installed where it gives the page WebMCP as the page loads
  (in browsers without their own, with access to all sites), and could try to time its
  own events, which the extension still listens to. A document the content script told "on" hears
  `{ v: 1, type: "update", on: false }` once when it goes off; the "told on" memory is
  the content script's, per document. Back from the back/forward cache it asks the
  worker again; once the extension was disabled, removed or updated
  (`chrome.runtime.id` gone) it says "off" at the page's next event or `pageshow` and
  then nothing. The worker sends the state to every content script of a site it may
  read whenever it changes (`extension-state`), and again when host access changes;
  each passes it on, field by field, only to a page that announced. A tab it can no
  longer read (no address) hears only "off". A call with a vouch carries the state, so
  that a page not told "on" yet (the call came first, or the worker did not answer) is
  told before the vouch.
  A content script asks the worker for it
  with `handshake`, accepted only from a tab's top frame, at the page's first `hello`
  only: later ones are answered from the last state the worker sent. A worker that does
  not answer is asked again after 1 s and 5 s (`RETRY_MS`), one ask at a time; a change
  from the worker or `pagehide` ends that. Each side cuts the other's list of AI apps
  to 64 and sends at most 64; the panel shows the library version of the app id
  announced first.
- **The vouch.** `PageToolBridge` makes one in `#allowedThenRun` only, after the
  user's answer (or the site's "allowed") and the same-tool check, for a tool that is not
  read-only and an AI app through the relay; it goes with the `webmcp-call` message,
  and the content script dispatches it (`tool`, `arguments`, `nonce`, `app`)
  synchronously right before `executeTool`, after its own checks, and `withdraw`
  (`nonce`) once `executeTool` settled, whatever the outcome, so that a call that failed
  or was cancelled before it reached the page leaves no vouch. The library keeps it
  2 s, for the tool registered under that name then, and uses it once for the next
  WebMCP call of that tool with equal arguments (canonical JSON, keys sorted): no
  `onConfirm`, the caller `{ kind: "webmcp", via: "tab-mcp-extension", name, host }`.
  `trustExtension: false` in the page hands it to `onConfirm` anyway. A WebMCP call
  without a vouch (an agent in the browser, another extension, an `exposedTo`
  origin; the page cannot tell which) gets no question from the library, only the
  page's `onConfirm` decides (DEC-215).
- **The panel.** For the tab in front, when the page announced the library: "This page
  has tab-mcp built in." (also while AI access is off: the page spoke, nothing it said
  was read), and when an AI app connected to the extension is also connected to the
  page directly (known only once AI access is on and the page answered the extension's
  `hello`) (same name and host, as the page announced its grants), that it
  sees the page's tools twice and to disconnect it in one of the two.
- **No proof** of either side: a convenience between two parts the user trusts, not a
  security boundary (threat model A13, A14). Old and new mix: a page without the
  handshake hears nothing, an old extension says nothing, and its calls are unvouched
  WebMCP calls, which the library does not ask. Client 0.21.0 and older takes "on" and
  `hello` only with a version, so with an extension after DEC-221 such a page shows no
  extension and does not answer the extension's `hello`: the panel says "This page has
  tab-mcp built in." but has no "sees the page's tools twice" line until the page's own
  AI apps change; its vouches still work. A newer client ignores an older extension's
  version and treats its "off" as no extension (DEC-221).

## Filling in the code on the relay's page

When an AI app opens the relay's pairing page (`/authorize`) in the browser that has the
extension, the extension can fill in its own code there, after asking (DEC-199's hooks,
built in DEC-203). Typing the code stays the way that always works.

- **A switch, off by default** (DEC-210). "Fill in the code for me" under the code in
  the pairing view, with one line under it on what it does, turns it on for the relay
  in use, also with access to all sites; off, it gives the relay's site back. Another
  relay starts off, and the old relay's site is given back (never access to all sites).
  The switch shows what is in effect: on only with the setting on and the relay's site
  granted. Declined in the browser's prompt, it goes back to off. When the site is taken
  away in the browser's settings, the worker turns the setting off and remembers it
  (`fillCodeLost`), so filling in never comes back by itself (with access to all sites,
  say); the line says "tab-mcp no longer has access to <host>, so this went off." until
  the user turns the switch on or off or picks another relay. "On" without the site
  when the worker handles it (given back for an "off" just before) stays off, without
  the note (`FillSetting` in `src/worker/fill.ts`). Each "set-fill" carries an id that
  comes back in the state (`fillAnswered`): until then the switch shows the click, its
  line has no "no longer has access", and an Allow that comes after the user turned it
  off again sends another "off" instead of "on". A relay address without a pattern
  shows the sentence alone, and the switch only while the setting is on there.
- **Access.** The page is opened by the AI app, so no click grants `activeTab` for it.
  Turning it on asks for the relay's site when the extension does not have it, one
  origin of the optional host permissions (`<scheme>://<host>/*`). Then a content script
  (`src/pairing-page.ts`, the library's `runPairingPage`) is registered for `<scheme>://<host>/authorize*` only, again
  whenever the relay, the setting or the permissions change. Off, nothing changes.
- **What it reads.** Only the form's hooks: `data-tab-mcp-pairing="1"`, `data-app`
  (its own `APP_ID` or nothing happens), `data-client-name`, `data-client-host`, the
  hidden `request_id`, and that there is a code field and a Connect button. It sends
  these with a nonce of the page load over a port; it never sees a code before the
  user's Allow.
- **The origin is the check.** The worker (the library's `CodeFiller`) takes the port only
  from this extension's content script in a tab's top frame at exactly the configured
  relay's origin, port included, and path `/authorize`: any site can copy the markup.
- **The question.** Only while AI access is on; turning it off withdraws a question. "Connect <name> (<host>) to the tab-mcp
  browser extension?", with the verified host on a line of its own and the AI app's own
  name for itself labelled as its own: any site can be a client called "Claude". One
  click is less than opening the panel and typing a code, so the host is what the user
  decides on. Allow or Don't allow, in the panel or a notification like a tool's
  question, 60 s. For a host that is a public DNS name (`alwaysAllowable`: not an IP
  address, `localhost`, a single label, all of `.arpa`, or a special-use, test or
  private name such as `.local`, `.test`, `.corp` or `.lan`) the answers are
  "Don't allow", "Allow once" and "Always allow" (DEC-213), with one sentence on what
  "Always allow" does and where to undo it; the notification offers "Allow once" only,
  as a tool's does.
- **Always allow (DEC-213).** Remembers the AI app's verified host for the relay in
  use (`fillCodeAlways`, with the setting in IndexedDB). The next sign-in page of that
  host is filled in without a question: the extension's `ask` answers `allow` at once,
  so every other check of `CodeFiller` stays. Each such fill shows a notification ("Code
  filled in", "Filled in the code for <name> (<host>).") and the same line in the panel
  (the last such fill, for 10 minutes in any case; the extension cannot tell whether the
  system showed the notification). The notice comes when the code is there, before the
  library's last checks, so it can name a fill those checks then stopped: it errs on the
  side of saying too much. At most 3 per host in 10 minutes (kept in storage; a clock
  moved back does not reset it); beyond that the question comes back. Under the switch,
  "Filled in without asking for:" lists the hosts, each with Remove, which also
  withdraws a fill of that host still waiting for its code. Forgotten when the switch
  goes off, when the relay's site was taken away, and when the relay changes, in the
  same write as the setting; a stored list that is not the setting's is deleted at load.
  An "Always allow" answer to a question that did not offer it is Don't allow. It rests
  on the AI app's own check that a sign-in belongs to the browser's account (Claude makes
  it; the threat model's residual risk).
- **On Allow** the worker holds pairing on (30 s), takes the current code (or the next
  one if it is about to change, and the current one if no next comes in 10 s; the same
  code sent again, the relay's answer to starting pairing while it is on, is not the
  next one) and sends it on that page's port; the content script writes it into the
  field and submits the form with Connect. The relay checks it as any code. The port is
  closed 5 s later. A fill that sends no code (withdrawn, the page gone, no code) ends
  the hold at once, unless another fill still needs it.
- **No loops.** One question per page load. The page of the same request
  (`request_id`) in the same tab within 30 s of a fill is the relay's answer that the
  code was not taken: filled once more without asking, then nothing until the window
  has passed. Any other request asks. Don't allow, a timeout, the page going, AI access
  going off or the AI app connecting by a typed code fill nothing.
- **Where the logic lives** (DEC-206). The rules above that are the same for any
  extension that is a tab-mcp page (the content script's reading and filling in, the
  sender check, the state machine of asking and filling in, which code, the relay's
  patterns, the messages) are the client library's entry
  `@ractive-ch/tab-mcp-client/extension` (`src/extension.ts` there, tested in
  `test/extension.test.ts`), which Sitegloss uses too. The extension keeps its own
  parts: the question (`src/worker/questions.ts`), the setting, the permission prompt
  and the panel's line (`src/sidepanel/fill.ts`), the script's registration and the
  panel's texts (`src/worker/fill.ts`), holding pairing on and the host the library
  calls (`src/worker/connection.ts`). `src/pairing-page.ts` is one call of the
  library's `runPairingPage`.

A click on the icon opens the side panel with `sidePanel.open({ tabId, windowId })`.
With the window only, Chrome resolved the call and showed nothing when another
extension had a panel of its own open for the tab (Claude in Chrome's);
`openPanelOnActionClick` shows the panel over it too, but then the click grants no
`activeTab` (both seen in Chrome for Testing 156, 2026-11-09, and in an end-to-end test
with a second extension).

## Permissions

- `activeTab`, `scripting`, `sidePanel`, `notifications` (questions while the panel is
  not in front), `alarms` (waking the worker while AI access is on). No `storage`: the
  settings are in IndexedDB, and without the permission content scripts have no
  `chrome.storage` area at all (ext/review-fixes).
- Host access is optional (`http://*/*` and `https://*/*` in
  `optional_host_permissions`, not `<all_urls>`: no `file:` pages, iteration 35): without
  it the extension runs on a tab only after a click on its icon, as Overmark does, and
  only for that origin in that tab (Chrome keeps the grant across navigations on the same
  origin, not to another subdomain; Firefox ends it at every navigation, a reload too,
  iteration 51's spike). While AI access is on, a page it reads that has no WebMCP gets
  the extension's own then, late (DEC-223, `worker/late-webmcp.ts`): in Chrome the
  worker puts the page-world polyfill in with `scripting.executeScript` (`world: "MAIN"`)
  and the content script connects to it again, in Firefox the content script installs
  it; the page hears `tab-mcp-webmcp`, and a client library that found none as it loaded
  looks again. Once per document, only for a page that can take it (https or the loopback
  host), pinned to the document that was read (Chrome: the content script's world names
  its page's id, an injection's result Chrome's document id, which `executeScript`'s
  `documentIds` and `tabs.sendMessage`'s `documentId` then take; the message carries
  the content script's id, and another page's content script ignores it). The panel
  says nothing about missing WebMCP until it settled, and "tab-mcp gave this page WebMCP
  after it had loaded…" for a page that then registered nothing. A content script put
  in without host access for the page (`injectInto` asks `permissions.contains` for the
  page's site; a click's grant is no permission) is told so first in its own world
  (`tabMcpByClick`) and then sends nothing into the page and installs nothing until
  `webmcp-install` (review of PR 234); without that flag (the registered script, the
  revive after an update, a page put in with host access) it does what it did before
  DEC-223, whatever AI access. "Give access to all sites" asks for host access; the content script
  is then registered for every http(s) page. The "Fill in the code for me" switch asks
  for the relay's site alone, for its pairing page (DEC-203). `"incognito": "not_allowed"`: no Incognito
  tabs (DEC-142).
- No remote code.

## Tools the AI app gets

| Tool | Kind | What it does |
|---|---|---|
| `page_info` | read | Address, title, language, whether WebMCP is available on the page and how many tools it registered (iteration 19) |
| `webmcp_tools` | read | The page's own WebMCP tools: each one's `page_<name>`, input schema (iteration 35), whether it only reads, whether it is destructive (DEC-214), and why a tool is left out (iteration 20) |
| `page_<name>` | as the page marks it | Each page tool, called with `executeTool()`; not read-only means the user confirms each call (iteration 20). `readOnlyHint` as the page's; `destructiveHint` false for a read-only tool, else the page's `consequentialHint`, true when a page registering with WebMCP itself gave no annotations (a page with the client library always gives them; a tool without hints is not consequential there) (DEC-214). A tool that navigates the tab answers with the new page's `page_info`, not an error (iteration 35) |
| `webmcp_call` | as the called tool | Calls a tool of the page in front by its WebMCP name, with the same rules (schema check, confirmation, the page it was listed from); for AI apps that read their tool list once (Claude, Codex), which never see the `page_<name>` tools of a later tab (iteration 20 review, `src/worker/tools.ts`) |
| `navigate` | navigates; another origin asks | Opens an http(s) address in the tab in front, if the extension may read it; waits for the load (30 s) and answers with the new page's `page_info`, or `readable: false` and why (iteration 27, DEC-121, `src/worker/navigation.ts`) |
| `go_back`, `go_forward` | navigates; another or unknown origin asks | One step in the tab's history; a target on the page's origin is known from the Navigation API (same-origin entries only), any other one asks |
| `reload` | navigates, never asks | Reloads the page in front, with its `page_info` |

The side panel shows the connection and its apps, the pairing view, questions, the tab in
front with its tools ("reads", "asks first", or an "Always allow" switch where a tool can be
allowed on the site), and the relay address under
Settings. The icon's badge shows "on", "…" or "?" (a question waits). The connector
carries the extension's icon. The panel's look (paper and ink on tokens whose pairs are
held to their contrast in light and dark, no amber button, what each colour says) is
[tab-mcp browser extension: the look](extension-look.md) (iteration 39, DEC-160 to DEC-163).

## Risks and how the design meets them

- **The page's hints can lie.** Every result is marked untrusted; every tool not marked
  read-only asks the user each time (side panel or notification), naming the page's
  origin.
- **Prompt injection.** Page tool results reach the AI app; they are marked untrusted,
  and the AI app decides what to do with them, as with any tool. The tools' names,
  descriptions and schemas are the page's words too, and no hint can mark them in a tool
  list: descriptions are cut to a limit and start with the page's origin (iteration 20).
- **A forged `document.modelContext`.** The content script sees the native object only;
  a page that replaces it in its own world fools only itself (iteration 18).

## Releases

Own version and tags (`extension-v0.1.0`), published to the Chrome Web Store from a
release, like Overmark (DEC-109). Relay and client releases stay as they are. The
release's store zip carries a build provenance attestation, and the publish workflow
uploads only a zip that verifies (DEC-182).

# Citations

- [WebMCP draft, W3C Web Machine Learning Community Group (2 November 2026)](https://webmachinelearning.github.io/webmcp/)
- [WebMCP explainer and repository](https://github.com/webmachinelearning/webmcp)
- [Chrome: WebMCP developer docs](https://developer.chrome.com/docs/ai/webmcp)
- [Chrome: WebMCP origin trial (9 June 2026)](https://developer.chrome.com/blog/ai-webmcp-origin-trial)
- [SiteSkills: navigation guides for AI browser agents](https://siteskills.ai/)
- [Chrome extensions: userScripts API](https://developer.chrome.com/docs/extensions/reference/api/userScripts)
