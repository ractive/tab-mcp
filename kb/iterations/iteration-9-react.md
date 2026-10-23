---
type: iteration
title: "Iteration 9: React bindings for single-page apps"
description: A React entry point of the browser library (`@ractive-ch/tab-mcp-client/react`) with a provider, state and tool hooks and a connect button, plus automatic reconnecting in the core library, for SPAs that have no server to host an MCP server.
status: planned
tags:
  - iteration
  - client
  - react
timestamp: 2026-10-21T19:30:00+02:00
---

# Iteration 9: React bindings for single-page apps

Owner, 2026-10-21: single-page apps are a natural fit for tab-mcp. A static SPA (GitHub
Pages, Netlify, an S3 bucket) has no server that could host an MCP server, and its state
lives in the tab anyway; tab-mcp gives it one through the relay. React is the most common
framework for them, so the library gets React bindings. (Parked on 2026-10-20, planned
now.)

## Design

### Where it lives

A second entry point of the existing package, `@ractive-ch/tab-mcp-client/react`, not a
new package: it releases with the client (same tag, same trusted publisher), and the core
stays framework-free. `react` is an optional peer dependency (`>=18.3 <20`,
`peerDependenciesMeta.react.optional`), so plain pages install nothing extra. ESM only,
with `"use client"` at the top of the module for React Server Components frameworks
(Next.js app router). Not in the CDN bundle: a page that loads tab-mcp from a CDN uses
the core API.

### API (first draft)

```tsx
import { TabMcpProvider, useTabMcpState, useTool, ConnectButton } from "@ractive-ch/tab-mcp-client/react";

<TabMcpProvider relay="https://relay.example" server={{ name: "todo", version: "1.0.0" }} appName="Todo">
  <App />
</TabMcpProvider>

function TodoList({ todos, add }) {
  useTool({
    name: "add_todo",
    description: "Add a todo item",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: ({ text }) => add(text),
  });
  const { state, grants } = useTabMcpState();
  return <><ConnectButton /> {state === "connected" && `${grants.length} AI apps`}</>;
}
```

- `TabMcpProvider`: makes one `TabMcp` for its tree, from the props of its first render
  (a changed `relay` or `server.name` makes a new instance and says so in development;
  other changes are ignored). Never on the server: the instance is created on the client
  only, so server rendering and hydration see the `disconnected` state. `useTabMcp()`
  returns the instance for everything the hooks do not cover.
- `useTabMcpState()`: `state`, `address`, `grants`, `pairingCode`, `session`, through
  `useSyncExternalStore` on the instance's events, with a cached snapshot so components
  re-render only on change.
- `useTool(tool, deps?)`: registers on mount with an `AbortSignal` and aborts on unmount.
  `execute` is read through a ref, so a new closure each render does not re-register;
  the tool is registered again only when its name, description, schema or annotations
  change (or `deps`). Must survive StrictMode's mount, unmount, mount in development
  (register, abort, register under the same name in one tick).
- `useToolCalls({ limit })`: the recent `toolcall`/`toolcallend` pairs, for an activity
  view like saturnus's "The AI's calls".
- `ConnectButton`: a button that calls `showConnectDialog()`, with the state as its label
  by default ("Connect your AI app", "AI app connected"); `children` and `className` to
  style it. The dialog stays the library's default (or the page's own via the core API).

### Reconnecting, in the core library

saturnus had to build it (iteration 56 there): after a `disconnected` with reason
`network`, `heartbeat` or `shutdown`, connect again with a growing wait (5, 10, 20, 40 s,
then every 60 s), and at once when the tab comes back to the front or the network
returns. Every page needs this, React or not, so it moves into `TabMcp` as an option
(`reconnect: true` by default for connections the user started; `false` keeps today's
behaviour), with a `reconnecting` state or event the hooks expose. saturnus can then drop
its own copy.

### Example and tests

- `examples/react-todo/`: a Vite SPA, a todo list with tools to list, add and complete
  items, a confirmation on delete (`consequentialHint`). Built to static files; served
  by the example server in tests.
- Unit tests of the hooks with happy-dom (already a dev dependency) and React's `act`,
  for React 18.3 and 19 (both as dev dependencies, the tests run against each):
  StrictMode double mount, re-render without re-registering, unmount removes the tool,
  provider on the server renders without touching `window`.
- End to end like the calculator: relay, the built example in headless Chrome over CDP,
  the MCP SDK client pairs, lists the tools, adds a todo, and the page shows it.
- Bundle size of the React entry in `build.test.ts` (it must not pull in the core's
  lazy chunks eagerly).

### Docs

README section "React", the plugin skill's React part (how an AI agent adds tab-mcp to a
React SPA), CHANGELOG. Client release 0.3.0.

## Open questions

- Provider plus hooks, or hooks only (`useTabMcp(options)` in the app's root)? The draft
  uses a provider because tools are registered in many components.
- Next.js app router and Remix: a small example or only a note on `"use client"`?
- Other frameworks later (Vue, Svelte, Solid): the core API works today; bindings only on
  demand.

## Tasks

- [ ] Decide the open questions (owner) and record them as a DEC
- [ ] Reconnecting in the core `TabMcp` (option, state/event, tests), docs
- [ ] React entry `src/react.tsx`: provider, `useTabMcp`, `useTabMcpState`, `useTool`, `useToolCalls`, `ConnectButton`; package exports and optional peer dependency
- [ ] Hook tests for React 18.3 and 19 (StrictMode, re-renders, unmount, server rendering)
- [ ] `examples/react-todo` and its end-to-end test
- [ ] README, plugin skill, CHANGELOG; release client 0.3.0
- [ ] saturnus: use the core reconnecting and drop its own

## Acceptance criteria

- A Vite React SPA adds tab-mcp with the provider, one `useTool` per tool and a
  `ConnectButton`, and an AI app pairs with it and uses its tools, also after the tab was
  in the background or the relay restarted.
- StrictMode in development registers each tool once at a time and never throws
  "already registered".
- The core entry's size and behaviour are unchanged for pages that do not use React
  (apart from reconnecting, which is opt-out).

# Citations

- [Iteration 2: the client library](/iterations/iteration-2-client-library.md)
- [WebMCP registerTool](/research/webmcp-register-tool.md)
