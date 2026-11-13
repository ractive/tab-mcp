---
type: operations
title: "tab-mcp for Chrome in the Chrome Web Store"
description: >-
  The release path of tab-mcp for Chrome: the store package, the release and publish
  workflows, the owner's one-time setup, the listing texts, single purpose, permission
  justifications, data disclosures and review notes, and adding the store id to the
  hosted relay before the listing goes public.
tags:
  - operations
  - release
  - extension
timestamp: 2026-11-13T12:00:00+01:00
---

# tab-mcp for Chrome in the Chrome Web Store

Iteration 23 ([iteration-23-extension-release](../iterations/iteration-23-extension-release.md)),
after Overmark's `kb/operations/chrome-web-store.md` (ractive/overmark).

## The store package

`bun scripts/build.ts --store --zip` in `packages/tab-mcp-extension` builds into
`dist-store/` (so it does not replace a development build in `dist/`) and packs
`tab-mcp-for-chrome-<version>-store.zip` next to `package.json`. The manifest has no `key`
(the store gives the item its own id), no `host_permissions` (host access is optional,
asked for with "Read all sites without a click"), the package no source maps, and its scripts not the
test build's hooks (`TAB_MCP_TEST`, a `define`: the functions through which the
end-to-end tests answer notifications). `zipStoreBuild`
refuses to pack a build that has any of these, and `--zip` without `--store` is refused,
since a zip of the development build would carry the owner's key. Every build holds
`LICENSES.txt`.

The zip is reproducible: its entries are sorted, deflated in one zlib call and dated with
`SOURCE_DATE_EPOCH`, else the last commit's time (UTC). Building the tagged commit again
gives the zip whose SHA-256 `extension-release.yml` prints, with the same Bun version.

## Releases

1. Bump `version` in `packages/tab-mcp-extension/package.json` and move the CHANGELOG's
   "tab-mcp for Chrome" Unreleased section to that version, in a PR; merge it.
2. Tag the merge commit and push the tag:

   ```sh
   git tag extension-v0.1.0 <merge commit on main>
   git push origin extension-v0.1.0
   ```

3. `extension-release.yml` checks that the tag is a Chrome version on main and matches
   `package.json`, runs `verify`, builds the store zip, checks its manifest again, and only
   then creates the GitHub release `extension-v<version>` with the zip attached (not
   marked latest, so the relay and client releases stay the latest). A failed build leaves
   no release; the release job stops if the tag moved off the commit it built.

Do not create the release with `gh release create`: then nothing builds the zip
(`release.yml` treats `extension-v*` releases as a no-op). The tag push is the release.

Chrome takes a version of one to four integers (0 to 65535), no suffixes; the store
rejects an upload whose version is not higher than the last one.

## Updates through the publish workflow

The API only updates an item that exists, so the first version goes in by hand (below).
After that: Actions → "Extension publish" → Run workflow, and pick the release's tag under
"Use workflow from" (the default, `main`, fails: the tag the workflow runs on is the tag
it uploads). It downloads the release's store zip, checks that its manifest has the tag's
version, no key, no host access and the zip no source maps, and uploads it with
[mnao305/chrome-extension-upload](https://github.com/mnao305/chrome-extension-upload)
(Chrome Web Store API v2), pinned to the same commit as Overmark's. With "submit" off the
upload stays a draft in the dashboard; with it on, the version is submitted for review.

The action receives the client secret and the refresh token, which can publish every item
of the developer account: it is pinned to a commit and runs in a job that checks out
nothing and installs nothing. Dependabot proposes its updates.

## Owner's one-time setup

1. **Developer account:** the Chrome Web Store developer account that also holds Overmark
   (one-time US$5, two-step verification, trader declaration).
2. **Privacy policy URL:** `https://ractive.ch/tab-mcp/privacy/`. The relay's privacy page
   also covers the extension in its section `#chrome`, the same content as
   [PRIVACY.md](../../packages/tab-mcp-extension/PRIVACY.md)
   ([ractive.ch#88](https://github.com/ractive/ractive.ch/pull/88)); a change to one goes
   into the other.
3. **Tags:** add `refs/tags/extension-v*` to the "release tags" tag ruleset (it holds
   `client-v*` and `relay-v*`), so only the owner can create, move or delete extension
   release tags.
4. **First version by hand:** download the zip from the `extension-v0.1.0` release (or
   build it locally), New item in the
   [developer dashboard](https://chrome.google.com/webstore/devconsole), upload the zip,
   fill in the listing below. The item's id now exists.
5. **The hosted relay:** add `chrome-extension://<store id>` to the hosted relay's allowed
   origins in ractive/ractive.ch (`infra/tab-mcp/variables.tf`, applied through
   `infra/tab-mcp/scripts/tofu-keychain.sh`, plan first), **before submitting for review**:
   the store build connects to `https://tab-mcp.ractive.ch` by default, and the reviewer and
   the first users get "origin not allowed" otherwise. Loading the zip unpacked does not
   check it (an unpacked build gets another id); check it with the item installed from
   the store (Unlisted, after the review): turn on AI access and see an address and a
   pairing code.
6. **Submit for review**, visibility Unlisted for the first version; Public once it works
   from the store.
7. **Publish workflow:** in a Google Cloud project enable the Chrome Web Store API; OAuth
   consent screen External, publishing status **In production** (in "Testing" Google
   expires refresh tokens after seven days); an OAuth client id of type "Web application"
   with `https://developers.google.com/oauthplayground` as redirect URI; in the
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) with that client,
   authorize `https://www.googleapis.com/auth/chromewebstore` with the developer account
   and exchange the code for a refresh token. Overmark's client and token can be reused:
   they cover every item of the account.
8. **Environment:** Settings → Environments → new environment `chrome-web-store`: secrets
   `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`; variables `CWS_PUBLISHER_ID`
   (Publisher → Settings in the dashboard) and `CWS_EXTENSION_ID` (the item's id); yourself
   as required reviewer; deployments limited to tags `extension-v*`.
9. **Afterwards, if wanted:** remove the development build's id
   (`chrome-extension://handeaggdjdkpniflkjlknlcfbjifkng`) from the hosted relay's allowed
   origins the same way. The development build then needs a relay of its own.

## Listing

- **Name:** tab-mcp for Chrome (from the manifest)
- **Summary:** the manifest's `description`, set in `createManifest`
  (`scripts/build.ts`): "Offers the WebMCP tools of the page in front to your AI app
  outside the browser, through a tab-mcp relay." (at most 132 characters)
- **Category:** Developer Tools
- **Language:** English
- **Homepage:** <https://ractive.ch/tab-mcp/>
- **Support:** <https://github.com/ractive/tab-mcp/issues>

**Description:**

> Pages can register tools for AI agents with WebMCP (`document.modelContext`). Chrome
> offers them to agents inside the browser only. This extension passes the tools of the
> page in front on to an AI app outside the browser, such as Claude, ChatGPT, Claude Code
> or Codex, through a tab-mcp relay.
>
> Click the extension's icon on a tab to let it read that tab, then turn on AI access in
> the side panel. It shows an address and a pairing code to add in your AI app. The AI app
> then sees the page's tools, follows the tab in front and can call them.
>
> A tool the page marks read-only runs at once. Every other tool asks you first, in the
> side panel or in a notification, with the AI app's name, the site and the arguments.
> You can allow a tool once, or stop being asked for it on that site.
>
> The AI app can also open pages in the tab in front: an address, back, forward and
> reload. On the page's own site this runs at once, as a link on the page would; going to
> another site asks you first. Each of these answers with the new page's address, title
> and language.
>
> The relay is https://tab-mcp.ractive.ch by default; you can run your own (the relay is
> open source, MIT) and enter its address in the settings.
>
> WebMCP is on in Chrome only where a site takes part in Chrome's origin trial, or after
> you turn on chrome://flags/#enable-webmcp-testing.
>
> The extension reads only tabs you give it, only pages of http(s) sites and no Incognito
> tabs, and only the page's address, title, language and its WebMCP tools. It sends data
> only while AI access is on, only to the relay you chose, and only what your AI app asks
> for. No analytics.

**Single purpose:** Letting an AI app outside the browser that the user connected work
with the page in front, through a tab-mcp relay: passing on the WebMCP tools the page
registered, and opening pages in that tab.

**Permission justifications** (from the README's "Permissions" table):

| Permission | Justification |
|---|---|
| `activeTab` | Read the tab the user clicked the icon on: its address, title, language and the WebMCP tools the page registered, also after the AI app opened another page of the same origin in it. No access to other tabs; another origin in that tab needs another click (or the optional host access). Opening pages in the tab (an address, back, forward, reload) needs no permission; to another origin it asks the user first. |
| `scripting` | Put the content script, which lists and calls the page's WebMCP tools, into that tab. |
| `sidePanel` | The side panel shows the connection's state, the pairing address and code, the tab's tools and the questions before a tool runs or the tab goes to another site. |
| `notifications` | Ask the user before a tool that is not read-only runs, or the tab goes to another site, while the side panel is not in front (Allow; closing it declines). |
| `alarms` | Wake the service worker once a minute while AI access is on, so a connection lost while the computer slept comes back. |
| `http://*/*`, `https://*/*` (optional) | Asked for only when the user clicks "Read all sites without a click": read every http(s) tab's WebMCP tools without a click on the icon. |

**Remote code:** No. All code is in the package. The extension lists and calls only the
tools a page registered itself through the browser's WebMCP API; the relay connection
carries data (MCP requests and results), never code, and no tool runs code an AI app
sends.

**Data usage (Privacy practices tab):**

- Collected:
  - **Web history:** the address (with its query and fragment) and title of the tab in
    front, when the AI app asks for them (`page_info`) and after it opened a page in the
    tab (`navigate`, `go_back`, `go_forward`, `reload`) or a page tool took the tab to
    another page. For back and forward the extension checks, in the page, whether the page
    before or after is on the same origin; that stays in the browser.
  - **Website content:** the page's WebMCP tools (names, descriptions, schemas), and the
    arguments and results of the calls the AI app makes and the user allows.
- Not collected: personally identifiable information, health, financial, authentication
  information, personal communications, location, user activity (clicks, keystrokes).
- Stored locally only (IndexedDB): the relay address, whether AI access is on, a random
  secret for the connection's address, the tools allowed per site. Transmitted only to the
  relay the user chose (by default tab-mcp.ractive.ch, run by the developer) and the AI
  app the user paired, only while AI access is on.
- Certify: not sold to third parties; not used or transferred for purposes unrelated to
  the single purpose; not used to determine creditworthiness or for lending.
- **Privacy policy URL:** the ractive.ch page with PRIVACY.md (setup step 2).

**Review notes** (the "Test instructions" field):

> The extension only passes on tools that a web page registered itself with WebMCP
> (`document.modelContext.registerTool`). To test: in Chrome 149 or later, turn on
> chrome://flags/#enable-webmcp-testing and restart. Open a page that registers WebMCP
> tools (for example any Shopify Liquid storefront, which registers its tools by default).
> Click the extension's icon: the side panel shows the page's tools. Turn on "AI access":
> the panel shows an address and a pairing code. Add the address in an MCP client, for
> example Claude Code: `claude mcp add --transport http tab-mcp-for-chrome <address>`,
> then `/mcp` → authenticate, and enter the pairing code in the browser page that opens.
> Ask Claude to list the page's tools (`webmcp_tools`) or call one; a tool that is not
> read-only asks in the side panel first. Ask it to open another page of the store
> (`navigate`): on the same site it opens at once; ask it to open another site: the side
> panel asks first. No account is needed for the extension or the relay.

Check the example storefront and the Chrome version before each submission.

**Screenshots (1280×800):** the side panel with a page's tools and AI access on; the
pairing address and code with "How do I add it?" open; a question in the side panel
(Don't allow, Allow, Don't ask again on <host>) with the arguments; Claude Code calling a
page tool.

# Citations

- [Chrome Web Store: publish an item](https://developer.chrome.com/docs/webstore/publish)
- [Chrome Web Store: privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Chrome Web Store program policies](https://developer.chrome.com/docs/webstore/program-policies)
- [Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api)
