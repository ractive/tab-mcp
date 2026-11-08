---
type: iteration
title: "Iteration 21: tools an AI app builds for a site (recipes)"
status: planned
description: "An AI app drafts a tool for the site in front as a recipe (inputs and steps the extension runs), tries it, and the user saves it; saved recipes are offered as tools on that site on every visit. Overmark's element matcher is copied in to find elements again."
timestamp: 2026-11-08T20:00:00+01:00
tags: [iteration, extension, recipes]
---
# Iteration 21: tools an AI app builds for a site (recipes)

The heart of the extension ([design](/design/extension.md)): a site without tools of its
own gets them from the AI app, once, and keeps them. A tool is a recipe, data the
extension runs, never code (DEC-111).

## Scope

1. **Recipe format** `tab-mcp-recipe/1` (JSON): name, title, description, site (origin
   and a path pattern), `inputSchema`, `readOnly`, `consequential`, steps. Step kinds are a
   fixed list: `fill`, `select`, `check`, `click`, `press`, `wait`, `read`, `scroll`,
   `navigate` (same origin only). Placeholders `{{input}}` only in values. Validated with
   limits on steps, sizes and names; anything else is refused.
2. **Element targets** are the element details Overmark records (tag, role, accessible
   name, text, readable classes, test id, heading above, selector), found again with
   Overmark's matcher, **copied** into this package (DEC-110): `match.ts`,
   `candidates.ts`, `element.ts`, `classes.ts`, `shadow.ts`, the element types from
   `case.ts`, and their tests, from `ractive/overmark` at a named commit. Each copied file
   names its source and commit in its header. A step whose element is not found, or only
   probably found, stops the run and says which step.
3. **Runner** in the content script: steps in order, each with a timeout; `wait` for an
   element or text; `read` returns text (cut to a limit, marked untrusted); the run's
   answer lists each step's outcome.
4. **Tools for the AI app**:
   - `draft_tool` (writes nothing stored): create or replace a draft recipe for the site
     in front; refuses invalid recipes with the reason;
   - `test_tool` (acts on the page, consequential): run a draft with inputs; the user
     confirms the first run of a draft, seeing its steps in words;
   - `save_tool` (consequential): keep the draft for this site; the confirmation shows
     the steps in words and whether the tool changes things;
   - `delete_tool` (consequential).
5. **Saved recipes** are offered as tools under their own names on pages that match their
   site; a consequential one asks the user on each run; they come and go with the tab in
   front.
6. **Storage**: IndexedDB in the extension, per origin; export and import come in
   iteration 22.

## Tasks

- [ ] Copy the matcher and its tests from Overmark (commit named), adapt imports; tests pass
- [ ] Recipe types, validation and limits, with tests for every refusal
- [ ] Runner with step outcomes, timeouts, the stop at a missing element; unit tests on
      happy-dom pages
- [ ] `draft_tool`, `test_tool`, `save_tool`, `delete_tool`; saved recipes as tools
- [ ] Plain-language rendering of steps for the confirmations
- [ ] End-to-end: an MCP client drafts, tests and saves a recipe on a test form page;
      the recipe is offered after a reload; a changed page (renamed classes, moved fields)
      still runs it; a removed field stops it at the right step
- [ ] Threat model update (prompt injection, acting as the user); review; merged on the
      owner's word

## Out of scope

Recipes that call a site's own HTTP endpoints (open question); sharing recipes
(iteration 22); a shared matcher package (DEC-110 keeps the copy for now).

# Citations

- [Chrome Web Store: remotely hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
