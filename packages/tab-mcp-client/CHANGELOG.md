# Changelog of @ractive-ch/tab-mcp-client

All notable changes to the browser library `@ractive-ch/tab-mcp-client`, released with
the Git tag `client-v<version>`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). The relay has its own
[changelog](https://github.com/ractive/tab-mcp/blob/main/packages/tab-mcp/CHANGELOG.md).

## [0.23.0][client-0.23.0] - 2026-11-23

### Breaking

- **`webmcp` is on by default** (DEC-222): the page's tools are also registered with the
  browser's WebMCP, where the tab has it. Set `webmcp: false` for the old behaviour.
- In a browser extension's own pages, and on a page that registers the same tool names
  with `document.modelContext` itself, set `webmcp: false`.

### Changed

- Several `TabMcp` of one app in a page (React's strict mode makes a second one and
  drops it) tell the tab-mcp browser extension one list of AI apps: before, the one
  made last, with none connected, replaced the other's.

## [0.22.0][client-0.22.0] - 2026-11-23

### Breaking

- **`BrowserExtension` has no `version` any more** (`TabMcp.extension`,
  `extensionchange`, the React snapshot's `extension`; DEC-221). The tab-mcp browser
  extension no longer tells a page its version. A page that showed or checked it drops
  that; `name`, `apps` and `whileInFront` are unchanged.
- **A page that stays on 0.21.0 or older loses the extension's state** once its users
  have the tab-mcp browser extension after 0.3.2: such a page takes the extension's
  "on" only with a version, so `extension` stays `undefined` and the page no longer
  shows the AI apps connected through the extension. Calls the user allowed in the
  extension are still not asked again in the page. Update to this version to get it
  back.

### Changed

- **The library takes the extension's "on" without a version** (DEC-221), as the
  tab-mcp browser extension after 0.3.2 sends it; a version an older extension sends is
  ignored. While AI access is off, the extension answers no page and sends it
  nothing, so `extension` stays `undefined`, as without the extension; a page it served
  is told once that it went off. Once on, the extension greets the page with `hello`,
  and the library's answer tells it what the page announces.

## [0.21.0][client-0.21.0] - 2026-11-22

### Breaking

- **The library no longer asks a WebMCP call that the tab-mcp browser extension did
  not vouch for** (DEC-215). Its confirmation dialog is never shown for such a call: a
  tool that asks (`consequentialHint`, or only `destructiveHint`) runs, unless the
  page's `onConfirm` refuses it. The tool is still registered with
  `consequentialHint: true`, so that a caller that heeds the hint asks its user. Calls of
  AI apps through the relay or a port, and calls the extension vouched for, are
  unchanged.
- **Who loses the dialog.** Every unvouched WebMCP call, and the page cannot tell their
  kinds apart: an agent in the browser that drives the tab (it clicked "Allow once"
  itself, after waiting most of a minute for the dialog, so the dialog did not check
  it); another extension that passes on calls of an AI app outside the browser; and a
  document of an origin the page named in `exposedTo` (Chrome 156 lets it list and run
  the tool). The last two cannot click in the page: for them the dialog was a real
  check, and now only the calling extension's own question, if it has one, or the
  page's `onConfirm` stands between them and the tool.
- **What a page has to do:** nothing to get the new behaviour. A page with a tool that
  must not run on an unvouched WebMCP caller's word either decides in `onConfirm`
  (`request.client.kind === "webmcp"`; refuse, or apply a rule of your own, without
  showing anything an agent could click), keeps the tool from WebMCP with
  `callers: ["relay", "local"]`, or leaves `exposedTo` off it. Search your tool
  descriptions and server instructions for "the page asks" (or similar) and remove the
  promise of a question: an agent told that the page asks may click the page's own
  buttons instead of calling the tool.
- `TabMcp.confirmInPage()` and the confirmation chunk's `confirmInPage()` resolve `true`
  for a WebMCP call without showing anything, so an `onConfirm` that hands such a call
  to them, as React's `TabMcpProvider` does without a handler of the page, does what the
  library does without `onConfirm`. The confirmation's chunk is not loaded for such a
  call.
- `trustExtension: false` now treats a vouched call as any other WebMCP call: `onConfirm`
  decides, without one it runs.
- **`ui.strings.clientWebMcp` is removed** ("An agent in this browser"): no dialog names
  this caller any more. A page's own text under that key is no longer used, as any
  unknown key (the type check flags it in an object literal); remove it.

### Added

- **A console warning for a tool that asks with `exposedTo`** (DEC-215): with
  `webmcp: true`, a tool marked `consequentialHint` (or only `destructiveHint`) whose
  `exposedTo` names other origins, on a page without `onConfirm` (in React: the
  provider without one), is warned about once per tool, when the browser accepted its
  registration (an `onConfirm` removed later is not caught). Documents of those origins can
  call it through WebMCP, and the library no longer asks them. Refuse such calls in
  `onConfirm`, or leave `exposedTo` off.
- The agent skill ships in the package as `skill/SKILL.md` (with `skill/references/`),
  written for this version (DEC-216). With a coding agent, install the package and tell
  it: "Read node_modules/@ractive-ch/tab-mcp-client/skill/SKILL.md and add tab-mcp to
  this app." Its links point to the README, CHANGELOG and declarations beside it.

### Fixed

- The validator that `connect()` loads checks `outputSchema` as it checks `inputSchema`,
  as the README said it did: an output schema it cannot use (a `$ref` next to a nested
  `$id`, which does not resolve, or a duplicate `$id`) makes `registerTool` throw, and a
  tool registered before with one is unregistered, with the reason in the event `error`
  ("the outputSchema of …"). Until now such a tool was listed, and an AI app whose
  validator compiles output schemas (the MCP SDK's client) could not use it. Results
  are still not checked against the output schema.
- The setup commands (`./setup`, "How do I add it?") put an address with `[`, `]` or `~`
  in double quotes (DEC-217): zsh refused `claude mcp add --transport http test
  http://[::1]:8080/s/test/mcp` with "no matches found" (`~` with `extendedglob`). POSIX
  shells, zsh, fish, PowerShell and cmd.exe read the quoted address the same. An address
  with any other character than letters, digits and `. : [ ] / _ ~ -` still gets the
  steps without a command.
- `disconnectAll()` with a `storage` that reads but cannot be written (full, blocked, or
  a custom one whose writes fail) connected again with the old secret: the new one was
  kept only in memory, and the next read of storage returned the old one over it. The
  grants were revoked, but the secret was not changed, so whoever held the old one could
  still take the page's place. The new secret now stays in use until the page is
  reloaded, and storage is not read over it until a write succeeds (code review
  2026-11-22, CR-02).

## [0.20.0][client-0.20.0] - 2026-11-22

### Breaking

- With `webmcp: true`, tools marked `consequentialHint` or `destructiveHint` are mirrored
  into the browser's WebMCP too, unless their `callers` leave `"webmcp"` out (DEC-209).
  They ask every WebMCP call (a call the tab-mcp browser extension vouched for was asked
  there), and so does a tool marked only `destructiveHint`, which the page asks no AI
  app for (DEC-022): WebMCP has no `destructiveHint`, so a WebMCP call asks by
  `consequentialHint ?? destructiveHint`, the rule that already set the native hint. Until now they were left out unless `callers` listed
  `"webmcp"`, and an agent that found no such tool used the page's own controls instead,
  which ask nothing. To keep a tool from agents in the browser, as before, register it
  with `callers: ["relay", "local"]`.

## [0.19.0][client-0.19.0] - 2026-11-21

### Breaking

**`newAddress()` is `disconnectAll()`** (DEC-201): since 0.17 the address names the app
and never changes; the method disconnects every AI app and makes a new secret, as the
dialogs' "Disconnect all apps" says. Every name that went with it is renamed, with no
alias. Search your code for the old names:

| Old | New |
|---|---|
| `TabMcp.newAddress()` | `TabMcp.disconnectAll()` |
| `addressChanged` (on a rejection of it) | `secretChanged` |
| `DisconnectReason` `"new_address"` (`statechange` `reason`) | `"disconnect_all"` |
| `ui.strings.newAddress` | `ui.strings.disconnectAll` |
| `ui.strings.newAddressNote` | `ui.strings.disconnectAllNote` |
| `ui.strings.newAddressQuestionOne`, `ui.strings.newAddressQuestionMany` | `ui.strings.disconnectAllQuestion` (plural forms, see "Changed") |
| `ui.strings.newAddressConfirm` | `ui.strings.disconnectAllConfirm` |
| `ui.strings.gettingNewAddress` | `ui.strings.disconnectingAll` |
| `ui.strings.newAddressDone` | `ui.strings.disconnectAllDone` |
| CSS class `tab-mcp-new-address` (the dialog's and the takeover notice's button) | `tab-mcp-disconnect-all` |
| CSS class `tab-mcp-new-address-row` | `tab-mcp-disconnect-all-row` |
| CSS class `tab-mcp-new-address-question` | `tab-mcp-disconnect-all-question` |
| CSS class `tab-mcp-new-address-confirm` | `tab-mcp-disconnect-all-confirm` |

What the method does is unchanged, and so is the protocol (`hello.revokeAll`,
`grants.revokeAll`). A page's own texts under an old key are no longer used, as any
unknown key. The type check does not catch `addressChanged` where it is read behind a
cast, as from a caught error (`(error as { addressChanged?: unknown })`): search for it
by name.

### Added

- **Translated texts in one step** (DEC-208): `ui.strings` is the one table for every
  text the library shows a person, given once on `TabMcp` (or `<TabMcpProvider>`): the
  dialogs, their setup steps and now also `ConnectButton` of `./react`. Partial tables
  keep English for every missing key. New entry **`@ractive-ch/tab-mcp-client/strings`**
  (and `cdn/strings.min.js`): `STRINGS`, the English table, typed, so a translation
  typed as `DialogStrings` names every key it lacks or misspells in the type check;
  `pickStrings(tables, languages?)`, which loads the page's own table for the user's
  languages (`navigator.languages`: the same tag, else the same script, region or the
  language alone), English when they prefer it or nothing matches, and never rejects (a
  table that does not load gives English, with a warning);
  `withEnglish(strings)`, the full table for a page's own UI; the type `PluralText`.
  `setupInstructions(serverName, address, strings?)` takes the table too. New keys:
  `allowEverythingUntilReloadNote`, `setupClaudeApp`, `setupClaude`, `setupChatGpt`,
  `setupRun`, `setupClaudeCode`, `setupClaudeCodeNote`, `setupCodex`, `setupCodexNote`,
  `buttonReconnecting`, `buttonConnected`. A table with texts but no `lang` counts as
  English and the console says so once. See [Translating](README.md#translating). The
  core grows by 10 bytes gzipped (6270 B). The React entry keeps `ConnectButton`'s few
  English texts inline and does not load the table: what a React page loads first grows
  by about 0.5 KB gzipped (13.2 KB, 13.0 KB before), the entry itself to 3.1 KB.
- **The page and the tab-mcp browser extension know of each other** (`webmcp: true`,
  DEC-207): a plain handshake over DOM events (`tab-mcp-page`, `tab-mcp-extension`) with
  the extension from its next release.
  - **No second question.** Right before the extension runs a tool that the user
    allowed there (asked, or its "Always allow"), it vouches for that call: the tool,
    the exact arguments and the AI app. The next WebMCP call of that tool with equal
    arguments within 2 seconds runs without the page's question and without
    `onConfirm`; a vouch is used once, and any other call is asked as before. A vouch
    the extension withdraws (its call ended, or never reached the page) is dropped.
  - **`trustExtension: false`** keeps asking every WebMCP call (a site that insists on
    its own question).
  - **`extension` and the event `extensionchange`** (also in the React snapshot): while
    the extension serves the page, `{ name, version, apps, whileInFront }`, with the AI
    apps connected through it (`name`, `host`); `undefined` otherwise.
  - **A vouched call's caller** is `{ kind: "webmcp", via: "tab-mcp-extension", name,
    host }` in `execute`, `toolcall` and `toolcallend` (`WebMcpClient` has the new
    optional fields).
  - The connect dialog says first which AI apps are connected through the extension
    ("… while this tab is in front."), texts `viaExtension` and `viaExtensionInFront`
    (plural forms); the rest stays.
  - The page tells the extension the library's version, the app id and the AI apps
    connected to it directly (at most 64), and marks `<html data-tab-mcp-handshake>`.
  - In the WebMCP mirror's chunk: the core grows by 9 bytes gzipped.
- **`pairingUntil` and the event `pairinguntil`** (identity binding, DEC-202): until when
  a sign-in pairs the page (an ISO time on the page's clock: the `expiresInMs` of the
  relay's new `pairing.open`, counted from its arrival, so a page clock that differs
  from the relay's does not matter). Also in the React bindings' snapshot. `undefined`
  while pairing is off, from each `startPairing()` until the relay answers, after the
  session ended (`disconnect()`, `disconnectAll()`, a refusal), and with relays up to
  0.12.1, which do not send it.
- Dialog texts `signInUntil`, `signInTimeUp` and `continuePairing`.
- **`@ractive-ch/tab-mcp-client/extension`** (DEC-206): for a browser extension that is a
  tab-mcp page itself, filling in its own pairing code on the relay's pairing page after
  asking its user, as the tab-mcp browser extension does (DEC-203). The content script's
  part (`runPairingPage`), the worker's rules as one state machine (`CodeFiller`: the
  origin check, also after the page's hello and after the answer, one question per page
  load, the one more fill for the same tab and request, what withdraws a question),
  which code to fill in (`takeCode`, `pairingCodes`), the relay's patterns and the
  messages. The extension supplies how its user is asked, its setting, the permission
  prompt and the content script's registration. An entry of its own, out of the core,
  with no `chrome` types; a content script bundles less than 1 KB gzipped of it. See
  [For browser extensions](README.md#for-browser-extensions). In detail:
  - `new CodeFiller(host, { retry: false })` turns the one more fill off: the same
    request's page back after a fill is asked about like any other page, so nothing is
    filled in without a yes of its own. On by default.
  - `takeCode` takes the same code sent again (the relay's answer to `startPairing()`
    while pairing is on) as the next one only if its expiry now leaves `minLeftMs`, so
    "`startPairing()` before `takeCode`" never fills in a code about to change.
  - `code(signal, context)` and `failed(why, context)` get `context: FillContext`,
    `{ tabId, client: { name, host } }`, the page's tab and AI app as `ask` gets them.
  - `release()` is called when no fill needs pairing held any more: the AI app
    connected, or a fill ended without sending its code (withdrawn, the page went, no
    code) and no other fill is under way or waits for the relay's check.
  - `runPairingPage` with a `page` (a test's) marks that page's document as run, not
    the global: two pages in one test are independent.

### Changed

- **Texts: English only, plural forms and lists by `Intl`** (DEC-208). The package
  ships English only. The keys that made grammar by hand are gone, with no alias: a
  page's own text under an old key is no longer used, as any unknown key.

  | Old | New |
  |---|---|
  | `ui.strings.and` | none: lists are joined by `Intl.ListFormat` in the texts' `lang` |
  | `ui.strings.waitingOne`, `waitingMany` | `waiting` |
  | `ui.strings.connectedOne`, `connectedMany` | `connected` |
  | `ui.strings.connectedNextOne`, `connectedNextMany` | `connectedNext` |
  | `ui.strings.disconnectAllQuestionOne`, `disconnectAllQuestionMany` | `disconnectAllQuestion` |
  | `ui.strings.runsWithoutAsking` | none: the switches are headed by `alwaysAllow` ("Always allow"), or `allowUntilReload` when nothing is kept |
  | `ui.strings.dir` (default `"ltr"`) | optional, no default: the direction of `lang` where the browser knows it, else `"ltr"` |

  The new keys hold one form per plural category of the language
  (`{ one: "…", other: "…" }` in English, chosen by `Intl.PluralRules`), with `{n}` for
  the count.
- **One wording for one thing** (DEC-208; the glossary is `kb/design/wording.md`), also
  in the texts of the tab-mcp browser extension and the relay:

  | Key | Was | Now |
  |---|---|---|
  | `allow` | Allow | Allow once |
  | `codeSentence` | When asked, enter the code {code} | When asked, type the code {code} |
  | `codeNote` | A new code appears every 2 minutes and after each use. | The code changes every 2 minutes and after each use. |
  | `connectAnother` | Connect another app | Connect another AI app |
  | `connectedHeading` | Connected | Connected AI apps |
  | `disconnectAllConfirm` | Disconnect all | Disconnect all apps (the button that asked) |
  | `disconnectAllNote`, `disconnectAllQuestion` | … connect again with a new code / and enter a new code | … connect again (with identity binding there is no code) |
  | `disconnectNote` | To disconnect an app, … | To disconnect an AI app, … |
  | `disconnectFailed` | Could not disconnect the app. … | Could not disconnect the AI app. … |
  | `allowEverything`, `allowEverythingApp` | Allow everything, no questions asked (, for {app}) | Always allow everything (for {app}) |
  | `allowEverythingNote` | … and ones that delete or overwrite. | … and ones that delete or overwrite, until you disconnect {app}. |
  | `closeNote` | Closing this stops the code. To connect later, … | Closing this ends the code. To connect an AI app later, … |
  | `replaced` | … now reach that tab … copied what this page keeps to connect … again with a new code. | … now use that tab … copied this page's saved connection … again. |
  | `ConnectButton` | Connection lost, retrying… | Connection lost. Reconnecting… |

  What an AI app reads: a refused call is "The user did not allow this call." (was "The
  user declined"), and a call cancelled while the user was asked "The call was
  cancelled." (was "The user declined", though the user did nothing).
- **With identity binding the connect dialog counts for 10 minutes** (DEC-202): the
  relay pairs a sign-in with the page only until 10 minutes after the dialog opened. The
  dialog says until when ("Your AI app can connect until 14:32.") and, once the time is
  up (checked again when the tab comes back to the front), "The time to connect your AI
  app is up. To connect it now, continue." with a Continue button that starts the 10
  minutes again; with an app connected, "Connect another AI app" shows that sentence next
  to Continue. Nothing starts them again by itself: on an `oidc` session a reconnect
  the library makes by itself does not send `pairing.start` again once the user's start
  was sent, answered or not (`pairingUntil` is then the time of the reconnect, so the
  dialog shows Continue). `connect()` from a click while reconnecting ("Connect again")
  does send it, and a session that pairs by code gets it after every reconnect, as
  before. `startPairing()` now sends `pairing.start` on each call while connected, also
  when pairing is on already; call it only when the user acts. With a relay up to
  0.12.1 the dialog counts as long as it is open, as before, but after a reconnect it
  shows Continue. Libraries up to 0.18.1 send `pairing.start` after every reconnect, so
  for their pages each reconnect starts another 10 minutes: this release is needed for
  the limit to be complete.
- The takeover notice says "If you did not open this page in another tab or window of
  this browser" (was "in another tab or browser"): a page in another browser has a
  secret of its own and cannot take this one's place.
- The listeners that make a reconnect try at once when the tab comes back to the front
  or the browser is online again, and the wait for the relay's answer to `revoke()` and
  `signOut()`, are in the lazy chunk, which keeps the core within its size limit.

## [0.18.1][client-0.18.1] - 2026-11-20

### Fixed

- **The confirmation chunk's `confirmInPage` works with a host of the caller's own
  again.** Code that loads the built confirmation chunk (`confirm-<hash>.js`) and calls
  its `confirmInPage(mcp, request, document, options)` with a stand-in for the `TabMcp`
  (a desktop app's own MCP endpoint, say) broke in 0.18.0, which the 0.18.0 entry did
  not say:
  - it read the internal `_allowed` of the host, so a host without it threw;
  - its fourth argument became the dialog texts (`ui`) alone, so the 0.17 options
    `{ alwaysAllow, ui, allowDelayMs }` were silently ignored: no third button per
    call, no translated texts, no other delay.

  Now the fourth argument is again `{ alwaysAllow?, ui?, allowDelayMs? }`, as in 0.17.
  A host needs only `grants`; it may send `grantschange` (any event: the allowances
  are then pruned against `grants` as they are, whatever the event carries). It needs
  no `_allowed` and no `session`. For a host that is not a `TabMcp`, nothing is
  allowed or kept unless the call offers it with `alwaysAllow`; then the button says
  "Allow until reload" (`true` and `"until-reload"` alike: nothing of a stand-in
  outlives a reload), and an allowance is kept in memory for the host's grants only,
  until a reload or until its grant leaves `grants`, and applies to that app's later
  calls of the tool. A call counts as allowed only while its grant is in the host's
  `grants` at that moment, also without an event. For a `TabMcp`, `alwaysAllow`
  overrides the page's option for that call. As since 0.13, only a client with
  `kind: "relay"` can be allowed. Hosts that added `_allowed` or `session` for 0.18.0
  can drop them; an `_allowed` that is not a `TabMcp`'s (such as that workaround's)
  now makes the host a stand-in, so pass `alwaysAllow` to keep offering the button.
  `TabMcp.confirmInPage(request, { document })` is unchanged.

### Changed

- `allowedTools(mcp).has(grantId, name)`, and a call, count an allowance only while
  the app is in `mcp.grants`: before the first connect after a reload, `has` is
  `false` (the allowance is still kept, `list` shows it). Calls only come while
  connected, so for them nothing changes.

## [0.18.0][client-0.18.0] - 2026-11-20

### Added

- **`@ractive-ch/tab-mcp-client/allowed`**, an entry of its own (not in the core):
  `allowedTools(mcp)` returns the tools that run without asking, per connected AI app,
  for a page that draws its own switches: `tools()` (the tools that ask, each with
  `destructive`), `has`, `list`, `allow`, `ask`, `everything`, `setEverything`,
  `forget`, `onChange` and `kept`. Types `AllowedTools`, `AllowedTool` (DEC-200). It
  works with `alwaysAllow` unset too, kept in `storage`. Without a bundler:
  `cdn/allowed.min.js` beside `cdn/tab-mcp-client.min.js` (package export
  `./cdn/allowed`), sharing its chunks; a page that does not import it loads nothing
  more.
- **"Allow everything, no questions asked"** per AI app: every tool runs without asking,
  also ones registered later, changed and destructive ones.
- **Switches in the connect dialog**: under each connected app, a switch per tool that
  asks (destructive ones marked) and "Allow everything, no questions asked" with a
  sentence on what it means; checkboxes with `role="switch"` whose accessible names name
  the app. Tools allowed but not registered right now are listed by name, to turn off.
  Without `alwaysAllow`, only what is allowed for that app is shown, as switches that can
  only be turned off. The methods of `allowedTools(mcp)` are bound; `ask` while
  "everything" is on turns "everything" off for that app.
- `useAllowedTools(grantId)` in `@ractive-ch/tab-mcp-client/react`: the tools that ask,
  each with `allowed`, `everything` and the `allowedTools` object to change them.
- `alwaysAllow: "until-reload"`.
- `ui.strings`: `alwaysAllow`, `alwaysAllowNote`, `destructive`, `allowToolApp`,
  `allowDestructiveToolApp`, `allowEverything`, `allowEverythingApp`,
  `allowEverythingNote`.

### Changed

- **`alwaysAllow: true` keeps allowances until the app is disconnected**, in `storage`
  under the secret's key with `#allowed` appended (grant ids, tool names, the title and
  description the user saw, a fingerprint of the secret; no arguments). They end when
  the relay reports the grant gone (disconnected, "Disconnect all apps", expired, signed
  out), not on a dropped connection or a reload. With `storage: null` they are kept in
  memory. `alwaysAllow: "until-reload"` is the old behaviour.
- **The confirmation's third button** says "Always allow" with `alwaysAllow: true`, and
  "Allow until reload" with `"until-reload"` or `storage: null`, each with its own note.
- **An allowed call no longer reaches the page's own `onConfirm`**: it runs without
  asking. React's provider always installs an `onConfirm`, so this holds there too.
- **A tool that is unregistered keeps its allowance** (a reload registers every tool
  again); one registered again with another title or description is asked again, as
  before.
- `ui.strings`: `runsWithoutAsking` is the heading over the switches ("Runs without
  asking", without `{tools}`); `askAgain` and `askAgainApp` are gone ("Ask again" is
  replaced by the switches).

## [0.17.0][client-0.17.0] - 2026-11-19

### Breaking

For relays with one fixed MCP address per app, `https://<relay>/s/<app>/mcp` (the relay
release after 0.11.0; DEC-196). Relays up to 0.11.0 are not supported, and that relay
release refuses clients before this one.

- **The address names the app, not the tab.** `session.address` is
  `https://<relay>/s/<app>/mcp`, the same for every page of the app and every visitor;
  the pairing code alone says which page an AI app is paired with. Every address from
  before is gone: users add the new one to their AI apps and pair again.
- **`hello` carries `app: { id, name? }`**, which the relay requires. The `page` field
  is no longer sent, and the `/tab` URL has no `?a=<address id>`.
- **`newAddress()` no longer changes the address.** It still takes the page back,
  revokes every grant and makes a new secret, and `addressChanged` on its rejection
  still says whether the secret changed. The dialogs call it "Disconnect all apps"
  (was "New address"); every AI app then connects again at the same address with a new
  code. The keys of `ui.strings` are unchanged (`newAddress`, `newAddressNote`,
  `newAddressQuestionOne`, `newAddressQuestionMany`, `newAddressConfirm`,
  `gettingNewAddress`, `newAddressDone`, `closeNote`, `replaced`); their English texts
  changed. A page with its own texts for them should say the same.
- **`PairingCodeReason` has no `"locked"`.** The relay's codes have no attempts of their
  own any more: `reason` is `start`, `used` or `expired`.

### Added

- The option `app`: the app id, the `<app>` of the address. 1 to 32 characters of `a-z`,
  `0-9` and `-`, not starting or ending with `-`; anything else is a `TypeError`.
  Without it the id is made from `server.name`: lower case, letters without their marks,
  each run of other characters as one `-`, at most 32 characters ("Bücher" gives
  `bucher`). A `server.name` that leaves nothing, with `relay` set, is a `TypeError`
  that says to set `app`. A relay may reserve an app id for certain origins; a page of
  another origin that names it is refused (`connect()` rejects with reason `policy`).
  The relay knows a page by its app id and its secret together, so a page that changes
  its app id is a new page to the relay, and its AI apps pair again.

### Changed

- The pairing code is 8 letters, shown as the relay sends it: `XXXX-XXXX`.
- The storage key of the secret is unchanged (`tab-mcp:secret:<relay origin>:<server.name>`
  or `storageKey`).

### Removed

- Close code 4009 (`address_mismatch`) is no longer known: relays do not send it.

## [0.16.2][client-0.16.2] - 2026-11-14

### Removed

- The copy of an address secret from the key of 0.4 and older
  (`tab-mcp:secret:<relay origin>`, DEC-083): the library reads only
  `tab-mcp:secret:<relay origin>:<server.name>` (or `storageKey`). A visitor whose last
  visit to a page was while the page ran client 0.4 or older gets a new address there
  and pairs their AI apps again; anyone whose page has loaded client 0.5 or later since
  keeps their address. The core is 73 bytes smaller (6143 B gzipped).

## [0.16.1][client-0.16.1] - 2026-11-13

### Fixed

- With several `revoke()` calls pending, a refusal by the relay rejects only the one it
  answers: relays from 0.10.2 name the message (`for`) and the grant (`grantId`) in
  their `error`, which the library compares. Before, any `store_unavailable` or
  `unknown_id` rejected every pending `revoke()` and `signOut()`, as it still does with
  older relays.
- A grant the relay no longer knows (`unknown_id` for a `revoke()` of it: it expired)
  leaves `grants`, with `grantschange`, and its `revoke()` resolves. Before, it stayed
  listed and could not be disconnected. Grants that expire while the page is connected
  leave `grants` too, through relay 0.10.2's `grant.removed` `expired`.
- In `tools/list`, a consequential tool's description no longer ends with "The page may
  ask the user to allow each call, usually in the page's browser tab." when an
  `onConfirm` answers: the page's, or for the calls of a served port its own. Such a
  question may be anywhere (a side panel, the site's chat). 0.16.0 added the sentence
  for every consequential tool.

### Changed

- `revoke()` and `signOut()` reject with a `NetworkError` when the session ends after
  the message was sent and before the relay answered (the relay may have done it), and
  keep the `InvalidStateError` for a page that is not connected (nothing was sent). Both
  were an `InvalidStateError`. Migration: code that checks `name === "InvalidStateError"`
  for a lost session checks `"NetworkError"`.
- A rejection of `newAddress()` has `addressChanged`: `false` when the old address could
  not be taken back (kept, with its grants), `true` when the address changed and only
  connecting with the new one failed.
- The WebMCP mirror is a chunk of its own, loaded by a `TabMcp` made with `webmcp: true`
  in a browser with native WebMCP; the core went from 6400 to 6082 B gzipped. Each
  `TabMcp` still reads `document.modelContext` through `Document.prototype`'s getter when
  it is made. The tools are registered natively once the chunk has loaded, a little
  later than before.
- The README says exactly when `statechange` has a `reason`: on the change from
  `connected`, and when `disconnect()` or `newAddress()` ends connecting or
  reconnecting; not on later reconnect attempts (`reconnecting.reason` has it), a failed
  `connect()` or the `disconnected` after a refusal (the `error` before it says why).
  The behaviour is unchanged.

## [0.16.0][client-0.16.0] - 2026-11-13

### Breaking

The API before 1.0 (iteration 38). Each item says what to change.

- **`ConnectionState` has `"reconnecting"`, and the `reconnecting` event is gone.** While
  the library connects again by itself, `state` is `reconnecting` (also during an
  attempt, which used to be `connecting`); `statechange` fires for each attempt it
  schedules, and the property `reconnecting` still says which attempt is next and when.
  Migration: replace `addEventListener("reconnecting", …)` with `statechange` and
  `mcp.state === "reconnecting"`; replace `mcp.reconnecting !== undefined` tests of the
  state with `mcp.state === "reconnecting"`. A refusal that stops reconnecting comes as
  `error` (with `state` already `disconnected`) just before the `statechange` to
  `disconnected`, where it came before `reconnecting: null`.
- **The `connected` and `disconnected` events are gone; `statechange` carries the reason.**
  `statechange` has `{ state, reason? }`: `reason` (a `DisconnectReason`) on the change
  from `connected`, to `disconnected` or, when the connection broke, to `reconnecting`,
  and when `disconnect()` or `newAddress()` ends connecting or reconnecting.
  The close code is not reported any more; `DisconnectDetail` is gone, `StateChangeDetail`
  is new. Migration: `connected` → `statechange` with `state === "connected"` and
  `mcp.session`; `disconnected` → `statechange` with `e.detail.reason !== undefined`
  (for example `reason === "user"` after `disconnect()`).
- **Every event detail is an object, and `undefined` stands for nothing.**
  `pairingcode` has `{ pairingCode }` (was the code or `null`); `identitychange` has
  `{ identity, identityMessage }` (was `{ state, message? }`). Migration:
  `e.detail?.code` → `e.detail.pairingCode?.code`; `e.detail === null` →
  `e.detail.pairingCode === undefined`; `e.detail.state` → `e.detail.identity`.
- **`revoke(grantId)` returns a promise** that resolves once the relay removed the grant
  (at once for a grant not in `grants`) and rejects with an `InvalidStateError` while not
  connected, when the session ends first, and with the relay's error when it refuses
  (`code` `store_unavailable` or `unknown_id`), or with a `TimeoutError` when the relay has
  not answered within 15 s. It returned `false` when it could not send. Migration: `mcp.revoke(id).catch(showProblem)` instead of checking the boolean.
- **`signOut()` returns a promise** that resolves once the relay removed the grants, and
  rejects with an `InvalidStateError` while not connected to a relay that pairs by
  sign-in, with the relay's `store_unavailable`, and with a `TimeoutError` after 15 s;
  `identity` is cleared in any case. It returned whether it was sent.
  Migration: `mcp.signOut().catch(() => {})` in a logout that does not wait.
- **`refreshIdentity()` resolves with the new `identity`** (`"bound"`, `"refused"` or
  `"none"`) instead of `true`/`false`, and rejects with an `InvalidStateError` while not
  connected and a `TypeError` without `identityAssertion` (it resolved `false`). Migration:
  `(await mcp.refreshIdentity()) === "bound"`.
- **`newAddress()` resolves with nothing** (`Promise<void>`); it resolved with the new
  session or `undefined`. Migration: read `mcp.session` after it.
- **`confirmInPage(request, { document })`** takes the document like
  `showConnectDialog`; without it, the global document as before. Nothing to change for
  pages that use the global one.
- **The options `confirmDelayMs`, `identityTimeoutMs` and `reconnect.delaysMs` are gone**;
  the waits are fixed (750 ms, 15 s, about 5, 10, 20, 40, then 60 s). `reconnect` is a
  boolean; `ReconnectOptions` is gone. Migration: remove them; `reconnect: { … }` becomes
  `reconnect: true` (the default) or `false`.
- **The properties `address`, `appName` and `pairing` are gone.** Migration:
  `mcp.address` → `mcp.session?.address`; `mcp.appName` → `mcp.session?.appName` (the
  name the relay shows, which is the page's own unless the relay configures one); keep
  your own flag for whether you called `startPairing()`.
- **"Always allow" is "Allow until reload"**, left of Allow, with the note "X will run for
  <app> without asking, with any arguments, until you reload this page or disconnect
  <app>". The option is still `alwaysAllow`. Migration: tests and guides that look for
  the button's text.
- **React: `useTool(tool, options?)`**, without `deps`, which only registered the same tool
  again. `connectLabel` is no longer exported, `TabMcpSnapshot` has no `address`, and
  `ConnectButton`'s `data-state` is the state itself. Migration: `useTool(tool, [a], opts)`
  → `useTool(tool, opts)`; `state.address` → `state.session?.address`; a label of your
  own as `children` instead of `connectLabel`.
- **The setup steps are shorter.** ChatGPT's entry has no note (the Mac app's steps are in
  the guide), and Codex's note no longer explains how to turn the feature off. Migration:
  none for pages; an extension or page that tests the texts of `setupInstructions`
  adjusts them.
- **The dialogs' chunk is split** into the confirmation and the connect dialog (with a
  shared chunk), so a page without a relay loads no connect dialog. Code that imported the
  UI chunk's internals from a built file (`ui-<hash>.js`) points at `confirm-<hash>.js`
  (`confirmInPage(mcp, request, document, { alwaysAllow, ui })`) instead.
- **Styling: only the dialog classes and the button kinds are documented** (`.tab-mcp-dialog`,
  `.tab-mcp-connect`, `.tab-mcp-confirm`, `.tab-mcp-replaced`, `.tab-mcp-primary`,
  `.tab-mcp-danger`, `.tab-mcp-copy`); override with two classes. The check mark of a
  connected app is drawn by the stylesheet, not an inline `svg`. A Copy button's name is
  what it shows while it says "Copied" or "Press Ctrl+C", and that is what is announced
  ("Copied", not "Address copied").
- **`RegisterToolOptions.webmcp` is gone; `callers` replaces it** (iteration 40). `callers`
  lists who sees a tool: `"relay"`, `"local"` (a served port), `"webmcp"`; by default all
  of them, and WebMCP gets a consequential tool only when `"webmcp"` is listed, as with
  `webmcp: true` before. Migration: `{ webmcp: true }` → `{ callers: ["relay", "local",
  "webmcp"] }` (or only the callers that should see it); `{ webmcp: false }` →
  `{ callers: ["relay", "local"] }`; also in React's `useTool(tool, options)`. A
  `callers` that is not a list of those three, and the old `webmcp` option (which would otherwise be ignored, and an ignored `webmcp: false` would put the tool into WebMCP), throw a `TypeError`. `TabMcpOptions.webmcp`
  stays: it turns WebMCP on.

### Added

- `ui: { strings }`: every text of the dialogs in one table (`DialogStrings`, keys and
  English texts in `src/strings.ts`), replaceable key by key, with `lang` and `dir`.
- `ui: { setup: { guide, instructions } }`: the connect dialog's guide link (or none) and
  its steps per AI app.
- The connect dialog lists the tools that run without asking under each app, with "Ask
  again"; a tool registered again unchanged keeps its entry (React's `useTool`), one whose
  title or description changed is asked again.
- A Disconnect in the connect dialog that the relay could not save says so ("The relay
  could not save this. Try again.").
- The React provider disconnects its instance a moment after it unmounts, unless the
  effect ran again: under StrictMode a child's `connect({ resume: true })` is no longer
  cancelled ("The connection was cancelled").
- The connect dialog names every connected app in its confirmation ("A and B are
  connected"), not only those that paired while it was open.
- `Tool.outputSchema` (the WebMCP draft of 12 November 2026 has it): an object schema of
  the result, listed in `tools/list` and passed on to WebMCP.
- `RegisterToolOptions.exposedTo` is passed on to the native WebMCP registration of a
  mirrored tool; it was accepted and ignored.
- `serve(port, { onConfirm })`: approves the consequential calls of that port in place of
  the page's `onConfirm` and the library's dialog, for example as a question in the
  site's own chat in the user's language; relay and WebMCP calls keep the page's. Same
  answers as `onConfirm`; `request.signal` aborts when the call is cancelled, times out
  or the serve closes. The question is never sent over the port. The README recommends it
  for a site's own assistant instead of answering `true` for `kind === "local"`.
- `serve(port, { requestTimeoutMs })`: a time limit per request on the page's side, 300 s
  by default as in `createTunnelFetch` (below 2^31 ms; a `subscriptions/listen` stream is
  not limited). On expiry the call is aborted and ends as `cancelled`, a later answer is
  dropped, and the other end gets the JSON-RPC error `-31002`.
- `RegisterToolOptions.callers` (`ToolCaller[]`): which callers see a tool, `"relay"`,
  `"local"` and `"webmcp"`. `tools/list` and `notifications/tools/list_changed` are per
  caller, and a call of a tool the caller does not see is answered as for an unknown tool.
- Every result of a tool marked `untrustedContentHint` carries
  `_meta["ch.ractive.tab-mcp/annotations"]: { untrustedContentHint: true }`, through the
  relay and through a port, next to the tool's own `_meta` (MCP has no such hint; in
  `tools/list` it stays `openWorldHint` plus the original in `_meta`).
- README: a tested backend recipe for a site's own assistant (the MCP SDK's client pinned
  to 2026-07-28 next to an agent framework, the tools as function tools, untrusted results
  delimited), and page context in a read-only tool such as `get_page_context`.

### Changed

- WebMCP: a mirrored tool that returns nothing resolves as `"Done."` (the browser cannot
  serialize `undefined`, so the agent saw a failed call); an MCP result goes out as its
  `structuredContent`, else as its text with other blocks (images) named as left out,
  instead of the JSON of the whole result with base64 images.
- WebMCP: tools marked only with MCP's `destructiveHint` are left out of WebMCP unless
  their `callers` list `"webmcp"`, like `consequentialHint`, and a mirrored one is
  registered natively with `consequentialHint: true`.
- A call that is cancelled (the AI app gave up, the serve closed, its time ran out) ends
  at once, with `toolcallend` outcome `cancelled`, also when the confirmation (an own
  `onConfirm`) or `execute` does not heed the signal; what they answer later is dropped.
  Before, the call ended only when they settled.
- WebMCP: each `TabMcp` reads the native `document.modelContext` when it is made (through
  `Document.prototype`'s getter, as before), not when the library loads, so an
  origin-trial token added by a script counts for a `TabMcp` made after it. A failed
  native registration is no longer tried a second time.
- `registerTool` with an already aborted signal rejects with the signal's reason, as the
  WebMCP draft does; it resolved without registering.
- `registerTool` rejects with a `TypeError` when a hint (`consequentialHint`,
  `readOnlyHint`, any `…Hint`, `debugging`) or the `webmcp` option is not a boolean. Until
  now such a hint was dropped, so `consequentialHint: "true"` registered a tool that ran
  without asking. Other annotation keys that are not booleans are still ignored.
- Only an MCP result passes through as one: an object whose `content` is an array of MCP
  content blocks (`type` `text`, `image`, `audio`, `resource_link` or `resource`, with the
  fields that type needs, such as a string `text` or `data` and `mimeType`). Any other
  value with a `content` array (a ProseMirror document, `{ title, content: [...] }`, also
  with an empty `content`) is sent as JSON text with `structuredContent`, like other
  objects. A passed-through
  result keeps its own `_meta`. `structuredContent` is the parsed JSON text, so a `Date`
  or `URL` (whose JSON is a string) has none.
- The confirmation: one dialog at a time per document; the others wait, and the shown one
  says how many. Each dialog starts its Allow delay when it is shown, and again when
  another dialog of the page closes over it, so the second click of a double click cannot
  approve the next call. When the arguments overflow their box (now up to
  `min(50vh, 24rem)`, `--tab-mcp-arguments-height`), Allow and Allow until reload wait until
  the box has been scrolled to its end, and the dialog says so. Before the delay has run
  out, Enter or Space on a button and Escape are ignored, so typing meant for the page
  cannot refuse a call either. The dialog is described by its question (and short
  arguments) for screen readers; each Disconnect button is named for its app.
- The dialogs' elements inherit the dialog's colour, buttons reset `width`,
  `text-transform` and `letter-spacing`, and the dialogs set `pointer-events: auto`, so
  a page's `p { color: … }`, a classless framework's buttons or Radix's
  `body { pointer-events: none }` no longer change or block them.
- `serve` also ends when the port fires `close` (the other end went away), where the
  browser has that event: Bun does; Chrome only with the `MessagePortCloseEvent` Blink
  feature. Elsewhere, close the serve yourself as before.
- `newAddress()` always takes the old address back first: it connects with the stored
  secret and `hello.revokeAll`, so the relay revokes every grant of the address, whether
  the page was connected or not and whether it was taken over or not. Before, a page
  that was not connected only made a new secret, and the old address kept its grants.
  It rejects, and keeps the old secret, when the address cannot be taken back (relay
  unreachable, taken over again first). A page that never had a secret makes one without
  connecting. A second call while it runs returns the same promise; `connect()` waits
  for it. Relays of 0.4 and older cannot take an address back: `newAddress()` rejects
  there with `reason` `"policy"` (it sent `grants.revokeAll` and waited for every grant).
- `grants` is empty (with `grantschange`) after `newAddress()`.
- A refusal that stops reconnecting always emits `error`, also when a `connect()` of the
  page waited on that attempt.
- Close codes 1001, 1011, 1012 and 1013 (a proxy in front of a restarting relay) mean
  `shutdown`, so the page reconnects. The reconnect waits vary by up to 20 %.
- `hello` sends an empty page title: the relay never read it.
- Tabs of a page tell each other which address they claimed, so a tab on another address,
  or one that claimed while this tab was still connecting, no longer makes a takeover
  read as "Opened in another tab".
- The library no longer answers a relay message it cannot read with `error`.
- The connect dialog says in plain words why it could not connect or why the page was
  disconnected ("Could not connect. Check your internet connection.", "The session
  ended.", "Not connected." for a call without a user action) and offers "Connect again"
  (`.tab-mcp-retry`); the error itself goes to the console. While the library reconnects
  by itself, it says "Connection lost. Reconnecting…". Before, it showed the relay's
  message after "Could not connect:" and had no way to connect again.
- With identity binding, the connect dialog shows the address only once the relay
  accepted the page's sign-in, and says otherwise "Checking your sign-in…", "Sign in to
  this page first." or that the sign-in was not accepted, with `identityMessage`.
- The connect dialog: "How do I add it?" comes right below the address, before the code;
  "New address" moved from beside Copy to the end of the setup
  (`.tab-mcp-new-address-row`), with a line on what it does.
- The setup steps (`./setup` and the dialog) end with the step that starts the sign-in:
  `/mcp` and Authenticate for Claude Code, `codex mcp login <name>` as the third line of
  Codex's command.
- A refused Copy says on the button what to do ("Press Ctrl+C", "Press ⌘C" on Apple
  devices, "Selected" on a touch screen) instead of only telling screen readers.
  "Copied" goes back to "Copy" after 2 seconds.
- While a confirmation is open in a hidden tab, the tab's title starts with "Allow? – ".
  In `tools/list`, the description of a consequential tool ends with "The page may ask
  the user to allow each call, usually in the page's browser tab."
- The dialogs carry `lang="en"` and `dir="ltr"`, so a screen reader on a page in another
  language reads them with an English voice and a right-to-left page does not mirror
  them.

### Removed

- `<html data-tab-mcp-webmcp="…">`: the library no longer lists the tools it mirrors
  into WebMCP on the page's root element. It was made for tab-mcp for Chrome, which has
  not read it since its own review fixes. The library has no replacement for the list: a
  name that could not be registered natively is still reported by a console warning, and
  `toolcall` events with `client.kind === "webmcp"` say that an agent in the browser has
  called a tool, not that the tools are mirrored.

### Fixed

- The connect dialog's code row no longer overflows at 320 px: below 30rem, the code's
  Copy goes under the code.

- The schema check at registration no longer reads `default`, `examples`, `const` and
  `enum` values or property names as keywords: `examples: [{ pattern: "*.ts" }]` was
  refused as an invalid regular expression. A malformed `%` escape in a `$ref` is a
  `TypeError`, not a `URIError`.
- A tool result larger than the relay's `maxBodyBytes` is answered as an error result
  that gives both sizes, and `toolcallend` says `error`; before, `toolcallend` said `ok`
  and the AI app got a transport error (`-31006`) for a tool that ran. A result that is
  not JSON now also ends with `toolcallend` `error`.
- Reconnecting no longer stops for good when a `statechange` listener calls `connect()`
  after a failed attempt.

## [0.15.0][client-0.15.0] - 2026-11-13

### Added

- `mcp.serve(port, { client })` serves the page's tools over a message port, without a
  relay: for a site's own assistant, e.g. a chat in an iframe whose backend runs the MCP
  client. The port carries the relay's `http.*` messages as plain objects (a
  `MessagePort` fits, or an object of your own with `postMessage` and `onmessage`). It
  resolves with `{ close() }`, takes a `signal`, and may be called for several ports,
  next to a relay connection and `webmcp: true`. Closing it tells the other end (`bye`). A port is a key to the tools: hand it
  only to a frame whose origin you checked (README, "Your own assistant on the page";
  threat model A15).
- `@ractive-ch/tab-mcp-client/tunnel`: `createTunnelFetch({ send })` is the other end, a
  `fetch` for an MCP client such as the MCP SDK's
  (`new StreamableHTTPClientTransport(url, { fetch })`). It needs only `Request`,
  `Response` and web streams (Bun, Node, a browser frame) and shares no code with the
  page's library. A timeout (`requestTimeoutMs`, 300 s), a closed tunnel and an invalid
  answer are JSON-RPC errors with the relay's codes (`-31002`, `-31003`, `-31007`) at
  HTTP 200; only an aborted `signal` rejects.
- `relay` is optional. Without it the page offers its tools only through `serve` and
  WebMCP: `connect()`, `showConnectDialog()` and `newAddress()` reject with a `TypeError`,
  no address secret is read or written, and React's `ConnectButton` renders nothing. New
  getter `mcp.hasRelay`.
- New types `LocalClient`, `ServeOptions`, `ServeHandle`, `TunnelPort`.

### Changed

- `ToolCallClient` has a new member, `{ kind: "local", id, name? }`: the caller of a port
  served with `serve`, as the page named it. Code that switches over every `kind`, or
  treats every caller that is not `"webmcp"` as a relay's AI app (reading `host` or
  `grantId`), needs a case for it. It only occurs in pages that call `serve`. The
  library's confirmation names it "<name> (this site's assistant)" and never offers
  "Always allow" for it.
- `TabMcpOptions.relay` and the `relay` prop of `TabMcpProvider` are optional in the
  types; `ConnectButton` may return `null`.

## [0.14.0][client-0.14.0] - 2026-11-12

### Added

- `onConfirm` may return (or resolve with) `"unanswered"` besides `true` and `false`: the
  user was asked and did not answer, e.g. a question of the page's own that timed out.
  The AI app then reads "The user was asked and did not answer." instead of "The user
  declined", and an agent in the browser (`webmcp: true`) gets `{ error: "The user did not
  answer whether <tool> may run." }`. New type `ConfirmAnswer`. Before, every answer but
  `true` read as a refusal. A throw from `onConfirm` is still a refusal.

### Changed

- `ToolCallOutcome` (the `toolcallend` event) has a new member, `unanswered`. Code that
  switches over every outcome needs a case for it.

## [0.13.1][client-0.13.1] - 2026-11-12

### Changed

- A WebMCP call (`webmcp: true`) that fails resolves with `{ error: "<message>" }`
  instead of rejecting: invalid arguments, "Don't allow" (`The user did not allow <tool>
  to run.`), a tool that is gone, an error thrown by `execute` and an `isError` result.
  Chrome 156 hands the agent every rejection as a bare `UnknownError`, so it could not
  tell why a call failed or what to change. Two cases still reject: a call the browser
  cancelled (`AbortError`), and a call when the library's lazily loaded part cannot be
  loaded (a new deploy while the page stays open, the network; reloading the page fixes
  it). `toolcallend` and calls through the relay are unchanged (DEC-120).

## [0.13.0][client-0.13.0] - 2026-11-12

### Added

- `webmcp: true` (`TabMcpOptions`): the tools are also registered with the browser's own
  WebMCP (`document.modelContext.registerTool()`) where it has it, so that agents in the
  browser (built into it, or an extension) can call them. Off by default. When turned on,
  this changes what the page exposes: any agent in the browser can call the mirrored
  tools, without pairing and without an identity. Consequential tools are left out
  unless registered with `{ webmcp: true }` (`RegisterToolOptions.webmcp`, also the third
  argument of `useTool`); `{ webmcp: false }` keeps a tool out. A WebMCP call gets the
  same argument check, confirmation and `toolcall`/`toolcallend` events as an AI app's,
  never "Always allow". Only the native object is used (through `Document.prototype`'s
  getter, not a polyfill's own `document.modelContext`); a failed native registration
  only warns in the console. `<html data-tab-mcp-webmcp>` lists the mirrored names for
  tab-mcp for Chrome (DEC-115, DEC-119).

### Changed

- `client` in `execute`'s options, `ConfirmRequest` and the `toolcall`/`toolcallend`
  events is a union with a `kind`: `RelayClient` (`kind: "relay"`, with `grantId`, `id`,
  `host` and `name` as before) or `WebMcpClient` (`kind: "webmcp"`, nothing more). Code
  that reads `client.host` or `client.name` without checking `client.kind` first no
  longer type-checks; at run time, calls through the relay carry the same fields as
  before plus `kind`.
- `confirmInPage` treats a client without `kind: "relay"` as a caller in the browser: no
  "Always allow", offered or applied. A page that calls it with a client object it builds
  itself (for example for its own local MCP endpoint) has to add `kind: "relay"` to keep
  "Always allow".

## [0.12.1][client-0.12.1] - 2026-11-11

### Fixed

- The npm build no longer carries Bun's chunk preload map. A page that bundles the
  library again (Vite, webpack, Bun) got `<link rel="modulepreload">` requests for the
  library's own chunk names (`./index-<hash>.js`) when the connect dialog loaded; they do
  not exist in the page's build, so each one was a 404 and a console error. The CDN build
  keeps the map: its chunks are served beside it.

## [0.12.0][client-0.12.0] - 2026-11-11

### Added

- `@ractive-ch/tab-mcp-client/setup`: `setupInstructions(serverName, address)`, the connect
  dialog's steps per AI app (Claude, ChatGPT, Claude Code, Codex) as data (`id`, `app`,
  `text`, `command`, `note`; types `SetupInstruction`, `SetupNotePart`), and `SETUP_GUIDE`,
  the guide's address, for pages and extensions that show the steps in their own UI. An
  entry of its own, out of the core; tab-mcp for Chrome uses it (DEC-118).
- `@ractive-ch/tab-mcp-client/visible`: `escapeInvisible(text)`, the escaping the
  confirmation dialog uses for the arguments and the AI app's name, for pages (and tab-mcp
  for Chrome) that ask in their own UI. An entry of its own, not in the core.

### Changed

- The confirmation dialog also escapes C0 controls and DEL (but tab and line feed), lone
  surrogates, every space but the plain one (U+00A0, U+2007, U+3000…) and the Braille
  blank (U+2800) in the arguments and the AI app's name.
- The CDN build bundles `@cfworker/json-schema` 4.1.6 (was 4.1.4); the dependency is
  pinned to it.

## [0.11.0][client-0.11.0] - 2026-11-09

### Added

- The connect dialog confirms a connected AI app at the top: a check mark, "Claude
  (claude.ai) is connected" and what to do next, also announced to screen readers. It
  shows the same when it opens while an app is connected. New styling hooks:
  `--tab-mcp-success`, `.tab-mcp-success` (with `.tab-mcp-success-icon`,
  `.tab-mcp-success-title`, `.tab-mcp-success-next`), `.tab-mcp-setup-toggle`,
  `.tab-mcp-setup` and `.tab-mcp-code-used`.
- `PairingCode.reason` (`start`, `used`, `locked`, `expired`, type `PairingCodeReason`):
  why the relay sent the code, when it says so. A missing or unknown reason is left out.

### Changed

- Once an app is connected, the connect dialog's address, code and help are behind
  "Connect another app", closed, and Done is its primary button (also when the dialog
  opens while an app is connected; before, Done showed only after an app paired in it).
- After a code is entered, the dialog shows "Code used. Waiting for your AI app…" in its
  place for up to 10 seconds instead of the next code, until the app connects. Only when
  the relay says the code was used (see `PairingCode.reason`); codes from older relays
  show at once, as before.

### Fixed

- The confirmation shows more characters as `\uXXXX` escapes: controls (C0 and C1 but
  tab and line feed), every space but U+0020 (U+00A0, U+2007, U+3000…), the Braille blank
  U+2800 and lone surrogates, beside the format, default-ignorable (variation selectors,
  U+034F, the Hangul fillers), private-use and unassigned characters it escaped before.
- The connect dialog no longer flickers when an app connects: it no longer shows the next
  code before the app is connected, nor rebuilds its list of apps (a focused Disconnect
  keeps the focus) or, on a reconnect with the same address, its help.
- The connect dialog names an app that holds two grants (paired twice) once, in its
  confirmation and in the New address question.

## [0.10.0][client-0.10.0] - 2026-11-01

### Added

- `Tool<Input>` types `execute`'s input; `registerTool` and `useTool` infer it or take it
  explicitly. Without it, `input` stays a `Record<string, unknown>`.
- README: tools that change `useState` state, the user-action rule next to
  `ConnectButton`, its label function, and end-to-end tests with
  `@ractive-ch/tab-mcp/testing`.

### Changed

- `ConnectButton`'s default label says "Connection lost, retrying…" once three reconnect
  attempts have failed, instead of "Reconnecting…" for as long as it tries.

### Fixed

- The dialogs set `margin: auto`, so they stay centred on pages whose CSS reset sets
  `margin: 0` on every element (Tailwind's preflight).

### Removed

- `connecting.md` from the package: the guide's only source is now
  https://ractive.ch/tab-mcp/connect/.

### Changed

- The CDN build bundles `@cfworker/json-schema` 4.1.4 (was 4.1.1); the dependency is
  pinned to it.

## [0.9.1][client-0.9.1] - 2026-10-26

### Changed

- The connect dialog's "How do I add it?" is a bordered, bold row across the dialog,
  not a line of plain text, so it is easier to find.
- The help's guide link goes to https://ractive.ch/tab-mcp/connect/, not GitHub. The
  package ships the guide as `connecting.md`.

## [0.9.0][client-0.9.0] - 2026-10-25

### Added

- `server.icons` (MCP `Icon`: `src`, `mimeType`, `sizes`, `theme`), sent in
  `serverInfo` for the AI app's connector list (DEC-105). Without it, the page's
  `<link rel="icon">` and `<link rel="apple-touch-icon">` are sent; `[]` sends none.
  At most 8: `http(s):` URLs, or raster `data:` URIs up to 16 KiB (no inline SVG); only
  in `server/discover`. In the connection chunk: the core does not grow.
- The connect dialog's help links to the new guide
  [connecting an AI app](https://github.com/ractive/tab-mcp/blob/main/docs/connecting.md).

### Changed

- The dialog's ChatGPT line: chatgpt.com's Plugins, and the Mac app's MCP servers (which
  are Codex's and need its `mcp_2026_07_28` feature). Developer mode is gone.

## [0.8.0][client-0.8.0] - 2026-10-25

### Changed

- **Visible change: "Always allow" is opt-in** (DEC-096). The default confirmation now
  shows only "Don't allow" and "Allow", so every call of a consequential tool asks.
  `alwaysAllow: true` on `TabMcp` (or `TabMcpProvider`) brings "Always allow" back.
  It lifted the only brake at run time for a tool until a reload, which is what a prompt
  injection needs.
- `replaced` carries `detail: { sibling }` (was `null`): `true` when a tab of the same
  page in this browser said on a `BroadcastChannel` that the relay accepted its session
  for the address, `false` when none did (or without `BroadcastChannel`), which may be a
  program with a copy of the address secret (DEC-095). The channel carries neither the
  secret nor the address. Listeners that ignore the detail work as before.
- **Order of events when replaced:** the session ends at the relay's `bye`;
  `disconnected` (reason `replaced`) comes at once, and `replaced` after it, up to a
  second later while the library waits to hear from a sibling tab. Before, `replaced`
  came first.
- `newAddress()` after `replaced` (from the event, during that second, or later) takes
  the address back first: it connects with the old secret and `hello.revokeAll`, so the
  relay revokes the AI apps that talk to whoever took it over in the same step, and
  makes the new address only once the relay confirmed it (no grants left). Taken over
  again before that, it rejects (`reason: "replaced"`), keeps the old secret, and a retry
  takes it back again. Against a relay of 0.4 or older, which ignores the field, it sends
  `grants.revokeAll` and waits until every grant is gone. It no longer needs a fresh user
  action for the reconnect when the page was connected.
- The tools allowed with "Always allow" are kept in the lazily loaded UI chunk, which
  makes the core smaller.

### Added

- The default UI says when the page loses its address, once the page has opened the
  connect dialog: "Opened in another tab" after a sibling tab, otherwise a warning that
  another tab or program took over this page, with "New address" (the dialog
  `.tab-mcp-replaced`). The connect dialog closes then.
- The WebSocket URL carries the address id: `wss://<relay>/tab?a=<id>`, never the
  secret. The library computes the id from the secret with Web Crypto before it opens
  the socket, so a load balancer in front of several relay instances can route the page
  by it (see self-hosting, "Running several instances"). Where Web Crypto is missing (a
  page on plain `http:` other than localhost) the URL has no id, which a single relay
  accepts. The hashing is in the lazily loaded chunk; the core is unchanged.
- Close code 4009 (`address_mismatch`: the URL's id is not the secret's) is reported as
  `policy` and not retried.

## [0.7.0][client-0.7.0] - 2026-10-25

### Changed

- The default dialogs have a designed look: the title, then the one next step as the
  primary button (Copy the address; Done once an app is connected; "Don't allow" in the
  confirmation), the pairing code large in its own box, the steps per AI app one below
  the other, Disconnect buttons marked, visible
  focus rings, and the arguments wrapped (also long words) and scrolling. The look comes
  from a constructed stylesheet (no CSP exception), uses
  system colours and the page's `color-scheme` (light and dark), fits 360 px, and does
  not animate when the user prefers reduced motion. A new code or "Copied" moves nothing.
- More custom properties (`--tab-mcp-muted`, `--tab-mcp-surface`, `--tab-mcp-accent`,
  `--tab-mcp-accent-text`, `--tab-mcp-danger`, `--tab-mcp-focus`, `--tab-mcp-shadow`,
  `--tab-mcp-backdrop`, `--tab-mcp-arguments-height`) and class names on the buttons
  (`.tab-mcp-primary`, `.tab-mcp-danger`, `.tab-mcp-deny`, `.tab-mcp-allow`,
  `.tab-mcp-always`, `.tab-mcp-disconnect`, `.tab-mcp-copy`), all listed in the README.
  Each rule has the specificity of one class, and the rules for hover, focus, disabled
  and the primary and danger buttons have one class and two elements. So the page's rules
  for elements, and for an element in a state (`button:hover`, `button:focus`,
  `button:disabled`), do not change those rules. A page rule with two classes
  (`.tab-mcp-dialog .tab-mcp-primary`) does.
  Until now most values were inline styles that only the custom properties could change.
- The help ("How do I add it?") shows each command as a block with its own Copy, and has
  steps for Codex: `codex features enable mcp_2026_07_28`, which Codex 0.163 needs for the
  relay's MCP revision (for all its MCP servers; `codex features disable mcp_2026_07_28`
  turns it off), then `codex mcp add <name> --url <address>`. The commands for Claude Code
  and Codex name the server by a label made from the page's `server.name` (was always
  `tools`). The label is safe in every shell without quoting: lower case, letters without
  marks, each run of other characters as `-`, no `-` at either end, at most 40 characters,
  `tools` if empty. The help shows commands only for an address made of plain URL
  characters, and plain steps otherwise.
- The connect dialog says what each Copy did in a polite live region ("Address copied",
  "Code copied", "Claude Code command copied", or "Selected: copy it with Ctrl+C or ⌘C" when
  the clipboard is not available).
- The pairing code is `2em` by default (was `1.5em`), the default border is the text
  colour at 22 % (was `GrayText`), the default radius `0.75rem` (was `0.5rem`).

## [0.6.0][client-0.6.0] - 2026-10-24

### Fixed

- The confirmation's "Allow" and "Always allow" can be clicked only once the page has been
  visible and focused for `confirmDelayMs` with the dialog open. Until now the 750 ms ran
  from when the dialog opened, usually in a tab in the background, so the click that
  brought the tab forward could approve the call. Leaving the page disables both again;
  coming back starts the wait again (DEC-087).
- The confirmation shows characters that are invisible or change the text direction
  (U+202E, U+2066-2069, zero-width characters, tags, private-use and unassigned code
  points, C1 controls) in the arguments as `\uXXXX` escapes, so an AI app cannot make
  `"evil‮moc.elpmaxe@ecila"` read as another address. The text is still JSON for the
  same arguments, and the tool gets them unchanged. The names of the AI app and the tool
  are isolated left to right (`<bdi dir="ltr">`) (DEC-087).
- A tool result with a key `invalid` is passed through as a result; it was sent as a
  JSON-RPC error `-32602` while `toolcallend` said `ok`.
- A schema that passes `registerTool` but that the validator cannot use (a `$ref` next to a
  nested `$id`) no longer makes every call fail with `-32603` and a `toolcall` without its
  `toolcallend`. Once `connect()` has loaded the validator, it compiles each schema at
  registration: `registerTool` rejects such a schema with a `TypeError`, and a tool
  registered before `connect()` with one is unregistered and reported in the event `error`.
  Every `toolcall` now has its `toolcallend` (DEC-086).
- A consequential tool that is unregistered (or replaced under the same name) while the
  user is asked no longer runs when the user allows it: the AI app gets the error result
  "The tool is no longer available".
- `showConnectDialog()` while its dialog is open (a double click on the button) opens no
  second dialog; the call resolves when the open one closes. Two dialogs shared one
  pairing, so closing either stopped the code of both. A call for another `document` while
  the dialog is open rejects with an `InvalidStateError`.
- `confirmDelayMs: NaN` turned the delay off. The constructor now throws a `TypeError` for
  a `confirmDelayMs` or `identityTimeoutMs` that is not a number of milliseconds (finite,
  0 or more, below 2^31).
- `identityTimeoutMs` now counts from when `identityAssertion` is asked, so an assertion
  that never comes no longer leaves `identity` at `pending` for good.

### Changed

- `grants` (and the `grants` of the event `grantschange`) is a frozen array of frozen
  grants, the same array until the grants change. Pages that changed it in place get a
  `TypeError` in strict mode.
- The core grows to 5.4 KB gzipped (DEC-086).

## [0.5.1][client-0.5.1] - 2026-10-23

### Fixed

- When the relay refuses an attempt the library made by itself while reconnecting (from
  its timer, or the tab coming back to the front), the event `error` now says why, just
  before `reconnecting` turns `null`. Until now the page only saw `null` and could not
  tell a refusal from a stop. An attempt made by the page's own `connect()` still
  rejects its promise and emits no `error`.

## [0.5.0][client-0.5.0] - 2026-10-23

### Changed

- The address secret's default storage key is `tab-mcp:secret:<relay origin>:<server.name>`
  instead of `tab-mcp:secret:<relay origin>`, so two pages of one site with different
  server names no longer share an address by accident (the name is URI-encoded in the
  key; renaming `server.name` changes the address). A secret under the old key is copied
  to the new one once, so an existing page keeps its address; on a site with several pages
  the first one to connect keeps it and the others get new addresses. The old key stays,
  for pages still on 0.4 and for a rollback, and a `<old key>#moved` marker records that
  it was taken. An explicit `storageKey` is used as given, without a copy. The core grows
  to 5.1 KB gzipped (DEC-083).

## [0.4.0][client-0.4.0] - 2026-10-23

### Added

- Identity binding with relays that pair by `oidc`: the option `identityAssertion`, a
  function that returns a tab assertion from your web app's backend for the signed-in
  user and the page's address (or `null` when nobody is signed in). The library asks it
  after every connect and sends the assertion to the relay. `refreshIdentity()` asks
  again (after a sign-in without a page load), `signOut()` tells the relay the user
  signed out, which ends every AI connection of the page at once. `identity` and the
  event `identitychange` say whether the relay accepted the page's user; only the answer
  to the newest assertion counts, and `identityTimeoutMs` (15 s) ends the wait.
- `SessionInfo.pairing` (`code` or `oidc`). With `oidc` the connect dialog shows no code
  but "sign in with the account you use on this page".
- React bindings for single-page apps: `@ractive-ch/tab-mcp-client/react` with
  `TabMcpProvider`, `useTabMcp()`, `useTabMcpState()` (state, address, grants, pairing
  code, identity, reconnecting, tools; renders only on change), `useTool(tool, deps?)`
  (registers while mounted, survives StrictMode, the latest `execute` without registering
  again), `useToolCalls({ limit })` and `ConnectButton`. React 18.3 or 19 is an optional
  peer dependency; the module starts with `"use client"`; not in the CDN build.
- Reconnecting: after the connection broke (reason `network`, `heartbeat` or `shutdown`)
  the library connects again after 5, 10, 20 and 40 s, then every 60 s, and at once when
  the tab comes back to the front or the network returns. The property and event
  `reconnecting` report it; the option `reconnect` (`false`, or `{ delaysMs }`) changes
  it. A reconnect asks `identityAssertion` again like a fresh connect. An attempt the
  relay refuses (not merely unreachable) stops reconnecting.
- `identityMessage`: why the relay refused the page's identity, while `identity` is
  `refused`.
- `confirmInPage(request)`: the library's own confirmation dialog, for an `onConfirm`
  that hands some calls to it.

### Changed

- The library now reconnects by itself by default (see above). Pages that reconnected in
  their own `disconnected` listener keep working (the library then does not schedule its
  own attempt) but can drop that code; `reconnect: false` keeps the old behaviour.

## [0.3.0][client-0.3.0] - 2026-10-23

### Added

- A Copy button next to the pairing code in the connect dialog, like the address's Copy
  ("Copied" once copied). It copies the code shown at the time, and is back to "Copy"
  when a new code appears. The code is plain, selectable text (one click selects it).

### Changed

- The connect dialog has no prominent button under the code until an AI app connects:
  only a small Close at the bottom (and Escape), next to a note that closing stops the
  code while the address stays the same, and that the page can show it again. Once an
  app connects in the dialog, a "Done" button replaces it. Pages and tests that click
  "Close" after pairing should click "Done".
- The connect dialog opens with the focus on the address's Copy instead of Close. The
  two Copy buttons are labelled "Copy address" and "Copy code" for assistive technology.

## [0.2.0][client-0.2.0] - 2026-10-20

### Added

- "Always allow" in the default confirmation. That tool then runs without asking for that
  AI app until the page is reloaded or the app is disconnected. Like "Allow", it stays
  disabled for a moment after the dialog opens. A custom `onConfirm` is asked every time,
  as before.
- The events `toolcall` and `toolcallend`: every call of a known tool by an AI app as it
  starts (id, tool, arguments, AI app) and as it ends (outcome `ok`, `error`, `declined`
  or `cancelled`, the result, the duration). For an activity log in the page.

## [0.1.0][client-0.1.0] - 2026-10-20

The first stable release, on the npm dist-tag `latest`; install without `@alpha`.

### Added

- "New address" in the connect dialog. It calls `newAddress()`, which disconnects every
  connected AI app and makes a new address. While apps are connected, the dialog first
  names them and asks.
- The connect dialog notes that a new pairing code appears every 2 minutes and after each
  use, and announces each newly connected AI app.

### Changed

- The default dialog says "AI app" instead of "AI tool": its title is now "Connect your
  AI app". Pages that quote the old wording should follow.
- `appName` must be 1-64 characters without control characters, as the relay requires
  (before, only the length was checked).
- README: how to get a relay, pairing, consequential tools and your own UI. Cursor is no
  longer named among the AI apps, because it cannot connect yet.

## [0.1.0-alpha.1][client-0.1.0-alpha.1] - 2026-10-20

No changes to the library. Published through the release workflow (trusted publishing)
to validate it; the release step now reads `npm view` output from npm 11 and 12 alike.

## [0.1.0-alpha.0][client-0.1.0-alpha.0] - 2026-10-19

First alpha of the browser library, on the npm dist-tag `alpha`.

### Added

- `TabMcp`: register tools WebMCP-style (`registerTool` with JSON Schema input, annotations
  and an abort signal), connect to a tab-mcp relay and answer MCP requests in the page.
- A small core; `connect()` loads the connection and the dialogs on demand.
- Default dialogs: "Connect your AI tool" with the address and connected apps, and a
  confirmation for consequential tools.
- ESM build for bundlers with type declarations, and a self-contained build for
  `<script type="module">` under `@ractive-ch/tab-mcp-client/cdn`.
- The connect dialog shows the pairing code from the relay.

[client-0.23.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.23.0
[client-0.22.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.22.0
[client-0.21.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.21.0
[client-0.20.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.20.0
[client-0.19.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.19.0
[client-0.18.1]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.18.1
[client-0.18.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.18.0
[client-0.17.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.17.0
[client-0.16.2]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.16.2
[client-0.16.1]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.16.1
[client-0.16.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.16.0
[client-0.15.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.15.0
[client-0.14.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.14.0
[client-0.13.1]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.13.1
[client-0.13.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.13.0
[client-0.12.1]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.12.1
[client-0.12.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.12.0
[client-0.11.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.11.0
[client-0.10.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.10.0
[client-0.9.1]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.9.1
[client-0.9.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.9.0
[client-0.8.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.8.0
[client-0.7.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.7.0
[client-0.6.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.6.0
[client-0.5.1]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.5.1
[client-0.5.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.5.0
[client-0.4.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.4.0
[client-0.3.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.3.0
[client-0.2.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.2.0
[client-0.1.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.1.0
[client-0.1.0-alpha.1]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.1.0-alpha.1
[client-0.1.0-alpha.0]: https://github.com/ractive/tab-mcp/releases/tag/client-v0.1.0-alpha.0
