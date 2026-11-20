/**
 * The worker's own parts of filling in the code on the relay's pairing page
 * (DEC-199, DEC-203). The rules (who may speak for a page, one question per
 * page load, the one more fill for the same request, what withdraws a
 * question) are the library's `CodeFiller` (DEC-206); the connection gives it
 * this extension's parts: the question, the setting, the code with pairing
 * held on, and the panel's texts here. The content script's registration is
 * here too.
 */

import type { FillFailure } from "@ractive-ch/tab-mcp-client/extension";
import {
	fillAccess,
	PAIRING_SCRIPT,
	PAIRING_SCRIPT_ID,
	pairingMatches,
} from "../fill.ts";

/** Pairing stays on this long after a fill, for the relay to check the code. */
export const HOLD_MS = 30_000;

/** What the panel says when Allow could fill in nothing. */
export const NO_CODE =
	"The code was not filled in: none came from the relay. Type the code shown under “Pair an AI app” instead.";

/** What the panel says when a pairing page could not be asked about. */
export const BUSY =
	"Another AI app's connection request waits for your answer. Type the code into the newer sign-in page, or reload it once you have answered.";

/** What the panel says when a pairing page filled in nothing. */
export function failureText(why: FillFailure): string {
	return why === "busy" ? BUSY : NO_CODE;
}

/** The browser APIs the registration uses (the unit tests give their own). */
export interface ScriptApi {
	permissions: Pick<typeof chrome.permissions, "contains">;
	scripting: Pick<
		typeof chrome.scripting,
		| "getRegisteredContentScripts"
		| "registerContentScripts"
		| "unregisterContentScripts"
		| "executeScript"
	>;
	tabs: Pick<typeof chrome.tabs, "query">;
}

/**
 * Register the pairing page's content script for the relay `relay` while the
 * user has turned filling in on there (`enabled`) and given access to its
 * site (or to all sites), and only then; for another relay, again. Just
 * registered, it is put into a pairing page that is open already.
 */
export async function syncPairingScript(
	relay: string,
	enabled: boolean,
	api: ScriptApi = chrome,
): Promise<void> {
	const access = fillAccess(relay);
	const matches = pairingMatches(relay);
	const granted =
		enabled && access !== undefined && (await api.permissions.contains(access));
	const [registered] = await api.scripting.getRegisteredContentScripts({
		ids: [PAIRING_SCRIPT_ID],
	});
	if (
		granted &&
		registered !== undefined &&
		JSON.stringify(registered.matches ?? []) === JSON.stringify(matches)
	)
		return;
	if (registered !== undefined)
		await api.scripting.unregisterContentScripts({ ids: [PAIRING_SCRIPT_ID] });
	if (!granted) return;
	await api.scripting.registerContentScripts([
		{
			id: PAIRING_SCRIPT_ID,
			js: [PAIRING_SCRIPT],
			matches,
			runAt: "document_idle",
		},
	]);
	const open = await api.tabs.query({ url: matches });
	await Promise.all(
		open.map((tab) =>
			tab.id === undefined
				? undefined
				: api.scripting
						.executeScript({
							target: { tabId: tab.id },
							files: [PAIRING_SCRIPT],
						})
						.catch(() => {
							// A tab that changed meanwhile.
						}),
		),
	);
}
