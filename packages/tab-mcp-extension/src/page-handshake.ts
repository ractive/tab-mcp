/**
 * The extension's side of the handshake with a page that uses the client
 * library with `webmcp: true` (DEC-205), in the content script of the top
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
 * Chrome, or after a click). It tells the page what it is, whether AI
 * access is on and which AI apps are connected (`hello`, `update`), and,
 * right before a page tool runs that the user allowed, `vouch`. Nothing
 * else: not the relay, not the address, not other tabs.
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
		!Array.isArray(apps) ||
		apps.length > MAX_APPS
	)
		return;
	const list: AppView[] = [];
	for (const a of apps) {
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

export class PageHandshake {
	readonly #doc: Document;
	readonly #host: HandshakeHost;
	/** What each of the page's apps announced, by app id. */
	readonly #pages = new Map<string, { library: string; apps: AppView[] }>();
	/** The page announced the library: the extension may speak to it. */
	#announced = false;

	constructor(doc: Document, host: HandshakeHost) {
		this.#doc = doc;
		this.#host = host;
	}

	/** Listen to the page; speak first if the page announced before this script ran. */
	start(): void {
		this.#doc.addEventListener(PAGE_EVENT, (event) =>
			this.#heard((event as CustomEvent).detail),
		);
		if (this.#doc.documentElement?.hasAttribute(MARK)) {
			this.#announced = true;
			void this.#tell("hello");
		}
	}

	/** What the page announced, all its apps together; `undefined` if nothing. */
	get library(): PageLibrary | undefined {
		if (this.#pages.size === 0) return undefined;
		const apps = new Map<string, AppView>();
		let version = "";
		for (const page of this.#pages.values()) {
			version = page.library;
			for (const a of page.apps) apps.set(JSON.stringify([a.name, a.host]), a);
		}
		return { version, apps: [...apps.values()] };
	}

	/** The extension's state changed: told to a page that announced the library. */
	stateChanged(state: ExtensionState): void {
		if (this.#announced) this.#send({ type: "update", ...state });
	}

	/**
	 * Right before the page's tool `tool` runs with `args`, which the user
	 * allowed: tell a page that announced the library. Synchronous, so the
	 * page has it before the call.
	 */
	vouch(tool: string, args: unknown, vouch: Vouch): void {
		if (!this.#announced) return;
		this.#send({
			type: "vouch",
			tool,
			arguments: args,
			nonce: vouch.nonce,
			app: { name: vouch.app.name, host: vouch.app.host },
		});
	}

	#heard(detail: unknown): void {
		const m = parsePage(detail);
		if (m === undefined) return;
		this.#announced = true;
		const before = JSON.stringify(this.library);
		if (this.#pages.has(m.app) || this.#pages.size < MAX_PAGES)
			this.#pages.set(m.app, { library: m.library, apps: m.apps });
		if (JSON.stringify(this.library) !== before) this.#host.changed();
		if (m.type === "hello") void this.#tell("update");
	}

	/** Ask the worker for the state and tell the page. */
	async #tell(type: "hello" | "update"): Promise<void> {
		const state = await this.#host.state().catch(() => undefined);
		if (state !== undefined) this.#send({ type, ...state });
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
