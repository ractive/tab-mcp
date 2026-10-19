# Index

<!-- okf:index:begin -->

## iteration

* [Iteration 1: protocol and relay core](iteration-1-relay-core.md) - The relay's tab WebSocket, addresses, the HTTP tunnel with limits and timeouts, and the health endpoint, tested with a scripted tab and the MCP SDK client.
* [Iteration 2: browser library](iteration-2-client-library.md) - The tab-side library with WebMCP-style registerTool, the MCP SDK handler over the tunnel, connect/disconnect, consent hooks and consequential-tool confirmation.
* [Iteration 3: OAuth authorization server with tab consent](iteration-3-oauth.md) - Protected-resource and authorization-server metadata, CIMD client validation, the authorize page with code comparison, token endpoint with PKCE, revocation.
* [Iteration 4: calculator example and end-to-end tests](iteration-4-calculator-e2e.md) - The four-function calculator page as the minimal example, an automated browser end-to-end test, a headless Claude Code run, and the first compatibility matrix.
* [Iteration 5: packaging, documentation and release](iteration-5-packaging-release.md) - npm builds with declarations, trusted publishing with provenance, the multi-arch Docker image, project documentation, the developer skill, dependency updates and the token-expiry warning.
* [Iteration 6: hosted relay on bunny.net](iteration-6-deployment-bunny.md) - Run the owner's public relay as a single Magic Containers instance behind the bunny CDN with a custom domain, health checks and a privacy notice.

<!-- okf:index:end -->
