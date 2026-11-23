/**
 * WebMCP on a click (DEC-223): where the worker reads a tab that has no
 * WebMCP (Chrome without its own on a site outside the origin trial, or
 * Firefox, and the extension without access to all sites, so its own came
 * not at `document_start`), it gives the page the extension's own now
 * (`giveWebMCP` in `tabs.ts`). A page with the client library looks again
 * then and mirrors its tools; everything after that is the usual path.
 *
 * Once per document (the content script's id): a page whose own polyfill
 * makes the extension's step aside costs one try, not one per read. And,
 * for the panel, whether WebMCP is on its way to the tab, so that it does
 * not say "This page has no WebMCP" in between.
 */

import type { ExtensionState, PageTools } from "../messages.ts";

/**
 * Whether the extension gives a page its WebMCP late, now: only while AI
 * access is on and connected, the same "on" in which it speaks to a page at
 * all (DEC-221); the owner's decision (DEC-223). The one place that
 * decides it.
 */
export function mayGiveLate(state: ExtensionState): boolean {
	return state.on;
}

/** A document tried, and how far. */
interface Tried {
	documentId: string;
	/** `give` settled (or failed): the next read of this document says what came of it. */
	given: boolean;
	/** A read after that: what the page has is what it gets. */
	settled: boolean;
}

const LOOPBACK = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Whether a page of `origin` can take the extension's WebMCP at all: the
 * polyfill (`chrome/webmcp-main.ts`, `firefox/webmcp.ts`) installs only in a
 * secure context, so only https pages and the loopback host's http ones.
 */
export function canTakeWebMCP(origin: string): boolean {
	try {
		const { protocol, hostname } = new URL(origin);
		return (
			protocol === "https:" || (protocol === "http:" && LOOPBACK.test(hostname))
		);
	} catch {
		return false;
	}
}

export class LateWebMCP {
	readonly #give: (tabId: number, documentId: string) => Promise<boolean>;
	readonly #may: () => boolean;
	readonly #failed: () => void;
	readonly #tabs = new Map<number, Tried>();

	/**
	 * `give`: puts the extension's WebMCP into the tab's page that was read
	 * (`giveWebMCP`), `false` if the tab shows another page now; `may`:
	 * whether it may now (`mayGiveLate` of the worker's state); `failed`:
	 * `give` rejected or found another page, so that the panel is told.
	 */
	constructor(
		give: (tabId: number, documentId: string) => Promise<boolean>,
		may: () => boolean,
		failed: () => void = () => {},
	) {
		this.#give = give;
		this.#may = may;
		this.#failed = failed;
	}

	/**
	 * The worker read `tabId`'s tools: give the page WebMCP where it has
	 * none, can take it and may. A page that can never take it (not a secure
	 * context) is settled at once, so that the panel says it has none.
	 */
	read(tabId: number, tools: PageTools): void {
		const tried = this.#tabs.get(tabId);
		if (tried?.documentId === tools.documentId) {
			if (tried.given) tried.settled = true;
			return;
		}
		if (tools.available || !this.#may()) return;
		const entry: Tried = {
			documentId: tools.documentId,
			given: false,
			settled: false,
		};
		this.#tabs.set(tabId, entry);
		if (!canTakeWebMCP(tools.origin)) {
			entry.given = true;
			entry.settled = true;
			return;
		}
		const gone = () => {
			entry.given = true;
			entry.settled = true;
			this.#failed();
		};
		this.#give(tabId, tools.documentId).then((given) => {
			if (given) entry.given = true;
			else gone();
		}, gone);
	}

	/**
	 * Whether WebMCP may still come to the page the worker last read in
	 * `tabId` (`documentId`, `undefined` if it has not read it yet): the
	 * panel then does not say that the page has none.
	 */
	pending(tabId: number, documentId: string | undefined): boolean {
		if (!this.#may()) return false;
		if (documentId === undefined) return true;
		const tried = this.#tabs.get(tabId);
		return tried?.documentId !== documentId || !tried.settled;
	}

	/** The tab closed. */
	closed(tabId: number): void {
		this.#tabs.delete(tabId);
	}
}
