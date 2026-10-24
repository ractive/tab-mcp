# Index

<!-- okf:index:begin -->

## iteration

* [Iteration 10: a stolen address secret](iteration-10-address-takeover.md) - What someone who copies a page's address secret can do, said plainly in the docs; a page that is taken over says so and offers a new address; and whether a backend-signed address claim is worth building.
* [Iteration 1: protocol and relay core](iteration-1-relay-core.md) - The relay's tab WebSocket, stable addresses, the token store, the HTTP tunnel with limits, timeouts and keep-alives, and the health endpoint, tested with a scripted tab and the MCP SDK client.
* [Iteration 2: browser library](iteration-2-client-library.md) - The tab-side library: a small eager core with WebMCP-style registerTool, and on connect() the lazily loaded connection and MCP handler, pairing UI and consequential-tool confirmation.
* [Iteration 3: OAuth authorization server with pairing](iteration-3-oauth.md) - Our own authorization server: metadata, CIMD client validation, pairing codes typed on the authorize page, token endpoint with PKCE and rotating refresh tokens, revocation, spec tests, conformance runs and a security review.
* [Iteration 4: calculator example and end-to-end tests](iteration-4-calculator-e2e.md) - The four-function calculator page as the minimal example, an automated browser end-to-end test, a headless Claude Code run, and the first compatibility matrix.
* [Iteration 5: packaging, documentation and release](iteration-5-packaging-release.md) - npm builds with declarations, trusted publishing with provenance, the multi-arch Docker image, project documentation, the developer skill, dependency updates and the token-expiry warning.
* [Iteration 6: deployment documentation and examples](iteration-6-deployment-bunny.md) - Generic, secret-free deployment docs and examples for running a tab-mcp relay (Docker, a bunny.net Magic Containers example); the owner's ractive.ch instance is deployed from the private ractive/ractive.ch repository.
* [Iteration 7: identity binding (0.2+)](iteration-7-identity-binding.md) - Binding a tab and an AI app to the same OpenID Connect identity, as a second pairing method next to the code.
* [Iteration 8: the relay's answer when the page is not open](iteration-8-page-not-open.md) - When the page is not open, the relay waits a short grace period for it and then answers with HTTP 200 and a JSON-RPC message instead of 503, so an AI app's connector keeps its session.
* [Iteration 9: React bindings for single-page apps](iteration-9-react.md) - A React entry point of the browser library (`@ractive-ch/tab-mcp-client/react`) with a provider, state and tool hooks and a connect button, plus automatic reconnecting in the core library, for SPAs that have no server to host an MCP server.

<!-- okf:index:end -->
