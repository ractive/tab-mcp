---
type: design
title: "tab-mcp for Chrome: the browser extension"
description: >-
  A Chrome extension in this repository that brings tab-mcp to sites that do not
  build it in: it bridges a page's own WebMCP tools to AI apps, and lets an AI app
  build tools for a site as recipes the extension runs, kept per site and offered
  again on the next visit.
tags:
  - design
  - extension
  - webmcp
timestamp: 2026-11-08T20:00:00+01:00
---

# tab-mcp for Chrome: the browser extension

## What it is

Today a site offers tools to AI apps only when it builds in `@ractive-ch/tab-mcp-client`.
The extension brings the same to any site the user allows, in two ways:

1. **A page's own WebMCP tools.** A page that registers tools with
   `document.modelContext.registerTool()` (WebMCP, in a Chrome origin trial since Chrome 149)
   offers them only to agents in the browser. The extension offers them to AI apps outside
   the browser, through the relay. Its content script reaches them on the native
   `document.modelContext`, in the top frame; pages with only the `@mcp-b/global`
   polyfill are not bridged (iteration 18, DEC-113).
2. **Tools an AI app builds for a site.** The AI app reads the page, writes a tool as a
   recipe (inputs, then steps such as "fill the field labelled Postleitzahl, click
   Prämien berechnen, read the result"), tries it, and the user saves it. The extension
   keeps recipes per site and offers them again on the next visit. A recipe is data the
   extension runs, never code (DEC-111).

Name: **tab-mcp for Chrome**; docs at `ractive.ch/tab-mcp`, no domain of its own (DEC-109).

## How it fits tab-mcp

```text
AI app ──MCP──▶ relay ◀──WebSocket── side panel (tab-mcp-client)
                                        │  chrome.tabs.sendMessage
                                        ▼
                           content script in the tab
                           ├─ reads the page (outline, elements)
                           ├─ runs recipes (copied matcher finds elements again)
                           └─ bridges WebMCP tools (getTools / executeTool, DEC-113)
```

- The side panel is an extension page: it connects to the relay with origin
  `chrome-extension://<id>`, which the relay accepts since 0.7.0 (DEC-108). A content
  script cannot connect itself: its requests carry the website's origin.
- The tools the AI app sees are registered in the side panel with `tab-mcp-client`'s
  `registerTool`; their `execute` sends a message to the content script of the tab in
  front and returns its answer. Overmark does the same today.
- Pairing, grants, confirmations and the relay are tab-mcp's as they are. Consequential
  tools ask the user each time in the side panel (the library's confirmation).

## Permissions

- `activeTab`, `scripting`, `sidePanel`, `storage`, `unlimitedStorage` if recipes grow.
- Host access is optional (`<all_urls>` in `optional_host_permissions`): without it the
  extension runs on a tab only after a click on its icon, as Overmark does. "Allow on all
  sites" asks for it.
- No remote code. Recipes are JSON validated against a fixed set of step kinds.

## Tools the AI app gets

| Tool | Kind | What it does |
|---|---|---|
| `page_info` | read | Address, title, language, size of the tab in front |
| `page_outline` | read | Landmarks, headings, forms with their fields and labels, buttons and links with their accessible names; each with an element reference, cut to a size limit |
| `find_elements` | read | Elements by text, role, label or test id, with references |
| `webmcp_tools` | read | The page's own WebMCP tools (iteration 20) |
| `draft_tool`, `test_tool` | changes nothing stored; `test_tool` acts on the page | Write a recipe and try it with inputs; the answer has each step's outcome |
| `save_tool`, `delete_tool` | consequential | Keep or remove a recipe for this site; the user confirms, seeing the steps in words |
| saved recipes | per recipe | Offered under their own names on the site they were made for |

Generic acting tools (`click`, `fill`) exist only inside recipes and `test_tool`, so every
action the AI app takes on a page is one the user can read as a step first.

## Recipes

```json
{
  "format": "tab-mcp-recipe/1",
  "name": "calculate_premium",
  "title": "Calculate the premium",
  "description": "Fills postcode and year of birth, starts the calculation, returns the cheapest premium.",
  "site": { "origin": "https://www.comparis.ch", "path": "/krankenkassen/*" },
  "inputSchema": { "type": "object", "properties": { "postcode": { "type": "string" }, "born": { "type": "integer" } }, "required": ["postcode", "born"] },
  "readOnly": false,
  "consequential": false,
  "steps": [
    { "do": "fill", "target": { "role": "textbox", "name": "Postleitzahl" }, "value": "{{postcode}}" },
    { "do": "fill", "target": { "role": "textbox", "name": "Jahrgang" }, "value": "{{born}}" },
    { "do": "click", "target": { "role": "button", "name": "Prämien berechnen" } },
    { "do": "wait", "for": { "text": "Ihre Prämien" }, "timeoutMs": 10000 },
    { "do": "read", "target": { "landmark": "main", "selector": "[class*=cheapest]" }, "as": "result" }
  ]
}
```

- A target is the element details Overmark's matcher uses (tag, role, accessible name,
  text, readable classes, test id, heading above, selector), so a recipe survives a
  redesign as well as Overmark's marks do (copied matcher, DEC-110).
- Step kinds are a fixed list: `fill`, `select`, `check`, `click`, `press`, `wait`,
  `read`, `scroll`, `navigate` (same origin only). No `eval`, no script, no request to
  another origin.
- `{{input}}` placeholders only in values; inputs are checked against `inputSchema`
  first. Results are page text and carry `untrustedContentHint`.
- A run stops at the first step whose element is not found and says which step: the
  recipe is then shown as broken in the side panel, and the AI app can mend it.

## Risks and how the design meets them

- **Prompt injection.** Page text reaches the AI app; it may ask it to build or run a
  harmful recipe. Saving a recipe, and every run of a consequential one, needs the
  user's click in the side panel, with the steps in words. Results are marked untrusted.
- **It acts as the user.** A recipe runs with the user's session. Recipes are bound to
  their site; `navigate` stays on that origin; consequential recipes confirm each run.
- **Imported recipes** (shared between people) are untrusted: shown step by step and
  off until the user turns them on.
- **Sites change.** The matcher finds elements again; a step it cannot find marks the
  recipe broken instead of acting on the wrong element.

## Releases

Own version and tags (`extension-v0.1.0`), published to the Chrome Web Store from a
release, like Overmark (DEC-109). Relay and client releases stay as they are.

# Citations

- [WebMCP draft, W3C Web Machine Learning Community Group (2 November 2026)](https://webmachinelearning.github.io/webmcp/)
- [Chrome: WebMCP origin trial (9 June 2026)](https://developer.chrome.com/blog/ai-webmcp-origin-trial)
- [Chrome Web Store: remotely hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
