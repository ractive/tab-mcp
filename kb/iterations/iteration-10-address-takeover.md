---
type: iteration
title: "Iteration 10: a stolen address secret"
status: planned
description: What someone who copies a page's address secret can do, said plainly in the docs; a page that is taken over says so and offers a new address; and whether a backend-signed address claim is worth building.
timestamp: 2026-10-24T20:30:00+02:00
tags: [iteration, security]
---
# Iteration 10: a stolen address secret

From the codebase review of 2026-10-24 (architecture finding F1, related F2, F3 and F4;
F4 itself is fixed in iteration 11). The other findings of that review are planned in
iterations 11 (relay), 12 (authorization server), 13 (browser library) and 14 (CI and
settings).
Owner, 2026-10-24: do the three steps below in their own iteration; plan first,
implement later.

## Problem

The page keeps its address secret in `localStorage` (DEC-083). Whoever has the secret
can send `hello` with it from anywhere, with a forged `Origin`. The newest session for
an address wins (`packages/tab-mcp/src/session.ts`, `claimAddress`): the real tab gets
`bye` `replaced` (4005), and by design the library does not reconnect after that. Every
AI app already paired with the address keeps its tokens and from then on talks to the
impostor:

- the impostor sees every argument the AI app sends, which can carry data from the chat;
- it writes the tool descriptions and results, so it can put instructions into the
  user's AI session, which may have other tools (mail, files, code). This is the real
  damage; fake results for the page's own tools are minor next to it;
- it keeps working after the XSS is fixed, the page is closed or the script is removed,
  until the page gets a new address.

It cannot pair a new AI app without the code, cannot read any token, and gets nothing
on a page that pairs by identity binding: a bound session needs a fresh signed assertion
from the site's backend.

Getting the secret needs script on the page's origin (XSS, a compromised third-party
script or dependency, another page on the same origin such as other pages of the same
site or a shared `*.github.io` origin) or access to the device or browser profile
(malware, an extension with page access, a shared computer). A network attacker cannot
get it (TLS), and the relay operator already sees it.

`docs/threat-model.md` (asset 4, A4, "Risks that remain") says a secret holder "can take
over the address, but not the tokens of apps already connected". True, but it leaves out
that the paired apps then talk to the holder.

## Design

### 1. Docs

- `docs/threat-model.md`: rewrite asset 4, A4 and "Risks that remain" with the scenario
  above (who can get the secret, what the holder gets, what it does not get, how long it
  lasts). Bring the version line up to date (it still says 0.1.0).
- Same file and `SECURITY.md`: the page origin on `/authorize` is what the page's
  browser reported; a program can claim any origin (architecture F2). Say this where
  users are told to check the origin, instead of presenting it as verified.
- `packages/tab-mcp-client/README.md` and the developer skill: for a page with user
  accounts, use identity binding; run the page on its own origin; keep third-party
  scripts off it; call `newAddress()` when the page's user logs out on a shared device.
- `docs/self-hosting.md`, "Before you go live": the same advice for operators.
- Threat model A1/A4 and the client README (architecture F3): on a code-paired page,
  grants follow the browser profile, not the person. On a shared profile, or a web app
  with accounts that pairs by code, the next user of the page gets the AI apps the
  previous one paired. Advise identity binding, or `newAddress()` on logout.
- README (architecture review, main idea): say when tab-mcp is the wrong tool. If a
  page's state lives on its server, an MCP server on that backend is the better answer;
  tab-mcp is for state that lives only in the browser, and for acting as the signed-in
  user in their open tab.

### 2. Library

- When the page is replaced (`replaced`), the default UI says that another tab or
  program took over the page's address and offers "New address", which calls
  `newAddress()` and so cuts off every app paired with the old address. A page with its
  own UI gets the same through the existing `replaced` event; the README says what to
  show.
- Open: whether a second tab of the same page (the usual, harmless cause of
  `replaced`) can be told apart from an impostor. The library could use a
  `BroadcastChannel` per relay and page: a tab that is replaced and hears from a sibling
  tab of the same page that it took over the address knows the cause is harmless and
  shows "Opened in another tab" instead. Both texts are new: the default UI has no
  `replaced` handling today. Decide during implementation.
- Optional, decide in review: `newAddress({ onLogout: true })` or a documented pattern
  for pages that log users out, rather than new API.

### 3. A backend-signed address claim (decide before building)

The review's suggestion was a "proof of page": the site's backend signs a short JWT for
the address, the relay accepts a claim of the address only with it, and `/authorize`
shows the origin as verified only then. Checked on 2026-10-24, this works only in a
narrower form than first suggested:

- **Without a signed-in user it proves nothing.** The backend cannot tell its own page
  from a program calling the same endpoint (CORS binds browsers only), so an endpoint
  that signs for anyone signs for the impostor too, and for an attacker's own address
  shown as "verified ractive.ch". It would not fix F2 or F4 either.
- **With a signed-in user it can work:** the backend keeps the address secret (or derives
  it per user, for example HMAC of the user id with a server key), the page never stores
  it, and each `hello` carries a short, single-use claim the backend signs for that
  user's address. Script on the page can then get claims only while it runs and the user
  is signed in; copying `localStorage` gets nothing. Grants made under such a claim must
  record it (like `TokenRecord.subject` today), so a session without a claim cannot use
  them, whatever origin it reports.
- **But identity binding already gives most of this:** a bound session needs a fresh
  assertion. Step 3 would add only "the AI app pairs with the code, the address is still
  tied to the site's backend", for sites with accounts that do not want the AI app's
  user to sign in.

Before implementing step 3, decide whether that case is worth a second signing flow next
to identity binding. If not, record the decision (DEC) and close step 3 with the docs of
step 1 naming identity binding as the protection.

## Tasks

- [ ] Docs: threat model asset 4, A4 and remaining risks rewritten; version line updated
- [ ] Docs: the origin on `/authorize` described as reported, not verified (`SECURITY.md`, threat model)
- [ ] Docs: advice for page authors (client README, skill) and operators (`docs/self-hosting.md`)
- [ ] Docs: grants follow the browser profile on code-paired pages (F3); README says when a backend MCP server fits better
- [ ] Library: the default UI explains `replaced` and offers "New address"; test with a second session claiming the address
- [ ] Library: decide on telling a sibling tab from an impostor (`BroadcastChannel`); if yes, the "Opened in another tab" text for that case; otherwise record why not
- [ ] Step 3: owner decision on the backend-signed address claim, recorded as a DEC; design and tasks added here if it goes ahead
- [ ] Changelog, release of the client if it changed

# Citations

- [Threat model](https://github.com/ractive/tab-mcp/blob/main/docs/threat-model.md): asset 4, A4 and "Risks that remain"
- [Decision log](../decision-log.md): DEC-083 (the address secret per relay and page), DEC-036 (any Origin on the MCP endpoint)
