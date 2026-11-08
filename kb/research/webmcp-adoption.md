---
type: research
title: "WebMCP adoption (November 2026)"
description: "How many sites register WebMCP tools and which agents call them, from Chrome's use counters, crawls and announcements as of 2026-11-08: about 1% of Chrome page loads register tools, mostly through platforms such as Shopify, while agent calls are about five orders of magnitude rarer."
timestamp: 2026-11-08T23:45:00+01:00
tags: [webmcp, research, adoption]
---
# WebMCP adoption (November 2026)

Collected on 2026-11-08 for the extension's WebMCP bridge (DEC-114). Many pages register
WebMCP tools; hardly any agent calls them yet.

## Chrome's use counters

Share of Chrome page loads (chromestatus feature popularity, where WebMCP is on: origin
trial token or flag):

| Counter | Value |
|---|---|
| `registerTool()` (bucket 5791) | about 0.001% until 2026-07-05; 0.79–0.83% monthly in August to October; 1.07% on 2026-11-07 |
| `getTools()` (5904) | 0.012–0.014% in November |
| Declarative `<form toolname>` (5792) | 0.0015% in November |
| An agent running a page's tool (5799, `ModelContext::ExecuteV8Tool`) | about 0.000005% (October, November) |

Roughly one agent tool call per 170,000 page loads that register tools. The jump on
2026-07-06 matches a large platform rolling out; chromestatus does not say which. The
origin trial ran Chrome 149–156 and is extended to 162; the feature is still "Proposed",
with no ship date. No count of trial registrations is published.

## Crawls

- Browser Use (October 2026, Chrome 154, Tranco top 300k plus public lists): 13,352 sites
  with tools; 1.7% of the top 100k. By platform: Shopify 5,190, Cloudflare 258, Mintlify
  203, Tambourine 201, SEOPress 159, GitBook 46, ReadMe 45.
- Known Good (August 2026): 580 of 14,351 indexed sites register a tool, "mostly a few
  plugins installed many times" (`search_site`, `fetch_as_markdown`).
- HTTP Archive and the Web Almanac have nothing on WebMCP yet.

## Who offers tools

- **Shopify**: on by default on every Liquid storefront since August 2026, 16 tools
  (`search_catalog`, `get_cart`, `proceed_to_checkout`, `complete_checkout`, …).
- **Cloudflare**: opt-in per domain (developer preview, August 2026).
- At Google I/O 2026, Expedia, Booking.com, Etsy, Target, Instacart and others were shown
  as "experimenting", which is not production use.
- npm, week of 2026-11-01: `@mcp-b/webmcp-polyfill` 371k, `@mcp-b/global` 211k,
  `webmcp-types` 297k downloads (CI and transitive installs included; not site counts).

## Who calls them

- ChatGPT desktop's built-in browser ("Site tools", since late August 2026, eligible
  accounts).
- Gemini in Chrome: announced as "soon".
- Claude in Chrome: no (open request, anthropics/claude-code#76809).
- `chrome-devtools-mcp`: `list_webmcp_tools`, `execute_webmcp_tool`, off by default;
  Vercel agent-browser and Brave Leo reportedly.
- MCP Apps (the MCP extension for interactive views) made WebMCP an equal surface for a
  view's tools: ext-apps#829, merged 2026-10-27, mirrors app tools into
  `document.modelContext` and serves a view's WebMCP tools over MCP.

## Other browsers

Safari opposes it (WebKit standards position, June 2026); Firefox is neutral and has no
implementation; Edge runs its own origin trial (until 2027-03-30).

# Citations

- [Chrome Status: WebMCP](https://chromestatus.com/feature/5117755740913664) and its [use counter timeline](https://chromestatus.com/data/timeline/featurepopularity?bucket_id=5791)
- [Browser Use: WebMCP directory](https://browser-use.com/webmcp)
- [Known Good data, webmachinelearning/webmcp#319](https://github.com/webmachinelearning/webmcp/issues/319)
- [Shopify: WebMCP on Liquid and Hydrogen storefronts](https://shopify.dev/changelog/webmcp-liquid-hydrogen)
- [Cloudflare: WebMCP](https://blog.cloudflare.com/webmcp/)
- [Chrome at I/O 2026](https://developer.chrome.com/blog/chrome-at-io26)
- [Search Engine Journal: ChatGPT adds WebMCP support](https://www.searchenginejournal.com/chatgpt-adds-webmcp-support/587237/)
- [anthropics/claude-code#76809](https://github.com/anthropics/claude-code/issues/76809)
- [MCP Apps: WebMCP interoperability, modelcontextprotocol/ext-apps#829](https://github.com/modelcontextprotocol/ext-apps/pull/829)
- [WebKit standards position](https://github.com/WebKit/standards-positions/issues/670), [Mozilla standards position](https://github.com/mozilla/standards-positions/issues/1412)
