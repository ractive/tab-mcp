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
