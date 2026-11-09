---
type: design
title: "tab-mcp for Chrome: the browser extension"
description: >-
  A small Chrome extension in this repository that bridges a page's own WebMCP tools
  to AI apps outside the browser, through the relay. Recipes (tools an AI app builds
  for a site) are dropped (DEC-114); user scripts are an experiment of their own.
tags:
  - design
  - extension
  - webmcp
timestamp: 2026-11-09T15:00:00+01:00
---

# tab-mcp for Chrome: the browser extension

## What it is

A page that registers tools with WebMCP (`document.modelContext.registerTool()`, in a
Chrome origin trial since Chrome 149) offers them only to agents in the browser. The
extension offers them to AI apps outside the browser, through the relay. Its content
script reaches them on the native `document.modelContext`, in the top frame (iteration 18,
DEC-113). That is all it does: a small bridge (DEC-114).

- It works only on sites that turn WebMCP on themselves (origin trial token) or for users
  who turned on the flag; the extension cannot turn it on for a page. Many do, mostly
  through platforms: about 1% of Chrome page loads register tools, and a crawl of the
  Tranco top 300k and public lists found about 13,000 sites with tools (1.7% of the top
  100k; Shopify storefronts above all), while agents that call them are still rare
  ([adoption](/research/webmcp-adoption.md)). The bridge brings those tools to AI apps
  outside the browser.
- Tools an AI app builds for a site (recipes) were planned and dropped: guides for
  agents in the browser (Claude in Chrome with site guides such as SiteSkills) give most
  of their benefit without an extension (DEC-114).
- Letting an AI app write user scripts that the extension runs (`chrome.userScripts`) is
  an experiment of its own, iteration 24, not part of the extension until it is decided.

Name: **tab-mcp for Chrome**; docs at `ractive.ch/tab-mcp`, no domain of its own (DEC-109).

## How it fits tab-mcp

```text
AI app ──MCP──▶ relay ◀──WebSocket── service worker (tab-mcp-client, the bridge)
                                        │  chrome.tabs.sendMessage     ▲ port: state ▼ commands
                                        ▼                              side panel (a view)
                           content script in the tab
                           └─ bridges WebMCP tools (getTools / executeTool, DEC-113)
```

- The connection lives in the service worker (DEC-116, iteration 26): it connects to the
  relay with origin `chrome-extension://<id>`, which the relay accepts since 0.7.0
  (DEC-108). A content script cannot connect itself: its requests carry the website's
  origin. A WebSocket that carries messages keeps the worker running (Chrome 116), and
  the relay's heartbeat carries some every 25 s, so the connection stays while the side
  panel is closed; an alarm wakes the worker once a minute while AI access is on, and
  every worker start connects again when the user left it on. The address secret and the
  settings are in IndexedDB in the extension's origin, used by the worker only, out of
  content scripts' reach (threat model A13).
- The tools the AI app sees are registered with `tab-mcp-client`'s `registerTool`; their
  `execute` sends a message to the content script of the tab in front (the active tab of
  the last focused normal window) and returns its answer. Overmark does the same in its
  side panel.
- Pairing, grants and the relay are tab-mcp's as they are; the side panel shows them
  with its own pairing view (the address, the code, the connected apps, New address),
  since the library's dialog would draw into no page. Commands reach the worker only
  over the panel's port (threat model A13).
- Tools that ask first ask in the side panel when it is open in the focused window of the
  tab the call acts on, else in a Chrome notification; the extension asks, not the
  library (iteration 26).

A click on the icon opens the side panel with `sidePanel.open({ tabId, windowId })`.
With the window only, Chrome resolved the call and showed nothing when another
extension had a panel of its own open for the tab (Claude in Chrome's);
`openPanelOnActionClick` shows the panel over it too, but then the click grants no
`activeTab` (both seen in Chrome for Testing 156, 2026-11-09, and in an end-to-end test
with a second extension).

## Permissions

- `activeTab`, `scripting`, `sidePanel`, `storage`, `notifications` (questions while the
  panel is not in front), `alarms` (waking the worker while AI access is on).
- Host access is optional (`<all_urls>` in `optional_host_permissions`): without it the
  extension runs on a tab only after a click on its icon, as Overmark does, and only for
  that origin in that tab (Chrome keeps the grant across navigations on the same origin,
  not to another subdomain). "Allow on all sites" asks for it; the content script is
  then registered for every page.
- No remote code.

## Tools the AI app gets

| Tool | Kind | What it does |
|---|---|---|
| `page_info` | read | Address, title, language, whether WebMCP is available on the page and how many tools it registered (iteration 19) |
| `webmcp_tools` | read | The page's own WebMCP tools: each one's `page_<name>`, whether it only reads, and why a tool is left out (iteration 20) |
| `page_<name>` | as the page marks it | Each page tool, called with `executeTool()`; not read-only means the user confirms each call (iteration 20) |
| `webmcp_call` | as the called tool | Calls a tool of the page in front by its WebMCP name, with the same rules (schema check, confirmation, the page it was listed from); for AI apps that read their tool list once (Claude, Codex), which never see the `page_<name>` tools of a later tab (iteration 20 review, `src/worker/tools.ts`) |

The side panel shows the connection and its apps, the pairing view, questions, the tab in
front with its tools ("reads", "asks first" or "allowed"), and the relay address under
Settings. The icon's badge shows "on", "…" or "?" (a question waits). The connector
carries the extension's icon.

## Risks and how the design meets them

- **The page's hints can lie.** Every result is marked untrusted; every tool not marked
  read-only asks the user each time (side panel or notification), naming the page's
  origin.
- **Prompt injection.** Page tool results reach the AI app; they are marked untrusted,
  and the AI app decides what to do with them, as with any tool. The tools' names,
  descriptions and schemas are the page's words too, and no hint can mark them in a tool
  list: descriptions are cut to a limit and start with the page's origin (iteration 20).
- **A forged `document.modelContext`.** The content script sees the native object only;
  a page that replaces it in its own world fools only itself (iteration 18).

## Releases

Own version and tags (`extension-v0.1.0`), published to the Chrome Web Store from a
release, like Overmark (DEC-109). Relay and client releases stay as they are.

# Citations

- [WebMCP draft, W3C Web Machine Learning Community Group (2 November 2026)](https://webmachinelearning.github.io/webmcp/)
- [Chrome: WebMCP origin trial (9 June 2026)](https://developer.chrome.com/blog/ai-webmcp-origin-trial)
- [SiteSkills: navigation guides for AI browser agents](https://siteskills.ai/)
- [Chrome extensions: userScripts API](https://developer.chrome.com/docs/extensions/reference/api/userScripts)
