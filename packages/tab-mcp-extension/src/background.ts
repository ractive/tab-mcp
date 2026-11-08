/**
 * The service worker. A click on the icon opens the side panel and injects
 * the content script into that tab (the click grants `activeTab` for that
 * page). With host access ("Allow on all sites", or the test build) the
 * content script is registered for every page instead, so it is there after
 * navigations and on every tab.
 */

import { CONTENT_SCRIPT, CONTENT_SCRIPT_ID } from "./messages.ts";
import { ALL_SITES, injectInto } from "./tabs.ts";

chrome.action.onClicked.addListener((tab) => {
	// `sidePanel.open` needs the click's user gesture: call it before any await.
	void chrome.sidePanel
		.open({ windowId: tab.windowId })
		.catch((error: unknown) => console.warn("tab-mcp: side panel", error));
	if (tab.id !== undefined)
		void injectInto(tab.id).catch(() => {
			// A page extensions may not run on (chrome://, the Web Store):
			// page_info says so when asked.
		});
});

/** Register the content script for every page while host access is granted. */
async function syncRegistration(): Promise<void> {
	const granted = await chrome.permissions.contains(ALL_SITES);
	const registered = await chrome.scripting.getRegisteredContentScripts({
		ids: [CONTENT_SCRIPT_ID],
	});
	if (granted && registered.length === 0)
		await chrome.scripting.registerContentScripts([
			{
				id: CONTENT_SCRIPT_ID,
				js: [CONTENT_SCRIPT],
				matches: ["<all_urls>"],
				runAt: "document_idle",
			},
		]);
	else if (!granted && registered.length > 0)
		await chrome.scripting.unregisterContentScripts({
			ids: [CONTENT_SCRIPT_ID],
		});
}

const sync = () =>
	void syncRegistration().catch((error: unknown) =>
		console.warn("tab-mcp: content script registration", error),
	);
chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
chrome.permissions.onAdded.addListener(sync);
chrome.permissions.onRemoved.addListener(sync);
