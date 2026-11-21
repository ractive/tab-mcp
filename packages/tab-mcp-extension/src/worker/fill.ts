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
	type FillAnswer,
	type FillFailure,
	pairingCodes,
	takeCode,
} from "@ractive-ch/tab-mcp-client/extension";
import { escapeInvisible } from "@ractive-ch/tab-mcp-client/visible";
import {
	alwaysAllowable,
	fillAccess,
	PAIRING_SCRIPT,
	PAIRING_SCRIPT_ID,
	pairingMatches,
} from "../fill.ts";
import type { Answer } from "../protocol.ts";
import type { Kv } from "./kv.ts";
import {
	type FillAlways,
	loadFillAlways,
	loadFillFor,
	loadFillLost,
	saveFillAlways,
	saveFillState,
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

/** How long the panel shows the line of a fill without a question. */
export const NOTICE_MS = 10 * 60_000;

/** The id prefix of a notification that tells of a fill: no question's. */
export const FILLED_PREFIX = "filled:";

/**
 * What the panel and a notification say after a fill without a question
 * (DEC-213): the AI app by its own name (invisible characters escaped)
 * beside its verified host, as a question names it.
 */
export function filledText(client: { name: string; host: string }): string {
	const name = escapeInvisible(client.name);
	const host = escapeInvisible(client.host);
	return `Filled in the code for ${name ? `${name} (${host})` : host}.`;
}

/** A notification's text for a fill without a question: nothing to answer. */
export function filledNotification(client: { name: string; host: string }) {
	return {
		title: "Code filled in",
		message: filledText(client),
		contextMessage: `You chose Always allow for ${escapeInvisible(client.host)}`,
	};
}

/**
 * What the library gets for the answer to a pairing question, and whether
 * to remember the host (DEC-213): "Always allow" (`site`) fills in and
 * remembers only where the question offered it; anywhere else it counts as
 * Don't allow, as before.
 */
export function pairingAnswer(
	answer: Answer | "timeout" | "busy",
	offered: boolean,
): { answer: FillAnswer; always: boolean } {
	if (answer !== "site") return { answer, always: false };
	return offered
		? { answer: "allow", always: true }
		: { answer: "deny", always: false };
}

/**
 * The pages let through without a question (DEC-213), by tab, until their
 * code comes: Remove withdraws the ones of its host, the page going or its
 * tab closing drops them, and the code's arrival says whether to tell the
 * user.
 */
export class UnaskedFills {
	readonly #byTab = new Map<
		number,
		{ host: string; withdraw: AbortController }
	>();

	/** Tab `tabId`'s page of `host` is let through; `page` aborts when it goes. */
	start(tabId: number, host: string, page: AbortSignal): void {
		// Gone already: the library fills in nothing for it.
		if (page.aborted) return;
		const entry = { host, withdraw: new AbortController() };
		this.#byTab.set(tabId, entry);
		page.addEventListener("abort", () => this.#drop(tabId, entry), {
			once: true,
		});
	}

	/** Whatever an earlier page in the tab left (a new page there asks anew). */
	clear(tabId: number): void {
		this.#byTab.delete(tabId);
	}

	/**
	 * The signal that withdraws the wait for the code of `host`'s page in
	 * `tabId`, if it was let through without a question.
	 */
	signal(tabId: number, host: string): AbortSignal | undefined {
		const entry = this.#byTab.get(tabId);
		return entry?.host === host ? entry.withdraw.signal : undefined;
	}

	/**
	 * The wait for the code ended (`code` is whether one came): `notice` if
	 * the page was let through and not withdrawn and a code came (tell the
	 * user), `withdrawn` if Remove withdrew it, else `asked`.
	 */
	finish(
		tabId: number,
		host: string,
		code: boolean,
	): "notice" | "withdrawn" | "asked" {
		const entry = this.#byTab.get(tabId);
		if (entry?.host !== host) return "asked";
		this.#byTab.delete(tabId);
		if (entry.withdraw.signal.aborted) return "withdrawn";
		return code ? "notice" : "asked";
	}

	/** Remove: the fills of `host` that wait for their code go. */
	withdraw(host: string): void {
		for (const entry of this.#byTab.values())
			if (entry.host === host) entry.withdraw.abort();
	}

	/** The tab closed. */
	tabClosed(tabId: number): void {
		this.#byTab.delete(tabId);
	}

	get size(): number {
		return this.#byTab.size;
	}

	#drop(tabId: number, entry: { host: string }): void {
		if (this.#byTab.get(tabId) === entry) this.#byTab.delete(tabId);
	}
}

/** At most this many fills without a question per host in UNASKED_WINDOW_MS (DEC-213). */
export const MAX_UNASKED = 3;
export const UNASKED_WINDOW_MS = 10 * 60_000;

/**
 * The "Fill in the code for me" setting (DEC-203, DEC-210), kept in storage:
 * the relay it is on for, and the relay for which it went off by itself
 * because its site was taken away (the panel says so). On only with the
 * relay's site: a switch that shows off never fills in later by itself.
 * With it, the AI apps' verified hosts the user chose "Always allow" for
 * (DEC-213): forgotten whenever the setting goes off or the relay changes.
 */
export class FillSetting {
	readonly #kv: Kv;
	readonly #contains: Contains;
	#for: string | undefined;
	#lost: string | undefined;
	#always: FillAlways | undefined;

	private constructor(
		kv: Kv,
		contains: Contains,
		fillFor: string | undefined,
		lost: string | undefined,
		always: FillAlways | undefined,
	) {
		this.#kv = kv;
		this.#contains = contains;
		this.#for = fillFor;
		this.#lost = lost;
		// Only with the setting on for the same relay.
		this.#always =
			always !== undefined && fillFor !== undefined && always.relay === fillFor
				? always
				: undefined;
	}

	static async load(
		kv: Kv,
		contains: Contains = (p) => chrome.permissions.contains(p),
	): Promise<FillSetting> {
		const [fillFor, lost, always] = await Promise.all([
			loadFillFor(kv),
			loadFillLost(kv),
			loadFillAlways(kv),
		]);
		const setting = new FillSetting(kv, contains, fillFor, lost, always);
		// A stored list that is not this setting's (left by a write that did
		// not happen): deleted, not only ignored, so a later "on" for its
		// relay cannot bring it back.
		if (always !== undefined && setting.#always === undefined)
			await saveFillAlways(kv, undefined).catch((error: unknown) =>
				console.warn("tab-mcp: forgetting stale hosts", error),
			);
		return setting;
	}

	/** On for `relay`. */
	on(relay: string): boolean {
		return this.#for !== undefined && this.#for === relay;
	}

	/** Went off by itself for `relay`: its site was taken away. */
	lost(relay: string): boolean {
		return this.#lost !== undefined && this.#lost === relay;
	}

	/** The hosts filled in for without a question at `relay`, in the order chosen. */
	alwaysHosts(relay: string): string[] {
		return this.on(relay) && this.#always?.relay === relay
			? [...this.#always.hosts]
			: [];
	}

	/**
	 * "Always allow" for `host` at `relay`: only while the setting is on
	 * there, and only for a host that qualifies (`alwaysAllowable`).
	 * Returns whether it is remembered.
	 */
	async allowAlways(relay: string, host: string): Promise<boolean> {
		if (!this.on(relay) || !alwaysAllowable(host)) return false;
		const always = this.#always ?? { relay, hosts: [], unasked: {} };
		if (!always.hosts.includes(host)) {
			this.#always = { ...always, hosts: [...always.hosts, host] };
			await saveFillAlways(this.#kv, this.#always);
		}
		return true;
	}

	/**
	 * Its next sign-in page asks again. Forgotten in memory at once; if that
	 * cannot be stored, every host is forgotten (the safe direction), in
	 * memory and, if a second write gets through, in storage. Whatever the
	 * stores say, the next write of the list (any later change) is the list
	 * in memory.
	 */
	async forget(relay: string, host: string): Promise<void> {
		const always = this.#always;
		if (always?.relay !== relay || !always.hosts.includes(host)) return;
		const { [host]: _, ...unasked } = always.unasked;
		this.#always = {
			relay,
			hosts: always.hosts.filter((h) => h !== host),
			unasked,
		};
		try {
			await saveFillAlways(this.#kv, this.#always);
		} catch (error) {
			console.warn("tab-mcp: forgetting a host; forgetting all", error);
			this.#always = undefined;
			await saveFillAlways(this.#kv, undefined).catch((again: unknown) =>
				console.warn("tab-mcp: forgetting all hosts", again),
			);
		}
	}

	/**
	 * Whether `host`'s sign-in page at `relay` is filled in without a
	 * question now, at `now`: a remembered host, under the brake (at most
	 * MAX_UNASKED in UNASKED_WINDOW_MS). Yes counts as one of them.
	 */
	async takeUnasked(
		relay: string,
		host: string,
		now: number,
	): Promise<boolean> {
		const always = this.#always;
		if (!this.on(relay) || always?.relay !== relay) return false;
		if (!always.hosts.includes(host)) return false;
		// A time after now (the clock went back) counts as now: still inside
		// the window, so moving the clock back does not reset the brake.
		const recent = (always.unasked[host] ?? [])
			.map((at) => Math.min(at, now))
			.filter((at) => now - at < UNASKED_WINDOW_MS)
			.slice(-MAX_UNASKED);
		if (recent.length >= MAX_UNASKED) return false;
		this.#always = {
			...always,
			// At most MAX_UNASKED times per host are kept.
			unasked: {
				...always.unasked,
				[host]: [...recent, now].slice(-MAX_UNASKED),
			},
		};
		await saveFillAlways(this.#kv, this.#always);
		return true;
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

	/**
	 * The setting and its note; the remembered hosts go with the setting
	 * (off, or another relay). All three in one transaction (DEC-213).
	 */
	async #set(fillFor: string | undefined, lost: string | undefined) {
		const always =
			this.#always !== undefined && this.#always.relay === fillFor
				? this.#always
				: undefined;
		if (this.#for === fillFor && this.#lost === lost && this.#always === always)
			return;
		this.#for = fillFor;
		this.#lost = lost;
		this.#always = always;
		await saveFillState(this.#kv, { fillFor, lost, always });
	}
}
