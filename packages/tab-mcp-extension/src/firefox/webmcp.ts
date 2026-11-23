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
 * What has to outlast this content script lives in the page (DEC-188): an
 * extension reload or update ends the script, and Firefox makes every
 * function it exported a dead object. The page's `modelContext` object, its
 * tools and its `on…` handlers are kept in a `Map` of the page's realm, and
 * the getters on the prototypes are the page's own `Map.prototype.get` bound
 * to it (a bound native function outlives the script). The page can reach
 * the map too, by calling the getter with its key: everything in it is the
 * page's own (its object, tools and handlers), which it can change anyway.
 * The next content script finds the map through the getter (`keptState`),
 * registers the tools again and puts its own methods and listeners on the
 * same object, so the page's references to it work on.
 *
 * Objects the page passes arrive as Xrays, which hide functions and getters:
 * a tool is read through `wrappedJSObject` and copied with this world's own
 * `JSON`. What goes back to the page is made in the page's realm (promises,
 * errors, events, arrays), or the page cannot use it.
 */

import { WEBMCP_EVENT } from "@ractive-ch/tab-mcp-client/extension";
import {
	copyJson,
	MAX_TOOLS,
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
/** Firefox: an object of the page seen through an Xray again. */
declare function XPCNativeWrapper<T>(value: T): T;
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
}

/** The events the page's object has `on…` handlers for. */
const EVENTS = ["toolchange", "toolactivated", "toolcancel"] as const;

/** A page's object as it is, past the Xray. */
const waive = (value: unknown): PageObject =>
	(value as PageObject)?.wrappedJSObject ?? value;

/** The state map's key for itself, and for the tools and the handlers. */
const STATE = "tab-mcp:webmcp";
const TOOLS = "tab-mcp:tools";
const HANDLER = "tab-mcp:on";
const LISTENER = "tab-mcp:listener:";

/**
 * The state an earlier content script of this extension left in the page
 * (`STATE`, through the getter it put on `Document.prototype`): the map and
 * the page's `modelContext` object, or `undefined`. A page that fakes it
 * gives only its own tools, which it can register anyway.
 */
function keptState(
	page: PageObject,
): { state: PageObject; context: PageObject } | undefined {
	try {
		const get = Reflect.getOwnPropertyDescriptor(
			page.Document.prototype,
			"modelContext",
		)?.get as ((key?: string) => PageObject) | undefined;
		if (typeof get !== "function") return undefined;
		const state = get(STATE);
		if (typeof state?.get !== "function" || state.get(STATE) !== state)
			return undefined;
		const context = state.get(undefined);
		return context !== null && typeof context === "object"
			? { state, context }
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Define `document.modelContext` (and `navigator.modelContext`, which older
 * pages use) in `win`'s page for its own scripts. `undefined` where Firefox
 * has WebMCP of its own (a native attribute is visible through the Xrays,
 * a page's getter is not), where the page set up its own already, in an
 * insecure context, or without the export helpers: `content.ts` then reads
 * `document.modelContext` as in Chrome. An earlier content script's state is
 * taken over, tools and all (`keptState`).
 */
export function installWebMCP(win: Window): ExtensionContext | undefined {
	if (!hasExportHelpers() || !win.isSecureContext) return undefined;
	if ("modelContext" in win.document) return undefined;
	const page = waive(win);
	// Injected after the page set up its own (a click on the icon, after the
	// load): the page's polyfill stays; the Xray above does not see it.
	const kept = keptState(page);
	if (
		kept === undefined &&
		("modelContext" in page.document || "modelContext" in page.navigator)
	)
		return undefined;
	// The page's realm: what the page gets is made from these.
	const pageWindow = win as PageObject;
	const PagePromise = pageWindow.Promise as PromiseConstructor;
	const PageEvent = pageWindow.Event as typeof Event;
	const PageDOMException = pageWindow.DOMException as typeof DOMException;
	const PageTypeError = pageWindow.TypeError as TypeErrorConstructor;
	const PageAbortController =
		pageWindow.AbortController as typeof AbortController;
	// The page's object (through an Xray, for `exportFunction`) and the map.
	const context: EventTarget = kept
		? XPCNativeWrapper(kept.context as EventTarget)
		: new (pageWindow.EventTarget as typeof EventTarget)();
	const pageContext = waive(context);
	const state: PageObject = kept?.state ?? new page.Map();
	const listeners = new Set<() => void>();
	/** The tools as the page's records, for the next content script. */
	const save = () => {
		const list = new page.Array();
		for (const record of tools.records()) {
			const kept = new page.Object();
			kept.tool = record.tool;
			kept.signal = record.signal ?? null;
			kept.provided = record.provided;
			list.push(kept);
		}
		state.set(TOOLS, list);
	};
	const tools = new ToolRegistry(() => {
		save();
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

	// `ontoolchange` and the others, kept in the map, called by one listener
	// per type for every event on the object, as WebIDL's handlers are (only
	// `toolchange` is dispatched here; a page or its polyfill may dispatch
	// the others). The listener is in the map too: the next content script
	// takes the dead one off.
	for (const type of EVENTS) {
		const dead = state.get(`${LISTENER}${type}`);
		if (typeof dead === "function") context.removeEventListener(type, dead);
		const listener = exportFunction((event: Event) => {
			const handler = state.get(`${HANDLER}${type}`);
			if (typeof handler !== "function") return;
			try {
				handler.call(pageContext, waive(event));
			} catch {
				// The page's handler threw: its own affair.
			}
		}, win);
		context.addEventListener(type, listener);
		state.set(`${LISTENER}${type}`, listener);
		Reflect.defineProperty(pageContext, `on${type}`, {
			get: exportFunction(() => state.get(`${HANDLER}${type}`) ?? null, win),
			set: exportFunction((value: unknown) => {
				const raw = waive(value);
				state.set(`${HANDLER}${type}`, typeof raw === "function" ? raw : null);
			}, win),
			configurable: true,
			enumerable: true,
		});
	}

	if (kept) {
		// The tools the page registered with the script that ended.
		try {
			const list = state.get(TOOLS);
			const records = [];
			for (let i = 0; i < Math.min(Number(list?.length ?? 0), MAX_TOOLS); i++) {
				const record = list[i];
				records.push({
					tool: record.tool,
					...(record.signal ? { signal: XPCNativeWrapper(record.signal) } : {}),
					provided: record.provided === true,
				});
			}
			tools.restore(records);
		} catch {
			// The page broke its own records: it registers again or has none.
		}
		save();
	} else {
		state.set(STATE, state);
		state.set(undefined, pageContext);
		// Accessors on the prototypes, as WebIDL attributes are: a page or
		// its polyfill can shadow them (`@mcp-b/global` does, and wraps this
		// object). The page's `Map.prototype.get` bound to the map, called
		// with no argument: `state.get(undefined)`, the object.
		const get = page.Map.prototype.get.bind(state);
		for (const proto of [page.Document.prototype, page.Navigator.prototype])
			Reflect.defineProperty(proto, "modelContext", {
				get,
				configurable: true,
				enumerable: true,
			});
		// A client library that looked for WebMCP before (installed late, at a
		// click on the icon) looks again (DEC-223). At `document_start` no page
		// script listens yet; a takeover tells nothing (the page had it).
		win.document.dispatchEvent(new PageEvent(WEBMCP_EVENT));
	}

	return {
		getTools: () => Promise.resolve(tools.list()),
		executeTool: (tool, input, options) =>
			run(tool.name, input, options?.signal),
		addEventListener: (_type, listener) => {
			listeners.add(listener);
		},
	};
}
