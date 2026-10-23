#!/usr/bin/env bun
/**
 * `bun run example:react`: a local relay in development mode (memory store,
 * only this page's origin allowed) and the React todo page. With
 * `TAB_MCP_RELAY=http://localhost:8080` it starts no relay and the page uses
 * that one instead. Never the hosted relay (DEC-032).
 *
 * Environment: PORT (page, 3001), RELAY_PORT (relay, 8080), TAB_MCP_RELAY.
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

const external = process.env["TAB_MCP_RELAY"];
let relayUrl = external ?? "";
const page = serveExample({
	relay: () => relayUrl,
	port: port("PORT", 3001),
	development: true,
});

let relay: Relay | undefined;
if (external === undefined || external === "") {
	const relayPort = port("RELAY_PORT", 8080);
	relay = createRelay({
		development: true,
		host: "127.0.0.1",
		port: relayPort,
		...(relayPort === 0 ? {} : { publicUrl: `http://localhost:${relayPort}` }),
		allowedOrigins: [
			`http://localhost:${page.port}`,
			`http://127.0.0.1:${page.port}`,
		],
		store: "memory",
		logLevel: "warn",
	});
	relayUrl = relay.url;
}

process.stdout.write(`
Todo (React): http://localhost:${page.port}/
Relay:        ${relayUrl}${relay === undefined ? " (external)" : " (local, development mode, memory store)"}

Open the page, click "Connect your AI app", and add the address it shows to
your AI app, e.g. Claude Code:

  claude mcp add --transport http todo <address>

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
