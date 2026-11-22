---
name: tab-mcp
description: Add tab-mcp to a web app so that AI apps (Claude, ChatGPT, Claude Code, Codex) can call the page's functions as MCP tools while it is open in a browser tab. Covers installing @ractive-ch/tab-mcp-client, registering tools WebMCP-style, the React bindings, the connect and pairing flow (by code or by sign-in), confirmation for consequential tools, registering the same tools with the browser's WebMCP (`webmcp: true`), serving them to the site's own assistant without a relay (`serve`), security defaults and running a tab-mcp relay. Use when the user wants to expose a web page's features to AI apps over MCP, mentions tab-mcp, WebMCP or registerTool, "Connect your AI app", or needs to self-host the tab-mcp relay.
license: MIT
compatibility: Browser library for any web page (ES modules); the relay needs Bun 1.4.4+ or Docker.
---

# Add tab-mcp to a web app

This skill describes `@ractive-ch/tab-mcp-client` 0.21.0. The package's
[README](https://github.com/ractive/tab-mcp/blob/client-v0.21.0/packages/tab-mcp-client/README.md)
is the full reference; read the section you need there when this skill is not enough. Its
[CHANGELOG](https://github.com/ractive/tab-mcp/blob/client-v0.21.0/packages/tab-mcp-client/CHANGELOG.md)
says what changed between versions. The package ships this skill for its own version as
`node_modules/@ractive-ch/tab-mcp-client/skill/SKILL.md`: when the project has another
version installed, follow that copy; an installed version without it is older than this
skill, so update the package first.

tab-mcp lets AI apps call tools that a web page offers while it is open in a browser tab.
The page uses the browser library `@ractive-ch/tab-mcp-client`, which connects to a
tab-mcp relay (`@ractive-ch/tab-mcp`) over a WebSocket and shows its app's MCP address,
the same for every page of the app. The user adds that address to their AI app and pairs
it with a code shown in the page, which says which page is meant. The relay
forwards the AI app's requests to the page; the tools run in the page.

Facts to keep in mind:

- Only MCP revision 2026-07-28, and only AI apps that register through OAuth Client ID
  Metadata Documents. Claude Code, claude.ai, Claude Desktop, ChatGPT and Codex work
  (Codex and ChatGPT for Mac with Codex's feature `mcp_2026_07_28` on); VS Code, Cursor
  and Gemini CLI cannot connect. claude.ai, Claude Desktop and ChatGPT on the web connect
  from their own servers and need a relay with a public HTTPS address.
- The page needs a relay that allows its origin; run one (section 7).
- [WebMCP](https://webmachinelearning.github.io/webmcp/) (`document.modelContext`) is the
  browser's own API for tools that agents in the browser call. tab-mcp is for AI apps
  outside the browser. With `webmcp: true` the library offers the page's tools both ways
  (section 5). A page that only registers WebMCP tools natively needs no library: the tab-mcp browser extension passes them on to an AI app through a relay.
- tab-mcp fits state that lives only in the browser, and acting as the signed-in user in
  their open tab. If the state lives on the site's server, suggest an MCP server on that
  backend instead: it works without an open tab and without a relay.

## 1. Install the client

```sh
npm install @ractive-ch/tab-mcp-client
```

Without a bundler, import the self-contained build from a CDN:

```html
<script type="module">
  import { TabMcp } from "https://cdn.jsdelivr.net/npm/@ractive-ch/tab-mcp-client@0.21.0/cdn/tab-mcp-client.min.js";
</script>
```

## 2. Create the client and register tools

```ts
import { TabMcp } from "@ractive-ch/tab-mcp-client";

const mcp = new TabMcp({
  relay: "https://relay.example.com",      // your relay (section 7); http: only on localhost
  server: { name: "notes", version: "1.0.0", instructions: "Notes shown on the page." },
  appName: "notes",                        // 1-64 characters, a name for people
});

const tools = new AbortController();
await mcp.registerTool<{ text: string }>( // types `input`; the schema is what is checked
  {
    name: "add_note",                      // 1-128 of A-Z a-z 0-9 _ - .
    title: "Add a note",
    description: "Add a note (at most 500 characters) to the list on the page and return its id.",
    inputSchema: {
      type: "object",                      // required: the schema must be an object
      properties: { text: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["text"],
      additionalProperties: false,
    },
    execute: ({ text }) => addNote(text),  // second argument: { signal, client }
  },
  { signal: tools.signal },                // abort to remove the tool
);
```

In development, `relay` is the local relay of section 7 (`http://localhost:8080`), and
the page's exact origin (scheme and port: `http://localhost:5173` for Vite) must be in the
relay's `TAB_MCP_ALLOWED_ORIGINS`. Take the relay address from the app's configuration
(an environment variable of the build), not a constant.

Rules for tools:

- The shape follows the WebMCP draft (`document.modelContext.registerTool`); the second
  argument is `{ signal, callers, exposedTo }`. There is no `unregisterTool`: abort the
  registration signal. AI apps that listen get a tool-list-changed notification.
- `callers` (default: all) lists who sees a tool: `"relay"` (AI apps), `"local"` (the
  site's own assistant on a served port), `"webmcp"` (whatever calls through the
  browser's WebMCP). Tools that ask go to every caller, but who asks differs (section
  5): an AI app through the relay gets the page's question (`onConfirm`, else the
  library's dialog); a WebMCP call the tab-mcp browser extension vouched for was asked in
  the extension and skips the page's question and `onConfirm` (`trustExtension`, on by
  default; `false` hands it to `onConfirm` like any other WebMCP call); any other WebMCP
  call gets no question from the library, only the page's `onConfirm` decides, and
  without one it runs. Leave a caller out for privacy
  (`["local"]`: data the site's own assistant may read, not an AI app through the relay),
  identity (`["relay"]`: the tool needs to know which AI app calls), or for a tool no
  unvouched WebMCP caller may run (`["relay", "local"]`). For the others the tool does
  not exist (not listed, no list-changed, a call answered as for an unknown tool).
- `registerTool` returns a promise. It rejects with a `TypeError` for an invalid tool and
  an `InvalidStateError` for a duplicate name. Do not use `x-mcp-header` in schemas.
- Arguments are validated against `inputSchema` before `execute` runs, so `execute`
  needs no casts such as `String(text)`; give the type as `registerTool<{ text: string }>`
  and keep it in step with the schema. Still treat the values as untrusted input (limits
  such as `maxLength` in the schema, no HTML from them).
- Write `description` for a model: what the tool does, its units, an example.
- `execute` results: a string becomes one text block; an MCP result (`content` an array
  of MCP content blocks: `text`, `image`, `audio`, `resource_link`, `resource`) is passed
  through (use it for images); any other JSON value, also an object whose `content` holds
  something else, is sent as JSON text and, for objects, as `structuredContent`.
  Annotation hints must be `true` or `false`; anything else is a `TypeError`. A thrown error becomes an error
  result with its message, so throw errors that tell the model what to do.
- `signal` aborts when the caller gives up; the call ends then even if `execute` keeps
  going, and its late result is dropped. `client` names the caller:
  `{ kind: "relay", grantId, id, host, name? }` for an AI app (verified `host`, declared
  `name`), `{ kind: "local", id, name? }` for the site's own assistant on a served port
  (what the page passed to `serve`, section 3), or `{ kind: "webmcp", via?, name?,
  host? }` for a WebMCP caller: `via: "tab-mcp-extension"` with the AI app's
  `name` and verified `host` when the tab-mcp browser extension ran the call for an AI
  app connected to it (section 5), else nothing more is known (an agent in the browser,
  another extension, an `exposedTo` origin: the page cannot tell which). Check `client.kind`
  before reading `host`; a label for a log, e.g. `kind === "relay" ? name ?? host :
  kind === "local" ? name ?? id : via ? (name ?? host) + " through the tab-mcp browser
  extension" : "an agent in this browser"`.
- Annotations: `readOnlyHint` for tools that only read; `consequentialHint` for tools
  whose effect cannot be undone in the page or reaches outside it (section 4);
  `untrustedContentHint` for results that contain text from the user, another AI app or
  third parties (a list of notes, todos, labels); every result of such a tool carries
  `_meta["ch.ractive.tab-mcp/annotations"].untrustedContentHint: true`, which a consumer
  should read (MCP has no such hint; `tools/list` shows `openWorldHint`). MCP hints
  (`destructiveHint`, `idempotentHint`, `openWorldHint`) may be set directly.

## 3. Connect and pair

Add a button and open the library's dialog from its click handler:

```ts
connectButton.addEventListener("click", () => mcp.showConnectDialog());
```

What happens:

1. `showConnectDialog()` calls `connect()`, which opens the WebSocket. Browsers that
   report user activation refuse `connect()` outside a user action, so never call it on
   page load.
2. The "Connect your AI app" dialog shows the address
   (`https://<relay>/s/<app>/mcp`, the same for every page of the app; `<app>` is the `app` option, else made from
   `server.name`), a Copy button, steps for Claude, ChatGPT, Claude
   Code and Codex (the two commands with a Copy each, named by a shell-safe label made from `server.name`; Codex's first
   turns on its feature `mcp_2026_07_28`), a code of 8 letters (`XXXX-XXXX`) and "Disconnect all apps". The code says
   which page the AI app is paired with; it is valid for 2 minutes and is replaced by itself.
3. The user adds the address to the AI app, for example
   `claude mcp add --transport http notes <address>` and then `/mcp` → Authenticate in
   Claude Code.
4. The AI app opens the relay's `/authorize` page in the browser. The page names the AI
   app and the page origin. The user types the code there. Codes work once and allow 5
   attempts.
5. The dialog lists the connected app with a Disconnect button. The AI app can now call
   the tools while the page is connected.

The relay knows the page again across visits (by a secret per relay and server name in `localStorage`), and paired
apps stay paired across reloads. While the page is closed, their calls wait up to 10 s
for it (the relay's `TAB_MCP_PAGE_WAIT_S`) and then get a tool result saying the page is
not open. Renaming `server.name` changes the secret's storage key and, without the `app` option, the address, so the
apps pair again.

When the connection breaks (reason `network`, `heartbeat` or `shutdown`: a dropped
network, a phone pausing the tab in the background, a relay restart), the library
connects again by itself: after 5, 10, 20 and 40 s, then every 60 s, and at once when the
tab comes back to the front or the network returns. Do not write your own retry loop;
show `state === "reconnecting"` and the property `reconnecting` (the next attempt, its
number and time); `statechange` fires for each attempt, and when the relay refused one,
`error` says why just before the `statechange` to `disconnected`. It never reconnects after `disconnect()`, `disconnectAll()`, another
tab taking the page's place (`replaced`), an expired or idle session or a refusal by the
relay, and a first `connect()` that fails is not retried (show the error and let the
user try again). `reconnect: false` turns it off.

The library does not connect on page load by itself: if the page offers a "Keep AI
access on" switch that the user turned on, call `connect({ resume: true })` on load.

"Disconnect all apps" in the dialog calls `mcp.disconnectAll()`: it disconnects every app
and makes a new address secret, and the dialog asks first when apps are connected. The
address stays the same; each AI app connects again with a new code. A custom UI calls
`mcp.disconnectAll()` from a click.

For a custom UI, use `connect()`, `startPairing()`/`stopPairing()` (codes come only while
pairing is on), `revoke(grantId)` (resolves once the relay removed the grant),
`disconnect()`, the properties `state` (`disconnected`, `connecting`, `connected`,
`reconnecting`), `session` (its `address` is the MCP address), `pairingCode`,
`pairingUntil` (identity binding) and `grants`, and the events `statechange` (`{ state,
reason? }`, `reason` when a session ended), `pairingcode` (`{ pairingCode }`),
`pairinguntil` (`{ pairingUntil }`), `grantschange` (`{ grants }`), `replaced` and
`error`. Every detail is an object; a value that is gone is `undefined`. Methods that ask
the relay reject with an `InvalidStateError` while not connected. The dialogs' texts can
be replaced (`ui: { strings }`, the keys of
[`STRINGS`](https://github.com/ractive/tab-mcp/blob/client-v0.21.0/packages/tab-mcp-client/src/strings.ts),
with `lang` and `dir`; see
[Translating](https://github.com/ractive/tab-mcp/blob/client-v0.21.0/packages/tab-mcp-client/README.md#translating)),
and their help gets its own guide link and steps (`ui: { setup: { guide,
instructions } }`).

When another tab or program takes the page's place (it connects with the same address
secret), the page gets a `statechange` to
`disconnected` (reason `replaced`) and then, up to a second later, `replaced`. Once the page has opened the
default dialog, the library says so itself: "Opened in another tab" when a tab of the
same page said on its `BroadcastChannel` that its session started, otherwise a warning
with "Disconnect all apps". A custom UI does the same with `event.detail.sibling`: `true` is the
usual, harmless second tab; `false` means it may be a program with a copy of the address
secret, which the paired AI apps now use, so offer a "Disconnect all apps" button that calls
`mcp.disconnectAll()`. It takes the page back with the relay revoking those apps in the
same step, then connects with a new secret; if it rejects with `reason: "replaced"`, the
page was taken over again first: say so and let the user try again.

**Sign-in instead of a code** (a relay that pairs by `oidc`): see
[references/sign-in.md](references/sign-in.md). **React** single-page apps: see
[references/react.md](references/react.md).

**The site's own assistant, without a relay.** A site whose AI assistant runs on the page
(a chat in an iframe whose backend runs the MCP client) can serve the tools to it over a
`MessagePort`: no relay, no pairing, no address.

```ts
const mcp = new TabMcp({ server: { name: "shop", version: "1.0.0" } }); // no relay
const served = await mcp.serve(port, {
  client: { id: "assistant", name: "Shop assistant" },
  onConfirm: (request) => askInChat(request), // the user's click in the chat answers
});
```

- The other end uses `createTunnelFetch` from `@ractive-ch/tab-mcp-client/tunnel` as the
  `fetch` of the MCP SDK's client, pinned to `2026-07-28` (an agent framework's own MCP
  client may not speak it), and passes the messages over its own channel; it hands the
  framework the tools as function tools. The README's
  [Your own assistant on the page](https://github.com/ractive/tab-mcp/blob/client-v0.21.0/packages/tab-mcp-client/README.md#your-own-assistant-on-the-page)
  has the whole setup and a tested backend recipe.
- A port is a key: whoever holds the other end calls the tools without pairing. Hand it
  only to a frame whose origin you checked, with that origin as the `postMessage` target,
  never `"*"`.
- Calls arrive with `client: { kind: "local", id, name }`. A consequential tool still
  asks: recommend `serve`'s `onConfirm`, which asks in the site's chat, in the user's
  language, for that port's calls only (relay calls keep the page's `onConfirm` or
  dialog, WebMCP calls the page's `onConfirm`, section 5; same answers;
  `request.signal` aborts on cancel, timeout or close). The answer must come from the user's click, never from a message of the
  assistant's backend: the library does not send the question over the port for that
  reason. Do not answer `true` for `kind === "local"` to skip the question: tool results
  bring third-party text into the model. Without it the dialog names "Shop assistant
  (this site's assistant)", no "Always allow".
- Page state that changes (the product shown, the cart) belongs in a read-only tool such
  as `get_page_context`, not in `instructions`: MCP has no notification for changed
  instructions.
- `requestTimeoutMs` (300 s) limits each request on the page's side (`-31002`, the call
  ends as `cancelled`); a port has none of the relay's other limits.
- `served.close()` (or `options.signal`) ends it; close it when the channel is gone.
  Without `relay`, `connect()`, `showConnectDialog()` and `disconnectAll()` reject with a
  `TypeError` and React's `ConnectButton` renders nothing. `serve`, the relay and
  `webmcp: true` can be used together: one registration reaches all three.

## 4. Consequential tools

Give `consequentialHint: true` to a tool whose effect the user cannot undo in the page,
or that acts outside it: it deletes for good, sends, buys, books, publishes, or changes
data on the server. A change the user sees in the page and can take back (add a note, move
a shape in an editor with Undo) gets none: a question on every call teaches users to click
Allow without reading. The live examples follow this rule: the todo list asks before
deleting, the sign-in example before deleting notes; adding and completing do not ask.

```ts
await mcp.registerTool<{ id: string }>({
  name: "delete_note",
  description: "Delete a note by its id. It cannot be restored.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  annotations: { consequentialHint: true },
  execute: ({ id }) => deleteNote(id),
});
```

Write the description as what the tool does and that it cannot be undone; do not promise
a question ("the page asks first"): the library does not ask a WebMCP call the tab-mcp
browser extension did not vouch for (section 5), and an agent told it will be asked may
click the page's own buttons instead.

The page then asks before every call of an AI app through the relay (WebMCP calls: section 5): a dialog names the AI app and shows the arguments,
"Don't allow" has the focus, and "Allow once" turns on only after the page has been visible and
focused for 750 ms with the dialog open (leaving the page starts the wait again).
Invisible and direction-changing characters in the arguments are shown as `\uXXXX`. The
dialog offers "Don't allow" and "Allow once"; "Always allow" (that tool runs without asking for
that AI app, with any arguments, until the app is disconnected, kept in `storage`; the
connect dialog shows a switch per tool and "Always allow everything" under
each app) appears only with `alwaysAllow: true` on `TabMcp` (`"until-reload"`: memory
only, "Allow until reload"). A page can draw its own switches with `allowedTools(mcp)` of
`@ractive-ch/tab-mcp-client/allowed`. Leave it off unless the user really need not check
each call: it lifts the only brake on a prompt injection for up to the grant's 90 days,
and the relay's one `tools` scope covers every tool, so consent per tool is the page's. A refusal becomes an error result. The AI app also sees `destructiveHint: true`. To ask in the page's own UI,
pass `onConfirm: (request) => ConfirmAnswer | Promise<ConfirmAnswer>` to `TabMcp`, where
`ConfirmAnswer` is `true` (run), `false` (the user refused) or `"unanswered"` (the user
was asked and did not answer, e.g. the page's own question timed out: the AI app reads
"The user was asked and did not answer." and `toolcallend` has the outcome
`unanswered`); anything else, and a throw, is a refusal. `request` has
`tool`, `arguments`, `client` and `signal`; close the question when `signal` aborts.
`mcp.confirmInPage(request, { document? })` is the library's dialog, for example for
`client.kind === "local"`; for `client.kind === "webmcp"` it resolves `true` unshown, as
without `onConfirm`. A served port can have its own `onConfirm` (section 3).
Without `onConfirm` and without a `document`,
calls are declined.

## 5. WebMCP: agents in the browser

```ts
const mcp = new TabMcp({ relay, server, webmcp: true });
await mcp.registerTool(deleteNoteTool); // an AI app is asked; an unvouched WebMCP call is not
```

Whether anyone asks before a tool that asks runs, and who, depends on the caller
(DEC-215); for some callers nobody does. The last three rows all arrive as
`client: { kind: "webmcp" }` without `via`; the page cannot tell them apart:

| Caller | Can it click in the tab? | Who asks |
|---|---|---|
| An AI app through the relay | no | the page: `onConfirm`, else the library's dialog |
| An AI app through the tab-mcp browser extension (a WebMCP call it vouched for) | no | the extension, in its side panel; the page skips its question and `onConfirm` (`trustExtension`, on by default; `false`: `onConfirm` decides, as for the rows below) |
| An agent in the browser that drives the tab | yes | the agent in its chat, if it heeds `consequentialHint`; the page's `onConfirm` if any; never the library's dialog |
| Another extension passing on an AI app's calls | no, unless that extension lets it | that extension, if it asks; the page's `onConfirm` if any; never the library's dialog |
| A document of an origin in the tool's `exposedTo` | no, not in the page | only the page's `onConfirm`, if any |

- `webmcp: true` (off by default) also registers each tool with the browser's native
  `document.modelContext.registerTool()`, where the browser has it (in Chrome: sites in
  the WebMCP origin trial, or `chrome://flags/#enable-webmcp-testing`). Agents in the
  browser (built in, or an extension) then call the tools without pairing. It is a
  change in what the page exposes: turn it on only when the user wants that.
- Every tool goes there, tools with `consequentialHint` or `destructiveHint` included
  (since client 0.20, DEC-209): hiding them did not stop an agent that drives the tab, it
  clicked the page's own controls instead, with no question. `callers` without
  `"webmcp"` keeps a tool out (React: `useTool(tool, { callers: ["relay", "local"] })`).
- The library shows an unvouched WebMCP call no question (since client 0.21, DEC-215;
  0.20 showed its dialog): an agent that
  drives the tab clicked "Allow once" in the dialog itself. For another extension or an
  `exposedTo` origin the dialog was a real check, and it is gone too. Such a tool is
  registered with `consequentialHint: true`, so a caller that heeds it asks its user.
  The page's `onConfirm` still gets the call (`client.kind === "webmcp"`, no `via`):
  decide there in code (refuse, or a rule), never by showing something, which an agent
  can click too. Without `onConfirm` the call runs. A tool that must not run on such a
  caller's word leaves `"webmcp"` out of `callers`, and gets no `exposedTo` (the library
  warns in the console about a tool that asks with `exposedTo` on a page without
  `onConfirm`).
- **The tab-mcp browser extension.** With `webmcp: true` the page and the extension
  shake hands. A call the user has just allowed in the extension (asked in its side
  panel, or covered by its "Always allow" switch; the same tool, equal arguments, within
  2 seconds) runs without `onConfirm`, so `onConfirm` is not a hook that sees every
  call; its caller is `{ kind: "webmcp", via: "tab-mcp-extension", name, host }`.
  `trustExtension: false` on `TabMcp` hands such a call to `onConfirm` like an
  unvouched one; without `onConfirm` it then runs as well, so the option only matters
  to a page with an `onConfirm`. `mcp.extension` (event `extensionchange`, React:
  `extension` of `useTabMcpState()`) is `{ name, apps, whileInFront }` while
  the extension serves the page, `apps` being the AI apps connected through it
  (`{ name, host }`), else `undefined`: while AI access is off, the extension answers no
  page and sends it nothing, so do not try to tell "extension off" from "no extension".
  The connect dialog already says so. Details:
  [With the tab-mcp browser extension](https://github.com/ractive/tab-mcp/blob/client-v0.21.0/packages/tab-mcp-client/README.md#with-the-tab-mcp-browser-extension).
- A WebMCP call gets the same argument check as an AI app's and fires `toolcall` and
  `toolcallend` with `client.kind === "webmcp"`, so the page's record of calls still
  lists it.
- The agent gets what `execute` returned. A failure (invalid arguments, a refusal of
  `onConfirm`, a tool that is gone, a thrown error, an `isError` result) comes back as
  `{ error: "<message>" }`, not as a rejection, which Chrome would hand the agent as a
  bare `UnknownError`. Two cases still reject: a call the browser cancelled
  (`AbortError`), and a call when the library's lazily loaded part cannot be loaded (a
  new deploy while the page stays open, the network); reloading the page fixes that.
- Only the native object is used, never a polyfill such as `@mcp-b/global`. A failed
  native registration (a name already registered natively, a frame without
  `allow="tools"`) only warns in the console; the tool stays offered through the relay.
  A page that registers tools natively itself leaves `webmcp` off or uses other names.
- The tab-mcp browser extension offers mirrored tools like any page tool, so an AI app connected to
  both the page and the extension sees them twice.

## 6. Security defaults

Keep these; do not work around them.

- Sessions start only from a click. Do not call `connect()` from timers or on load
  without the user's opt-in.
- Relays must be `https:`; `http:` works only for `localhost`, `127.0.0.1` and `[::1]`.
- Keep XSS out of the page and do not log or expose the secret under
  `tab-mcp:secret:<relay origin>:<server name>`: whoever has it can take the page's place,
  and the AI apps paired with it then use them until the page makes a new secret
  (`disconnectAll()`).
  Run the page on its own origin (not a shared one such as `*.github.io`) and keep
  third-party scripts off it.
- For a page with user accounts, use identity binding
  ([references/sign-in.md](references/sign-in.md)): a copied secret then gets nothing.
  On a page that pairs by code, grants follow the browser profile, not the person, so the
  next user of a shared browser gets the AI apps the previous one paired: call
  `mcp.disconnectAll()` when the user logs out.
- The relay's pairing page names the AI app and the app id of the address, not the page:
  the code alone says which page is paired. Tell users never to pass their code on.
- Tools act with the user's rights in the page. Expose only what the user may do anyway,
  and nothing that leaks other users' data.
- Connecting an AI app means trusting the page. Describe tools honestly; tool text and
  results go to the model.
- Do not open the relay to every origin (`TAB_MCP_ALLOWED_ORIGINS=*`) in production.

## 7. Run the relay

Local development (a page on `http://localhost:3000`):

```sh
docker run --rm -p 8080:8080 -e NODE_ENV=development \
  -e TAB_MCP_PUBLIC_URL=http://localhost:8080 \
  -e TAB_MCP_ALLOWED_ORIGINS=http://localhost:3000 \
  -e TAB_MCP_STORE=memory ractive/tab-mcp:0.13.2
```

Production: name the image version (pre-releases have no `latest` tag), keep `/data` on
a volume, and put the relay behind TLS:

```sh
docker run -d -p 127.0.0.1:8080:8080 -v tab-mcp-data:/data \
  -e TAB_MCP_PUBLIC_URL=https://relay.example.com \
  -e TAB_MCP_ALLOWED_ORIGINS=https://app.example.com \
  -e TAB_MCP_TRUST_PROXY=x-real-ip ractive/tab-mcp:0.13.2
```

`x-real-ip` fits an nginx proxy that sets `X-Real-IP $remote_addr`; behind Caddy use
`x-forwarded-for`. Set it only to a header your proxy overwrites, and never when clients
can reach the relay directly, or they can pick their own IP and get around the per-IP
limits.

Without Docker: `bun add --global @ractive-ch/tab-mcp`, then `tab-mcp` with the same
variables (Bun 1.4.4+). Run one relay process per public address. The reverse proxy must
forward WebSockets on `/tab`, must not buffer event streams on `/s/…/mcp`, and must allow
requests of up to 300 s. The relay starts event streams after 20 s, which keeps 60 s
first-byte limits of CDNs happy. Health check: `GET /healthz`.

## 8. Common mistakes

- `connect()` or `showConnectDialog()` on page load, in a `useEffect` or from a timer:
  the browser refuses it. Open the dialog from a click; on load only
  `connect({ resume: true })`, and only after the user turned AI access on.
- The page's origin is missing from `TAB_MCP_ALLOWED_ORIGINS`, or differs in scheme or
  port: the relay refuses the page.
- `consequentialHint` on every tool that writes: only for effects the user cannot undo
  in the page (section 4).
- A tool description or `instructions` that promise a question ("the page asks
  first"): an unvouched WebMCP call is not asked by the library, and an agent told it
  will be may click the page's own buttons instead. Say what the tool does and that it
  cannot be undone (section 4).
- Casts or hand-written checks of the arguments in `execute`: the schema is checked
  first; put the limits in it.
- A React tool that reads state the previous call changed from the component's props or
  `useState`: it gets the old value. Read from a store or a ref
  ([references/react.md](references/react.md)).
- A retry loop around `connect()`: the library reconnects by itself (section 3).
- Renaming `server.name` after release: the page gets a new secret (and, without `app`, a
  new address), so every AI app pairs again. Choose it once.
- Handing `serve`'s port to a frame with `"*"` as the target: transfer it as
  `frame.contentWindow.postMessage({ type: "tools-port" }, "https://chat.example", [port2])`,
  with the frame's checked origin (section 3).

## Check your work

Try the pairing flow by hand with Claude Code against a local relay. For automated
tests of the page's tools, `@ractive-ch/tab-mcp/testing` starts a relay in the test
process and gives a token without pairing
([the relay's README](https://github.com/ractive/tab-mcp/tree/relay-v0.13.2/packages/tab-mcp#testing-a-pages-tools)).
Live pages to try are at <https://ractive.ch/tab-mcp/>. The relay's docs cover every
setting and the proxy details:
[configuration](https://github.com/ractive/tab-mcp/blob/relay-v0.13.2/docs/configuration.md),
[self-hosting](https://github.com/ractive/tab-mcp/blob/relay-v0.13.2/docs/self-hosting.md),
[compatibility](https://github.com/ractive/tab-mcp/blob/main/docs/compatibility.md) (which
AI apps work, kept up to date) and the
[security policy](https://github.com/ractive/tab-mcp/blob/main/SECURITY.md).
