# @ractive-ch/tab-mcp-client

Offer a web page's functions as [MCP](https://modelcontextprotocol.io) tools to AI apps
(Claude, ChatGPT, Claude Code, Codex) through a
[tab-mcp](https://github.com/ractive/tab-mcp) relay. The page connects to the relay and
gets an address. The user adds that address to their AI app and types a pairing code
from the page; the AI app then calls the page's tools while the tab stays open. Nothing
is installed on the user's computer. With `webmcp: true` the library also registers the
tools with the browser's own [WebMCP](#webmcp), for agents in the browser. A site's own
assistant can call the same tools over a port, without a relay:
[Your own assistant on the page](#your-own-assistant-on-the-page).

**Status: 0.15.0.** Until 1.0, a new minor version can still change the API. Which AI apps
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
  ractive/tab-mcp:0.9.0
```

For production, see
[self-hosting](https://github.com/ractive/tab-mcp/blob/main/docs/self-hosting.md).

A page that offers its tools only to its own assistant (`serve`) or to agents in the
browser (`webmcp`) needs no relay: leave `relay` out.

## Install

```sh
npm install @ractive-ch/tab-mcp-client
```

Or without a bundler, from a CDN as an ES module:

```html
<script type="module">
  import { TabMcp } from "https://cdn.jsdelivr.net/npm/@ractive-ch/tab-mcp-client@0.15.0/cdn/tab-mcp-client.min.js";
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

`server` is what the AI app sees: `name`, `version`, optional `title` and
`instructions`, and `icons`. Without `icons`, the page's own `<link rel="icon">` and
`<link rel="apple-touch-icon">` are sent, so an AI app that shows icons can show the
page's for its connector. `icons: [{ src, mimeType?, sizes?, theme? }]` (MCP's `Icon`)
sets them instead, `icons: []` sends none. At most 8: `https:` (or `http:`) URLs, or
PNG, JPEG, GIF, WebP or ICO `data:` URIs up to 16 KiB (no inline SVG). They go only in
`server/discover`. An icon on `localhost` reaches only an AI app on the same computer.

### Tools

`registerTool(tool, { signal, webmcp })` takes a tool in the shape of the WebMCP draft's
`registerTool` (`webmcp`: see [WebMCP](#webmcp)):

- `name` (1-128 characters of `A-Z a-z 0-9 _ - .`), `title`, `description` (not empty);
- `inputSchema`: a JSON Schema with `"type": "object"`. Arguments are checked against it
  before `execute` runs. `registerTool` rejects a schema the validator cannot use (a
  pattern that is not a regular expression, a `$ref` that does not resolve; values of
  `default`, `examples`, `const` and `enum` are data and are not read as schema). The
  validator itself is loaded by `connect()`: from then on it checks each schema at
  registration too, and a tool registered earlier whose schema it refuses (for example a
  `$ref` next to a nested `$id`) is unregistered, with the reason in the event `error`;
- `execute(input, { signal, client })`: runs the tool. `signal` aborts when the caller
  gives up. `client` names the caller: `{ kind: "relay", grantId, id, host, name? }` for
  an AI app through the relay (`id`, verified `host`, declared `name`),
  `{ kind: "local", id, name? }` for the site's own assistant on a served port, with the
  `id` and `name` the page gave `serve` ([Your own assistant](#your-own-assistant-on-the-page)),
  or `{ kind: "webmcp" }` for an agent in the browser ([WebMCP](#webmcp)), of which nothing
  more is known. Check `client.kind` before you read `host`. Return a
  string (one text block), an MCP result (passed through with its `_meta`: an object
  whose `content` is an array of MCP content blocks, each with `type` `text`, `image`,
  `audio`, `resource_link` or `resource` and the fields that type needs), or any other JSON value (sent as JSON text,
  and as `structuredContent` when that JSON is an object; a `Date` becomes a string, so
  it has none). Data that only looks like a result, such as a ProseMirror document with
  its `content` array, is sent as JSON. A thrown error becomes an error result with its
  message;
- `annotations`: `readOnlyHint`, `consequentialHint`, `untrustedContentHint`, and the
  MCP hints `destructiveHint`, `idempotentHint`, `openWorldHint`. A hint must be `true`
  or `false`: `registerTool` rejects any other value with a `TypeError`, since a
  `consequentialHint: "true"` that was dropped would run the tool without asking.

In TypeScript, `Tool<Input>` types the `input` of `execute`, and `registerTool` and
`useTool` infer it from the tool or take it explicitly
(`registerTool<{ a: number; b: number }>(…)`); without it, `input` is a
`Record<string, unknown>`. The library checks the arguments against `inputSchema`, not
against the type, so keep the two in step.

Abort the `signal` to remove the tool. AI apps that listen for changes learn about
added and removed tools.

### WebMCP

`new TabMcp({ ..., webmcp: true })` also registers the tools with the browser's own
WebMCP (`document.modelContext.registerTool()`, the
[WebMCP draft](https://webmachinelearning.github.io/webmcp/) of the W3C Web Machine
Learning Community Group; [explainer](https://github.com/webmachinelearning/webmcp)),
where the browser has it, so that agents in the browser can call them: an agent built
into the browser, or an extension. Off by default. Turning it on is a change in what the
page exposes: any agent in the browser can then call the mirrored tools without pairing.
Chrome has WebMCP for sites in its
[origin trial](https://developer.chrome.com/blog/ai-webmcp-origin-trial) (from Chrome
149) and with `chrome://flags/#enable-webmcp-testing`
([Chrome's WebMCP docs](https://developer.chrome.com/docs/ai/webmcp)).

- Tools marked `consequentialHint` are left out unless their registration says
  `{ webmcp: true }`: an agent in the browser often drives the very tab it calls into,
  so it can click Allow in the page's confirmation itself. `{ webmcp: false }` keeps any
  tool out of WebMCP.
- A WebMCP call takes the same path as an AI app's: the arguments are checked against
  `inputSchema` (Chrome does not check them), a consequential tool asks (`onConfirm`, or
  the library's dialog, which names the caller "An agent in this browser"), and
  `toolcall` and `toolcallend` fire with `client: { kind: "webmcp" }`. "Always allow" is
  never offered or applied for these calls: there is no identity to remember it for.
- The call resolves with what `execute` returned. A failure resolves too, as
  `{ error: "<message>" }`, so that the agent can read it: invalid arguments (the same
  message as for an AI app), "Don't allow" (`The user did not allow <tool> to run.`), a
  question not answered (`The user did not answer whether <tool> may run.`), a tool that
  is gone, an error thrown by `execute` (its message) and an MCP result with
  `isError: true` (its text). A rejection would not help: Chrome 156 hands the agent
  every rejection as a bare `UnknownError`, without its message. Two cases still
  reject: a call the browser cancelled (`AbortError`), since its caller no longer waits
  for an answer, and a call made when the library's lazily loaded part cannot be loaded
  (a new deploy with other chunk names while the page stays open, the network, a
  Content Security Policy); reloading the page fixes the latter.
  `toolcallend` reports the outcome as for an AI app (`error`, `declined`, `unanswered`,
  `cancelled`).
- Only the native object is used, read through `Document.prototype`'s getter: an own
  `document.modelContext` (a polyfill such as `@mcp-b/global`, or a page script) is
  passed by, and with native WebMCP and the polyfill both present the tools go to the
  native object.
- A tool leaves WebMCP whenever it leaves the page's registry: its `signal`, or the
  validator, which the first WebMCP call loads (as `connect()` does), refusing its
  schema.
- A failed native registration only warns in the console, once per tool, and the tool
  stays offered through the relay; it is tried again only when the tool is registered
  again: a name the page or another script already registered
  natively keeps its owner, and a frame without `allow="tools"` refuses all. The other
  way round, once a name is mirrored, the page's own native `registerTool()` of that name
  fails: a page that registers tools natively itself leaves `webmcp` off or uses other
  names.
- tab-mcp for Chrome offers mirrored tools like any page tool, since it cannot know
  whether the AI app is also paired with the page, so an AI app connected to the page and
  to the extension sees such a tool twice.

### Your own assistant on the page

A site with its own AI assistant can let it use the page's tools without a relay,
pairing or an address. `mcp.serve(port, { client })` answers MCP requests on a message
port, and `createTunnelFetch` (`@ractive-ch/tab-mcp-client/tunnel`) is a `fetch` for the
other end. The port carries the relay's `http.*` messages
([protocol](https://github.com/ractive/tab-mcp/blob/main/docs/protocol.md#the-tunnel-without-a-relay))
as plain objects, so anything that passes them on in order will do. A usual setup: the
assistant's chat runs in an iframe on the page, and its backend, which already holds a
WebSocket to that chat, runs the MCP client.

The page, without `relay`:

```ts
import { TabMcp } from "@ractive-ch/tab-mcp-client";

const mcp = new TabMcp({ server: { name: "shop", version: "1.0.0" } });
await mcp.registerTool({ name: "add_to_cart", description: "…", execute: addToCart });

const chat = document.querySelector<HTMLIFrameElement>("#chat")!;
let served: { close(): void } | undefined;
addEventListener("message", async (event) => {
  // Only the chat's frame, on the chat's origin, gets a port.
  if (event.origin !== "https://chat.example" || event.source !== chat.contentWindow) return;
  if (event.data?.type !== "tools-wanted") return;
  const { port1, port2 } = new MessageChannel();
  served?.close(); // the chat asked again (it reloaded): the old port is dead
  served = await mcp.serve(port1, { client: { id: "assistant", name: "Example assistant" } });
  chat.contentWindow!.postMessage({ type: "tools-port" }, "https://chat.example", [port2]);
});
```

The chat in the iframe passes the messages on between the port and its WebSocket:

```ts
parent.postMessage({ type: "tools-wanted" }, "https://shop.example");
addEventListener("message", (event) => {
  if (event.origin !== "https://shop.example" || event.data?.type !== "tools-port") return;
  const [port] = event.ports;
  port.onmessage = (e) => socket.send(JSON.stringify({ tunnel: e.data }));
  socket.addEventListener("message", (e) => {
    const message = JSON.parse(e.data);
    if (message.tunnel) port.postMessage(message.tunnel);
  });
});
```

The backend (Bun, Node or anything with `fetch`'s `Request` and `Response`), here with
the MCP SDK's client:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createTunnelFetch } from "@ractive-ch/tab-mcp-client/tunnel";

const tunnel = createTunnelFetch({
  send: (message) => socket.send(JSON.stringify({ tunnel: message })),
});
socket.on("message", (data) => {
  const message = JSON.parse(String(data));
  if (message.tunnel) tunnel.receive(message.tunnel);
});
socket.on("close", () => tunnel.close());

// The page speaks MCP 2026-07-28 only: pin it, or the SDK starts with an older version.
const client = new Client(
  { name: "assistant", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
// The URL is never fetched; only its path reaches the page.
await client.connect(
  new StreamableHTTPClientTransport(new URL("https://tab.invalid/mcp"), { fetch: tunnel.fetch }),
);
const { tools } = await client.listTools();
```

- **A port is a key.** Whoever holds the other end calls the tools without pairing, and
  the library cannot check who that is. Hand a port only to a frame whose origin you
  checked, as above, and send it with that origin as the target, never `"*"`.
- Calls arrive with `client: { kind: "local", id, name }`, as given to `serve`. A `grant`
  in a message is ignored, so the other end cannot pass for an AI app of the relay.
- A consequential tool still asks. The library's dialog names the caller
  "Example assistant (this site's assistant)" and never offers "Always allow". A page
  that lets its own assistant run such tools without asking answers `onConfirm` itself
  for `request.client.kind === "local"`, and hands other calls to `mcp.confirmInPage`.
- `serve` resolves with `{ close() }`; `options.signal` does the same. Closing aborts the
  calls in flight and tells the other end (`bye`), whose requests then end at once with
  `-31003`. Close a serve whose port is dead, as above: its calls, listen streams and an
  open confirmation would stay otherwise. Where the port fires `close` when its other end
  goes away (Bun does; Chrome only with the `MessagePortCloseEvent` Blink feature), the
  serve closes itself then. `serve` may be called for several ports (each port once at a
  time), and next to a relay connection and `webmcp: true`: one registration reaches all
  three.
- A port has none of the relay's limits: no cap on requests in flight, listen streams,
  body size or rate. The other end is the site's own code (threat model A15). The
  confirmations of consequential calls are shown one at a time, however many arrive.
- `createTunnelFetch` answers a request that takes longer than `requestTimeoutMs`
  (300 s by default; a `subscriptions/listen` stream is not limited) with the JSON-RPC
  error `-31002`, and every request after `close()` with `-31003`, at HTTP 200 like the
  relay: the MCP client reads an error, not a network failure. Only an aborted `signal`
  rejects. Call `close()` when the channel to the page is gone; a closed tunnel stays
  closed, so a new channel (or a new `serve`) gets a new `createTunnelFetch`.
- Without `relay`, `connect()`, `showConnectDialog()` and `newAddress()` reject with a
  `TypeError`, nothing is read from or written to `localStorage`, `mcp.hasRelay` is
  `false`, and React's `ConnectButton` renders nothing.

### Consequential tools

Mark tools that change or delete something with `consequentialHint: true`. The page then
asks the user before every call ("Don't allow" or "Allow"), showing the AI app and the
arguments. A refusal reaches the AI app as an error result, and so does a call whose tool
was removed while the user was asked.

`alwaysAllow: true` adds "Always allow", which lets that tool run without asking for that
AI app until the page is reloaded or the app is disconnected. It is off by default: it
lifts the only brake at run time, which is what a prompt injection needs, and the relay
cannot help, since its one OAuth scope (`tools`) covers every tool of the page. Consent
per tool is the page's. Turn it on only for tools whose calls the user need not check one
by one.

Tools are called while the user is in the AI app, so the dialog often opens in a tab in
the background. "Allow" and "Always allow" can be clicked only once the page has been
visible and focused for `confirmDelayMs` (750 ms) with the dialog open; leaving the page
disables them and coming back starts the wait again, so the click that brings the page
forward cannot approve. One confirmation is shown at a time; the others wait, the shown
one says how many, and each starts its own wait when it is shown (and again when another
dialog of the page closes over it), so the second click of a double click cannot approve
the next call. A call cancelled while it waits is never shown. When the arguments do not
fit their box (`min(50vh, 24rem)`), the approving buttons also wait until the box has been
scrolled to its end, and the dialog says so: the AI app chooses the order of the keys, so
what matters may come last. Before the wait has run out, Enter or Space on a button and
Escape do nothing, so typing meant for the page cannot refuse a call the user has not
seen; a click on "Don't allow" works at once. Characters that are invisible, blank (such as U+00A0, U+3000 or
U+2800) or change the text direction (such as U+202E) are shown in the arguments and the
AI app's name as `\uXXXX`, so the AI app cannot make them look like something else; the
tool gets the arguments unchanged.

While a confirmation is open in a hidden tab, the tab's title starts with "Allow? – ", so
the user can find the tab that asks; the title is put back when the tab is shown or the
dialog closes (unless the page changed it meanwhile). In `tools/list`, the description of
a consequential tool ends with "The page may ask the user to allow
each call, usually in the page's browser tab.", so the AI app can tell the user where to look while it waits.

Pass `onConfirm` to ask in your own UI (it is asked every time; remember answers there if
you want to). Show the verified `client.host` next to the name the AI app declares, as the
library's dialog does, since anyone can declare any name. Escape the arguments and the
name as the dialog does with `escapeInvisible` from `@ractive-ch/tab-mcp-client/visible`
(an entry of its own, not in the core):

```ts
import { escapeInvisible } from "@ractive-ch/tab-mcp-client/visible";

const mcp = new TabMcp({
  relay: "https://relay.example",
  server: { name: "calculator", version: "1.0.0" },
  onConfirm: (request) => {
    const { tool, arguments: args, client, signal } = request;
    // An agent in the browser (`webmcp`) or the site's own assistant (`local`):
    // the library's own dialog.
    if (client.kind !== "relay") return mcp.confirmInPage(request);
    const name = client.name ? escapeInvisible(client.name) : undefined;
    const app = name ? `${name} (${client.host})` : client.host;
    const shown = escapeInvisible(JSON.stringify(args, null, 2));
    return myDialog.ask(`${app} wants to run ${tool.name}.`, shown, signal);
  },
});
```

`onConfirm` returns `true` (run), `false` (the user refused) or `"unanswered"`: the user was
asked and did not answer, e.g. your question timed out. The AI app then reads "The user was
asked and did not answer." instead of "The user declined", and `toolcallend` has the
outcome `unanswered`. Any other value, and a throw, is a refusal.

`mcp.confirmInPage(request)` is the library's own dialog, for an `onConfirm` that
handles only some calls itself.

### Connecting and pairing

1. The user clicks your button. `showConnectDialog()` connects (call it from the click
   handler: browsers that report user activation refuse `connect()` without one) and
   opens the "Connect your AI app" dialog. A script's `element.click()` has no user
   activation, so tests and browser automation see "connect() must be called from a
   user action"; a click through Playwright or the DevTools protocol has one, and
   `connect({ resume: true })` skips the check. When it cannot connect, the dialog says
   why in plain words ("Could not connect. Check your internet connection.", "Too many
   attempts…", "The connection was refused.", or "Not connected." when the click had no
   user activation) and offers "Connect again", which connects from its own click; the
   error itself goes to the console (`console.warn`). After a disconnect it says why
   ("The session ended." for `expired` and `idle`) and offers the same button. While the
   library reconnects by itself, it says "Connection lost. Reconnecting…", and "Connect
   again" tries at once.
2. The dialog shows the address with Copy and, right below it, "How do I add it?" (closed;
   open, its steps would push the code out of view): short instructions for Claude,
   ChatGPT, Claude Code and Codex. The commands for Claude Code and Codex each have a
   Copy. They name the
   server by a label made from `server.name` that every shell reads as one plain word:
   lower case, letters without marks, each run of other characters as `-`, at most 40
   characters, `tools` if nothing is left ("Bücher" gives `bucher`). The address goes
   into a command only if it has nothing but plain URL characters; otherwise the help
   shows the steps without commands. Each entry ends with the step that starts the
   sign-in: `/mcp` and Authenticate in Claude Code, `codex mcp login <name>` as the third
   line of Codex's command. Codex 0.163 needs its feature `mcp_2026_07_28` for the relay's MCP
   revision, so its command turns that on first (for all of Codex's MCP servers;
   `codex features disable mcp_2026_07_28` turns it off), and ChatGPT's entry names the
   same command for its Mac app. The user adds the address to their AI app.
3. The AI app opens the relay's sign-in page in the browser. The dialog shows a 6-digit
   code with a Copy button, which the user types or pastes there. The code changes every
   2 minutes and after each use.
4. Once the AI app connects, the dialog says so at the top: a check mark, "Claude
   (claude.ai) is connected" and what to do next (close it and ask the app to use the
   page's tools); screen readers hear the same. The setup (address, code, help) moves
   behind "Connect another app", closed, so the next code does not appear in view; the
   connected app is listed with a Disconnect button, and "Done" closes the dialog.
   Opened again while an app is connected, the dialog starts like this, with the focus
   on Done.

The relay makes a new code the moment one is entered, but the AI app connects only a
moment later. When the relay says the code was used (`reason: "used"` in the event
`pairingcode`), the dialog shows "Code used. Waiting for your AI app…" instead of the new
code, for up to 10 seconds; if no app connects by then, the new code appears. A code that
replaces an expired or locked one (too many wrong tries), or one from a relay that does not
say why, shows at once.

Until an app is connected, the dialog offers no prominent button under the code: only a small
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

"New address" in the dialog (at the end of the setup, below the code, with a line on what
it does; not next to Copy, since with no app connected it changes the address at once)
calls `newAddress()`, which disconnects every
app and makes a new address; when apps are connected, the dialog asks first. It first
takes the old address back: it connects with the stored secret, and the relay revokes
every grant of the address in
the same step (`hello.revokeAll`), whether the page was connected or not. Then it makes
the new secret, clears `grants`, and connects with it if the page was connected,
connecting or reconnecting (or taken over). A page that never had a secret makes one
without connecting. If the old address cannot be taken back (the relay is unreachable,
or someone takes it over again first), it rejects and keeps the old secret, so calling
it again tries again. A second call while it runs returns the same promise; `connect()`
meanwhile waits for it and then connects with the new address. The relay's
sign-in page points users to it when someone else may be guessing codes. A page with its
own UI calls `newAddress()` from a click. Connected apps keep working after a reload once the page connects
again; while the page is closed, they get "the page is not open".

When another tab or program connects with the same address, it takes the address over:
the page gets `disconnected` with reason `replaced` at once, then the event `replaced`,
and does not reconnect by itself. Tabs of the same page say on a `BroadcastChannel` (per
relay and storage key; it carries the address id, which is part of the address, never
the secret) when the relay accepted their session, so `replaced` says which it probably
was:

- `event.detail.sibling` is `true`: a tab of the same page in this browser said within
  the last 10 seconds that it claimed this tab's address, after this tab's own session
  started (a claim of another address, or one heard while this tab was still connecting,
  does not count; a claim without an address, from a tab still on 0.15 or older, does). That message usually comes just after the takeover, so the
  library waits up to a second for it, and `replaced` may come that much after
  `disconnected`. The usual cause, and harmless. Once the page has opened the default
  dialog, the library shows "Opened in another tab".
- `false`: none did (or the browser has no `BroadcastChannel`). It may be a program with
  a copy of the address secret, and the AI apps paired with the address now talk to it.
  The library shows "Another tab or program took over this page" with "New address".

After a takeover, `newAddress()` (from the `replaced` listener, before it, or later, also
after a reload) takes the address back as above and makes the new address only once the
relay confirmed that no grant is left. If the address is taken over again before that,
it rejects with an error whose `reason` is `"replaced"` and keeps the old secret, so
calling it again takes it back again. A relay of 0.4 or older cannot take an address
back: `newAddress()` rejects there with `reason` `"policy"`. When the takeover ended a
session of this page, it then connects with the new address; the default notice opens
the connect dialog to add it to the AI apps.

The default dialog closes when the page is replaced, and the notice appears also when the
dialog is closed, but only once the page has opened the dialog: a page that connects on
load with `connect({ resume: true })` and never opens it shows its own message. A page
with its own UI shows the same from `replaced`:

```ts
mcp.addEventListener("replaced", (e) => {
  if (e.detail.sibling) showNote("Opened in another tab.");
  else showWarning("Another tab or program took over this page's address.", {
    action: "New address",
    onClick: () => mcp.newAddress(), // from the click
  });
});
```

Script on the page's origin can post on the channel and make a takeover look like a
sibling; such script can read the secret anyway, so `sibling` is a hint, not a proof.

### Keeping the address safe

Whoever has the address secret can take over the page's address from anywhere, and the
AI apps paired with it then send their arguments to them and get their tool descriptions
and results, until the page gets a new address. They get no token and cannot pair a new
app without a code. Script on your origin (cross-site scripting, a compromised
third-party script, another page on the same origin) or access to the device can copy it
([threat model](https://github.com/ractive/tab-mcp/blob/main/docs/threat-model.md), A4).

- For a page with user accounts, use [identity binding](#identity-binding-no-code): a
  copied secret then gets nothing, since a session needs a fresh assertion from your
  backend.
- Run the page on its own origin, not a shared one such as `*.github.io`, and keep
  third-party scripts off it.
- On a page that pairs by code, grants follow the browser profile, not the person: on a
  shared profile, or in a web app with accounts that pairs by code, the next user of the
  page gets the AI apps the previous one paired. Call `newAddress()` when the user logs
  out, or use identity binding.
- The page origin that the relay's sign-in page shows is what the page's browser
  reported; a program can claim any origin. Do not tell users it proves which page they
  pair with.

When the connection breaks (reason `network`, `heartbeat` or `shutdown`: a dropped
network, a phone pausing the tab in the background, a relay restart; close codes 1001,
1011, 1012 and 1013 from a proxy in front of the relay count as `shutdown`), the library
connects again by itself: after about 5, 10, 20 and 40 seconds, then about every 60
seconds (each wait varies by up to 20 %, so that the tabs of a restarted relay do not all
come back at once), and at once when the tab comes back to the front or the network
returns. `reconnecting` (the
next attempt, its number and time) and the event `reconnecting` say so; `null` in the
event means it stopped, connected again or after `disconnect()`. Calling `connect()`
meanwhile tries at once. It never reconnects after `disconnect()`, a new address,
another tab taking over the address (`replaced`), an expired or idle session, or a
refusal by the relay, and an attempt the relay refuses stops it (an unreachable relay is
tried again); the event `error` then says why, just before `reconnecting` turns `null`,
also when a `connect()` of the page waits on that attempt and rejects with the same
error. `reconnect: false` turns it off, `reconnect: { delaysMs: [...] }`
sets the waits (the last one repeats).

### Keeping AI access on after a reload

The library does not connect on page load by itself, so after a reload the page is off
until the user clicks Connect again; its AI apps stay paired but cannot reach it. To keep
AI access on, remember the user's choice and connect on load:

```ts
const key = "my-page:ai-on";
// On once an AI app is paired: opening the dialog and closing it again does not count.
mcp.addEventListener("grantschange", () => {
  if (mcp.grants.length > 0) localStorage.setItem(key, "1");
});
// Turned off by the user (`disconnect()`): stay off after the next reload.
mcp.addEventListener("disconnected", (e) => {
  if (e.detail.reason === "user") localStorage.removeItem(key);
});
turnOffButton.onclick = () => mcp.disconnect();
// On load: connect without a click if the user turned it on before.
if (localStorage.getItem(key) === "1") {
  mcp.connect({ resume: true }).catch((error) => showNote(`AI access is off: ${error.message}`));
}
```

`resume: true` lets `connect()` run without a click. Offer a way to turn it off. With
two tabs of the page open, the newer one takes the address over: listen for `replaced`
(above) to tell the older tab why it went off.

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

The connect dialog follows `identity`: it shows the address and "When your AI app asks,
sign in with the account you use on this page" only once it is `bound`. Until then it
says what is missing: "Checking your sign-in…" (`pending`), "Sign in to this page first."
(`none`), or that the sign-in was not accepted, with `identityMessage` (`refused`).

### Your own UI

Instead of `showConnectDialog()`, use `connect()`, `disconnect()`, `newAddress()`,
`startPairing()` and `stopPairing()` (codes come only while pairing is on),
`revoke(grantId)`, the properties `state`, `address`, `pairingCode`, `grants`,
`reconnecting` and `tools`, and the events `statechange`, `connected`, `disconnected`,
`pairingcode`, `grantschange`, `reconnecting`, `toolschange`, `replaced` (with
`detail.sibling`, see above) and `error`. For an activity log, `toolcall`
and `toolcallend` report every call by an AI app (or, with `webmcp`, an agent in the
browser, or the assistant on a served port): its id, tool, arguments and caller as it starts, then its outcome (`ok`,
`error`, `declined`, `unanswered` or `cancelled`), result and duration.

```ts
mcp.addEventListener("toolcallend", (e) => {
  const { tool, client, outcome, durationMs } = e.detail;
  const who =
    client.kind === "relay"
      ? (client.name ?? client.host)
      : client.kind === "local"
        ? (client.name ?? client.id)
        : "An agent in this browser";
  log(`${who}: ${tool} ${outcome} in ${durationMs} ms`);
});
```

### Setup steps in your own UI

`@ractive-ch/tab-mcp-client/setup` has the steps the connect dialog shows under "How do I
add it?", as data for your own UI. An entry of its own, out of the core, and not in the CDN
build. `setupInstructions(serverName, address)` returns one entry per AI app (Claude,
ChatGPT, Claude Code, Codex, in that order): `id` (`claude`, `chatgpt`, `claude-code`,
`codex`), `app` (its name as shown), `text` (what to do), `command` (lines to run, for
Claude Code and Codex) and `note` (text and code parts, for ChatGPT, Claude Code and
Codex). Every string is plain
text: set it with `textContent`. The commands name the server by a label made from
`serverName` and contain the address only when every shell reads both as plain words (see
step 2 above), so they are safe to show with a Copy button; for an address that is not
plain, `command` is left out and `text` names the command instead. `SETUP_GUIDE` is the
guide with every step and what to do when it fails.

```ts
import { SETUP_GUIDE, setupInstructions } from "@ractive-ch/tab-mcp-client/setup";

const el = (tag: string, text: string) =>
  Object.assign(document.createElement(tag), { textContent: text });
// `session` is what `mcp.connect()` resolved to; "notes" is your `server.name`.
for (const { app, text, command, note } of setupInstructions("notes", session.address)) {
  const li = list.appendChild(document.createElement("li"));
  li.append(el("strong", app), ` ${text}`);
  if (command) li.append(el("pre", command)); // and a Copy button for it
  for (const part of note ?? []) li.append("code" in part ? el("code", part.code) : part.text);
}
guide.href = SETUP_GUIDE;
```

### Styling the default dialogs

The default dialogs bring their own stylesheet, a constructed stylesheet added to
`document.adoptedStyleSheets`, so a strict CSP needs no `style-src` exception. It uses
the page's font and system colours, and follows the page's `color-scheme`: declare
`color-scheme: light dark` (or `<meta name="color-scheme" content="light dark">`) and the
dialogs are dark in dark mode. They fit a 320 px wide screen (below 30rem the code's Copy goes under the code), and they open (and show the
check mark of a connected app) without animation when the user prefers reduced motion.
Their texts are English, so they carry `lang="en"` and `dir="ltr"` whatever the page's
language and direction.

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
| `--tab-mcp-success` | dark green, light green in dark mode | the check mark and the box of "… is connected" |
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
| `--tab-mcp-arguments-height` | `min(50vh, 24rem)` | the arguments scroll beyond this |

For more, write CSS for the class names. Each of the dialogs' rules has the specificity
of one class, so the page's rules for elements (`button { … }`, a reset's
`* { border-width: 0 }`) do not change them: every element in a dialog inherits the
dialog's colour, buttons reset `width`, `text-transform` and `letter-spacing`, and the
dialogs set `pointer-events: auto` (so they work while a modal layer of Radix or shadcn
sets `body { pointer-events: none }`). The rules for hover, focus and disabled, and
for the primary and danger buttons, have one class and two elements (0,1,2), so the page's
`button:hover`, `button:focus` or `button:disabled` (0,1,1) do not change those either. A
rule with two classes, such as `.tab-mcp-dialog .tab-mcp-primary` (0,2,0), wins over all
of them. A page rule of one element and one pseudo-class still changes a property that the
dialogs set only in their base rules (for example `button:hover { padding: 0 }`). Write
overrides outside cascade layers: the dialogs' rules are not in a layer, so they win over
any layered rule. All dialogs are `dialog.tab-mcp-dialog`; the connect dialog is
`.tab-mcp-connect` (with `.tab-mcp-status`, `.tab-mcp-address`, `.tab-mcp-code`,
`.tab-mcp-code-value`, `.tab-mcp-code-used`, `.tab-mcp-help`, `.tab-mcp-apps`,
`.tab-mcp-app`, `.tab-mcp-new-address-row` (New address and its line),
`.tab-mcp-new-address-question`, `.tab-mcp-actions`, the button `.tab-mcp-retry` (Connect
again, while not connected); once an app is
connected `.tab-mcp-success`, with `.tab-mcp-success-icon` (the check mark, an inline
`svg` in `currentColor`), `.tab-mcp-success-title` and `.tab-mcp-success-next`, and the
button `.tab-mcp-setup-toggle`, "Connect another app", with `aria-expanded`, which shows
and hides `.tab-mcp-setup`, the address, code and help), the confirmation is
`.tab-mcp-confirm` (with `.tab-mcp-description`, `.tab-mcp-arguments`,
`.tab-mcp-scroll-note`, `.tab-mcp-always-note`, `.tab-mcp-waiting`, and the buttons `.tab-mcp-deny`, `.tab-mcp-allow`,
`.tab-mcp-always`, with `alwaysAllow`), and the notice after `replaced` is
`.tab-mcp-replaced` (with `.tab-mcp-description`, `.tab-mcp-status`, and the buttons
`.tab-mcp-replaced-close` and `.tab-mcp-new-address`). Buttons are `.tab-mcp-primary` (the one
next step: Copy the address until an app is connected, then Done, Connect again while not connected, "Don't allow", the safe choice, and the notice's "New
address", or its "Close" after a sibling tab), `.tab-mcp-danger` (Disconnect and
"Disconnect and get new address") or plain; every Copy button is also `.tab-mcp-copy`, and
the Disconnect buttons in the apps list are `.tab-mcp-disconnect`. For example:

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
- `useTool(tool, deps?, options?)` registers the tool while the component is mounted and
  removes it on unmount. `execute` is always the latest closure, so it may use the
  component's current props and state without registering again; the tool is registered
  again only when its name, title, description, input schema or annotations change, or
  `options.webmcp` ([WebMCP](#webmcp); `webmcp` on the provider turns it on), or one of
  `deps`. StrictMode's double mount registers it once at a time. A duplicate name or an
  invalid tool is thrown from the component's render, for an error boundary. Tools that
  read state right after another tool changed it should read it from a store (as the
  example does) or a ref ([Tools in a `useState` app](#tools-in-a-usestate-app)), not
  from a render's props.
- `useToolCalls({ limit })` lists the AI app's tool calls since the component mounted,
  newest first (default 20), each with its `end` (outcome, result, duration) once over.
- `<ConnectButton>` calls `showConnectDialog()`, so it needs a real click (see
  [Connecting and pairing](#connecting-and-pairing)). Its label follows the state
  ("Connect your AI app", "Connecting…", "Reconnecting…", "AI app connected"), and
  "Connection lost, retrying…" once three reconnect attempts have failed; a click then
  tries again at once. `children` replaces the label: a node, or a function of the state
  from `useTabMcpState()`, such as
  `{(s) => (s.grants.length > 0 ? "Claude is playing" : "Let Claude play")}`. The usual
  button props style it, and `data-state` (`disconnected`, `connecting`, `connected`,
  `reconnecting`) is there for CSS. An `onClick` that calls `preventDefault()` keeps the
  dialog closed.

### Tools in a `useState` app

A tool that changes the page's state and returns the result needs the state as it is
after the change, but `setState` only schedules the next render. Keep the current value
in a ref next to the state, and change both through one function that the page's own UI
uses too:

```tsx
function Game() {
  const [game, setGame] = useState(newGame);
  const current = useRef(game);
  const update = (change: (g: GameState) => GameState) => {
    current.current = change(current.current);
    setGame(current.current);
    return current.current;
  };
  useTool<{ card: string }>({
    name: "play_card",
    description: "Play a card from the hand",
    inputSchema: { type: "object", properties: { card: { type: "string" } }, required: ["card"] },
    // play() throws for a move that is not allowed: the AI app gets the message.
    execute: ({ card }) => summary(update((g) => play(g, card))),
  });
  return <Board game={game} onPlay={(card) => update((g) => play(g, card))} />;
}
```

Two calls in a row then each see the other's change, before React renders. Wrap the
`setGame` in `flushSync` (from `react-dom`) only if the tool has to read the rendered DOM.
A store outside React (as in the todo example) works as well.

The module starts with `"use client"`, so React Server Components frameworks (Next.js's
app router) render the provider on the client; it never connects or touches storage on
the server. The CDN build does not include the React bindings: a page that loads tab-mcp
from a CDN uses the core API. [examples/react-todo](https://github.com/ractive/tab-mcp/tree/main/examples/react-todo)
is a complete todo app.

For end-to-end tests of a page's tools, `@ractive-ch/tab-mcp/testing` (the relay's
package) starts a relay in the test process and issues a token for the page's address
without pairing; see the relay's [README](https://github.com/ractive/tab-mcp/tree/main/packages/tab-mcp#testing-a-pages-tools).

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
