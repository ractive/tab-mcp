/**
 * The tools a user chose "Allow until reload" for, per AI app (grant), kept
 * in memory for the page's lifetime. An entry goes when its grant goes, when
 * the user resets it in the connect dialog, or when its tool is gone. A tool
 * registered again as it was (React's `useTool` does that on a remount) keeps
 * it; one whose title or description changed, what the user saw when
 * allowing it, is asked again.
 */

import type { TabMcp } from "./tab-mcp.ts";
import type { ConfirmRequest } from "./types.ts";

type ToolSeen = ConfirmRequest["tool"];

/** What the user saw of a tool when allowing it. */
const seen = (tool: ToolSeen) => JSON.stringify([tool.title, tool.description]);

export class AlwaysAllowed {
	/** Per grant: the tools by name, with what the user saw of each. */
	readonly #tools = new Map<string, Map<string, string>>();
	readonly #listeners = new Set<() => void>();

	has(grantId: string, tool: ToolSeen): boolean {
		const tools = this.#tools.get(grantId);
		const allowed = tools?.get(tool.name);
		if (allowed === undefined || allowed === seen(tool)) {
			return allowed !== undefined;
		}
		// The tool changed since: asked again, and no longer listed.
		tools?.delete(tool.name);
		this.#changed();
		return false;
	}

	add(grantId: string, tool: ToolSeen): void {
		const tools = this.#tools.get(grantId) ?? new Map<string, string>();
		tools.set(tool.name, seen(tool));
		this.#tools.set(grantId, tools);
		this.#changed();
	}

	/** The names of the tools allowed for a grant, in the order allowed. */
	list(grantId: string): string[] {
		return [...(this.#tools.get(grantId)?.keys() ?? [])];
	}

	/** Ask again for every tool of a grant. */
	forget(grantId: string): void {
		if (this.#tools.delete(grantId)) this.#changed();
	}

	/** Forget every grant not in `grantIds`. */
	keepGrants(grantIds: Iterable<string>): void {
		const keep = new Set(grantIds);
		for (const grantId of this.#tools.keys())
			if (!keep.has(grantId)) this.forget(grantId);
	}

	/** Forget every tool not in `names`. */
	keepTools(names: Iterable<string>): void {
		const keep = new Set(names);
		let changed = false;
		for (const tools of this.#tools.values()) {
			for (const tool of tools.keys()) {
				if (keep.has(tool)) continue;
				tools.delete(tool);
				changed = true;
			}
		}
		if (changed) this.#changed();
	}

	/** Calls `listener` on every change; returns what stops it. */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#changed(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}

/** The tools allowed until reload, per `TabMcp`. */
const allowed = new WeakMap<TabMcp, AlwaysAllowed>();

/**
 * The tools allowed until reload of `mcp`, made on first use. Its grants
 * and tools are followed: a tool's absence counts only after the current
 * task, so that one unregistered and registered again at once (React) keeps
 * its entries.
 */
export function allowedFor(mcp: TabMcp): AlwaysAllowed {
	const kept = allowed.get(mcp);
	if (kept !== undefined) return kept;
	const made = new AlwaysAllowed();
	mcp.addEventListener("grantschange", (e) =>
		made.keepGrants(e.detail.grants.map((g) => g.grantId)),
	);
	let tools: readonly string[] | undefined;
	mcp.addEventListener("toolschange", (e) => {
		if (tools === undefined)
			queueMicrotask(() => {
				if (tools !== undefined) made.keepTools(tools);
				tools = undefined;
			});
		tools = e.detail.tools;
	});
	allowed.set(mcp, made);
	return made;
}
