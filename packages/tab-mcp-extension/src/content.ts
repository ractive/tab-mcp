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
/** At most this many mirrored names are read from `<html>`, each this long. */
const SEND_MIRRORED = 256;

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
	const language = doc.documentElement.lang.trim();
	return {
		url: doc.location.href,
		title: doc.title,
		...(language ? { language } : {}),
		webmcp,
	};
}

/** The names a tab-mcp page mirrors into WebMCP (iteration 25), from `<html>`. */
export function mirroredNames(doc: Document = document): string[] {
	const listed = doc.documentElement.getAttribute("data-tab-mcp-webmcp") ?? "";
	return listed
		.split(/[\s,]+/)
		.filter((name) => name !== "")
		.slice(0, SEND_MIRRORED)
		.map((name) => cutText(name, SEND_NAME));
}

const hint = (annotations: Record<string, unknown> | undefined, key: string) =>
	annotations?.[key] === true;

/**
 * The page's tools, as plain data, without the ones it mirrors from tab-mcp;
 * capped, so a page cannot make the message (or the bridge's list) big.
 */
export async function pageTools(
	doc: Document = document,
	documentId: string = DOCUMENT_ID,
): Promise<PageTools> {
	const context = contextOf(doc);
	const mirrored = mirroredNames(doc);
	const base = {
		url: doc.location.href,
		origin: doc.location.origin,
		documentId,
		available: context !== undefined,
		mirrored,
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
		if (mirrored.includes(tool.name)) continue;
		if (tools.length >= SEND_TOOLS) {
			more++;
			continue;
		}
		const annotations = tool.annotations;
		let schema: { inputSchema?: unknown; schemaTooBig?: true } = {};
		if (tool.inputSchema !== undefined) {
			const json = JSON.stringify(tool.inputSchema) ?? "";
			schema =
				json.length > SEND_SCHEMA_BYTES
					? { schemaTooBig: true }
					: { inputSchema: tool.inputSchema };
		}
		tools.push({
			name: cutText(String(tool.name), SEND_NAME),
			...(typeof tool.title === "string" && tool.title !== ""
				? { title: cutText(tool.title, SEND_TEXT) }
				: {}),
			description: cutText(String(tool.description ?? ""), SEND_TEXT),
			...schema,
			annotations: {
				readOnlyHint: hint(annotations, "readOnlyHint"),
				consequentialHint: hint(annotations, "consequentialHint"),
				untrustedContentHint: hint(annotations, "untrustedContentHint"),
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
	if (tool === undefined || mirroredNames(doc).includes(name))
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
	try {
		return {
			ok: true,
			value: await context.executeTool(tool, input ?? {}, { signal }),
		};
	} catch (error) {
		return { ok: false, error: message(error) };
	}
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
	}
}

const REQUESTS = new Set([
	"page-info",
	"webmcp-list",
	"webmcp-call",
	"webmcp-cancel",
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
