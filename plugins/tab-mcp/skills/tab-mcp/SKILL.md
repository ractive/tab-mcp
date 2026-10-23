---
name: tab-mcp
description: Add tab-mcp to a web app so that AI apps (Claude, ChatGPT, Claude Code) can call the page's functions as MCP tools while it is open in a browser tab. Covers installing @ractive-ch/tab-mcp-client, registering tools WebMCP-style, the connect and pairing flow, confirmation for consequential tools, security defaults and running a tab-mcp relay. Use when the user wants to expose a web page's features to AI apps over MCP, mentions tab-mcp, WebMCP-style registerTool or "Connect your AI app", or needs to self-host the tab-mcp relay.
license: MIT
compatibility: Browser library for any web page (ES modules); the relay needs Bun 1.4.3+ or Docker.
---

# Add tab-mcp to a web app

tab-mcp lets AI apps call tools that a web page offers while it is open in a browser tab.
The page uses the browser library `@ractive-ch/tab-mcp-client`, which connects to a
tab-mcp relay (`@ractive-ch/tab-mcp`) over a WebSocket and gets an MCP address. The user
adds that address to their AI app and pairs it with a code shown in the page. The relay
forwards the AI app's requests to the page; the tools run in the page.

Facts to keep in mind (version 0.5.0):

- Only MCP revision 2026-07-28, and only AI apps that register through OAuth Client ID
  Metadata Documents. Claude Code works; VS Code, Cursor and Gemini CLI cannot connect.
  claude.ai and ChatGPT need a relay with a public HTTPS address.
- The page needs a relay that allows its origin; run one (section 6).

## 1. Install the client

```sh
npm install @ractive-ch/tab-mcp-client
```

Without a bundler, import the self-contained build from a CDN:

```html
<script type="module">
  import { TabMcp } from "https://cdn.jsdelivr.net/npm/@ractive-ch/tab-mcp-client@0.5.0/cdn/tab-mcp-client.min.js";
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
   (`https://<relay>/a/<id>/mcp`), Copy and New address buttons, steps for Claude, ChatGPT and Claude
   Code, and a 6-digit code. The code is valid for 2 minutes and is replaced by itself.
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
not open. The library never reconnects by itself. If the page offers a "Keep AI access
on" switch that the user turned on, call `connect({ resume: true })` on load. After a
`disconnected` event with reason `network`, `heartbeat` or `shutdown`, call
`connect({ resume: true })` again with a growing wait, and at once when the tab comes back
to the front (`visibilitychange`) or the network returns (`online`): phones pause
background tabs, which breaks the connection while the user is in the AI app.

"New address" in the dialog calls `mcp.newAddress()`: it disconnects every app and makes
a new address, and the dialog asks first when apps are connected. The relay's pages point
users to it when someone may be guessing codes. A custom UI calls `mcp.newAddress()` from
a click.

For a custom UI, use `connect()`, `startPairing()`/`stopPairing()` (codes come only while
pairing is on), `revoke(grantId)`, `disconnect()`, the properties `address`,
`pairingCode` and `grants`, and the events `connected`, `disconnected`, `pairingcode`,
`grantschange`, `statechange` and `error`.

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
"Don't allow" has the focus, and "Allow" stays disabled for 750 ms. A refusal becomes an
error result. The AI app also sees `destructiveHint: true`. To ask in the page's own UI,
pass `onConfirm: (request) => boolean | Promise<boolean>` to `TabMcp`. `request` has
`tool`, `arguments`, `client` and `signal`; close the question when `signal` aborts. Without `onConfirm` and without a `document`,
calls are declined.

## 5. Security defaults

Keep these; do not work around them.

- Sessions start only from a click. Do not call `connect()` from timers or on load
  without the user's opt-in.
- Relays must be `https:`; `http:` works only for `localhost`, `127.0.0.1` and `[::1]`.
- Keep XSS out of the page and do not log or expose the secret under
  `tab-mcp:secret:<relay origin>:<server name>`: whoever has it can take over the address.
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
  -e TAB_MCP_STORE=memory ractive/tab-mcp:0.3.0
```

Production: name the image version (pre-releases have no `latest` tag), keep `/data` on
a volume, and put the relay behind TLS:

```sh
docker run -d -p 127.0.0.1:8080:8080 -v tab-mcp-data:/data \
  -e TAB_MCP_PUBLIC_URL=https://relay.example.com \
  -e TAB_MCP_ALLOWED_ORIGINS=https://app.example.com \
  -e TAB_MCP_TRUST_PROXY=x-real-ip ractive/tab-mcp:0.3.0
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
