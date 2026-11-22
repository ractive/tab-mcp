---
type: research
title: "Code review of tab-mcp, 2026-11-22"
description: Implementation review at a6e154c, with four newly reproduced correctness bugs and four reconfirmed findings from the website and code review, including fixes to consider and regression-test cases.
tags:
  - review
  - correctness
  - relay
  - client
  - extension
timestamp: 2026-11-22T00:00:00+01:00
---

# Code review of tab-mcp, 2026-11-22

This is a separate implementation review requested after the
[website, code and wording review](review-2026-11-22.md). It focuses on runtime
correctness, state transitions, cancellation, limits, schema handling and tool
registration. Website copy and editorial recommendations are outside this report.

Four additional bugs were reproduced. The four code findings from the earlier review
were also reproduced against the current checkout. All eight are P2: actionable bugs
with specific triggering conditions. No P0 or P1 finding was established in this pass.
The findings are not fixed by this report.

## Revision and scope

- **Reviewed revision:** `a6e154c3c20148490c41c1196a5b2abfaf659112` (`a6e154c`).
  The earlier report covered `09704a2`; the intervening changes package the agent
  skill and update its documentation and release checks. The runtime files cited
  below are unchanged between those revisions.
- **Relay:** request admission and forwarding, page waits, session cleanup,
  streamed responses, authentication and revocation paths, token issuance and
  refresh, memory-store semantics, JWT/key handling and CIMD/IP checks.
- **Browser library:** tool registration and validation, MCP call execution,
  confirmation and cancellation, relay and local transports, connection recovery,
  secret rotation, WebMCP mirroring, extension handshake and React lifecycle code.
- **Extension:** bridge validation and approvals, navigation, fallback WebMCP
  registry, permission decisions, connection coordination and settings storage.
- **Packaging:** inspected the newly added skill packaging and tarball checks.
- **Method:** source inspection, existing-test inspection, temporary Bun
  reproductions, a generated-command shell check and a fresh repository verification
  run. The reproductions use local fixtures or in-memory objects; no production
  service was modified.
- **Changes:** only this report and its knowledge-base index entry are added for
  this request. The earlier report and its index entry were already uncommitted.

This was a focused review of the listed implementation paths, not an assertion that
every line, browser platform or deployed configuration has been exhaustively tested.
Line numbers below refer to the reviewed revision.

## Findings

### CR-01 — [P2] Reserve request capacity before yielding from admission

**Location:** [relay.ts](../../packages/tab-mcp/src/relay.ts), lines 1343–1374;
[session.ts](../../packages/tab-mcp/src/session.ts), `forward`, lines 729–765.

`admit()` checks `session.pending.size` and the grant's number of listen streams,
then returns the session through an asynchronous boundary. `handleMcp()` adds the
exchange to those counters only after `await admit(...)` resumes. Several requests
released together can therefore all observe the same available capacity.

**Reproduction A — site limit:** start a relay with an instance limit of 16 and a
site limit of two. Issue a test token for a page that has not connected during this
relay process. Send eight requests while the page is absent; they can wait under the
instance limit because its site is not known yet. Connect that page and leave its
requests unanswered. **All eight requests reach the page**, although its advertised
limit is two.

**Reproduction B — listen limit:** with the normal page limit of 16, queue eight
`subscriptions/listen` requests under one grant while the page is absent, then
connect it. **All eight reach the page**, bypassing the explicit per-grant limit of
two. This case does not depend on a site-specific configuration.

The second case lets one connected AI app occupy more long-lived slots than intended;
listen streams have no request timeout. The first lets the page receive more concurrent
work than its operator configured. These are authenticated requests, not an
unauthenticated cross-user access finding.

**Suggested correction:** check and reserve both capacities in the same synchronous
step as adding the exchange, after the last `await`. A reservation made earlier must
be released on every refusal, cancellation and retry.

**Regression tests:** hold eight requests until a page connects, assert no more than
two reach it in each scenario, and assert excess admitted requests receive 429. Also
check that cancellation releases capacity. Existing page-wait tests use an already
known site's limit, which prevents the first burst from forming.

### CR-02 — [P2] Keep a rotated secret when storage cannot overwrite the old value

**Location:** [secret.ts](../../packages/tab-mcp-client/src/secret.ts), lines 55–78;
[tab-mcp.ts](../../packages/tab-mcp-client/src/tab-mcp.ts), `#renew`, lines 703–709.

`rotate()` stores the new secret in memory and catches a failed `setItem()`, promising
a page-lifetime fallback. However, `current()` always prefers a valid value returned
by `getItem()`, including the old value that the failed write left behind. The next
connection silently switches back to the old secret.

**Minimal reproduction:**

```ts
// Import SecretStore and newSecret from the client's src/secret.ts.
const old = newSecret();
const storage = {
  getItem: () => old,
  setItem: () => { throw new Error("read-only storage"); },
};
const secrets = new SecretStore(storage, "review");
const fresh = secrets.rotate();
console.log(fresh !== old);               // true
console.log(secrets.current() === fresh); // false
console.log(secrets.current() === old);   // true
```

The public `TabMcp.disconnectAll()` path was also exercised against `StubRelay` with
this storage. Its take-back connection sent the old secret with `revokeAll: true`,
then its supposedly fresh connection sent **the same old secret**, without
`revokeAll`. `disconnectAll()` resolved successfully.

Existing grants are still revoked by the take-back step; the failure is the promised
secret rotation. If someone else holds the old secret, rotation has not removed
their ability to claim that page's address again. This requires readable storage
whose writes fail, such as a failing custom storage implementation; it is not a
failure of ordinary successful writes.

**Suggested correction:** retain an explicit unsaved-memory state after a failed
rotation and avoid reading the stale stored value over it. Alternatively, reject the
rotation explicitly instead of reporting success with the old secret. The analogous
`#unsaved` handling in `always-allowed.ts` is useful precedent.

**Regression tests:** cover an existing valid stored secret with readable storage and
failing writes, both through `SecretStore` and through `disconnectAll()`. The current
fallback test makes both reads and writes throw, which misses this case.

### CR-03 — [P2] Track SSE boundaries across chunks

**Location:** [exchange.ts](../../packages/tab-mcp/src/exchange.ts), line 458,
with consequences in `#scheduleKeepAlive()` and `fail()`.

`#atBoundary` is calculated from the most recent chunk alone. A valid SSE event
terminator can span two `http.response.chunk` messages. After chunks
`"data: {}\n"` and `"\n"`, the accumulated stream is between events, but
`endsAtBoundary("\n")` returns false.

**Reproduction:** create an `Exchange`, start a `text/event-stream` response, send
those two chunks, wait through several 10 ms keep-alive intervals, then call `fail()`.
The resulting body is only `"data: {}\n\n"`: **no keep-alive and no terminal error**.
Sending the identical bytes as one chunk produces both keep-alives and the error.

Long-lived streams can consequently go silent and be dropped by intermediaries.
Cancellation, timeout or page-loss errors can also be omitted even though there is
a safe event boundary. This can arise in normal chunking; it does not require a
malformed page response.

**Suggested correction:** retain enough trailing stream characters to recognize
LF, CRLF and CR boundaries across writes, or maintain a small incremental framing
state. Continue suppressing keep-alives inside an unfinished event.

**Regression tests:** split each supported event terminator at every character
boundary and check both keep-alives and a final failure event. The existing test
splits an event's JSON but leaves its final `\n\n` together in one chunk.

### CR-04 — [P2] Track context ownership by registration, not a stale name

**Location:** [registry.ts](../../packages/tab-mcp-extension/src/webmcp/registry.ts),
`provide`, lines 227–238, and `#remove`, lines 298–303.

The fallback WebMCP registry keeps the last `provideContext()` tool names in
`#provided`. Unregistering one of those tools removes it from `#tools` but leaves its
name in `#provided`. If `registerTool()` subsequently registers a new tool with that
name, the next `provideContext()` still treats the new registration as its own and
deletes or replaces it.

**Minimal reproduction:**

```ts
// Import ToolRegistry from the extension's src/webmcp/registry.ts.
const registry = new ToolRegistry(() => {});
registry.provide([{ name: "save", description: "old context", execute() {} }]);
registry.unregister("save");
registry.register({ name: "save", description: "independent tool", execute() {} });
registry.provide([]);
console.log(registry.get("save") !== undefined); // false; should be true
```

The affected tool disappears for pages mixing the compatibility context API and
individual registrations. The shared registry is used by the Chrome fallback and
Firefox implementation; this reproduction exercised the shared implementation,
not a fresh manual run in both browsers. `records()` also mislabels the replacement
as provided, so restoring a registry can preserve the ownership error.

**Suggested correction:** clear ownership on removal or associate context membership
with the actual entry rather than its name. Ensure replacing a context cannot remove
a later independent registration.

**Regression tests:** exercise the sequence above, replacement by a new context
tool of the same name, and `records()`/`restore()` after the independent registration.

### CR-05 — [P2] Invalidate pending approval when the tool definition changes

**Location:** [bridge.ts](../../packages/tab-mcp-extension/src/worker/bridge.ts),
`sameTool`, lines 471–476, used after confirmation at lines 655–660.

Reconfirmed from finding 1 of the earlier report. `sameTool()` compares tab,
document, origin, name and read-only status, but omits the description, title,
schema and consequential status. A call waiting for approval can therefore execute
after the description and consequences of its tool changed.

**Observed:** start `callByName()` for “Save a draft only”; while confirmation is
pending, change the tool to “Publish the draft publicly”, set its consequential
hint and refresh the bridge. Keeping its name, document and read-only status the
same is enough for the old approval to pass. The reproduction recorded one call.

**Suggested correction:** compare a stable fingerprint of the approved definition
or a registration generation after confirmation, and reject a changed definition.
Re-check the arguments against any definition that is permitted to survive an update.

**Regression test:** hold confirmation, refresh a changed tool, then approve and
assert the browser call is not made. Exercise both the named bridge tool and
`webmcp_call`. This is approval consistency, not a claim that page descriptions
provide a security boundary against a malicious page.

### CR-06 — [P2] Do not make valid input impossible when stripping patterns

**Location:** [bridge.ts](../../packages/tab-mcp-extension/src/worker/bridge.ts),
`withoutPatterns`, lines 190–220, called by `schemaFor()`.

Reconfirmed from finding 2 of the earlier report. Removing `patternProperties` while
retaining `additionalProperties: false` changes the accepted argument set in the
wrong direction:

```json
{
  "type": "object",
  "patternProperties": { "^x-": { "type": "string" } },
  "additionalProperties": false
}
```

**Observed:** the original schema accepts `{"x-name":"Alice"}`. The offered schema
becomes `{"type":"object","additionalProperties":false}` and rejects it. The
extension blocks the call before the page can apply its own validation.

**Suggested correction:** keep the reason for removing untrusted regular expressions,
but use a conservative transformation that does not reject valid page input. Simply
dropping keywords is not generally safe in JSON Schema: negation and conditional
branches also need consideration.

**Regression test:** validate the same patterned-property arguments before and after
transformation, and cover the combinations with additional properties and negation.

### CR-07 — [P2] Compile output schemas before advertising them

**Location:** [mcp.ts](../../packages/tab-mcp-client/src/mcp.ts), `compileTool`,
lines 112–133; registration prechecks are in
[registry.ts](../../packages/tab-mcp-client/src/registry.ts).

Reconfirmed from finding 3 of the earlier report. Registration applies lightweight
checks to both schemas, but the lazy compiler only processes `inputSchema`.
Consequently, a reference that looks valid against the root but resolves differently
under a nested `$id` can pass as an output schema and be advertised to clients.

**Reproduction schema:**

```json
{
  "type": "object",
  "$defs": { "s": { "type": "string" } },
  "properties": {
    "a": { "$id": "https://y.example/t", "$ref": "#/$defs/s" }
  }
}
```

**Observed:** `compileRegistry()` returns no errors and keeps the tool when this is
its output schema. As an input schema, `compileTool()` rejects its unresolved
reference. The installed MCP client's Ajv validator also fails to compile it
(`RangeError: Maximum call stack size exceeded` in this run). Advertising it can
therefore break the client's validator setup.

**Suggested correction:** apply the same supported-schema compilation checks to
output schemas and report the correct schema name in registration errors. This
does not require validating every returned result against its output schema, which
is a separate design choice.

**Regression tests:** run this schema through registration before and after loading
the lazy compiler, as input and output; assert the invalid tool is refused or removed
consistently and the error identifies `outputSchema`.

### CR-08 — [P2] Do not emit unquoted IPv6 addresses as shell-safe arguments

**Location:** [command.ts](../../packages/tab-mcp-client/src/command.ts),
`commandAddress`, lines 33–39.

Reconfirmed from finding 4 of the earlier report. The whitelist includes `[` and
`]`, so setup instructions emit this command for a supported IPv6 loopback relay:

```sh
claude mcp add --transport http test http://[::1]:8080/s/test/mcp
```

In zsh the brackets undergo filename expansion. A shell-only reproduction fails
with `no matches found`, before a client command can execute. This is a broken
setup path, not a demonstrated shell-injection vulnerability.

**Suggested correction:** provide appropriate shell quoting, or reject brackets
from the universal unquoted subset and use the existing instruction-only fallback.

**Regression test:** verify the IPv6 setup path with zsh or assert it uses the
fallback; string-matching the generated command alone does not test shell behaviour.

## Assessment and follow-up

The code has useful separation between the registry, call execution, transport and
extension bridge. Shared call execution reduces drift between local, relay and
WebMCP callers. The relay also distinguishes store outages from bad credentials,
and its token-store tombstones explicitly handle revocation races. These are
strengths visible in the inspected implementation, not a blanket security verdict.

The new failures concentrate on state that spans asynchronous boundaries or multiple
representations: admission versus reservation, storage versus memory, chunks versus
the stream, and a name versus the registration that owns it. The proposed regression
tests should exercise those transitions rather than only the final happy-path state.

Address CR-01 and CR-02 first because they undermine explicit resource and recovery
guarantees. CR-05 also deserves early attention because it concerns what the user
approved. The remaining fixes can be scoped independently. No broad refactor is
needed to establish or correct these findings.

## Validation

The eight findings were reproduced against the reviewed checkout. The new request
limit tests used a real local relay and scripted WebSocket page; the rotation test
also exercised the public library against a stub relay. SSE and fallback-registry
tests directly exercised the production classes. Temporary scripts were kept outside
the repository, and no production code or test files were changed.

`bun run verify` exited successfully on the reviewed revision:

- Biome CI passed; no fixes were applied.
- All workspace type checks passed.
- **1,886 tests passed, one skipped and zero failed**, across 86 test files
  (225.60 seconds for `bun test`).
- The conformance run reported 112 passed and 64 failed scenarios across its runs;
  its baseline check passed because all failures were expected. This is not a claim
  that every conformance scenario passed.

An initial local-relay reproduction could not bind a socket inside the sandbox;
the reproduction and full verification then ran successfully with local server and
browser access. These were test-environment permissions, not production changes.

The passing suite does not contradict the findings: the reproductions exercise
conditions its current tests miss. The suggested regression cases above should fail
against this revision before their corresponding fixes are implemented.

## Outcome

Added 2026-11-22. CR-01 to CR-04 were reproduced against main at `9f11a91` (after
pull request 202) with the regression tests the review asks for, which failed before
their fixes, and fixed in [tab-mcp#206](https://github.com/ractive/tab-mcp/pull/206),
one commit each.

- **CR-01, fixed.** Reproduced as described: eight held requests all reached a page
  whose site allows two, and eight listen streams of one grant all reached the page.
  The two limits are now checked in `handleMcp`'s loop, after the last await, in the
  same synchronous step as `session.forward()`, which counts the exchange; no separate
  reservation is needed, since a refused, ended, cancelled or resent request leaves
  `pending` when its exchange ends. Tests in `packages/tab-mcp/test/page-not-open.test.ts`
  ("CR-01: …"): both bursts (two forwarded, six 429), and that cancelling the held
  requests lets the next one through.
- **CR-02, fixed.** Reproduced through `SecretStore` and `disconnectAll()` (the
  "fresh" connection sent the old secret). `SecretStore` keeps an unsaved state, as
  `always-allowed.ts` does: after a rotation that could not be written, `current()`
  returns the secret in memory and does not read storage until a write succeeds. After a
  reload the page reads the old secret again, whose grants were revoked; the README and
  the threat model say so. Tests in `packages/tab-mcp-client/test/secret.test.ts`.
  Core bundle 6283 to 6297 B gzipped, React closure 13486 to 13514 B.
- **CR-03, fixed.** Reproduced; mixed line ends (`\n\r\n`, `\n\r`) failed even in one
  chunk, which the review did not mention. `Exchange` keeps a framing state (between
  events, line has text, last character a CR) updated by every write. Tests in
  `packages/tab-mcp/test/hardening.test.ts`: six event ends split at every character,
  each with keep-alives and the final error event, and streams left inside an event.
- **CR-04, fixed.** Reproduced with the review's sequence. The registry keeps the
  context's entries, not names; removing a tool drops its entry, and the quota counts
  the live ones. Tests in `packages/tab-mcp-extension/test/unit.test.ts` ("CR-04: …"):
  the sequence, a new context with a tool of that name, `records()`/`restore()`.
- **CR-05 to CR-08:** fixed in [tab-mcp#205](https://github.com/ractive/tab-mcp/pull/205)
  (DEC-217), as findings 1 to 4 of the
  [website, code and wording review](review-2026-11-22.md); its Outcome says where and
  with which tests.
