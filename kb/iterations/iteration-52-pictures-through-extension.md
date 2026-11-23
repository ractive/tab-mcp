---
type: iteration
title: "Iteration 52: pictures through the extension"
status: in-progress
description: >-
  An AI app connected to a page through the tab-mcp browser extension got no pictures
  from the page's tools: the client library reduced every WebMCP result to text. The
  extension now announces every call it makes for an AI app (a vouch as before, a new
  claim for read-only tools), asks for the whole MCP result, and the library gives it
  that, images included; any other WebMCP caller gets text as before. Needs a client
  and an extension release.
timestamp: 2026-11-23T21:00:00+01:00
tags: [iteration, client, extension, webmcp, privacy]
---
# Iteration 52: pictures through the extension

Stacked on iteration 51 (`iter-51/webmcp-on-click`, PR 234). The owner approved on
2026-11-23 ("ok, plan it and implement it") after the explanation that the extension
says "the next call is mine" before every call and the library then gives it the
picture. Decision: DEC-224.

## The problem

- A page tool can answer with a picture (saturnus's `read_display`, the diagram
  editor's `get_image`). Through the relay the AI app gets it.
- Through the extension it gets "[image content left out: WebMCP results are text.]":
  `webMcpCall` (`packages/tab-mcp-client/src/mcp.ts`) resolves every WebMCP call with
  `webMcpValue` (`mapping.ts`), the `structuredContent` or the text (DEC-143, made for the
  browser's own AI, which gets results as JSON text).
- The extension carries MCP results (`resultOf` in `worker/bridge.ts`), but the library
  can tell its call from the browser's AI only by the vouch (DEC-207), which the
  extension sent only for calls it asked about (`#allowedThenRun`).

## The design

1. The extension announces every page-tool call it makes for an AI app through the
   relay, right before `executeTool`, as the vouch was: `vouch` when the user allowed
   the call (as before), `claim` for a read-only tool (new). Same fields (`tool`,
   `arguments`, `nonce`, `app`), both with `result: "mcp"`, both withdrawn after the call.
2. The library keeps claims with vouches. A matching call is named as the AI app's
   (`via`, `name`, `host`); only a vouch skips `onConfirm`. With `result: "mcp"` it
   resolves with the whole MCP result; every other WebMCP call as before.
3. The extension passes the result on with `resultOf`, as it does for `@mcp-b/global`
   pages, with three changes below.

**Why a claim, not a vouch for read-only calls** (settled from the code): a vouch skips
`onConfirm`. A tool marked `readOnlyHint` and `consequentialHint` (or `destructiveHint`)
is read-only for the extension, which does not ask; a vouch would skip the page's
`onConfirm` for a call nobody allowed. A library of 0.23 or older takes any vouch, but
ignores unknown types (`handshake.ts`), so a claim leaves it as today.

**Why `result: "mcp"`**: an older extension's vouch (no `result`) must get today's value:
its `resultOf` drops `structuredContent` and turns a result with any block other than
text or a base64 PNG/JPEG/GIF/WebP image into its whole JSON as text.

## The value a vouched or claimed call resolves with

`mcpParts` (`mapping.ts`), used by `webMcpCall` with `whole`:

| `execute` returned | Resolves with (whole) | Today and for any other caller |
|---|---|---|
| an MCP result | `{ content, structuredContent?, isError? }` (no `_meta`) | `structuredContent`, else the text with "left out" lines |
| an MCP result with `isError` | the same, `isError: true` | `{ error: "<text>" }` |
| it threw; invalid arguments; gone; `onConfirm` refused (claim) | `{ content: [{ type: "text", text: "<message>" }], isError: true }` | `{ error: "<message>" }` |
| a string, another value, `undefined` | as today (`"Done."` for `undefined`) | the same |

The extension's `resultOf` (`src/result.ts` since the review of PR 236) then gives the
AI app (read from the code, the limits tested in `bridge.test.ts`):

- text blocks, all together cut to 100,000 characters (`MAX_RESULT`), the notes below
  counted first;
- PNG, JPEG, GIF, WebP images with base64 data, up to 640 KiB of base64 together
  (`MAX_IMAGES_BASE64`); one beyond is a note line (as before);
- `isError` (as before);
- **new:** `structuredContent` (an object) where its JSON fits in what the text left of
  the 100,000 (it was dropped), else a note line; so text + images + structured stay
  under the relay's 1 MiB as before;
- **new:** the text of an embedded text resource, after its uri, as a text block;
- **new:** each other MCP block (audio, `resource_link`, a binary `resource`, an image of
  another type, or not base64, with its own reason) is a line "[… was left out: …]"
  (before, the whole result went out as its JSON, cut, base64 included);
- **new:** past 32 blocks (`MAX_BLOCKS`; 31 with `structuredContent`, whose note may need
  the last) the rest are one line (before: the whole JSON).
- A value that is not MCP blocks (a ProseMirror `content`) stays text, as before.
- 2 MiB (`MAX_SEND_RESULT`, content script) refuses a longer result, except an MCP
  result, which the content script first makes what the AI app gets (`shrunk`, the same
  function), so that a picture of several MiB is a note, not a failed call (review of
  PR 236; before this iteration the library sent such a result reduced to text). The
  worker's pass over the shrunk result changes nothing.

## The way through the page

Every path stringifies the page's value and the content script receives a string:
Chrome's own `executeTool` (JSON by the browser), the page-world polyfill over a
`MessagePort` (`chrome/webmcp-main.ts`, `resultText`), Firefox's exported
`executeTool` (`firefox/webmcp.ts`). A 300 KiB picture is 409,600 base64 characters,
under the 2 MiB and the 640 KiB. Seen in the browser tests: the AI app gets the image
block with the page's exact bytes in Chrome 156 (its WebMCP), Chrome 156 (the
extension's polyfill) and Firefox 160.

## Vouches and claims in the page

16 wait at most (`MAX_VOUCHES`), each 2 s (`VOUCH_MS`); the seventeenth drops the
oldest, whose call runs unannounced: text, and `onConfirm` for a vouched tool that asks;
it never fails (client unit test). Kept at 16: the relay runs at most 8 requests per
tab at once by default (`maxConcurrentRequests`), the extension is one tab, and each
announcement is used or withdrawn when its call ends. Equal concurrent calls of two AI
apps can swap their names in the page's events; both get whole results.

## `trustExtension: false`

Claims are ignored as vouches are: no AI app named, the result as text. Said in the
client README and in `types.ts`.

## What the page newly learns

While AI access is on: the AI app (name, verified host) and the tool of every call the
extension makes there for an AI app, read-only ones included (the `toolcall` event's
`client` then has `via`, `name`, `host`, and `allowed`: `true` only for a call the user
allowed, `false` for a claimed one; review of PR 236). Nothing new while off (DEC-221). Residual
(threat model A14): an agent in the browser that calls the same tool with equal
arguments in the moment before the extension's call reaches the page takes the vouch or
claim, and with it the whole result (pictures) and the AI app's name; the extension's
call then gets text.

## Old and new

| Extension | Library | Read-only tool | Tool the user allowed |
|---|---|---|---|
| old | old | text, unnamed | vouched, text |
| old | new | text, unnamed (no claim) | vouched, text (no `result`) |
| new | old | text, unnamed (claim ignored) | vouched, text (`result` ignored) |
| new | new | whole result, named | vouched, whole result |

No row is worse than today. A new extension with a page that answers in its own code
(not the library): it may take or ignore the claim; the extension's unwrapping is the
only change it sees.

## Rejected

- A vouch for every call: skips `onConfirm` for read-only-and-consequential tools, also
  in old libraries (above).
- Images to every WebMCP caller: DEC-143's reason holds for the browser's AI.
- Telling callers apart another way: WebMCP gives the page nothing to tell them by.

## Tasks

- [x] Client: claims in `handshake.ts` (mirror chunk, 1967 to 1995 B of 2048 B
  gzipped), `callFromWebMcp` and `webMcpCall` with `whole`, `mcpParts`; the core
  unchanged (6358 to 6356 B).
- [x] Extension: claim for read-only AI-app calls (`#allowedThenRun`, `Vouch.allowed`,
  `PageHandshake.vouch`), `resultOf` with `structuredContent`, notes, 32 blocks.
- [x] Unit tests: client `handshake.test.ts` (claim, whole, older vouch, failures,
  `trustExtension: false`, withdraw, the seventeenth), extension `handshake.test.ts`
  (claim message, bridge, both sides with a picture) and `bridge.test.ts` (unwrapping).
- [x] Browser tests, Chrome (its WebMCP, the polyfill) and Firefox: the picture whole,
  a page script's call gets text and no name, a tool that asks is asked in the panel
  and not in the page (`onConfirm` recorded); each check failed against a mutant first.
- [x] Docs: client README, extension README and PRIVACY.md, both threat models,
  `kb/design/extension.md`, the skill, changelogs, DEC-224, DEC-207 and DEC-143 amended.
- [x] Review of PR 236: an MCP result over 2 MiB shrunk in the content script
  (`src/result.ts`, shared with the worker), `client.allowed`, the README's `onConfirm`
  line, a note for dropped `structuredContent`, its own reason for an image that is not
  base64, text resources as text.
- [ ] Not here: the site's privacy page (ractive.ch), saturnus, releases.

# Citations

- [Decision log](/decision-log.md), DEC-143, DEC-207, DEC-215, DEC-221, DEC-224
- [Iteration 48: the handshake](/iterations/iteration-48-page-extension-handshake.md)
- [Iteration 51: WebMCP on a click](/iterations/iteration-51-webmcp-on-click.md)
- [Review of 2026-11-13](/research/review-2026-11-13.md), "MCP-style return values go out to WebMCP as the JSON of the wrapper"
