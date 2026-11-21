/**
 * The page's side of the handshake with the tab-mcp browser extension
 * (DEC-207), in the WebMCP mirror's chunk: only a page that offers its tools
 * to agents in the browser (`webmcp: true`) takes part.
 *
 * Plain DOM events on `document`, each with a JSON string as `detail`
 * (objects do not cross between a content script's world and the page's in
 * every browser): `tab-mcp-page` from the page, `tab-mcp-extension` from
 * the extension. Every message has `v: 1` and a `type`; a message of
 * another version, an unknown type or a malformed one is ignored, and so
 * are unknown fields.
 *
 * - The page announces itself (`hello`: the library's version, the app id,
 *   the AI apps connected to it directly) when it starts, again (`update`)
 *   when those apps change, and answers the extension's `hello` with an
 *   `update`. It marks `<html data-tab-mcp-handshake>`, so that an
 *   extension that starts later (its content script comes at
 *   `document_idle`, or with a click) knows it may speak without having
 *   heard the `hello`.
 * - The extension says what it is, whether it serves the page now and
 *   which AI apps are connected to it (`hello`, `update`), and, right before
 *   it runs a page tool the user allowed there, `vouch`: the tool, the exact
 *   arguments, a nonce and the AI app; once that call ended or failed,
 *   `withdraw` with the nonce, and a vouch still unused is dropped.
 * - Each side cuts the other's list of AI apps to 64 and sends no more.
 *
 * No proof of who sent what: anything that could fake the extension runs in
 * the page already, where it could skip any check. A convenience between
 * two parts the user trusts, not a security boundary.
 */

import type { RegisteredTool, ToolRegistry } from "./registry.ts";
import type { BrowserExtension, Grant } from "./types.ts";

/** From the page to the extension. */
export const PAGE_EVENT = "tab-mcp-page";
/** From the extension to the page. */
export const EXTENSION_EVENT = "tab-mcp-extension";
/** On `<html>`: this page takes part (for an extension that starts later). */
export const MARK = "data-tab-mcp-handshake";
/** A vouch is kept this long (milliseconds), then dropped unused. */
export const VOUCH_MS = 2_000;
/** At most this many vouches wait; beyond, the oldest goes. */
const MAX_VOUCHES = 16;
/** Texts from the extension are taken up to these lengths, apps up to this count either way. */
const MAX_TEXT = 256;
const MAX_APPS = 64;

/** One `TabMcp` of the page, as the handshake sees it. */
export interface HandshakePage {
	/** The library's version. */
	readonly version: string;
	readonly app: string;
	readonly registry: ToolRegistry;
	/** Vouches are taken for its tools (`trustExtension`). */
	readonly trust: boolean;
	/** The `TabMcp`: its `grants` and `grantschange`. */
	readonly mcp: EventTarget & { readonly grants: readonly Grant[] };
	/** The extension's state changed. */
	set(extension: BrowserExtension | undefined): void;
}

/** The AI app a vouched call came from. */
export interface VouchedBy {
	name: string;
	host: string;
}

interface Vouch {
	tool: RegisteredTool;
	/** The arguments, canonical (`canonical`). */
	args: string;
	nonce: string;
	app: VouchedBy;
	at: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): value is string =>
	typeof value === "string" && value.length <= MAX_TEXT;

/** An AI app as the extension names it; `undefined` if it is malformed. */
function appOf(value: unknown): VouchedBy | undefined {
	return isObject(value) && text(value["name"]) && text(value["host"])
		? { name: value["name"], host: value["host"] }
		: undefined;
}

/**
 * `value` as JSON with the keys of every object sorted: two argument
 * objects are equal when their canonical forms are.
 */
export function canonical(value: unknown): string {
	return (
		JSON.stringify(value, (_key, v: unknown) =>
			isObject(v)
				? Object.fromEntries(
						Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
					)
				: v,
		) ?? ""
	);
}

/** Monotonic milliseconds: a vouch's age must not follow the wall clock. */
const now = () => performance.now();

class Handshake {
	readonly #doc: Document;
	readonly #pages: HandshakePage[] = [];
	#extension: BrowserExtension | undefined;
	#vouches: Vouch[] = [];

	constructor(doc: Document) {
		this.#doc = doc;
		doc.addEventListener(EXTENSION_EVENT, (event) =>
			this.#heard((event as CustomEvent).detail),
		);
		doc.documentElement?.setAttribute(MARK, "1");
	}

	join(page: HandshakePage): void {
		this.#pages.push(page);
		if (this.#extension !== undefined) page.set(this.#extension);
		page.mcp.addEventListener("grantschange", () => this.#say(page, "update"));
		this.#say(page, "hello");
	}

	#say(page: HandshakePage, type: "hello" | "update"): void {
		// The document's own `CustomEvent`: a document may take only events
		// of its realm.
		const Custom = this.#doc.defaultView?.CustomEvent ?? CustomEvent;
		this.#doc.dispatchEvent(
			new Custom(PAGE_EVENT, {
				detail: JSON.stringify({
					v: 1,
					type,
					library: page.version,
					app: page.app,
					// Capped as the extension cuts what it hears: more would
					// not be heard anyway.
					apps: page.mcp.grants.slice(0, MAX_APPS).map((g) => ({
						name: g.client.name,
						host: g.client.host,
					})),
				}),
			}),
		);
	}

	#heard(detail: unknown): void {
		let m: unknown;
		try {
			m = typeof detail === "string" ? JSON.parse(detail) : undefined;
		} catch {
			return;
		}
		if (!isObject(m) || m["v"] !== 1) return;
		if (m["type"] === "vouch") this.#vouch(m);
		// The call it was for ended or never reached the page: an unused vouch
		// must not wait its 2 s for another caller.
		else if (m["type"] === "withdraw")
			this.#vouches = this.#vouches.filter((v) => v.nonce !== m["nonce"]);
		else if (m["type"] === "hello" || m["type"] === "update") {
			const extension = extensionOf(m);
			if (extension === null) return;
			if (canonical(extension) !== canonical(this.#extension)) {
				this.#extension = extension;
				for (const page of this.#pages) page.set(extension);
			}
			if (m["type"] === "hello")
				for (const page of this.#pages) this.#say(page, "update");
		}
	}

	/**
	 * A vouch, kept for the tool registered under its name now, by a page
	 * that takes vouches: a tool registered anew after this does not get it.
	 */
	#vouch(m: Record<string, unknown>): void {
		const app = appOf(m["app"]);
		const name = m["tool"];
		const nonce = m["nonce"];
		if (
			app === undefined ||
			typeof name !== "string" ||
			typeof nonce !== "string" ||
			!isObject(m["arguments"])
		)
			return;
		this.#drop();
		// The same vouch heard twice counts once.
		if (this.#vouches.some((v) => v.nonce === nonce)) return;
		for (const page of this.#pages) {
			const tool = page.trust ? page.registry.get(name) : undefined;
			if (tool === undefined) continue;
			this.#vouches.push({
				tool,
				args: canonical(m["arguments"]),
				nonce,
				app,
				at: now(),
			});
			if (this.#vouches.length > MAX_VOUCHES) this.#vouches.shift();
			return;
		}
	}

	/** Forget the vouches older than `VOUCH_MS`. */
	#drop(): void {
		const t = now();
		this.#vouches = this.#vouches.filter((v) => t - v.at <= VOUCH_MS);
	}

	/**
	 * The vouch for this call of `tool` with `input`, used up; `undefined`
	 * if there is none (the call is asked as without the extension).
	 */
	take(tool: RegisteredTool, input: unknown): VouchedBy | undefined {
		this.#drop();
		const args = canonical(input);
		const i = this.#vouches.findIndex(
			(v) => v.tool === tool && v.args === args,
		);
		return i < 0 ? undefined : this.#vouches.splice(i, 1)[0]?.app;
	}
}

/**
 * The extension's state from its `hello` or `update`: `undefined` when it
 * does not serve the page now, `null` when the message is malformed.
 */
function extensionOf(
	m: Record<string, unknown>,
): BrowserExtension | undefined | null {
	if (m["on"] !== true) return m["on"] === false ? undefined : null;
	const { name, version, apps } = m;
	if (!text(name) || !text(version) || !Array.isArray(apps)) return null;
	const list = apps.slice(0, MAX_APPS).map(appOf);
	if (list.some((a) => a === undefined)) return null;
	return Object.freeze({
		name,
		version,
		apps: Object.freeze(list.map((a) => Object.freeze(a as VouchedBy))),
		whileInFront: m["whileInFront"] !== false,
	});
}

const handshakes = new WeakMap<Document, Handshake>();

/**
 * The handshake of the page's top-level document, which `page` joins; the
 * extension speaks only to the top frame. `undefined` in a frame or
 * without a document.
 */
export function joinHandshake(page: HandshakePage): Handshake | undefined {
	const doc = globalThis.document;
	if (doc === undefined || globalThis.top !== globalThis.window)
		return undefined;
	let handshake = handshakes.get(doc);
	if (handshake === undefined) {
		handshake = new Handshake(doc);
		handshakes.set(doc, handshake);
	}
	handshake.join(page);
	return handshake;
}
