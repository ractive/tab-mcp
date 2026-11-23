/**
 * The content script, in the extension's isolated world of the tab's top
 * frame: injected at a click on the icon, or registered for every page with
 * host access. It answers the service worker (where the connection lives,
 * DEC-116) about the page and its WebMCP tools and calls them. In this world `document.modelContext` is the browser's own,
 * whatever the page put on its own `document` (iteration 18). Firefox has
 * none: there this script defines one for the page and keeps its tools
 * (`firefox/webmcp.ts`, iteration 44). With a page whose client library
 * mirrors its tools into WebMCP it shakes hands (`page-handshake.ts`, DEC-207).
 * Where the page had no WebMCP when the worker read it, the worker gives it
 * the extension's own late, while AI access is on (`webmcp-install`, DEC-223).
 */

import { PANEL } from "./browser.ts";
import { canonicalJson } from "./canonical.ts";
import { connectPolyfill } from "./chrome/webmcp-port.ts";
import { installWebMCP } from "./firefox/webmcp.ts";
import type {
	CallResult,
	ContentEvent,
	ContentRequest,
	ContentResponse,
	ExtensionState,
	PageHistory,
	PageInfo,
	PageLibrary,
	PageTool,
	PageTools,
} from "./messages.ts";
import { PageHandshake } from "./page-handshake.ts";

/** The part of WebMCP the content script uses. */
interface ModelContext extends EventTarget {
	getTools(): Promise<RegisteredTool[]>;
	executeTool(
		tool: RegisteredTool,
		input: unknown,
		options?: { signal?: AbortSignal },
	): Promise<string | null>;
}

interface RegisteredTool {
	name: string;
	title?: string;
	description: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	annotations?: Record<string, unknown>;
}

/**
 * This page's id: a content script runs once per document, so a call that
 * carries another id was listed from another page (the tab navigated since).
 */
export const DOCUMENT_ID: string = crypto.randomUUID();

/** At most this many tools are sent, names and descriptions cut to these lengths. */
const SEND_TOOLS = 256;
const SEND_NAME = 256;
const SEND_TEXT = 4000;
const SEND_SCHEMA_BYTES = 16 * 1024;
/** The page's title and language are cut to these lengths. */
export const MAX_PAGE_TITLE = 300;
export const MAX_LANGUAGE = 64;
/**
 * A tool's result longer than this (characters) is not passed on: the relay
 * carries 1 MiB per response by default, and the bridge cuts a result's text
 * to 100 000 characters anyway. Chrome's own limit for a message is 64 MiB.
 */
export const MAX_SEND_RESULT = 2 * 1024 * 1024;

const cutText = (text: string, max: number) =>
	text.length > max ? text.slice(0, max) : text;

/** `true` in the Firefox build (`scripts/build.ts`, a `define`). */
declare const TAB_MCP_FIREFOX: boolean | undefined;

/**
 * The extension's stand-in for the browser's own WebMCP, where there is none:
 * in Firefox the content script's side of the `document.modelContext` it
 * defines (`firefox/webmcp.ts`), in Chrome without WebMCP the port to the
 * page-world polyfill (`chrome/webmcp-port.ts`). The browser's own wins.
 */
let ownContext: ModelContext | undefined;

/**
 * `ownContext` came late, on the worker's `webmcp-install` (DEC-223): after
 * the page's scripts had looked for WebMCP.
 */
let late = false;

/**
 * Give the page the extension's own WebMCP now (`webmcp-install`); set by
 * the script's start below.
 */
let installLate: () => void = () => {};

/**
 * How long the content script waits for Chrome's polyfill, put in late, to
 * answer before it has the page read again anyway: where the polyfill
 * stepped aside (the page's own, an insecure page) it never answers.
 */
export const LATE_WAIT_MS = 1_000;

/** The handshake with a page that has the client library (DEC-207). */
let handshake: PageHandshake | undefined;

const contextOf = (doc: Document) =>
	(doc as Document & { modelContext?: ModelContext }).modelContext ??
	(ownContext !== undefined && doc === globalThis.document
		? ownContext
		: undefined);

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/**
 * `page_info`'s word on a page without WebMCP in Firefox: tab-mcp gives a
 * page its WebMCP as it loads (`firefox/webmcp.ts`).
 */
export const FIREFOX_NO_WEBMCP_NOTE =
	"tab-mcp gives a page its WebMCP as the page starts loading (with access to all sites) or, while AI access is on, when the user clicks its icon on the page. Only https pages (and localhost) get it, and not a page that brought its own.";

/**
 * `page_info`'s word on a page that got the extension's WebMCP late and
 * registered no tools (DEC-223).
 */
export const LATE_WEBMCP_NOTE = `tab-mcp gave this page WebMCP after it had loaded, and it registered no tools: a page that looks for WebMCP only while it loads needs the user to click "Give access to all sites" in the ${PANEL} and reload it.`;

/**
 * A read of the page's tools is shared for this long after it started
 * (DEC-177): after a load the worker asks several times within some 300 ms
 * (the load, the content script's first `webmcp-changed`, the panel after
 * each), and each `getTools()` pending while the tab navigates is a moment
 * in which Chrome's browser process can crash (Chromium issue 585631961).
 */
export const SHARE_READ_MS = 1_000;

/**
 * The page's `getTools()`, called as rarely as the answers allow: a read
 * that started less than `SHARE_READ_MS` ago is shared, in flight or done,
 * unless the page fired `toolchange` since (then the next read is a new
 * one). A call to a tool (`fresh`) shares only a read still in flight.
 */
export class ToolReads {
	readonly #context: ModelContext;
	readonly #now: () => number;
	#read: Promise<RegisteredTool[]> | undefined;
	#startedAt = 0;
	#pending = false;

	/** `now`: a monotonic clock (milliseconds); the wall clock can step back. */
	constructor(
		context: ModelContext,
		now: () => number = () => performance.now(),
	) {
		this.#context = context;
		this.#now = now;
		// Optional: a page's own stand-in (a test's) may not be an EventTarget.
		context.addEventListener?.("toolchange", () => {
			this.#read = undefined;
		});
	}

	get(options: { fresh?: boolean } = {}): Promise<RegisteredTool[]> {
		const read = this.#read;
		if (
			read !== undefined &&
			this.#now() - this.#startedAt < SHARE_READ_MS &&
			(this.#pending || !options.fresh)
		)
			return read;
		const started = this.#context.getTools();
		this.#read = started;
		this.#startedAt = this.#now();
		this.#pending = true;
		const settled = () => {
			if (this.#read === started) this.#pending = false;
		};
		started.then(settled, settled);
		return started;
	}
}

const reads = new WeakMap<ModelContext, ToolReads>();

/** The shared reads of `context`'s tools. */
function readsOf(context: ModelContext): ToolReads {
	let found = reads.get(context);
	if (found === undefined) {
		found = new ToolReads(context);
		reads.set(context, found);
	}
	return found;
}

/** `context` is the extension's own WebMCP, given late (DEC-223). */
const isLate = (context: ModelContext) => late && context === ownContext;

export async function pageInfo(doc: Document = document): Promise<PageInfo> {
	const context = contextOf(doc);
	const webmcp: PageInfo["webmcp"] = {
		available: context !== undefined,
		tools: 0,
	};
	if (
		context === undefined &&
		typeof TAB_MCP_FIREFOX !== "undefined" &&
		TAB_MCP_FIREFOX
	)
		webmcp.note = FIREFOX_NO_WEBMCP_NOTE;
	if (context !== undefined) {
		try {
			webmcp.tools = (await readsOf(context).get()).length;
		} catch (error) {
			webmcp.error = message(error);
		}
		if (isLate(context)) {
			webmcp.late = true;
			if (webmcp.tools === 0 && webmcp.error === undefined)
				webmcp.note = LATE_WEBMCP_NOTE;
		}
	}
	const language = cutText(doc.documentElement.lang.trim(), MAX_LANGUAGE);
	return {
		url: doc.location.href,
		title: cutText(doc.title, MAX_PAGE_TITLE),
		...(language ? { language } : {}),
		webmcp,
	};
}

/** The part of the Navigation API `pageHistory` reads. */
interface NavigationLike {
	currentEntry: { index: number } | null;
	entries(): { index: number; url: string | null }[];
}

/** A history entry's address is sent only up to this length (else hidden). */
const SEND_URL = 8192;

/**
 * The tab's history as the page sees it. The Navigation API lists only the
 * entries of the page's own origin, so a `back` or `forward` here is on the
 * page's origin; one of another origin is not listed at all.
 */
export function pageHistory(win: Window = window): PageHistory {
	const length = win.history.length;
	const navigation = (win as Window & { navigation?: NavigationLike })
		.navigation;
	const index = navigation?.currentEntry?.index;
	if (navigation === undefined || index === undefined) return { length };
	const entries = navigation.entries();
	const at = (i: number) => {
		const entry = entries.find((e) => e.index === i);
		if (entry === undefined) return undefined;
		const url =
			typeof entry.url === "string" && entry.url.length <= SEND_URL
				? entry.url
				: null;
		return { url };
	};
	const back = at(index - 1);
	const forward = at(index + 1);
	return {
		length,
		...(back ? { back } : {}),
		...(forward ? { forward } : {}),
	};
}

const hint = (annotations: Record<string, unknown> | undefined, key: string) =>
	annotations?.[key] === true;

/**
 * The page's tools, as plain data; capped, so a page cannot make the message
 * (or the bridge's list) big. Tools a tab-mcp page mirrors into WebMCP are
 * among them: the extension cannot know whether the AI app is paired with
 * the page itself (WM 1, DEC-140).
 */
export async function pageTools(
	doc: Document = document,
	documentId: string = DOCUMENT_ID,
	library: PageLibrary | undefined = handshake?.library,
): Promise<PageTools> {
	const context = contextOf(doc);
	const base = {
		url: doc.location.href,
		origin: doc.location.origin,
		documentId,
		available: context !== undefined,
		...(context !== undefined && isLate(context)
			? { late: true as const }
			: {}),
		more: 0,
		...(library !== undefined ? { library } : {}),
	};
	if (context === undefined) return { ...base, tools: [] };
	let listed: RegisteredTool[];
	try {
		listed = await readsOf(context).get();
	} catch (error) {
		return { ...base, tools: [], error: message(error) };
	}
	const tools: PageTool[] = [];
	let more = 0;
	for (const tool of listed) {
		if (tools.length >= SEND_TOOLS) {
			more++;
			continue;
		}
		tools.push(offeredTool(tool));
	}
	return { ...base, tools, more };
}

/** A page's tool as the content script sends it: capped, as plain data. */
function offeredTool(tool: RegisteredTool): PageTool {
	const annotations = tool.annotations;
	/** Whether `schema` fits in a message (as JSON). */
	const fits = (schema: unknown) =>
		(JSON.stringify(schema) ?? "").length <= SEND_SCHEMA_BYTES;
	let schema: { inputSchema?: unknown; schemaTooBig?: true } = {};
	if (tool.inputSchema !== undefined)
		schema = fits(tool.inputSchema)
			? { inputSchema: tool.inputSchema }
			: { schemaTooBig: true };
	return {
		name: cutText(String(tool.name), SEND_NAME),
		...(typeof tool.title === "string" && tool.title !== ""
			? { title: cutText(tool.title, SEND_TEXT) }
			: {}),
		description: cutText(String(tool.description ?? ""), SEND_TEXT),
		...schema,
		// The draft's (WM 3); left out when too big, as it is only shown.
		...(tool.outputSchema !== undefined && fits(tool.outputSchema)
			? { outputSchema: tool.outputSchema }
			: {}),
		annotations: {
			readOnlyHint: hint(annotations, "readOnlyHint"),
			debugging: hint(annotations, "debugging"),
			// Only as the page gave it: Chrome fills in all four hints of a
			// tool with annotations and lists none without, so a tool
			// without it is one nothing is known about (DEC-214).
			...(typeof annotations?.["consequentialHint"] === "boolean"
				? { consequentialHint: annotations["consequentialHint"] }
				: {}),
		},
	};
}

/**
 * What identifies a tool as offered (DEC-217): its `PageTool` as
 * `canonicalJson`, which the worker sends with each call
 * (`CallTarget.definition`).
 */
export const definitionOf = (tool: PageTool): string => canonicalJson(tool);

/** Calls still running, by call id, to cancel them. */
const running = new Map<string, AbortController>();

/**
 * Run the page's tool `name`, if it is still what was offered: listed from
 * this very page (`documentId`) with the same read-only claim, and, read
 * again now, the same definition (`definition`, DEC-217: the user's answer
 * was about that one; a page that registered it again meanwhile, faster
 * than the worker read its list, does not get the changed tool run).
 * Otherwise "gone": a tool must never run on another page than the one it
 * was offered for, nor without the confirmation its first claim would have
 * needed.
 * `vouch`, for a call the user allowed: `send` runs right before the tool,
 * once every check passed, so that a page with the client library does not
 * ask again (DEC-207); `withdraw` once the call settled, whatever the
 * outcome, so that a vouch the call did not use (it failed or was cancelled
 * before it reached the page) is not left for another caller.
 */
export async function callTool(
	call: {
		documentId: string;
		name: string;
		readOnly: boolean;
		definition: string;
	},
	input: unknown,
	signal: AbortSignal,
	doc: Document = document,
	documentId: string = DOCUMENT_ID,
	vouch?: { send(input: unknown): void; withdraw(): void },
): Promise<CallResult> {
	const { name } = call;
	if (call.documentId !== documentId)
		return {
			ok: false,
			error: "The page in the tab changed since its tools were listed.",
			gone: true,
		};
	const context = contextOf(doc);
	if (context === undefined)
		return { ok: false, error: "WebMCP is not on in this page.", gone: true };
	// Not a list read earlier: only one still in flight is as new as this call.
	const tool = (await readsOf(context).get({ fresh: true })).find(
		(t) => t.name === name,
	);
	if (tool === undefined)
		return {
			ok: false,
			error: `The page has no tool ${name} (any more).`,
			gone: true,
		};
	if (hint(tool.annotations, "readOnlyHint") !== call.readOnly)
		return {
			ok: false,
			error: `The page changed what tool ${name} does since it was listed.`,
			gone: true,
		};
	if (definitionOf(offeredTool(tool)) !== call.definition)
		return {
			ok: false,
			error: `The page's tool ${name} changed since it was offered; it did not run.`,
			gone: true,
		};
	let value: string | null;
	const args = input ?? {};
	try {
		vouch?.send(args);
		value = await context.executeTool(tool, args, { signal });
	} catch (error) {
		return { ok: false, error: message(error) };
	} finally {
		vouch?.withdraw();
	}
	if (typeof value === "string" && value.length > MAX_SEND_RESULT)
		return {
			ok: false,
			error: `It returned ${value.length} characters; the tab-mcp browser extension passes on at most ${MAX_SEND_RESULT}.`,
		};
	return { ok: true, value };
}

async function answer(request: ContentRequest): Promise<ContentResponse> {
	switch (request.type) {
		case "page-info":
			return { ok: true, ...(await pageInfo()) };
		case "webmcp-list":
			return { ok: true, ...(await pageTools()) };
		case "webmcp-call": {
			const controller = new AbortController();
			running.set(request.callId, controller);
			const { vouch } = request;
			try {
				return await callTool(
					request,
					request.input,
					controller.signal,
					document,
					DOCUMENT_ID,
					vouch === undefined
						? undefined
						: {
								send: (args) =>
									handshake?.vouch(request.name, args, vouch, request.state),
								withdraw: () => handshake?.withdraw(vouch.nonce),
							},
				);
			} finally {
				running.delete(request.callId);
			}
		}
		case "webmcp-cancel":
			running.get(request.callId)?.abort();
			return { ok: true, value: null };
		case "history":
			return { ok: true, ...pageHistory() };
		case "extension-state":
			handshake?.stateChanged(request.state);
			return { ok: true, value: null };
		case "webmcp-install":
			// For the page that was read only (the tab may show another now).
			if (request.documentId === DOCUMENT_ID) installLate();
			return { ok: true, value: null };
	}
}

const REQUESTS = new Set([
	"page-info",
	"webmcp-list",
	"webmcp-call",
	"webmcp-cancel",
	"history",
	"extension-state",
	"webmcp-install",
]);

declare global {
	var tabMcpContentScript: true | undefined;
	/**
	 * Set in this world by the worker before it puts the script in without
	 * host access for the page (`injectInto` in `tabs.ts`): it runs only
	 * because of a click on the icon (DEC-223).
	 */
	var tabMcpByClick: true | undefined;
	/** This page's id (`DOCUMENT_ID`), for the worker to find its document. */
	var tabMcpDocumentId: string | undefined;
}

// Injected again on each click: answer once per page.
if (typeof chrome !== "undefined" && !globalThis.tabMcpContentScript) {
	globalThis.tabMcpContentScript = true;
	globalThis.tabMcpDocumentId = DOCUMENT_ID;
	// Without host access for the page (a click put it in), the script sends
	// nothing into the page and installs nothing until the worker's
	// `webmcp-install`, which comes only while AI access is on (DEC-223): no
	// port, no WebMCP, no takeover of a state the page could have faked. With
	// host access (registered for every page, or put into the open pages
	// after an update) it does what it always did, whatever AI access.
	const byClick = globalThis.tabMcpByClick === true;
	// First of all, at `document_start`: the page's scripts look for it as
	// they load. Where Firefox has WebMCP of its own, the native one is used.
	// With host access also into a page that loaded before (an install, an
	// update, "Give access to all sites"), taking over what an earlier script
	// left there. The build's `define` itself, not `FIREFOX`, here and below:
	// so Chrome's bundle drops it.
	if (typeof TAB_MCP_FIREFOX !== "undefined" && TAB_MCP_FIREFOX && !byClick) {
		try {
			ownContext = installWebMCP(window) as unknown as ModelContext | undefined;
		} catch {
			// The page broke what a takeover needs (a frozen object, its own
			// records): no WebMCP of ours, but the script still answers.
		}
	}
	chrome.runtime.onMessage.addListener(
		(request: ContentRequest, sender, sendResponse) => {
			// Only the extension itself (its service worker) asks; a content
			// script of this tab never sends to itself.
			if (sender.id !== chrome.runtime.id || !REQUESTS.has(request?.type))
				return false;
			answer(request).then(sendResponse, (error: unknown) =>
				sendResponse({ ok: false, error: message(error) }),
			);
			return true; // answers asynchronously
		},
	);
	// Tell the service worker when the page's tools change, also without a
	// navigation (single-page apps), and once now: injected at a click, the
	// script is the first moment the worker's bridge may read them.
	// At most every 250 ms, the last change included: a page firing
	// `toolchange` in a loop costs one message per 250 ms.
	let waiting: ReturnType<typeof setTimeout> | undefined;
	const send = () => {
		waiting = undefined;
		const event: ContentEvent = { type: "webmcp-changed" };
		chrome.runtime.sendMessage(event).catch(() => {
			// The service worker is not listening (stopping, or updated).
		});
	};
	const changed = () => {
		if (waiting === undefined) waiting = setTimeout(send, 250);
	};
	contextOf(document)?.addEventListener("toolchange", changed);
	// The page with the client library (DEC-207): what it announces goes to
	// the panel as a change of the page's tools does.
	handshake = new PageHandshake(document, {
		state: async () => {
			const ask: ContentEvent = { type: "handshake" };
			return (await chrome.runtime.sendMessage(ask)) as
				| ExtensionState
				| undefined;
		},
		changed,
		// Undefined once the extension was disabled, removed or updated.
		alive: () => chrome.runtime?.id !== undefined,
	});
	handshake.start();
	// Chrome without WebMCP of its own: the page-world polyfill, if it is
	// there (registered with host access), answers on a port. Put in late by
	// the worker, it answers a port posted after it came (`webmcp-install`);
	// one posted before it is lost, and of two ports only the first to be
	// answered counts.
	const connect = (isLate: boolean) =>
		void connectPolyfill(window).then((context) => {
			if ("modelContext" in document || ownContext !== undefined) return;
			ownContext = context as unknown as ModelContext;
			late = isLate;
			context.addEventListener("toolchange", changed);
			changed();
		});
	if (
		!(typeof TAB_MCP_FIREFOX !== "undefined" && TAB_MCP_FIREFOX) &&
		!byClick &&
		!("modelContext" in document)
	)
		connect(false);
	// The worker found no WebMCP in the page, while AI access is on
	// (DEC-223): Firefox installs its own now; in Chrome the worker has put
	// the page-world polyfill in, which a new port reaches. The page is read
	// again either way, so that the worker learns what came of it.
	installLate = () => {
		if (contextOf(document) !== undefined) return;
		if (typeof TAB_MCP_FIREFOX !== "undefined" && TAB_MCP_FIREFOX) {
			try {
				ownContext = installWebMCP(window) as unknown as
					| ModelContext
					| undefined;
			} catch {
				// As at the start: no WebMCP of ours.
			}
			if (ownContext !== undefined) {
				late = true;
				ownContext.addEventListener("toolchange", changed);
			}
			changed();
			return;
		}
		connect(true);
		setTimeout(changed, LATE_WAIT_MS);
	};
	// A page Chrome shows again from its back/forward cache loads nothing:
	// its tools are read again as after a change.
	globalThis.addEventListener?.("pageshow", (event) => {
		if ((event as PageTransitionEvent).persisted) changed();
	});
	changed();
}
