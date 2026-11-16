/**
 * WebMCP for Firefox (iteration 44): Firefox has no `document.modelContext`,
 * so the content script defines it for the page, from its own isolated world,
 * with Firefox's `exportFunction` and `cloneInto` ("Sharing objects with page
 * scripts"). It runs at `document_start`, before the page's scripts, so a page
 * that registers its tools wherever the API exists (Shopify's storefronts,
 * the MCP-B and W3C polyfills, Mintlify, GitBook, ReadMe) registers them here.
 *
 * There is no channel through the page: the page's calls run here, in the
 * content script, which keeps the tools (`webmcp/registry.ts`). The page sees
 * only that the API exists; it can register, list and call its own tools,
 * which is what the API is for. The content script gets an object of its own
 * (`ExtensionContext`) with what `content.ts` reads from Chrome's WebMCP.
 *
 * Objects the page passes arrive as Xrays, which hide functions and getters:
 * a tool is read through `wrappedJSObject` and copied with this world's own
 * `JSON`. What goes back to the page is made in the page's realm (promises,
 * errors, events, arrays), or the page cannot use it.
 */

import {
	copyJson,
	messageOf,
	PageError,
	type PageObject,
	resultText,
	type SignalLike,
	type ToolInfo,
	ToolRegistry,
} from "../webmcp/registry.ts";

export { MAX_TOOLS, resultText, type ToolInfo } from "../webmcp/registry.ts";

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

/** What `content.ts` uses of a `ModelContext`, here kept by the extension. */
export interface ExtensionContext {
	getTools(): Promise<ToolInfo[]>;
	executeTool(
		tool: { name: string },
		input: unknown,
		options?: { signal?: AbortSignal },
	): Promise<string | null>;
	addEventListener(type: "toolchange", listener: () => void): void;
	/**
	 * It replaced the dead `modelContext` of an earlier content script (an
	 * extension reload or update while the page was open): the tools the
	 * page registered before are gone.
	 */
	readonly revived: boolean;
}

/** The events the page's object has `on…` handlers for. */
const EVENTS = ["toolchange", "toolactivated", "toolcancel"] as const;

/** A page's object as it is, past the Xray. */
const waive = (value: unknown): PageObject =>
	(value as PageObject)?.wrappedJSObject ?? value;

/**
 * The page has a `modelContext` on `target` that works: not one left by an
 * earlier content script of this extension, whose getter Firefox made a
 * dead object when the extension was reloaded or updated (every read throws
 * "can't access dead object" in the page).
 */
function hasLiveContext(target: PageObject): boolean {
	if (!("modelContext" in target)) return false;
	try {
		void target.modelContext;
		return true;
	} catch {
		return false;
	}
}

/**
 * Define `document.modelContext` (and `navigator.modelContext`, which older
 * pages use) in `win`'s page for its own scripts. `undefined` where Firefox
 * has WebMCP of its own (a native attribute is visible through the Xrays,
 * a page's getter is not), where the page set up its own already, in an
 * insecure context, or without the export helpers: `content.ts` then reads
 * `document.modelContext` as in Chrome. The dead getters an extension reload
 * leaves are replaced: the page's tools from before are gone with the old
 * content script, but its reads stop throwing and new tools register.
 */
export function installWebMCP(win: Window): ExtensionContext | undefined {
	if (!hasExportHelpers() || !win.isSecureContext) return undefined;
	if ("modelContext" in win.document) return undefined;
	const page = waive(win);
	// Injected after the page set up its own (a click on the icon, after the
	// load): the page's polyfill stays; the Xray above does not see it.
	if (hasLiveContext(page.document) || hasLiveContext(page.navigator))
		return undefined;
	const revived =
		"modelContext" in page.document || "modelContext" in page.navigator;
	// The page's realm: what the page gets is made from these.
	const pageWindow = win as PageObject;
	const PagePromise = pageWindow.Promise as PromiseConstructor;
	const PageEvent = pageWindow.Event as typeof Event;
	const PageDOMException = pageWindow.DOMException as typeof DOMException;
	const PageTypeError = pageWindow.TypeError as TypeErrorConstructor;
	const PageAbortController =
		pageWindow.AbortController as typeof AbortController;
	const context: EventTarget = new (
		pageWindow.EventTarget as typeof EventTarget
	)();
	const listeners = new Set<() => void>();
	const tools = new ToolRegistry(() => {
		context.dispatchEvent(new PageEvent("toolchange"));
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				// One listener's failure is not the others'.
			}
		}
	});

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
		if ((error as PageObject)?.wrappedJSObject !== undefined) return error;
		return new PageDOMException(messageOf(error), "OperationError");
	};

	/**
	 * A promise of the page's realm settled by `work`, which runs at once (a
	 * promise's executor runs synchronously): a registration takes effect
	 * before the page's next call, in the order the page makes them.
	 */
	const pagePromise = <T>(work: () => T | Promise<T>): Promise<T> =>
		new PagePromise<T>(
			exportFunction(
				(resolve: (value: T) => void, reject: (reason: unknown) => void) => {
					try {
						Promise.resolve(work()).then(
							(value) => resolve(value),
							(error: unknown) => reject(toPage(error)),
						);
					} catch (error) {
						reject(toPage(error));
					}
				},
				win,
			),
		);

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
		const options = cloneInto({}, win) as PageObject;
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

	exportFunction(
		// A DOM object: the signal's Xray gives the native `aborted` and listeners.
		(tool: unknown, options?: unknown) =>
			pagePromise(() =>
				tools.register(
					waive(tool),
					(options as PageObject)?.signal as SignalLike | undefined,
				),
			),
		context,
		{ defineAs: "registerTool" },
	);
	exportFunction((name: unknown) => tools.unregister(String(name)), context, {
		defineAs: "unregisterTool",
	});
	exportFunction(
		() => pagePromise(() => cloneInto(tools.list(), win)),
		context,
		{ defineAs: "getTools" },
	);
	exportFunction(
		(tool: unknown, input: unknown, options?: unknown) =>
			pagePromise(() =>
				run(
					String(waive(tool)?.name ?? ""),
					copyJson(waive(input)),
					((options as PageObject)?.signal as AbortSignal | null) ?? undefined,
				),
			),
		context,
		{ defineAs: "executeTool" },
	);
	exportFunction(
		(value: unknown) => pagePromise(() => tools.provide(waive(value)?.tools)),
		context,
		{ defineAs: "provideContext" },
	);
	exportFunction(() => tools.clear(), context, { defineAs: "clearContext" });

	// `ontoolchange` and the others: one listener each, calling the handler set.
	const pageContext = waive(context);
	for (const type of EVENTS) {
		let handler: PageObject = null;
		context.addEventListener(type, (event) => {
			if (typeof handler === "function") {
				try {
					handler.call(pageContext, waive(event));
				} catch {
					// The page's handler threw: its own affair.
				}
			}
		});
		Reflect.defineProperty(pageContext, `on${type}`, {
			get: exportFunction(() => handler, win),
			set: exportFunction((value: unknown) => {
				const raw = waive(value);
				handler = typeof raw === "function" ? raw : null;
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
		getTools: () => Promise.resolve(tools.list()),
		executeTool: (tool, input, options) =>
			run(tool.name, input, options?.signal),
		addEventListener: (_type, listener) => {
			listeners.add(listener);
		},
		revived,
	};
}
