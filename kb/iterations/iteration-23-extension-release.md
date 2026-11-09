---
type: iteration
title: "Iteration 23: releasing tab-mcp for Chrome"
status: planned
description: "The Chrome Web Store listing, privacy policy and review notes, a release workflow on extension-v* tags that publishes the store package, and the documentation on ractive.ch/tab-mcp."
timestamp: 2026-11-08T23:30:00+01:00
tags: [iteration, extension, release]
---
# Iteration 23: releasing tab-mcp for Chrome

## Scope

1. **Versions and tags**: the extension has its own version; a tag `extension-v<version>`
   builds and attaches the store package to a GitHub release. Relay and client releases
   are unchanged (DEC-109).
2. **Publishing**: a manual workflow uploads a release's store package to the Chrome Web
   Store, as Overmark's `publish.yml` does (a pinned public action, the store's OAuth
   credentials as secrets of a protected environment in this repository).
3. **Store listing**: name "tab-mcp for Chrome", the descriptor, screenshots, the
   permissions and why each is needed (the README's "Permissions" table, iteration 26),
   review notes (no remote code: the extension only
   lists and calls the tools a page registered itself with WebMCP).
4. **Privacy policy**: what is stored (settings, in the browser), what leaves the
   browser (only what the user's AI app asks for, through the relay the user chose).
5. **Docs** on `ractive.ch/tab-mcp` (in the ractive.ch repository): the two ways to use
   tab-mcp, built into a site, or the extension for sites that offer WebMCP tools; that
   WebMCP is on only where a site takes part in Chrome's origin trial or the user turned
   on the flag (the listing says so too); setup with the hosted relay.
6. **CHANGELOG** for the extension.

## Tasks

- [ ] Release workflow on `extension-v*`; store package attached
- [ ] Publish workflow and environment; credentials set up by the owner
- [ ] Listing texts, screenshots, privacy policy, review notes
- [ ] Docs page content for ractive.ch (its own PR there)
- [ ] First release on the owner's word

# Citations

- [Chrome Web Store: publish an item](https://developer.chrome.com/docs/webstore/publish)
- [Chrome Web Store: privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
