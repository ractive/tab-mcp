---
type: iteration
title: "Iteration 17: browser extensions as pages"
status: completed
description: "The relay accepts a Chrome or Edge extension's origin (chrome-extension://<id>) in TAB_MCP_ALLOWED_ORIGINS and TAB_MCP_SITES, so an extension can offer tools from its side panel; other extension schemes are refused with a reason."
timestamp: 2026-11-04T12:00:00+01:00
tags: [iteration, relay, extension, docs]
---
# Iteration 17: browser extensions as pages

A browser extension (the first is Overmark, an annotation extension in its own repository)
offers its tools through tab-mcp: the library runs in an extension page, such as its side
panel, and opens the WebSocket from there. Chrome sends that page's origin,
`chrome-extension://<id>`, and the relay accepted only `http:` and `https:` origins in its
configuration (`normalizeOrigin`). DEC-108 has the reasons.

## Scope

1. `TAB_MCP_ALLOWED_ORIGINS` and `TAB_MCP_SITES` accept `chrome-extension://<id>`, the id
   being the 32 letters a to p of a Chrome or Edge extension id; written in lower case,
   a trailing slash dropped. The public URL stays `http:`/`https:` only.
2. `moz-extension://` and `safari-web-extension://` are refused with a reason: their ids
   differ per installation, so no list can name them. Any other scheme is refused as
   before, the message naming the three that work.
3. `TAB_MCP_ALLOWED_ORIGINS=*` keeps admitting every origin, extensions included.
4. The pairing page calls such a page "the browser extension `chrome-extension://<id>`",
   after the site's name when one is configured.
5. Identity binding (`pairing: "oidc"`) stays allowed for an extension's site; it needs a
   backend that signs tab assertions for the extension's user, which an extension
   usually lacks, so `code` is the usual choice (docs).
6. Docs: configuration (origins, sites, an example for an extension) and the threat model
   (a website cannot send an extension origin; a content script's requests carry the
   page's origin, so the extension must connect from an extension page).

## Tasks

- [x] `normalizePageOrigin()` for allowed origins and sites, `isExtensionOrigin()`, tests
- [x] A tab session with `Origin: chrome-extension://<id>` accepted, another id refused
- [x] Pairing page wording for an extension, with a test
- [x] docs/configuration.md, docs/threat-model.md, CHANGELOG (relay, Unreleased), DEC-108
- [x] Review; merged (PR #72) and released as relay 0.7.0 on the owner's word
