# @ractive-ch/tab-mcp-client

Offer a web page's functions as [MCP](https://modelcontextprotocol.io) tools to AI apps
(Claude, ChatGPT, Claude Code) through a [tab-mcp](https://github.com/ractive/tab-mcp)
relay. The page connects to the relay and gets an address. The user adds that address to
their AI app and types a pairing code from the page; the AI app then calls the page's
tools while the tab stays open. Nothing is installed on the user's computer.

**Status: 0.6.0.** Until 1.0, a new minor version can still change the API. Which AI apps
work is listed in [compatibility](https://github.com/ractive/tab-mcp/blob/main/docs/compatibility.md).

## You need a relay

The page talks to a tab-mcp relay, which only accepts pages from the origins its operator
allows. Run your own: the relay is on npm as
[`@ractive-ch/tab-mcp`](https://www.npmjs.com/package/@ractive-ch/tab-mcp) and on Docker
Hub as `ractive/tab-mcp`. For local development:

```sh
docker run --rm -p 8080:8080 \
  -e NODE_ENV=development \
  -e TAB_MCP_PUBLIC_URL=http://localhost:8080 \
  -e TAB_MCP_ALLOWED_ORIGINS=http://localhost:3000 \
  -e TAB_MCP_STORE=memory \
  ractive/tab-mcp:0.4.0
```

For production, see
[self-hosting](https://github.com/ractive/tab-mcp/blob/main/docs/self-hosting.md).

## Install

```sh
npm install @ractive-ch/tab-mcp-client
```

Or without a bundler, from a CDN as an ES module:

```html
<script type="module">
  import { TabMcp } from "https://cdn.jsdelivr.net/npm/@ractive-ch/tab-mcp-client@0.6.0/cdn/tab-mcp-client.min.js";
</script>
```

## Use

```ts
import { TabMcp } from "@ractive-ch/tab-mcp-client";

const mcp = new TabMcp({
  relay: "https://relay.example",
  server: { name: "calculator", version: "1.0.0" },
  appName: "calculator",
});

await mcp.registerTool({
  name: "add",
  description: "Add two numbers",
  inputSchema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  annotations: { readOnlyHint: true },
  execute: ({ a, b }) => Number(a) + Number(b),
});

// From a click: connects and shows the address to add to the AI app.
button.addEventListener("click", () => mcp.showConnectDialog());
```

Importing the library loads only a small core; `connect()` loads the rest.

### Tools

`registerTool(tool, { signal })` takes a tool in the shape of the WebMCP draft's
`registerTool`:

- `name` (1-128 characters of `A-Z a-z 0-9 _ - .`), `title`, `description` (not empty);
- `inputSchema`: a JSON Schema with `"type": "object"`. Arguments are checked against it
  before `execute` runs. `registerTool` rejects a schema the validator cannot use (a
  pattern that is not a regular expression, a `$ref` that does not resolve). The
  validator itself is loaded by `connect()`: from then on it checks each schema at
  registration too, and a tool registered earlier whose schema it refuses (for example a
  `$ref` next to a nested `$id`) is unregistered, with the reason in the event `error`;
- `execute(input, { signal, client })`: runs the tool. `signal` aborts when the AI app
  gives up; `client` names the caller (`id`, verified `host`, declared `name`). Return a
  string (one text block), an MCP result with a `content` array (passed through), or any
  other JSON value (sent as JSON text, and as `structuredContent` for an object). A thrown
  error becomes an error result with its message;
- `annotations`: `readOnlyHint`, `consequentialHint`, `untrustedContentHint`, and the
  MCP hints `destructiveHint`, `idempotentHint`, `openWorldHint`.

Abort the `signal` to remove the tool. AI apps that listen for changes learn about
added and removed tools.

### Consequential tools

Mark tools that change or delete something with `consequentialHint: true`. The page then
asks the user before every call ("Allow", "Always allow" or "Don't allow"), showing the AI
app and the arguments. "Always allow" lets that tool run without asking for that AI app
until the page is reloaded or the app is disconnected. A refusal reaches the AI app as an
error result, and so does a call whose tool was removed while the user was asked.

Tools are called while the user is in the AI app, so the dialog often opens in a tab in
the background. "Allow" and "Always allow" can be clicked only once the page has been
visible and focused for `confirmDelayMs` (750 ms) with the dialog open; leaving the page
disables them and coming back starts the wait again, so the click that brings the page
forward cannot approve. Characters that are invisible or change the text direction (such
as U+202E) are shown in the arguments as `\uXXXX`, so the AI app cannot make them look
like something else; the tool gets the arguments unchanged.

Pass `onConfirm` to ask in your own UI (it is asked every time; remember answers there if
you want to). Show the verified `client.host` next to the name the AI app declares, as the
library's dialog does, since anyone can declare any name:

```ts
const mcp = new TabMcp({
  relay: "https://relay.example",
  server: { name: "calculator", version: "1.0.0" },
  onConfirm: ({ tool, arguments: args, client, signal }) => {
    const app = client.name ? `${client.name} (${client.host})` : client.host;
    return myDialog.ask(`${app} wants to run ${tool.name}.`, args, signal);
  },
});
```

`mcp.confirmInPage(request)` is the library's own dialog, for an `onConfirm` that
handles only some calls itself.

### Connecting and pairing

1. The user clicks your button. `showConnectDialog()` connects (call it from the click
   handler: browsers that report user activation refuse `connect()` without one) and
   opens the "Connect your AI app" dialog.
2. The dialog shows the address and short instructions for Claude, ChatGPT, Claude Code
   and Codex; the commands for Claude Code and Codex name the server by its `server.name`
   and each has a Copy. Codex 0.163 needs its feature `mcp_2026_07_28` for the relay's MCP
   revision, so its command turns that on first (for all of Codex's MCP servers;
   `codex features disable mcp_2026_07_28` turns it off). The user adds the address to
   their AI app.
3. The AI app opens the relay's sign-in page in the browser. The dialog shows a 6-digit
   code with a Copy button, which the user types or pastes there. The code changes every
   2 minutes and after each use.
4. The dialog announces and lists the connected app with a Disconnect button, and shows
   "Done" to close it.

Until an app connects, the dialog offers no prominent button under the code: only a small
"Close" at the bottom (and Escape). Closing it stops the code (`stopPairing()`); the page
stays connected and the address stays the same, so calling `showConnectDialog()` again
shows the same address with a new code. While the dialog is open, calling it again (a
double click) opens no second one; the call resolves when that one closes. A call for another
`document` (an iframe's, say) while it is open rejects with an `InvalidStateError`.

The address stays the same across visits: the library keeps a secret per relay and page
in `localStorage`, under `tab-mcp:secret:<relay origin>:<server.name>`, so two pages of one
site with different server names get different addresses (set `storageKey` to choose the
key yourself; the name is URI-encoded, and renaming it changes the address). A secret that
0.4 or older kept under `tab-mcp:secret:<relay origin>` is copied to the new key once, so an
existing page keeps its address; on a site with several pages the first one to connect
keeps it, the others get new ones. The old key stays for pages still on 0.4.

"New address" in the dialog calls `newAddress()`, which disconnects every
app and makes a new address; when apps are connected, the dialog asks first. The relay's
sign-in page points users to it when someone else may be guessing codes. A page with its
own UI calls `newAddress()` from a click. Connected apps keep working after a reload once the page connects
again; while the page is closed, they get "the page is not open".

When the connection breaks (reason `network`, `heartbeat` or `shutdown`: a dropped
network, a phone pausing the tab in the background, a relay restart), the library
connects again by itself: after 5, 10, 20 and 40 seconds, then every 60 seconds, and at
once when the tab comes back to the front or the network returns. `reconnecting` (the
next attempt, its number and time) and the event `reconnecting` say so; `null` in the
event means it stopped, connected again or after `disconnect()`. Calling `connect()`
meanwhile tries at once. It never reconnects after `disconnect()`, a new address,
another tab taking over the address (`replaced`), an expired or idle session, or a
refusal by the relay, and an attempt the relay refuses stops it (an unreachable relay is
tried again); the event `error` then says why, just before `reconnecting` turns `null`. `reconnect: false` turns it off, `reconnect: { delaysMs: [...] }`
sets the waits (the last one repeats).

The library does not connect on page load by itself. A page that offers something like
"Keep AI access on" can call `connect({ resume: true })` on load.

### Identity binding (no code)

On a relay that pairs by `oidc` ([identity binding](https://github.com/ractive/tab-mcp/blob/main/docs/configuration.md#identity-binding)),
the user signs in to the AI app's connection with the account they use on your page,
and no code is shown. Your backend proves who is signed in: give the library a function
that fetches a short-lived tab assertion for the page's address.

```ts
const mcp = new TabMcp({
  relay: "https://relay.example.com",
  server: { name: "Calculator", version: "1.0.0" },
  identityAssertion: async ({ address }) => {
    const res = await fetch("/api/tab-mcp-assertion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }), // the assertion's aud
    });
    return res.ok ? (await res.json()).assertion : null; // null: nobody signed in
  },
});

// In your logout: the relay ends every AI connection of this page at once.
logoutButton.onclick = () => { mcp.signOut(); /* then your own logout */ };
// After a sign-in without a reload:
await mcp.refreshIdentity();
```

The library asks the function after every connect. `identity` (`none`, `pending`,
`bound`, `refused`, with the reason in `identityMessage`) and the event
`identitychange` tell you whether the relay accepted it; when the function or the relay does not answer within `identityTimeoutMs` (15 s, counted from when the function is asked), it goes back to `none`. An AI app signed in as someone else gets "This AI tool is logged in as someone other
than the page."

### Your own UI

Instead of `showConnectDialog()`, use `connect()`, `disconnect()`, `newAddress()`,
`startPairing()` and `stopPairing()` (codes come only while pairing is on),
`revoke(grantId)`, the properties `state`, `address`, `pairingCode`, `grants`,
`reconnecting` and `tools`, and the events `statechange`, `connected`, `disconnected`,
`pairingcode`, `grantschange`, `reconnecting`, `toolschange`, `replaced` and `error`. For an activity log, `toolcall`
and `toolcallend` report every call by an AI app: its id, tool, arguments and AI app as it
starts, then its outcome (`ok`, `error`, `declined` or `cancelled`), result and duration.

```ts
mcp.addEventListener("toolcallend", (e) => {
  const { tool, client, outcome, durationMs } = e.detail;
  log(`${client.name ?? client.host}: ${tool} ${outcome} in ${durationMs} ms`);
});
```

### Styling the default dialogs

The default dialogs bring their own stylesheet, a constructed stylesheet added to
`document.adoptedStyleSheets`, so a strict CSP needs no `style-src` exception. It uses
the page's font and system colours, and follows the page's `color-scheme`: declare
`color-scheme: light dark` (or `<meta name="color-scheme" content="light dark">`) and the
dialogs are dark in dark mode. They fit a 360 px wide screen, and they open without
animation when the user prefers reduced motion.

To adjust single values, set these custom properties on `:root` or on `.tab-mcp-dialog`:

| Property | Default | |
| --- | --- | --- |
| `--tab-mcp-font` | `inherit` | font shorthand |
| `--tab-mcp-color` | `CanvasText` | text |
| `--tab-mcp-background` | `Canvas` | background |
| `--tab-mcp-muted` | the text colour at 72 % | secondary text |
| `--tab-mcp-surface` | the text colour at 6 % | the code box, the address, the arguments |
| `--tab-mcp-accent` | the text colour | background of the primary button |
| `--tab-mcp-accent-text` | the background colour | text of the primary button |
| `--tab-mcp-danger` | dark red, light red in dark mode | Disconnect buttons |
| `--tab-mcp-focus` | the text colour | focus ring |
| `--tab-mcp-border` | `1px solid` the text colour at 22 % | border of the dialog |
| `--tab-mcp-radius` | `0.75rem` | corners of the dialog (buttons and boxes: 60 % of it) |
| `--tab-mcp-padding` | `clamp(1rem, 5vw, 1.5rem)` | |
| `--tab-mcp-max-width` | `34rem` | |
| `--tab-mcp-shadow` | `0 1rem 3rem rgb(0 0 0 / 0.3)` | |
| `--tab-mcp-backdrop` | `rgb(0 0 0 / 0.4)` | behind the dialog |
| `--tab-mcp-title-size` | `1.25em` | |
| `--tab-mcp-mono` | `ui-monospace, …, monospace` | the address, the code, the arguments |
| `--tab-mcp-code-size` | `2em` | the pairing code |
| `--tab-mcp-arguments-height` | `12rem` | the arguments scroll beyond this |

For more, write CSS for the class names. Each of the dialogs' rules has the specificity
of one class, so the page's rules for elements (`button { … }`, a reset's
`* { border-width: 0 }`) do not change them, and a rule with two classes, such as
`.tab-mcp-dialog .tab-mcp-primary`, wins over them. Write such rules outside cascade
layers: the dialogs' rules are not in a layer, so they win over any layered rule. Both dialogs are `dialog.tab-mcp-dialog`; the connect dialog is
`.tab-mcp-connect` (with `.tab-mcp-status`, `.tab-mcp-address`, `.tab-mcp-code`,
`.tab-mcp-code-value`, `.tab-mcp-help`, `.tab-mcp-apps`, `.tab-mcp-app`,
`.tab-mcp-new-address-question`, `.tab-mcp-actions`), the confirmation is
`.tab-mcp-confirm` (with `.tab-mcp-description`, `.tab-mcp-arguments`,
`.tab-mcp-always-note`, and the buttons `.tab-mcp-deny`, `.tab-mcp-allow`,
`.tab-mcp-always`). Buttons are `.tab-mcp-primary` (the one next step: Copy the
address, Done, and "Don't allow", the safe choice), `.tab-mcp-danger` (Disconnect and
"Disconnect and get new address") or plain. For example:

```css
:root {
  --tab-mcp-accent: #1f5fbf;
  --tab-mcp-accent-text: #fff;
  --tab-mcp-radius: 0.5rem;
}
.tab-mcp-dialog .tab-mcp-primary { text-transform: uppercase; }
```

## React

`@ractive-ch/tab-mcp-client/react` has bindings for single-page apps with React 18.3 or
19 (`react` is an optional peer dependency; pages without React install nothing more).
A provider makes one `TabMcp` for the tree, each component registers the tools it owns,
and a button opens the connect dialog:

```tsx
import { ConnectButton, TabMcpProvider, useTabMcpState, useTool } from "@ractive-ch/tab-mcp-client/react";

export function App() {
  return (
    <TabMcpProvider relay="https://relay.example" server={{ name: "todo", version: "1.0.0" }} appName="Todo">
      <TodoList />
    </TabMcpProvider>
  );
}

function TodoList() {
  const todos = useTodos(); // your state
  useTool({
    name: "add_todo",
    description: "Add a todo item",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: ({ text }) => todos.add(String(text)),
  });
  const { state, grants } = useTabMcpState();
  return <><ConnectButton /> {state === "connected" && `${grants.length} AI apps`}</>;
}
```

- `<TabMcpProvider {...options}>` takes the `TabMcp` options and makes the instance from
  its first render. A changed `relay` or `server.name` makes a new one (with a warning);
  other changes are ignored, except that `onConfirm` and `identityAssertion` are always
  the latest ones, also when added or removed after the first render (without
  `onConfirm`, the library's dialog asks). It disconnects its instance when it unmounts. `<TabMcpProvider
  client={mcp}>` uses an instance of your own instead (and leaves it connected).
- `useTabMcp()` returns the instance, for everything the hooks do not cover
  (`newAddress()`, `signOut()`, `refreshIdentity()`, `revoke()`, …).
- `useTabMcpState()` returns `{ state, address, session, grants, pairingCode, identity,
  identityMessage, reconnecting, tools }` through `useSyncExternalStore`: the component
  renders again only when one of them changed. On the server and during hydration it is
  `disconnected`.
- `useTool(tool, deps?)` registers the tool while the component is mounted and removes it
  on unmount. `execute` is always the latest closure, so it may use the component's
  current props and state without registering again; the tool is registered again only
  when its name, title, description, input schema or annotations change, or one of
  `deps`. StrictMode's double mount registers it once at a time. A duplicate name or an
  invalid tool is thrown from the component's render, for an error boundary. Tools that
  read state right after another tool changed it should read it from a store (as the
  example does), not from a render's props.
- `useToolCalls({ limit })` lists the AI app's tool calls since the component mounted,
  newest first (default 20), each with its `end` (outcome, result, duration) once over.
- `<ConnectButton>` calls `showConnectDialog()`. Its label follows the state ("Connect
  your AI app", "Connecting…", "Reconnecting…", "AI app connected"); `children` (a node,
  or a function of the state) and the usual button props replace or style it, and
  `data-state` (`disconnected`, `connecting`, `connected`, `reconnecting`) is there for
  CSS. An `onClick` that calls `preventDefault()` keeps the dialog closed.

The module starts with `"use client"`, so React Server Components frameworks (Next.js's
app router) render the provider on the client; it never connects or touches storage on
the server. The CDN build does not include the React bindings: a page that loads tab-mcp
from a CDN uses the core API. [examples/react-todo](https://github.com/ractive/tab-mcp/tree/main/examples/react-todo)
is a complete todo app.

## Security

Connecting an AI app to a page means trusting that page, as with any MCP server. Keep
cross-site scripting out of your page: a script that reads the address secret can take
over the address. The library sends the secret only over `https:`/`wss:` (plain `http:`
only to `localhost`). See
[SECURITY.md](https://github.com/ractive/tab-mcp/blob/main/SECURITY.md) and the
[threat model](https://github.com/ractive/tab-mcp/blob/main/docs/threat-model.md).

## More

- [Live examples](https://ractive.ch/tab-mcp/)
- [Example: a React todo app](https://github.com/ractive/tab-mcp/tree/main/examples/react-todo)
- [Tab–relay protocol](https://github.com/ractive/tab-mcp/blob/main/docs/protocol.md)
- [Changelog](https://github.com/ractive/tab-mcp/blob/main/CHANGELOG.md)

## Licence

MIT, see [LICENSE](LICENSE) and [AI_NOTICE](AI_NOTICE). The CDN build bundles
third-party code; see [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
