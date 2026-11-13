# React

Single-page apps with React 18.3 or 19 use `@ractive-ch/tab-mcp-client/react` (not in the
CDN build). The provider makes one `TabMcp` for the tree, each component registers the
tools it owns while mounted:

```tsx
import { ConnectButton, TabMcpProvider, useTabMcpState, useTool } from "@ractive-ch/tab-mcp-client/react";

export function App() {
  return (
    <TabMcpProvider relay="https://relay.example.com" server={{ name: "todo", version: "1.0.0" }} appName="Todo">
      <TodoList />
    </TabMcpProvider>
  );
}

function TodoList() {
  const todos = useTodos(); // a store, so a tool reads what the previous tool wrote
  useTool<{ text: string }>({
    name: "add_todo",
    title: "Add a todo",
    description: "Add a todo item (at most 200 characters). Returns it with its id.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["text"],
      additionalProperties: false,
    },
    execute: ({ text }) => todos.add(text),
  });
  const { state, grants } = useTabMcpState();
  return <><ConnectButton /> {state === "connected" && `${grants.length} AI apps`}</>;
}
```

- `TabMcpProvider` takes the `TabMcp` options; a changed `relay` or `server.name` makes a
  new instance. `useTabMcp()` returns it for `newAddress()`, `revoke()`, `signOut()`.
- `useTabMcpState()` returns `{ state, session, grants, pairingCode, identity,
  identityMessage, reconnecting, tools }` (the address is `session?.address`) and renders
  again only on change.
- `useTool(tool, options?)` always calls the latest `execute`; it registers again
  only when the name, title, description, schemas or annotations change, or
  `options.callers` or `options.exposedTo` (by value). A duplicate name throws from render (use an error boundary).
- `webmcp` on the provider registers the tools with the browser's WebMCP too; a
  consequential tool only with `useTool(tool, { callers: ["relay", "webmcp"] })`
  (SKILL.md, section 5).
- `useToolCalls({ limit })` lists the AI app's recent calls; `ConnectButton` opens the
  dialog and labels itself by state.
