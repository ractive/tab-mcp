#!/usr/bin/env bun
/**
 * `bun run example`: a local relay in development mode (memory store, only
 * this page's origin allowed) and the calculator page. With
 * `TAB_MCP_RELAY=http://localhost:8080` it starts no relay and the page uses
 * that one instead (e.g. `docker run ractive/tab-mcp`). Never the hosted
 * relay (DEC-032).
 *
 * Environment: PORT (page, 3000), RELAY_PORT (relay, 8080), TAB_MCP_RELAY.
 */

import { createRelay, type Relay } from "@ractive-ch/tab-mcp";
import { serveExample } from "./server.ts";

function port(name: string, fallback: number): number {
	const value = process.env[name];
	if (value === undefined || value === "") return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0 || n > 65535) {
		throw new Error(`${name} must be a port number, not ${value}`);
	}
	return n;
}

const pagePort = port("PORT", 3000);
const external = process.env["TAB_MCP_RELAY"];

// The relay must know the page's origin before it starts, so the page
// listens first (on a free port if PORT=0) and learns the relay afterwards.
let relayUrl = external ?? "";
const page = serveExample({
	relay: () => relayUrl,
	port: pagePort,
	development: true,
});
const pageOrigins = [
	`http://localhost:${page.port}`,
	`http://127.0.0.1:${page.port}`,
];

let relay: Relay | undefined;
if (external === undefined || external === "") {
	const relayPort = port("RELAY_PORT", 8080);
	relay = createRelay({
		development: true,
		host: "127.0.0.1",
		port: relayPort,
		...(relayPort === 0 ? {} : { publicUrl: `http://localhost:${relayPort}` }),
		allowedOrigins: pageOrigins,
		store: "memory",
		logLevel: "warn",
	});
	relayUrl = relay.url;
}

process.stdout.write(`
Calculator: http://localhost:${page.port}/
Relay:      ${relayUrl}${relay === undefined ? " (external)" : " (local, development mode, memory store)"}

Open the page, click "Connect your AI app", and add the address it shows to
your AI app, e.g. Claude Code:

  claude mcp add --transport http calc <address>

then /mcp in Claude Code, Authenticate, and type the code from the page.
Ctrl-C stops everything.
`);

let stopping = false;
const stop = async () => {
	if (stopping) return;
	stopping = true;
	await relay?.stop();
	await page.stop(true);
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
