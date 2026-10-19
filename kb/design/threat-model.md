---
type: design
title: "Security model and threat model"
description: Assets, attackers, what the relay sees, the mitigations and safe defaults, and the risks that remain.
tags:
  - security
  - design
timestamp: 2026-10-19T20:00:00+02:00
---

# Security model and threat model

Becomes `SECURITY.md` (reporting, supported versions) and `docs/threat-model.md` in
[iteration 5](/iterations/iteration-5-packaging-release.md).

## Assets

1. **The page's capabilities**: whatever the tools can read or do in the user's tab
   (calculator state; in saturnus, the emulated calculator's memory and files).
2. **Tool arguments and results** in transit through the relay.
3. **Access tokens**: anyone holding one can call the tab's tools until the session ends.
4. **The user's attention**: consent prompts and confirmations must not be spammed or
   confusing.
5. **The relay's availability and its operator's bill.**

## Trust boundaries and what each party sees

| Party | Sees | Trusted for |
|---|---|---|
| Page (and its author) | its own tools, consent decisions | defining tools honestly; it already runs in the user's browser |
| Relay operator | **every tool argument and result in clear text** (TLS ends at the relay), client ids, IP addresses, timing | not logging or altering traffic |
| AI app | the tools it is allowed to call, their results | following the user's intent (it is driven by a model) |
| Model provider behind the AI app | the same as the AI app | — |
| Network | nothing (TLS everywhere; `wss:` and `https:` only outside development) | — |

The relay cannot be made blind: the AI app speaks HTTPS to the relay and the MCP payload
must be readable to be forwarded. Users who do not trust a public relay self-host it.

## Attackers and mitigations

### A1: Someone who learns the address (shared screenshot, chat log, shoulder-surfing)

- The address alone grants nothing: every MCP request needs a token, and a token needs the
  user's Allow click in the tab.
- **Code comparison**: the tab and the `/authorize` page show the same 4-digit code. An
  attacker who starts an authorization (even with a genuine client such as their own
  claude.ai account) gets a different code on their own page; the victim sees a request
  in the tab that matches nothing on their screen.
- If two authorizations are pending at the same time, the tab warns explicitly.
- Pending authorizations per address are capped (3) and expire after 5 minutes;
  `/authorize` is rate-limited per IP and per address.
- "New address" in the page replaces the `addressKey`; the old address becomes unknown.
- Residual: a user who clicks Allow without comparing the codes. See the open question on
  typing the code instead.

### A2: A malicious or impersonating OAuth client

- Client registration only through Client ID Metadata Documents: the `client_id` is an HTTPS
  URL the relay fetches; the document's `client_id` must equal the URL and `redirect_uri`
  must be listed. Exact match, except loopback redirects where the port is ignored
  (RFC 8252).
- The consent UI shows the declared name **and** the verified client id host and redirect
  host; a client calling itself "Claude" from `evil.example` shows `evil.example`.
- PKCE S256 required; codes are single-use, 60 s, bound to client id, redirect URI and
  resource. `iss` in the response (RFC 9207) defeats mix-up.
- Optional operator allow-list of client id hosts (`TAB_MCP_CLIENT_ID_HOSTS`).

### A3: SSRF through CIMD fetches

The relay fetches a URL chosen by an unauthenticated party. Guards: `https:` only, default
port only, no credentials in the URL, resolve the host first and refuse private, loopback,
link-local, CGNAT and multicast ranges (IPv4 and IPv6), no redirects, 5 s timeout, 64 KiB
limit, `application/json` only, response cached per `Cache-Control` (max 24 h, min 5 min),
per-host fetch rate limit. Residual: DNS rebinding between the check and the connect (Bun
cannot pin the resolved IP for `fetch`); acceptable because the response is only parsed as
JSON and never returned to the requester except as a pass/fail.

### A4: Token theft and replay

- Tokens are 256-bit random, opaque, stored only as SHA-256 hashes, accepted only in the
  `Authorization` header and only for their own address (audience check against
  `resource`).
- They die with the session: tab closed, Disconnect, revoke, idle timeout (60 min),
  lifetime (12 h), relay restart. No refresh tokens.
- The relay never forwards the `Authorization` header to the tab.

### A5: A hostile page or another site using someone's relay

- Tab WebSockets only from allowed origins (default: none). This stops other websites in a
  browser; a non-browser client can forge `Origin`, so it is abuse control, not a security
  boundary for users.
- Limits: sessions per IP (5) and in total (500), message and body size (1 MiB), concurrent
  requests per session (8), request timeout (120 s), idle timeout, session lifetime.

### A6: The AI app (or a prompt injection) misuses the tools

- Read-only and harmless tools run directly; tools marked `consequentialHint` ask in the
  page before each run, showing the client and a summary of the arguments.
- Annotations reach the AI app as MCP hints (`readOnlyHint`, `destructiveHint`) so it can
  ask too, but the page's confirmation does not depend on the AI app.
- `untrustedContentHint` tools mark their results so AI apps can treat them as untrusted
  data (mapping in the decision log).
- The user sees connected apps in the page and can revoke them or disconnect at any time.

### A7: Cross-site attacks on the relay's pages

- `/authorize` sends `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; form-action 'self' <redirect origin>`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and binds the waiting page to
  the browser with a `__Host-` cookie (`Secure`, `HttpOnly`, `SameSite=Lax`).
- All values shown on the page (client name, page title) are HTML-escaped and length-capped.
- The MCP endpoint ignores cookies; no CORS headers are sent for it (AI apps are not
  browsers; browser-based MCP clients are out of scope for version 1).

### A8: Denial of service

In-memory token buckets per IP for `/tab`, `/authorize`, `/token` and per grant for the
MCP endpoint; WebSocket backpressure checked on every send (a dropped send fails the
request instead of hanging); bounded maps with expiry sweeps. A single-instance relay can
still be flooded; the CDN in front absorbs volumetric attacks.

### A9: Logs and privacy

Logs are JSON lines with event, hashed address id, session id, MCP method, HTTP status,
duration, client id host and coarse error codes. Never bodies, tool names, arguments,
results, tokens, codes or `addressKey`s. Client IPs appear only in rate-limit warnings,
truncated (/24, /48). The hosted instance's privacy notice states this.

## Safe defaults

- No tab origins allowed until configured.
- `TAB_MCP_PUBLIC_URL` must be `https:` unless `NODE_ENV=development`.
- No unauthenticated MCP mode exists, not even as a flag.
- `development: false`, body limits set, `server.timeout` handled explicitly.
- Sessions start only from a click (`connect()` refuses to run without transient user
  activation, `navigator.userActivation.isActive`, where the browser supports it).

## Residual risks

- The relay operator can read and alter all traffic. Mitigation: open source, self-hosting,
  no logs of bodies; not solvable with MCP over HTTPS.
- Users who approve without comparing codes.
- The AI app's model can be steered by content (prompt injection) into calling tools the
  user did not intend; page-side confirmation covers consequential tools only.
- Client-declared names are self-asserted; only hosts are verified.
- DNS rebinding in CIMD fetches (see A3).
- The known Claude header bug tolerance (decision log) slightly widens what the relay
  accepts; it is limited to one exact version pair.

# Citations

- [MCP authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [CIMD draft (draft-ietf-oauth-client-id-metadata-document)](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)
- [RFC 8252 §7.3 loopback redirects](https://www.rfc-editor.org/rfc/rfc8252#section-7.3)
- [RFC 9207 issuer identification](https://www.rfc-editor.org/rfc/rfc9207)
- [RFC 9700 OAuth security best current practice](https://www.rfc-editor.org/rfc/rfc9700)
- [WebMCP draft (annotations)](https://webmachinelearning.github.io/webmcp/)
- [MCP 2026-07-28 research](/research/mcp-2026-07-28-spec.md)
