/**
 * The service worker: home of the connection to the AI app (DEC-116), so it
 * stays while the side panel is closed. A click on the icon opens the side
 * panel and injects the content script into that tab (the click grants
 * `activeTab` for that page). With host access ("Give access to all sites", or the
 * test build) the content script is registered for every page instead, so it
 * is there after navigations and on every tab.
 *
 * Every listener is added here, at the top level, so that its event wakes the
 * worker; each worker start makes the connection again and connects if the
 * user left AI access on (after a browser start, an update, a reload).
 */

import { FIREFOX, openPanel } from "./browser.ts";
import { CONTENT_SCRIPT, CONTENT_SCRIPT_ID } from "./messages.ts";
import { attachPanel } from "./panel-port.ts";
import { isContentEvent, isPanelSender, PANEL_PORT } from "./protocol.ts";
import { ALL_SITES, injectInto, isSitePage, SITE_MATCHES } from "./tabs.ts";
import { ALARM, Connection } from "./worker/connection.ts";

/** `true` only in the test build (`scripts/build.ts --test`, a `define`). */
declare const TAB_MCP_TEST: boolean;

/** The connection, once its start has succeeded. */
let started: Connection | undefined;
let starting: Promise<Connection> | undefined;

/**
 * The connection's start, shared by every caller. A start that fails
 * (IndexedDB refused, say) is forgotten, so the next Chrome event or panel
 * message tries again; meanwhile a panel shows why.
 */
function ready(): Promise<Connection> {
	starting ??= Connection.start().then(
		(connection) => {
			started = connection;
			return connection;
		},
		(error: unknown) => {
			starting = undefined;
			console.error("tab-mcp: start", error);
			throw error;
		},
	);
	return starting;
}
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
	void openPanel({
		...(tab.id === undefined ? {} : { tabId: tab.id }),
		windowId: tab.windowId,
	}).catch((error: unknown) => console.warn("tab-mcp: side panel", error));
	// Only into a page of an http(s) site (DEC-142); elsewhere page_info says why.
	if (tab.id !== undefined && isSitePage(tab.url ?? ""))
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
				matches: SITE_MATCHES,
				// Firefox: before the page's scripts, which look for
				// `document.modelContext` while they load (the polyfill,
				// `firefox/webmcp.ts`).
				runAt: FIREFOX ? "document_start" : "document_idle",
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
		!isPanelSender(port.sender ?? {}, chrome.runtime.id, {
			origin: chrome.runtime.getURL("/").replace(/\/$/, ""),
			// The Firefox test build: the tests open the panel in a tab
			// (WebDriver BiDi cannot reach the sidebar).
			inTab: FIREFOX && TAB_MCP_TEST,
		})
	) {
		port.disconnect();
		return;
	}
	attachPanel(
		ready,
		{
			postMessage: (message) => port.postMessage(message),
			onMessage: (listener) => port.onMessage.addListener(listener),
			onDisconnect: (listener) => port.onDisconnect.addListener(listener),
		},
		(connection) => connection.addPanel(port),
	);
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === ALARM) withConnection((c) => c.keepUp());
});

/**
 * A notification's answer: its button Allow; its closing is Don't allow; a
 * click on its body opens the side panel of the tab's window, where the
 * whole question is (if Chrome refuses, the notification comes back). In
 * the test build on the worker's global object too, for the DevTools
 * Protocol, which cannot click a notification: the end-to-end tests answer
 * through the same functions a click calls. Not in the store build (ES 7).
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
	started?.notificationClicked(id);
}
chrome.notifications.onButtonClicked.addListener(notificationButton);
chrome.notifications.onClicked.addListener(notificationClicked);
chrome.notifications.onClosed.addListener(notificationDismissed);
// The Firefox test build opens the panel at install, in a tab in front (the
// tests open their pages in another window; the tab in front is then the
// page's, `tabInFront`): WebDriver BiDi can neither reach the sidebar nor
// navigate a tab to an extension's page, and headless Firefox shows one
// window only.
if (TAB_MCP_TEST && FIREFOX)
	chrome.runtime.onInstalled.addListener(
		() =>
			void chrome.tabs.create({
				url: chrome.runtime.getURL("sidepanel/index.html"),
				active: true,
			}),
	);
if (TAB_MCP_TEST)
	Object.assign(globalThis, {
		tabMcpNotificationButton: notificationButton,
		tabMcpNotificationDismissed: notificationDismissed,
		tabMcpNotificationClicked: notificationClicked,
	});
