/**
 * The extension's side of the handshake with a page that uses the client
 * library with `webmcp: true` (DEC-207), in the content script of the top
 * frame. The page's side is `packages/tab-mcp-client/src/handshake.ts`.
 *
 * Plain DOM events on `document`, a JSON string as `detail` (objects do not
 * cross between this world and the page's in every browser):
 * `tab-mcp-page` from the page, `tab-mcp-extension` from here. Every
 * message has `v: 1` and a `type`; another version, an unknown type or a
 * malformed message is ignored, and so are unknown fields.
 *
 * The extension speaks only to a page that announced the library: its
 * `hello`, or `<html data-tab-mcp-handshake>`, which the library sets for an
 * extension that comes later (this script runs at `document_idle` in
 * Chrome, or after a click). And only while AI access is on and connected
 * (DEC-221): then it tells the page its name and which AI apps are
 * connected (`hello`, `update`), and, right before a page tool runs that
 * the user allowed, `vouch`, and once that call ended or failed,
 * `withdraw` with the vouch's nonce, so that a vouch its call did not use
 * does not wait for another caller. While off it says nothing, so that a
 * page cannot tell the extension from none; a page it told "on" hears
 * `update` with `on: false` once, so that its display does not stay on.
 * Nothing else: not its version, not the relay, not the address, not
 * other tabs.
 *
 * Everything the page says is the page's word: it only feeds the panel's
 * lines. No proof either way: a page script can fake the library, and the
 * page can fake the extension to itself; a convenience between two parts
 * the user trusts, not a security boundary.
 */

import type {
	AppView,
	ExtensionState,
	PageLibrary,
	Vouch,
} from "./messages.ts";

/** From the page. */
export const PAGE_EVENT = "tab-mcp-page";
/** To the page. */
export const EXTENSION_EVENT = "tab-mcp-extension";
/** On `<html>`: the page takes part (set by the library). */
export const MARK = "data-tab-mcp-handshake";

/** A page's texts are taken up to these lengths, its apps up to this count. */
const MAX_TEXT = 256;
const MAX_APPS = 64;
/** At most this many apps (`app` ids) of one page are kept. */
const MAX_PAGES = 16;

/** A page's announcement, checked. */
export interface PageMessage {
	type: "hello" | "update";
	library: string;
	app: string;
	apps: AppView[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): value is string =>
	typeof value === "string" && value.length <= MAX_TEXT;

/** A page's message (an event's `detail`); `undefined` for anything else. */
export function parsePage(detail: unknown): PageMessage | undefined {
	if (typeof detail !== "string" || detail.length > 64 * 1024) return;
	let m: unknown;
	try {
		m = JSON.parse(detail);
	} catch {
		return;
	}
	if (!isObject(m) || m["v"] !== 1) return;
	const { type, library, app, apps } = m;
	if (
		(type !== "hello" && type !== "update") ||
		!text(library) ||
		!text(app) ||
		!Array.isArray(apps)
	)
		return;
	const list: AppView[] = [];
	// Cut, not refused, as the library cuts the extension's list: a page
	// with more apps than that still gets its handshake.
	for (const a of apps.slice(0, MAX_APPS)) {
		if (!isObject(a) || !text(a["name"]) || !text(a["host"])) return;
		list.push({ name: a["name"], host: a["host"] });
	}
	return { type, library, app, apps: list };
}

/** What the handshake needs from the content script. */
export interface HandshakeHost {
	/** The extension's state, from the worker (`undefined`: it did not answer). */
	state(): Promise<ExtensionState | undefined>;
	/** What the page announced changed (the panel shows it). */
	changed(): void;
}

/**
 * A worker that did not answer (starting, failing) is asked again after
 * these delays (milliseconds), then not until the page says `hello` again:
 * the page learns the state without waiting for its next change, and a
 * worker that cannot answer is not asked in a loop.
 */
export const RETRY_MS: readonly number[] = [1_000, 5_000];

export class PageHandshake {
	readonly #doc: Document;
	readonly #host: HandshakeHost;
	readonly #retryMs: readonly number[];
	/** What each of the page's apps announced, by app id, in the order they first did. */
	readonly #pages = new Map<string, { library: string; apps: AppView[] }>();
	/** The page announced the library: the extension may speak to it. */
	#announced = false;
	/**
	 * The state as the worker last sent it (an answer or a change). The
	 * worker sends every change, so a later `hello` of the page is answered
	 * from it: a page saying `hello` in a loop costs the one worker of all
	 * tabs nothing.
	 */
	#state: ExtensionState | undefined;
	/** The page is owed the state once it is known (a `hello` of its own, or its mark). */
	#owed = false;
	/**
	 * The page marked itself and has not spoken since this script listens:
	 * the first message to it is `hello`, which it answers with what it
	 * announced. Kept while AI access is off, as nothing is said then.
	 */
	#greet = false;
	/** This document was told "on", and not "off" since (DEC-221). */
	#on = false;
	/** The nonces of the vouches it was told and not yet withdrawn. */
	readonly #vouched = new Set<string>();
	/** The worker is being asked (or a retry waits): one round at a time. */
	#asking = false;
	/** Counts the rounds: the answer of an ended round is not used. */
	#round = 0;
	#retry: ReturnType<typeof setTimeout> | undefined;

	/** `retryMs`: `RETRY_MS`, shorter in tests. */
	constructor(doc: Document, host: HandshakeHost, retryMs = RETRY_MS) {
		this.#doc = doc;
		this.#host = host;
		this.#retryMs = retryMs;
	}

	/** Listen to the page; speak first if the page announced before this script ran. */
	start(): void {
		this.#doc.addEventListener(PAGE_EVENT, (event) =>
			this.#heard((event as CustomEvent).detail),
		);
		// A page that goes away needs no answer: no more retries for it.
		this.#doc.defaultView?.addEventListener("pagehide", () => this.#end());
		if (this.#doc.documentElement?.hasAttribute(MARK)) {
			this.#announced = true;
			this.#greet = true;
			this.#owe();
		}
	}

	/**
	 * What the page announced, all its apps together; `undefined` if nothing.
	 * The version is that of the app id the page announced first: a page
	 * with several `TabMcp`s has one library, and should two differ, the
	 * panel always shows the same one.
	 */
	get library(): PageLibrary | undefined {
		const first = this.#pages.values().next().value;
		if (first === undefined) return undefined;
		const apps = new Map<string, AppView>();
		for (const page of this.#pages.values())
			for (const a of page.apps) apps.set(JSON.stringify([a.name, a.host]), a);
		return { version: first.library, apps: [...apps.values()] };
	}

	/**
	 * The extension's state changed (the worker's word): kept, and told to a
	 * page that announced the library.
	 */
	stateChanged(state: ExtensionState): void {
		this.#state = state;
		this.#end();
		if (this.#announced) this.#tell(state);
	}

	/**
	 * Right before the page's tool `tool` runs with `args`, which the user
	 * allowed: tell a page that was told "on". Synchronous, so the page has
	 * it before the call.
	 */
	vouch(tool: string, args: unknown, vouch: Vouch): void {
		if (!this.#on) return;
		this.#vouched.add(vouch.nonce);
		this.#send({
			type: "vouch",
			tool,
			arguments: args,
			nonce: vouch.nonce,
			app: { name: vouch.app.name, host: vouch.app.host },
		});
	}

	/**
	 * The vouch with `nonce` is no longer wanted: its call ended, or failed
	 * or was cancelled before it reached the page. Sent after every vouched
	 * call: a vouch its call used is gone already, and of two vouches for
	 * equal calls the page may have used the other one for this call.
	 */
	withdraw(nonce: string): void {
		// Also after "off": the page has the vouch, it must not wait.
		if (this.#vouched.delete(nonce)) this.#send({ type: "withdraw", nonce });
	}

	#heard(detail: unknown): void {
		const m = parsePage(detail);
		if (m === undefined) return;
		this.#announced = true;
		this.#greet = false;
		const before = JSON.stringify(this.library);
		if (this.#pages.has(m.app) || this.#pages.size < MAX_PAGES)
			this.#pages.set(m.app, { library: m.library, apps: m.apps });
		if (JSON.stringify(this.library) !== before) this.#host.changed();
		if (m.type === "hello") this.#owe();
	}

	/** Tell the page the state: at once if known, else once the worker answers. */
	#owe(): void {
		if (this.#state !== undefined) {
			this.#tell(this.#state);
			return;
		}
		this.#owed = true;
		if (this.#asking) return;
		this.#asking = true;
		void this.#ask(this.#round, 0);
	}

	/** Ask the worker for the state; after no answer, again after `#retryMs[attempt]`. */
	async #ask(round: number, attempt: number): Promise<void> {
		const state = await this.#host.state().catch(() => undefined);
		// Ended meanwhile: a change came from the worker, or the page went away.
		if (round !== this.#round) return;
		if (state !== undefined) {
			this.#state = state;
			if (this.#end()) this.#tell(state);
			return;
		}
		const delay = this.#retryMs[attempt];
		if (delay === undefined) {
			// Given up: the page's next `hello` or the worker's next change heals it.
			this.#end();
			return;
		}
		this.#retry = setTimeout(() => void this.#ask(round, attempt + 1), delay);
	}

	/** End the round of asking; whether the page was owed the state. */
	#end(): boolean {
		const owed = this.#owed;
		this.#round++;
		clearTimeout(this.#retry);
		this.#retry = undefined;
		this.#owed = false;
		this.#asking = false;
		return owed;
	}

	/**
	 * Tell the page the state (DEC-221): while on, what it is and the AI
	 * apps; while not, nothing, unless it was told "on": then `on: false`,
	 * once. Field by field: nothing else the worker might send gets through.
	 */
	#tell(state: ExtensionState): void {
		if (!state.on) {
			if (!this.#on) return;
			this.#on = false;
			this.#send({ type: "update", on: false });
			return;
		}
		const type = this.#greet ? "hello" : "update";
		this.#greet = false;
		this.#on = true;
		this.#send({
			type,
			name: state.name,
			on: true,
			// Capped as the page caps its own list: the library cuts it there too.
			apps: state.apps
				.slice(0, MAX_APPS)
				.map((a) => ({ name: a.name, host: a.host })),
			whileInFront: state.whileInFront,
		});
	}

	#send(message: Record<string, unknown>): void {
		// A string: an object would not reach the page's world in every
		// browser. The document's own `CustomEvent`, as a document takes only
		// events of its realm.
		const Custom = this.#doc.defaultView?.CustomEvent ?? CustomEvent;
		this.#doc.dispatchEvent(
			new Custom(EXTENSION_EVENT, {
				detail: JSON.stringify({ v: 1, ...message }),
			}),
		);
	}
}
