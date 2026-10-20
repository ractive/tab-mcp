# Self-hosting the relay

Run your own relay when your pages should not depend on someone else's server, or when
you do not want another operator to see your users' tool traffic. The relay reads every
tool argument and result in clear text, because TLS ends there (see the
[threat model](threat-model.md)).

The relay is one small process. It keeps tab sessions in memory and grants and token
hashes in a SQLite file. Run **one instance** per public address: a page's WebSocket
reaches one process, and an MCP request that lands on another process would find no
page.

## Docker

The image is published as `ractive/tab-mcp` (Docker Hub) and `ghcr.io/ractive/tab-mcp`,
for linux/amd64 and linux/arm64, with provenance and SBOM attestations. Every release
has the tag `X.Y.Z`. Stable releases also get `X.Y` and `latest`; pre-releases do not.
The current release is a pre-release, so name its version:

```sh
docker run -d --name tab-mcp --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v tab-mcp-data:/data \
  -e TAB_MCP_PUBLIC_URL=https://relay.example.com \
  -e TAB_MCP_ALLOWED_ORIGINS=https://app.example.com \
  ractive/tab-mcp:0.1.0-alpha.1
```

This publishes the port on the loopback interface only, for a reverse proxy on the same
machine (see below). The image:

- runs as the non-root user 65532;
- keeps grants and token hashes in `/data/tab-mcp.db` (`TAB_MCP_STORE=sqlite`,
  `TAB_MCP_SQLITE_PATH=/data/tab-mcp.db`). A named volume works as is; a host directory
  mounted at `/data` must be writable by uid 65532;
- listens on port 8080 (`TAB_MCP_PORT`) on all interfaces (`TAB_MCP_HOST=0.0.0.0`);
- sets `NODE_ENV=production`, so the public URL must be `https:`;
- has no shell and no `HEALTHCHECK`. Probe `GET /healthz` from your platform instead. It
  answers `200` with `{"status":"ok","version":"…","counters":{…}}`.

`docker run --rm ractive/tab-mcp:0.1.0-alpha.1 --version` prints the version. Every
setting is listed in [configuration](configuration.md).

With Docker Compose:

```yaml
services:
  tab-mcp:
    image: ractive/tab-mcp:0.1.0-alpha.1
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - tab-mcp-data:/data
    environment:
      TAB_MCP_PUBLIC_URL: https://relay.example.com
      TAB_MCP_ALLOWED_ORIGINS: https://app.example.com
      # For the nginx config below; x-forwarded-for behind Caddy (see "Client IP").
      TAB_MCP_TRUST_PROXY: x-real-ip
volumes:
  tab-mcp-data:
```

## Without Docker

The relay is also on npm as `@ractive-ch/tab-mcp`. It needs [Bun](https://bun.sh) 1.4.3
or newer; it does not run on Node.js.

```sh
bun add --global @ractive-ch/tab-mcp@alpha
TAB_MCP_PUBLIC_URL=https://relay.example.com \
  TAB_MCP_ALLOWED_ORIGINS=https://app.example.com tab-mcp
```

Install `@alpha`: npm's `latest` tag still points at the first alpha. Run it under a
supervisor (systemd or similar) that restarts it. It stops on SIGTERM or SIGINT and tells
each page (close code 4004).

## Behind a reverse proxy or CDN

The relay speaks plain HTTP. Put TLS in front of it with a reverse proxy or a CDN. The
proxy must pass four kinds of traffic:

| Path | Traffic |
|---|---|
| `/tab` | WebSocket from the page, open for hours |
| `/a/<id>/mcp` | MCP requests from AI apps: POST, often answered with a long event stream (SSE) |
| `/authorize`, `/authorize.css` | the pairing page in the user's browser, a form post with a cookie |
| `/.well-known/…`, `/token`, `/revoke`, `/healthz`, `/` | short JSON or HTML answers |

Check these points:

- **Public URL.** `TAB_MCP_PUBLIC_URL` must be exactly the origin users reach, such as
  `https://relay.example.com`. The relay builds addresses and its OAuth issuer from it,
  and refuses pairing form posts whose `Origin` differs.
- **WebSockets.** Forward the `Upgrade` and `Connection` headers on `/tab`. The relay
  pings each page every 25 seconds (`TAB_MCP_HEARTBEAT_S`), so an idle timeout of 60
  seconds or more on the proxy is enough. A session lasts up to 12 hours
  (`TAB_MCP_SESSION_LIFETIME_S`). Some CDNs need WebSockets switched on per zone.
- **No buffering of event streams.** The proxy must pass each event on at once. The relay
  sends `X-Accel-Buffering: no` (nginx honours it) and `Cache-Control: no-cache` on
  streams. Turn off response buffering, caching and request coalescing for `/a/` if your
  proxy or CDN does them anyway.
- **Long requests.** One MCP request may take up to 300 seconds
  (`TAB_MCP_REQUEST_TIMEOUT_S`). Allow at least that as the proxy's read timeout, or rely
  on the keep-alives: the relay writes `: keep-alive` every 20 seconds on a silent stream.
- **60-second first-byte limits.** Some CDNs (bunny.net, for example) answer 504 when the
  origin sends no response headers within 60 seconds. The relay starts the event stream
  itself when the page has not answered after `TAB_MCP_KEEPALIVE_S` (20 seconds), so
  headers always arrive well before that. Keep `TAB_MCP_KEEPALIVE_S` below your proxy's
  first-byte and idle limits.
- **Body size.** Allow request bodies up to `TAB_MCP_MAX_MESSAGE_BYTES` (1 MiB by
  default).
- **Client IP.** The relay limits sessions and requests per client IP. Behind a proxy
  every request comes from the proxy, so set `TAB_MCP_TRUST_PROXY` to the header your
  proxy sets: `x-real-ip`, or `x-forwarded-for` (the relay uses its last entry). Never set
  it when clients can reach the relay directly, because they could then pick their own IP.
- **Cookies.** The pairing page sets a first-party cookie for its form. Do not strip it.

### nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name relay.example.com;
    # ssl_certificate and ssl_certificate_key as usual

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 360s;
        proxy_send_timeout 360s;
        client_max_body_size 2m;
    }
}
```

With this, set `TAB_MCP_TRUST_PROXY=x-real-ip`.

### Caddy

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy gets the certificate, forwards WebSockets, and flushes event streams at once. It
sets `X-Forwarded-For`, so set `TAB_MCP_TRUST_PROXY=x-forwarded-for`.

## Restarts and upgrades

- A restart ends every tab session. Pages show that they are disconnected; the user
  clicks Connect again.
- Grants and token hashes are in the SQLite file, so AI apps stay paired across restarts
  and upgrades. While no page is connected, their requests get HTTP 503 "the page is not
  open".
- With `TAB_MCP_STORE=memory` a restart ends every connection; users pair again.
- To upgrade, pull the new tag and recreate the container with the same volume. Read the
  [changelog](../CHANGELOG.md) first.

## Before you go live

- `TAB_MCP_ALLOWED_ORIGINS` or `TAB_MCP_SITES` lists your pages, and nothing else. Read
  the [open-relay warning](configuration.md#open-relay) before you use `*`.
- `TAB_MCP_PUBLIC_URL` is `https:` and matches what users see.
- `/healthz` answers through the proxy, and a page can connect and pair.
- Tell your users what passes through the relay: every tool argument and result, which
  the relay does not log or store.
