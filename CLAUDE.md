
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Type checking

Use `bun check` to type check the project. It reads `tsconfig.json` and reports the same errors as `tsc`.

- `bun check src/index.ts` checks one file and what it imports
- `bun --check src/index.ts`, `bun test --check` and `bun build --check` type check first, and do nothing else if there is an error

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## This project

tab-mcp: a relay that lets AI apps call MCP tools offered by a web page in a
browser tab. Bun workspaces: `packages/tab-mcp` (relay, `@ractive-ch/tab-mcp`),
`packages/tab-mcp-client` (browser library, `@ractive-ch/tab-mcp-client`),
`packages/tab-mcp-extension` (the tab-mcp browser extension, Chrome Web Store from
`extension-v0.1.0`), `test/e2e` (end-to-end test with its test page).

- Commands: `bun run verify` (Biome CI, type check, tests; no browser, about a
  minute and a half) before every commit, docs included (tests read them). A
  change to `kb/` alone needs nothing.
- `bun run test:browser [filter…]` (the `*.browser.test.ts` files, Chrome and
  Firefox; a filter matches the file's name) before a commit that changes code
  a browser test runs, with the filters for the part touched: the extension
  (`extension fill firefox`), the client library's browser code (`page webmcp
  serve`), the relay's pages, server and protocol (`code-field calculator page
  react-todo`), the test pages and harnesses (the files that use them). It
  starts only the pinned test browsers, never the owner's own Chrome or
  Firefox: Chrome for Testing and a test Firefox in `~/.cache/puppeteer`,
  installed once with the two `bunx @puppeteer/browsers` lines in the README's
  commands (or `CHROME_PATH` / `FIREFOX_PATH`; an installed Firefox only with
  `--system-firefox`), and no notification reaches the desktop. It fails when
  a browser it needs is missing and prints the line that installs it;
  `--no-firefox` or `--no-chrome` leaves those files out and says so;
  `--no-full` leaves out the full run's files (`*-full.browser.test.ts`: the
  rest of Firefox), as the pull requests' browser job does.
  Every Firefox browser file is `*-smoke` (on every pull request) or `*-full`
  (a test checks); `test:browser firefox` runs both. One browser run per machine: a second
  run (also `TAB_MCP_BROWSER=1 bun test <file>`) says whose run holds the lock
  and waits for it; `--no-wait` fails instead. Each run first stops the test
  browsers of killed runs and removes their folders (`bun run test:browser
  --sweep --dry-run` shows what). CI runs both on every pull request (the
  browser job with `--no-full`); its required check `verify` needs both.
  `.github/workflows/browser-full.yml` runs every browser file nightly, on
  demand and on changes to main (not required); a red run there opens an
  issue labelled `browser-full`.
- `bun run fix` to format. Type check per workspace with `bun check -p <dir>`
  (no script may be named `check`: it shadows `bun check`).
- Always the latest versions of Bun, TypeScript, Biome and every dependency,
  pinned exactly. Use Bun's built-ins before adding a package.
- Biome ignores `.claude/` and `kb/` (vendored and knowledge files).
- Knowledge, plans and decisions live in `kb/` (hyalo, OKF profile). No `kb/log.md`
  (owner, 2026-11-14): iteration files, the decision log and git history are the record.
- Commits: author email james@ractive.ch. MIT licence with `AI_NOTICE`.
