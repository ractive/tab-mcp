---
type: iteration
title: "Iteration 18: can an extension reach a page's WebMCP tools?"
status: completed
description: "A spike before the extension is built: a test page registers WebMCP tools, and a test extension tries to list and call them from a content script, from a script in the page's own world, and to register tools of its own; the findings decide the WebMCP bridge (iteration 20)."
timestamp: 2026-11-08T20:00:00+01:00
tags: [iteration, extension, webmcp, research]
---
# Iteration 18: can an extension reach a page's WebMCP tools?

The extension ([design](/design/extension.md)) is to offer a page's own WebMCP tools to AI
apps outside the browser. The WebMCP draft defines how a page registers tools
(`document.modelContext.registerTool`) and how scripts in the page list and call them
(`getTools()`, `executeTool()`), but says nothing about extensions beyond naming them as one
kind of browser agent. Whether an extension can reach the tools at all, and from which
world, decides how iteration 20 is built, or whether it is built. So this comes first
(DEC-112).

A spike: small, throwaway where it can be, and its outcome is a research note and a
decision, not a feature.

## Questions

1. **Turning it on.** Which Chrome has WebMCP, and how: the flag in `chrome://flags`, the
   feature name for `--enable-features=` (from Chrome Status or the Chromium source), the
   origin trial token. Does Chrome for Testing have it, headless included, so CI can test it?
2. **From a content script** (the extension's isolated world): is `document.modelContext`
   there? Does `getTools()` return the tools the page registered, with name, description,
   `inputSchema`, `outputSchema` and annotations? Does `executeTool()` run the page's
   `execute` and return its result? Does the `toolchange` event fire there?
3. **From the page's own world** (`chrome.scripting.executeScript` with `world: "MAIN"`,
   or a `content_scripts` entry with `"world": "MAIN"`): the same questions, and how the
   answer gets back to the content script (`window.postMessage` or a `CustomEvent`, and
   what a page can forge on that channel).
4. **Registering from the extension.** Can the content script, or a main-world script,
   call `registerTool()` so the page's `getTools()` lists the extension's tool? Would the
   browser's own agent see it? (This decides whether saved recipes can also be offered
   through WebMCP, iteration 22.)
5. **Edges.** Tools in a cross-origin iframe; a tool unregistered (its signal aborted)
   during a call; an `execute` that never answers; a page without WebMCP; a page that
   replaces `document.modelContext` with its own object (polyfill or forgery).
6. **The polyfill.** Pages using `@mcp-b/global` instead of Chrome's own: does the same
   access work, or does it need its own path?

## Tasks

- [x] Find how to enable WebMCP in Chrome and in Chrome for Testing; write it down with
      the version numbers
- [x] A test page (`test/webmcp-spike/page.html`) that registers three tools: one
      read-only, one consequential, one with `outputSchema`; one more registered after a
      second, to see `toolchange`
- [x] A minimal MV3 test extension (`test/webmcp-spike/extension/`) that tries questions
      2 to 4 from both worlds and reports what it saw
- [x] An automated run of both with the project's Chrome for Testing (the way Overmark's
      end-to-end harness loads an extension); the polyfill case by hand if needed
- [x] Research note `research/webmcp-from-extension.md`: what works, from where, in which
      Chrome, with the exact calls; what does not
- [x] A decision (DEC-113): how the bridge reaches the tools, or that it waits, and
      whether recipes are also registered through WebMCP; iteration 20 and 22 adjusted
- [x] Keep the automated run as a canary test if it is cheap, so a Chrome change shows

## Out of scope

The extension itself (iteration 19), any tools offered to AI apps, and Firefox or Safari.

## Done when

The research note answers questions 1 to 4 for Chrome stable and Chrome for Testing, with
the calls that work, and DEC-113 says how iteration 20 proceeds.

## Outcome

A content script is enough: it lists and calls the page's tools on the native
`document.modelContext`, gets `toolchange`, and can register tools of its own, which the
page can then call too. Chrome 156 has WebMCP behind `--enable-features=WebMCP` (or the
`chrome://flags` entry, or the page's origin trial token), checks no input and drops
`outputSchema` ([research](/research/webmcp-from-extension.md), DEC-113). The spike stays
in `test/webmcp-spike/` (pages in `pages/`, served through the DevTools Protocol on
made-up https origins) with `webmcp.test.ts` as the canary.

# Citations

- [WebMCP draft (2 November 2026)](https://webmachinelearning.github.io/webmcp/)
- [Chrome: WebMCP origin trial (9 June 2026)](https://developer.chrome.com/blog/ai-webmcp-origin-trial)
- [Chrome extensions: content script worlds](https://developer.chrome.com/docs/extensions/reference/api/scripting#type-ExecutionWorld)
