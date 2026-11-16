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

/** Firefox's `browser.sidebarAction`, the part used here. */
interface SidebarAction {
	open(): Promise<void>;
}

/**
 * Open the panel for `tabId` in `windowId`: Chrome's side panel, or
 * Firefox's sidebar (of the window in front; it needs the user's gesture,
 * as Chrome's does, so no `await` before this).
 */
export function openPanel(options: {
	tabId?: number;
	windowId: number;
}): Promise<void> {
	if (FIREFOX) {
		const browser = (
			globalThis as { browser?: { sidebarAction?: SidebarAction } }
		).browser;
		return browser?.sidebarAction
			? browser.sidebarAction.open()
			: Promise.reject(new Error("no sidebarAction"));
	}
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
