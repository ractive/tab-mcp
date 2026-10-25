# Self-hosting the relay

Run your own relay when your pages should not depend on someone else's server, or when
you do not want another operator to see your users' tool traffic. The relay reads every
tool argument and result in clear text, because TLS ends there (see the
[threat model](threat-model.md)).

This page covers running the relay in production: the Docker image, the settings that
matter, TLS in front of it, health checks, resource limits, backups, upgrades and what
to tell your users. Every setting is listed in [configuration](configuration.md).

- [One instance](#one-instance)
- [Docker](#docker)
- [Settings for production](#settings-for-production)
- [Without Docker](#without-docker)
- [Behind a reverse proxy or CDN](#behind-a-reverse-proxy-or-cdn)
- [Running several instances](#running-several-instances)
- [Health checks and monitoring](#health-checks-and-monitoring)
- [Resource limits](#resource-limits)
- [Operations](#operations): backups, upgrades, rollback, restarts
- [Lessons from a CDN deployment](#lessons-from-a-cdn-deployment)
- [Before you go live](#before-you-go-live)

## One instance

The relay is one small process. It keeps tab sessions in memory and grants and token
hashes in a SQLite file. Run **exactly one instance** per public address:

- A page's WebSocket reaches one process. An MCP request that a load balancer sends to
  another process finds no page there.
- The SQLite file is local to that process. Two processes on one file, or two copies of
  the file, would disagree about which tokens are valid.

So with the Docker image as it is there is no horizontal scaling: no autoscaling, no
second region, no deploy that runs the old and the new container side by side. One
instance serves 500 tab sessions by default (`TAB_MCP_MAX_SESSIONS`). For more, either
run a second relay with its own public URL, or run several instances behind one URL
with a load balancer that routes by the address id and a
[shared token store](token-store.md): see
[Running several instances](#running-several-instances). A shared store alone, without
that routing, does not help: tab sessions still live in one process.

## Docker

The image is published as `ractive/tab-mcp` (Docker Hub) and `ghcr.io/ractive/tab-mcp`,
for linux/amd64 and linux/arm64, with provenance and SBOM attestations. Every release
has the tag `X.Y.Z`. Stable releases also get `X.Y` and `latest`; pre-releases do not.
`X.Y` and `latest` move to the newest stable release, never back to an older one. Name the
full version, so the relay changes only when you choose:

```sh
docker run -d --name tab-mcp --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v tab-mcp-data:/data \
  -e TAB_MCP_PUBLIC_URL=https://relay.example.com \
  -e TAB_MCP_ALLOWED_ORIGINS=https://app.example.com \
  -e TAB_MCP_TRUST_PROXY=x-real-ip \
  ractive/tab-mcp:0.5.1
```

This publishes the port on the loopback interface only, for a reverse proxy on the same
machine (see [below](#behind-a-reverse-proxy-or-cdn)). The image:

- runs as the non-root user 65532;
- keeps grants and token hashes in `/data/tab-mcp.db` (`TAB_MCP_STORE=sqlite`,
  `TAB_MCP_SQLITE_PATH=/data/tab-mcp.db`);
- listens on port 8080 (`TAB_MCP_PORT`) on all interfaces (`TAB_MCP_HOST=0.0.0.0`);
- sets `NODE_ENV=production`, so the public URL must be `https:`;
- has no shell and no `HEALTHCHECK`. Probe `GET /healthz` from your platform instead
  (see [Health checks](#health-checks-and-monitoring)).

`docker run --rm ractive/tab-mcp:0.5.1 --version` prints the version, `--help` the
settings. A setting the relay cannot use stops it at start with
`tab-mcp: configuration error: …` and exit code 2; read the container log if it does not
come up.

With Docker Compose:

```yaml
services:
  tab-mcp:
    image: ractive/tab-mcp:0.5.1
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
    mem_limit: 512m
    cpus: 1
volumes:
  tab-mcp-data:
```

### The data volume

Mount a volume at `/data`. Without one the SQLite file lives in the container's
writable layer and is gone when the container is recreated, so every AI app has to pair
again after an upgrade.

- **A named volume** (`-v tab-mcp-data:/data`) works as is: Docker copies the owner of
  the image's `/data` (uid 65532) into a new, empty volume.
- **A host directory** mounted at `/data` must be writable by uid 65532:

  ```sh
  sudo install -d -o 65532 -g 65532 -m 0700 /srv/tab-mcp
  docker run … -v /srv/tab-mcp:/data ractive/tab-mcp:0.5.1
  ```

- **Platform volumes** (container hosts, Kubernetes) are sometimes mounted owned by
  root. If uid 65532 cannot write there, the relay cannot open its store and stops at
  start: the log shows `process.uncaught_exception` with `"error":"SQLiteError"`, the
  process exits with code 1, and the platform restarts it in a loop. On Kubernetes, `securityContext.fsGroup: 65532` fixes it. Where the
  platform has no such setting, ask whether its volumes allow writes by other users; as
  a last resort, `TAB_MCP_STORE=memory` runs the relay without the file (users pair
  again after every restart).
- The relay opens the file in SQLite's WAL mode, so it also writes `tab-mcp.db-wal` and
  `tab-mcp.db-shm` next to it. Keep the three together, on a local disk: SQLite's locking
  does not work reliably on network file systems (NFS, SMB).
- The file is small. It holds one row per token: each refresh adds an access and a
  refresh token, and a used refresh token stays for 24 hours, so that its reuse can be
  detected. An AI app in daily use refreshes about once an hour of use, so it has a few
  dozen rows of a few hundred bytes each; the relay allows a connection 20 refreshes,
  then 1 a minute. That is an estimate, not a measurement: on the order of 10 KiB per
  busy AI app, much less for occasional ones.
  The smallest volume your platform offers is plenty.
- It holds no usable tokens (only SHA-256 hashes), but it does list which AI apps are
  connected to which address. Keep it private (`0700` above).

## Settings for production

[Configuration](configuration.md) lists every setting with its default. These are the
ones to decide on for a public relay:

| Setting | What to set |
|---|---|
| `TAB_MCP_PUBLIC_URL` | Required. Exactly the `https:` origin users reach, such as `https://relay.example.com`, without a path. The relay builds MCP addresses and its OAuth issuer from it and refuses pairing form posts whose `Origin` differs. |
| `TAB_MCP_ALLOWED_ORIGINS` or `TAB_MCP_SITES` | The pages that may connect (see [Sites](#sites-and-allowed-origins)). Without either, every page is refused. |
| `TAB_MCP_TRUST_PROXY` | The header your proxy or CDN puts the client IP in, so per-IP limits count clients and not the proxy (see [Client IP](#client-ip)). |
| `TAB_MCP_STORE`, `TAB_MCP_SQLITE_PATH` | Keep the image's defaults (`sqlite`, `/data/tab-mcp.db`) with a volume on `/data`. |
| `TAB_MCP_KEEPALIVE_S` | 20 by default. Keep it below the shortest idle or first-byte limit of every proxy and CDN in front (see [Event streams](#event-streams-and-long-requests)). |
| `TAB_MCP_PAGE_WAIT_S` | 10 by default. How long an MCP request waits for its page to open or reconnect before the relay answers "the page is not open". It covers a phone that paused the tab in the background. Raise it if your users switch apps often, but no response headers are sent while the request waits, so `TAB_MCP_PAGE_WAIT_S` + `TAB_MCP_KEEPALIVE_S` must stay below the first-byte limit of every proxy and CDN in front (see [Event streams](#event-streams-and-long-requests)). `0` answers at once; at most 60. See [protocol](protocol.md#when-the-page-is-not-open). |
| `TAB_MCP_CLIENT_ID_HOSTS` | Empty admits any AI app that registers with a client id metadata document. List hosts (`claude.ai,chatgpt.com`) to admit only those apps. |
| `TAB_MCP_CORS` | `on` by default, for browser-based MCP clients. `off` if none needs the relay. |
| `TAB_MCP_MAX_SESSIONS`, `TAB_MCP_MAX_SESSIONS_PER_IP`, `TAB_MCP_MAX_CONCURRENT_REQUESTS`, `TAB_MCP_MAX_MESSAGE_BYTES` | Fit them to the memory you give the container (see [Resource limits](#resource-limits)). |
| `TAB_MCP_GRANT_LIFETIME_S` | 90 days by default: an AI app pairs again at the latest 90 days after pairing. Shorter limits a leaked token further at the cost of pairing more often. |
| `TAB_MCP_LOG_LEVEL` | `info`. Logs are JSON lines on stdout without request or response bodies; `debug` adds detail, still without bodies. |

Leave `NODE_ENV` as the image sets it (`production`). `development` allows `http:` and
is for local testing only.

### Sites and allowed origins

Every page that may connect must be listed by its origin (scheme, host and port, no
path). For pages with the default limits, list them in `TAB_MCP_ALLOWED_ORIGINS`:

```sh
TAB_MCP_ALLOWED_ORIGINS=https://app.example.com,https://www.example.com
```

A page that needs its own app name on the pairing page, or its own limits, goes into
`TAB_MCP_SITES` instead (an origin may be in only one of the two):

```sh
TAB_MCP_SITES='[{"origin":"https://app.example.com","name":"Notes","limits":{"maxConcurrentRequests":4}}]'
```

The `name` replaces the app name the page claims for itself, so users see a name you
chose. Details in [configuration](configuration.md#sites). Do not use
`TAB_MCP_ALLOWED_ORIGINS=*` on a public relay unless you mean to run an
[open relay](configuration.md#open-relay). A page from an origin that is not listed is
refused and logged as `tab.refused` with reason `origin`.

## Without Docker

The relay is also on npm as `@ractive-ch/tab-mcp`. It needs [Bun](https://bun.sh) 1.4.3
or newer; it does not run on Node.js.

```sh
bun add --global @ractive-ch/tab-mcp
TAB_MCP_PUBLIC_URL=https://relay.example.com \
  TAB_MCP_ALLOWED_ORIGINS=https://app.example.com tab-mcp
```

Without Docker, `TAB_MCP_SQLITE_PATH` defaults to `tab-mcp.db` in the working
directory; set an absolute path. Run it under a supervisor that restarts it. With
systemd:

```ini
[Unit]
Description=tab-mcp relay
After=network-online.target
Wants=network-online.target

[Service]
User=tab-mcp
StateDirectory=tab-mcp
StateDirectoryMode=0700
Environment=TAB_MCP_PUBLIC_URL=https://relay.example.com
Environment=TAB_MCP_ALLOWED_ORIGINS=https://app.example.com
Environment=TAB_MCP_TRUST_PROXY=x-real-ip
Environment=TAB_MCP_HOST=127.0.0.1
Environment=TAB_MCP_SQLITE_PATH=/var/lib/tab-mcp/tab-mcp.db
ExecStart=/usr/local/bin/tab-mcp
Restart=on-failure
MemoryMax=512M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Point `ExecStart` at wherever `bun add --global` put `tab-mcp` (`which tab-mcp`); with
`ProtectHome=true` that must not be under a home directory. The relay stops on SIGTERM
or SIGINT and tells each page (close code 4004).

## Behind a reverse proxy or CDN

The relay speaks plain HTTP. Put TLS in front of it with a reverse proxy or a CDN, and
make sure clients cannot reach the relay's port directly (bind it to `127.0.0.1`, a
private network, or the platform's internal endpoint only). The proxy must pass four
kinds of traffic:

| Path | Traffic |
|---|---|
| `/tab` | WebSocket from the page, open for hours |
| `/a/<id>/mcp` | MCP requests from AI apps: POST, often answered with a long event stream (SSE) |
| `/authorize`, `/authorize.css` | the pairing page in the user's browser, a form post with a cookie |
| `/.well-known/…`, `/token`, `/revoke`, `/healthz`, `/` | short JSON or HTML answers |

### Public URL and TLS

`TAB_MCP_PUBLIC_URL` must be exactly the origin users reach. Terminate TLS at the proxy
or CDN and redirect `http:` to `https:`. The relay builds its addresses and OAuth issuer
from `TAB_MCP_PUBLIC_URL`, not from the `Host` header, so a second hostname pointing at
the same relay does not work for pairing. The hop from the proxy to the relay can be
plain HTTP on a private network or the loopback interface. The relay sends no
`Strict-Transport-Security` header; let the proxy or CDN that terminates TLS add it
(for example `max-age=31536000`).

### WebSockets

Forward the `Upgrade` and `Connection` headers on `/tab`. Many CDNs need WebSockets
switched on per zone or site; without it the page cannot connect at all. The relay pings
each page every 25 seconds with a protocol message (`TAB_MCP_HEARTBEAT_S`), and Bun sends
WebSocket ping frames on a connection that has been quiet for a while (its idle timeout
is 120 seconds). The protocol pings alone keep data flowing every 25 seconds, so an idle
timeout of 60 seconds or more on the proxy is enough. A
session lasts up to 12 hours (`TAB_MCP_SESSION_LIFETIME_S`); a proxy may cut it earlier,
and the page then shows that it is disconnected.

### Event streams and long requests

- **No buffering.** The proxy must pass each event on at once. The relay sends
  `X-Accel-Buffering: no` (nginx honours it) and `Cache-Control: no-cache` on streams.
  Turn off response buffering, caching and request coalescing for `/a/` if your proxy or
  CDN does them anyway.
- **Long requests.** One MCP request may take up to 300 seconds
  (`TAB_MCP_REQUEST_TIMEOUT_S`). Allow at least that as the proxy's read timeout, or rely
  on the keep-alives: the relay writes `: keep-alive` every 20 seconds
  (`TAB_MCP_KEEPALIVE_S`) on a silent stream.
- **60-second first-byte limits.** Some CDNs (bunny.net, for example) answer 504 when the
  origin sends no response headers within 60 seconds. Once the page is connected, the
  relay starts the event stream itself if the page has not answered after
  `TAB_MCP_KEEPALIVE_S`. Before that, while the request waits for its page
  (`TAB_MCP_PAGE_WAIT_S`), no headers are sent. So the first byte can come as late as
  `TAB_MCP_PAGE_WAIT_S` + `TAB_MCP_KEEPALIVE_S` after the request (10 + 20 s with the
  defaults). Keep that sum below the first-byte limit: behind a 60-second limit with the
  default keep-alive, a page wait of at most about 35 seconds. A `tools/list` whose page
  closed during the request waits for the page once more, which can add a second wait.
- **Stream idle limits.** Some CDNs also close a stream that carries no data for about 30
  seconds. The keep-alives prevent that while `TAB_MCP_KEEPALIVE_S` is below the limit.
  Keep it below the shortest first-byte and idle limit of everything in front of the
  relay.
- **Body size.** Allow request bodies up to `TAB_MCP_MAX_MESSAGE_BYTES` (1 MiB by
  default).

### Client IP

The relay limits sessions and requests per client IP. Behind a proxy every request comes
from the proxy, so set `TAB_MCP_TRUST_PROXY` to the header your proxy sets: `x-real-ip`,
or `x-forwarded-for` (the relay uses its last entry, the one the nearest proxy added).

Only trust a header that a client cannot choose. That holds when the proxy overwrites
the header (nginx with the config below; many CDNs for `X-Real-IP`, check yours) and
**every** request goes through the proxy. If the relay also has a direct path, such as a
published port, a platform's direct or anycast endpoint, or a second hostname that skips
the CDN, a client can send its own header there and pick its IP. Remove that path, or
leave `TAB_MCP_TRUST_PROXY=none`.

### Caching, coalescing and cookies

- **Caching.** Nothing the relay serves is worth caching at the edge. Turn the cache off
  for the relay's hostname, and know that some CDNs still cache a response without cache
  headers for a long time (see [Lessons](#lessons-from-a-cdn-deployment)). The relay
  sends `no-store` on `/healthz`, `/authorize`, `/token` and `/revoke`, `no-cache` on
  event streams, and a cache time of one hour on `/`.
- **Request coalescing** (one origin request for identical requests in flight) must be
  off: two AI apps' MCP requests must never be merged.
- **Cookies.** The pairing page sets a first-party cookie for its form and checks it on
  the post. A proxy or CDN that strips cookies makes every pairing fail.

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

### A CDN in front

For a CDN (bunny.net, Cloudflare, Fastly, CloudFront and the like) in front of a
container platform or a server, check these settings for the relay's hostname:

- WebSockets on;
- caching off, and no "cache everything" rule that matches the relay;
- request coalescing off;
- cookies passed through, not stripped;
- response buffering off for event streams, if the CDN buffers;
- origin timeouts longer than `TAB_MCP_KEEPALIVE_S` with a margin, better as long as
  `TAB_MCP_REQUEST_TIMEOUT_S`;
- the client IP header and `TAB_MCP_TRUST_PROXY` as above, with no path around the CDN;
- the CDN's own access logs: they hold IP addresses and URLs (which contain the address
  id). Shorten or anonymise the IPs if the CDN offers it, and name these logs in your
  privacy notice.

## Running several instances

Several relay processes can serve one public URL if every request for one address
reaches the same process (DEC-098). The relay does not coordinate its instances: the
load balancer does the work, by a hash of the **address id**, the 52 characters of
`[a-z2-7]` in the MCP URL `https://<relay>/a/<id>/mcp`. Each instance then holds the
tab sessions, pairing requests and sign-ins of its share of the addresses. You need:

1. **The same configuration on every instance**, above all `TAB_MCP_PUBLIC_URL` (it is
   the OAuth issuer and part of every address), the sites and origins, and the OIDC
   settings.
2. **A shared token store.** Grants and token hashes must be the same for every
   instance: a refresh or revocation can reach any of them. The built-in SQLite file
   cannot be shared; embed the relay in your own Bun program and pass a
   [`TokenStore`](token-store.md) backed by Redis, PostgreSQL or similar. The Docker
   image has no such store, so it runs one instance per public URL.
3. **A load balancer that routes by the address id**, with a consistent hash, as below.

### Where the address id is

| Request | Address id | Needs the address's instance |
|---|---|---|
| `GET /tab?a=<id>` (WebSocket) | query `a` (client library 0.8 and later) | yes: the tab session lives there |
| `POST /a/<id>/mcp` | path | yes: forwarded to that session |
| `GET /authorize?…&resource=https://<relay>/a/<id>/mcp` | query `resource` (often percent-encoded) | yes: it checks the session and keeps the pending request |
| `POST /authorize?a=<id>` (the pairing form) | query `a` | yes: the pending request, its CSRF token, the pairing code or the code guesses |
| `GET /authorize/callback?state=<id>.<random>&code=…` (OIDC sites) | `state` up to the first `.` | yes: the sign-in in progress |
| `POST /token` with `grant_type=authorization_code` | form body: `code` up to the first `.` (also `resource`, if the client sends it) | yes: authorization codes are kept in memory, and the identity check reads the session |
| `POST /token` with `grant_type=refresh_token`, `POST /revoke` | none | no, with a shared store (see below) |
| `/.well-known/…`, `/healthz`, `/`, `/authorize.css` | none | no |

What lives in each process, and what routing by the id does to it:

| State | Kept | With routing by address id |
|---|---|---|
| Tab sessions, MCP requests waiting for a page, the last site seen per address | memory | works: `/tab` and `/a/<id>/mcp` reach the same instance |
| Pending `/authorize` requests, the pairing form's CSRF secret | memory | works: `GET` and `POST /authorize` reach the same instance |
| Pairing codes | the tab session | works |
| OIDC sign-ins in progress | memory | works: the callback's `state` carries the id |
| Authorization codes | memory, 60 s | works only if the load balancer reads the `/token` body (HAProxy below; nginx and Caddy cannot) |
| Used `jti` of tab assertions (replay cache) | memory | works: an assertion's audience is one address, so a replay can only be used at that address's instance |
| Rate limits per address (code guesses, sign-ins) | memory | works: one instance counts them |
| Rate limits per network (`/authorize` views and posts, `/token`, sessions per IP) and per grant (refreshes) | memory | per instance: with N instances a network or grant gets up to N times the allowance |
| CIMD documents, provider metadata, JWKS | memory cache | per instance; each fetches on its own |
| Grants, access and refresh token hashes | token store | needs the shared store |

Refreshes and revocations work on any instance with a shared store: the store's atomic
`markUsed` still catches a reused refresh token. But the page's list of connected apps
is updated only by the instance that holds the page: a revocation on another instance
(`/revoke`, a reused refresh token) shows in the page after it reconnects. The revoked
tokens stop working at once, since they are gone from the shared store.

### Rules for the load balancer

- **A consistent hash of the address id**, so that adding or removing an instance moves
  only a share of the addresses. Requests without an id can go to any instance.
- **No failover for routed requests.** If an address's instance is down, its requests
  should fail, not go to another instance: a tab that connects to a stand-in stays there
  when the original returns, and the AI app's requests then reach the original, where no
  page is. The library reconnects by itself (5 s, 10 s, … 60 s) and finds its instance
  once it is back. In nginx, `max_fails=0` and `proxy_next_upstream off`; in HAProxy, no
  `option redispatch`.
- **After changing the set of instances, restart every instance once**, one at a time.
  Open WebSockets stay where they are; a restart (close code 4004) makes their pages
  reconnect through the new hash.
- **Do not trust a client's routing header.** The examples below set it themselves and
  remove any that came in. The relay ignores it; the worst a forged one does is send
  that request to the wrong instance.
- **The address id is not secret** (it is in the MCP URL the user gives the AI app), but
  it is personal data in your access logs, like the paths `/a/<id>/mcp` already are.

### nginx

nginx cannot read a request body for routing, so authorization codes are exchanged only
if `/token` reaches the instance that issued the code; elsewhere the AI app gets
`invalid_grant` and the user has to pair again. Route `/token` through something that
reads the body's `code` (HAProxy as below, OpenResty, Envoy, an edge worker).
Everything else:

```nginx
# The address id of a request (DEC-098); empty when the request has none.
map $request_uri $tab_mcp_address {
    default "";
    "~^/tab\?(?:.*&)?a=(?<id>[a-z2-7]{52})(?:&|$)" $id;
    "~^/a/(?<id>[a-z2-7]{52})/mcp" $id;
    "~^/authorize\?(?:.*&)?a=(?<id>[a-z2-7]{52})(?:&|$)" $id;
    "~^/authorize/callback\?(?:.*&)?state=(?<id>[a-z2-7]{52})\." $id;
    "~^/authorize\?(?:.*&)?resource=[^&]*(?:/|%2[Ff])a(?:/|%2[Ff])(?<id>[a-z2-7]{52})(?:/|%2[Ff])mcp" $id;
}

upstream tab_mcp {
    hash $tab_mcp_address consistent;
    server 10.0.0.11:8080 max_fails=0;
    server 10.0.0.12:8080 max_fails=0;
}
```

In the `location /` of the [nginx example](#nginx), use `proxy_pass http://tab_mcp;`
and add `proxy_next_upstream off;`.

### Caddy

Caddy has no matcher for the body either (same limit for `/token` as nginx). It hashes a
request header, which it sets from the URL first:

```caddyfile
relay.example.com {
    @tab {
        path /tab
        query a=*
    }
    @form {
        path /authorize
        query a=*
    }
    @mcp path_regexp mcp ^/a/([a-z2-7]{52})/mcp$
    @authorize {
        path /authorize
        vars_regexp res {query.resource} /a/([a-z2-7]{52})/mcp$
    }
    @callback {
        path /authorize/callback
        vars_regexp st {query.state} ^([a-z2-7]{52})\.
    }
    route {
        request_header -X-Tab-Mcp-Address
        request_header @tab X-Tab-Mcp-Address {query.a}
        request_header @form X-Tab-Mcp-Address {query.a}
        request_header @mcp X-Tab-Mcp-Address {re.mcp.1}
        request_header @authorize X-Tab-Mcp-Address {re.res.1}
        request_header @callback X-Tab-Mcp-Address {re.st.1}
        reverse_proxy 10.0.0.11:8080 10.0.0.12:8080 {
            lb_policy header X-Tab-Mcp-Address
        }
    }
}
```

### HAProxy

HAProxy can read the `/token` body, so it routes every request in the table:

```haproxy
defaults
    mode http
    timeout connect 5s
    timeout http-request 10s
    timeout client 360s
    timeout server 360s
    # WebSockets (/tab) stay open for hours
    timeout tunnel 1h

frontend relay
    mode http
    bind :443 ssl crt /etc/haproxy/relay.pem
    option http-buffer-request
    http-request set-var(txn.address) url_param(a) if { path /tab } || { path /authorize }
    http-request set-var(txn.address) path,field(3,/) if { path_beg /a/ }
    http-request set-var(txn.address) url_param(state),field(1,.) if { path /authorize/callback }
    http-request set-var(txn.address) url_param(resource),url_dec,field(5,/) if { path /authorize } !{ var(txn.address) -m found }
    http-request set-var(txn.address) req.body_param(code),field(1,.) if { path /token }
    default_backend relays

backend relays
    mode http
    balance hash var(txn.address)
    hash-type consistent
    server r1 10.0.0.11:8080
    server r2 10.0.0.12:8080
```

`field(5,/)` takes the id from `https://<relay>/a/<id>/mcp`; if your public URL has a
path, count its segments too. `balance hash` needs HAProxy 2.6 or later.

### A CDN or cloud load balancer

Any that can hash on a value taken from the path or a query parameter can route
everything except the code exchange; an edge function or worker that reads the body can
route that too. Check the [CDN settings](#a-cdn-in-front) as well.

## Health checks and monitoring

`GET /healthz` answers `200` with

```json
{"status":"ok","version":"0.5.1","counters":{"claudeHeaderWorkaround":0}}
```

and `Cache-Control: no-store`. It needs no token and touches no page. It does read the
token store once (a key that never exists) and waits at most one second for it. If the
store fails or does not answer in time, it answers `503`:

```json
{"status":"unhealthy","reason":"store_unavailable","version":"0.5.1"}
```

`reason` is `store_unavailable` (the store threw) or `store_timeout` (no answer within
a second). The answer never carries the store's error; the log line `health.store` has
its name (`error`, or `timeout`). One probe runs at a time and its result is reused for
a second, so a flood of `/healthz` does not reach the store. After a timeout, while
that read still hangs, the next read is tried after 30 seconds (until then the answer
stays `store_timeout`). While the store fails, MCP
requests get 503 too, so AI apps keep their tokens and retry; tab sessions stay open.

A `503` means that the process runs but cannot check tokens. Restarting rarely fixes
that (a full disk, a database that is down) and ends every tab session, so use it for
readiness and alerts. If your platform only has a liveness probe, allow several minutes
of failures before it restarts the container.

Use it:

- as the platform's start and readiness probe (HTTP GET, expect 200). The image
  answered `/healthz` within half a second of `docker run` in our test. Since `/healthz`
  includes the token store, a liveness probe on it restarts the relay when the store is
  down, which ends every tab session and does not bring the store back: give a liveness
  probe a long window (for example every 30 seconds with 20 failures allowed, 10
  minutes), or probe liveness with a plain TCP check of the port;
- after a deploy, to check `version` against the release you meant to run. Ask the
  container directly or through a path without a cache, not only through the CDN (see
  [Lessons](#lessons-from-a-cdn-deployment));
- from an external uptime monitor through the public URL, so a broken certificate, DNS
  record or CDN setting shows up too.

`/healthz` says that the process answers and its token store responds. It does not say
that pages can connect or AI apps can pair: after changing the proxy or CDN, connect a
page and pair an AI app once.

The logs are JSON lines on stdout. Events worth an alert or a look:

| Event | Meaning |
|---|---|
| `store.error` | The token store failed while running (disk full, file removed). The line names the operation (`op`) and the error's name (`error`), never its message, which can carry token hashes or a connection string. MCP requests then get HTTP 503 with `Retry-After`, so AI apps keep their tokens and retry. A store that cannot be opened at all stops the relay at start instead (`process.uncaught_exception`, see [The data volume](#the-data-volume)). |
| `relay.no_origins` | No page is allowed; every page is refused. A missing or misspelled setting. |
| `relay.open_relay` | `TAB_MCP_ALLOWED_ORIGINS=*` is set. |
| `tab.refused` | A page was refused: `origin` (not listed), `max_sessions`, `max_sessions_per_ip`, `bad_address` (a malformed `?a=`), `address_mismatch` (the URL's address id is not the secret's). Many per-IP refusals from one address may mean `TAB_MCP_TRUST_PROXY` is not set and every page appears to come from the proxy. Many `max_sessions` refusals while few real pages are open may be the attack in [Known limit: session slots](#known-limit-session-slots). |
| `health.store` | The `/healthz` probe of the token store failed (`error` is the error's name, or `timeout`). |
| `oauth.refresh_reuse` | An old refresh token was used again, so the relay revoked that grant. A sign of a stolen token, or of a client that lost its newest token. |

## Resource limits

The relay is light. The image of October 2026 used about 8 MiB of memory at rest and after a few
hundred HTTP requests (`docker stats`, arm64; no page connected), and little CPU: it
forwards JSON and checks tokens. Each connected page adds a WebSocket and its buffers. What makes memory grow is traffic in flight:
each MCP request body and each answer from the page can be up to
`TAB_MCP_MAX_MESSAGE_BYTES` (1 MiB), for up to `TAB_MCP_MAX_CONCURRENT_REQUESTS` (8)
requests per tab session and `TAB_MCP_MAX_SESSIONS` (500) sessions. The theoretical
worst case of the defaults is therefore several GiB; ordinary traffic is far below it.

- As an estimate, not a measurement: 128 to 256 MiB of memory and one CPU should be
  plenty for a site with a few hundred users. Watch the real use and adjust.
- If you give it less, lower `TAB_MCP_MAX_SESSIONS`, `TAB_MCP_MAX_CONCURRENT_REQUESTS`
  or `TAB_MCP_MAX_MESSAGE_BYTES` so that their product fits.
- Set a memory limit on the container (`mem_limit`, `MemoryMax=`, a Kubernetes limit),
  so a flood ends in a restart of the relay and not of the host.
- Disk: small (see [The data volume](#the-data-volume)); the relay deletes expired
  tokens every 10 minutes.
- Against volumetric attacks, rely on the CDN or proxy in front; the relay's own limits
  protect it from single clients, not from a flood.

### Known limit: session slots

The relay admits a tab session for any client that sends an allowed `Origin` and a
well-formed secret. A browser cannot forge `Origin`, but any other program can. With the
defaults, `TAB_MCP_MAX_SESSIONS` (500) slots and `TAB_MCP_MAX_SESSIONS_PER_IP` (5) per
IPv4 address or IPv6 /64, a program on about 100 IPv6 /64s can hold every slot with idle
WebSockets, and real pages get `too_many_sessions` (HTTP 429, logged as `tab.refused`
`max_sessions`). It is a handful of quiet connections, not a flood, so a CDN does not see
it. The fix (a quota per site, or evicting the oldest session that never paired and has
no grants when the instance is full) is deferred (DEC-097). Until then:

- watch for `tab.refused` with `max_sessions` while your own pages are few;
- if it happens, block the networks at the proxy or CDN, or lower
  `TAB_MCP_MAX_SESSIONS_PER_IP` (which also limits real users behind one address);
- with [several instances](#running-several-instances), each instance has its own 500
  slots, which raises the cost of the attack but does not remove it.

## Operations

### Backups

The SQLite file holds the pairings. Losing it does no harm beyond that every AI app has
to pair again; it holds no page data and no usable tokens. Whether to back it up depends
on how much a mass re-pairing would bother your users.

The relay writes in WAL mode, so copying `tab-mcp.db` alone while the relay runs can give
an inconsistent or outdated copy. Either make a consistent copy with SQLite:

```sh
# The image has no shell or sqlite3; run it from another container on the same volume,
# while the relay runs.
docker run --rm -v tab-mcp-data:/data -v "$PWD":/backup alpine:3 \
  sh -c 'umask 077 && apk add --no-cache sqlite >/dev/null &&
         sqlite3 /data/tab-mcp.db ".backup /backup/tab-mcp-$(date +%F).db"'
```

This container runs as root, because it installs `sqlite3`. Run it while the relay
runs: the relay then holds `tab-mcp.db-wal` and `tab-mcp.db-shm`, and the backup only
reads them, so no file in `/data` ends up owned by root. `umask 077` makes the backup
file readable by its owner only. (`VACUUM INTO '/backup/…'` works too.) Or stop the relay, copy `tab-mcp.db` with its
`-wal` and `-shm` files, and start it again; that ends every tab session (see
[What a restart does](#what-a-restart-does)).

To restore, stop the relay, put the copy in place as `tab-mcp.db`, delete any old
`tab-mcp.db-wal` and `tab-mcp.db-shm`, make the file owned by uid 65532 and start the
relay. Grants revoked after the backup come back; tokens that expired meanwhile are
deleted at the next sweep. Keep backups as private as the file itself.

### Upgrading

1. Read the [changelog](../CHANGELOG.md) for every version between yours and the new one:
   new, renamed or removed `TAB_MCP_*` settings, changed defaults, store changes. Until
   1.0, a minor version can change settings and the protocol.
2. Back up the SQLite file if you keep backups.
3. Change the settings the changelog asks for. The relay stops at start on a value it
   cannot use, but it does not notice a variable it no longer knows; remove those.
4. Pull the new tag and recreate the container with the same volume:

   ```sh
   VERSION=…   # the new release, in full
   docker pull "ractive/tab-mcp:$VERSION"
   docker stop tab-mcp && docker rm tab-mcp
   docker run -d --name tab-mcp … "ractive/tab-mcp:$VERSION"
   # Compose: change the tag, then
   docker compose up -d
   ```

5. Check that `/healthz` reports the new version, from the container and through the
   public URL. Then connect a page and make one tool call.

Stop the old container before the new one starts: two relays on one SQLite file at the
same time are not supported (see [One instance](#one-instance)).

Relay and browser library (`@ractive-ch/tab-mcp-client`) are released on their own. The
changelog says when a release of one needs a new version of the other.

### Rollback

Run the previous image tag with the same volume. The store's schema has a version
number, and the changelog says when a release migrates it. A file migrated by a newer
release may be unreadable for an older one. Then restore the backup made before the
upgrade (pairings made since are lost), roll back with an empty volume and accept that
users pair again, or roll forward with a fix.

### What a restart does

- Every tab session ends. Pages show that they are disconnected; the user clicks Connect
  again and gets the same address (its secret is in the page's `localStorage`). A tool
  call in progress ends with an error.
- Grants and token hashes are in the SQLite file, so AI apps stay paired across restarts
  and upgrades. While no page is connected, their requests wait up to
  `TAB_MCP_PAGE_WAIT_S` and then get "the page is not open" (HTTP 200 with a JSON-RPC
  error or a tool error, see [protocol](protocol.md#when-the-page-is-not-open)). Once the
  user clicks Connect, the same AI app works again without signing in.
- Pairing codes and sign-ins in progress are kept in memory and are lost; the user starts
  the sign-in again.
- Rate-limit counters start from zero.
- With `TAB_MCP_STORE=memory`, or without a volume, a restart ends every connection;
  users pair again.

On SIGTERM the relay closes each page with code 4004 and exits. Give it a few seconds
(Docker's default of 10 is enough) before it is killed.

### Ending every connection

To cut off every connected AI app at once, stop the relay, delete the SQLite file with
its `-wal` and `-shm` files (or the volume), and start it again. Every user pairs again.
A single user ends their own connections with Disconnect or "New address" in the page.

## Lessons from a CDN deployment

From running the relay as a container on a hosting platform behind its CDN (bunny.net
Magic Containers with a pull zone):

- **A CDN can cache responses that have no cache headers, for a long time, even with
  caching "off".** One CDN kept `/healthz` and `/` for 30 days, so after a deploy
  `/healthz` through the CDN still reported the old version. The relay sends
  `Cache-Control: no-store` on `/healthz` and a cache time of one hour on `/`. Check a
  deploy against the container itself (the platform's internal endpoint, `docker exec`,
  a port-forward), not only through the CDN, and purge the CDN cache if it kept
  anything.
- **WebSocket support must be on** for the hostname. Some platforms turn it on for their
  own endpoint; pin it in your configuration so a dashboard change shows up.
- **Cookies must pass.** A CDN option that strips cookies "for caching" breaks pairing,
  because the pairing page's form checks a first-party cookie.
- **Request coalescing off,** and caching off. Neither helps the relay, and coalescing
  can merge requests that must stay separate.
- **CDN streaming limits.** Expect a first-byte limit (60 seconds) and a stream idle
  limit (about 30 seconds) at the edge. The default `TAB_MCP_KEEPALIVE_S` of 20 stays
  below both; set it explicitly so a change of the default cannot surprise you.
- **The client IP header is only safe without a direct path.** Behind a CDN that
  overwrites `X-Real-IP`, `TAB_MCP_TRUST_PROXY=x-real-ip` is right only if the container
  has no endpoint that skips the CDN.
- **One instance, one region.** Set the platform's scaling to exactly one instance in
  one region. A second instance gets its own empty volume and its own sessions.
- **Platform volumes may be root-owned** and may have no backups. If the relay
  cannot write there, it stops at start and restarts in a loop; check the first start's
  log (see [The data volume](#the-data-volume)), and make your
  own backups if pairings matter.
- **A restart ends page connections; pairings survive.** With the SQLite file on a
  volume, an AI app that paired before a restart worked again in the same chat after the
  page reconnected, without signing in.
- **Guard the volume.** On some platforms deleting the app deletes its volume, and with
  it every pairing. Use the platform's or your provisioning tool's deletion guard.
- **New settings before the new image.** When a release needs a new environment
  variable, change the environment first, then roll out the image. Tools that rewrite
  the whole app definition can otherwise roll the image back.

## Before you go live

- `TAB_MCP_ALLOWED_ORIGINS` or `TAB_MCP_SITES` lists your pages, and nothing else. Read
  the [open-relay warning](configuration.md#open-relay) before you use `*`.
- `TAB_MCP_PUBLIC_URL` is `https:` and matches what users see; `http:` redirects to it.
- `TAB_MCP_CLIENT_ID_HOSTS` lists the hosts of the AI apps you expect, for example
  `claude.ai` for Claude and Claude Code. Left empty, any HTTPS host counts as an AI app,
  and the pairing page shows a host like `claude-connect.pages.dev` as plainly as
  `claude.ai`. To find another app's host, connect it once and read `client` in the
  relay's `oauth.paired` log line, or `host` in `oauth.client_refused` once the list is
  set.
- The relay's port is reachable only through the proxy or CDN, and
  `TAB_MCP_TRUST_PROXY` matches the proxy's header.
- `/data` is a volume that survives recreating the container, writable by uid 65532.
- One instance, with a memory limit.
- `/healthz` answers through the proxy with the version you deployed, and is monitored.
- A page can connect and pair an AI app, a tool call works, and a page stays connected
  for more than 5 minutes.
- After a restart, the AI app is still paired.
- Your users get a privacy notice: every tool argument and result passes through the
  relay, which does not log or store them. The
  [privacy notice template](privacy-template.md) is a starting point.
- The pages you list keep their address secret safe: whoever copies it out of
  `localStorage` (script on the page's origin, an extension, a shared computer) can take
  over the address, and the AI apps paired with it then talk to them
  ([threat model](threat-model.md), A4). Sites with user accounts pair by
  [identity binding](configuration.md#identity-binding), so a copied secret gets nothing.
  Each page runs on its own origin (not a shared one such as `*.github.io`), without
  third-party scripts, and calls `newAddress()` when its user logs out on a shared
  device.
- The page origin on the pairing page is what the page's browser reported. A program can
  claim any origin, including one you list, so the list keeps other websites off your
  relay but does not prove to a user which page they pair with.
