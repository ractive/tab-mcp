/**
 * The tools a user chose "Always allow" for, per grant (AI app). Kept in
 * memory for the page's lifetime; an entry goes when its grant goes or its
 * tool is unregistered, so a re-paired app or a new tool under the same name
 * is asked again.
 */
export class AlwaysAllowed {
	readonly #tools = new Map<string, Set<string>>();

	has(grantId: string, tool: string): boolean {
		return this.#tools.get(grantId)?.has(tool) === true;
	}

	add(grantId: string, tool: string): void {
		const tools = this.#tools.get(grantId) ?? new Set();
		tools.add(tool);
		this.#tools.set(grantId, tools);
	}

	/** Forget every grant not in `grantIds`. */
	keepGrants(grantIds: Iterable<string>): void {
		const keep = new Set(grantIds);
		for (const grantId of this.#tools.keys()) {
			if (!keep.has(grantId)) this.#tools.delete(grantId);
		}
	}

	/** Forget every tool not in `names`. */
	keepTools(names: Iterable<string>): void {
		const keep = new Set(names);
		for (const tools of this.#tools.values()) {
			for (const tool of tools) if (!keep.has(tool)) tools.delete(tool);
		}
	}
}
