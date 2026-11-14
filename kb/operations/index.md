# Index

<!-- okf:index:begin -->

## operations

* [Chrome crash in the store package's e2e tests (SIGILL in CI)](chrome-webmcp-crash.md) - Why tab-mcp for Chrome's e2e tests lost Chrome with SIGILL in CI (SIGTRAP on macOS): a bug in Chrome's WebMCP when a document with a tool has getTools() pending while it goes into the back/forward cache (Chromium issue 585631961); how it was found, the evidence, the test's wait that avoids it, and how the extension reads less (DEC-177).
* [npm publishing: bootstrap and releases](npm-publishing.md) - The owner's one-time steps to put @ractive-ch/tab-mcp-client and @ractive-ch/tab-mcp on npm from CI-signed tarballs and switch on trusted publishing, the relay's image registries, and how every later release works.
* [Release credentials and how to renew them](release-secrets.md) - Which secrets and variables the release workflow uses and the steps to renew them when a publication fails.
* [tab-mcp for Chrome in the Chrome Web Store](chrome-web-store.md) - The release path of tab-mcp for Chrome: the store package, the release and publish workflows, the owner's one-time setup, the listing texts, single purpose, permission justifications, data disclosures and review notes, and adding the store id to the hosted relay before the listing goes public.

<!-- okf:index:end -->
