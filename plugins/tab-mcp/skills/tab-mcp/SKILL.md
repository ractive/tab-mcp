---
name: tab-mcp
description: Add tab-mcp to a web app so that AI apps (Claude, ChatGPT, Claude Code) can call the page's functions as MCP tools while it is open in a browser tab. Covers installing @ractive-ch/tab-mcp-client, registering tools WebMCP-style, the React bindings, the connect and pairing flow (by code or by sign-in), confirmation for consequential tools, security defaults and running a tab-mcp relay. Use when the user wants to expose a web page's features to AI apps over MCP, mentions tab-mcp, WebMCP-style registerTool or "Connect your AI app", or needs to self-host the tab-mcp relay.
license: MIT
compatibility: Browser library for any web page (ES modules); the relay needs Bun 1.4.3+ or Docker.
---

# Add tab-mcp to a web app

tab-mcp lets AI apps call tools that a web page offers while it is open in a browser tab.
The page uses the browser library `@ractive-ch/tab-mcp-client`, which connects to a
tab-mcp relay (`@ractive-ch/tab-mcp`) over a WebSocket and gets an MCP address. The user
adds that address to their AI app and pairs it with a code shown in the page. The relay
forwards the AI app's requests to the page; the tools run in the page.

Facts to keep in mind (version 0.8.0):

- Only MCP revision 2026-07-28, and only AI apps that register through OAuth Client ID
  Metadata Documents. Claude Code works; VS Code, Cursor and Gemini CLI cannot connect.
  claude.ai and ChatGPT need a relay with a public HTTPS address.
- The page needs a relay that allows its origin; run one (section 6).
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
  import { TabMcp } from "https://cdn.jsdelivr.net/npm/@ractive-ch/tab-mcp-client@0.8.0/cdn/tab-mcp-client.min.js";
</script>
```

## 2. Create the client and register tools

```ts
import { TabMcp } from "@ractive-ch/tab-mcp-client";

const mcp = new TabMcp({
  relay: "https://relay.example.com",      // https:, or http: only on localhost
  server: { name: "notes", version: "1.0.0", instructions: "Notes shown on the page." },
  appName: "notes",                        // 1-64 characters, shown when pairing
});

const tools = new AbortController();
await mcp.registerTool(
  {
    name: "add_note",                      // 1-128 of A-Z a-z 0-9 _ - .
    title: "Add note",
    description: "Add a note to the list on the page and return its id.",
    inputSchema: {
      type: "object",                      // required: the schema must be an object
      properties: { text: { type: "string", maxLength: 500 } },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async ({ text }, { signal }) => addNote(String(text), { signal }),
  },
  { signal: tools.signal },                // abort to remove the tool
);
```

Rules for tools:

- The shape follows the WebMCP draft (`document.modelContext.registerTool`). There is no
  `unregisterTool`: abort the registration signal. AI apps that listen get a
  tool-list-changed notification.
- `registerTool` returns a promise. It rejects with a `TypeError` for an invalid tool and
  an `InvalidStateError` for a duplicate name. Do not use `x-mcp-header` in schemas.
- Arguments are validated against `inputSchema` before `execute` runs. Still treat them
  as untrusted input in `execute`.
- Write `description` for a model: what the tool does, its units, an example.
- `execute` results: a string becomes one text block; an object with a `content` array is
  passed through as an MCP result (use it for images); any other JSON value is sent as
  JSON text and, for objects, as `structuredContent`. A thrown error becomes an error
  result with its message, so throw errors that tell the model what to do.
- `signal` aborts when the AI app gives up. `client` has `id`, the verified `host` and
  the declared `name`.
- Annotations: `readOnlyHint` for tools that only read; `consequentialHint` for tools
  that change or delete something (section 4); `untrustedContentHint` for results that
  contain user or third-party content. MCP hints (`destructiveHint`, `idempotentHint`,
  `openWorldHint`) may be set directly.

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
   (`https://<relay>/a/<id>/mcp`), Copy and New address buttons, steps for Claude, ChatGPT, Claude
   Code and Codex (the two commands with a Copy each, named by a shell-safe label made from `server.name`; Codex's first
   turns on its feature `mcp_2026_07_28`), and a 6-digit code. The code is valid for 2 minutes and is replaced by itself.
3. The user adds the address to the AI app, for example
   `claude mcp add --transport http notes <address>` and then `/mcp` → Authenticate in
   Claude Code.
4. The AI app opens the relay's `/authorize` page in the browser. The page names the AI
   app and the page origin. The user types the code there. Codes work once and allow 5
   attempts.
5. The dialog lists the connected app with a Disconnect button. The AI app can now call
   the tools while the page is connected.

The address is stable across visits (a secret per relay and server name in `localStorage`), and paired
apps stay paired across reloads. While the page is closed, their calls wait up to 10 s
for it (the relay's `TAB_MCP_PAGE_WAIT_S`) and then get a tool result saying the page is
not open. Renaming `server.name` changes the address, so the apps pair again.

When the connection breaks (reason `network`, `heartbeat` or `shutdown`: a dropped
network, a phone pausing the tab in the background, a relay restart), the library
connects again by itself: after 5, 10, 20 and 40 s, then every 60 s, and at once when the
tab comes back to the front or the network returns. Do not write your own retry loop;
show the property and event `reconnecting` (the next attempt, its number and time; once
it stopped, the event carries `null` and the property is `undefined`; when the relay
refused an attempt, `error` says why just before). It never reconnects after `disconnect()`, a new address, another
tab taking over the address (`replaced`), an expired or idle session or a refusal by the
relay, and a first `connect()` that fails is not retried (show the error and let the
user try again). `reconnect: false`
turns it off, `reconnect: { delaysMs: [...] }` sets the waits.

The library does not connect on page load by itself: if the page offers a "Keep AI
access on" switch that the user turned on, call `connect({ resume: true })` on load.

"New address" in the dialog calls `mcp.newAddress()`: it disconnects every app and makes
a new address, and the dialog asks first when apps are connected. The relay's pages point
users to it when someone may be guessing codes. A custom UI calls `mcp.newAddress()` from
a click.

For a custom UI, use `connect()`, `startPairing()`/`stopPairing()` (codes come only while
pairing is on), `revoke(grantId)`, `disconnect()`, the properties `address`,
`pairingCode` and `grants`, and the events `connected`, `disconnected`, `pairingcode`,
`grantschange`, `statechange`, `reconnecting`, `replaced` and `error`.

When another tab or program takes over the address, the page gets `disconnected` (reason
`replaced`) and then, up to a second later, `replaced`. Once the page has opened the
default dialog, the library says so itself: "Opened in another tab" when a tab of the
same page said on its `BroadcastChannel` that its session started, otherwise a warning
with "New address". A custom UI does the same with `event.detail.sibling`: `true` is the
usual, harmless second tab; `false` means it may be a program with a copy of the address
secret, which the paired AI apps now talk to, so offer a "New address" button that calls
`mcp.newAddress()`. It takes the address back with the relay revoking those apps in the
same step, then connects with a new address; if it rejects with `reason: "replaced"`, the
address was taken over again first: say so and let the user try again.

**Sign-in instead of a code** (a relay that pairs by `oidc`): see
[references/sign-in.md](references/sign-in.md). **React** single-page apps: see
[references/react.md](references/react.md).

## 4. Consequential tools

Every tool that changes data, spends money, sends something or deletes something gets
`consequentialHint: true`:

```ts
await mcp.registerTool({
  name: "delete_note",
  description: "Delete a note by its id.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  annotations: { consequentialHint: true },
  execute: ({ id }) => deleteNote(String(id)),
});
```

The page then asks before every call: a dialog names the AI app and shows the arguments,
"Don't allow" has the focus, and "Allow" turns on only after the page has been visible and
focused for 750 ms with the dialog open (leaving the page starts the wait again).
Invisible and direction-changing characters in the arguments are shown as `\uXXXX`. The
dialog offers "Don't allow" and "Allow"; "Always allow" (that tool runs without asking for
that AI app until a reload or a disconnect) appears only with `alwaysAllow: true` on
`TabMcp`. Leave it off unless the user really need not check each call: it lifts the only
brake on a prompt injection, and the relay's one `tools` scope covers every tool, so
consent per tool is the page's. A refusal becomes an error result. The AI app also sees `destructiveHint: true`. To ask in the page's own UI,
pass `onConfirm: (request) => boolean | Promise<boolean>` to `TabMcp`. `request` has
`tool`, `arguments`, `client` and `signal`; close the question when `signal` aborts. Without `onConfirm` and without a `document`,
calls are declined.

## 5. Security defaults

Keep these; do not work around them.

- Sessions start only from a click. Do not call `connect()` from timers or on load
  without the user's opt-in.
- Relays must be `https:`; `http:` works only for `localhost`, `127.0.0.1` and `[::1]`.
- Keep XSS out of the page and do not log or expose the secret under
  `tab-mcp:secret:<relay origin>:<server name>`: whoever has it can take over the address,
  and the AI apps paired with it then talk to them until the page gets a new address.
  Run the page on its own origin (not a shared one such as `*.github.io`) and keep
  third-party scripts off it.
- For a page with user accounts, use identity binding
  ([references/sign-in.md](references/sign-in.md)): a copied secret then gets nothing.
  On a page that pairs by code, grants follow the browser profile, not the person, so the
  next user of a shared browser gets the AI apps the previous one paired: call
  `mcp.newAddress()` when the user logs out.
- The page origin on the relay's pairing page is what the browser reported; a program
  can claim any origin. Do not tell users it proves which page they pair with.
- Tools act with the user's rights in the page. Expose only what the user may do anyway,
  and nothing that leaks other users' data.
- Connecting an AI app means trusting the page. Describe tools honestly; tool text and
  results go to the model.
- Do not open the relay to every origin (`TAB_MCP_ALLOWED_ORIGINS=*`) in production.

## 6. Run the relay

Local development (a page on `http://localhost:3000`):

```sh
docker run --rm -p 8080:8080 -e NODE_ENV=development \
  -e TAB_MCP_PUBLIC_URL=http://localhost:8080 \
  -e TAB_MCP_ALLOWED_ORIGINS=http://localhost:3000 \
  -e TAB_MCP_STORE=memory ractive/tab-mcp:0.5.1
```

Production: name the image version (pre-releases have no `latest` tag), keep `/data` on
a volume, and put the relay behind TLS:

```sh
docker run -d -p 127.0.0.1:8080:8080 -v tab-mcp-data:/data \
  -e TAB_MCP_PUBLIC_URL=https://relay.example.com \
  -e TAB_MCP_ALLOWED_ORIGINS=https://app.example.com \
  -e TAB_MCP_TRUST_PROXY=x-real-ip ractive/tab-mcp:0.5.1
```

`x-real-ip` fits an nginx proxy that sets `X-Real-IP $remote_addr`; behind Caddy use
`x-forwarded-for`. Set it only to a header your proxy overwrites, and never when clients
can reach the relay directly, or they can pick their own IP and get around the per-IP
limits.

Without Docker: `bun add --global @ractive-ch/tab-mcp`, then `tab-mcp` with the same
variables (Bun 1.4.3+). Run one relay process per public address. The reverse proxy must
forward WebSockets on `/tab`, must not buffer event streams on `/a/…/mcp`, and must allow
requests of up to 300 s. The relay starts event streams after 20 s, which keeps 60 s
first-byte limits of CDNs happy. Health check: `GET /healthz`.

## Check your work

Try the pairing flow by hand with Claude Code against a local relay. Live pages to try
are at <https://ractive.ch/tab-mcp/>; the docs cover every setting and the proxy details:
<https://github.com/ractive/tab-mcp> (`docs/configuration.md`,
`docs/self-hosting.md`, `docs/compatibility.md`, `SECURITY.md`).
