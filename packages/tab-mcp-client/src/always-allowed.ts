/**
 * The tools that run without asking, per AI app (grant), DEC-096 and
 * DEC-200: the ones the user allowed one by one, each with what the user
 * saw of it (title and description; a tool that changed since is asked
 * again and leaves the list), and "everything", which covers every tool of
 * the page, also ones the user has not seen.
 *
 * Kept in the page's `storage` under the secret's key with `#allowed`, so
 * that they outlive a reload; in memory with `alwaysAllow: "until-reload"`,
 * with `storage: null` and without a relay. Storage is read first on every
 * question, so that a change in another tab of the same address counts at
 * once (only one tab at a time holds the connection, DEC-095).
 *
 * An allowance ends with its grant, and only on what the relay says: the
 * grants of a new session, a removed grant, `disconnectAll()` (the relay
 * revoked them all). A dropped connection, or a page that has not connected
 * yet, keeps them: `grantschange` does not fire then. They also belong to
 * the address secret they were made under, so a new secret (`disconnectAll()`
 * here or in another tab) ends them even where nothing listened.
 *
 * Out of the core: the confirmation (`confirm.ts`, which the core loads for
 * every consequential call), the connect dialog and
 * `@ractive-ch/tab-mcp-client/allowed` import it.
 */

import type { ToolRegistry } from "./registry.ts";
import type { TabMcp } from "./tab-mcp.ts";
import type { ConfirmRequest, SecretStorage } from "./types.ts";

/** What the user saw of a tool: its name, title and description. */
type ToolSeen = ConfirmRequest["tool"];
/** A tool as the registry or a call names it. */
type ToolNow = {
	name: string;
	title?: string | undefined;
	description: string;
};

/** A tool that asks before it runs, for a page's switch. */
export interface AllowedTool {
	name: string;
	title?: string;
	description: string;
	/** Marked `destructiveHint`: it may delete or overwrite. */
	destructive: boolean;
}

/**
 * The tools that run without asking, per connected AI app (`Grant.grantId`),
 * for a page that draws its own switches: `allowedTools(mcp)` of
 * `@ractive-ch/tab-mcp-client/allowed`. The library's dialogs use the same.
 * The methods are bound: `const { allow } = allowedTools(mcp)` works. The
 * queries (`tools`, `list`, `has`, `everything`) only read: safe while
 * drawing.
 */
export interface AllowedTools {
	/**
	 * `true`: kept in the page's `storage` until the app is disconnected;
	 * `false`: in memory, until the page is reloaded or the app is
	 * disconnected (`alwaysAllow: "until-reload"`, `storage: null`).
	 */
	readonly kept: boolean;
	/**
	 * The page's tools that ask before they run (`consequentialHint`, callable
	 * by AI apps through the relay), in the order registered.
	 */
	tools(): AllowedTool[];
	/**
	 * The names of the tools allowed one by one for this app, in the order
	 * allowed; also one that is not registered right now (it runs without
	 * asking again once it is back unchanged). One registered now with another
	 * title or description than the user allowed is not in it (it asks).
	 */
	list(grantId: string): string[];
	/**
	 * Whether a call of this tool by this app runs without asking now: the
	 * app is in `mcp.grants`, and "everything" is on or the tool is allowed
	 * and registered unchanged.
	 */
	has(grantId: string, name: string): boolean;
	/**
	 * Allow one tool for this app from now on, as it is registered now (its
	 * title and description). Nothing happens for an app that is not in
	 * `mcp.grants` or a tool that is not in `tools()`.
	 */
	allow(grantId: string, name: string): void;
	/**
	 * Ask again before this app runs this tool. While "everything" is on for
	 * the app, that goes off too (asking again errs towards asking); the
	 * other tools allowed one by one stay allowed.
	 */
	ask(grantId: string, name: string): void;
	/** Whether "Allow everything, no questions asked" is on for this app. */
	everything(grantId: string): boolean;
	/**
	 * "Allow everything, no questions asked" for this app: every tool runs
	 * without asking, with any arguments, also tools registered later, changed
	 * ones and destructive ones. Turning it on does nothing for an app that
	 * is not in `mcp.grants`.
	 */
	setEverything(grantId: string, on: boolean): void;
	/** Ask again for everything of this app: its tools and "everything". */
	forget(grantId: string): void;
	/**
	 * Calls `listener` on every change of the allowances (also one in
	 * another tab of the same address) and of `tools()`; returns what stops it.
	 */
	onChange(listener: () => void): () => void;
}

/** One app's allowances. */
interface Entry {
	everything: boolean;
	/** In the order allowed; `title` and `description` as the user saw them. */
	tools: ToolSeen[];
}

/** What is kept: the grants' entries and the secret they belong to. */
interface State {
	/** {@link fingerprint} of the address secret. */
	secret: string;
	grants: Map<string, Entry>;
}

/**
 * A short fingerprint of the address secret (FNV-1a, 32 bits): enough to
 * tell that the secret changed, too short to say anything about it.
 */
function fingerprint(secret: string | undefined): string {
	if (secret === undefined) return "";
	let hash = 0x811c9dc5;
	for (let i = 0; i < secret.length; i++)
		hash = Math.imul(hash ^ secret.charCodeAt(i), 0x01000193) >>> 0;
	return hash.toString(16);
}

const isString = (v: unknown): v is string => typeof v === "string";

/**
 * The kept text as a state; anything that is not exactly what
 * {@link serialize} writes allows nothing.
 */
function parse(text: string): State {
	const none: State = { secret: "", grants: new Map() };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return none;
	}
	const v = value as { secret?: unknown; grants?: unknown } | null;
	if (!isString(v?.secret) || !Array.isArray(v.grants)) return none;
	const grants = new Map<string, Entry>();
	for (const g of v.grants as unknown[]) {
		const e = g as {
			grantId?: unknown;
			everything?: unknown;
			tools?: unknown;
		} | null;
		if (
			!isString(e?.grantId) ||
			typeof e.everything !== "boolean" ||
			!Array.isArray(e.tools)
		)
			return none;
		const tools: ToolSeen[] = [];
		for (const t of e.tools as unknown[]) {
			const tool = t as Partial<Record<keyof ToolSeen, unknown>> | null;
			if (
				!isString(tool?.name) ||
				!isString(tool.description) ||
				(tool.title !== undefined && !isString(tool.title))
			)
				return none;
			tools.push(seenOf(tool as ToolSeen));
		}
		grants.set(e.grantId, { everything: e.everything, tools });
	}
	return { secret: v.secret, grants };
}

/** Grant ids, tool names and what the user saw of each: no arguments, no results. */
function serialize(state: State): string {
	return JSON.stringify({
		secret: state.secret,
		grants: [...state.grants].map(([grantId, e]) => ({ grantId, ...e })),
	});
}

/** Only what the user saw, as plain strings. */
function seenOf(tool: ToolSeen): ToolSeen {
	const seen: ToolSeen = { name: tool.name, description: tool.description };
	if (tool.title !== undefined) seen.title = tool.title;
	return seen;
}

const sameSeen = (a: ToolSeen, b: ToolNow) =>
	a.title === b.title && a.description === b.description;

/**
 * Whether a tool allowed as `kept` still counts against what is registered
 * now (`now`, `undefined` when it is not): unchanged, or not registered. The
 * one rule for drawing (`list`) and for deciding (`has`).
 */
const counts = (kept: ToolSeen, now: ToolNow | undefined) =>
	now === undefined || sameSeen(kept, now);

/**
 * A caller's own stand-in for a `TabMcp` in the confirmation chunk's
 * `confirmInPage` (a desktop app with an MCP endpoint of its own, say): the
 * AI apps it allows for, and optionally `grantschange` events (with
 * `detail.grants`) when they change. Its allowances live in memory, for
 * those grants only, until the page is reloaded.
 */
export interface ConfirmHost {
	readonly grants: readonly { readonly grantId: string }[];
	addEventListener?(type: string, listener: (event: Event) => void): void;
}

/** What the allowances read of their host's tools. */
type ToolsOf = Pick<ToolRegistry, "list" | "get" | "onChange">;

/** A stand-in has no tools to list: a tool is allowed as its question showed it. */
const NO_TOOLS: ToolsOf = {
	list: () => [],
	get: () => undefined,
	onChange: () => () => {},
};

const isFunction = (v: unknown) => typeof v === "function";

/**
 * Whether `value` is what a `TabMcp`'s `_allowed` is: its registry (with
 * `register`), its secret store or none, its `alwaysAllow`. Anything else
 * (a stand-in that copied part of it, as some did for 0.18.0) is a stand-in.
 */
function isInternals(value: unknown): value is TabMcp["_allowed"] {
	if (!Array.isArray(value) || value.length !== 3) return false;
	const [registry, secrets, alwaysAllow] = value as unknown[];
	const r = registry as Partial<Record<string, unknown>> | null;
	const s = secrets as { current?: unknown } | null | undefined;
	return (
		["register", "list", "get", "onChange"].every((k) => isFunction(r?.[k])) &&
		(s === undefined || isFunction(s?.current)) &&
		[undefined, true, false, "until-reload"].includes(alwaysAllow as never)
	);
}

/** The host's tools, secret store and `alwaysAllow`: a `TabMcp`'s, or none for a stand-in. */
function internalsOf(
	host: TabMcp | ConfirmHost,
): TabMcp["_allowed"] | [ToolsOf, undefined, undefined] {
	const internals = (host as { _allowed?: unknown })._allowed;
	return isInternals(internals) ? internals : [NO_TOOLS, undefined, undefined];
}

/**
 * The allowances of one `TabMcp` (or a caller's stand-in, `ConfirmHost`).
 * The public methods are arrow fields, so that they work taken off the
 * object; the queries never write.
 */
export class Allowances implements AllowedTools {
	readonly kept: boolean;
	/** The library's dialogs offer allowing (`alwaysAllow` on). */
	readonly offered: boolean;
	readonly #mcp: TabMcp | ConfirmHost;
	readonly #registry: ToolsOf;
	readonly #secret: () => string;
	/** `null`: in memory only. */
	readonly #storage: SecretStorage | null;
	readonly #key: string;
	#memory: State = { secret: "", grants: new Map() };
	/**
	 * The last write to storage failed (quota, blocked): memory holds what the
	 * user chose, for the page's lifetime, and storage is not read over it
	 * until a write succeeds again.
	 */
	#unsaved = false;
	readonly #listeners = new Set<() => void>();
	#unwatch: (() => void) | undefined;

	constructor(mcp: TabMcp | ConfirmHost) {
		const [registry, secrets, alwaysAllow] = internalsOf(mcp);
		this.#mcp = mcp;
		this.#registry = registry;
		this.#secret = () => fingerprint(secrets?.current());
		this.#storage =
			alwaysAllow === "until-reload" ? null : (secrets?.storage ?? null);
		this.#key = `${secrets?.key}#allowed`;
		this.kept = this.#storage !== null;
		this.offered = alwaysAllow === true || alwaysAllow === "until-reload";
	}

	readonly tools = (): AllowedTool[] =>
		this.#registry
			.list()
			.filter(
				(t) =>
					t.annotations.consequentialHint === true &&
					(t.callers?.includes("relay") ?? true),
			)
			.map((t) => {
				const tool: AllowedTool = {
					name: t.name,
					description: t.description,
					destructive: t.annotations.destructiveHint === true,
				};
				if (t.title !== undefined) tool.title = t.title;
				return tool;
			});

	readonly list = (grantId: string): string[] =>
		(this.#read().get(grantId)?.tools ?? [])
			.filter((t) => counts(t, this.#registry.get(t.name)))
			.map((t) => t.name);

	readonly has = (grantId: string, name: string): boolean => {
		const tool = this.#registry.get(name);
		return (
			this.#granted(grantId) &&
			(this.everything(grantId) ||
				(tool !== undefined && this.allows(grantId, tool)))
		);
	};

	/**
	 * Whether this call runs without asking: "everything", or this tool as
	 * the user saw it. Only reads: a tool that changed since asks, and leaves
	 * the list when the registry or another tab's change is seen
	 * (`toolsChanged`).
	 */
	allows(grantId: string, tool: ToolNow): boolean {
		// Only for an app the host lists at this moment: a stand-in may drop
		// one from `grants` without an event, and for a `TabMcp` a call comes
		// only while the relay's list is current, so it costs nothing there.
		if (!this.#granted(grantId)) return false;
		const entry = this.#read().get(grantId);
		if (entry === undefined) return false;
		if (entry.everything) return true;
		const kept = entry.tools.find((t) => t.name === tool.name);
		return kept !== undefined && sameSeen(kept, tool);
	}

	readonly allow = (grantId: string, name: string): void => {
		const tool = this.tools().find((t) => t.name === name);
		if (tool !== undefined) this.keep(grantId, tool);
	};

	/** Allow `tool` as the user saw it, for an app the relay still lists. */
	keep(grantId: string, tool: ToolSeen): void {
		if (!this.#granted(grantId)) return;
		const grants = this.#read();
		const entry = grants.get(grantId) ?? { everything: false, tools: [] };
		entry.tools = [
			...entry.tools.filter((t) => t.name !== tool.name),
			seenOf(tool),
		];
		grants.set(grantId, entry);
		this.#write(grants);
	}

	readonly ask = (grantId: string, name: string): void => {
		const grants = this.#read();
		const entry = grants.get(grantId);
		if (entry === undefined) return;
		const tools = entry.tools.filter((t) => t.name !== name);
		// Under "everything" this tool ran without asking too: asking again
		// for it turns that off; the tools allowed one by one stay.
		if (!entry.everything && tools.length === entry.tools.length) return;
		entry.everything = false;
		entry.tools = tools;
		if (tools.length === 0) grants.delete(grantId);
		this.#write(grants);
	};

	readonly everything = (grantId: string): boolean =>
		this.#read().get(grantId)?.everything === true;

	readonly setEverything = (grantId: string, on: boolean): void => {
		if (on && !this.#granted(grantId)) return;
		const grants = this.#read();
		const entry = grants.get(grantId) ?? { everything: false, tools: [] };
		if (entry.everything === on) return;
		entry.everything = on;
		if (on || entry.tools.length > 0) grants.set(grantId, entry);
		else grants.delete(grantId);
		this.#write(grants);
	};

	readonly forget = (grantId: string): void => {
		const grants = this.#read();
		if (grants.delete(grantId)) this.#write(grants);
	};

	/**
	 * Only the grants the relay lists now: the others ended. What was kept
	 * under another secret is dropped from storage too (it allowed nothing
	 * already).
	 */
	keepGrants(grantIds: Iterable<string>): void {
		const keep = new Set(grantIds);
		const grants = this.#read();
		// Kept under another secret: nothing to write unless something was kept.
		let changed =
			this.#memory.grants !== grants && this.#memory.grants.size > 0;
		for (const grantId of [...grants.keys()])
			if (!keep.has(grantId)) changed = grants.delete(grantId) || changed;
		if (changed) this.#write(grants);
	}

	/**
	 * The registry changed, or another tab changed the allowances: a tool
	 * registered with another title or description than the user saw leaves
	 * every list. One that is not registered stays (a reload registers them
	 * all again, a page may offer some only on some views). Tells the
	 * listeners in any case.
	 */
	toolsChanged(): void {
		const grants = this.#read();
		let changed = false;
		for (const [grantId, entry] of [...grants]) {
			const tools = entry.tools.filter((t) =>
				counts(t, this.#registry.get(t.name)),
			);
			if (tools.length === entry.tools.length) continue;
			changed = true;
			entry.tools = tools;
			if (!entry.everything && tools.length === 0) grants.delete(grantId);
		}
		if (changed) this.#write(grants);
		else this.#changed();
	}

	readonly onChange = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		this.#watch();
		return () => {
			this.#listeners.delete(listener);
			if (this.#listeners.size === 0) {
				this.#unwatch?.();
				this.#unwatch = undefined;
			}
		};
	};

	/**
	 * Another tab changed them: clean up against this page's tools and tell
	 * the listeners (only while there are some).
	 */
	#watch(): void {
		if (this.#unwatch !== undefined || this.#storage === null) return;
		const g = globalThis as Partial<EventTarget>;
		const changed = (event: Event) => {
			if ((event as StorageEvent).key === this.#key) this.toolsChanged();
		};
		g.addEventListener?.("storage", changed);
		this.#unwatch = () => g.removeEventListener?.("storage", changed);
	}

	#granted(grantId: string): boolean {
		return this.#mcp.grants.some((g) => g.grantId === grantId);
	}

	/**
	 * The allowances now: storage first, so that another tab's change counts;
	 * memory where storage cannot be read or the last write to it failed.
	 * None once the secret changed.
	 */
	#read(): Map<string, Entry> {
		if (this.#storage !== null && !this.#unsaved) {
			try {
				const text = this.#storage.getItem(this.#key);
				if (text !== null) this.#memory = parse(text);
			} catch {
				// unreadable: what this page kept in memory
			}
		}
		return this.#memory.secret === this.#secret()
			? this.#memory.grants
			: new Map();
	}

	#write(grants: Map<string, Entry>): void {
		this.#memory = { secret: this.#secret(), grants };
		try {
			this.#storage?.setItem(this.#key, serialize(this.#memory));
			this.#unsaved = false;
		} catch {
			// quota or blocked: kept in memory for the page's lifetime
			this.#unsaved = true;
		}
		this.#changed();
	}

	#changed(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}

/** The allowances per `TabMcp` or stand-in. */
const allowances = new WeakMap<TabMcp | ConfirmHost, Allowances>();

/**
 * The allowances of `mcp`, made on first use. They follow its grants (only
 * when the relay names them, see above; a stand-in's `grantschange`) and
 * its tools.
 */
export function allowedFor(mcp: TabMcp | ConfirmHost): Allowances {
	const kept = allowances.get(mcp);
	if (kept !== undefined) return kept;
	const made = new Allowances(mcp);
	allowances.set(mcp, made);
	// Against the host's grants as they are now, whatever the event carries
	// (a stand-in may send a plain Event; a TabMcp's detail is its grants).
	mcp.addEventListener?.("grantschange", () =>
		made.keepGrants(mcp.grants.map((g) => g.grantId)),
	);
	internalsOf(mcp)[0].onChange(() => made.toolsChanged());
	made.toolsChanged(); // tools may have changed since the last page kept them
	// Made while connected: the grants are the relay's, the others ended.
	if ("session" in mcp && mcp.session !== undefined)
		made.keepGrants(mcp.grants.map((g) => g.grantId));
	return made;
}
