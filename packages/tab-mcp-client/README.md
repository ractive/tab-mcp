# @ractive-ch/tab-mcp-client

Offer a web page's functions as [MCP](https://modelcontextprotocol.io) tools to AI apps
(Claude, ChatGPT, Claude Code, Codex) through a
[tab-mcp](https://github.com/ractive/tab-mcp) relay. The page connects to the relay and
shows its app's address, which is the same for every page of the app. The user adds that
address to their AI app and types a pairing code from the page, which tells the relay
which page is meant; the AI app then calls the page's tools while the tab stays open. Nothing
is installed on the user's computer. With `webmcp: true` the library also registers the
tools with the browser's own [WebMCP](#webmcp), for agents in the browser. A site's own
assistant can call the same tools over a port, without a relay:
[Your own assistant on the page](#your-own-assistant-on-the-page). A browser extension
that is a tab-mcp page itself can fill in its pairing code on the relay's page for its
user: [For browser extensions](#for-browser-extensions).

How the library, the relay and the tab-mcp browser extension fit together, with a
picture:
[How the parts fit together](https://github.com/ractive/tab-mcp#how-the-parts-fit-together).

**Status: 0.20.0.** Until 1.0, a new minor version can still change the API. Which AI apps
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
  ractive/tab-mcp:0.13.1-rc.1
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
  import { TabMcp } from "https://cdn.jsdelivr.net/npm/@ractive-ch/tab-mcp-client@0.20.0/cdn/tab-mcp-client.min.js";
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

Importing the library loads only a small core; `connect()` loads the rest, and
`webmcp: true` loads the WebMCP mirror where the browser has WebMCP.

`server` is what the AI app sees: `name`, `version`, optional `title` and
`instructions`, and `icons`. Without `icons`, the page's own `<link rel="icon">` and
`<link rel="apple-touch-icon">` are sent, so an AI app that shows icons can show the
page's for its connector. `icons: [{ src, mimeType?, sizes?, theme? }]` (MCP's `Icon`)
sets them instead, `icons: []` sends none. At most 8: `https:` (or `http:`) URLs, or
PNG, JPEG, GIF, WebP or ICO `data:` URIs up to 16 KiB (no inline SVG). They go only in
`server/discover`. An icon on `localhost` reaches only an AI app on the same computer.

`app` is the app id: the `<app>` of the page's MCP address
`https://<relay>/s/<app>/mcp`, which every page of the app shares. It is 1 to 32
characters of `a-z`, `0-9` and `-`, not starting or ending with `-`; anything else is a
`TypeError`. Without `app`, the id is made from `server.name`: lower case, letters
without their marks, each run of other characters as one `-`, at most 32 characters
("My Notes" gives `my-notes`, "Bücher" gives `bucher`). A name that leaves nothing (no
letter a-z and no digit) is a `TypeError` when `relay` is set: set `app` then. A relay
may reserve an app id for certain origins (`sites[].apps` in its
[configuration](https://github.com/ractive/tab-mcp/blob/main/docs/configuration.md)); a
page of another origin that names it is refused (`connect()` rejects, reason `policy`).
`appName` is a name for people (at most 64 characters), shown in "the page is not open"
answers.

### Tools

`registerTool(tool, { signal, callers, exposedTo })` takes a tool in the shape of the
WebMCP draft's `registerTool` (`callers`: [which callers see a tool](#which-callers-see-a-tool);
`exposedTo`: see [WebMCP](#webmcp)):

- `name` (1-128 characters of `A-Z a-z 0-9 _ - .`), `title`, `description` (not empty);
- `inputSchema`: a JSON Schema with `"type": "object"`. Arguments are checked against it
  before `execute` runs. `registerTool` rejects a schema the validator cannot use (a
  pattern that is not a regular expression, a `$ref` that does not resolve; values of
  `default`, `examples`, `const` and `enum` are data and are not read as schema). The
  validator itself is loaded by `connect()`: from then on it checks each schema at
  registration too, and a tool registered earlier whose schema it refuses (for example a
  `$ref` next to a nested `$id`) is unregistered, with the reason in the event `error`;
- `outputSchema` (optional): a JSON Schema with `"type": "object"` for the result, listed
  to AI apps (`tools/list`) and passed on to WebMCP. `registerTool` checks it as it checks
  `inputSchema` (an AI app compiles it when it lists the tools, and one that does not
  compile can cost the whole list), but results are not checked against it. An AI app
  expects every result of such a tool to carry
  `structuredContent` that matches it (the MCP SDK's client refuses one without), so
  `execute` returns a plain object, not a string;
- `execute(input, { signal, client })`: runs the tool. `signal` aborts when the caller
  gives up (or a served call takes too long); the call ends then, also if `execute` does
  not stop, and what it returns later is dropped. `client` names the caller: `{ kind: "relay", grantId, id, host, name? }` for
  an AI app through the relay (`id`, verified `host`, declared `name`),
  `{ kind: "local", id, name? }` for the site's own assistant on a served port, with the
  `id` and `name` the page gave `serve` ([Your own assistant](#your-own-assistant-on-the-page)),
  or `{ kind: "webmcp" }` for an agent in the browser ([WebMCP](#webmcp)), of which nothing
  more is known (unless the tab-mcp browser extension vouched for the call: then
  `{ kind: "webmcp", via: "tab-mcp-extension", name, host }`, [with the
  extension](#with-the-tab-mcp-browser-extension)). Check `client.kind` before you read `host`. Return a
  string (one text block), an MCP result (passed through with its `_meta`: an object
  whose `content` is an array of MCP content blocks, each with `type` `text`, `image`,
  `audio`, `resource_link` or `resource` and the fields that type needs), or any other JSON value (sent as JSON text,
  and as `structuredContent` when that JSON is an object; a `Date` becomes a string, so
  it has none). Data that only looks like a result, such as a ProseMirror document with
  its `content` array, is sent as JSON. A thrown error becomes an error result with its
  message;
- `annotations`: the WebMCP hints `readOnlyHint`, `consequentialHint`,
  `untrustedContentHint` and `debugging` (a tool meant for the page's developers), and
  the MCP hints `destructiveHint`, `idempotentHint`, `openWorldHint`. A hint must be
  `true` or `false`: `registerTool` rejects any other value with a `TypeError`, since a
  `consequentialHint: "true"` that was dropped would run the tool without asking. MCP has
  no `untrustedContentHint`: every result of such a tool carries a marker in its `_meta`
  ([untrusted results](#untrusted-results)).

Where `registerTool` differs from the WebMCP draft's (of 12 November 2026), so that code
written for the native API behaves differently here:

- An invalid name, an empty description or an invalid schema is a `TypeError`; the
  draft rejects the first two with an `InvalidStateError`. A duplicate name is an
  `InvalidStateError` in both.
- `inputSchema` and `outputSchema` need `"type": "object"`, as MCP does; the draft takes
  any object. The library also checks `inputSchema`'s patterns and `$ref`s (above).
- The library checks the arguments against `inputSchema` before `execute` runs; the
  draft leaves that to the page.
- `execute` may return an MCP result; through WebMCP it goes out as its
  `structuredContent` or its text ([WebMCP](#webmcp)).
- `exposedTo` matters only for WebMCP: it is passed on to the native registration of a
  mirrored tool, and AI apps never see it.

An already aborted `signal` rejects with its reason and registers nothing, as in the
draft.

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
[origin trial](https://developer.chrome.com/blog/ai-webmcp-origin-trial) (Chrome 149 to
162; a site needs a trial token) and with `chrome://flags/#enable-webmcp-testing`
([Chrome's WebMCP docs](https://developer.chrome.com/docs/ai/webmcp)). Without either,
`webmcp: true` does nothing. Each `new TabMcp` looks for WebMCP when it is made, so a
trial token that a script adds later counts for a `TabMcp` made after it.

- Every tool goes there, tools marked `consequentialHint` or MCP's `destructiveHint`
  included, and they ask every WebMCP call (below). A WebMCP call asks by
  `consequentialHint ?? destructiveHint`, so a tool marked only `destructiveHint` asks
  there too, though it does not ask an AI app (its own client sees the hint). `callers` without
  `"webmcp"` keeps a tool out of WebMCP
  ([which callers see a tool](#which-callers-see-a-tool)). Until 0.20 such tools were
  left out unless `callers` listed `"webmcp"`; an agent that found no tool to delete with
  then clicked the page's own Delete buttons, with no question at all (DEC-209). An agent
  that drives the tab can click Allow in the page's dialog too, so a tool the page wants
  kept from agents in the browser leaves `"webmcp"` out of `callers`. A tool marked only
  `destructiveHint: true` is registered natively with `consequentialHint: true`, since
  WebMCP has no `destructiveHint` (DEC-022 maps the other way).
- The native registration gets the WebMCP fields: `name`, `title`, `description`,
  `inputSchema`, `outputSchema` and the WebMCP hints, and `exposedTo` from
  `registerTool`'s options (origins of other documents in the tab that may see the
  tool; the browser checks it, and an invalid list only warns, as below).
- A WebMCP call takes the same path as an AI app's: the arguments are checked against
  `inputSchema` (Chrome does not check them), a consequential tool asks (`onConfirm`, or
  the library's dialog, which names the caller "An agent in this browser"), and
  `toolcall` and `toolcallend` fire with `client: { kind: "webmcp" }`. "Always allow" is
  never offered or applied for these calls: there is no identity to remember it for.
- The call resolves with what `execute` returned, which the browser hands the agent as
  JSON text. An MCP result goes out as its `structuredContent` if it has one, else as
  its text blocks, one per line, each other block (an image, a resource) as a line that
  says it was left out: WebMCP results are text, and an image as base64 inside JSON
  costs the agent tokens for nothing. Nothing (`undefined`), which the browser cannot
  serialize, and an empty MCP result resolve as `"Done."`.
- A failure resolves too, as
  `{ error: "<message>" }`, so that the agent can read it: invalid arguments (the same
  message as for an AI app), "Don't allow" (`The user did not allow <tool> to run.`), a
  question not answered (`The user did not answer whether <tool> may run.`), a tool that
  is gone, an error thrown by `execute` (its message) and an MCP result with
  `isError: true` (its text). A rejection would not help: the draft hands the agent
  every rejection as an `OperationError` without its message, on purpose (a failure the
  agent should read belongs in the result), and Chrome 156 as `UnknownError`. Two cases still
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
  again (a browser that unregisters a tool some time after its abort would refuse a
  registration of the same name at once after it, as a duplicate; Chrome unregisters at
  once): a name the page or another script already registered
  natively keeps its owner, and a frame without `allow="tools"` refuses all. The other
  way round, once a name is mirrored, the page's own native `registerTool()` of that name
  fails: a page that registers tools natively itself leaves `webmcp` off or uses other
  names.
- The tab-mcp browser extension offers mirrored tools like any page tool, since it cannot know
  whether the AI app is also paired with the page, so an AI app connected to the page and
  to the extension sees such a tool twice. The page and the extension know of each
  other, though: see the next section.

#### With the tab-mcp browser extension

The [tab-mcp browser extension](https://github.com/ractive/tab-mcp/tree/main/packages/tab-mcp-extension)
calls a page's tools through WebMCP for AI apps connected to it, and asks the user
first about every tool that is not read-only. With `webmcp: true` the page and the
extension shake hands (DEC-207), so that a call is not asked twice and the page can say
that an AI app reaches it through the extension:

- **`extension`** (and the event `extensionchange`, `{ extension }`; in React the
  snapshot's `extension`): while the extension serves the page,
  `{ name, version, apps, whileInFront }`. `apps` are the AI apps connected to the
  extension now, each `{ name, host }` (the AI app's own name and the host the relay
  verified), empty while none is. `whileInFront` is `true`: the extension serves only the
  tab in front of its window, so say "while this tab is in front". `undefined` without
  the extension, while its AI access is off, and without WebMCP. The connect dialog says
  it first ("Claude (claude.ai) is connected through the tab-mcp browser extension,
  while this tab is in front.", `ui.strings.viaExtension…`) and keeps everything else:
  a phone or another browser still connects to the page directly.
- **A vouched call.** Right before the extension runs a tool the user allowed there
  (asked and allowed, or covered by its "Always allow" switch), it tells the page the
  tool, the exact arguments and the AI app. The next WebMCP call of that tool with equal
  arguments (key order aside) within 2 seconds runs without the page's question and
  without `onConfirm`: the user just allowed exactly that call. Its caller in
  `execute`, `toolcall` and `toolcallend` is
  `{ kind: "webmcp", via: "tab-mcp-extension", name, host }`, so an activity view can say
  "Claude (claude.ai) through the tab-mcp browser extension". A vouch is used once and
  only for the tool registered under its name when it came (a tool registered anew
  since asks). Everything else is as for any call: the arguments are checked, the
  events fire, a tool that is gone does not run. Once the extension's call ended or
  failed, the extension withdraws the vouch, and one still unused (the call never
  reached the page) is dropped. Any call that matches no vouch (an agent in the
  browser, a call after the 2 seconds) is asked as before.
- **`trustExtension: false`** keeps asking every WebMCP call, vouched or not, for a site
  that insists on its own question; `extension` is still reported.
- **What the page tells the extension:** the library's version, the app id and the AI
  apps connected to the page directly (`name`, `host`, as `grants` has them; at most
  64), again on
  each `grantschange`. The extension's panel uses it to say that the page has tab-mcp
  built in and when one AI app is connected both ways (it then sees the page's tools
  twice). The page also marks `<html data-tab-mcp-handshake>`, so that an extension
  that comes after the page loaded knows it may speak.
- **No proof.** Plain DOM events on `document` (`tab-mcp-page` from the page,
  `tab-mcp-extension` from the extension, a JSON string as `detail`; the protocol is in
  `src/handshake.ts`). Script in the page could fake the extension, but script in the
  page can already skip any question of the page: this is a convenience between two
  parts the user trusts, not a security boundary. Only the top frame takes part.
- Old and new mix: an extension that does not know the handshake says nothing, and the
  page asks as before; the extension says nothing to a page that did not announce the
  library.

A page that registers its WebMCP tools itself, without the library's mirror, can take
part the same way: answer the events as `src/handshake.ts` does, skip its own
question for a call that matches a vouch, and drop a vouch the extension withdraws.

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
  served = await mcp.serve(port1, {
    client: { id: "assistant", name: "Example assistant" },
    // Consequential tools ask in the chat, in the user's language (below).
    onConfirm: (request) => askInChat(request),
  });
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

The backend (Bun, Node or anything with `fetch`'s `Request` and `Response`) makes the
tunnel's end on its WebSocket:

```ts
import { createTunnelFetch } from "@ractive-ch/tab-mcp-client/tunnel";

const tunnel = createTunnelFetch({
  send: (message) => socket.send(JSON.stringify({ tunnel: message })),
});
socket.on("message", (data) => {
  const message = JSON.parse(String(data));
  if (message.tunnel) tunnel.receive(message.tunnel);
});
socket.on("close", () => tunnel.close());
```

#### The backend and an agent framework

An agent framework's own MCP client may not speak MCP 2026-07-28, the only version the
page speaks. Use the MCP SDK's client (`@modelcontextprotocol/client`), pinned to that
version, next to the framework, and hand the framework the page's tools as plain function
tools: most frameworks take a function tool as a name, a description, a JSON Schema and a
function. This recipe is tested in the repository
([`packages/tab-mcp-client/test/assistant-backend.ts`](https://github.com/ractive/tab-mcp/blob/main/packages/tab-mcp-client/test/assistant-backend.ts)):

```ts
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { TunnelFetch } from "@ractive-ch/tab-mcp-client/tunnel";

/** A function tool as agent frameworks take one: a name, a description, a JSON Schema and a function. */
export interface PageTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
}

const ANNOTATIONS = "ch.ractive.tab-mcp/annotations";

export async function pageTools(
  tunnel: TunnelFetch,
): Promise<{ tools: PageTool[]; close(): Promise<void> }> {
  // The page speaks MCP 2026-07-28 only: pin it, or the SDK starts with an older version.
  const client = new Client(
    { name: "assistant", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  // The URL is never fetched; only its path reaches the page.
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://tab.invalid/mcp"), {
      fetch: tunnel.fetch,
    }),
  );
  const { tools } = await client.listTools();
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      async run(args) {
        const result = await client.callTool({
          name: tool.name,
          arguments: args,
        });
        const text = result.content
          .map((block) =>
            block.type === "text" ? block.text : `[${block.type}]`,
          )
          .join("\n");
        if (result.isError === true) return `The tool failed: ${text}`;
        // Text from third parties (reviews, messages): say so to the model.
        const hints = result._meta?.[ANNOTATIONS] as
          | { untrustedContentHint?: boolean }
          | undefined;
        return hints?.untrustedContentHint === true
          ? `<untrusted-content>\n${text}\n</untrusted-content>`
          : text;
      },
    })),
    close: () => client.close(),
  };
}
```

`const { tools, close } = await pageTools(tunnel)` lists the tools once; give each to the
framework with `inputSchema` as its parameters and `run` as its function. List them again
for a new conversation, or when the page's tools change
(`notifications/tools/list_changed` on a `subscriptions/listen` stream).

**Page context.** The server's `instructions` reach the assistant once, when its client
connects (`server/discover`), and MCP has no notification for instructions that changed.
What changes with the page (the product shown, the cart, the user's selection) belongs in
a read-only tool such as `get_page_context` (`readOnlyHint: true`, perhaps
`callers: ["local"]`) that the model calls when it needs it.

#### Asking in your chat

A consequential tool asks before every call. For the calls through one port, `serve`'s
`onConfirm` asks instead of the page's `onConfirm` and the library's dialog; calls through
the relay and WebMCP keep those. That is the recommended way for a site's own assistant:
the question appears where the user talks to the assistant, in the user's language. It
answers as the page's `onConfirm` does: `true`, `false` or `"unanswered"`; anything else,
and a throw, is a refusal. `request.signal` aborts when the call is cancelled, takes longer
than `requestTimeoutMs` or the serve closes: take the question away then.

The answer has to come from the user's click, in UI that the assistant cannot answer for
it. The library does not send the question over the port, because the other end of the
port is the caller that wants the tool to run: a model that injected text told to say yes
would answer it. If the chat in the iframe shows the question, give it the question on a
channel of its own, and let only a click on its buttons answer, never a message from the
backend.

Do not answer `true` for `client.kind === "local"` to skip the question. Tool results carry
text the site did not write (reviews, messages, other users' posts) into the model, and
that text can tell the model to call a consequential tool. The question is the one check
between that text and the tool.

#### Which callers see a tool

`registerTool(tool, { callers })` lists the callers that see a tool: `"relay"` (AI apps
through the relay), `"local"` (a served port) and `"webmcp"` (agents in the browser),
by default all of them. A tool that asks asks each of them; whether a tool deletes
something is no reason to hide it from a caller. `callers` is for who may see it at all.
For a caller that is not listed the tool does not exist: `tools/list` leaves it out,
`notifications/tools/list_changed` does not fire for it, and a call gets the same error
as a call of an unknown tool. For example:

- `{ callers: ["local"] }`: data the site's own assistant may read under the site's
  terms, but that should not pass through the relay to an AI app the site has no
  contract with (a bank's `list_transactions`).
- `{ callers: ["relay"] }`: a tool that needs to know which AI app calls (a paired,
  named app; an audit line, "Always allow" remembered per app), which an anonymous
  WebMCP caller is not.
- `{ callers: ["relay", "webmcp"] }`: kept from the port, when the page serves it to a
  chat frame of another origin.

#### Untrusted results

A tool marked `untrustedContentHint` returns text the page did not write. MCP has no such
hint: in `tools/list` the tool has `annotations.openWorldHint: true` and the original hints
in `_meta["ch.ractive.tab-mcp/annotations"]` (for example
`{ "readOnlyHint": true, "untrustedContentHint": true }`). Every result of such a tool
carries `_meta["ch.ractive.tab-mcp/annotations"]: { "untrustedContentHint": true }` too,
through the relay and through a port, next to the tool's own `_meta`. A consumer reads the
marker on the result, so it needs no list at hand, and keeps such text apart from its
instructions, as the recipe does with a delimited block.

#### More about `serve`

- **A port is a key.** Whoever holds the other end calls the tools without pairing, and
  the library cannot check who that is. Hand a port only to a frame whose origin you
  checked, as above, and send it with that origin as the target, never `"*"`.
- Calls arrive with `client: { kind: "local", id, name }`, as given to `serve`. A `grant`
  in a message is ignored, so the other end cannot pass for an AI app of the relay.
- Without `serve`'s `onConfirm`, a consequential call through the port asks the page's
  `onConfirm` or the library's dialog, which names the caller "Example assistant (this
  site's assistant)" and never offers "Always allow".
- `requestTimeoutMs` (300 s by default, as `createTunnelFetch`; below 2^31 ms) limits each
  request on the page's side: on expiry the call is aborted (`execute`'s signal and the
  question's), `toolcallend` says `cancelled`, a later answer of the tool is dropped, and
  the other end gets the JSON-RPC error `-31002`, as from `createTunnelFetch`'s own limit.
  A `subscriptions/listen` stream is not limited.
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
- `createTunnelFetch` answers a request that takes longer than its `requestTimeoutMs`
  (300 s by default; a `subscriptions/listen` stream is not limited) with the JSON-RPC
  error `-31002`, and every request after `close()` with `-31003`, at HTTP 200 like the
  relay: the MCP client reads an error, not a network failure. Only an aborted `signal`
  rejects. Call `close()` when the channel to the page is gone; a closed tunnel stays
  closed, so a new channel (or a new `serve`) gets a new `createTunnelFetch`.
- Without `relay`, `connect()`, `showConnectDialog()` and `disconnectAll()` reject with a
  `TypeError`, nothing is read from or written to `localStorage`, `mcp.hasRelay` is
  `false`, and React's `ConnectButton` renders nothing.

### Consequential tools

Mark tools that change or delete something with `consequentialHint: true`. The page then
asks the user before every call ("Don't allow" or "Allow once"), showing the AI app and the
arguments. A refusal reaches the AI app as an error result, and so does a call whose tool
was removed while the user was asked.

`alwaysAllow: true` adds "Always allow", which lets that tool run without asking for that
AI app from then on; see [Tools that run without asking](#tools-that-run-without-asking).
It is off by default.

Tools are called while the user is in the AI app, so the dialog often opens in a tab in
the background. "Allow once" and "Always allow" can be clicked only once the page has
been visible and focused for 750 ms with the dialog open; leaving the page
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
Not when an `onConfirm` answers (the page's, or for a served port its own): it may ask
anywhere, such as a side panel or the site's chat. Say where in the tool's own
description if the AI app should know.

Pass `onConfirm` to ask in your own UI (it is asked for every call the user has not
allowed, see [Tools that run without asking](#tools-that-run-without-asking)). Show the verified `client.host` next to the name the AI app declares, as the
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
    // An agent in the browser (`webmcp`), or the site's own assistant (`local`) on a
    // port served without its own onConfirm: the library's own dialog.
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
asked and did not answer." instead of "The user did not allow this call.", and `toolcallend` has the
outcome `unanswered`. Any other value, and a throw, is a refusal.

`mcp.confirmInPage(request, { document })` is the library's own dialog, for an
`onConfirm` that handles only some calls itself (`document` defaults to the global one).
A call the user allowed for its AI app resolves `true` without the dialog.

An app that shows the dialog for an MCP endpoint of its own, without a `TabMcp` (a
desktop app, say), can load the built confirmation chunk (`confirm-<hash>.js`; its name
changes with each build) and call its `confirmInPage(host, request, document, options)`.
`host` is a stand-in with `grants` (the AI apps it allows for, `{ grantId }`), optionally
an `EventTarget` that sends `grantschange` when they change (any event: the allowances
are pruned against `grants` as they are then). A call counts as allowed only while its
grant is in `grants`, also without an event. `options` are
`alwaysAllow` (`true` or `"until-reload"` offers "Allow until reload" for that call;
without it nothing is allowed or kept), `ui` (the dialog's texts) and `allowDelayMs`
(tests only). Such allowances live in memory, for the host's grants, until a reload; only
a client with `kind: "relay"` can be allowed.

### Tools that run without asking

The user can let a consequential tool run without asking, for one connected AI app: one
tool at a time ("Always allow" this tool), or everything ("Always allow everything"). An allowed call runs at once, with the library's dialog and with your own
`onConfirm` alike: neither is asked. Only AI apps through the relay can be allowed; an
agent in the browser (WebMCP) and a served port have no grant to remember it for and are
always asked.

The option `alwaysAllow` decides what the library's dialogs offer:

| `alwaysAllow`    | The confirmation offers    | The connect dialog shows              | Kept                                         |
| ---------------- | -------------------------- | ------------------------------------- | -------------------------------------------- |
| unset or `false` | Don't allow, Allow once    | nothing (unless something is allowed) | in `storage`, for your own switches          |
| `true`           | … and "Always allow"       | the switches under each app           | in `storage`, until the app is disconnected  |
| `"until-reload"` | … and "Allow until reload" | the switches under each app           | in memory, until the page is reloaded        |

With `true` and `storage: null`, nothing outlives the page either, and the button says
"Allow until reload". The confirmation never offers "allow everything": that is a
deliberate act in the connect dialog, not an answer to one question. In the connect
dialog, each connected AI app gets a switch per tool that asks (its title or name;
destructive ones marked) and "Always allow everything", with a sentence on what it means
and how long it lasts, under the confirmation's own label ("Always allow", or "Allow until
reload" when nothing outlives the page), so the button and the switches it turns on read
alike. The switches are checkboxes with `role="switch"` whose accessible names
name the app. A tool that is allowed but not registered right now (a page may offer some
tools only on some views) is listed by its name, as a switch that can only be turned
off. When the page does not offer allowing (`alwaysAllow` unset) but something is
allowed for an app (by your own switches), the connect dialog shows only that, as
switches that can only be turned off ("everything" only while it is on): the user can
see and end what runs without asking where they disconnect apps, and is never offered
more than the page chose to offer.

**What counts.** An allowed tool runs without asking as long as its title and
description are the ones the user allowed: a tool registered with another one is asked
again and leaves the list. A tool that is not registered for a while keeps its allowance
(a reload registers every tool again; a page may offer some only on some views).
"Everything" covers every tool, also ones registered later, changed ones and destructive
ones: that is why it is a switch of its own.

**Where it is kept, and when it ends.** In the page's `storage` (by default
`localStorage`), under the address secret's key with `#allowed` appended: the grant ids,
the tool names and the title and description the user saw, and a fingerprint of the
secret; no arguments, no results. An allowance ends with its grant, as the relay reports
it: the app is disconnected (in the page or elsewhere), "Disconnect all apps"
(`disconnectAll()`), the grant expired, the user signed out (identity binding). A dropped
connection, a reload or a page that has not connected yet keeps them. Tabs that share the
address share them, and a change in one counts in the others at once.

**Your own switches.** `@ractive-ch/tab-mcp-client/allowed` (an entry of its own, not in
the core) has the same allowances for a UI of your own, also with `alwaysAllow` unset:

```ts
import { allowedTools } from "@ractive-ch/tab-mcp-client/allowed";

const allowed = allowedTools(mcp); // one object per TabMcp
function drawSwitches() {
  list.replaceChildren(
    ...mcp.grants.flatMap((grant) => [
      ...allowed.tools().map((tool) =>
        mySwitch(`${tool.title ?? tool.name}${tool.destructive ? " (destructive)" : ""}`,
          allowed.has(grant.grantId, tool.name),
          (on) => on ? allowed.allow(grant.grantId, tool.name) : allowed.ask(grant.grantId, tool.name)),
      ),
      mySwitch("Always allow everything",
        allowed.everything(grant.grantId),
        (on) => allowed.setEverything(grant.grantId, on)),
    ]),
  );
}
allowed.onChange(drawSwitches); // allowances and tools
mcp.addEventListener("grantschange", drawSwitches);
```

- `tools()`: the tools that ask (`consequentialHint`, callable through the relay), each
  `{ name, title?, description, destructive }`.
- `has(grantId, name)`: whether a call runs without asking now (only for an app in
  `mcp.grants`). `list(grantId)`: the
  names allowed one by one (one registered now with another title or description is
  not in it). `everything(grantId)`. These only read, so they are safe while drawing.
- `allow(grantId, name)` (as the tool is registered now), `ask(grantId, name)`,
  `setEverything(grantId, on)`, `forget(grantId)` (everything of that app asks again).
  Allowing does nothing for an app that is not in `mcp.grants`. `ask` while
  "everything" is on turns "everything" off for that app too, and leaves the other
  tools allowed one by one as they are: asking again errs towards asking.
- `onChange(listener)` returns what stops it. `kept` says whether they outlive a reload.
  The methods are bound: `const { allow, ask } = allowedTools(mcp)` works.
- In React, `useAllowedTools(grantId)` of `@ractive-ch/tab-mcp-client/react` returns
  `{ tools (each with allowed), everything, allowedTools }` and renders again on a change.
- Without a bundler, `cdn/allowed.min.js` sits beside the CDN build's
  `tab-mcp-client.min.js` and shares its chunks (one store with the dialogs); a page
  that does not import it loads nothing of it. Take both from the same version:

  ```js
  import { TabMcp } from "https://cdn.jsdelivr.net/npm/@ractive-ch/tab-mcp-client@0.20.0/cdn/tab-mcp-client.min.js";
  import { allowedTools } from "https://cdn.jsdelivr.net/npm/@ractive-ch/tab-mcp-client@0.20.0/cdn/allowed.min.js";
  ```

**The risk.** An allowance outlives the user's attention: for up to the grant's 90 days,
calls run that nobody looks at. An AI app can be steered by text it reads (a web page, a
mail, a document), and an allowed tool is then the one that runs on its say. Offer it
for tools one would not want to check each time, whose worst call is cheap to undo; not
for tools that pay, send, delete or publish. "Everything" also covers tools the user has
not seen, and ones the page adds later. The relay cannot help: its one OAuth scope
(`tools`) covers every tool of the page, so consent per tool is the page's.

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
   revision, so its command turns that on first. The steps are the minimum; the link at
   the end of the help leads to the guide with the rest (ChatGPT's Mac app, turning the
   Codex feature off, what to do when it fails). A page can link its own guide and give
   its own steps (`ui.setup`, see [Help in the connect dialog](#help-in-the-connect-dialog)).
   The user adds the address to their AI app. It is the app's address
   (`https://<relay>/s/<app>/mcp`), the same in every user's dialog.
3. The AI app opens the relay's sign-in page in the browser. The dialog shows a code of
   8 letters (`XXXX-XXXX`) with a Copy button, which the user types or pastes there, in
   any case, with or without the dash. The relay finds the page by it. The code changes
   every 2 minutes and after each use.
4. Once the AI app connects, the dialog says so at the top: a check mark, "Claude
   (claude.ai) is connected" (every connected app is named) and what to do next (close it and ask the app to use the
   page's tools); screen readers hear the same. The setup (address, code, help) moves
   behind "Connect another AI app", closed, so the next code does not appear in view; the
   connected app is listed with a Disconnect button (and, with `alwaysAllow`, the
   switches for what it may run without asking), and "Done" closes the dialog. A Disconnect the relay could
   not save says so in the list ("The relay could not save this. Try again.").
   Opened again while an app is connected, the dialog starts like this, with the focus
   on Done.

The relay makes a new code the moment one is entered, but the AI app connects only a
moment later. When the relay says the code was used (`reason: "used"` in the event
`pairingcode`), the dialog shows "Code used. Waiting for your AI app…" instead of the new
code, for up to 10 seconds; if no app connects by then, the new code appears. A code that
replaces an expired one, or one that comes without a reason, shows at once.

Until an app is connected, the dialog offers no prominent button under the code: only a small
"Close" at the bottom (and Escape). Closing it ends the code (`stopPairing()`); the page
stays connected and the address stays the same, so calling `showConnectDialog()` again
shows the same address with a new code. While the dialog is open, calling it again (a
double click) opens no second one; the call resolves when that one closes. A call for another
`document` (an iframe's, say) while it is open rejects with an `InvalidStateError`.

The address is the app's: it is the same for every visitor and every visit. What tells
one user's page from another's is the address secret: the library keeps one per relay
and page in `localStorage`, under `tab-mcp:secret:<relay origin>:<server.name>` (set
`storageKey` to choose the key yourself; the name is URI-encoded). The relay keys the
page's session and the AI apps paired with it by a hash of the app id and that secret
(the address id), which is in no URL. A paired AI app therefore reaches the page again
after a reload and on later visits. A browser without the secret (another profile,
cleared storage, a renamed `server.name` without `storageKey`) is a page nobody has
paired with yet, and so is the same secret under another app id: changing `app`, or a
`server.name` that `app` is made from, means every AI app pairs again. Two pages of one
site with different server names keep different secrets; their addresses differ when
their app ids do. The key of 0.4 and older, `tab-mcp:secret:<relay origin>`, is not
read: a visitor whose last visit predates 0.5 pairs their AI apps again.

"Disconnect all apps" in the dialog (at the end of the setup, below the code, with a
line on what it does) calls `disconnectAll()`, which disconnects every app and makes a new
secret; when apps are connected, the dialog asks first. The address the user sees does
not change, and each AI app connects again at the same address with a new code. It first takes the
page back: it connects with the stored secret, and the relay revokes every grant made
for it in the same step (`hello.revokeAll`), whether the page was connected or not.
Then it makes the new secret, clears `grants`, and connects with it if the page was
connected, connecting or reconnecting (or taken over). A page that never had a secret
makes one without connecting. If the page cannot be taken back (the relay is
unreachable, or someone takes it over again first), it rejects and keeps the old secret,
so calling it again tries again. A second call while it runs returns the same promise;
`connect()` meanwhile waits for it and then connects with the new secret. A page with
its own UI calls `disconnectAll()` from a click. Connected apps keep working after a reload once the page connects
again; while the page is closed, they get "the page is not open".

When another tab or program connects with the same secret, it takes the page's place:
the page gets `statechange` to `disconnected` with reason `replaced` at once, then the
event `replaced`,
and does not reconnect by itself. Tabs of the same page say on a `BroadcastChannel` (per
relay and storage key; it carries a hash of the secret, never the secret) when the relay
accepted their session, so `replaced` says which it probably was:

- `event.detail.sibling` is `true`: a tab of the same page in this browser said within
  the last 10 seconds that it connected with this tab's secret, after this tab's own
  session started (a claim with another secret's hash, or one heard while this tab was
  still connecting, does not count; a claim without a hash, from a tab still on
  0.15 or older, does). That message usually comes just after the takeover, so the
  library waits up to a second for it, and `replaced` may come that much after
  the `statechange`. The usual cause, and harmless. Once the page has opened the default
  dialog, the library shows "Opened in another tab".
- `false`: none did (or the browser has no `BroadcastChannel`). It may be a program with
  a copy of the address secret, and the AI apps paired with the page now use it.
  The library shows "Another tab or program took over this page" with "Disconnect all
  apps".

After a takeover, `disconnectAll()` (from the `replaced` listener, before it, or later, also
after a reload) takes the page back as above and makes the new secret only once the
relay confirmed that no grant is left. If the page is taken over again before that,
it rejects with an error whose `reason` is `"replaced"` and keeps the old secret, so
calling it again takes it back again. A relay of 0.4 or older cannot take a page
back: `disconnectAll()` rejects there with `reason` `"policy"`. When the takeover ended a
session of this page, it then connects with the new secret; the default notice opens
the connect dialog, where the user pairs the AI apps again.

The default dialog closes when the page is replaced, and the notice appears also when the
dialog is closed, but only once the page has opened the dialog: a page that connects on
load with `connect({ resume: true })` and never opens it shows its own message. A page
with its own UI shows the same from `replaced`:

```ts
mcp.addEventListener("replaced", (e) => {
  if (e.detail.sibling) showNote("Opened in another tab.");
  else showWarning("Another tab or program took over this page.", {
    action: "Disconnect all apps",
    onClick: () => mcp.disconnectAll(), // from the click
  });
});
```

Script on the page's origin can post on the channel and make a takeover look like a
sibling; such script can read the secret anyway, so `sibling` is a hint, not a proof.

### Keeping the address secret safe

Whoever has the address secret can take the page's place from anywhere, and the AI apps
paired with the page then send their arguments to them and get their tool descriptions
and results, until the page makes a new secret (`disconnectAll()`). They get no token and
cannot pair a new app without a code. Script on your origin (cross-site scripting, a compromised
third-party script, another page on the same origin) or access to the device can copy it
([threat model](https://github.com/ractive/tab-mcp/blob/main/docs/threat-model.md), A4).

- For a page with user accounts, use [identity binding](#identity-binding-no-code): a
  copied secret then gets nothing, since a session needs a fresh assertion from your
  backend.
- Run the page on its own origin, not a shared one such as `*.github.io`, and keep
  third-party scripts off it.
- On a page that pairs by code, grants follow the browser profile, not the person: on a
  shared profile, or in a web app with accounts that pairs by code, the next user of the
  page gets the AI apps the previous one paired. Call `disconnectAll()` when the user logs
  out, or use identity binding.
- The relay's sign-in page names the AI app and the app id of the address, not the page
  or its origin: the code alone says which page is paired. Whoever types a user's code
  on that page connects their own AI app to the user's page, so tell users never to
  pass their code on. With identity binding there is no code to pass on.

When the connection breaks (reason `network`, `heartbeat` or `shutdown`: a dropped
network, a phone pausing the tab in the background, a relay restart; close codes 1001,
1011, 1012 and 1013 from a proxy in front of the relay count as `shutdown`), the library
connects again by itself: after about 5, 10, 20 and 40 seconds, then about every 60
seconds (each wait varies by up to 20 %, so that the tabs of a restarted relay do not all
come back at once), and at once when the tab comes back to the front or the network
returns. Meanwhile `state` is `reconnecting` (while it waits and while it makes an
attempt), `reconnecting` says which attempt is next and when, and `statechange` fires
for each attempt it schedules; only the `statechange` that leaves `connected` carries the
`reason` ([Your own UI](#your-own-ui)). Calling `connect()` meanwhile tries at once. It never reconnects after `disconnect()`, `disconnectAll()`,
another tab taking the page's place (`replaced`), an expired or idle session, or a
refusal by the relay, and an attempt the relay refuses stops it (an unreachable relay is
tried again); the event `error` then says why, with `state` already `disconnected`, just
before the `statechange` to `disconnected`, also when a `connect()` of the page waits on
that attempt and rejects with the same error. `reconnect: false` turns it off; the waits
are fixed.

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
mcp.addEventListener("statechange", (e) => {
  if (e.detail.reason === "user") localStorage.removeItem(key);
});
turnOffButton.onclick = () => mcp.disconnect();
// On load: connect without a click if the user turned it on before.
if (localStorage.getItem(key) === "1") {
  mcp.connect({ resume: true }).catch((error) => showNote(`AI access is off: ${error.message}`));
}
```

`resume: true` lets `connect()` run without a click. Offer a way to turn it off. With
two tabs of the page open, the newer one takes the older one's place: listen for `replaced`
(above) to tell the older tab why it went off.

### Identity binding (no code)

On a relay that pairs by `oidc` ([identity binding](https://github.com/ractive/tab-mcp/blob/main/docs/configuration.md#identity-binding)),
the user signs in to the AI app's connection with the account they use on your page,
and no code is shown. The relay pairs the AI app with the app's page whose user is that
person and whose "Connect your AI app" dialog is open. Your backend proves who is signed
in: give the library a function that fetches a short-lived tab assertion for the page's
address. The address is the app's, so the assertion's `aud` names the app, not one page.

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
logoutButton.onclick = () => {
  mcp.signOut().catch(() => {}); // settles once the relay removed the grants
  // then your own logout
};
// After a sign-in without a reload: "bound", "refused" or "none".
const identity = await mcp.refreshIdentity();
```

The library asks the function after every connect. `identity` (`none`, `pending`,
`bound`, `refused`, with the reason in `identityMessage`) and the event
`identitychange` tell you whether the relay accepted it; when the function or the relay does not answer within 15 s (counted from when the function is asked), it goes back to `none`. `signOut()` and `refreshIdentity()` reject with an `InvalidStateError` while the page is not connected (`signOut()` also on a relay that pairs by code); `identity` is cleared either way. An AI app signed in as someone else gets "This AI app is signed in as someone other
than the page's user."

The connect dialog follows `identity`: it shows the address and "When your AI app asks,
sign in with the account you use on this page" only once it is `bound`. Until then it
says what is missing: "Checking your sign-in…" (`pending`), "Sign in to this page first."
(`none`), or that the sign-in was not accepted, with `identityMessage` (`refused`).

An open dialog counts for 10 minutes (relays after 0.13.1-rc.1): a sign-in pairs the page
only until 10 minutes after the last `startPairing()`, which the dialog calls when it
opens. The relay says for how long (`pairing.open`); the library counts that on the
page's own clock from the message's arrival and keeps the end in `pairingUntil` (an ISO
time, event `pairinguntil`), so a page whose clock differs from the relay's still shows
the right moment. `pairingUntil` is `undefined` while pairing is off, from each
`startPairing()` until the relay answers, after the session ended (`disconnect()`,
`disconnectAll()`, a refusal), and with a relay up to 0.13.1-rc.1. The dialog shows "Your AI
app can connect until 14:32." under the sign-in line and, once that time is up (also
checked when the tab comes back to the front), "The time to connect your AI app is up"
with Continue, which calls `startPairing()` again. Nothing starts the 10 minutes again
by itself: not a timer, and not a reconnect the library makes by itself once the start
was sent, answered or not (after one, `pairingUntil` is the time of the reconnect, so
the dialog shows Continue). `connect()` from a click while reconnecting ("Connect again")
does ask again; codes always come again after a reconnect. A custom UI does the same:
call `startPairing()` only from the user's click. With a relay up to 0.13.1-rc.1 an open dialog
counts as long as it is open, and after a reconnect the dialog shows Continue too. A
sign-in that comes back after the time is up gets the relay's answer that no page is
connecting with that account; Continue, then Connect again on the relay's page, pairs it.

### Your own UI

Instead of `showConnectDialog()`, use the methods, properties and events below.

| Methods | |
|---|---|
| `connect(options?)` | resolves with the session (`SessionInfo`) |
| `disconnect()` | ends the session at once |
| `disconnectAll()` | disconnects every app ("Disconnect all apps"); resolves once the new secret is in use (connected again if it was on) |
| `startPairing()`, `stopPairing()` | codes come only while pairing is on; with identity binding each `startPairing()` starts the 10 minutes anew |
| `revoke(grantId)` | resolves once the relay removed the grant |
| `signOut()` | resolves once the relay removed the grants (identity binding) |
| `refreshIdentity()` | resolves with the new `identity`; a `TypeError` without `identityAssertion` |

A method that asks the relay rejects with an `InvalidStateError` while the page is not
connected: nothing was sent. `revoke()` and `signOut()` reject with a `NetworkError` when
the session ends after the message was sent and before the relay answered, and with a
`TimeoutError` when the relay has not answered within 15 s: in both cases the relay may
or may not have done it, and `grants` says so once the page is connected again. They
also reject with the relay's refusal of that message, an `Error` whose `code` is
`store_unavailable` (the relay could not save the change: try again) or `unknown_id`.
A relay after 0.13.1-rc.1 names the message it answers (`for`, and `grantId` for a
revocation), so with several revocations pending only the one it answers rejects; an
older relay's refusal rejects every pending `revoke()` and `signOut()`. When the relay
does not know a grant the page lists (it expired), the grant leaves `grants` (with
`grantschange`) and its `revoke()` resolves.

With a relay, `disconnectAll()` rejects with an error whose `secretChanged` says what happened: `false`
when the page could not be taken back (the old secret is kept with its grants; call
`disconnectAll()` again), `true` when the secret changed, so every app is disconnected, and
only connecting with the new one failed (call `connect()`).

The properties are `state` (`disconnected`, `connecting`, `connected`, `reconnecting`),
`session` (while connected; `session.address` is the MCP address, `session.appName` the
name the relay shows), `reconnecting` (the next attempt, while `state` is
`reconnecting`), `pairingCode`, `pairingUntil` (identity binding, see there), `grants`,
`identity`, `identityMessage`, `tools`, `extension` ([with the tab-mcp browser
extension](#with-the-tab-mcp-browser-extension)) and
`hasRelay`.

Every event's `detail` is an object. A change event names the new values like the
properties (`grantschange` has `grants`), and a value that is gone is `undefined`:

| Event | `detail` |
|---|---|
| `statechange` | `{ state, reason? }`, see below |
| `grantschange` | `{ grants }` |
| `pairingcode` | `{ pairingCode }` |
| `pairinguntil` | `{ pairingUntil }` |
| `identitychange` | `{ identity, identityMessage }` |
| `toolschange` | `{ tools }` |
| `extensionchange` | `{ extension }` |
| `replaced` | `{ sibling }` (see above) |
| `error` | `{ error }` |
| `toolcall`, `toolcallend` | the call, see below |

`statechange`'s `reason` (a `DisconnectReason`) says why a session or an attempt to
open one ended, once: on the change from `connected` (to `disconnected`, or to
`reconnecting` when the connection broke), and when `disconnect()` or `disconnectAll()`
ends connecting or reconnecting. It is absent on every other change: `connecting`,
`connected`, each later reconnect attempt (`statechange` fires for each, and
`reconnecting.reason` keeps the reason of the break), a failed `connect()`, and the
`disconnected` after a refusal stopped reconnecting (the `error` just before says why).

For an activity log, `toolcall`
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
build. `setupInstructions(serverName, address, strings?)` returns one entry per AI app (Claude,
ChatGPT, Claude Code, Codex, in that order): `id` (`claude`, `chatgpt`, `claude-code`,
`codex`), `app` (its name as shown), `text` (what to do), `command` (lines to run, for
Claude Code and Codex) and `note` (text and code parts, for Claude Code and Codex). Every string is plain
text: set it with `textContent`. The commands name the server by a label made from
`serverName` and contain the address only when every shell reads both as plain words (see
step 2 above), so they are safe to show with a Copy button; for an address that is not
plain, `command` is left out and `text` names the command instead. `strings` is your
table of texts ([Translating](#translating)); the steps are English without it.
`SETUP_GUIDE` is the guide with every step and what to do when it fails.

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

### Translating

The package ships English only. Every text the library shows a person is in one table,
[`src/strings.ts`](src/strings.ts): the connect dialog and its setup steps, the question
before a tool runs, the switches of the tools that run without asking, the line about AI
apps connected through the tab-mcp browser extension, the replaced notice and the label of
the React `ConnectButton`. Give your own table once, as `ui.strings` of `TabMcp` (or of
`<TabMcpProvider>`), and every part reads it; a key you leave out stays English. With
your tables loaded only for the users who need them, it takes three lines:

```ts
import { pickStrings } from "@ractive-ch/tab-mcp-client/strings";
const strings = await pickStrings({ de: () => import("./tab-mcp.de.ts"), fr: () => import("./tab-mcp.fr.ts") });
const mcp = new TabMcp({ relay: "https://relay.example", server: { name: "notizen", version: "1.0.0" }, ui: { strings } });
```

`pickStrings(tables, languages = navigator.languages)` goes through the user's languages
in order and loads the first table that matches: the same tag, else a table of the same
language, preferring the same script (`zh-TW` takes `zh-Hant` over `zh-Hans` or `zh`),
then the same region, then the language alone (`de-CH` takes `de` over `de-AT`; `pt-PT`
takes `pt` over `pt-BR`, or `pt-BR` if it is the only one), then the first by name.
English is built in: a user who prefers English before any of your languages, or none of
them, gets `undefined`, which keeps the English texts. The table comes with `lang` set to
the tag it was found by unless it has its own. It never rejects: a table that does not
load (a chunk gone after a deploy, offline) or is not an object is said in the console
and gives `undefined`, so the page starts in English. A table with a few keys:

```ts
// tab-mcp.de.ts
import type { DialogStrings } from "@ractive-ch/tab-mcp-client";

export default {
  lang: "de",
  connectTitle: "KI-App verbinden",
  confirmTitle: "{tool} erlauben?",
  confirmWho: "{client} möchte {tool} ausführen.",
  deny: "Nicht erlauben",
  allow: "Einmal erlauben",
  alwaysAllow: "Immer erlauben",
  waiting: {
    one: "{n} weiterer Aufruf wartet nach diesem.",
    other: "{n} weitere Aufrufe warten nach diesem.",
  },
  connected: { one: "{apps} ist verbunden", other: "{apps} sind verbunden" },
  buttonConnected: { one: "KI-App verbunden", other: "{n} KI-Apps verbunden" },
} satisfies Partial<DialogStrings>;
```

- **Placeholders.** `{name}` is filled in: names of tools and AI apps (isolated, so that
  they cannot reorder your sentence), the code, a time, a count. Put them where your
  language needs them.
- **Plural forms.** A text that depends on a count is an object with one form per plural
  category of your language, as `Intl.PluralRules` names them (`zero`, `one`, `two`,
  `few`, `many`, `other`): English needs `one` and `other`, Polish `one`, `few`, `many`
  and `other`, Japanese only `other`. `other` is required and stands in for a category
  you leave out. `{n}` is the count; in a text with `{apps}` the count is the number of
  AI apps named.
- **Lists.** Names are joined by `Intl.ListFormat` in your language ("A, B und C"):
  there is nothing to translate.
- **Language and direction.** `lang` (a BCP 47 tag) is what plural forms and lists follow,
  and every dialog carries it, so a screen reader reads it with the right voice. Always
  give it: a table with texts but no `lang` counts as English (English plural rules,
  `lang="en"`), and the console says so once; a page that only changes a few English
  texts sets `lang: "en"`. The
  dialogs take the direction from `lang` where the browser knows it; set `dir: "rtl"` in a
  right-to-left table to be sure (Firefox does not tell).
- **Complete across upgrades.** Type a full translation as `DialogStrings` instead of
  `Partial<DialogStrings>` (start from a copy of `STRINGS`, the English table of
  `@ractive-ch/tab-mcp-client/strings`): the type check then names every key you lack,
  also one a new version added, and a misspelt key is a type error either way. Keys that
  change name are listed in the changelog under "Changed". At run time a missing or wrong
  value keeps the English text.
- **Texts an AI app reads stay English** on purpose: tool results, refusals ("The user did
  not allow this call.") and errors go to the AI app, which answers the user in their
  language anyway.

`Intl.PluralRules` and `Intl.ListFormat` are in every browser the library runs in (the
later of the two since Chrome 72, Firefox 78 and Safari 14.1, 2019 to 2021). Without a
bundler, the same entry is `cdn/strings.min.js` next to `cdn/tab-mcp-client.min.js`. A
page that shows these texts in its own UI gets the whole table, its own texts where it
has them and English for the rest, from `withEnglish(strings)`.

### Help in the connect dialog

`ui.setup` changes the help in the connect dialog: `guide` is the link at its end
(default the guide on ractive.ch; `null` for none, for example on your own relay, and
then your own `instructions` too, since the default steps refer to the guide), and
`instructions(serverName, address)` returns the steps per AI app, each `{ app, text,
command?, note? }` (default `setupInstructions` of `@ractive-ch/tab-mcp-client/setup`,
which you can filter or extend; pass it your `strings` to keep them translated).

```ts
import { setupInstructions } from "@ractive-ch/tab-mcp-client/setup";

const mcp = new TabMcp({
  relay: "https://relay.example",
  server: { name: "notizen", version: "1.0.0" },
  ui: {
    strings,
    setup: {
      guide: "https://example.com/hilfe/ki",
      instructions: (name, address) =>
        setupInstructions(name, address, strings).filter((step) => step.id !== "codex"),
    },
  },
});
```

### Styling the default dialogs

The default dialogs bring their own stylesheet, a constructed stylesheet added to
`document.adoptedStyleSheets`, so a strict CSP needs no `style-src` exception. It uses
the page's font and system colours, and follows the page's `color-scheme`: declare
`color-scheme: light dark` (or `<meta name="color-scheme" content="light dark">`) and the
dialogs are dark in dark mode. They fit a 320 px wide screen (below 30rem the code's Copy
goes under the code), and they open without animation when the user prefers reduced
motion. The page's rules for elements (`button { … }`, `p { color: … }`, a reset) do not
reach into them, nor does `body { pointer-events: none }` of a modal layer (Radix, shadcn).

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

For more, override with two classes, `.tab-mcp-dialog .tab-mcp-x`, outside cascade layers;
a rule with one class does not win. The class names that stay are the dialogs:
`.tab-mcp-dialog` (all of them), `.tab-mcp-connect`, `.tab-mcp-confirm` and
`.tab-mcp-replaced`; and the kinds of button: `.tab-mcp-primary` (the one next step),
`.tab-mcp-danger` (what disconnects apps) and `.tab-mcp-copy` (every Copy). Other class
names inside the dialogs may change with any release. For example:

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
  `onConfirm`, the library's dialog asks). It disconnects its instance when it unmounts (a moment later, so that StrictMode's
  simulated unmount does not cancel a `connect()` a child started). `<TabMcpProvider
  client={mcp}>` uses an instance of your own instead (and leaves it connected).
- `useTabMcp()` returns the instance, for everything the hooks do not cover
  (`disconnectAll()`, `signOut()`, `refreshIdentity()`, `revoke()`, …).
- `useTabMcpState()` returns `{ state, session, grants, pairingCode, pairingUntil,
  identity, identityMessage, reconnecting, tools, extension }` (the address is `session?.address`) through `useSyncExternalStore`: the component
  renders again only when one of them changed. On the server and during hydration it is
  `disconnected`.
- `useTool(tool, options?)` registers the tool while the component is mounted and
  removes it on unmount. `execute` is always the latest closure, so it may use the
  component's current props and state without registering again; the tool is registered
  again only when its name, title, description, input or output schema or annotations
  change, or `options.callers` or `options.exposedTo` (by value: a new array with the same
  entries is no change; [which callers see a tool](#which-callers-see-a-tool),
  [WebMCP](#webmcp), whose `webmcp` on the provider turns it on). Registered again unchanged, an allowed tool stays
  allowed. StrictMode's double mount registers it once at a time. A duplicate name or an
  invalid tool is thrown from the component's render, for an error boundary. Tools that
  read state right after another tool changed it should read it from a store (as the
  example does) or a ref ([Tools in a `useState` app](#tools-in-a-usestate-app)), not
  from a render's props.
- `useToolCalls({ limit })` lists the AI app's tool calls since the component mounted,
  newest first (default 20), each with its `end` (outcome, result, duration) once over.
- `<ConnectButton>` calls `showConnectDialog()`, so it needs a real click (see
  [Connecting and pairing](#connecting-and-pairing)). Its label follows the state
  ("Connect your AI app", "Connecting…", "Reconnecting…", "AI app connected", "2 AI apps
  connected"), and "Connection lost. Reconnecting…" once three reconnect attempts have
  failed; a click then
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
package) starts a relay in the test process and issues a token for the page connected
at the app's address without pairing; see the relay's [README](https://github.com/ractive/tab-mcp/tree/main/packages/tab-mcp#testing-a-pages-tools).

## For browser extensions

A browser extension can be a tab-mcp page itself: its service worker holds the `TabMcp`
and offers the extension's tools (the
[tab-mcp browser extension](https://github.com/ractive/tab-mcp/tree/main/packages/tab-mcp-extension)
and Sitegloss do). When the user adds it to an AI app, the relay's pairing page
(`/authorize`) often opens in the same browser. `@ractive-ch/tab-mcp-client/extension`
lets the extension fill in its own code there: it asks its user "Connect Claude
(claude.ai)?", and on Allow writes the code into the page's form and submits it. The
relay checks the code as it checks a typed one, and typing it by hand keeps working
(another browser, a user who ignores the question).

It is an entry of its own, which a web page never loads. It imports nothing of the rest
of the library at run time, touches no `window` or `document` until called, and needs no
`chrome` types: it takes the browser's ports as small structural types, which
`chrome.runtime.Port` fits. A content script that imports `runPairingPage` bundles less
than 1 KB gzipped of it.

**What the entry gives:**

- The content script's part, `runPairingPage({ app, connect })`: on the relay's
  `/authorize` page in a tab's top frame, with exactly one form for `app` that has a code
  field, a Connect button and the relay's request id (the hooks of DEC-199), it opens a
  port to the worker (`PAIRING_PORT`), says who asks (the AI app's name and verified
  host, the request id, a nonce of this page load) and waits. It fills in only the code
  the worker sends back with that nonce, once (`requestSubmit` with Connect, the page's
  own post). Its pieces are exported too: `findPairingForm`, `fillIn`, `helloFor`,
  `parseFill`.
- The worker's part, `CodeFiller`, the rules as one state machine. A port is taken only
  from this extension's own content script, in a tab's top frame, at exactly the relay's
  origin (port included) and path (`isPairingSender`). One question per page load; on
  Allow the code goes to that one page. The same request's page back in the same tab
  within 30 s is the relay's answer that the code was not taken: filled once more
  without asking, never a third time; any other request asks. With
  `new CodeFiller(host, { retry: false })` that page is asked about like any other (one
  question per page load), so no code is ever filled in without a yes of its own. A
  question that waits is withdrawn when the page goes, AI access or the setting goes off,
  the relay changes (also during the page's hello), or the AI app connects meanwhile. A
  page that could not be asked about is reported, not dropped. `pagePort(port)` takes
  the browser's port over in `onConnect`.
- Which code to fill in: `takeCode(pairingCodes(mcp), signal, { now })` gives the current
  code unless it is about to change, else the next one, and never fails while a code
  exists: on a computer whose clock is ahead every code would look expired, so after
  waiting 10 s for a next one it gives the current code. If the relay refuses that one,
  the one more fill covers it, or with `retry: false` a new question. The same code sent
  again, as the relay answers `startPairing()` while pairing is on, is not the next one.
- The relay's addresses: `relayPageOrigin(relay)`, `relaySitePattern(relay)` (the host
  permission to ask for, `<scheme>://<host>/*`) and `pairingPagePattern(relay)` (a
  content script's `matches`); `undefined` where an address has none (an IPv6 literal).
- The messages between the two (`PairingHello`, `FillMessage`, `parseHello`).

**What the extension supplies** (`FillHost`): its id and app id; the relay origin it fills
in for (`undefined` for none); whether AI access is on, and whether the user turned
filling in on; how the user is asked (`ask`, in its own panel or notification, the name
and host shown with invisible characters escaped, `@ractive-ch/tab-mcp-client/visible`);
the code with pairing held on (`startPairing()` before `takeCode`, kept on long enough
after the fill for the relay to check the code); `release()`, called when no fill needs
pairing held any more (the AI app connected, or a fill ended without sending its code
and no other fill is under way or waits for the relay's check); and
`failed("busy" | "no-code", context)` to tell its user. `code(signal, context)` and
`failed(why, context)` get the page's `context` (`FillContext`): `{ tabId, client }`,
the same `client` (`{ name, host }`) that `ask` got. Besides, the extension keeps the
on/off setting, asks for the relay's site with a click
(`permissions.request({ origins: [relaySitePattern(relay)] })`, an optional host
permission), registers the content script for `pairingPagePattern(relay)` or puts it in
with `scripting.executeScript`, and tells the filler what changed (`grantsChanged`,
`withdrawAll`, `reset`).

The content script:

```ts
import { PAIRING_PORT, runPairingPage } from "@ractive-ch/tab-mcp-client/extension";

runPairingPage({
  app: "my-app", // the extension's appName
  connect: () => chrome.runtime.connect({ name: PAIRING_PORT }),
});
```

The worker:

```ts
import {
  CodeFiller, PAIRING_PORT, pagePort, pairingCodes, relayPageOrigin, takeCode,
} from "@ractive-ch/tab-mcp-client/extension";

const filler = new CodeFiller({
  extensionId: chrome.runtime.id,
  app: "my-app",
  relayOrigin: () => relayPageOrigin(relay),
  aiOn: () => mcp.state !== "disconnected",
  enabled: () => settings.fillCode, // off until the user turns it on
  ask: (tabId, client, signal) => askConnect(tabId, client, signal), // "allow" | "deny" | "timeout" | "busy"
  code: (signal) => {
    holdPairing(); // mcp.startPairing(), and stopPairing() a while after
    return takeCode(pairingCodes(mcp), signal, { now: Date.now() });
  },
  release: () => releasePairing(), // no fill needs pairing held now
  failed: (why, { client }) => showProblem(why, client.host), // "busy" | "no-code"
  now: () => Date.now(),
});
// new CodeFiller(host, { retry: false }): never fill in without a yes, also not
// the relay's answer to a fill.

// At the top level, so that a page's port wakes the worker; taken over at once.
// `page()` never rejects: a callback that throws closes the port and is logged.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PAIRING_PORT) void filler.page(pagePort(port));
});
// The first list is taken as the grants there are; a grant in a later one is
// an AI app that just connected, which withdraws its question.
mcp.addEventListener("grantschange", () =>
  filler.grantsChanged(mcp.grants.map((g) => ({ grantId: g.grantId, host: g.client.host }))),
);
// AI access or the setting turned off: filler.withdrawAll(); another relay: filler.reset().
```

A service worker usually starts before its connection is up, when `mcp.grants` is still
empty: build the filler without `grants`, as above, and the relay's first list is the
baseline. An extension that keeps the grants between worker starts can pass them
(`new CodeFiller(host, { grants: kept })`), so that a grant made while the worker slept
counts as new.

**Rules the extension must not weaken:**

- **The origin check.** Any site can copy the relay's markup, and any AI app can name
  itself as it likes. The worker decides by the port's sender, which the browser sets,
  never by what the page says: give `relayOrigin()` the configured relay's origin,
  exactly, and show the verified host in the question.
- **The user's Allow.** A code leaves the worker only after a yes to a question that
  names the AI app's verified host. How to ask is the extension's (`ask`): an `ask`
  that answers `allow` without asking the user ("always allow" for a host) is only
  safe for a public DNS name the relay verified, at an AI app that ties each sign-in
  to the account of the browser that started it, with a limit on such fills and a
  notice for each; the library enforces none of this.
  The one exception is the one more fill for the same tab and the same relay request
  (next point), which follows that request's yes without a new question;
  `retry: false` turns it off, and then no code leaves without a yes of its own. A
  withdrawn, timed-out or unanswered question fills in nothing.
- **No loops.** One question per page load; the one fill without a question is bound to
  the same tab and the same relay request. Do not retry around the filler.
- **Opt-in.** Off by default, also for an extension with access to all sites (that grant
  was for something else): `enabled()` is false until the user turns it on, and the
  content script is not registered while it is off.

## Security

Connecting an AI app to a page means trusting that page, as with any MCP server. Keep
cross-site scripting out of your page: a script that reads the address secret can take
the page's place at the relay. The library sends the secret only over `https:`/`wss:`
(plain `http:` only to `localhost`). See
[SECURITY.md](https://github.com/ractive/tab-mcp/blob/main/SECURITY.md) and the
[threat model](https://github.com/ractive/tab-mcp/blob/main/docs/threat-model.md).

## More

- [Live examples](https://ractive.ch/tab-mcp/)
- [Example: a React todo app](https://github.com/ractive/tab-mcp/tree/main/examples/react-todo)
- [Tab–relay protocol](https://github.com/ractive/tab-mcp/blob/main/docs/protocol.md)
- [Changelog](https://github.com/ractive/tab-mcp/blob/main/packages/tab-mcp-client/CHANGELOG.md), also in the package as `CHANGELOG.md`

## Licence

MIT, see [LICENSE](LICENSE) and [AI_NOTICE](AI_NOTICE). The CDN build bundles
third-party code; see [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
