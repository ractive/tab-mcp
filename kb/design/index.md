# Index

<!-- okf:index:begin -->

## design

* [Identity binding](identity-binding.md) - The relay connects an AI app to a tab only if both are signed in as the same person at the same OpenID Connect provider; a pairing method next to the code (DEC-075 to DEC-079).
* [Security model and threat model](threat-model.md) - Assets, attackers, what the relay sees, the mitigations and safe defaults, and the risks that remain.
* [tab-mcp architecture](architecture.md) - Components, endpoints, data flow and the full sequence from a page connecting, through pairing with a code, to an AI app calling its tools and the user disconnecting.
* [Tab↔relay protocol, version 1](protocol.md) - The versioned WebSocket protocol between the browser library and the relay — message types (session, pairing, grants, tunnel), JSON shapes, errors, heartbeat and limits.

<!-- okf:index:end -->
