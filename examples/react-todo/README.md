# React todo example

A single-page todo app with React 19 that offers its list to AI apps through tab-mcp,
with the React bindings `@ractive-ch/tab-mcp-client/react`:

- `TabMcpProvider` around the app (`src/App.tsx`),
- one `useTool` per tool where the list lives: `list_todos`, `add_todo`,
  `complete_todo`, and `delete_todo`, which the user confirms in the page
  (`consequentialHint`),
- `ConnectButton` for the "Connect your AI app" dialog, `useTabMcpState` for the status
  line and `useToolCalls` for "The AI's calls".

The list is a small external store (`src/todos.ts`) read with `useSyncExternalStore`, so
a tool call and the next one see the same list even before React renders.

## Run it

```sh
bun install
bun run example:react
```

This starts a local relay (development mode, memory store, only this page's origin
allowed) and the page on <http://localhost:3001/>. Click "Connect your AI app" and add the
address to your AI app, e.g. `claude mcp add --transport http todo <address>`, then `/mcp`
in Claude Code, Authenticate, and type the code from the page. `TAB_MCP_RELAY=<url>` uses
another relay; `PORT` and `RELAY_PORT` change the ports.

The page is bundled by Bun's HTML import (`server.ts`); `bun run --cwd examples/react-todo
build` writes static files to `dist/` (serve them with a `/config.json` that names the
relay).

## Test

`test/e2e.test.ts` (part of `bun test`) drives the page in headless Chrome with a real
relay and the MCP SDK client: it lists the tools, adds, completes and deletes todos
(clicking Allow in the page's confirmation), restarts the relay and checks that the page
reconnects to the same address by itself.
