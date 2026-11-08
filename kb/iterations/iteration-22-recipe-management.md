---
type: iteration
title: "Iteration 22: managing a site's tools in the side panel"
status: planned
description: "The side panel lists the saved tools of the site in front: their steps in words, rename, turn off, delete, export and import (imports off until the user turns them on), a broken tool marked with the step that failed; recipes also registered through WebMCP if DEC-113 allows."
timestamp: 2026-11-08T20:00:00+01:00
tags: [iteration, extension, recipes]
---
# Iteration 22: managing a site's tools in the side panel

Recipes the AI app saved are the user's: they see them, keep them working, and share them.

## Scope

1. **List** of the saved tools for the site in front (and all sites, grouped): name,
   description, read-only or not, last run and its outcome.
2. **Details**: the steps in words, the inputs; rename, turn off and on, delete (asks
   once more).
3. **Broken tools**: a run that stopped at a missing element marks the tool broken with
   that step; the AI app sees it in the tool's description and can mend it with
   `draft_tool` and `save_tool`.
4. **Export and import**: a file with one or more recipes. An imported recipe is shown
   step by step and stays off until the user turns it on; its texts are whoever wrote the
   file's (untrusted).
5. **WebMCP**: saved recipes can also be registered with
   `document.modelContext.registerTool()` from the content script, so agents in the
   browser can use them too (DEC-113). Off by default, a switch per site: the page itself
   can call them as well, so a consequential recipe still asks in the side panel on
   every run, whoever calls it.

## Tasks

- [ ] Side panel list, details, rename, on/off, delete
- [ ] Broken state from the runner; shown to the user and the AI app
- [ ] Export and import with validation; imports off until turned on
- [ ] Registration through WebMCP behind the per-site switch, with a test that a call
      from the page runs the recipe and a consequential one waits for the side panel
- [ ] Unit and end-to-end tests; review; merged on the owner's word

# Citations

- [WebMCP draft (2 November 2026)](https://webmachinelearning.github.io/webmcp/)
