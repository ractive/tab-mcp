/**
 * The content script, in the extension's isolated world of the tab's top
 * frame: injected at a click on the icon, or registered for every page with
 * host access. It answers the side panel about the page and its WebMCP tools
 * and calls them. In this world `document.modelContext` is the browser's own,
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
	return listed.split(/[\s,]+/).filter((name) => name !== "");
}

const hint = (annotations: Record<string, unknown> | undefined, key: string) =>
	annotations?.[key] === true;

/** The page's tools, as plain data, without the ones it mirrors from tab-mcp. */
export async function pageTools(doc: Document = document): Promise<PageTools> {
	const context = contextOf(doc);
	const mirrored = mirroredNames(doc);
	const base = {
		url: doc.location.href,
		origin: doc.location.origin,
		available: context !== undefined,
		mirrored,
	};
	if (context === undefined) return { ...base, tools: [] };
	let listed: RegisteredTool[];
	try {
		listed = await context.getTools();
	} catch (error) {
		return { ...base, tools: [], error: message(error) };
	}
	const tools: PageTool[] = [];
	for (const tool of listed) {
		if (mirrored.includes(tool.name)) continue;
		const annotations = tool.annotations;
		tools.push({
			name: String(tool.name),
			...(typeof tool.title === "string" && tool.title !== ""
				? { title: tool.title }
				: {}),
			description: String(tool.description ?? ""),
			...(tool.inputSchema !== undefined
				? { inputSchema: tool.inputSchema }
				: {}),
			annotations: {
				readOnlyHint: hint(annotations, "readOnlyHint"),
				consequentialHint: hint(annotations, "consequentialHint"),
				untrustedContentHint: hint(annotations, "untrustedContentHint"),
			},
		});
	}
	return { ...base, tools };
}

/** Calls still running, by call id, to cancel them. */
const running = new Map<string, AbortController>();

/** Run the page's tool `name`; "not found" if the page no longer has it. */
export async function callTool(
	name: string,
	input: unknown,
	signal: AbortSignal,
	doc: Document = document,
): Promise<CallResult> {
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
				return await callTool(request.name, request.input, controller.signal);
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
			// Only the extension's own pages (the side panel) ask; a content
			// script of this tab never sends to itself.
			if (sender.id !== chrome.runtime.id || !REQUESTS.has(request?.type))
				return false;
			answer(request).then(sendResponse, (error: unknown) =>
				sendResponse({ ok: false, error: message(error) }),
			);
			return true; // answers asynchronously
		},
	);
	// Tell the side panel when the page's tools change, also without a
	// navigation (single-page apps), and once now: injected at a click, the
	// script is the first moment the panel may read them.
	const changed = () => {
		const event: ContentEvent = { type: "webmcp-changed" };
		chrome.runtime.sendMessage(event).catch(() => {
			// No side panel open.
		});
	};
	contextOf(document)?.addEventListener("toolchange", changed);
	changed();
}
