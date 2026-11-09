/**
 * The service worker: home of the connection to the AI app (DEC-116), so it
 * stays while the side panel is closed. A click on the icon opens the side
 * panel and injects the content script into that tab (the click grants
 * `activeTab` for that page). With host access ("Allow on all sites", or the
 * test build) the content script is registered for every page instead, so it
 * is there after navigations and on every tab.
 *
 * Every listener is added here, at the top level, so that its event wakes the
 * worker; each worker start makes the connection again and connects if the
 * user left AI access on (after a browser start, an update, a reload).
 */

import { CONTENT_SCRIPT, CONTENT_SCRIPT_ID } from "./messages.ts";
import { isContentEvent, isPanelSender, PANEL_PORT } from "./protocol.ts";
import { ALL_SITES, injectInto } from "./tabs.ts";
import { ALARM, Connection } from "./worker/connection.ts";

const ready = Connection.start();
ready.catch((error: unknown) => console.error("tab-mcp: start", error));

const withConnection = (use: (connection: Connection) => void) =>
	void ready.then(use, () => {});

chrome.action.onClicked.addListener((tab) => {
	// `sidePanel.open` needs the click's user gesture: call it before any await.
	void chrome.sidePanel
		.open({ windowId: tab.windowId })
		.catch((error: unknown) => console.warn("tab-mcp: side panel", error));
	if (tab.id !== undefined)
		void injectInto(tab.id)
			.then(() => withConnection((c) => c.tabChanged()))
			.catch(() => {
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

const tabChanged = () => withConnection((c) => c.tabChanged());
const permissionsChanged = () => {
	sync();
	tabChanged();
};
chrome.permissions.onAdded.addListener(permissionsChanged);
chrome.permissions.onRemoved.addListener(permissionsChanged);
chrome.tabs.onActivated.addListener(tabChanged);
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
	// Only the active tabs, and only once a page has loaded: mid-navigation
	// there is nothing to read, and the click's grant may be on its way out.
	if (tab.active && change.status === "complete") tabChanged();
});
chrome.windows.onFocusChanged.addListener(tabChanged);

// Content scripts may say only this: the page's tools changed (`toolchange`)
// in an active tab. Commands come only over the side panel's port.
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
	if (isContentEvent(message, sender, chrome.runtime.id) && sender.tab?.active)
		tabChanged();
	return false;
});

chrome.runtime.onConnect.addListener((port) => {
	if (
		port.name !== PANEL_PORT ||
		!isPanelSender(port.sender ?? {}, chrome.runtime.id)
	) {
		port.disconnect();
		return;
	}
	// Until the connection has started (a worker that just woke), keep what
	// the panel says: Chrome hands a message only to the listeners there are.
	const early: unknown[] = [];
	const keep = (message: unknown) => void early.push(message);
	let gone = false;
	port.onMessage.addListener(keep);
	port.onDisconnect.addListener(() => {
		gone = true;
	});
	withConnection((c) => {
		port.onMessage.removeListener(keep);
		if (!gone) c.addPanel(port, early);
	});
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === ALARM) withConnection((c) => c.keepUp());
});

/**
 * A notification's answer: its button Don't allow (0) or Allow (1); a click
 * on its body or its closing is Don't allow. On the worker's global object
 * too, for the DevTools Protocol, which cannot click a notification: the
 * end-to-end tests answer through the same functions a click calls.
 */
function notificationButton(id: string, index: number): void {
	withConnection((c) => c.notificationButton(id, index));
}
function notificationDismissed(id: string): void {
	withConnection((c) => c.notificationDismissed(id));
}
chrome.notifications.onButtonClicked.addListener(notificationButton);
chrome.notifications.onClicked.addListener(notificationDismissed);
chrome.notifications.onClosed.addListener(notificationDismissed);
Object.assign(globalThis, {
	tabMcpNotificationButton: notificationButton,
	tabMcpNotificationDismissed: notificationDismissed,
});
