/**
 * The worker's own parts of filling in the code on the relay's pairing page
 * (DEC-199, DEC-203). The rules (who may speak for a page, one question per
 * page load, the one more fill for the same request, what withdraws a
 * question) are the library's `CodeFiller` (DEC-206); the connection gives it
 * this extension's parts: the question, the setting, the code with pairing
 * held on, and the panel's texts here. The content script's registration is
 * here too.
 */

import type { TabMcp } from "@ractive-ch/tab-mcp-client";
import {
	type FillFailure,
	pairingCodes,
	takeCode,
} from "@ractive-ch/tab-mcp-client/extension";
import {
	fillAccess,
	PAIRING_SCRIPT,
	PAIRING_SCRIPT_ID,
	pairingMatches,
} from "../fill.ts";
import type { Kv } from "./kv.ts";
import {
	loadFillFor,
	loadFillLost,
	saveFillFor,
	saveFillLost,
} from "./settings.ts";

/** Pairing stays on this long after a fill, for the relay to check the code. */
export const HOLD_MS = 30_000;

/** What the panel says when Allow could fill in nothing. */
export const NO_CODE =
	"The code was not filled in: none came from the relay. Type the code shown under “Connect your AI app” instead.";

/** What the panel says when a pairing page could not be asked about. */
export const BUSY =
	"Another AI app's connection request waits for your answer. Type the code into the newer sign-in page, or reload it once you have answered.";

/** What the panel says when a pairing page filled in nothing. */
export function failureText(why: FillFailure): string {
	return why === "busy" ? BUSY : NO_CODE;
}

/**
 * The code to fill in, with pairing on for it: pairing is started first (or
 * again, which brings back the code shown), then `takeCode` picks the code,
 * the next one if the one shown is about to change.
 */
export function codeWithPairingOn(
	mcp: Pick<
		TabMcp,
		"startPairing" | "pairingCode" | "addEventListener" | "removeEventListener"
	>,
	signal: AbortSignal,
	now: number = Date.now(),
): Promise<string | undefined> {
	mcp.startPairing();
	return takeCode(pairingCodes(mcp), signal, { now });
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

/** Whether the extension holds a permission (`chrome.permissions.contains`). */
export type Contains = (
	permissions: chrome.permissions.Permissions,
) => Promise<boolean>;

/**
 * The "Fill in the code for me" setting (DEC-203, DEC-210), kept in storage:
 * the relay it is on for, and the relay for which it went off by itself
 * because its site was taken away (the panel says so). On only with the
 * relay's site: a switch that shows off never fills in later by itself.
 */
export class FillSetting {
	readonly #kv: Kv;
	readonly #contains: Contains;
	#for: string | undefined;
	#lost: string | undefined;

	private constructor(
		kv: Kv,
		contains: Contains,
		fillFor: string | undefined,
		lost: string | undefined,
	) {
		this.#kv = kv;
		this.#contains = contains;
		this.#for = fillFor;
		this.#lost = lost;
	}

	static async load(
		kv: Kv,
		contains: Contains = (p) => chrome.permissions.contains(p),
	): Promise<FillSetting> {
		const [fillFor, lost] = await Promise.all([
			loadFillFor(kv),
			loadFillLost(kv),
		]);
		return new FillSetting(kv, contains, fillFor, lost);
	}

	/** On for `relay`. */
	on(relay: string): boolean {
		return this.#for !== undefined && this.#for === relay;
	}

	/** Went off by itself for `relay`: its site was taken away. */
	lost(relay: string): boolean {
		return this.#lost !== undefined && this.#lost === relay;
	}

	/**
	 * On for `relay`, if its site is granted (the panel asked for it first).
	 * Not granted any more (the worker gave it back for an "off" that came
	 * just before): it stays off, without the note, as nobody took it away.
	 */
	async turnOn(relay: string): Promise<boolean> {
		const access = fillAccess(relay);
		const granted =
			access !== undefined && (await this.#contains(access).catch(() => false));
		await this.#set(granted ? relay : undefined, undefined);
		return granted;
	}

	/** Off, and the note gone. */
	async turnOff(): Promise<void> {
		await this.#set(undefined, undefined);
	}

	/**
	 * Another relay is used: off, the note gone. Returns the relay it was on
	 * for, whose site is to be given back.
	 */
	async reset(): Promise<string | undefined> {
		const old = this.#for;
		await this.#set(undefined, undefined);
		return old;
	}

	/**
	 * On for `relay` but its site gone (taken away in the browser's
	 * settings): off, with the note. Returns whether it went off.
	 */
	async check(relay: string): Promise<boolean> {
		if (!this.on(relay)) return false;
		const access = fillAccess(relay);
		if (access !== undefined && (await this.#contains(access))) return false;
		// Turned off or on for another relay meanwhile.
		if (!this.on(relay)) return false;
		await this.#set(undefined, relay);
		return true;
	}

	async #set(fillFor: string | undefined, lost: string | undefined) {
		if (this.#for !== fillFor) {
			this.#for = fillFor;
			await saveFillFor(this.#kv, fillFor);
		}
		if (this.#lost !== lost) {
			this.#lost = lost;
			await saveFillLost(this.#kv, lost);
		}
	}
}
