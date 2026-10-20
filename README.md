# tab-mcp

Connect your AI tool to a web app open in a browser tab.

A web page offers some of its functions as [MCP](https://modelcontextprotocol.io)
tools. The page connects to a tab-mcp relay and gets an address that you add to
your AI app (Claude, ChatGPT, Claude Code; see
[compatibility](docs/compatibility.md) for which apps work). The AI app then
calls the page's tools through the relay while the tab stays open. Nothing has
to be installed on your computer.

**Status: early development.** Nothing is published yet.

## Packages

| Path | npm | What |
|---|---|---|
| `packages/tab-mcp` | `@ractive-ch/tab-mcp` | the relay (also the Docker image) |
| `packages/tab-mcp-client` | `@ractive-ch/tab-mcp-client` | the browser library a page uses |
| `examples/calculator` | – | a small calculator page as an example ([README](examples/calculator/README.md)) |

## Development

Requires [Bun](https://bun.sh) 1.4.

```sh
bun install
bun run verify     # Biome, type check, tests
bun run fix        # format and apply safe lint fixes
```

## License

MIT, see [LICENSE](LICENSE) and [AI_NOTICE](AI_NOTICE).
