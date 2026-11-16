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
import {
	CONTENT_SCRIPT,
	CONTENT_SCRIPT_ID,
	WEBMCP_MAIN_ID,
	WEBMCP_MAIN_SCRIPT,
} from "./messages.ts";
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
	const scripts: chrome.scripting.RegisteredContentScript[] = [
		{
			id: CONTENT_SCRIPT_ID,
			js: [CONTENT_SCRIPT],
			matches: SITE_MATCHES,
			// Firefox: before the page's scripts, which look for
			// `document.modelContext` while they load (the polyfill,
			// `firefox/webmcp.ts`).
			runAt: FIREFOX ? "document_start" : "document_idle",
		},
	];
	// Chrome: the polyfill for pages without Chrome's WebMCP, in the page's
	// own world before its scripts (`chrome/webmcp-main.ts`).
	if (!FIREFOX)
		scripts.push({
			id: WEBMCP_MAIN_ID,
			js: [WEBMCP_MAIN_SCRIPT],
			matches: SITE_MATCHES,
			runAt: "document_start",
			world: "MAIN",
		});
	const ids = scripts.map((s) => s.id);
	const registered = new Set(
		(await chrome.scripting.getRegisteredContentScripts({ ids })).map(
			(s) => s.id,
		),
	);
	if (granted) {
		// Also after an update that added a script: the missing ones.
		const missing = scripts.filter((s) => !registered.has(s.id));
		if (missing.length > 0)
			await chrome.scripting.registerContentScripts(missing);
	} else if (registered.size > 0)
		await chrome.scripting.unregisterContentScripts({ ids: [...registered] });
}

const sync = () =>
	void syncRegistration().catch((error: unknown) =>
		console.warn("tab-mcp: content script registration", error),
	);
chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);

/**
 * Firefox, after an install, reload or update: the content script into every
 * open page it may read, at once. The page's tools outlived the script that
 * ended in the page (`firefox/webmcp.ts`), but its methods are dead objects
 * until a new script takes over, and the page's own calls throw meanwhile.
 * Chrome keeps the tools itself, and its page-world polyfill outlives the
 * extension's reload. Not after a disable and enable: Firefox tells the
 * extension nothing of it, and without the `storage` permission (DEC-116) a
 * first start can't be told from the event page waking; a page gets the
 * script when the worker reads its tab (`tabs.ts`) or at a click.
 */
async function reviveOpenPages(): Promise<void> {
	const tabs = await chrome.tabs.query({ url: SITE_MATCHES });
	await Promise.all(
		tabs.map((tab) =>
			tab.id === undefined
				? undefined
				: injectInto(tab.id).catch(() => {
						// No access to its site, or a page Firefox keeps to itself.
					}),
		),
	);
}

if (FIREFOX)
	chrome.runtime.onInstalled.addListener(
		() => void reviveOpenPages().catch(() => {}),
	);

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
 * Firefox stops an idle event page after 30 s (`extensions.background.idle.timeout`),
 * its WebSocket with it; Chrome keeps a worker whose WebSocket is busy. A call
 * to an extension API resets Firefox's idle timer (a port from a content
 * script does not, nor does `persistent`, which Manifest V3 ignores), so
 * while AI access is on the event page makes one this often (iteration 44).
 * The test build every second: its tests cut Firefox's timeout to 3 s.
 */
const FIREFOX_KEEPALIVE_MS = TAB_MCP_TEST ? 1_000 : 20_000;
if (FIREFOX)
	setInterval(() => {
		if (started?.aiOn) void chrome.runtime.getPlatformInfo().catch(() => {});
	}, FIREFOX_KEEPALIVE_MS);

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
// Not in Firefox: its notifications have no `requireInteraction` and close by
// themselves, which fires `onClosed` too (Firefox gives no `byUser`), so a
// close is no answer there; the question's own time limit, the panel and
// the badge stay.
if (!FIREFOX) chrome.notifications.onClosed.addListener(notificationDismissed);
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
