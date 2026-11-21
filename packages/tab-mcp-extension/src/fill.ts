/**
 * Filling in the extension's own pairing code on the relay's pairing page
 * (`/authorize`) when an AI app opens it in this browser (DEC-199, DEC-203).
 * The rules, the page's side and the messages are the library's
 * (`@ractive-ch/tab-mcp-client/extension`, DEC-206), shared with Sitegloss;
 * what is this extension's own is here and in `worker/fill.ts`: the content
 * script's file and registration, and the permission it asks for.
 */

import {
	pairingPagePattern,
	relaySitePattern,
} from "@ractive-ch/tab-mcp-client/extension";

/** The content script for the pairing page in the build, and its registration id. */
export const PAIRING_SCRIPT = "pairing.js";
export const PAIRING_SCRIPT_ID = "tab-mcp-pairing-page";

/**
 * The host access that lets the extension see the relay's pages: one origin
 * of its optional host permissions (`http://*` and `https://*`), asked for
 * with a click in the panel. `undefined` for an address that has none.
 */
export function fillAccess(
	relay: string,
): chrome.permissions.Permissions | undefined {
	const pattern = relaySitePattern(relay);
	return pattern === undefined ? undefined : { origins: [pattern] };
}

/** Where the pairing page's content script is registered: the page only. */
export function pairingMatches(relay: string): string[] {
	const pattern = pairingPagePattern(relay);
	return pattern === undefined ? [] : [pattern];
}

/**
 * Names that never belong to one public owner: special-use and test names
 * (RFC 6761, RFC 6762, RFC 8375, RFC 9476, ICANN's `.internal`).
 */
const SPECIAL_USE = [
	"localhost",
	"local",
	"internal",
	"test",
	"example",
	"invalid",
	"home.arpa",
	"onion",
	"alt",
];

/**
 * Whether "Always allow" may be offered for the AI app's verified host
 * `host` (the pairing form's `data-client-host`, `host[:port]`) (DEC-212):
 * only a public DNS name, which the relay got the AI app's details from over
 * https. Not an IP address, not `localhost`, not a single label, not a
 * special-use or test name. The form does not say how the relay verified
 * the host, so this goes by its shape; a port is only there with a relay
 * that allows one (a test relay), and changes nothing about the name.
 */
export function alwaysAllowable(host: string): boolean {
	if (host.length > 260) return false;
	const match = /^([^:[\]]+)(?::\d{1,5})?$/.exec(host);
	if (match === null) return false; // an IPv6 address, or no host at all
	const name = (match[1] ?? "").toLowerCase().replace(/\.$/, "");
	const labels = name.split(".");
	if (
		name.length > 253 ||
		labels.length < 2 ||
		!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))
	)
		return false;
	// An IPv4 address (or anything ending in a number): no name.
	if (/^[0-9]+$/.test(labels.at(-1) ?? "")) return false;
	return !SPECIAL_USE.some((s) => name === s || name.endsWith(`.${s}`));
}
