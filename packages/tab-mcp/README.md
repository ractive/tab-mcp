# @ractive-ch/tab-mcp

The tab-mcp relay. It lets AI apps (Claude, ChatGPT, Claude Code) call
[MCP](https://modelcontextprotocol.io) tools that a web page offers while it is open in a
browser tab.

The page connects to the relay over a WebSocket with the browser library
[`@ractive-ch/tab-mcp-client`](https://www.npmjs.com/package/@ractive-ch/tab-mcp-client)
and gets an MCP address. The user adds that address to an AI app and pairs it by typing
a code from the page on the relay's sign-in page. The relay then forwards the AI app's
requests to the page. It knows nothing about the tools themselves.

**Status: 0.3.0.** Until 1.0, a new minor version can still change settings and the API.
The relay speaks MCP revision 2026-07-28 only and accepts AI apps that register through
OAuth Client ID Metadata Documents; see [compatibility](https://github.com/ractive/tab-mcp/blob/main/docs/compatibility.md)
for which apps work.

## Run it

The relay needs [Bun](https://bun.sh) 1.4.3 or newer. It does not run on Node.js.

```sh
bun add --global @ractive-ch/tab-mcp
TAB_MCP_PUBLIC_URL=https://relay.example.com \
  TAB_MCP_ALLOWED_ORIGINS=https://app.example.com \
  tab-mcp
```

Or with Docker (linux/amd64 and linux/arm64):

```sh
docker run -d -p 127.0.0.1:8080:8080 -v tab-mcp-data:/data \
  -e TAB_MCP_PUBLIC_URL=https://relay.example.com \
  -e TAB_MCP_ALLOWED_ORIGINS=https://app.example.com \
  ractive/tab-mcp:0.3.0
```

The image is also on `ghcr.io/ractive/tab-mcp`. Put the relay behind a reverse proxy
with TLS; see
[self-hosting](https://github.com/ractive/tab-mcp/blob/main/docs/self-hosting.md) for
WebSockets, event streams and proxy time limits.

For a local test with a page on `http://localhost:3000`:

```sh
NODE_ENV=development TAB_MCP_PUBLIC_URL=http://localhost:8080 \
  TAB_MCP_ALLOWED_ORIGINS=http://localhost:3000 TAB_MCP_STORE=memory tab-mcp
```

## Configuration

Environment variables, all listed by `tab-mcp --help` and in
[configuration](https://github.com/ractive/tab-mcp/blob/main/docs/configuration.md).
The most important:

| Variable | Default | Meaning |
|---|---|---|
| `TAB_MCP_PUBLIC_URL` | required | the relay's public origin; `https:` outside development |
| `TAB_MCP_ALLOWED_ORIGINS` | empty: no page may connect | comma-separated page origins; `*` makes an open relay (read the warning in the docs first) |
| `TAB_MCP_SITES` | empty | JSON array of sites with their own app name or limits |
| `TAB_MCP_STORE` | `sqlite` | `sqlite` or `memory` |
| `TAB_MCP_SQLITE_PATH` | `tab-mcp.db` | the SQLite file for grants and token hashes |
| `TAB_MCP_TRUST_PROXY` | `none` | `x-real-ip` or `x-forwarded-for` behind a proxy |
| `TAB_MCP_PORT` | `8080` | listen port |
| `TAB_MCP_IDENTITY` | `code` | `oidc` pairs AI apps by the same sign-in at your OpenID Connect provider instead of a code (identity binding; needs the `TAB_MCP_OIDC_*` and `TAB_MCP_TAB_ASSERTION_*` settings) |

`GET /healthz` answers `200` with the version, for health checks.

## Use it as a library

```ts
import { createRelay } from "@ractive-ch/tab-mcp";

const relay = createRelay({
  publicUrl: "https://relay.example.com",
  allowedOrigins: ["https://app.example.com"],
  store: "sqlite",
  sqlitePath: "/var/lib/tab-mcp/tab-mcp.db",
});
console.log(`listening on port ${relay.port}`);

process.on("SIGTERM", () => relay.stop().then(() => process.exit(0)));
```

`createRelay(options)` starts the server and returns once it listens. The options mean
the same as the environment variables, with camel-case names, milliseconds instead of
seconds and arrays instead of comma-separated lists (`allowedOrigins`, `sites`,
`maxSessionsPerIp`, `requestTimeoutMs`, `maxMessageBytes`, …), plus:

- `store`: `"sqlite"` (default), `"memory"`, or your own `TokenStore` object;
- `logger`: your own logger; by default JSON lines on stdout.

The returned `Relay` has `url`, `port`, `config`, `sessionCount`, `addressFor(secret)`
and `stop()`, which sends `bye` to every page (close code 4004) and stops the server.

The package also exports `MemoryTokenStore`, `SqliteTokenStore`, the `TokenStore` types,
`configFromEnv`, `resolveConfig`, `DEFAULT_CONFIG`, `createLogger`, `SUBPROTOCOL`
(`tab-mcp.v1`) and `VERSION`.

### Your own token store

A store keeps grants and the SHA-256 hashes of tokens, never the tokens. Check yours with
the conformance suite for `bun test`:

```ts
import { tokenStoreConformance } from "@ractive-ch/tab-mcp/testing";
import { MyTokenStore } from "./my-token-store.ts";

tokenStoreConformance("MyTokenStore", () => new MyTokenStore());
```

[Token store](https://github.com/ractive/tab-mcp/blob/main/docs/token-store.md) explains
the interface, its guarantees and a Redis example.

## Security

Connecting an AI app to a page means trusting that page, as with any MCP server. The
relay operator can read every tool argument and result; the relay does not log them.
Report vulnerabilities privately as described in
[SECURITY.md](https://github.com/ractive/tab-mcp/blob/main/SECURITY.md). The
[threat model](https://github.com/ractive/tab-mcp/blob/main/docs/threat-model.md) covers
the details.

## More

- [Repository and overview](https://github.com/ractive/tab-mcp)
- [Tab–relay protocol](https://github.com/ractive/tab-mcp/blob/main/docs/protocol.md)
- [Changelog](https://github.com/ractive/tab-mcp/blob/main/CHANGELOG.md)

## Licence

MIT, see [LICENSE](LICENSE) and [AI_NOTICE](AI_NOTICE).
