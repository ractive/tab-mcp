/**
 * The content script, in the extension's isolated world of the tab's top
 * frame: injected at a click on the icon, or registered for every page with
 * host access. It answers the side panel about the page. In this world
 * `document.modelContext` is the browser's own, whatever the page put on its
 * own `document` (iteration 18).
 */

import type { ContentRequest, ContentResponse, PageInfo } from "./messages.ts";

export async function pageInfo(doc: Document = document): Promise<PageInfo> {
	const context = (
		doc as Document & { modelContext?: { getTools(): Promise<unknown[]> } }
	).modelContext;
	const webmcp: PageInfo["webmcp"] = {
		available: context !== undefined,
		tools: 0,
	};
	if (context !== undefined) {
		try {
			webmcp.tools = (await context.getTools()).length;
		} catch (error) {
			webmcp.error = error instanceof Error ? error.message : String(error);
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

declare global {
	var tabMcpContentScript: true | undefined;
}

// Injected again on each click: answer once per page.
if (typeof chrome !== "undefined" && !globalThis.tabMcpContentScript) {
	globalThis.tabMcpContentScript = true;
	chrome.runtime.onMessage.addListener(
		(request: ContentRequest, sender, sendResponse) => {
			if (sender.id !== chrome.runtime.id || request?.type !== "page-info")
				return false;
			pageInfo().then(
				(info) => sendResponse({ ok: true, ...info } satisfies ContentResponse),
				(error: unknown) =>
					sendResponse({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					} satisfies ContentResponse),
			);
			return true; // answers asynchronously
		},
	);
}
