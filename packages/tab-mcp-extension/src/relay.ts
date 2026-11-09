/**
 * Relay addresses: the default, and which ones the library accepts. The
 * one the user chose is kept by the worker (`worker/settings.ts`).
 */

/** The hosted relay, which allows this extension's development build. */
export const DEFAULT_RELAY = "https://tab-mcp.ractive.ch";

/** Hosts the library accepts over plain http: and ws:. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why `value` is no relay address the library accepts, or `undefined`. */
export function relayProblem(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "Not an address.";
	}
	if (url.protocol === "https:" || url.protocol === "wss:") return undefined;
	if (url.protocol !== "http:" && url.protocol !== "ws:")
		return "Use an https: (or wss:) address.";
	return LOOPBACK.has(url.hostname)
		? undefined
		: "Plain http: works only for localhost; use https: for other hosts.";
}
