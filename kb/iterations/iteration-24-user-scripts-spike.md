---
type: iteration
title: "Iteration 24: can an AI app give a site tools through user scripts?"
status: planned
description: "An experiment: an AI app writes a user script for the site in front, the user sees and allows it, and the extension runs it with chrome.userScripts so the script's functions become tools for the AI app. Finds out what Chrome and the Chrome Web Store allow, how the tools reach the AI app, and what it takes to keep it safe; decides whether it goes into the extension."
timestamp: 2026-11-08T23:00:00+01:00
tags: [iteration, extension, userscripts, research]
---
# Iteration 24: can an AI app give a site tools through user scripts?

Recipes are dropped (DEC-114). What a site's own JavaScript and endpoints offer (its
functions, its API calls with the user's session) could still become tools if an AI app
writes a small script for the site and the extension runs it. Extensions may not run code
they did not ship (Chrome Web Store, Manifest V3), except through `chrome.userScripts`,
the API for user script managers. This experiment finds out whether that path is open to
tab-mcp and worth it. It is a spike: a research note and a decision, not a feature.

## Questions

1. **Chrome.** Which Chrome has `chrome.userScripts` and what the user must turn on (the
   "Allow User Scripts" switch per extension, Developer mode before it); `register`,
   `execute`, `configureWorld`; the `USER_SCRIPT` world and the main world; whether Chrome
   for Testing has it, headless included, so CI can test it.
2. **The Chrome Web Store.** Whether an extension that runs scripts an AI app wrote for
   the user is allowed, or only scripts the user writes or installs; what the listing and
   the review must say.
3. **Tools.** How a script's functions reach the AI app: messages from the user script
   world to the extension (`runtime.sendMessage` with `messaging` in `configureWorld`),
   registered in the side panel with `tab-mcp-client`; or WebMCP (`registerTool` from the
   script, then bridged as in iteration 20).
4. **Safety.** The script runs with the user's session on the site, and page text reaches
   the AI app that writes it (prompt injection). What the user sees before allowing a
   script (the code, a summary), whether a script may make requests to other origins
   (the `USER_SCRIPT` world's CSP), how scripts are bound to their site and turned off.
5. **Worth.** Against Claude in Chrome with site guides: does a script give anything they
   do not (speed, no model in the loop, any MCP app)?

## Tasks

- [ ] Find what Chrome and the Chrome Web Store allow; write it down with versions and
      quotes
- [ ] A test extension in `test/userscripts-spike/` that registers a script given as text
      for a test page and offers its functions as tools (both paths of question 3)
- [ ] An automated run with Chrome for Testing, as `test/webmcp-spike/` does
- [ ] Research note `research/user-scripts.md`
- [ ] A decision: whether user scripts go into the extension, and how; DEC-111's reasons
      (no remote code, steps the user can read) are the bar

## Out of scope

Building it into the extension; Firefox and Safari.

# Citations

- [Chrome extensions: userScripts API](https://developer.chrome.com/docs/extensions/reference/api/userScripts)
- [Chrome Web Store: remotely hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
