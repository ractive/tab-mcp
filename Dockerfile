# syntax=docker/dockerfile:1
#
# The tab-mcp relay (DEC-026, DEC-069). Multi-arch (amd64, arm64): the build
# stage runs on the build machine's own platform, because its output is
# platform-independent JavaScript; the runtime stage only copies files, so no
# emulation is needed for the other architecture.
#
#   docker build -t tab-mcp .
#   docker run --rm -p 8080:8080 -v tab-mcp-data:/data \
#     -e TAB_MCP_PUBLIC_URL=https://relay.example.com \
#     -e TAB_MCP_ALLOWED_ORIGINS=https://app.example.com tab-mcp
#
# Health: GET /healthz (200 with JSON). There is no HEALTHCHECK here: the
# distroless image has no shell or curl; probe /healthz from the platform.
#
# The relay runs as the non-root user 65532 and keeps grants and token hashes
# in SQLite at /data/tab-mcp.db. A named volume inherits /data's owner; a
# host directory mounted there must be writable by uid 65532.

FROM --platform=$BUILDPLATFORM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS build
WORKDIR /src
COPY LICENSE AI_NOTICE ./
COPY packages/tab-mcp/package.json packages/tab-mcp/
COPY packages/tab-mcp/scripts packages/tab-mcp/scripts
COPY packages/tab-mcp/src packages/tab-mcp/src
# The relay has no runtime dependencies: bundling needs no `bun install`.
RUN bun packages/tab-mcp/scripts/build.ts --no-declarations \
 && mkdir -p /out/app /out/data \
 && cp packages/tab-mcp/dist/main.js packages/tab-mcp/dist/main.js.map LICENSE AI_NOTICE /out/app/

FROM oven/bun:1.4.3-distroless@sha256:1aaa515018b0b37d95dbdebd55d1b7f37ad258a6289ba63e4bc3b9c9e3038697
LABEL org.opencontainers.image.title="tab-mcp" \
      org.opencontainers.image.description="Relay that lets AI apps call the MCP tools of a web page open in a browser tab" \
      org.opencontainers.image.source="https://github.com/ractive/tab-mcp" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY --from=build /out/app/ /app/
COPY --from=build --chown=65532:65532 /out/data/ /data/
ENV NODE_ENV=production \
    TAB_MCP_HOST=0.0.0.0 \
    TAB_MCP_PORT=8080 \
    TAB_MCP_STORE=sqlite \
    TAB_MCP_SQLITE_PATH=/data/tab-mcp.db
USER 65532:65532
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/bun", "/app/main.js"]
