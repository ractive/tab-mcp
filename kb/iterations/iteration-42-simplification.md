---
type: iteration
title: "Iteration 42: simplification of the relay and the client"
status: completed
description: >-
  The owner's decisions on the review's simplification table (DEC-178). Relay: the
  duplicated small helpers in one module each (RQ 14), no hung-read bookkeeping in
  /healthz (RQ 17), the CIMD test mode as an injected URL policy and no unused options
  or test helper in production code (RQ 18), no "Already connected" page (RQ 16).
  Client: no copy of the secret from the 0.4 key (DEC-083 amended). About 120 lines of
  relay source and 40 of client source fewer; the client core 6216 to 6143 B.
timestamp: 2026-11-14T18:00:00+01:00
tags: [iteration, relay, client, review, simplification]
---
# Iteration 42: simplification of the relay and the client

The owner's decisions of 2026-11-14 on the table "Simplification, for the owner to
decide" of the [review of 2026-11-13](../research/review-2026-11-13.md), recorded as
DEC-178. Branch `simplify/relay-client`. The extension's rows (question window,
`Starter`) go in a separate extension PR.

## 1. Duplicated relay helpers (RQ 14)

Nothing may change in behaviour.

- [x] `src/crypto.ts`: `randomBase64url`, `sha256Base64url`, `constantTimeEqual`; used by
      `tokens.ts`, `address.ts`, `identity.ts`, `oauth/server.ts`, `oauth/oidc.ts`,
      `oauth/pairing.ts` (three `random`, four SHA-256 and two compare copies gone)
- [x] `readCapped` in `src/body.ts`: one counting reader for request bodies
      (`readBodyWithDeadline`), the JWKS fetch (`fetchJson`) and the CIMD fetch
- [x] `checkTimes` in `src/jwt.ts` for the tab assertion and the client assertion: same
      reasons, same texts, same order of checks; returns how long a `jti` is kept
- [x] `clientHost` exported from `session.ts`, used by the MCP endpoint instead of its
      inline copy
- [x] The PKCE pattern once (`VERIFIER` also checks the code challenge)
- [x] Left as is, on purpose: the ID token's time checks in `oidc.ts` (they throw
      `OidcError` with reasons of their own and require `iat`, so sharing would change
      the logged reason); `hostOf` in `oauth/server.ts` (it names redirect URIs too, and
      gives the scheme for a URL without a host, unlike `clientHost`); the URL rules and
      the expiring key sets the finding also lists (not in the owner's list)

## 2. Hung-read bookkeeping of `/healthz` (RQ 17)

- [x] `hungReads`, `lastHungAt`, `HEALTH_HUNG_RETRY_MS` and the `healthRetryMs` hook gone;
      the single flight, the one-second deadline and the one-second reuse stay (DEC-099)
- [x] Tests: a hanging store answers `store_timeout` and the answer is reused within the
      second; a store that recovers is read again after the reused second
- [x] `docs/self-hosting.md`: the 30-second sentence removed

## 3. Test hooks and unused options in production code (RQ 18)

- [x] CIMD: `UrlPolicy` (`schemes`, `anyPort`, `allowsAddress`, `ca`) instead of
      `CimdTestMode` and eight `#testMode` checks; the relay uses `PUBLIC_HTTPS`, the
      loopback policy is `testUrls()` in `test/oauth-helpers.ts`; `validateDocument` takes
      `urls` instead of `test`
- [x] `issueAccessToken` out of `tokens.ts` into `src/test-token.ts`, imported only by
      `testing.ts` (`tokenFor`) and the tests; `build.test.ts` checks it is in
      `testing.js` and not in `main.js` or `index.js`; `GrantInput` is the full grant
      `issueTokenPair` needs
- [x] `PairingCodes`' `maxAttempts` and the fetcher's `maxBytes` removed (never passed)
- [x] Kept: `createTestRelay` and its remaining hooks (code lifetimes, caps, clocks,
      pairing methods). It is the test-only seam: not exported, refused outside
      development, logged when on

## 4. The "Already connected" page (RQ 16, RS list)

- [x] `#usedRequests`, `#usedPage`, `#rememberUsed`, `#sweepUsed`, `#usedRequest`,
      `UsedRequest`, `MAX_USED_REQUESTS` and `IssuedCode.requestId` gone
- [x] A second submit of a paired request's form gets "This connection request has
      expired or was already used." (400); test: before and after the code exchange, and
      the first code still works
- [x] Docs: none described the page (only the CHANGELOG of relay 0.8.0)

## 5. The 0.4 secret key migration (CC list, DEC-083 amended)

- [x] `SecretStore` takes one key; `#oldKey`, `#claimKey`, `#claim` gone
- [x] Test: a secret under `tab-mcp:secret:<relay origin>` is not read, not marked
      `#moved`, and the page gets a new address
- [x] Client README: who pairs again
- [x] Core: 6216 to 6143 B gzipped (`build.test.ts`)

## 6. Records

- [x] DEC-178 (owner): the table's rows done, kept, deferred and not decided;
      `TAB_MCP_CLIENT_ID_HOSTS` stays unset on the hosted relay
- [x] DEC-083: amended
- [x] The review's Outcome section, CHANGELOG (relay and client `### Unreleased`),
      `kb/log.md`

## Outcome

Lines (from `git diff --numstat` against `main`, after the review fixes): relay source
296 added, 420 removed (net −124; 38 of the added lines are `src/test-token.ts`, which
only `testing.js` and the tests load); client source 4 added, 44 removed (net −40); tests
79 added, 91 removed (net −12). Client core 6216 B to 6143 B gzipped.

Review of the PR: claude 3 findings (all low: the token record built twice, the browser
id read before the expired check, a blank line in an import block), all fixed; glm 0.
