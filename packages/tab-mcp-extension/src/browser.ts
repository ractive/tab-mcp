/**
 * What differs between Chrome and Firefox (iteration 44), in one place:
 * Chrome's side panel is Firefox's sidebar, and Firefox's notifications have
 * no buttons. The build decides (`scripts/build.ts --firefox`, a `define`);
 * without it (the unit tests) it is Chrome.
 */

declare const TAB_MCP_FIREFOX: boolean | undefined;

/** `true` in the Firefox build only. */
export const FIREFOX: boolean =
	typeof TAB_MCP_FIREFOX !== "undefined" && TAB_MCP_FIREFOX;

/** The browser's name, in the panel's and the notifications' words. */
export const BROWSER: string = FIREFOX ? "Firefox" : "Chrome";

/** What the panel is called: Chrome's side panel, Firefox's sidebar. */
export const PANEL: string = FIREFOX ? "sidebar" : "side panel";

/** The extension's name: "tab-mcp for Chrome" or "tab-mcp for Firefox". */
export const PRODUCT = `tab-mcp for ${BROWSER}`;

/**
 * The panel's static texts that name the browser, for Firefox: by element
 * id, the text (or HTML of the extension's own) that replaces Chrome's.
 */
export const FIREFOX_PANEL_TEXTS: Readonly<Record<string, string>> = {
	"no-webmcp":
		"This page has no WebMCP: tab-mcp gives a page its WebMCP as the page starts loading, so reload it if it loaded before tab-mcp had access to the site. Only https pages (and localhost) get it. page_info and the navigation tools still work.",
	"pairing-profile":
		"Use the AI app outside this Firefox profile (its desktop app, another browser or another profile): a chat open in a tab here becomes the tab in front while you type in it.",
	"host-access-note":
		"Then tab-mcp reads every tab without a click on its icon, and gives every page WebMCP as it loads. Firefox asks you first.",
};

/** The pages the browser keeps extensions out of, in the user's words. */
export const STORE_TEXT: string = FIREFOX
	? "Firefox does not let extensions read addons.mozilla.org and Mozilla's account and support sites."
	: "Chrome does not let extensions read the Chrome Web Store.";

/** Firefox's `browser.sidebarAction`, the part used here. */
export interface SidebarAction {
	open(): Promise<void>;
	isOpen(details: { windowId?: number }): Promise<boolean>;
}

/**
 * Open Firefox's sidebar: `open()` takes no window and opens it in the
 * window in front, which need not be `windowId` (a question's notification
 * clicked while another window is in front). Rejects unless `windowId`'s
 * sidebar is open after it. `open()` is called at once, in the gesture.
 */
export function openSidebar(
	action: SidebarAction | undefined,
	windowId: number,
): Promise<void> {
	if (action === undefined)
		return Promise.reject(new Error("no sidebarAction"));
	return action.open().then(async () => {
		if (!(await action.isOpen({ windowId })))
			throw new Error("the sidebar opened in another window");
	});
}

/**
 * Open the panel for `tabId` in `windowId`: Chrome's side panel, or
 * Firefox's sidebar (`openSidebar`; it needs the user's gesture, as Chrome's
 * does, so no `await` before this).
 */
export function openPanel(options: {
	tabId?: number;
	windowId: number;
}): Promise<void> {
	if (FIREFOX)
		return openSidebar(
			(globalThis as { browser?: { sidebarAction?: SidebarAction } }).browser
				?.sidebarAction,
			options.windowId,
		);
	return chrome.sidePanel.open(
		options.tabId === undefined
			? { windowId: options.windowId }
			: { tabId: options.tabId, windowId: options.windowId },
	);
}

/** A notification's options; Firefox takes no buttons and no `requireInteraction`. */
export function notificationOptions(
	options: chrome.notifications.NotificationCreateOptions,
): chrome.notifications.NotificationCreateOptions {
	if (!FIREFOX) return options;
	const { buttons: _b, requireInteraction: _r, ...rest } = options;
	return rest;
}
