/**
 * Tabs: which one the side panel acts on, putting the content script into it,
 * and asking it.
 */

import {
	CONTENT_SCRIPT,
	type ContentRequest,
	type ContentResponse,
	type PageInfo,
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

function ask(tabId: number, request: ContentRequest): Promise<ContentResponse> {
	return chrome.tabs.sendMessage(tabId, request) as Promise<ContentResponse>;
}

/**
 * Ask the content script of `tab` about its page. If it is not there yet
 * (granted by a click or host access, but the page changed since), put it in
 * and ask again; if the extension may not, say so.
 */
export async function askPage(tab: TargetTab): Promise<PageInfo> {
	let response: ContentResponse | undefined;
	try {
		response = await ask(tab.id, { type: "page-info" });
	} catch {
		try {
			await injectInto(tab.id);
		} catch {
			throw noAccess(tab.url);
		}
		response = await ask(tab.id, { type: "page-info" });
	}
	if (response === undefined) throw noAccess(tab.url);
	if (!response.ok) throw new Error(response.error);
	const { ok: _, ...info } = response;
	return info;
}
