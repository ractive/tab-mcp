/**
 * WebMCP for Firefox (iteration 44): Firefox has no `document.modelContext`,
 * so the content script defines it for the page, from its own isolated world,
 * with Firefox's `exportFunction` and `cloneInto` ("Sharing objects with page
 * scripts"). It runs at `document_start`, before the page's scripts, so a page
 * that registers its tools wherever the API exists (Shopify's storefronts,
 * the MCP-B and W3C polyfills, Mintlify, GitBook, ReadMe) registers them here.
 *
 * There is no channel through the page: the page's calls run here, in the
 * content script, which keeps the tools. The page sees only that the API
 * exists; it can register, list and call its own tools, which is what the API
 * is for. The content script gets an object of its own (`ExtensionContext`)
 * with what `content.ts` reads from Chrome's native WebMCP.
 *
 * Objects the page passes arrive as Xrays, which hide functions and getters:
 * a tool is read through `wrappedJSObject` and copied with this world's own
 * `JSON`. What goes back to the page is made in the page's realm (promises,
 * errors, events, arrays), or the page cannot use it.
 */

/** Firefox's helpers in content scripts; not in Chrome. */
declare function exportFunction<F extends (...args: never[]) => unknown>(
	fn: F,
	target: object,
	options?: { defineAs?: string },
): F;
declare function cloneInto<T>(
	value: T,
	target: object,
	options?: { cloneFunctions?: boolean; wrapReflectors?: boolean },
): T;

/** Whether this world has Firefox's export helpers. */
export const hasExportHelpers = (): boolean =>
	typeof exportFunction === "function" && typeof cloneInto === "function";

/** A tool as the content script reads it (the shape of Chrome's `getTools()`). */
export interface ToolInfo {
	name: string;
	title?: string;
	description: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	annotations?: Record<string, unknown>;
}

/** What `content.ts` uses of a `ModelContext`, here kept by the content script. */
export interface ExtensionContext {
	getTools(): Promise<ToolInfo[]>;
	executeTool(
		tool: { name: string },
		input: unknown,
		options?: { signal?: AbortSignal },
	): Promise<string | null>;
	addEventListener(type: "toolchange", listener: () => void): void;
}

/** At most this many tools per page; more are refused. */
export const MAX_TOOLS = 1024;

/** The events the page's object has `on…` handlers for. */
const EVENTS = ["toolchange", "toolactivated", "toolcancel"] as const;

/** The page's view of an object it passed: anything, read through `wrappedJSObject`. */
// biome-ignore lint/suspicious/noExplicitAny: the page's objects have no types
type Waived = any;

interface Entry {
	info: ToolInfo;
	/** The page's tool object, waived, for `this` in `execute`. */
	tool: Waived;
	/** The page's `execute`, waived. */
	execute: Waived;
	/** Unregisters on its signal's abort; `undefined` without one. */
	stop?: () => void;
}

/** A copy made with this world's `JSON` (the page's getters and `toJSON` run). */
function copyJson(value: unknown): unknown {
	if (value === undefined) return undefined;
	const text = JSON.stringify(value);
	return text === undefined ? undefined : JSON.parse(text);
}

/** The text of an error from either world. */
function messageOf(error: unknown): string {
	try {
		const waived = (error as Waived)?.wrappedJSObject ?? error;
		if (waived && typeof waived.message === "string") return waived.message;
		return String(waived);
	} catch {
		return "the tool failed";
	}
}

/**
 * Define `document.modelContext` (and `navigator.modelContext`, which older
 * pages use) in `win`'s page for its own scripts. `undefined` where Firefox
 * has WebMCP of its own (a native attribute is visible through the Xrays,
 * a page's getter is not), in an insecure context, or without the export
 * helpers: `content.ts` then reads `document.modelContext` as in Chrome.
 */
export function installWebMCP(win: Window): ExtensionContext | undefined {
	if (!hasExportHelpers() || !win.isSecureContext) return undefined;
	if ("modelContext" in win.document) return undefined;
	const page = (win as Waived).wrappedJSObject as Waived;
	// The page's realm: what the page gets is made from these.
	const PagePromise = (win as Waived).Promise as PromiseConstructor;
	const PageEvent = (win as Waived).Event as typeof Event;
	const PageDOMException = (win as Waived).DOMException as typeof DOMException;
	const PageTypeError = (win as Waived).TypeError as TypeErrorConstructor;
	const PageAbortController = (win as Waived)
		.AbortController as typeof AbortController;
	const context: EventTarget = new (
		(win as Waived).EventTarget as typeof EventTarget
	)();

	const tools = new Map<string, Entry>();
	const listeners = new Set<() => void>();

	const pagePromise = <T>(work: () => T | Promise<T>): Promise<T> =>
		new PagePromise<T>(
			exportFunction(
				(resolve: (value: T) => void, reject: (reason: unknown) => void) => {
					Promise.resolve()
						.then(work)
						.then(
							(value) => resolve(value),
							(error: unknown) => reject(toPage(error)),
						);
				},
				win,
			),
		);
	/**
	 * An error the page can read, made in its realm (one made here reaches
	 * the page as "An exception was thrown"): a `PageError` as its kind, the
	 * page's own as it is, any other as an `OperationError`.
	 */
	const toPage = (error: unknown): unknown => {
		if (error instanceof PageError)
			return error.kind === "TypeError"
				? new PageTypeError(error.message)
				: new PageDOMException(error.message, error.kind);
		if ((error as Waived)?.wrappedJSObject !== undefined) return error;
		return new PageDOMException(messageOf(error), "OperationError");
	};

	const changed = () => {
		context.dispatchEvent(new PageEvent("toolchange"));
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				// One listener's failure is not the others'.
			}
		}
	};

	const unregister = (name: string) => {
		const entry = tools.get(name);
		if (entry === undefined) return false;
		tools.delete(name);
		entry.stop?.();
		changed();
		return true;
	};

	/** Read the page's tool into an entry, or throw a `PageError`. */
	const read = (tool: unknown): Entry => {
		const raw = (tool as Waived)?.wrappedJSObject ?? tool;
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
	};

	/** `registerTool(tool, { signal })` as in the draft of 2026-11-13. */
	const registerTool = (tool: unknown, options?: unknown) =>
		pagePromise(() => {
			const entry = read(tool);
			const name = entry.info.name;
			if (tools.has(name))
				throw new PageError(
					"InvalidStateError",
					`Duplicate tool name: ${name}`,
				);
			if (tools.size >= MAX_TOOLS)
				throw new PageError("QuotaExceededError", "too many tools");
			// A DOM object: its Xray gives the native `aborted` and listeners.
			const signal = (options as Waived)?.signal as AbortSignal | undefined;
			if (signal !== undefined && signal !== null) {
				if (typeof signal.aborted !== "boolean")
					throw new PageError("TypeError", "signal is not an AbortSignal");
				if (signal.aborted) return undefined;
				const onAbort = () => unregister(name);
				signal.addEventListener("abort", onAbort, { once: true });
				entry.stop = () => signal.removeEventListener("abort", onAbort);
			}
			tools.set(name, entry);
			changed();
			return undefined;
		});

	/** Run a tool: the page's `execute` with a copy of `input` and a signal. */
	const run = async (
		name: string,
		input: unknown,
		signal?: AbortSignal,
	): Promise<string | null> => {
		const entry = tools.get(name);
		if (entry === undefined) throw new Error(`no tool named ${name}`);
		signal?.throwIfAborted();
		const controller = new PageAbortController();
		const options = cloneInto({}, win) as Waived;
		options.wrappedJSObject.signal = controller.signal;
		const pageInput = cloneInto(input ?? {}, win);
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => {
				controller.abort();
				reject(new DOMException("The call was cancelled", "AbortError"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		try {
			const value: unknown = await Promise.race([
				Promise.resolve(entry.execute.call(entry.tool, pageInput, options)),
				aborted,
			]);
			return resultText(value);
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError")
				throw error;
			throw new Error(messageOf(error));
		} finally {
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	};

	const list = (): ToolInfo[] =>
		[...tools.values()].map((entry) => structuredClone(entry.info));

	exportFunction(registerTool, context, { defineAs: "registerTool" });
	exportFunction(
		(name: unknown) => {
			// The older API (and `@mcp-b/global` 2.x): by name.
			unregister(String(name));
		},
		context,
		{ defineAs: "unregisterTool" },
	);
	exportFunction(
		() => pagePromise(() => cloneInto(list(), win) as ToolInfo[]),
		context,
		{ defineAs: "getTools" },
	);
	exportFunction(
		(tool: unknown, input: unknown, options?: unknown) =>
			pagePromise(() => {
				const name = String(
					((tool as Waived)?.wrappedJSObject ?? tool)?.name ?? "",
				);
				const signal = (options as Waived)?.signal as AbortSignal | undefined;
				const waivedInput = (input as Waived)?.wrappedJSObject ?? input;
				return run(name, copyJson(waivedInput), signal ?? undefined);
			}),
		context,
		{ defineAs: "executeTool" },
	);
	// The older `provideContext({ tools })`: these tools instead of the last ones given so.
	let provided: string[] = [];
	const provideContext = (value: unknown) =>
		pagePromise(async () => {
			for (const name of provided) unregister(name);
			provided = [];
			const raw = (value as Waived)?.wrappedJSObject ?? value;
			const given = raw?.tools;
			const count = Number(given?.length ?? 0);
			for (let i = 0; i < Math.min(count, MAX_TOOLS); i++) {
				const entry = read(given[i]);
				if (tools.has(entry.info.name)) continue;
				tools.set(entry.info.name, entry);
				provided.push(entry.info.name);
			}
			changed();
			return undefined;
		});
	exportFunction(provideContext, context, { defineAs: "provideContext" });
	exportFunction(
		() => {
			for (const name of [...tools.keys()]) unregister(name);
			provided = [];
		},
		context,
		{ defineAs: "clearContext" },
	);
	// `ontoolchange` and the others: one listener each, calling the handler set.
	const pageContext = (context as Waived).wrappedJSObject;
	for (const type of EVENTS) {
		let handler: Waived = null;
		context.addEventListener(type, (event) => {
			if (typeof handler === "function") {
				try {
					handler.call(pageContext, (event as Waived).wrappedJSObject ?? event);
				} catch {
					// The page's handler threw: its own affair.
				}
			}
		});
		Reflect.defineProperty(pageContext, `on${type}`, {
			get: exportFunction(() => handler, win),
			set: exportFunction((value: unknown) => {
				const waived = (value as Waived)?.wrappedJSObject ?? value;
				handler = typeof waived === "function" ? waived : null;
			}, win),
			configurable: true,
			enumerable: true,
		});
	}

	// Accessors on the prototypes, as WebIDL attributes are: a page or its
	// polyfill can shadow them (`@mcp-b/global` does, and wraps this object).
	for (const proto of [page.Document.prototype, page.Navigator.prototype])
		Reflect.defineProperty(proto, "modelContext", {
			get: exportFunction(() => context, win),
			configurable: true,
			enumerable: true,
		});

	return {
		getTools: () => Promise.resolve(list()),
		executeTool: (tool, input, options) =>
			run(tool.name, input, options?.signal),
		addEventListener: (_type, listener) => {
			listeners.add(listener);
		},
	};
}

/**
 * An error for the page: `kind` is `TypeError` or a `DOMException` name.
 * `installWebMCP` makes the page's own error from it.
 */
class PageError extends Error {
	readonly kind: string;

	constructor(kind: string, message: string) {
		super(message);
		this.kind = kind;
	}
}

/**
 * The string Chrome's `executeTool()` gives for a tool's result: a string as
 * it is, nothing as `null`, anything else as its JSON.
 */
export function resultText(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	const waived = (value as Waived)?.wrappedJSObject ?? value;
	const text = JSON.stringify(waived);
	return text === undefined ? null : text;
}
