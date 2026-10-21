# Privacy notice template

A starting point for the privacy notice an operator of a tab-mcp relay gives its users.
It describes what the relay software does with its default settings. Copy the part
below the line, replace every `{{placeholder}}`, delete what does not apply, and add what
your own setup adds: your hosting provider, your CDN or proxy and its logs, your log
retention, your legal basis and your contact. This template is not legal advice; check
it against the law that applies to you (for example the GDPR or the Swiss FADP).

Check these points against your setup before you publish:

- Settings that change the numbers below: `TAB_MCP_ACCESS_TOKEN_TTL_S` (1 hour),
  `TAB_MCP_REFRESH_TOKEN_TTL_S` (30 days), `TAB_MCP_GRANT_LIFETIME_S` (90 days),
  `TAB_MCP_STORE` (`memory` keeps nothing across restarts), `TAB_MCP_LOG_LEVEL`. See
  [configuration](configuration.md).
- Where the relay's stdout goes, and how long you keep it.
- Whether a CDN or proxy in front keeps access logs (IP addresses, URLs, user agents),
  and for how long. The relay cannot see or limit those logs.
- Backups of the SQLite file, if you make them, and how long you keep them.
- If you embed the relay with your own token store, what that store keeps.

[Self-hosting](self-hosting.md) explains the setup, and the
[threat model](threat-model.md) explains who can see what.

---

# {{Relay name}}: privacy

{{Operator name}} runs a tab-mcp relay at `{{https://relay.example.com}}`. It connects an
AI app (such as Claude or ChatGPT) to a web page open in your browser, such as
{{the pages that use the relay}}. Nothing passes through the relay until you click
"Connect your AI app" in the page and pair an AI app with the code the page shows.

## What passes through

While a page is connected, the AI app's requests go to the relay over HTTPS, and the
relay forwards them to the page over a WebSocket. The page's answers go back the same
way. This traffic contains the tool names, the arguments the AI app sends, and the
results the page returns, which can include whatever the page shows or computes for you.

The traffic is encrypted on the way, but the relay decrypts it to forward it, so the
relay could read it. The relay forwards it without storing or logging it. The AI app
and its provider receive the results; their own privacy terms apply to them.

When an AI app signs in, the relay fetches the app's public client metadata document
from the app's own web address, to show you its name and verified host.

## What is stored

For each AI app you pair, the relay keeps:

- a random connection id, and the id of the page's address (derived from a random
  secret the page keeps in your browser);
- the AI app's client id (a web address such as `https://claude.ai/…`) and the name it
  declares;
- the permissions granted and the times of pairing, issue and expiry;
- hashes of its access and refresh tokens, never the tokens themselves.

The relay does not store your name, e-mail address, IP address, or the content of any
tool call. It has no user accounts.

How long:

- Access tokens end after {{1 hour}}, refresh tokens after {{30 days}}. Each refresh
  issues a new refresh token. Expired tokens are deleted within minutes.
- A connection ends when you click Disconnect or "New address" in the page, or at the
  latest {{90 days}} after pairing. Its tokens are then deleted. A note that the
  connection was ended (its id and the time) is kept for up to {{90 days}}, so that an
  old token cannot bring it back.
- While a page is connected, the relay holds the connection and the current pairing code
  (valid for 2 minutes) in memory only.
- For its rate limits, the relay counts requests per IP address (IPv6 addresses
  shortened to their first 64 bits) in memory only. A counter is dropped once its limit
  has recovered (within about half an hour), the count of open page connections when
  they close, and all of them at a restart at the latest; they are never written to
  disk.
- {{Backups: none. / Backups of the stored data are kept for N days.}}

## Logs

The relay writes event logs: what happened (a page connected, a request was answered,
a sign-in succeeded), a shortened address id, a session id, the kind of MCP request
(such as `tools/call`, not the tool's name), the HTTP status, the duration and the host
of the AI app's client id. Logs never contain requests, answers, tool names,
arguments, results, tokens, codes or secrets. IP addresses appear only when a rate limit
is hit, and then shortened (the last part of an IPv4 address, the last 80 bits of an
IPv6 address removed). Logs are kept for {{N days}}.

{{If a CDN or proxy is in front: Our CDN, {{provider}}, keeps access logs with
{{shortened}} IP addresses, the requested addresses and the time, for {{N days}}.}}

## Where it runs

The relay runs at {{hosting provider}} in {{country or region}}.
{{CDN: Traffic reaches it through {{CDN provider}}.}}

## Your choices

- Disconnect an AI app at any time in the page; "New address" ends every connection of
  that page.
- Closing the page stops all traffic; the AI app can call nothing until you connect the
  page again.
- Connect only AI apps you started yourself, and only pages you trust: the page decides
  what its tools do.

## Questions

{{Contact for privacy questions: an e-mail address, a form or an issue tracker.}}

{{Date of this notice.}}
