---
type: iteration
title: "Iteration 12: authorization server hardening"
status: completed
description: "Fixes from the 2026-10-24 security audit of the relay's OAuth, CIMD, OIDC and token store code: an owner locked out of /authorize, CIMD rate limits per registrable domain, OIDC flows per request, refresh-token retention, look-alike client names, small doc items."
timestamp: 2026-10-24T23:00:00+02:00
tags: [iteration, security, relay, oauth]
---
# Iteration 12: authorization server hardening

From the security audit of 2026-10-24 (OAuth, JWT, identity, store). The audit found no
critical or high issue; these are availability, storage growth and UI-spoofing gaps. The
files are `packages/tab-mcp/src/oauth/` (`server.ts`, `cimd.ts`, `oidc.ts`), `tokens.ts`
and `store/`; iteration 11 touches `relay.ts`, `exchange.ts` and `session.ts`, so the two
can run in parallel. Finding 4 changes what the store keeps; check the store conformance
suite and `docs/token-store.md` with it.

## Findings and fixes

1. **Low-medium: anyone who knows an address can keep its owner off `/authorize`**
   (`oauth/server.ts:551-560`, `MAX_PENDING_PER_ADDRESS = 20` at line 48). Every
   `GET /authorize` naming an address with a connected tab opens a pending request, not
   only while its pairing dialog is open. With the address (attacker A1), a public CIMD
   and two IPs, twenty GETs every ten minutes give the owner a permanent 429 "Too many
   connection requests". Fix: open a pending request only when `session.pairingOpen` (the
   code method needs it anyway; `OidcPairing.check` already requires it); when the cap is
   reached, evict that address's oldest pending request instead of refusing; also count
   per address and IP prefix.
2. **Low: the CIMD per-host limit is bypassed with wildcard subdomains**
   (`oauth/cimd.ts:151` keys on `url.host`; `:157` is the global limiter, 30 burst at
   1/s; `:165-167` evicts the cache first-in-first-out at 1000 entries). With
   `*.evil.example` every client id is a new host, so two IPs keep the global bucket
   empty and every uncached legitimate client gets "The relay is busy"; 1000 documents on
   1000 subdomains also evict claude.ai's cached entry. Fix: key the per-host limit on
   the registrable domain (public suffix list, or at least the last two labels); evict
   least recently used instead of oldest; never evict hosts in `TAB_MCP_CLIENT_ID_HOSTS`.
   Also take the per-host token only after the global limiter admits the fetch (ordering
   nit at `:151-157`).
3. **Low: OIDC flows pile up per Connect click** (`oauth/oidc.ts:268-286`, `MAX_FLOWS`
   10 000 at line 30, `FLOW_TTL_MS` at line 29). Every `POST /authorize` with
   `action=connect` on an oidc site adds a flow under a fresh `state` and never drops the
   earlier flows of the same request. The `admit` limiter is not used for oidc (the
   parameter is `_admit`); only `#attemptsPerIp` (per /64) applies, and the CSRF token is
   not IP-bound, so a signed-in user of the site with an IPv6 /48 fills all 10 000 and
   blocks identity pairing relay-wide for ten minutes at a time. Fix: one flow per pending
   request (a new Connect replaces the old flow); cap flows per IP; use `admit`.
4. **Low: every used refresh token is kept for 30 days** (`oauth/server.ts:1240`
   `markUsed`; `tokens.ts:114-127`; `store/sqlite.ts:159-166`, `211-218`). Reuse detection
   keeps the used refresh row until its own expiry, so one grant refreshing at the
   `/token` rate adds about 86 000 rows a day per IP, about 1 GB of SQLite over the
   window (proof: 1000 refreshes left 1001 rows after a sweep two hours later). Fix: when a
   refresh token is used, cut its expiry to a reuse-detection window (for example 24 h),
   or let `deleteExpired` drop used refresh rows past that window; consider a cap on
   refreshes per grant per hour. Store contract and conformance suite to match.
5. **Low: look-alike client names get past the check** (`oauth/cimd.ts:379` only refuses
   a web address in parentheses). "Claude [claude.ai]", "Claude · claude.ai" or
   "Claude from claude.ai" pass, so the heading reads "Connect Claude · claude.ai from
   evil.example". The verified host is still shown (DEC-065), so this weakens the defence
   rather than bypassing it. Fix: refuse any name containing a domain-shaped token, or
   put the verified host first ("From evil.example: Claude").
6. **Low (architecture F6): "verified host" means any HTTPS host.** A CIMD on
   `claude-connect.pages.dev` looks as verified as `claude.ai`; `TAB_MCP_CLIENT_ID_HOSTS`
   is empty by default and missing from "Before you go live" in `docs/self-hosting.md`.
   Fix: add it to that checklist with the hosts of the known AI apps; decide whether the
   pairing page should mark hosts outside the list.

## Documentation and small items

- `docs/self-hosting.md`: the relay sends no `Strict-Transport-Security`; the TLS
  terminator should. One line.
- `oauth/server.ts:461-464` logs `hostOf(clientId)`; a `client_id` that is not a URL puts
  up to 100 attacker-chosen characters into the log (JSON-escaped, no injection). Log a
  fixed marker instead.

## Tasks

- [x] 1: pending requests only while pairing is open; evict oldest at the cap; test that the owner is not locked out
- [x] 2: CIMD limit per registrable domain, LRU cache, listed hosts never evicted, limiter order
- [x] 3: one OIDC flow per pending request; per-IP cap; `admit` used
- [x] 4: used refresh tokens kept only for the reuse window; store contract, conformance suite and `docs/token-store.md`
- [x] 5: domain-shaped names refused (or host first); tests
- [x] 6: `TAB_MCP_CLIENT_ID_HOSTS` in "Before you go live"; unlisted hosts are not marked (owner, DEC-100)
- [x] HSTS line in `docs/self-hosting.md`; no raw `client_id` in logs
- [x] Changelog, relay release, deploy (relay 0.4.0, deployed 2026-10-25)

## Progress

Decisions DEC-088 (finding 1), DEC-089 (2), DEC-090 (3), DEC-091 (4) and DEC-092 (5).

- 1: one network holds at most 5 requests per address; at 20 the oldest request of the
  network holding the most is evicted, rather than the address's oldest (DEC-088).
- 2: the last two labels, not the Public Suffix List (DEC-089). "Listed hosts never
  evicted" needs no code while the list is an allow-list: no other host is cached.
- 3: the per-IP cap comes from binding flows to pending requests, which are capped per
  network (DEC-090).
- 4: also a cap of 20 refreshes per grant, then 1 a minute (DEC-091).
- 5: names with a foreign domain are refused; the host stays where it was (DEC-092).
- 6: the documentation half is done (`docs/self-hosting.md`, "Before you go live", and
  the threat model). Open for the owner: whether the pairing page marks hosts outside
  `TAB_MCP_CLIENT_ID_HOSTS`.
- Changelog: entries under "Unreleased"; the relay release and deploy are still to do.

# Citations

- [OAuth Client ID Metadata Document (draft)](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)
- [Public Suffix List](https://publicsuffix.org/)
