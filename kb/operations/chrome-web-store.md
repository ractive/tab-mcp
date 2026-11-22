---
type: operations
title: The tab-mcp browser extension in the Chrome Web Store, Microsoft Edge Add-ons and addons.mozilla.org
description: "The release path of the tab-mcp browser extension: the store package, the release and publish workflows (Chrome Web Store, Microsoft Edge Add-ons, addons.mozilla.org), the zip's build provenance and how to verify it, the owner's one-time setup, the listing texts, single purpose, permission justifications, data disclosures and review notes, and adding the store id to the hosted relay before the listing goes public."
tags:
  - operations
  - release
  - extension
timestamp: 2026-11-14T17:30:00+01:00
---

# The tab-mcp browser extension in the Chrome Web Store, Microsoft Edge Add-ons and addons.mozilla.org

Iteration 23 ([iteration-23-extension-release](../iterations/iteration-23-extension-release.md)),
after Overmark's `kb/operations/chrome-web-store.md` (ractive/overmark).

## The store package

`bun scripts/build.ts --store --zip` in `packages/tab-mcp-extension` builds into
`dist-store/` (so it does not replace a development build in `dist/`) and packs
`tab-mcp-browser-extension-<version>-store.zip` next to `package.json`. The manifest has no `key`
(the store gives the item its own id), no `host_permissions` (host access is optional,
asked for with "Give access to all sites"), the package no source maps, and its scripts not the
test build's hooks (`TAB_MCP_TEST`, a `define`: the functions through which the
end-to-end tests answer notifications). `zipStoreBuild`
refuses to pack a build that has any of these, and `--zip` without `--store` is refused,
since a zip of the development build would carry a `key`. Every build holds
`LICENSES.txt`.

The zip is reproducible: its entries are sorted, deflated in one zlib call and dated with
`SOURCE_DATE_EPOCH`, else the last commit's time (UTC). Building the tagged commit again
gives the zip whose SHA-256 `extension-release.yml` prints, with the same Bun version.

## Releases

1. Bump `version` in `packages/tab-mcp-extension/package.json` and move the Unreleased
   section of `packages/tab-mcp-extension/CHANGELOG.md` to that version, in a PR; merge it.
2. Tag the merge commit and push the tag:

   ```sh
   git tag extension-v0.1.0 <merge commit on main>
   git push origin extension-v0.1.0
   ```

3. `extension-release.yml` checks that the tag is a Chrome version on main and matches
   `package.json`, runs `verify`, builds the store zip and the Firefox store zip, checks
   their manifests again, packs the source archive `tab-mcp-<version>-source.zip` (the
   built commit, with a `SOURCE_DATE_EPOCH` file) and builds the Firefox zip from it again,
   which must give the same bytes; only then does it create the GitHub release
   `extension-v<version>` with the three attached (not marked latest, so the relay and
   client releases stay the latest). A failed build leaves no release; the release job
   stops if the tag moved off the commit it built.
4. Before it creates the release, the release job attests the three files' build
   provenance (below) and verifies the attestations; after it, it checks that each release
   asset has the SHA-256 of the attested file. A file that does not verify leaves no
   release; a release whose asset has another SHA-256 fails the run after the release
   exists, and is deleted by hand.

Do not create the release with `gh release create`: then nothing builds the zip
(`release.yml` treats `extension-v*` releases as a no-op). The tag push is the release.

## Build provenance

The release job signs a [SLSA build provenance](https://slsa.dev/provenance/v1)
attestation for `tab-mcp-browser-extension-<version>-store.zip` with
[actions/attest](https://github.com/actions/attest) (DEC-182): a Sigstore certificate
issued to the workflow run, binding the zip's SHA-256 to the repository, the workflow file
(`extension-release.yml`), the tag and the commit. GitHub keeps it with the repository's
attestations; the run's summary links it. The build job, which runs third-party code,
keeps its read-only token: the zip goes from it to the release job as an artifact, and the
release job prints the zip's SHA-256 next to the one the build job printed.

Check a release's zip by hand before uploading it (GitHub CLI, signed in; any account):

```sh
gh release download extension-v0.1.0 -R ractive/tab-mcp --pattern '*-store.zip'
gh attestation verify tab-mcp-browser-extension-0.1.0-store.zip -R ractive/tab-mcp \
  --signer-workflow ractive/tab-mcp/.github/workflows/extension-release.yml \
  --source-ref refs/tags/extension-v0.1.0
```

`-R ractive/tab-mcp` alone accepts any workflow of the repository; `--signer-workflow`
and `--source-ref` also pin the release workflow and the tag, which is what the publish
workflow checks. A zip built locally from the tag has the same SHA-256 (the zip is
reproducible, above) and so verifies too.

What it covers: the zip on the GitHub release and the zip the publish workflow uploads.
It does not cover the installed extension: the Chrome Web Store serves a CRX it builds and
signs itself (its own signature and the item's id), so a user's copy has another digest and
no attestation of ours.

Chrome takes a version of one to four integers (0 to 65535), no suffixes; the store
rejects an upload whose version is not higher than the last one.

## Updates through the publish workflow

The API only updates an item that exists, so the first version went in by hand (below).
Since then a release publishes itself: after `extension-release.yml` has created the
release, its job `publish` runs
[chrome-extension-publish.yml](https://github.com/ractive/release-workflows/blob/v0.6.0/.github/workflows/chrome-extension-publish.yml)
of ractive/release-workflows (pinned to a commit) in the environment `chrome-web-store`,
which waits for the owner's approval. That job:

1. checks that it runs on the release's tag and downloads the release's store zip;
2. checks that its manifest has the tag's version, no key, no host access and the zip no
   source maps;
3. verifies its build provenance (signed by `extension-release.yml` for that tag; an
   unattested zip stops the run, so the attestation of the release is what the store
   gets);
4. packs it as a CRX3 signed with `CWS_CRX_PRIVATE_KEY` (Verified CRX uploads, below), whose
   CRX id must be `jbpcbkngalkckpjgonfkhhcipjmnnofh`; the CRX wraps exactly the verified
   zip's bytes;
5. uploads the CRX with the Chrome Web Store API v2 and submits it for review.

No third-party code runs in that job: the CRX is packed by Python of the standard library
and `openssl` (byte for byte what `chrome --pack-extension` writes, which release-workflows'
selftest checks against Chrome), the API is called with `curl`. The client secret and the
refresh token can publish every item of the developer account; the signing key can sign
uploads of this item only. Both callers pass `secrets: inherit`: a reusable workflow sees
an environment's secrets only when the caller passes them on, even though its own job runs
in that environment, and a caller outside the environment cannot name them one by one. The
repository has no secrets of its own, so only the environment's reach the job (0.2.0's
publish failed for the lack of it, before the upload; a dry run reads no secrets).

If the publish fails or is rejected, fix the cause and run it again by hand: Actions →
"Extension publish" → Run workflow, pick the release's tag under "Use workflow from"
(the default, `main`, fails) and store `chrome`. "Submit" off leaves the upload as a draft
in the dashboard.

### Verified CRX uploads

The item accepts only uploads signed with our key (dashboard → Package → "Verified CRX
uploads"), so whoever gets into the Google account cannot push an update without it. The
key is an RSA key of its own (not the item's key, which Google holds):
`~/.config/chrome-web-store/tab-mcp-crx-key.pem` on the owner's machine, a copy in the
owner's password manager, and the environment secret `CWS_CRX_PRIVATE_KEY`. It is never
stored in the Google account. Losing it means a week with Chrome Web Store support. Its
public key and CRX id:

```sh
openssl rsa -in tab-mcp-crx-key.pem -pubout                     # pasted into the dashboard
openssl pkey -in tab-mcp-crx-key.pem -pubout -outform DER | shasum -a 256 | head -c 32 | tr 0-9a-f a-p
```

The CRX id is `signing-key-id` in both workflows: a secret with another key fails before
the upload. The installed extension still has the item's id; the store re-signs what it
serves.

## Microsoft Edge Add-ons

The same release goes to its Edge Add-ons item (DEC-194): `extension-release.yml`'s job
`publish-edge` runs beside `publish`, after the release, and calls
[edge-extension-publish.yml](https://github.com/ractive/release-workflows/blob/v0.7.0/.github/workflows/edge-extension-publish.yml)
of ractive/release-workflows (pinned to a commit) in the environment `edge-add-ons`
(required reviewer, tags `extension-v*` only). It runs the same checks of the tag, the
manifest and the zip's build provenance, then uploads the zip itself (Edge takes no CRX
and has no signed uploads) through the Edge Add-ons API v1.1 and submits it for
certification with the notes in the workflow. On failure the log shows Microsoft's error
code and message.

- **Item:** Product ID `a9ff25ac-7200-4573-8eee-69473a630ae7` (the workflows' `product-id`),
  Store ID `0RDCKD10ZWD4`, CRX id `dajcihibbfmlghajafpckpgefkkjgogn`. Edge's store signs with
  its own key, so the id differs from the Chrome Web Store's, and the hosted relay allows
  `chrome-extension://dajcihibbfmlghajafpckpgefkkjgogn` separately. The item was created by
  hand with 0.2.1 (the API updates items, it cannot create one).
- **Credentials:** Partner Center → Microsoft Edge → Publish API: the Client ID and an API
  key, as the environment secrets `EDGE_CLIENT_ID` and `EDGE_API_KEY` of `edge-add-ons`; both
  workflows pass `secrets: inherit`. The key works for every item of the account. **API keys
  expire** (the date is on that page): before then "Create API credentials" makes a new
  key, and the secret takes it. An expired key fails the upload at once with HTTP 401.
- **One submission at a time:** while a version is in certification, a new submission is
  refused with `InProgressSubmission`; the upload to the draft has gone through. Run it
  again by hand once certification is over.
- **By hand:** Actions → "Extension publish" → Run workflow, the release's tag under "Use
  workflow from", store `edge` (or `all`). "Submit" off leaves the package in the item's
  draft in Partner Center.

## addons.mozilla.org

The Firefox build goes to its add-on on addons.mozilla.org (DEC-195):
`extension-release.yml`'s job `publish-firefox` runs beside the other two, after the
release, and calls
[firefox-extension-publish.yml](https://github.com/ractive/release-workflows/blob/v0.8.1/.github/workflows/firefox-extension-publish.yml)
of ractive/release-workflows (pinned to a commit) in the environment `firefox-add-ons`
(required reviewer, tags `extension-v*` only). It checks the tag, the Firefox zip's
manifest (the version, the gecko id `tab-mcp@ractive.ch`, no key, no install-time host
access, no source maps) and both files' build provenance, then uploads the zip through
AMO's API v5 as a new listed version, with the source archive and the notes for the
reviewers in the workflow (how to build it from the source, what it does, how to test it).
On failure the log shows AMO's answer.

- **Add-on:** id `tab-mcp@ractive.ch` (the manifest's `browser_specific_settings.gecko.id`
  and the workflows' `addon-id`). It was created by hand with 0.2.0 (the API adds versions,
  it does not create add-ons). Firefox's extension origin is `moz-extension://<a UUID per
  installation>`, so the hosted relay admits `moz-extension://*` (DEC-189).
- **Source archive:** AMO's reviewers need the source of minified code and the steps to
  build it. `tab-mcp-<version>-source.zip` is `git archive` of the built commit plus a
  file `SOURCE_DATE_EPOCH` with its commit time, which the zip's entries carry (the archive
  has no Git history for `sourceDate`). The release workflow builds the Firefox zip from
  that archive, as the notes tell the reviewers to, and stops when the bytes differ.
- **Credentials:** AMO → Developer Hub → Manage API Keys
  (<https://addons.mozilla.org/developers/addon/api/key/>): the JWT issuer and secret, as
  the environment secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` of `firefox-add-ons`; both
  workflows pass `secrets: inherit`. The key's account must be an author of the add-on.
- **By hand:** Actions → "Extension publish" → Run workflow, the release's tag under "Use
  workflow from", store `firefox` (or `all`). A version AMO already has as a listed version, awaiting
  review or approved, uploads nothing and the run succeeds (a rerun after a run that
  failed past the upload); in any other state (unlisted, rejected, deleted) it is refused,
  since AMO takes each version number once: release a higher version.

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
   build it locally) and verify it (`gh attestation verify`, "Build provenance" above),
   New item in the
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
   `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_CRX_PRIVATE_KEY` (the
   PEM of the signing key); variable `CWS_PUBLISHER_ID` (Publisher → Settings in the
   dashboard); yourself as required reviewer; deployments limited to tags `extension-v*`.
   Then opt in to Verified CRX uploads (Package tab) with the key's public key, after the
   secret is set: from then on the store refuses a zip (opted in 2026-11-16).
9. **The store id:** `jjhddplkjikmbpcobcnfebnglgjomfgh` (submitted 2026-11-16, published
   public the same day: <https://chromewebstore.google.com/detail/tab-mcp-browser-extension/jjhddplkjikmbpcobcnfebnglgjomfgh>). The
   hosted relay allows it (ractive/ractive.ch#120). The development build has the same id
   since DEC-187: its manifest carries the item's public key (`manifest-key.txt`, from
   Package → "View public key" in the dashboard). The old development id
   (`chrome-extension://handeaggdjdkpniflkjlknlcfbjifkng`) left the relay's allowed origins
   with ractive/ractive.ch#120.

## Listing

- **Name:** tab-mcp browser extension (from the manifest)
- **Summary:** the manifest's `description`, set in `createManifest`
  (`scripts/build.ts`): "Lets an AI app outside the browser call the WebMCP tools of the
  page in front and open pages in that tab, through a tab-mcp relay." (130 characters; at
  most 132, which `test/unit.test.ts` checks)
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
> the side panel. Under "Connect your AI app" it shows an address to add to your AI app
> and a code to type when your AI app asks for it. The AI app then sees the page's tools,
> follows the tab in front and can call them.
>
> A tool the page marks read-only runs at once. Every other tool asks you first, in the
> side panel or in a notification, with the AI app's name, the site and the arguments.
> You can allow a tool once, or always allow it on that site.
>
> The AI app can also open pages in the tab in front: an address, back, forward and
> reload. On the page's own site this runs at once, as a link on the page would; going to
> another site asks you first. Each of these answers with the new page's address, title
> and language.
>
> The relay is https://tab-mcp.ractive.ch by default; you can run your own (the relay is
> open source, MIT) and enter its address in the settings.
>
> Chrome's own WebMCP is on only where a site takes part in Chrome's origin trial, or
> after you turn on chrome://flags/#enable-webmcp-testing. Elsewhere, after "Give access
> to all sites", the extension gives https pages a WebMCP of its own as they load.
>
> A page built with the tab-mcp client library and the extension know of each other: a
> call you allowed in the extension is not asked again in the page, and the page can show
> which AI apps reach it through the extension. Only while AI access is on, such a page
> learns the extension's name, that AI access is on, the names and verified hosts of the
> AI apps connected to it, and right before a call you allowed, the tool, its arguments
> and which AI app made the call. While AI access is off, the extension answers no page
> and sends it nothing. A page can still see that the extension is installed where it
> provides WebMCP itself (in browsers without their own), and could try to time its own
> events, which the extension still listens to. A page that was told AI access is on is
> told once that it went off. Nothing else.
>
> The extension reads only tabs you give it, only pages of http(s) sites and no Incognito
> tabs, and only the page's address, title, language and its WebMCP tools (and what a
> page with the tab-mcp client library tells it about itself). It sends your AI app's
> requests and the page's answers only while AI access is on, only to the relay you
> chose, and only what your AI app asks for; a page with the tab-mcp client library gets,
> inside the browser, what is said above. No analytics.

**Single purpose:** Letting an AI app outside the browser that the user connected work
with the page in front, through a tab-mcp relay: passing on the WebMCP tools the page
registered, and opening pages in that tab.

**Permission justifications** (from the README's "Permissions" table):

| Permission | Justification |
|---|---|
| `activeTab` | Read the tab the user clicked the icon on: its address, title, language and the WebMCP tools the page registered, also after the AI app opened another page of the same origin in it. No access to other tabs; another origin in that tab needs another click (or the optional host access). Opening pages in the tab (an address, back, forward, reload) needs no permission; to another origin it asks the user first. |
| `scripting` | Put the content script, which lists and calls the page's WebMCP tools, into that tab. |
| `sidePanel` | The side panel shows the connection's state, the pairing address and code, the tab's tools and the questions before a tool runs or the tab goes to another site. |
| `notifications` | Ask the user before a tool that is not read-only runs, or the tab goes to another site, while the side panel is not in front ("Allow once"; closing it declines). |
| `alarms` | Wake the service worker once a minute while AI access is on, so a connection lost while the computer slept comes back. |
| `http://*/*`, `https://*/*` (optional) | Asked for only when the user clicks "Give access to all sites": read every http(s) tab's WebMCP tools without a click on the icon. Or only the relay's site, when the user turns on the "Fill in the code for me" switch (off by default): on the relay's pairing page, read the AI app's name and host and the request's id from the form and, after the user allows it (or, for an AI app's host the user chose "Always allow" for, with a notification instead of a question), fill in the extension's pairing code and submit the form. |

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
  secret per relay that identifies this installation to it, the connected AI apps as the
  relay last listed them (grant id, name, verified host), the tools allowed per site, and
  with "Fill in the code for me" on its relay and the hosts chosen for "Always allow"
  (PRIVACY.md has the full list). Transmitted only to the
  relay the user chose (by default tab-mcp.ractive.ch, run by the developer) and the AI
  app the user connected, only while AI access is on; and, inside the browser, to a page
  that uses the tab-mcp client library, only while AI access is on: the extension's
  name, that AI access is on, the connected AI apps' names and verified hosts, and for a
  call the user allowed, the tool, its arguments and which AI app made it (and, once,
  that AI access went off).
- Certify: not sold to third parties; not used or transferred for purposes unrelated to
  the single purpose; not used to determine creditworthiness or for lending.
- **Privacy policy URL:** the ractive.ch page with PRIVACY.md (setup step 2).

**Review notes** (the "Test instructions" field):

> The extension only passes on tools that a web page registered itself with WebMCP
> (`document.modelContext.registerTool`). To test: in Chrome 149 or later, turn on
> chrome://flags/#enable-webmcp-testing and restart. Open
> https://ractive.ch/tab-mcp/examples/diagram/, a diagram editor that registers its tools
> with WebMCP (by the extension's developer). Click the extension's icon: the side panel shows the page's tools. Turn on "AI access":
> under "Connect your AI app" the panel shows an address and a code. Add the address in an
> MCP client, for example Claude Code: `claude mcp add --transport http tab-mcp-browser-extension <address>`,
> then `/mcp` → authenticate, and type the code on the sign-in page that opens.
> Ask Claude to draw a small flowchart in the page; a tool that is not read-only (such as
> `page_add_shapes`) asks in the side panel first. Ask it to open https://ractive.ch/tab-mcp/
> (`navigate`): on the same site it opens at once; ask it to open another site: the side
> panel asks first. No account is needed for the extension or the relay.

Check the diagram example and the Chrome version before each submission.

**Store icon (128×128):** `packages/tab-mcp-extension/assets/store/icon-128.png`, the
extension's icon at 96×96 with 16 px transparent on each side, as the
[image guidelines](https://developer.chrome.com/docs/webstore/images#icons) ask; the
manifest's `icons/icon-128.png` fills its square. `bun scripts/icons.ts` renders both
from the relay's `favicon.svg`.

**Promo tiles (24-bit PNG, no alpha):** `assets/store/promo-small.png` (440×280) and
`assets/store/promo-marquee.png` (1400×560), in the look of tab-mcp's card image on
ractive.ch (`static/images/tab-mcp-preview.svg`): its green, the wordmark "tab-mcp" with
"for Chrome" and "let your AI app use the tab in front", and its drawing of a browser tab
and an AI app joined through the relay as the MCP logo; no screenshots and little text,
as the [image guidelines](https://developer.chrome.com/docs/webstore/images#promo) ask.
`bun scripts/promo.ts` draws them in Chrome for Testing (`CHROME_PATH`) and flattens them
with ImageMagick; the drawing is copied into the script, so take them again when the card
image changes.

**Screenshots (1280×800, light):** in `packages/tab-mcp-extension/assets/store/`, each the
diagram editor example on ractive.ch (live) beside the side panel, in the look of
iteration 39 ([the look](../design/extension-look.md)):

1. `1-tools.png`: AI access on, Claude Code paired, the page's 8 tools ("reads", the
   "Always allow" switches, three of them on, and "Always allow all") and "Give access
   to all sites"; in the page, the diagram the AI app drew through them (AI app → relay
   → extension → "You allow?" → page tools);
2. `2-pairing.png`: no AI app paired yet, the address and the pairing code; the diagram
   still empty;
3. `3-question.png`: a question for `page_update_elements` in the dialog over the panel,
   with its arguments, the time left and its bar (Don't allow, "Allow once", "Always
   allow on ractive.ch", all of one button kind, DEC-180);
4. `4-navigation.png`: a question before the tab goes to another site (the repository
   on GitHub).

Taken again on 2026-11-15 on the diagram example instead of a made-up shop page (owner:
a real page the reviewer can open); the script moves the pointer off the dialog before
shots 3 and 4 and scrolls the page to its heading.

`bun scripts/screenshots.ts` in `packages/tab-mcp-extension` takes them again, from the
store build in Chrome for Testing (`CHROME_PATH`, as for the end-to-end tests), with a relay
in the process whose addresses read as the hosted relay's; the page's requests (ractive.ch
and its CDN) go to the network. Take them again when the panel's
look changes, and look at each before the upload. A fifth one, an AI app calling a page
tool, is taken by hand if wanted.

# Citations

- [Chrome Web Store: publish an item](https://developer.chrome.com/docs/webstore/publish)
- [Chrome Web Store: privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Chrome Web Store program policies](https://developer.chrome.com/docs/webstore/program-policies)
- [Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api)
