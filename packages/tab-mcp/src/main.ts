#!/usr/bin/env bun
import { ConfigError, configFromEnv } from "./config.ts";
import { createLogger, installCrashLogging } from "./log.ts";
import { createRelay, type Relay, VERSION } from "./relay.ts";

const HELP = `tab-mcp ${VERSION}: relay between AI apps (MCP clients) and tools offered by a web page in a browser tab.

Usage: tab-mcp [--help] [--version]

Configuration is read from environment variables:
  TAB_MCP_PUBLIC_URL          external origin, e.g. https://relay.example.com (required;
                              https unless NODE_ENV=development)
  TAB_MCP_PORT                listen port (8080)
  TAB_MCP_HOST                listen address (0.0.0.0)
  TAB_MCP_ALLOWED_ORIGINS     comma-separated page origins allowed to connect; empty = none;
                              * = any website (open relay, logs a warning)
  TAB_MCP_TRUST_PROXY         none | x-real-ip | x-forwarded-for (none)
  TAB_MCP_CORS                on | off: CORS without credentials on the MCP endpoint (on)
  TAB_MCP_STORE               sqlite | memory (sqlite)
  TAB_MCP_SQLITE_PATH         SQLite file for grants and token hashes (tab-mcp.db)
  TAB_MCP_MAX_SESSIONS        tab sessions in total (500)
  TAB_MCP_MAX_SESSIONS_PER_IP tab sessions per client IP (5)
  TAB_MCP_MAX_CONCURRENT_REQUESTS  MCP requests in flight per tab (8)
  TAB_MCP_REQUEST_TIMEOUT_S   per MCP request (300)
  TAB_MCP_KEEPALIVE_S         SSE keep-alive interval (20)
  TAB_MCP_IDLE_TIMEOUT_S      close a tab session without MCP requests (3600)
  TAB_MCP_SESSION_LIFETIME_S  absolute tab session lifetime (43200)
  TAB_MCP_HEARTBEAT_S         protocol ping interval (25)
  TAB_MCP_MAX_MESSAGE_BYTES   request body and WebSocket message limit (1048576)
  TAB_MCP_ACCESS_TOKEN_TTL_S  access token lifetime (3600)
  TAB_MCP_REFRESH_TOKEN_TTL_S refresh token lifetime (2592000)
  TAB_MCP_LOG_LEVEL           error | warn | info | debug (info); bodies are never logged

Stops on SIGTERM or SIGINT: tabs get "bye" and close code 4004.
`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	process.stdout.write(HELP);
	process.exit(0);
}
if (args.includes("--version")) {
	process.stdout.write(`${VERSION}\n`);
	process.exit(0);
}
if (args.length > 0) {
	process.stderr.write(`tab-mcp: unknown argument ${args[0]}\n\n${HELP}`);
	process.exit(2);
}

let relay: Relay;
try {
	const config = configFromEnv(process.env);
	const logger = createLogger(config.logLevel ?? "info");
	installCrashLogging(logger);
	relay = createRelay({ ...config, logger });
} catch (error) {
	if (error instanceof ConfigError) {
		process.stderr.write(`tab-mcp: configuration error: ${error.message}\n`);
		process.exit(2);
	}
	throw error;
}

const shutdown = () => {
	relay.stop().then(
		() => process.exit(0),
		() => process.exit(1),
	);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
