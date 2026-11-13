/**
 * The content script, in the extension's isolated world of the tab's top
 * frame: injected at a click on the icon, or registered for every page with
 * host access. It answers the service worker (where the connection lives,
 * DEC-116) about the page and its WebMCP tools and calls them. In this world `document.modelContext` is the browser's own,
 * whatever the page put on its own `document` (iteration 18).
 */

import type {
	CallResult,
	ContentEvent,
	ContentRequest,
	ContentResponse,
	PageHistory,
	PageInfo,
	PageTool,
	PageTools,
} from "./messages.ts";

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

const contextOf = (doc: Document) =>
	(doc as Document & { modelContext?: ModelContext }).modelContext;

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

export async function pageInfo(doc: Document = document): Promise<PageInfo> {
	const context = contextOf(doc);
	const webmcp: PageInfo["webmcp"] = {
		available: context !== undefined,
		tools: 0,
	};
	if (context !== undefined) {
		try {
			webmcp.tools = (await context.getTools()).length;
		} catch (error) {
			webmcp.error = message(error);
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
): Promise<PageTools> {
	const context = contextOf(doc);
	const base = {
		url: doc.location.href,
		origin: doc.location.origin,
		documentId,
		available: context !== undefined,
		more: 0,
	};
	if (context === undefined) return { ...base, tools: [] };
	let listed: RegisteredTool[];
	try {
		listed = await context.getTools();
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
		const annotations = tool.annotations;
		/** Whether `schema` fits in a message (as JSON). */
		const fits = (schema: unknown) =>
			(JSON.stringify(schema) ?? "").length <= SEND_SCHEMA_BYTES;
		let schema: { inputSchema?: unknown; schemaTooBig?: true } = {};
		if (tool.inputSchema !== undefined)
			schema = fits(tool.inputSchema)
				? { inputSchema: tool.inputSchema }
				: { schemaTooBig: true };
		tools.push({
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
			},
		});
	}
	return { ...base, tools, more };
}

/** Calls still running, by call id, to cancel them. */
const running = new Map<string, AbortController>();

/**
 * Run the page's tool `name`, if it is still what was offered: listed from
 * this very page (`documentId`) with the same read-only claim. Otherwise
 * "gone": a tool must never run on another page than the one it was offered
 * for, nor without the confirmation its first claim would have needed.
 */
export async function callTool(
	call: { documentId: string; name: string; readOnly: boolean },
	input: unknown,
	signal: AbortSignal,
	doc: Document = document,
	documentId: string = DOCUMENT_ID,
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
	const tool = (await context.getTools()).find((t) => t.name === name);
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
	let value: string | null;
	try {
		value = await context.executeTool(tool, input ?? {}, { signal });
	} catch (error) {
		return { ok: false, error: message(error) };
	}
	if (typeof value === "string" && value.length > MAX_SEND_RESULT)
		return {
			ok: false,
			error: `It returned ${value.length} characters; tab-mcp for Chrome passes on at most ${MAX_SEND_RESULT}.`,
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
			try {
				return await callTool(request, request.input, controller.signal);
			} finally {
				running.delete(request.callId);
			}
		}
		case "webmcp-cancel":
			running.get(request.callId)?.abort();
			return { ok: true, value: null };
		case "history":
			return { ok: true, ...pageHistory() };
	}
}

const REQUESTS = new Set([
	"page-info",
	"webmcp-list",
	"webmcp-call",
	"webmcp-cancel",
	"history",
]);

declare global {
	var tabMcpContentScript: true | undefined;
}

// Injected again on each click: answer once per page.
if (typeof chrome !== "undefined" && !globalThis.tabMcpContentScript) {
	globalThis.tabMcpContentScript = true;
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
	changed();
}
