/**
 * The relay address the user chose, kept in the extension's storage.
 */

/** The hosted relay, which allows this extension's development build. */
export const DEFAULT_RELAY = "https://tab-mcp.ractive.ch";

const KEY = "relay";
const ON_KEY = "aiOn";

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

export async function loadRelay(): Promise<string> {
	const stored = (await chrome.storage.local.get(KEY))[KEY];
	return typeof stored === "string" && relayProblem(stored) === undefined
		? stored
		: DEFAULT_RELAY;
}

export async function saveRelay(relay: string): Promise<void> {
	await chrome.storage.local.set({ [KEY]: relay });
}

/** Whether the user left AI access on (connect again when the panel opens). */
export async function loadAiOn(): Promise<boolean> {
	return (await chrome.storage.local.get(ON_KEY))[ON_KEY] === true;
}

export async function saveAiOn(on: boolean): Promise<void> {
	await chrome.storage.local.set({ [ON_KEY]: on });
}
