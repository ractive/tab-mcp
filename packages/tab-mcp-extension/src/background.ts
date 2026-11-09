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
import {
	isContentEvent,
	isPanelSender,
	isQuestionSender,
	PANEL_PORT,
	QUESTION_PORT,
	startProblem,
	type WorkerMessage,
} from "./protocol.ts";
import { Starter } from "./starter.ts";
import { ALL_SITES, injectInto } from "./tabs.ts";
import { ALARM, Connection } from "./worker/connection.ts";

// A start that fails (IndexedDB refused, say) is tried again by the next
// event or panel; meanwhile a panel shows why.
const connection = new Starter(() => Connection.start());
const ready = () => {
	const starting = connection.ready();
	starting.catch((error: unknown) => console.error("tab-mcp: start", error));
	return starting;
};
void ready().catch(() => {});

const withConnection = (use: (connection: Connection) => void) =>
	void ready().then(use, () => {});

chrome.action.onClicked.addListener((tab) => {
	// `sidePanel.open` needs the click's user gesture: call it before any await.
	// With the tab, not only the window: over another extension's panel for
	// this tab (Claude in Chrome's, say), `open({ windowId })` resolves and
	// shows nothing. The panel stays the global one, for every tab without a
	// panel of its own. (`openPanelOnActionClick` would show it too, but then
	// the click grants no `activeTab`.)
	void chrome.sidePanel
		.open(
			tab.id === undefined
				? { windowId: tab.windowId }
				: { tabId: tab.id, windowId: tab.windowId },
		)
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
	// A question's own window (a notification clicked where the side panel
	// could not open): the connection checks that it opened that window.
	if (
		port.name === QUESTION_PORT &&
		isQuestionSender(port.sender ?? {}, chrome.runtime.id)
	) {
		const c = connection.value;
		if (c === undefined) port.disconnect();
		else c.addQuestionWindow(port);
		return;
	}
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
	let gone = false;
	let added = false;
	const add = () =>
		void ready().then(
			(c) => {
				if (gone || added) return;
				added = true;
				port.onMessage.removeListener(keep);
				c.addPanel(port, early);
			},
			(error: unknown) => {
				// The panel shows why; what it says next tries the start again.
				if (gone || added) return;
				const message: WorkerMessage = {
					type: "state",
					state: startProblem(error),
				};
				try {
					port.postMessage(message);
				} catch {
					// Closed meanwhile.
				}
			},
		);
	const keep = (message: unknown) => {
		early.push(message);
		if (connection.failed) add();
	};
	port.onMessage.addListener(keep);
	port.onDisconnect.addListener(() => {
		gone = true;
	});
	add();
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === ALARM) withConnection((c) => c.keepUp());
});

// A window opened for a question, closed: Don't allow.
chrome.windows.onRemoved.addListener((windowId) =>
	connection.value?.windowRemoved(windowId),
);

/**
 * A notification's answer: its button Allow (0) or Always allow (1); its
 * closing is Don't allow; a click on its body shows the whole question (the
 * side panel of the tab's window, else a window of its own). On the worker's
 * global object too, for the DevTools Protocol, which cannot click a
 * notification: the end-to-end tests answer through the same functions a
 * click calls.
 */
function notificationButton(id: string, index: number): void {
	withConnection((c) => c.notificationButton(id, index));
}
function notificationDismissed(id: string): void {
	withConnection((c) => c.notificationDismissed(id));
}
function notificationClicked(id: string): void {
	// At once, not after a promise: `sidePanel.open` needs Chrome's user
	// gesture, which this event carries only until the first `await`. A
	// worker that is still starting has no question of this notification:
	// a start clears them all.
	connection.value?.notificationClicked(id);
}
chrome.notifications.onButtonClicked.addListener(notificationButton);
chrome.notifications.onClicked.addListener(notificationClicked);
chrome.notifications.onClosed.addListener(notificationDismissed);
Object.assign(globalThis, {
	tabMcpNotificationButton: notificationButton,
	tabMcpNotificationDismissed: notificationDismissed,
	tabMcpNotificationClicked: notificationClicked,
});
