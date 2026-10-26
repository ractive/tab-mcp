# Connecting an AI app

How to add a page's tab-mcp address to an AI app. AI apps
change their menus often: if a step no longer matches, look for "connector", "MCP
server" or "plugin" in the app's settings. Which apps work at all:
[compatibility](https://github.com/ractive/tab-mcp/blob/main/docs/compatibility.md).

Every app needs the same two things from the page:

1. In the page, click "Connect your AI app" and copy the **address**
   (`https://…/a/…/mcp`). Keep the page and the dialog open until the app shows it
   is connected: the code works only while the dialog is open.
2. When the app asks you to sign in, your browser opens the relay's page
   "Connect … from …". Type the **6-digit code** the page shows (it changes every
   2 minutes) and click Connect.

Keep the defaults for sign-in wherever an app asks (OAuth, no client ID or secret).

## Claude (claude.ai and Claude Desktop)

As of claude.ai on 2026-10-25 and Claude for Mac 3.6556.2.

1. Settings → Connectors → Add custom connector. Enter a name and the address, then
   Add. Claude detects "Sign in now" and "Use Claude's published identity" by itself.
2. Click Connect. Claude Desktop opens your browser and claude.ai asks to finish
   connecting; continue. Type the code, and the browser hands you back to the app.
3. In a new chat, turn the connector on in the tools menu.

The relay's page names the app "Claude from claude.ai" in both cases: the desktop app
signs in as claude.ai.

## ChatGPT on the web

As of chatgpt.com on 2026-10-25 (relay 0.5.1 or later).

1. Open <https://chatgpt.com/plugins> and add an MCP server with the address.
2. Connect, then type the code on the relay's page.

## ChatGPT for Mac and Codex

As of ChatGPT for Mac 26.1016 and Codex 0.163. The Mac app's MCP servers are Codex's
(`~/.codex/config.toml`), so the two need the same feature turned on first:

```sh
codex features enable mcp_2026_07_28
```

- **ChatGPT for Mac:** Settings → Plugins → MCPs → Add. Choose the type
  **Streamable HTTP** (the switch is easy to miss), paste the address, save, then
  Authenticate.
- **Codex:** `codex mcp add <name> --url <address>`, then `codex mcp login <name>` (the
  desktop app shows Authenticate).

Codex loads tools when a chat starts: start a new chat after connecting. Each page has
its own address, so each needs its own entry.

## Claude Code

As of Claude Code 2.1.308 on 2026-10-26.

```sh
claude mcp add --transport http <name> <address>
```

Then run `/mcp` in Claude Code and choose Authenticate.

## When it does not work

- **"Open “Connect your AI app” first" during the sign-in:** the page's dialog is
  closed, or its tab is closed or asleep. Click "Connect your AI app" in the page, then
  Try again.
- **The AI app says the page is not open:** its tab is closed, asleep or disconnected.
  Open it; the address stays the same.
- **"That code has expired":** take the current code from the page.
- **Signed in, but no tools appear (Codex, ChatGPT for Mac):** the feature above is off.
- **"This connection cannot be made":** the app's sign-in is not supported; the page
  says why. Check [compatibility](https://github.com/ractive/tab-mcp/blob/main/docs/compatibility.md).
