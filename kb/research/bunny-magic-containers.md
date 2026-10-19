---
type: research
title: "bunny.net Magic Containers for the relay"
description: Notes for the deployment iteration — WebSockets, long requests, single instance, health checks, client IP and pricing on bunny.net Magic Containers.
tags:
  - deployment
  - bunny
timestamp: 2026-10-19T20:00:00+02:00
---

# bunny.net Magic Containers for the relay

Notes only; verified in the deployment iteration.

- **Endpoints:** a CDN endpoint (HTTP(S) through the edge, `mc-<hash>.bunny.run`, custom
  hostname possible) or an Anycast IP (raw TCP/UDP, no edge, TLS is ours).
- **WebSockets:** a pull-zone toggle (Pull Zone → General → WebSockets), 500 concurrent by
  default (up to 25 000 self-serve), billed per connection-minute. The Magic Containers docs
  do not say explicitly that a container's CDN endpoint passes WebSockets; inferred because
  the endpoint is a pull zone. **Verify first.** Fallback: Anycast endpoint with TLS in the
  relay.
- **Timeouts:** 10 s TCP connect, **60 s until the origin sends response headers** (else
  504, error code 106), about 2 minutes without data closes a stream; heartbeat at least
  every 30 s. Configurable via "Safehop" (field names not verified). Consequence: the relay
  must not hold an MCP response without sending headers for 60 s; SSE responses start at
  once and carry `: keep-alive` comments every 20 s.
- **SSE:** works; requires `Cache-Control: no-cache` (else cached up to a month). Turn off
  request coalescing for the zone.
- **Images:** linux/amd64 only. Public Docker Hub and ghcr.io images pull directly.
  GitHub action `BunnyWay/actions/container-update-image`.
- **Single instance:** one region, min = max = 1 replica. A deploy or restart closes all tab
  sockets (sessions end). SIGTERM then a 30 s grace period.
- **Health checks:** startup, readiness, liveness as HTTP GET or TCP.
- **Client IP:** `X-Real-IP` and `X-Forwarded-For` hold one address; client-supplied values
  are replaced by the edge. Trust them only behind the CDN endpoint.
- **Env:** dashboard env vars; no separate secret store documented. The relay needs no
  secret in version 1 (tokens are random and in memory).
- **Pricing:** $0.02 per CPU-hour used, $0.005 per GB-hour RAM, egress $0.01/GB, CDN
  traffic and WebSocket minutes extra.

# Citations

- [Magic Containers endpoints](https://bunny.net/docs/magic-containers/endpoints.md)
- [Magic Containers deploy](https://bunny.net/docs/magic-containers/deploy.md)
- [Magic Containers pricing](https://bunny.net/docs/magic-containers/pricing.md)
- [CDN WebSockets](https://bunny.net/docs/cdn/websockets.md)
- [CDN server-sent events](https://bunny.net/docs/cdn/server-sent-events.md)
- [CDN connectivity and timeouts](https://bunny.net/docs/cdn/connectivity.md)
- [Request headers to origin](https://bunny.net/docs/cdn/request-headers-to-origin.md)
