/**
 * The page's WebMCP tools where the browser has no WebMCP of its own
 * (iteration 44): what the polyfill keeps, by the draft's rules (2026-11-13),
 * whichever world it runs in. Firefox keeps them in the content script
 * (`firefox/webmcp.ts`), Chrome without WebMCP in a script of the page's own
 * world (`chrome/webmcp-main.ts`). Nothing here touches the page's realm:
 * the callers make what the page gets (promises, errors, events) and pass
 * the page's objects in as they can read them.
 */

/** A tool as `getTools()` gives it (Chrome's shape, without `window`). */
export interface ToolInfo {
	name: string;
	title?: string;
	description: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	annotations?: Record<string, unknown>;
}

/** At most this many tools per page; more are refused. */
export const MAX_TOOLS = 1024;

/** A page's object, read as it is (Firefox: through `wrappedJSObject`). */
// biome-ignore lint/suspicious/noExplicitAny: the page's objects have no types
export type PageObject = any;

/** A tool as kept: what is listed, and the page's own object to run. */
export interface Entry {
	info: ToolInfo;
	/** The page's tool object, for `this` in `execute`. */
	tool: PageObject;
	/** The page's `execute`. */
	execute: PageObject;
	/** The registration's signal, if it had one. */
	signal?: SignalLike;
	/** Stops listening to its signal; `undefined` without one. */
	stop?: () => void;
}

/** A tool as `records` gives it and `restore` takes it back. */
export interface ToolRecord {
	tool: PageObject;
	signal?: SignalLike;
	/** Given with `provideContext`, not `registerTool`. */
	provided: boolean;
}

/** The part of an `AbortSignal` a registration uses. */
export interface SignalLike {
	readonly aborted: boolean;
	addEventListener(type: "abort", listener: () => void, options?: object): void;
	removeEventListener(type: "abort", listener: () => void): void;
}

/**
 * An error for the page: `kind` is `TypeError` or a `DOMException` name. The
 * caller makes the page's own error of that kind.
 */
export class PageError extends Error {
	readonly kind: string;

	constructor(kind: string, message: string) {
		super(message);
		this.kind = kind;
	}
}

/** A copy made with this world's `JSON` (the page's getters and `toJSON` run). */
export function copyJson(value: unknown): unknown {
	if (value === undefined) return undefined;
	const text = JSON.stringify(value);
	return text === undefined ? undefined : JSON.parse(text);
}

/** The text of an error from either world. */
export function messageOf(error: unknown): string {
	try {
		const raw = (error as PageObject)?.wrappedJSObject ?? error;
		if (raw && typeof raw.message === "string") return raw.message;
		return String(raw);
	} catch {
		return "the tool failed";
	}
}

/**
 * The string Chrome's `executeTool()` gives for a tool's result: a string as
 * it is, nothing as `null`, anything else as its JSON.
 */
export function resultText(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	const raw = (value as PageObject)?.wrappedJSObject ?? value;
	const text = JSON.stringify(raw);
	return text === undefined ? null : text;
}

/** Read the page's tool `raw` into an entry, or throw a `PageError`. */
export function readTool(raw: PageObject): Entry {
	if (raw === null || typeof raw !== "object")
		throw new PageError("TypeError", "a tool must be an object");
	const name = raw.name;
	if (typeof name !== "string" || name === "")
		throw new PageError("TypeError", "a tool needs a name");
	const execute = raw.execute;
	if (typeof execute !== "function")
		throw new PageError("TypeError", `the tool ${name} has no execute`);
	const info: ToolInfo = {
		name,
		description: raw.description === undefined ? "" : String(raw.description),
	};
	if (raw.title !== undefined) info.title = String(raw.title);
	try {
		const inputSchema = copyJson(raw.inputSchema);
		if (inputSchema !== undefined) info.inputSchema = inputSchema;
		const outputSchema = copyJson(raw.outputSchema);
		if (outputSchema !== undefined) info.outputSchema = outputSchema;
		const annotations = copyJson(raw.annotations);
		if (annotations !== null && typeof annotations === "object")
			info.annotations = annotations as Record<string, unknown>;
	} catch (error) {
		throw new PageError(
			"TypeError",
			`the tool ${name} has a schema that is no JSON: ${messageOf(error)}`,
		);
	}
	return { info, tool: raw, execute };
}

/**
 * The page's tools. Every change takes effect at once, in the order the page
 * makes its calls, and is told once through `changed`.
 */
export class ToolRegistry {
	readonly #tools = new Map<string, Entry>();
	readonly #changed: () => void;
	/** The names the last `provide` gave (the older `provideContext`). */
	#provided: string[] = [];
	/** While `restore` runs: no `changed`. */
	#quiet = false;

	constructor(changed: () => void) {
		this.#changed = changed;
	}

	/** `registerTool(tool, { signal })`: throws a `PageError`. */
	register(raw: PageObject, signal?: SignalLike | null): void {
		const entry = readTool(raw);
		const name = entry.info.name;
		if (this.#tools.has(name))
			throw new PageError("InvalidStateError", `Duplicate tool name: ${name}`);
		if (this.#tools.size >= MAX_TOOLS)
			throw new PageError("QuotaExceededError", "too many tools");
		if (signal !== undefined && signal !== null) {
			if (typeof signal.aborted !== "boolean")
				throw new PageError("TypeError", "signal is not an AbortSignal");
			// Aborted already: nothing to register (the draft).
			if (signal.aborted) return;
			const onAbort = () => this.unregister(name);
			signal.addEventListener("abort", onAbort, { once: true });
			entry.signal = signal;
			entry.stop = () => signal.removeEventListener("abort", onAbort);
		}
		this.#tools.set(name, entry);
		this.#notify();
	}

	/** The older `unregisterTool(name)`, and a registration's signal. */
	unregister(name: string): void {
		if (this.#remove(name)) this.#notify();
	}

	/**
	 * The older `provideContext({ tools })`: these tools instead of the last
	 * ones given so. All are read and checked first, so an invalid tool
	 * changes nothing; at most `MAX_TOOLS` entries are read (a made-up
	 * `length`), and the limit holds over all the page's tools.
	 */
	provide(given: PageObject): void {
		const count = Number(given?.length ?? 0);
		const fresh = new Map<string, Entry>();
		for (let i = 0; i < Math.min(count, MAX_TOOLS); i++) {
			const entry = readTool(given[i]);
			const name = entry.info.name;
			// A name registered with registerTool keeps its tool.
			if (this.#tools.has(name) && !this.#provided.includes(name)) continue;
			if (!fresh.has(name)) fresh.set(name, entry);
		}
		const kept =
			this.#tools.size -
			this.#provided.filter((n) => this.#tools.has(n)).length;
		if (kept + fresh.size > MAX_TOOLS)
			throw new PageError("QuotaExceededError", "too many tools");
		for (const name of this.#provided) this.#remove(name);
		this.#provided = [...fresh.keys()];
		for (const [name, entry] of fresh) this.#tools.set(name, entry);
		this.#notify();
	}

	/** The older `clearContext()`: every tool goes. */
	clear(): void {
		const any = this.#tools.size > 0;
		for (const name of [...this.#tools.keys()]) this.#remove(name);
		this.#provided = [];
		if (any) this.#notify();
	}

	/** The tools in their order, with what `restore` needs to register them again. */
	records(): ToolRecord[] {
		return [...this.#tools.values()].map((entry) => ({
			tool: entry.tool,
			...(entry.signal ? { signal: entry.signal } : {}),
			provided: this.#provided.includes(entry.info.name),
		}));
	}

	/**
	 * Register `records` again, in their order (a registry taking over the
	 * tools of one that ended), without `changed`: the page's tools did not
	 * change. A tool that no longer reads as one is left out.
	 */
	restore(records: readonly ToolRecord[]): void {
		this.#quiet = true;
		try {
			const provided: PageObject[] = [];
			for (const record of records) {
				if (record.provided) {
					provided.push(record.tool);
					continue;
				}
				try {
					this.register(record.tool, record.signal);
				} catch {
					// Changed meanwhile so that it is no tool: left out.
				}
			}
			if (provided.length > 0) {
				try {
					this.provide(provided);
				} catch {
					// As above.
				}
			}
		} finally {
			this.#quiet = false;
		}
	}

	get(name: string): Entry | undefined {
		return this.#tools.get(name);
	}

	/** Copies of the tools' descriptions, in the order they came. */
	list(): ToolInfo[] {
		return [...this.#tools.values()].map(
			(entry) => copyJson(entry.info) as ToolInfo,
		);
	}

	#notify(): void {
		if (!this.#quiet) this.#changed();
	}

	#remove(name: string): boolean {
		const entry = this.#tools.get(name);
		if (entry === undefined) return false;
		this.#tools.delete(name);
		entry.stop?.();
		return true;
	}
}
