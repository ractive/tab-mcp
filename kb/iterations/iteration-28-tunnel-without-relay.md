---
type: iteration
title: "Iteration 28: the page's tools for the site's own agent, without a relay"
status: planned
description: >-
  The client library serves its tools over any message port (mcp.serve), not only
  through a relay, and a small fetch function speaks the other end
  (@ractive-ch/tab-mcp-client/tunnel). A site's own agent, whose chat runs in an iframe
  on the page and whose backend already holds a WebSocket to that chat, then calls the
  page's tools with the same tab-mcp.v1 http.* messages, with no relay, pairing or
  address; relay is optional on TabMcp. Client only; the relay does not change.
timestamp: 2026-11-12T20:00:00+01:00
tags: [iteration, client, protocol]
---
# Iteration 28: the page's tools for the site's own agent, without a relay

A site with its own AI assistant (the owner's use case) wants the assistant to use the
same tools the page offers to AI apps and, with `webmcp: true`, to agents in the browser.
The assistant's chat runs in an iframe on the page, and its backend already holds a
WebSocket to that chat. Today the page can offer tools only through a relay: the backend
would connect to the page's MCP address like any AI app.

That fits badly. Pairing is made for an AI app the user started (a code or an identity),
not for the site's own assistant and anonymous visitors. The backend would also have to
prove that a chat and a tab belong together, because the address is not secret. And a
relay is one process that holds the tab sessions in memory, next to a backend that runs
its own sessions.

The page and the backend are already connected, through the chat. So this iteration lets
the library serve its tools over that connection: the backend sends the relay's
`http.request` and `http.cancel` messages (`docs/protocol.md`, "Tunnelled MCP requests"),
the chat in the iframe passes them on, and the page answers with `http.response*` as it
answers a relay. Who can send on the port is decided by the page when it hands the port
out, so nothing needs pairing.

```text
page (TabMcp, relay optional)                 chat iframe              site's backend
  registerTool(...) ── webmcp: true ──▶ document.modelContext (agents in the browser)
  mcp.serve(port1, { client }) ◀── MessageChannel ──▶ port2 ⇄ own WebSocket ⇄ createTunnelFetch()
                                                                            ▲
                                                          MCP SDK client (fetch) / own code
```

## What stays the same

- The messages: `http.request`, `http.response`, `http.response.start`, `.chunk`, `.end`,
  `http.cancel`, unchanged. No new message type.
- The MCP handler (`createMcpHandler` in `src/mcp.ts`), the argument check, the
  confirmation of consequential tools, `toolcall`/`toolcallend`, `toolsChanged` and
  `subscriptions/listen`. A page's tool code cannot tell a served call from a relay call
  except by `client.kind`.
- The relay package. Nothing in `packages/tab-mcp` changes.
- WebMCP mirroring (iteration 25). It works with or without a relay and with or without
  `serve`.

## Scope

1. **`relay` is optional.** `TabMcpOptions.relay?: string`. Without it, `connect()`,
   `showConnectDialog()` and `newAddress()` reject with a `TypeError` ("this TabMcp has
   no relay"), no address secret is read or written, and no `BroadcastChannel` is opened.
   `registerTool`, the WebMCP mirror and `serve` work as usual. `TabMcpProvider` (React)
   accepts a missing `relay` the same way, and `ConnectButton` renders nothing without
   one. Today the constructor reads the relay first (`src/tab-mcp.ts`, `tabUrl(options.relay)`).

2. **The tunnel leaves `connection.ts`.** `tunnel()` and its `inflight` map
   (`src/connection.ts`, from `async function tunnel`) move into `src/tunnel.ts`:

   ```ts
   createTunnel(options: {
     handler: McpHandler;
     send(message: TabMessage): boolean;
     maxChunk: number;
     client(grant: GrantRef): ToolCallClient;
   }): {
     request(message: HttpRequestMessage): void;
     cancel(id: string, reason?: string): void;
     close(): void; // aborts every call in flight
   };
   ```

   `openConnection` uses it. No change in behaviour; the existing relay tests are the
   check. The handler that `openConnection` creates today (`createMcpHandler({ ...,
   client: (grant) => host.clientFor(grant) })`) is created by the caller and passed in.

3. **`mcp.serve(port, options)`** serves the tools over one port:

   ```ts
   interface TunnelPort {
     postMessage(message: unknown): void;
     onmessage: ((event: { data: unknown }) => void) | null;
   }

   serve(port: TunnelPort, options: {
     /** Who is on the other end; shown in confirmations and passed to execute. */
     client: { id: string; name?: string };
     /** Aborting it stops serving: calls in flight are aborted, the port is let go. */
     signal?: AbortSignal;
     /** Largest http.response.chunk, as the relay's session message says; 64 KiB. */
     maxChunk?: number;
   }): Promise<{ close(): void }>;
   ```

   - A `MessagePort` is a `TunnelPort` (setting `onmessage` starts it), and so is an
     object a page writes around something else.
   - It accepts `http.request` and `http.cancel` and answers `error` with
     `bad_message` to anything else, as the relay does in the other direction.
   - **The library sets the grant itself.** Every request's `grant` is replaced by
     `{ grantId: "local:<n>", clientId: options.client.id, scopes: ["tools"] }` (one
     `n` per `serve` call). A `grant` sent on the port is ignored: the other end must not
     be able to pose as a relay's AI app.
   - Calls see a new member of `ToolCallClient`: `{ kind: "local", id, name? }` from
     `options.client`. The confirmation names `name ?? id` ("Example assistant wants to
     run …") and says it is the page's own assistant, not an AI app the user paired.
   - `serve` may be called several times (several ports, several clients). Closing one
     leaves the others and the relay connection alone.
   - Loaded lazily, like the connection (`#load()`), with the handler, the tunnel and
     `mcp.ts`. The core is 23 B under its 6 KB budget (DEC-119), so see the first open
     question.

4. **`@ractive-ch/tab-mcp-client/tunnel`**, a new entry without DOM or Bun APIs, for the
   other end (a backend on Bun or Node, a test, another frame):

   ```ts
   createTunnelFetch(options: {
     send(message: HttpRequestMessage | HttpCancelMessage): void;
     /** Per request, until the first byte of the answer; 300 s as the relay. */
     requestTimeoutMs?: number;
   }): {
     fetch(request: Request): Promise<Response>;
     /** Hand it every message from the other end; unknown ones are ignored. */
     receive(message: unknown): void;
     /** The other end is gone: pending requests fail, later ones too. */
     close(reason?: string): void;
   };
   ```

   - `fetch` turns a `Request` (method, path, the headers `docs/protocol.md` allows,
     body) into `http.request` with a new `id`, and `http.response` or
     `http.response.start`/`.chunk`/`.end` back into a `Response` with a streamed body.
   - Aborting the request's `signal` sends `http.cancel` and rejects with `AbortError`.
   - A timeout or `close()` answers like the relay: JSON-RPC errors with the relay's
     codes (`-31002` timeout, `-31003` the page went away) at HTTP 200, so an MCP client
     shows the agent a readable error, not a network failure. `tools/call` is never
     sent twice.
   - Meant for the MCP SDK client: `new StreamableHTTPClientTransport(new
     URL("https://tab.invalid/mcp"), { fetch })`. Whether `@modelcontextprotocol/client`
     2.4.0 takes a `fetch` option is checked first (first task); if not, the README shows
     `tools/list` and `tools/call` with plain `fetch` calls instead.
   - Small and separate from the core; it shares only types with `protocol.ts`.

5. **Documentation.**
   - `docs/protocol.md`: a section "The tunnel without a relay": the six `http.*`
     messages work over any ordered channel; what `serve` does with `grant`; no session,
     heartbeat or limits messages on a port.
   - Client README: "Your own assistant on the page", with the three parts as short
     examples: the page (`new TabMcp({ server })` without `relay`, a `MessageChannel`,
     the origin check on the iframe's first message, `serve(port1, ...)`), the iframe
     (forward `port2` to its WebSocket and back) and the backend (`createTunnelFetch` with
     the MCP SDK client).
   - `kb/design/architecture.md`: the third caller next to AI apps and agents in the
     browser.
   - Threat model (`docs/threat-model.md`, `kb/design/threat-model.md`): a port is a
     capability. Whoever the page gives it to calls its tools without pairing, and the
     library cannot check who that is: the page must hand it out only after checking the
     frame's origin. The grant cannot be forged over the port. Consequential tools still
     ask (also for `kind: "local"`), and results the page marks `untrustedContentHint`
     stay marked.

6. **Tests.**
   - Unit (`bun test`): `serve` and `createTunnelFetch` over a `MessageChannel` in Bun:
     `tools/list`, a `tools/call` with a streamed result, a declined confirmation, a
     cancel in both directions, a timeout, `close()` with calls in flight, a forged
     `grant` that is ignored, `toolsChanged` reaching a `subscriptions/listen` stream,
     `bad_message` for other message types, two `serve` calls at once.
   - The MCP SDK client 2.4.0 through `createTunnelFetch` (pinned to 2026-07-28, as
     `test/helpers.ts` does over HTTP).
   - Browser: a page with an iframe on another origin; the page checks the origin, hands
     over the port and serves; the iframe lists and calls a tool through
     `createTunnelFetch`. The same test with `webmcp: true` shows a tool reaching both
     callers.
   - Without `relay`: `connect()` rejects, nothing is written to `localStorage`, and
     `serve` and the mirror work.
   - The size test (`test/build.test.ts`): the core stays within its budget, and the new
     entry is measured on its own.

## Not in this iteration

- **Anything in the relay.** No embeddable relay handler, no pairing for a site's own
  agent, no trusted clients. The relay stays the way to AI apps outside the site.
- **Raw JSON-RPC on the port.** The handler is HTTP-shaped and tested as such
  (`src/mcp.ts`); a second way in would make the page answer two protocols. The
  `http.*` framing costs a few fields per message.
- **An MCP SDK `Transport`.** On the server side a hand-connected server does not serve
  2026-07-28 ([SDK v2 research](/research/mcp-typescript-sdk-v2.md)); on the client side
  `fetch` is all the SDK client needs.
- **A handshake in the library.** Which frame gets a port, and after which origin
  check, is the page's code; the library takes a port that is already decided.
- **Allowing without asking** for the site's own agent. A page that wants it answers
  `onConfirm` itself for `client.kind === "local"`.
- **Heartbeats and limits on a port.** The other end is the page's own code, and the
  backend's connection has its own.
- **Anything for an agent framework** (OpenAI Agents SDK and others): a backend wraps
  the MCP client in its framework's interface itself.

## Open questions for the owner

1. **Where `serve` lives.** As a method on `TabMcp` it needs a stub in the core, and the
   core is 23 B under its budget (DEC-119). Either a new budget, or `serve` moves to its
   own entry (`@ractive-ch/tab-mcp-client/serve`, `serve(mcp, port, options)`) with a
   symbol-keyed hook in the core to reach the registry and confirmation (a few bytes),
   or the WebMCP mirror moves into a lazy chunk first, as DEC-119 foresees.
2. **The caller's name.** `kind: "local"`, `"port"` or `"site"`, and whether the
   confirmation text should say "this site's assistant".
3. **Always allow for `kind: "local"`.** Offered and kept per `client.id` for the
   page's lifetime (like a relay grant), or never (like WebMCP callers).
4. **Errors from `createTunnelFetch`.** JSON-RPC errors with the relay's codes (planned
   above) or plain rejected `fetch` calls, which MCP clients show as network errors.
5. **Package.** `createTunnelFetch` as an entry of the client package (planned above,
   since it shares the protocol types), or a small package of its own for backends that
   should not install a browser library.

## Tasks

- [ ] Check that `@modelcontextprotocol/client` 2.4.0's `StreamableHTTPClientTransport`
      takes a `fetch` option and pins 2026-07-28 with it (a scratch test)
- [ ] The owner answers the open questions; decisions recorded as DEC-122 and following
- [ ] `relay` optional in `TabMcp`, `TabMcpProvider` and `ConnectButton`
- [ ] `src/tunnel.ts` out of `connection.ts`, no change in behaviour
- [ ] `serve` with the grant set by the library, the `local` caller, confirmation text,
      `signal` and `close()`
- [ ] `@ractive-ch/tab-mcp-client/tunnel` with `createTunnelFetch`; package exports and
      build
- [ ] Tests as listed under Scope 6
- [ ] `docs/protocol.md`, client README, architecture, threat model
- [ ] CHANGELOG (client minor: a new caller kind changes `ToolCallClient`, so code
      that switches over every `kind` needs a case), a client release on the owner's word
- [ ] Review; merged on the owner's word
