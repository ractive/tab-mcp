/**
 * Tabs: which one the tools act on, putting the content script into it,
 * and asking it.
 */

import { BROWSER, FIREFOX, PANEL, PRODUCT, STORE_TEXT } from "./browser.ts";
import {
	type CallResult,
	CONTENT_SCRIPT,
	type ContentRequest,
	type ContentResponse,
	type ExtensionState,
	type PageHistory,
	type PageInfo,
	type PageTools,
	type Vouch,
	WEBMCP_MAIN_SCRIPT,
} from "./messages.ts";

/**
 * The pages the extension acts on: http(s) only, the pages that have a site
 * ("allowed" and the navigation rules know no other). Not `file:` pages.
 */
export const SITE_MATCHES = ["http://*/*", "https://*/*"];

/** Host access on every site: what "Give access to all sites" asks for. */
export const ALL_SITES: chrome.permissions.Permissions = {
	origins: SITE_MATCHES,
};

/**
 * A content script that does not answer in this time is given up: a page
 * whose main thread is blocked would otherwise hold the bridge, `page_info`
 * and the navigation tools for every tab (ES 1). Calls have their own limit.
 */
export const ASK_TIMEOUT_MS = 5_000;

/** Put the content script into a tab's page (it answers once per page). */
export async function injectInto(tabId: number): Promise<void> {
	await chrome.scripting.executeScript({
		target: { tabId },
		files: [CONTENT_SCRIPT],
	});
}

/**
 * Give the page in tab `tabId` the extension's own WebMCP now, after it
 * loaded (DEC-223): in Chrome the page-world polyfill into the top frame's
 * main world (which tells the page with `WEBMCP_EVENT`), then the content
 * script connects to it; in Firefox the content script installs it. Needs a
 * click's grant (`activeTab`) or host access; rejects without.
 */
export async function giveWebMCP(tabId: number): Promise<void> {
	if (!FIREFOX)
		await chrome.scripting.executeScript({
			target: { tabId, frameIds: [0] },
			world: "MAIN",
			files: [WEBMCP_MAIN_SCRIPT],
		});
	const install: ContentRequest = { type: "webmcp-install" };
	await chrome.tabs.sendMessage(tabId, install, { frameId: 0 });
}

/** The tab a tool acts on. */
export interface TargetTab {
	id: number;
	url: string;
	title: string;
}

/**
 * The tab in front: the active tab of the last focused normal window (the
 * connection runs in the service worker, which has no window of its own),
 * or, when that is one of the extension's own pages or there is none, the
 * most recently used active tab of a normal window that is not.
 */
export async function tabInFront(): Promise<TargetTab> {
	const own = chrome.runtime.getURL("");
	const usable = (tab: chrome.tabs.Tab) =>
		tab.id !== undefined && !(tab.url ?? "").startsWith(own);
	let tab: chrome.tabs.Tab | undefined;
	try {
		const focused = await chrome.windows.getLastFocused({
			windowTypes: ["normal"],
		});
		const [active] = await chrome.tabs.query({
			active: true,
			windowId: focused.id,
		});
		if (active && usable(active)) tab = active;
	} catch {
		// No normal window: none in front.
	}
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

/** A page of an http(s) site: the only pages the extension acts on (DEC-142). */
export const isSitePage = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * Why the extension may not read a tab: its address is hidden (no click on
 * its icon there and no host access, or a browser page: Chrome hides both
 * alike), no click on a page whose address is known, a browser page, the
 * Chrome Web Store, or no http(s) page.
 */
export type NoAccessReason =
	| "hidden"
	| "no-grant"
	| "browser-page"
	| "web-store"
	| "not-site";

/**
 * The extension may not run on this tab. The message is for the AI app;
 * the side panel writes its own sentence for `reason` (EQ 6).
 */
export class NoAccessError extends Error {
	readonly reason: NoAccessReason;
	constructor(reason: NoAccessReason, message: string) {
		super(message);
		this.reason = reason;
	}
}

const NO_GRANT = `The ${PRODUCT} may not read this tab yet. The user can click its icon in ${BROWSER}'s toolbar while on this tab, or click "Give access to all sites" in its ${PANEL}.${FIREFOX ? " In Firefox a click counts for that one page: each new page, of the same site too, needs another." : ""}`;

/**
 * The hosts Firefox keeps extensions out of (its default
 * `extensions.webextensions.restrictedDomains`).
 */
const FIREFOX_RESTRICTED = new Set([
	"accounts-static.cdn.mozilla.net",
	"accounts.firefox.com",
	"addons.cdn.mozilla.net",
	"addons.mozilla.org",
	"api.accounts.firefox.com",
	"content.cdn.mozilla.net",
	"discovery.addons.mozilla.org",
	"install.mozilla.org",
	"oauth.accounts.firefox.com",
	"profile.accounts.firefox.com",
	"support.mozilla.org",
	"sync.services.mozilla.com",
]);

/** A page of the browser's add-on store (or Firefox's other restricted hosts). */
function isStorePage(url: string): boolean {
	if (!FIREFOX) return /^https:\/\/chromewebstore\.google\.com\//i.test(url);
	try {
		const { protocol, hostname } = new URL(url);
		return protocol === "https:" && FIREFOX_RESTRICTED.has(hostname);
	} catch {
		return false;
	}
}

/** The answer to an access problem: its reason, and what the AI app is told. */
export function noAccess(url: string): NoAccessError {
	// Without a grant Chrome hides the tab's address: "" is any page.
	if (url === "")
		return new NoAccessError(
			"hidden",
			`${NO_GRANT} (Browser pages such as ${FIREFOX ? "about:" : "chrome://"} cannot be read at all.)`,
		);
	if (
		/^(chrome|edge|about|devtools|view-source|moz-extension|resource):/i.test(
			url,
		)
	)
		return new NoAccessError(
			"browser-page",
			`${BROWSER} does not let extensions read this tab (a browser page). Switch to a web page.`,
		);
	if (isStorePage(url)) return new NoAccessError("web-store", STORE_TEXT);
	if (!isSitePage(url))
		return new NoAccessError(
			"not-site",
			`The ${PRODUCT} works only on pages of http(s) sites (not file: or other pages). Switch to a web page.`,
		);
	return new NoAccessError("no-grant", NO_GRANT);
}

function send(tabId: number, request: ContentRequest): Promise<unknown> {
	return chrome.tabs.sendMessage(tabId, request);
}

/**
 * Ask the content script of `tab`. If it is not there yet (granted by a click
 * or host access, but the page changed since), put it in and ask again; if
 * the extension may not, say so. A page that does not answer within
 * `timeoutMs` (its main thread blocked, say) is given up.
 */
export function ask(
	tab: TargetTab,
	request: ContentRequest,
	timeoutMs = ASK_TIMEOUT_MS,
): Promise<ContentResponse> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`The page in the tab did not answer within ${timeoutMs / 1000} s (it may be busy or stuck).`,
					),
				),
			timeoutMs,
		);
	});
	return Promise.race([askNow(tab, request), timeout]).finally(() =>
		clearTimeout(timer),
	);
}

async function askNow(
	tab: TargetTab,
	request: ContentRequest,
): Promise<ContentResponse> {
	// Only http(s) pages, also where a click granted another (a file: page
	// with "Allow access to file URLs"). An empty address is a tab Chrome
	// hides from the extension: asking says so.
	if (tab.url !== "" && !isSitePage(tab.url)) throw noAccess(tab.url);
	let response: unknown;
	try {
		response = await send(tab.id, request);
	} catch {
		// Put in also while the page is still loading: a page with a
		// subresource that never loads stays "loading", and with only the
		// click's grant nothing else would ever put the script there (EQ 15).
		// During a navigation there may be no page to put it in yet.
		const { status } = await chrome.tabs.get(tab.id);
		try {
			await injectInto(tab.id);
		} catch {
			if (status !== "complete")
				throw new Error("The page in the tab is still loading; try again.");
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

/** The history of the tab of `tab`, as its page sees it. */
export async function askHistory(tab: TargetTab): Promise<PageHistory> {
	const response = await ask(tab, { type: "history" });
	if (!response.ok) throw new Error(response.error);
	const { ok: _, ...history } = response as { ok: true } & PageHistory;
	return history;
}

/** Tab `tabId` now (its address empty where Chrome hides it), `undefined` if closed. */
export async function getTab(tabId: number): Promise<TargetTab | undefined> {
	try {
		const tab = await chrome.tabs.get(tabId);
		return { id: tabId, url: tab.url ?? "", title: tab.title ?? "" };
	} catch {
		return undefined;
	}
}

/** The WebMCP tools of the page in `tab`. */
export async function askTools(tab: TargetTab): Promise<PageTools> {
	const response = await ask(tab, { type: "webmcp-list" });
	if (!response.ok) throw new Error(response.error);
	const { ok: _, ...tools } = response as { ok: true } & PageTools;
	return tools;
}

/**
 * A call's message that Chrome rejected. No content script to take it (the
 * page changed before the call): the tool did not run. The message reached
 * the page and its channel closed before the answer (Chrome's words for it,
 * also when the page went into the back/forward cache): the page went away
 * while the tool ran (it navigated, or the tab closed), and the tool may
 * have done its work (WM 2). Any other error is a plain failure: nothing
 * says the tool ran.
 */
export function callFailed(error: unknown): CallResult {
	const text = error instanceof Error ? error.message : String(error);
	if (/receiving end does not exist|no tab with id/i.test(text))
		return {
			ok: false,
			error: "The page in the tab changed before the call reached it.",
			gone: true,
		};
	if (/message (port|channel) (is )?closed|back\/forward cache/i.test(text))
		return {
			ok: false,
			error: "The page went away while the tool ran.",
			navigated: true,
		};
	return { ok: false, error: `The call did not reach the page: ${text}` };
}

/**
 * Call a page tool in tab `tabId` (only the content script already there: a
 * call does not inject it). The content script runs it only on the page it
 * was listed from (`target.documentId`), with the claim it was offered with.
 * Aborting `signal` cancels the call in the page. `vouch`: the user allowed
 * this call (the bridge's word, DEC-207); `state` goes with it, for a page
 * not told "on" yet (DEC-221).
 */
export async function callInTab(
	tabId: number,
	target: {
		documentId: string;
		name: string;
		readOnly: boolean;
		definition: string;
	},
	input: unknown,
	signal: AbortSignal,
	vouch?: Vouch,
	state?: ExtensionState,
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
			definition: target.definition,
			input,
			...(vouch !== undefined ? { vouch } : {}),
			...(vouch !== undefined && state !== undefined ? { state } : {}),
		})) as CallResult | undefined;
		return (
			response ?? {
				ok: false,
				error: "The page did not answer.",
				gone: true,
			}
		);
	} catch (error) {
		return callFailed(error);
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}
