/**
 * The worker's side of filling in the code on the relay's pairing page
 * (DEC-199, DEC-203): a page's port is taken only from this extension's
 * content script in the top frame of a tab at exactly the configured relay's
 * origin, and only while AI access is on. Then the user is asked, with the
 * AI app's verified host; on Allow the worker holds pairing on, takes the
 * current code and sends it to that one page, which fills it in and submits.
 *
 * No loops: one question per page load (one port per document, one hello
 * per port). When the same tab shows the page of the same request (the
 * relay's `request_id`) again soon after a fill, it is the relay's answer
 * that the code was not taken (it had just changed): filled once more with
 * the code of then, without asking; the time after, nothing. Any other
 * request asks. Don't allow, a timeout, the page going, AI access going off
 * or the AI app connecting meanwhile fill nothing, and typing by hand works
 * as before. Nothing at all unless the user turned filling in on (DEC-203).
 */

import type { PairingCode } from "@ractive-ch/tab-mcp-client";
import {
	type FillMessage,
	fillAccess,
	isPairingSender,
	PAIRING_SCRIPT,
	PAIRING_SCRIPT_ID,
	type PageSender,
	type PairingHello,
	pairingMatches,
	parseHello,
} from "../fill.ts";
import { type Answer, APP_ID } from "../protocol.ts";

/** A page that does not say who asks in this time is dropped. */
export const HELLO_WAIT_MS = 5_000;
/**
 * The same request's page in the same tab within this time after a fill is
 * the relay's answer to it: the code was not taken.
 */
export const RETRY_WINDOW_MS = 30_000;
/** No code from the relay in this time after Allow: nothing is filled in. */
export const CODE_WAIT_MS = 10_000;
/** A code with less time left than this is not used: the next one is. */
export const MIN_CODE_LEFT_MS = 5_000;
/** Pairing stays on this long after a fill, for the relay to check the code. */
export const HOLD_MS = 30_000;
/**
 * A filled-in page's port is closed this long after the fill: the page has
 * posted by then, and its answer, if any, is a new document with a port of
 * its own.
 */
export const FILLED_CLOSE_MS = 5_000;

/** What the panel says when Allow could fill in nothing. */
export const NO_CODE =
	"The code was not filled in: none came from the relay. Type the code shown under “Pair an AI app” instead.";

/** What the panel says when a pairing page could not be asked about. */
export const BUSY =
	"Another AI app's connection request waits for your answer. Type the code into the newer sign-in page, or reload it once you have answered.";

/**
 * A pairing page's port in the worker. Its first message and its end are
 * taken from the moment it connects: the connection may still be starting,
 * and Chrome hands a message only to the listeners there are.
 */
export interface PagePort {
	readonly sender: PageSender;
	/** The first message; `undefined` if the port went before one came. */
	readonly hello: Promise<unknown>;
	/** Aborted when the page goes (or the worker closes the port). */
	readonly signal: AbortSignal;
	send(message: FillMessage): void;
	close(): void;
}

/** `port`, taken over at once (see PagePort). */
export function pagePort(port: chrome.runtime.Port): PagePort {
	const gone = new AbortController();
	let first: (message: unknown) => void = () => {};
	const hello = new Promise<unknown>((resolve) => {
		first = resolve;
	});
	const take = (message: unknown) => {
		port.onMessage.removeListener(take);
		first(message);
	};
	port.onMessage.addListener(take);
	port.onDisconnect.addListener(() => {
		gone.abort();
		first(undefined);
	});
	return {
		sender: port.sender ?? {},
		hello,
		signal: gone.signal,
		send: (message) => {
			try {
				port.postMessage(message);
			} catch {
				// The page went meanwhile.
			}
		},
		close: () => {
			if (gone.signal.aborted) return;
			// Our own `disconnect()` fires no `onDisconnect` here.
			gone.abort();
			first(undefined);
			try {
				port.disconnect();
			} catch {
				// Gone already.
			}
		},
	};
}

/** What the filler needs from the connection. */
export interface FillHost {
	extensionId: string;
	/** The origin of the configured relay's pages (`relayPageOrigin`). */
	relayOrigin(): string | undefined;
	/** AI access is on: connected, or on its way. */
	aiOn(): boolean;
	/** The user turned filling in on, for this relay. */
	enabled(): boolean;
	/** The question (`Questions.askPairing`). */
	ask(
		tabId: number,
		client: { name: string; host: string },
		signal: AbortSignal,
	): Promise<Answer | "timeout" | "busy">;
	/**
	 * The code to fill in now, with pairing held on for the relay to check
	 * it; `undefined` if none came in time or `signal` aborted.
	 */
	code(signal: AbortSignal): Promise<string | undefined>;
	/** A filled-in code paired its AI app: pairing need not be held for it. */
	release(): void;
	/** A page filled in nothing, or was not asked about: the panel says why. */
	failed(why: string): void;
	now(): number;
}

/** A page whose question waits. */
interface Waiting {
	host: string;
	withdraw: AbortController;
}

/** The last fill in a tab. */
interface Filled {
	/** The relay's id of the request filled in. */
	requestId: string;
	host: string;
	/** Fills for it so far: 1 after Allow, 2 after the one more. */
	count: number;
	at: number;
}

const tabIdOf = (sender: PageSender): number | undefined => {
	const id = (sender.tab as { id?: unknown } | undefined)?.id;
	return typeof id === "number" ? id : undefined;
};

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

export class CodeFiller {
	readonly #host: FillHost;
	readonly #waiting = new Set<Waiting>();
	/** By tab: what was filled in there last. */
	readonly #filled = new Map<number, Filled>();
	/** The grants seen so far: a new one is an AI app that just connected. */
	readonly #grants: Set<string>;
	readonly #closeAfterMs: number;

	/**
	 * `grantIds`: the grants there are already (not new when listed again).
	 * `closeAfterMs`: FILLED_CLOSE_MS (the tests' is shorter).
	 */
	constructor(
		host: FillHost,
		grantIds: Iterable<string> = [],
		closeAfterMs = FILLED_CLOSE_MS,
	) {
		this.#host = host;
		this.#grants = new Set(grantIds);
		this.#closeAfterMs = closeAfterMs;
	}

	/** A pairing page's port: checked, then asked about and maybe filled in. */
	async page(port: PagePort): Promise<void> {
		const host = this.#host;
		const tabId = tabIdOf(port.sender);
		if (
			tabId === undefined ||
			!isPairingSender(port.sender, host.extensionId, host.relayOrigin())
		) {
			port.close();
			return;
		}
		const hello = parseHello(await within(port.hello, HELLO_WAIT_MS));
		// Only this extension's own app, only if the user turned filling in
		// on, and only while AI access is on: otherwise they have not asked
		// for it.
		if (
			hello === undefined ||
			hello.app !== APP_ID ||
			port.signal.aborted ||
			!host.enabled() ||
			!host.aiOn()
		) {
			port.close();
			return;
		}
		const before = this.#lastFill(tabId);
		if (before?.requestId === hello.requestId) {
			// The same request's page again after a fill: the code was not
			// taken. Once more with the code of now, then never again for it.
			if (before.count === 1) await this.#fill(port, tabId, hello, 2);
			else port.close();
			return;
		}
		const waiting: Waiting = {
			host: hello.clientHost,
			withdraw: new AbortController(),
		};
		this.#waiting.add(waiting);
		const signal = AbortSignal.any([port.signal, waiting.withdraw.signal]);
		let answer: Answer | "timeout" | "busy";
		try {
			answer = await host.ask(
				tabId,
				{ name: hello.clientName, host: hello.clientHost },
				signal,
			);
		} finally {
			this.#waiting.delete(waiting);
		}
		// Too many questions wait: not dropped unseen.
		if (answer === "busy") host.failed(BUSY);
		if (
			answer !== "allow" ||
			signal.aborted ||
			!host.enabled() ||
			!host.aiOn()
		) {
			port.close();
			return;
		}
		await this.#fill(port, tabId, hello, 1);
	}

	/** The last fill in `tabId`, if it is recent enough to be answered by this page. */
	#lastFill(tabId: number): Filled | undefined {
		const now = this.#host.now();
		for (const [id, filled] of this.#filled)
			if (now - filled.at > RETRY_WINDOW_MS) this.#filled.delete(id);
		return this.#filled.get(tabId);
	}

	async #fill(
		port: PagePort,
		tabId: number,
		hello: PairingHello,
		count: number,
	): Promise<void> {
		const code = await this.#host.code(port.signal);
		if (port.signal.aborted) return;
		if (code === undefined) {
			this.#host.failed(NO_CODE);
			port.close();
			return;
		}
		this.#filled.set(tabId, {
			requestId: hello.requestId,
			host: hello.clientHost,
			count,
			at: this.#host.now(),
		});
		port.send({ type: "fill", nonce: hello.nonce, code });
		setTimeout(() => port.close(), this.#closeAfterMs);
	}

	/**
	 * The relay's list of grants: an AI app that just connected (typed by
	 * hand, or filled in) withdraws the questions for its host, and its fills
	 * are done with.
	 */
	grantsChanged(grants: readonly { grantId: string; host: string }[]): void {
		const connected = new Set<string>();
		for (const grant of grants)
			if (!this.#grants.has(grant.grantId)) {
				this.#grants.add(grant.grantId);
				connected.add(grant.host);
			}
		if (connected.size === 0) return;
		for (const waiting of this.#waiting)
			if (connected.has(waiting.host)) waiting.withdraw.abort();
		let done = false;
		for (const [tabId, filled] of this.#filled)
			if (connected.has(filled.host)) {
				this.#filled.delete(tabId);
				done = true;
			}
		if (done) this.#host.release();
	}

	/**
	 * AI access off, or filling in turned off: the questions waiting are
	 * withdrawn and no page gets the one more fill.
	 */
	withdrawAll(): void {
		for (const waiting of this.#waiting) waiting.withdraw.abort();
		this.#filled.clear();
	}

	/** Another relay: no page of the one before is asked about or filled in. */
	reset(): void {
		this.withdrawAll();
		this.#grants.clear();
	}
}

/** Where the pairing codes come from: the library's connection. */
export interface CodeSource {
	current(): PairingCode | undefined;
	/** Call `listener` on every new code (or none); returns how to stop. */
	onChange(listener: () => void): () => void;
}

/**
 * The code to fill in. The current one if it has `minLeftMs` left by this
 * clock (or an expiry that cannot be read); else the next one the relay
 * sends, which is fresh whatever the clocks say. If none comes within
 * `waitMs`, the current one after all: with this clock ahead every code
 * would look expired, and the relay refuses one that is, which the one
 * more fill for the same request covers. `undefined` only without any code,
 * or when `signal` aborts.
 */
export function takeCode(
	source: CodeSource,
	signal: AbortSignal,
	options: { now: number; waitMs?: number; minLeftMs?: number },
): Promise<string | undefined> {
	const { waitMs = CODE_WAIT_MS, minLeftMs = MIN_CODE_LEFT_MS } = options;
	const current = source.current();
	if (
		current !== undefined &&
		!(Date.parse(current.expiresAt) - options.now < minLeftMs)
	)
		return Promise.resolve(current.code);
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const done = (code: string | undefined) => {
			clearTimeout(timer);
			stop();
			signal.removeEventListener("abort", aborted);
			resolve(code);
		};
		const stop = source.onChange(() => {
			const code = source.current()?.code;
			if (code !== undefined) done(code);
		});
		const aborted = () => done(undefined);
		const timer = setTimeout(() => done(source.current()?.code), waitMs);
		signal.addEventListener("abort", aborted, { once: true });
	});
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
