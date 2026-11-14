# tab-mcp for Chrome

A Chrome extension that offers the page in front to your AI app outside the browser,
through a tab-mcp relay. It is the WebMCP bridge of tab-mcp (DEC-114 in `kb/`): pages that
register tools with [WebMCP](https://webmachinelearning.github.io/webmcp/)
(`document.modelContext.registerTool()`) offer them only to agents in the browser; the
extension passes them on (iterations 19 and 20). A page needs nothing of tab-mcp for
this.

Not in the Chrome Web Store yet; load it unpacked. Privacy policy: [PRIVACY.md](PRIVACY.md).

## Tools

| Tool | What it does |
|---|---|
| `page_info` | The tab in front: address (with its query and fragment), title, language, whether WebMCP is available on the page and how many tools it registered. Read-only; its text is the page's own (untrusted). |
| `webmcp_tools` | The page's WebMCP tools: each one's `page_<name>`, title, description, input schema (what `webmcp_call` checks the arguments against; 192 KB of schemas together at most, past that a tool says where its schema is), whether it only reads, and why a tool is left out; empty with the reason when the tab has none or may not be read. |
| `page_<name>` | One per tool the page in front registered. The list follows the tab in front and the page's `toolchange`. |
| `webmcp_call` | Calls a tool of the page in front by its name, with the same rules. For AI apps that read their tool list once (Claude, Codex): a `page_<name>` tool that came with a later tab is not in their list, but `webmcp_call` reaches it. |
| `navigate` | Opens an http(s) address (or one relative to the page, `/sale`) in the tab in front, waits until it has loaded and answers with its `page_info`. |
| `go_back`, `go_forward` | Back or forward one page in that tab, as the browser's buttons do, with the new page's `page_info`. |
| `reload` | Reloads the page in that tab, with its `page_info`. |

The navigation tools act only on a tab the extension may read now (a click on its icon
there, or "Read all sites without a click"); on any other tab they do nothing and say why:

- On the page's own origin (scheme, host and port) they run at once, as a link on the
  page would.
- To another origin they ask you first, in the side panel or a notification as page tools
  do, naming the site the tab is on and the address it would open; "Allow once" and Don't
  allow only, no "Don't ask again" (a page's text could tell the AI app to go anywhere). Back or
  forward to a page the extension cannot see (another origin: Chrome lists only the
  page's own) asks too, saying its address is not known. A reload never asks.
- Only `http:` and `https:` addresses, without a user name or password.
- Without "Read all sites without a click", Chrome lets the extension read the new page of another
  origin only after a click on its icon there; the answer says so.
- They wait up to 30 s for the page to load; after that the answer says it is still
  loading.

The page's tools are the page's word:

- Their descriptions reach the AI app starting with the page's origin (`From
  https://shop.example: …`), cut to 1000 characters; titles to 100. The origin is the one
  Chrome reports for the tab: a page that says it is another site gets no tools.
- A tool the page marks read-only runs at once; every other one asks you each time
  (see "Questions" below). "Don't ask again on <host>" in a question, or switching off
  the tool's "Ask first" in the panel's list, allows the tool on that site (exact origin)
  for every paired AI app, kept until you switch "Ask first" on again. "Turn off Ask
  first" over the list does that for every tool listed at that moment that asks first,
  in one step; once none asks, it reads "Turn on Ask first" and turns them all back. A tool the page registers later asks first. When the page changes what the
  button would do, it waits 750 ms before it takes a click. All of these only for pages
  of an http(s) site: pages with an opaque origin (`null`, such as sandboxed pages)
  always ask ("asks first", no switch).
- A call runs only on the page its tool was listed from, and only if the tool still
  makes the read-only claim it was offered with; after a navigation, or a tool that
  changed (also while you were asked), the AI app is told to list the tools again.
- A tool that takes the tab to another page (a checkout, a search) is not a failure: the
  answer says the page changed while the tool ran, that the tool may have completed, and
  gives the new page's `page_info` once it has loaded; its tools are offered by then.
- Arguments are checked against the tool's schema before the call (without the schema's
  regular expressions, which a page could make freeze the extension; the page checks those
  itself; a parameter that is called `pattern` stays). The schema the AI app gets has no
  `pattern` either: each one is added to its property's description instead ("Must match
  the regular expression …", cut to 200 characters). A call that the page does not
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
  each connector, and a consequential one asks in the page as well.
- The top frame's WebMCP, which lists the tools of the page and of its same-origin
  frames (the draft and Chrome's documentation say so; not tested here); tools of
  frames of other origins are not listed. Only the browser's own WebMCP: a page's
  replacement `document.modelContext` (or a polyfill without native WebMCP) is not used.
- Only pages of http(s) sites, not `file:` pages, and not Incognito tabs (the extension
  cannot be allowed there).

## Load it unpacked

```sh
bun run build            # in packages/tab-mcp-extension: writes dist/
```

Then `chrome://extensions`, Developer mode on, "Load unpacked", choose `dist/`.

- Click the extension's icon on a tab: the side panel opens (also over another
  extension's panel for that tab, such as Claude in Chrome's), and the extension may read
  that tab, also after navigations on the same origin, until the tab goes to another
  origin (`www.example.com` is another origin than `example.com`).
  "Read all sites without a click" in the side panel lets it read every http(s) tab
  without a click; the panel says before the button what Chrome will ask ("Read and
  change all your data on all websites"). On a tab it may not read, the panel says to
  click the icon in the toolbar (or that Chrome does not let extensions read the page).
  On a page without tools it says so, that `page_info` and the navigation tools still
  work, and, where WebMCP is off, how Chrome turns it on.
- "Turn on AI access" (or the "AI access" switch) connects to the relay. While no AI app
  is paired, a line under the heading says what the extension does and names the relay.
  With no AI app paired yet, the panel shows the address for your AI app and a pairing
  code at once, with a note to use the AI app outside this Chrome profile (a chat in a
  tab of the same profile becomes the tab in front while you type in it).
  "How do I add it?" under the address says how to add it in Claude, ChatGPT, Claude Code
  and Codex (the client library's steps, the commands each with a Copy), and links to the
  [connect page](https://ractive.ch/tab-mcp/connect/). A Copy the clipboard refuses
  selects the text in place to copy by hand. Paired apps are listed, each with a dot
  (green while connected, grey while off or connecting); while connected each has a
  Disconnect button (which asks first, and takes no double click). Only the relay can
  disconnect an app, so while off or connecting the list has no Disconnect and says why;
  the list is kept from the relay's last one, also across a restart of the extension.
  "+ Add another AI app" shows the address and a code again. The address shows only
  while pairing. Off with apps paired, the panel says "AI access is off · paired apps stay
  paired". The relay address is under "Settings". Where you name the connector
  yourself (Claude, ChatGPT), a name such as "Browser" helps: "in my browser" then leads
  the AI to it (the Claude Code and Codex commands name it `tab-mcp-for-chrome`). The
  extension's instructions and `page_info` tell the AI to call `page_info` first when you
  refer to a page in your browser.
- The connection lives in the extension's service worker, not in the side panel: close
  the panel and AI access stays on, until the switch turns it off. It comes back by itself after a
  browser start, an update or a reload of the extension when you left it on. While the
  relay cannot be reached, the panel says "Connection lost · retrying" and the extension
  tries again every minute. The icon
  shows "on" while it is connected, "…" while it connects or retries, "?" while a tool asks. If
  another tab or program takes the address over, the extension does not take it back by
  itself, also after a restart: the panel says so and offers "New address" (or Connect,
  to take it back).

## Questions

A tool that asks first asks in the side panel when the panel is open in the window of the
tab the tool acts on, that window is in front, and the panel is not covered by another
extension's panel for the tab (a question it shows goes out as a notification once it is
covered): "Allow once" and "Don't ask again on <host>" work once the
panel has been in front for 750 ms, so the click that brings it forward cannot approve
(until then they keep their focus and place in the tab order, `aria-disabled`, and take
no click). The panel's question names the AI app and the tool, then, each on a line of
its own, the site the tool acts on ("Site (verified)") and the page's title for the tool
("Title (from the page)"), the arguments in full (they scroll when long) and the seconds
left to answer. A question that runs out leaves "Not answered in time: <tool> did not
run." for a few seconds. A screen reader hears one short line per question ("<app> asks
to run <tool>"), not the card. A question that comes or goes moves what is below it: the
"Ask first" switches and "Turn off Ask first" over the list wait 750 ms after.

Otherwise it asks in a Chrome notification, "Allow <tool>?" (the page's title of the tool,
cut to 60 characters) with "On <site> · Closing this is Don't allow" below, naming the AI
app (its name and its verified host) and the arguments in short (cut to 150 characters;
when they are cut, the notification says "Arguments cut: click to see them in full."),
with the button "Allow once". "Don't ask again" is not on the notification: allowing a
tool for good needs the whole question. A click on the notification's body opens it, the
arguments in full, with Don't allow, "Allow once" and "Don't ask again on <host>": in the
side panel of the tab's window, or, where Chrome does not open the panel, in a small
window of its own (closing that window is Don't allow). The question waits there, its
60 s still running. Don't allow is closing the
notification or no answer in 60 s. A click on "Allow once" within half a second of the
notification showing does not count (it shows again). A notification answers only its
own call. Questions also show in every open side panel, so with notifications off
(Focus, Do Not Disturb, notifications off for Chrome) open the panel when the icon shows
"?". A question nobody answers in 60 s is Don't allow, and the AI app is told the user did
not answer. At most 5 questions of one AI app wait at once; a further call of that app is
declined without asking, and the app is told why.

"Don't ask again on <host>" allows the tool on that site (exact origin) for every paired
AI app, as switching off its "Ask first" in the panel's tool list does, until you switch
it on again there.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read the tab you click the icon on (its WebMCP tools), without access to other sites. |
| `scripting` | Put the content script, which lists and calls the page's WebMCP tools, into that tab. |
| `sidePanel` | The side panel: the connection's state, pairing, the tab's tools, the questions. |
| `notifications` | Ask before a tool that is not read-only runs while the side panel is not in front. |
| `alarms` | Wake the service worker once a minute while AI access is on, so a connection lost while the computer slept comes back. |
| `http://*/*`, `https://*/*` (optional) | Only after "Read all sites without a click": read every tab of an http(s) site without a click. |

The manifest sets `"incognito": "not_allowed"`: Incognito tabs are never offered to an AI
app.

No `storage` permission: the relay address, whether AI access is on, the tools allowed per
site and the secret behind the connection's address are in IndexedDB, used by the service
worker only, which content scripts (in the page's origin) cannot reach; there is no
`chrome.storage` area for them to read or write.

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

- `bun run build` writes the owner's key into the manifest, read from
  `~/.config/tab-mcp/extension-key.txt` (or `TAB_MCP_EXTENSION_KEY_FILE`). That build's
  id, `handeaggdjdkpniflkjlknlcfbjifkng`, is the one the hosted relay
  (`https://tab-mcp.ractive.ch`, the side panel's default) allows. The key is not in this
  repository: anyone with it could load an extension with that id.
- Without the key the build gets an id of its own; run your own relay
  (`docs/self-hosting.md`) and allow that id, or use the relay's development mode.
- `bun scripts/build.ts --store` builds the Chrome Web Store package into `dist-store/`
  (no key, no host access, no source maps); `--store --zip` also packs it as
  `tab-mcp-for-chrome-<version>-store.zip` and refuses a build with a key, host access,
  source maps or the test build's hooks. `--test` builds the end-to-end tests' build (no
  key, host access at install, and the hooks through which the tests answer
  notifications, which no other build has).

## Releases

A tag `extension-v<version>` on main (the version in `package.json`) builds the store zip
and creates the GitHub release with it (`.github/workflows/extension-release.yml`); the
"Extension publish" workflow uploads a release's zip to the Chrome Web Store. The owner's
setup, the listing, the permission justifications and the review notes:
`kb/operations/chrome-web-store.md`. The listing's screenshots are in `assets/store/`;
`bun scripts/screenshots.ts` takes them again (Chrome for Testing, `CHROME_PATH`).

## Tests

- `test/unit.test.ts`: manifests, the key's id, reading a page, the tool, the refusals.
- `test/build.test.ts`: the store build has no key, no `host_permissions`, no source
  maps and no test hooks; its zip lists the build's files; a build with any of these is
  not packed; `--zip` needs `--store`.
- `test/panel.test.ts`: the side panel's AI app card (the next step, the address only
  while pairing, the first look, Disconnect only while connected), "How do I add it?" and
  its Copy buttons, its clicks (Disconnect's double click, the switch), "Turn off Ask
  first" over the tool list, the tab card's texts (an unreadable tab, no tools), the labels and live
  regions of `index.html`, a question's countdown and its end.
- `test/contrast.test.ts`: the panel's look (`kb/design/extension-look.md`). Every pair
  of colours the style sheet uses, from its two token blocks (light and dark): text at
  least 4.5:1, edges, dots and the switches' parts at least 3:1; the badge's colours
  (`src/look.ts`); and the style sheet's rules: every colour is a token, none is unused,
  nothing is dimmed by opacity, no hover reaches a button that takes no click, no button
  is amber, one focus ring, reduced motion stops every transition, forced colours name
  every state. A new colour or pair goes into the test's table first.
- `test/worker.test.ts`: who may send the service worker what (only the side panel's
  port gives commands; a content script can only say its page's tools changed), the
  questions (notifications, the guard, late clicks, a click on the body, cut arguments,
  the panel, the time limit), invisible characters, the address secret's storage,
  "Don't ask again" (the site's "allowed"), the panel's status while the relay is out of
  reach, a failed start tried again, a bundle without dynamic `import()`.
- `test/bridge.test.ts`: the bridge's names (also one that becomes the extension's own),
  descriptions, schemas (a parameter called `pattern`), results (the image budget, a
  tool that navigates), the origin checked against Chrome's, why a call did not run, and
  how its tools follow the page.
- `test/e2e.test.ts`: the test build and the store package in Chrome for Testing 156 or
  newer (`CHROME_PATH`), the side panel opened by a real click on the icon, a relay in
  the test process, an MCP client calling `page_info`, `webmcp_tools` and the page's
  tools (the look: nothing past the panel's edge at 345, 360 and 420 px, each scheme's
  colours as computed, both switches' contrast; confirmation in the panel, cancellation, `toolchange`, a forged
  `document.modelContext`, a tool that takes the tab to another page, "Don't ask again")
  across navigations and tab switches; with the panel closed
  (tools still run, questions as notifications, a panel closed during a question, a click
  on a notification's body opening the question's own window, reopening it) and after a restart of the same profile (the same address connects
  again by itself; with the relay out of reach the alarm is set and the panel says it
  retries). `TAB_MCP_E2E_IDLE=1` adds a two-minute check that the service
  worker keeps running on a quiet connection and stops once AI access is off. Pages are served
  through the DevTools Protocol on made-up https origins. They take a few seconds and
  run in CI on every change.
- `test/hosted.ts` (by hand): the development build connects to the hosted relay and
  shows an address and a pairing code.

## Licence

MIT, see the repository's `LICENSE` and `AI_NOTICE`. The build's `LICENSES.txt` lists
what it bundles.
