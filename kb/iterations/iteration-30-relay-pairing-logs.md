---
type: iteration
title: "Iteration 30: what the relay's pairing page and logs show"
status: completed
description: >-
  Iteration B of the review of 2026-11-13: the pairing page shows only a serialised page
  origin and a cleaned app name, one text for a closed page and a closed dialog, a
  renewed visit cookie and a form-action Chrome accepts for [::1]; OIDC pairing needs the
  dialog open at the callback; guesses count per /56; the logs carry error codes, store
  failures everywhere, token refusals, limit warnings and session figures; configuration
  errors name the variable; the guide says what a restart and a revocation on another
  instance do. Relay and docs; DEC-130 to DEC-132.
timestamp: 2026-11-13T22:00:00+01:00
tags: [iteration, relay, security, review, observability]
---

# Iteration 30: what the relay's pairing page and logs show

Iteration B of [the review of 2026-11-13](../research/review-2026-11-13.md). Branch
`iteration/30-relay-pairing-logs`, on top of iteration 29 (A). Tests in
`packages/tab-mcp/test/pairing-logs.test.ts`, one block per finding; RS 11 and RS 12 in
`identity.test.ts`.

## Tasks

### RS 6: free text as the page origin on an open relay (DEC-130)

- [x] An open relay keeps only a serialised origin or an extension origin of at most
  255 characters (`shownOrigin`); anything else is no origin
- [x] Protocol, configuration (open relay) and threat model A7 updated

### RS 7: the page's app name keeps bidi and invisible characters (DEC-130)

- [x] `pageAppName`: `displayName`, dropped when empty or naming a foreign domain;
  `tab.session` logs `appNameDropped`
- [x] `unicode-bidi: isolate` on `strong` and `.origin`
- [x] Protocol and threat model A11 updated

### RS 9: three /64s lock the owner out of typing the code (DEC-130)

- [x] The per-address-and-network guess share counts an IPv6 /56
- [x] Threat model A1 says "three networks" and A8 the /56

### RS 10: `/authorize` tells whether the page is open (DEC-130)

- [x] One "Open the page first" text for a closed page and a closed dialog
- [x] Threat model A1 names the remaining signal (an open dialog shows the pairing page)

### RS 11: OIDC pairing checks the dialog at Connect only (DEC-130)

- [x] The callback fails with `inactive` when the dialog is closed by then
- [x] Threat model A12 updated

### RS 12: `identity_refused` passes internal error text (DEC-130)

- [x] The JWKS failure has a fixed message; the inner error is its `cause`, logged by
  name (`identity.refused`) and in full in `oidc.sign_in_failed`

### RS 17: the visit cookie is not renewed (DEC-130)

- [x] Every pairing page and the redirect to the provider renew the cookie (same id,
  fresh `Max-Age`)

### RS 18: `form-action` with an IPv6 literal (DEC-130)

- [x] Checked in Chrome 151: the literal is dropped and the redirect blocked; `http:`
  works
- [x] A loopback redirect to `[::1]` gets `http:` in `form-action`

### RQ 4: start-up failures and store errors as a bare class name (DEC-131)

- [x] `errorFields`: `error` plus `errorCode` for codes like `SQLITE_FULL`, used by every
  error line
- [x] `tab-mcp` prints the message of a start failure, logs `relay.start_failed`, exits 1

### RQ 5: store failures under three events, the page told `bad_message` (DEC-131)

- [x] `guardStore` wraps the relay's store; failures are `StoreFailure`
- [x] `/token`, `/revoke`: `store.error` with `op`; tab revocations: `store.error` and the
  error code `store_unavailable`
- [x] `message` renamed `error` in `oauth.error` and `tab.handler_error`

### RQ 6: refusals at `/token` leave no line; no session figure (DEC-131)

- [x] `oauth.token_refused`
- [x] `oauth.rate_limited`, once per network and episode (`RateLimiter.onLimited`)
- [x] `relay.stats` from the sweep

### RQ 7: a revocation on another instance does not end requests in flight

- [x] The self-hosting guide states it (requests in flight, listen streams up to the
  session lifetime, the page's list)
- Not done: checking the grant in the store on each keep-alive of a listen stream; a
  store read per stream every 20 seconds, for several instances only (DEC-132)

### RQ 8: the guide contradicts itself on what a restart does

- [x] "What a restart does": pages reconnect by themselves after 5 to 60 seconds; only
  `reconnect: false` waits for a click

### RQ 11: enums unchecked, messages name config keys (DEC-132)

- [x] `store`, `trustProxy`, `logLevel`, `cors` checked in `resolveConfig`
- [x] `ConfigError.key`, `describeConfigError`: the command names the variable
- [x] `relay.unknown_setting` for `TAB_MCP_*` variables the relay does not read

### RQ 12: 413 for a large request while the page is away (DEC-132)

- [x] `lastSeen` keeps the site's `maxMessageBytes` as the fallback limit

### RQ 13: provider discovery has no grace period (DEC-132)

- [x] Last good metadata for another hour after a failed refresh; 30 s between attempts

## Outcome

- Simplification items of the review that overlap: none taken. The "Already connected"
  page (RQ 16) is not in this iteration; `private_key_jwt` and the CIMD defences are
  owner decisions.
- Deploy notes: no new environment variables and no changed defaults. Log changes that
  dashboards or alerts may depend on: a store failure at `/token` and `/revoke` is now
  `store.error` (was `oauth.error`); `oauth.error` and `tab.handler_error` have `error`
  instead of `message`; error lines may have `errorCode`; a failed start is
  `relay.start_failed` (was `process.uncaught_exception`). New: `oauth.token_refused`
  (info), `oauth.rate_limited` (warn), `relay.stats` (info, every 10 minutes),
  `relay.unknown_setting` (warn at start). The new tab error code `store_unavailable`
  reaches pages as a relay error event in client libraries that do not know it.
