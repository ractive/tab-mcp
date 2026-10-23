---
type: research
title: "Bun 1.4.3, TypeScript 7 and publishing for tab-mcp"
description: Bun.serve WebSockets and long-held requests, crypto and CSRF helpers, declaration emit with TypeScript 7, browser bundles, npm trusted publishing and Docker.
tags:
  - bun
  - typescript
  - release
  - spike
timestamp: 2026-10-20T12:00:00+02:00
---

# Bun 1.4.3, TypeScript 7 and publishing for tab-mcp

Spiked on Bun 1.4.3 (macOS arm64) on 2026-10-19; spikes outside the repo, deleted.

## Findings that shape the design

1. **Bun's HTTP `idleTimeout` (default 10 s, max 255) kills a pending request and a
   streaming response too**; writing does not reset it (spike: SSE writing every 0.5 s cut
   after ~4 s with `idleTimeout: 3`). Fix: `server.timeout(req, 0)` per MCP request and our
   own timers.
   **But it does not fire while a handler waits for an unfinished request body**
   (checked 2026-10-20 with `arrayBuffer()` and a stream reader: the socket stayed open;
   without a body read, `idleTimeout: 1` closed it after about 4 s). Answering early with
   `Connection: close` makes Bun close the socket (DEC-048).
2. **`ws.send()` returns 0 and drops the message** once `backpressureLimit` is exceeded
   (spike: 176 of 200 16-KiB sends dropped at a 64-KiB limit). The relay must check the
   return value and fail the HTTP request on 0; `-1` means queued, `drain` follows.
   **Tests that hold a streamed response must keep reading it:** Bun's `fetch` closes the
   connection when an unread `Response` is garbage-collected (shown with `Bun.gc(true)`:
   5 of 5 unreferenced listen responses closed, 0 of 5 referenced ones), and the relay
   then rightly reports `client_closed`. Under CPU load the periodic GC lands inside short
   test windows; this made the listen-stream test flaky in CI (2026-10-20).
3. **`bun publish` cannot do provenance** (`--provenance` is documented as an error), and
   **npm trusted publishing needs the package to exist** first. Plan: owner publishes the
   first version by hand; CI then does `bun pm pack` (rewrites `workspace:*`) and
   `npm publish <tgz>` via OIDC.
4. **`.d.ts` emit works with TypeScript 7.0.2's `tsc`** (there is no `tsgo` binary):
   `declaration`, `emitDeclarationOnly`, `isolatedDeclarations`, `outDir: dist`. `bun build`
   has no declaration option and `bun check` never writes files.
5. A `.d.ts` keeps imports of workspace packages: the client's public types must be
   self-contained (no private shared package in its type surface).

## WebSockets

- `websocket: { data: {} as WsData, … }` types `ws.data` and the `data` passed to
  `server.upgrade(req, { data, headers })` (the old `Bun.serve<T>` generic is gone).
- Check `Origin` in `fetch` before `upgrade`; return 403 to refuse.
- Handlers `open`, `message`, `close(ws, code, reason)`, `drain`, `ping`, `pong`.
- Defaults: `maxPayloadLength` 16 MB, `backpressureLimit` 16 MB,
  `closeOnBackpressureLimit` false, `idleTimeout` 120 s (0–960), `sendPings` true,
  `perMessageDeflate` false. `ws.getBufferedAmount()`.
- `server.requestIP(req)` gives the socket address; there is no trust-proxy setting.

## Long-held requests and streams

- A `fetch` handler may return a `Promise<Response>` resolved later, subject to the idle
  timer. `req.signal` aborts when the client goes away or the idle timer fires.
- SSE: `new Response(new ReadableStream({ start, cancel }), { headers: { "content-type":
  "text/event-stream" } })`; `cancel()` runs on disconnect.
- `maxRequestBodySize` defaults to 128 MB — set it to the body limit.

## Routes, security helpers, crypto

- `routes` with per-method handlers, `:param` and `*`; unlisted methods fall through to
  `fetch`. Set `development: false` in production.
- HTML imports serve static, bundled pages; the `/authorize` page needs per-request data, so
  render it from a template string with escaping instead.
- No rate limiter built in: in-memory token buckets keyed by IP, session or grant.
- `Bun.CSRF.generate(secret, { expiresIn, sessionId })` / `Bun.CSRF.verify(token, { secret,
  maxAge, sessionId })`; without a secret Bun uses a per-process random secret (fine for a
  single in-memory relay).
- PKCE S256: `Bun.CryptoHasher.hash("sha256", verifier, "base64url")` matches the RFC 7636
  test vector. Random tokens: `crypto.getRandomValues` +
  `Uint8Array.prototype.toBase64({ alphabet: "base64url", omitPadding: true })`.
- Constant-time compare: `timingSafeEqual` from `node:crypto` (throws on unequal lengths:
  compare digests).

## Browser bundles

- npm build: `bun build ./src/index.ts --target=browser --format=esm --sourcemap=linked
  --packages=external --outdir=dist`.
- CDN build (self-contained): `--minify --outfile=./dist/tab-mcp-client.min.js`. No
  `--global-name` for IIFE; ship ESM for `<script type="module">`.
- A page builds with `bun build ./src/index.html --outdir=…` or is served by an HTML-import
  route (the e2e test page, `test/e2e/server.ts`, does the latter).

## npm trusted publishing

- npm ≥ 11.5.1, Node ≥ 22.14, `permissions: id-token: write`, GitHub-hosted runner,
  `repository.url` matching exactly, workflow file name registered on npmjs.com.
- `npm trust github <pkg> --file release.yml --repo ractive/tab-mcp --allow-publish`.
- Provenance is automatic for a public repo and package. `npm publish <tgz> --provenance`
  dry-run worked locally; OIDC with a tarball argument is to be confirmed in CI.

## Docker

- `oven/bun:1.4.3-alpine`, `-slim`, `-distroless` exist for amd64 and arm64.
- `docker/build-push-action` v7.4.0 (`platforms`, `provenance`, `sbom`, cache `type=gha`),
  `setup-buildx-action` v4.4.1, `setup-qemu-action` v4.4.0, `login-action` v4.6.0,
  `metadata-action` v6.2.0. One build can push to Docker Hub and ghcr.io.

# Citations

- [Bun HTTP server (idle timer, server.timeout)](https://bun.com/docs/runtime/http/server)
- [Bun WebSockets](https://bun.com/docs/runtime/http/websockets)
- [Bun CSRF](https://bun.com/docs/runtime/csrf)
- [bun check](https://bun.com/docs/runtime/check)
- [bun publish](https://bun.com/docs/pm/cli/publish)
- [bun pm pack](https://bun.com/docs/pm/cli/pm)
- [bun build](https://bun.com/docs/bundler)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers)
- [TypeScript isolatedDeclarations](https://www.typescriptlang.org/tsconfig/#isolatedDeclarations)
- [docker/build-push-action](https://github.com/docker/build-push-action)
- [oven/bun images](https://hub.docker.com/r/oven/bun/tags)
