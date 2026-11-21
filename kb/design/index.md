# Index

<!-- okf:index:begin -->

## design

* [Identity binding](identity-binding.md) - The relay connects an AI app to a tab only if both are signed in as the same person at the same OpenID Connect provider; a pairing method next to the code (DEC-075 to DEC-079).
* [Security model and threat model](threat-model.md) - Assets, attackers, what the relay sees, the mitigations and safe defaults, and the risks that remain.
* [tab-mcp architecture](architecture.md) - Components, endpoints, data flow and the full sequence from a page connecting, through pairing with a code, to an AI app calling its tools and the user disconnecting.
* [tab-mcp browser extension: the look](extension-look.md) - Overmark's design language (paper and ink, tokens with computed contrast for light and dark, edges that reach 3:1, one type and spacing scale, forced colours, reduced motion, tests that guard the look) mapped onto the side panel and the question window of the tab-mcp browser extension: what is adopted as it is, what is adapted, what is left out and why, and the changes and tests of iteration 39.
* [Tab↔relay protocol, version 1](protocol.md) - Pointer to docs/protocol.md, the normative description of the versioned WebSocket protocol `tab-mcp.v1` between the browser library and the relay.
* [The tab-mcp browser extension](extension.md) - A small Chrome extension in this repository that bridges a page's own WebMCP tools to AI apps outside the browser, through the relay. Recipes (tools an AI app builds for a site) are dropped (DEC-114); user scripts are an experiment of their own.
* [Wording: one term for one thing](wording.md) - The glossary every text a person or an AI app reads follows, in the client library's dialogs, the tab-mcp browser extension and the relay's pages and messages: the term for each of 31 concepts, the differences that keep two terms on purpose, the texts an AI app reads, and how the library writes plural forms and lists (Intl, English only in the package). Check new texts against it.

<!-- okf:index:end -->
