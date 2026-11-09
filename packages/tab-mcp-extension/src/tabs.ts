/**
 * Tabs: which one the side panel acts on, putting the content script into it,
 * and asking it.
 */

import {
	type CallResult,
	CONTENT_SCRIPT,
	type ContentRequest,
	type ContentResponse,
	type PageInfo,
	type PageTools,
} from "./messages.ts";

/** Host access on every site: what "Allow on all sites" asks for. */
export const ALL_SITES: chrome.permissions.Permissions = {
	origins: ["<all_urls>"],
};

/** Put the content script into a tab's page (it answers once per page). */
export async function injectInto(tabId: number): Promise<void> {
	await chrome.scripting.executeScript({
		target: { tabId },
		files: [CONTENT_SCRIPT],
	});
}

/** The tab a tool acts on. */
export interface TargetTab {
	id: number;
	url: string;
	title: string;
}

/**
 * The tab in front: the active tab of the side panel's window, or, when the
 * panel is open as a tab of its own (or in a window without other tabs), the
 * most recently used active tab of a normal window that is not one of the
 * extension's own pages.
 */
export async function tabInFront(): Promise<TargetTab> {
	const own = chrome.runtime.getURL("");
	const usable = (tab: chrome.tabs.Tab) =>
		tab.id !== undefined && !(tab.url ?? "").startsWith(own);
	const current = await chrome.windows.getCurrent();
	const [inPanelWindow] = await chrome.tabs.query({
		active: true,
		windowId: current.id,
	});
	let tab = inPanelWindow && usable(inPanelWindow) ? inPanelWindow : undefined;
	if (tab === undefined) {
		const candidates = (
			await chrome.tabs.query({ active: true, windowType: "normal" })
		).filter(usable);
		candidates.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
		tab = candidates[0];
	}
	if (tab?.id === undefined) throw new Error("No tab is in front.");
	return { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" };
}

/** The extension may not run on this tab, and why, with what the user can do. */
export class NoAccessError extends Error {}

/** The answer to an access problem, for the AI app and the user. */
export function noAccess(url: string): NoAccessError {
	// Without a grant Chrome hides the tab's address: "" is any page.
	if (url === "")
		return new NoAccessError(
			'tab-mcp for Chrome may not read this tab yet. The user can click its icon on the tab, or turn on "Allow on all sites" in its side panel. (Browser pages such as chrome:// cannot be read at all.)',
		);
	if (/^(chrome|edge|about|devtools|view-source):/i.test(url))
		return new NoAccessError(
			"Chrome does not let extensions read this tab (a browser page). Switch to a web page.",
		);
	if (/^https:\/\/chromewebstore\.google\.com\//i.test(url))
		return new NoAccessError(
			"Chrome does not let extensions read the Chrome Web Store.",
		);
	return new NoAccessError(
		'tab-mcp for Chrome may not read this tab yet. The user can click its icon on the tab, or turn on "Allow on all sites" in its side panel.',
	);
}

function send(tabId: number, request: ContentRequest): Promise<unknown> {
	return chrome.tabs.sendMessage(tabId, request);
}

/**
 * Ask the content script of `tab`. If it is not there yet (granted by a click
 * or host access, but the page changed since), put it in and ask again; if
 * the extension may not, say so.
 */
export async function ask(
	tab: TargetTab,
	request: ContentRequest,
): Promise<ContentResponse> {
	let response: unknown;
	try {
		response = await send(tab.id, request);
	} catch {
		try {
			await injectInto(tab.id);
		} catch {
			throw noAccess(tab.url);
		}
		response = await send(tab.id, request);
	}
	if (response === undefined) throw noAccess(tab.url);
	return response as ContentResponse;
}

/** The page in `tab`. */
export async function askPage(tab: TargetTab): Promise<PageInfo> {
	const response = await ask(tab, { type: "page-info" });
	if (!response.ok) throw new Error(response.error);
	const { ok: _, ...info } = response as { ok: true } & PageInfo;
	return info;
}

/** The WebMCP tools of the page in `tab`. */
export async function askTools(tab: TargetTab): Promise<PageTools> {
	const response = await ask(tab, { type: "webmcp-list" });
	if (!response.ok) throw new Error(response.error);
	const { ok: _, ...tools } = response as { ok: true } & PageTools;
	return tools;
}

/**
 * Call a page tool in tab `tabId` (only the content script already there: a
 * call does not inject it). The content script runs it only on the page it
 * was listed from (`target.documentId`), with the claim it was offered with.
 * Aborting `signal` cancels the call in the page.
 */
export async function callInTab(
	tabId: number,
	target: { documentId: string; name: string; readOnly: boolean },
	input: unknown,
	signal: AbortSignal,
): Promise<CallResult> {
	const callId = crypto.randomUUID();
	const cancel = () =>
		void send(tabId, { type: "webmcp-cancel", callId }).catch(() => {});
	signal.addEventListener("abort", cancel, { once: true });
	try {
		const response = (await send(tabId, {
			type: "webmcp-call",
			callId,
			documentId: target.documentId,
			name: target.name,
			readOnly: target.readOnly,
			input,
		})) as CallResult | undefined;
		return (
			response ?? {
				ok: false,
				error: "The page did not answer.",
				gone: true,
			}
		);
	} catch {
		// The page went away (navigation, closed tab) during the call.
		return {
			ok: false,
			error: "The page changed or closed during the call.",
			gone: true,
		};
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}
