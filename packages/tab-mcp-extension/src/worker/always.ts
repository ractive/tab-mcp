/**
 * "Always allow" from a question: per grant (AI app), page and tool, in the
 * service worker's memory, as the library keeps its own. The page is its
 * origin and its document (the content script's id for the page loaded in
 * the tab), so the answer holds for this tool on this page only: a
 * navigation, a reload or another tab with a tool of the same name asks
 * again. An entry also goes when its grant goes or its tool is unregistered.
 */

/** What an Always allow is for. */
export interface AlwaysKey {
	grantId: string;
	origin: string;
	documentId: string;
	/** The tool's name for the AI app (`page_<name>`). */
	tool: string;
}

export class AlwaysAllowed {
	/** By grant: the tool name and the page, as JSON. */
	readonly #entries = new Map<string, Map<string, string>>();

	static #page(key: AlwaysKey): string {
		return JSON.stringify([key.origin, key.documentId, key.tool]);
	}

	has(key: AlwaysKey): boolean {
		return (
			this.#entries.get(key.grantId)?.get(AlwaysAllowed.#page(key)) === key.tool
		);
	}

	add(key: AlwaysKey): void {
		const entries = this.#entries.get(key.grantId) ?? new Map();
		entries.set(AlwaysAllowed.#page(key), key.tool);
		this.#entries.set(key.grantId, entries);
	}

	/** Forget every grant not in `grantIds`. */
	keepGrants(grantIds: Iterable<string>): void {
		const keep = new Set(grantIds);
		for (const grantId of this.#entries.keys())
			if (!keep.has(grantId)) this.#entries.delete(grantId);
	}

	/** Forget every tool not in `names`. */
	keepTools(names: Iterable<string>): void {
		const keep = new Set(names);
		for (const entries of this.#entries.values())
			for (const [page, tool] of entries)
				if (!keep.has(tool)) entries.delete(page);
	}
}
