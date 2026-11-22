# The tab-mcp browser extension

A Chrome extension that offers the page in front to your AI app outside the browser,
through a tab-mcp relay. It is the WebMCP bridge of tab-mcp (DEC-114 in `kb/`): pages that
register tools with [WebMCP](https://webmachinelearning.github.io/webmcp/)
(`document.modelContext.registerTool()`) offer them only to agents in the browser; the
extension passes them on (iterations 19 and 20). A page needs nothing of tab-mcp for
this. How the extension, the relay and the client library fit together, with a picture:
[How the parts fit together](../../README.md#how-the-parts-fit-together).

Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/tab-mcp-browser-extension/jjhddplkjikmbpcobcnfebnglgjomfgh). Privacy policy: [PRIVACY.md](PRIVACY.md).

## Tools

| Tool | What it does |
|---|---|
| `page_info` | The tab in front: address (with its query and fragment), title, language, whether WebMCP is available on the page and how many tools it registered. Read-only; its text is the page's own (untrusted). |
| `webmcp_tools` | The page's WebMCP tools: each one's `page_<name>`, title, description, input schema (what `webmcp_call` checks the arguments against; 192 KB of schemas together at most, past that a tool says where its schema is), whether it only reads, whether it is destructive (as its `page_<name>` tool's hint), and why a tool is left out; empty with the reason when the tab has none or may not be read. |
| `page_<name>` | One per tool the page in front registered. The list follows the tab in front and the page's `toolchange`. Its hints for the AI app: `readOnlyHint` as the page marks it; `destructiveHint` false for a read-only tool, else as the page's `consequentialHint`, and true when a page that registers its tools with WebMCP itself gave the tool no annotations at all (nothing known). A page built with the tab-mcp client library always gives them: a tool without hints is not consequential there, so not destructive. The hint only describes the tool: every tool that is not read-only asks you all the same. |
| `webmcp_call` | Calls a tool of the page in front by its name, with the same rules. For AI apps that read their tool list once (Claude, Codex): a `page_<name>` tool that came with a later tab is not in their list, but `webmcp_call` reaches it. |
| `navigate` | Opens an http(s) address (or one relative to the page, `/sale`) in the tab in front, waits until it has loaded and answers with its `page_info`. |
| `go_back`, `go_forward` | Back or forward one page in that tab, as the browser's buttons do, with the new page's `page_info`. |
| `reload` | Reloads the page in that tab, with its `page_info`. |

The navigation tools act only on a tab the extension may read now (a click on its icon
there, or "Give access to all sites"); on any other tab they do nothing and say why:

- On the page's own origin (scheme, host and port) they run at once, as a link on the
  page would.
- To another origin they ask you first, in the side panel or a notification as page tools
  do, naming the site the tab is on and the address it would open; "Allow once" and Don't
  allow only, no "Always allow on <host>" (a page's text could tell the AI app to go anywhere). Back or
  forward to a page the extension cannot see (another origin: Chrome lists only the
  page's own) asks too, saying its address is not known. A reload never asks.
- Only `http:` and `https:` addresses, without a user name or password.
- Without "Give access to all sites", Chrome lets the extension read the new page of another
  origin only after a click on its icon there; the answer says so.
- They wait up to 30 s for the page to load; after that the answer says it is still
  loading.

The page's tools are the page's word:

- Their descriptions reach the AI app starting with the page's origin (`From
  https://shop.example: …`), cut to 8000 characters (room for a page's how-to, as WebMCP has no server instructions), and all of a page's descriptions together to 64 KiB, the longest cut first; titles to 100. The origin is the one
  Chrome reports for the tab: a page that says it is another site gets no tools.
- A tool the page marks read-only runs at once; every other one asks you each time
  (see "Questions" below). "Always allow on <host>" in a question, or switching on
  the tool's "Always allow" in the panel's list, allows the tool on that site (exact origin)
  for every connected AI app, kept until you switch it off again. The switch
  "Always allow all" over the list does that for every tool listed at that moment that
  asks first, in one step. It is on once none asks; turned off, every one asks again. A
  tool the page registers later asks first, and the switch is off again. When the page
  changes which tools it is for, it waits 750 ms before it takes a click. All of these only for pages of an http(s)
  site: pages with an opaque origin (`null`, such as sandboxed pages) always ask ("asks
  first", no switch).
- A call runs only on the page its tool was listed from, and only if the tool still
  makes the read-only claim it was offered with; after a navigation, or a tool that
  changed (also while you were asked), the AI app is told to list the tools again. An
  answer is for the tool as you were asked about it: a page that registers it again
  with another title, description, schema or hint meanwhile gets nothing run.
- A tool that takes the tab to another page (a checkout, a search) is not a failure: the
  answer says the page changed while the tool ran, that the tool may have completed, and
  gives the new page's `page_info` once it has loaded; its tools are offered by then.
- Arguments are checked against the tool's schema before the call (without the schema's
  regular expressions, which a page could make freeze the extension; the page checks those
  itself; a parameter that is called `pattern` stays). The schema the AI app gets has no
  `pattern` either: each one is added to its property's description instead ("Must match
  the regular expression …", cut to 200 characters), and so are the names
  `patternProperties` allows. Without them the check only ever lets through more than the
  page's schema, never less: a restricting `additionalProperties` beside
  `patternProperties`, an `unevaluatedProperties` or `unevaluatedItems` above them, a
  `not` or `if` around them and a `maxContains` go too, and a `oneOf` becomes an `anyOf`.
  A call that the page does not
  answer in 60 s ends for the AI app, also when the page is stuck; cancelling in the AI
  app cancels it in the page. A page that does not answer the extension's other questions
  (its tools, `page_info`) in 5 s is given up, so a stuck page cannot hold the other
  tabs. Results are marked untrusted; their text, all blocks together, is cut to 100,000
  characters, and a result over 2 MiB is refused. A page that answers with an MCP result
  (as `@mcp-b/global` pages do) gets its text blocks and images through, at most 32
  blocks, the images of one result up to 640 KiB of base64 together (about 480 KB of
  image data; an image beyond that is replaced by a note), so that a result stays within
  the relay's default 1 MiB per response. A result that is the JSON of another object
  (within the 100,000 characters, and without a `content` key) reaches the AI app as text
  and as `structuredContent`. A result that is a JSON-encoded string (`"Hello"`, as the
  WebMCP draft encodes every result; Chrome 156 passes strings on as they are) is that
  string.
- A tool's `outputSchema` (the WebMCP draft has it; Chrome 156 does not give it) is shown
  in `webmcp_tools`, but not declared on its `page_<name>` tool: an AI app expects every
  result of a tool with an output schema to carry matching `structuredContent`, which a
  page's text result does not.
- Names: `page_<name>`, other characters than letters, digits, `_` and `-` as `_`, at most
  64 characters in all: the Anthropic API takes no other tool names, and Claude drops the
  rest without a word.
- Left out: tools whose `page_<name>` would be longer than 64 characters, the same as
  another's or the same as one of the extension's own tools (a page tool `info` would be
  `page_info`), and tools the client library refuses (none of them can be called through
  `webmcp_call` either), a schema that is no object schema or over 16 KB, tools marked
  `debugging` (WebMCP's hint for tools meant for the page's developers), and more than
  64 tools. `webmcp_tools` lists each of them with the reason.
- Tools a tab-mcp page mirrors into WebMCP (the client library's `webmcp: true`) are
  offered like any other: the extension cannot know whether your AI app is also paired
  with the page itself. An AI app connected to both sees such a tool twice, once from
  each connector. Such a page and the extension know of each other (DEC-207, client
  library 0.19.0 and later): a call you allowed here is not asked again in the page
  (the extension vouches for that one call, right before it runs), the page can show
  which AI apps reach it through the extension, and the panel says "This page has
  tab-mcp built in." and when an AI app is connected to the page directly too (it then
  sees the page's tools twice: disconnect it in one of the two). The extension tells
  such a page only its name and version, whether AI access is on and the AI apps
  connected now (name and verified host); a page without the library is told nothing.
- The top frame's WebMCP, which lists the tools of the page and of its same-origin
  frames (the draft and Chrome's documentation say so; not tested here); tools of
  frames of other origins are not listed. Only the browser's own WebMCP: a page's
  replacement `document.modelContext` (or a polyfill without native WebMCP) is not used.
- Only pages of http(s) sites, not `file:` pages, and not Incognito tabs (the extension
  cannot be allowed there).
- The extension reads a page's tools (`getTools()`) only while the side panel is open or
  the connection to the relay is up (or being made), and one read answers everything it
  asks the page within 1 s, unless the page's tools change (`toolchange`) meanwhile; a
  call to a tool reads them anew. Chrome can crash when a tab navigates while such a read
  is pending (Chromium issue 585631961, `kb/operations/chrome-webmcp-crash.md`); fewer
  reads make that rarer, but only Chrome can fix it.

## Install and use it

Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/tab-mcp-browser-extension/jjhddplkjikmbpcobcnfebnglgjomfgh),
or build it and load it unpacked (development; it has the store's id, so the two can't
share a Chrome profile):

```sh
bun run build            # in packages/tab-mcp-extension: writes dist/
```

Then `chrome://extensions`, Developer mode on, "Load unpacked", choose `dist/`.

- Click the extension's icon on a tab: the side panel opens (also over another
  extension's panel for that tab, such as Claude in Chrome's), and the extension may read
  that tab, also after navigations on the same origin, until the tab goes to another
  origin (`www.example.com` is another origin than `example.com`).
  "Give access to all sites" in the side panel lets it read every http(s) tab
  without a click; Chrome asks first ("Read and change all your data on all
  websites"). On a tab it may not read, a notice in the
  panel says to click the icon in the toolbar (or that Chrome does not let extensions
  read the page); on a tab it may read whose tools could not be read
  (the page changed meanwhile, or says it is another site), the notice says that.
  On a page without tools it says so, that `page_info` and the navigation tools still
  work, and, where WebMCP is off, how Chrome turns it on.
- "Turn on AI access" (or the switch beside the card's heading "AI access") connects to
  the relay. While no AI app is connected, a line under the heading says what the
  extension does and names the relay. With no AI app connected yet ("On · no AI app
  connected yet"), the panel shows "Connect your AI app": the address for your AI app and a pairing
  code at once, with a note to use the AI app outside this Chrome profile (a chat in a
  tab of the same profile becomes the tab in front while you type in it). The address
  is `<relay>/s/tab-mcp-extension/mcp`, the same for everyone who has the extension;
  the code (8 letters, `XXXX-XXXX`) pairs the AI app with this installation.
  "How do I add it?" under the address says how to add it in Claude, ChatGPT, Claude Code
  and Codex (the client library's steps, the commands each with a Copy), and links to the
  [connect page](https://ractive.ch/tab-mcp/connect/). A Copy the clipboard refuses
  selects the text in place to copy by hand. Connected AI apps are listed, each with a dot
  (green while connected, grey while off or connecting); while connected each has a
  Disconnect button (which asks first, and takes no double click). Only the relay can
  disconnect an AI app, so while off or connecting the list has no Disconnect and says why;
  the list is kept from the relay's last one, also across a restart of the extension.
  "+ Connect another AI app" shows the address and a code again. The address shows only
  while pairing. Off with apps paired, the panel says "AI access is off · your AI apps
  stay connected for next time". The relay address is under "Settings". Where you name the connector
  yourself (Claude, ChatGPT), a name such as "Browser" helps: "in my browser" then leads
  the AI to it (the Claude Code and Codex commands name it `tab-mcp-browser-extension`). The
  extension's instructions and `page_info` tell the AI to call `page_info` first when you
  refer to a page in your browser.
- The connection lives in the extension's service worker, not in the side panel: close
  the panel and AI access stays on, until the switch turns it off. It comes back by itself after a
  browser start, an update or a reload of the extension when you left it on. While the
  relay cannot be reached, the panel says "Connection lost · reconnecting…" and the extension
  tries again every minute. The icon
  shows "on" while it is connected, "…" while it connects or retries, "?" while a tool asks. If
  another tab or program takes the extension's connection over (it connects with the
  extension's secret), the extension does not take it back by itself, also after a
  restart: the panel says so and offers "Disconnect all apps" (or Connect, to take it
  back). "Disconnect all apps", also under the pairing code, disconnects every AI app
  and makes a new secret; the address stays, and each AI app connects again with a new
  code. With apps paired, the button under the code asks for a second click first.
- The "Fill in the code for me" switch, under the code, turns on filling in its code on
  the relay's sign-in page when an AI app opens it in this browser (an AI app on the
  desktop opens it in the default browser). It is off by default, also with access to
  all sites. Unless the extension has the relay's site already, Chrome first asks ("Read
  and change your data on tab-mcp.ractive.ch"); declined, the switch goes back to off.
  From then on, while AI access is on, the panel (or a notification) asks "Connect <AI
  app> (<host>) to the tab-mcp browser extension?"; Allow writes the code into the
  page's field and clicks Connect. Typing the code by hand works as before, also while
  the question waits. For an AI app whose verified host is a public name (not
  `localhost`, an IP address or a private or test name such as `.lan` or `.test`), the question offers "Don't allow", "Allow
  once" and "Always allow": "Always allow" fills in the code for that host from then on
  without asking, each time with a notification and a line in the panel ("Filled in the
  code for <AI app> (<host>)."), at most 3 times per host in 10 minutes before it asks
  again. "Filled in without asking for:", under the switch, lists those hosts, each with
  Remove; turning the switch off or using another relay forgets them all. It relies on
  the AI app tying each sign-in to the account of the browser that started it (Claude
  does: a sign-in started in another account ends with "Account mismatch"). Turned off, it gives the relay's site back (not access to all
  sites); another relay under "Settings" starts off. The switch is on only while the
  relay's site is granted: taken away in Chrome's settings, filling in goes off (the
  line under the switch says so) and stays off until turned on again. See [Filling in
  the code](#filling-in-the-code).

## Questions

A tool that asks first asks in the side panel when the panel is open in the window of the
tab the tool acts on, that window is in front, and the panel is not covered by another
extension's panel for the tab (a question it shows goes out as a notification once it is
covered): "Allow once" and "Always allow on <host>" work once the
panel has been in front for 750 ms, so the click that brings it forward cannot approve
(until then they keep their focus and place in the tab order, `aria-disabled`, and take
no click). The panel's question names the AI app and the tool, then, each on a line of
its own, the site the tool acts on ("Site (verified)") and the page's title for the tool
("Title (from the page)"), the arguments in full (they scroll when long) and the seconds
left to answer. Its three buttons look alike: none is drawn to be the one to click.
Questions open in a modal dialog over the panel, wherever it is scrolled to; the rest of
the panel is inert until the last one is answered or runs out, and Escape does not close
it. A question that runs out leaves "Not answered in time: <tool> did not run." in the
warning's tint: in the dialog in its card's place while other questions wait, else over
the panel's top wherever it is scrolled to, for 15 s or until its OK. A screen reader hears one short line per question ("<app>
asks to run <tool>"), not the card. For 750 ms after the dialog goes, the "Always allow"
switches and "Always allow all" under it ignore a click, without changing their look, so
the second click of a double click on "Allow once" does nothing there.

Otherwise it asks in a Chrome notification, "Allow <tool>?" (the page's title of the tool,
cut to 60 characters) with "On <site> · Closing this is Don't allow" below, naming the AI
app (its name and its verified host) and the arguments in short (cut to 150 characters;
when they are cut, the notification says "Arguments cut: click to see them in full."),
with the button "Allow once". "Always allow on <host>" is not on the notification: allowing a
tool for good needs the whole question. A click on the notification's body opens the side
panel of the tab's window, where the question waits, the arguments in full, with Don't
allow, "Allow once" and "Always allow on <host>", its 60 s still running. Where Chrome
does not open the panel, the notification shows again and the icon's "?" opens the
panel. Don't allow is closing the
notification or no answer in 60 s; on macOS, Chrome's own "Settings" button on the
notification closes it too, so it also counts as Don't allow. A click on "Allow once" within half a second of the
notification showing does not count (it shows again). A notification answers only its
own call. Questions also show in every open side panel, so with notifications off
(Focus, Do Not Disturb, notifications off for Chrome) open the panel when the icon shows
"?". A question nobody answers in 60 s is Don't allow, and the AI app is told the user did
not answer. At most 5 questions of one AI app wait at once; a further call of that app is
declined without asking, and the app is told why.

"Always allow on <host>" allows the tool on that site (exact origin) for every connected
AI app, as switching on its "Always allow" in the panel's tool list does, until you
switch it off again there.

## Filling in the code

When an AI app opens the relay's pairing page (`<relay>/authorize`) in the browser
that has the extension, and filling in is on (above), its content script for that page
reads the form's `data-tab-mcp-*` attributes (the app the AI app asks for, its name and
its verified host) and the form's hidden request id. It reads nothing else of the page. Only for
the extension's own app (`tab-mcp-extension`; `tab-mcp-extension-firefox` in Firefox),
only in the tab's top frame, only on a form with a code field (a relay that pairs by
sign-in alone has none) and only while AI access is on, the service worker asks:
"Connect <name> (<host>) to the tab-mcp browser extension?", with "AI app at (verified)
<host>" on a line of its own and the AI app's name for itself apart, Don't allow and
Allow, in the side panel or a notification ("Connect an AI app?") like a tool's question.
The worker takes the page's word only from the relay's exact origin, port included: the
same form on another site is ignored. On Allow it writes the code into the field and
submits the form with Connect, and the relay checks the code as a typed one. Nothing is
filled on Don't allow, after 60 s without an answer, when the tab closes or leaves the
page, when AI access goes off, or when the AI app connects meanwhile. One question per
page load; if the page of the same request comes back with "That code is not right"
within 30 s (the code had just changed), it is filled once more without asking, and not
a third time; any other request asks. If another connection request's question is
waiting already, the panel says so: type the code, or reload the page once answered. Needs a relay with the hooks
(relay 0.12.0 and later).

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read the tab you click the icon on (its WebMCP tools), without access to other sites. |
| `scripting` | Put the content script, which lists and calls the page's WebMCP tools, into that tab. |
| `sidePanel` | The side panel: the connection's state, pairing, the tab's tools, the questions. |
| `notifications` | Ask before a tool that is not read-only runs while the side panel is not in front. |
| `alarms` | Wake the service worker once a minute while AI access is on, so a connection lost while the computer slept comes back. |
| `http://*/*`, `https://*/*` (optional) | Only after "Give access to all sites": read every tab of an http(s) site without a click. Or, after turning on "Fill in the code for me", the relay's site alone: its pairing page. |

The manifest sets `"incognito": "not_allowed"`: Incognito tabs are never offered to an AI
app.

No `storage` permission: the relay address, whether AI access is on, the tools allowed per
site and the secret by which the relay knows this installation are in IndexedDB, used by
the service worker only, which content scripts (in the page's origin) cannot reach; there
is no `chrome.storage` area for them to read or write.

WebMCP is on in Chrome only where a site takes part in Chrome's
[origin trial](https://developer.chrome.com/blog/ai-webmcp-origin-trial) (Chrome 149 to
162), or after you
turn on `chrome://flags/#enable-webmcp-testing`
([Chrome's WebMCP docs](https://developer.chrome.com/docs/ai/webmcp)).

## The relay and the extension's id

The relay accepts an extension only if its origin, `chrome-extension://<id>`, is allowed
(`TAB_MCP_ALLOWED_ORIGINS` or `TAB_MCP_SITES`, relay 0.7.0 or later; see "Browser
extensions" in `docs/configuration.md`). An unpacked extension's id comes from the public
key in its manifest, or, without one, from the folder it was loaded from.

The extension names its app to the relay (`APP_ID` in `src/protocol.ts`):
`tab-mcp-extension`, and `tab-mcp-extension-firefox` in the Firefox build. Its MCP
address is therefore `<relay>/s/tab-mcp-extension/mcp` for every installation; the
pairing code says which installation an AI app is paired with. A relay can reserve
`tab-mcp-extension` for the extension's origin (`apps` of its entry in `TAB_MCP_SITES`),
so that no other origin the relay allows can serve that address. The Firefox build's id
cannot be reserved for it: no list can name one Firefox extension.

- `bun run build` writes the Chrome Web Store item's public key, `manifest-key.txt`, into
  the manifest, so the development build has the store's id,
  `jjhddplkjikmbpcobcnfebnglgjomfgh`, the one the hosted relay
  (`https://tab-mcp.ractive.ch`, the side panel's default) allows. The key is public: the
  store ships it in every copy. A development build and the store's cannot be installed in
  the same Chrome profile; try the store's in another profile.
- With your own relay (`docs/self-hosting.md`), allow that id, or use the relay's
  development mode.
- `bun scripts/build.ts --store` builds the Chrome Web Store package into `dist-store/`
  (no key, no host access, no source maps); `--store --zip` also packs it as
  `tab-mcp-browser-extension-<version>-store.zip` and refuses a build with a key, host access,
  source maps or the test build's hooks. `--test` builds the end-to-end tests' build (no
  key, host access at install, and the hooks through which the tests answer
  notifications, which no other build has).

## In Firefox (a spike)

Firefox has no WebMCP. The Firefox build gives every page `document.modelContext` as the
page starts loading, from its content script (`src/firefox/webmcp.ts`, DEC-188), so pages
that register their tools wherever the API exists (Shopify's storefronts, Mintlify, GitBook
and ReadMe docs, pages with the MCP-B or W3C polyfill) register them in Firefox too, and
the extension offers them to the AI app as in Chrome. Iteration 44; not released.
A page can therefore tell that the extension is installed: the API is there where Firefox
has none, and it behaves as this extension's (accepted, 2026-11-16; `PRIVACY.md`).

1. `bun scripts/build.ts --firefox` builds it into `dist-firefox/` (Firefox 128 or later).
2. Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
   `dist-firefox/manifest.json`. (Or `ff-rdp launch --temporary-addon dist-firefox <url>`.)
   **Reload** keeps its UUID and storage, and with them the AI app's pairing (checked
   in Firefox 160: `storage.local` and IndexedDB). **Remove** and loading it again is a new
   installation: a new UUID and empty storage, so the AI app has to pair again, unless
   `extensions.webextensions.keepUuidOnUninstall` and
   `extensions.webextensions.keepStorageOnUninstall` are `true` in `about:config`. A
   temporary add-on is gone when Firefox quits; the two prefs are meant to keep it the
   same when loaded again (not checked for a quit). Open pages keep their WebMCP tools across a reload or update of the
   extension: the polyfill keeps them in the page, and the new content script, put into
   every open page at once, takes them over (DEC-188).
3. A relay that admits Firefox extensions. Firefox's origin, `moz-extension://<UUID>`, is
   made up for each installation, so a relay admits all Firefox extensions or none
   (`moz-extension://*`, relay 0.11.0, DEC-189). The hosted relay
   (`https://tab-mcp.ractive.ch`, the default) does since 2026-11-16; or run one locally:

   ```sh
   NODE_ENV=development TAB_MCP_PUBLIC_URL=http://localhost:8080 \
     TAB_MCP_ALLOWED_ORIGINS='moz-extension://*' TAB_MCP_STORE=memory \
     bun packages/tab-mcp/src/main.ts
   ```

4. Click the tab-mcp icon: the sidebar opens. For a local relay, set it under **Settings**
   (`http://localhost:8080`). Then **Give access to all sites** (Firefox asks): only then does
   every page get WebMCP as it loads; a click on the icon comes after the page looked for it.
5. Reload the page with the tools, turn on AI access, and add the address the sidebar shows
   (`<relay>/s/tab-mcp-extension-firefox/mcp`) to your AI app
   (`claude mcp add --transport http tab-mcp-browser-extension-firefox <address>`), with the
   pairing code from the sidebar.
   The "Fill in the code for me" switch works as in Chrome (Firefox asks for the relay's site);
   its notification has no buttons, so a click on it opens the sidebar, where Allow is.

**While developing**, `bun scripts/firefox-dev.ts [URL] [--headless] [--port N]` does steps 1,
2 and the host access in one: it builds `dist-firefox-dev/` with host access granted at
install (`--all-sites`), and starts Firefox through [ff-rdp](https://github.com/ractive/ff-rdp)
with the build as a temporary add-on and one kept profile (`TAB_MCP_FIREFOX_PROFILE`, else
`~/.cache/tab-mcp/firefox-dev-profile`) that has the two prefs above. Every launch then has
the same UUID and storage, so the AI app stays paired; running it again rebuilds and
replaces the running Firefox. With `--reload` it rebuilds and reloads the add-on in the
running Firefox instead (`ff-rdp addon reload`, ff-rdp 0.4.4 or later): the tabs stay open,
and their pages keep their tools, which is what an update does to them. ff-rdp's commands
reach it with `--port N` (6000 by default).

**For addons.mozilla.org**, `bun scripts/build.ts --firefox --store --zip` builds
`dist-firefox-store/` (no source maps, no host access at install) and packs
`tab-mcp-browser-extension-firefox-<version>-store.zip`, with the same checks as the Chrome
store zip. The scripts are bundled and minified, so the listing needs the source as well:
the repository at that commit, built with `bun install` and that command.

`bun scripts/build.ts --firefox --test` builds the end-to-end tests' build (host access at
install, the panel opened in a tab at install). `bun test/firefox-sites.ts` loads real
WebMCP sites with it and lists the tools each registers (needs the network).

## Releases

A tag `extension-v<version>` on main (the version in `package.json`) builds the store zip,
creates the GitHub release with it and then, after the owner's approval, publishes it to
the Chrome Web Store (`.github/workflows/extension-release.yml`). The release job attests
the zip's build provenance; check a release's zip with
`gh attestation verify tab-mcp-browser-extension-<version>-store.zip -R ractive/tab-mcp`. The
publish job takes only a zip that verifies, packs it into a CRX signed with the item's
verified-upload key and submits it for review. The
"Extension publish" workflow repeats that publish by hand, for a release whose publish
failed. The attestation covers the GitHub release's zip and the upload, not the installed
extension: the Chrome Web Store signs what it serves itself. The owner's setup, the listing, the permission justifications and the review notes:
`kb/operations/chrome-web-store.md`. The listing's screenshots are in `assets/store/`;
`bun scripts/screenshots.ts` takes them again (Chrome for Testing, `CHROME_PATH`).

## Tests

- `test/unit.test.ts`: manifests, the key's id, reading a page (one `getTools()` shared
  by the reads of a second, a new one after `toolchange` and for a call), the tool, the
  refusals.
- `test/build.test.ts`: the store build has no key, no `host_permissions`, no source
  maps and no test hooks; its zip lists the build's files; a build with any of these is
  not packed; `--zip` needs `--store`.
- `test/panel.test.ts`: the side panel's AI app card (the next step, the address only
  while pairing, the first look, Disconnect only while connected), "How do I add it?" and
  its Copy buttons, its clicks (Disconnect's double click, the switch), "Always allow
  all" over the tool list, the tab card's texts (an unreadable tab, no tools), the
  labels and live regions of `index.html`, a question's countdown and its end.
- `test/contrast.test.ts`: the panel's look (`kb/design/extension-look.md`). Every pair
  of colours the style sheet uses, from its two token blocks (light and dark): text at
  least 4.5:1, edges, dots and the switches' parts at least 3:1; the badge's colours
  (`src/look.ts`); and the style sheet's rules: every colour is a token, none is unused,
  nothing is dimmed by opacity, no hover reaches a button that takes no click, no button
  is amber, one focus ring, reduced motion stops every transition, forced colours name
  every state. A new colour or pair goes into the test's table first.
- `test/worker.test.ts`: who may send the service worker what (only the side panel's
  port gives commands; a content script can only say its page's tools changed), the
  questions (notifications, the guard, late clicks, a click on the body and a panel
  Chrome refuses, cut arguments, the panel, the time limit), invisible characters, the
  address secret's storage, "Always allow on <host>" (the site's "allowed"), the panel's status
  while the relay is out of reach, a panel's messages across the worker's start (their
  order, a failed start, a panel gone before it), a bundle without dynamic `import()`.
- `test/bridge.test.ts`: the bridge's names (also one that becomes the extension's own),
  descriptions, schemas (a parameter called `pattern`), results (the image budget, a
  tool that navigates), the origin checked against Chrome's, why a call did not run, and
  how its tools follow the page.
- `test/e2e.test.ts`: the test build and the store package in Chrome for Testing 156 or
  newer (`CHROME_PATH`), the side panel opened by a real click on the icon, a relay in
  the test process, an MCP client calling `page_info`, `webmcp_tools` and the page's
  tools (the look: nothing past the panel's edge at 345, 360 and 420 px, each scheme's
  colours as computed, both switches' contrast; confirmation in the panel, cancellation, `toolchange`, a forged
  `document.modelContext`, a tool that takes the tab to another page, "Always allow on <host>")
  across navigations and tab switches; a `toolchange` read with one `getTools()`, and
  none with AI access off and the panel closed; with the panel closed
  (tools still run, questions as notifications, a panel closed during a question, a click
  on a notification's body where Chrome refuses the panel, reopening it) and after a restart of the same profile (the same address connects
  again by itself; with the relay out of reach the alarm is set and the panel says it
  retries). `TAB_MCP_E2E_IDLE=1` adds a two-minute check that the service
  worker keeps running on a quiet connection and stops once AI access is off. Pages are served
  through the DevTools Protocol on made-up https origins. They take a few seconds and
  run in CI on every change.
- `test/fill.test.ts`: filling in the code on the relay's page: which page is one (top
  frame, `/authorize`, its own app, a code field), who may speak for it (the relay's
  exact origin; a look-alike, a frame, another extension), the question and its
  notification, Allow, Don't allow, a timeout, the page going, the AI app connecting
  meanwhile, AI access off, the setting off, too many questions, one more fill for the
  same request only and no third, the code taken despite a clock ahead, the content
  script's registration and the panel's line. `test/fill-e2e.test.ts` and
  `test/firefox-fill-e2e.test.ts` do it end to end in Chrome for Testing and Firefox
  with a relay and an OAuth client (`test/oauth.ts`): off by default, turned on with a
  real click, a look-alike on another port gets no question, Don't allow then typing by
  hand, the tab closing, Allow pairs the AI app, AI access off (also while a question
  waits), Stop. Chrome's prompt for the relay's site is not tested: the test builds
  have access to all sites at install.
- `test/hosted.ts` (by hand): the development build connects to the hosted relay and
  shows an address and a pairing code.
- `test/firefox-e2e.test.ts`: the Firefox test build in Firefox 128 or newer
  (`FIREFOX_PATH`, else where it is installed; skipped without it) over WebDriver BiDi
  (`test/firefox.ts`, a temporary add-on): the same test page registers its tools with the
  extension's `document.modelContext` as it loads, and a relay and an MCP client list,
  call, confirm, cancel and follow them (`toolchange`, a signal's abort, a page replacing
  the getter); the event page outlasts Firefox's idle timeout with the panel closed; the
  panel says Firefox, not Chrome. Pages on http://localhost. `test/firefox-sites.ts` (by
  hand, the network): real sites.

## Licence

MIT, see the repository's `LICENSE` and `AI_NOTICE`. The build's `LICENSES.txt` lists
what it bundles.
