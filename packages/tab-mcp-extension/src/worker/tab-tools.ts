/**
 * `list_tabs` and `use_tab` (iteration 53, DEC-230): the tabs an AI app may
 * work in, and pinning one of them.
 *
 * An AI app sees only what it saw before: tabs the extension may read (the
 * user's click on its icon there, or "Give access to all sites"), the rule
 * of `page_info`. `list_tabs` names those tabs, their titles and addresses
 * (the pages' own text), and of every other tab only how many there are:
 * the browser gives the extension no address or title of a tab it may not
 * read, and none of them reaches the AI app. `use_tab` pins only a tab the
 * extension may read now.
 */

import type { ModelContextTool } from "@ractive-ch/tab-mcp-client";
import { PANEL, PRODUCT } from "../browser.ts";
import type { PageInfo } from "../messages.ts";
import { mayList, type TargetTab } from "../tabs.ts";
import { type TargetSetting, type Targets, tabArgument } from "./targets.ts";
import { TAB_ARGUMENT } from "./tools.ts";

/** `list_tabs` names at most this many tabs; past that it counts them. */
export const MAX_LISTED_TABS = 100;
/** A title in `list_tabs` is cut to this many characters. */
export const MAX_TAB_TITLE = 200;
/** An address in `list_tabs` is cut to this many characters. */
export const MAX_TAB_URL = 2048;

/** What the two tools need from the browser. */
export interface TabListChrome {
	/** The tabs of the normal windows, the extension's own pages left out (`normalTabs`). */
	tabs(): Promise<TargetTab[]>;
	/** The tab in front (`tabInFront`); throws when there is none. */
	front(): Promise<TargetTab>;
	/** The page in `tab`; throws `page_info`'s access message if it may not be read. */
	page(tab: TargetTab): Promise<PageInfo>;
}

/** A tab as `list_tabs` names it. */
export interface ListedTab {
	/** The id to pass as `tab`. */
	tab: string;
	title: string;
	url: string;
	/** The tab in front of the user's browser window. */
	inFront?: true;
	/** The pinned tab (mode "a pinned tab"). */
	pinned?: true;
}

/** What `list_tabs` answers. */
export interface TabList {
	/** Where calls without a `tab` argument go. */
	mode: "the tab in front" | "a pinned tab";
	tabs: ListedTab[];
	/** Tabs the extension may read beyond `MAX_LISTED_TABS`. */
	more?: number;
	/** Open tabs the extension may not read: only how many. */
	notReadable?: number;
	note: string;
}

const cut = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Where a call without `tab` goes, as `list_tabs` says it. */
function whereCallsGo(
	setting: TargetSetting,
	pin: "none" | "listed" | "closed" | "not-readable",
): string {
	if (setting.mode === "front")
		return "Calls without a tab argument go to the tab in front of the user's browser window (inFront).";
	if (pin === "none")
		return "Calls without a tab argument go to a pinned tab; none is pinned yet, so the next one pins the tab in front.";
	if (pin === "closed")
		return "Calls without a tab argument go to the pinned tab, which was closed: they fail until use_tab pins another tab.";
	if (pin === "not-readable")
		return `Calls without a tab argument go to the pinned tab, which the ${PRODUCT} may not read now: they fail until the user gives it access there or use_tab pins another tab.`;
	return "Calls without a tab argument go to the pinned tab (pinned), wherever the user is.";
}

/** `list_tabs` and `use_tab`, for the connection's `TabMcp`. */
export function tabTools(
	targets: Targets,
	chrome: TabListChrome,
	refresh: () => Promise<void>,
): ModelContextTool[] {
	return [
		{
			name: "list_tabs",
			title: "Tabs you may use",
			description: `The tabs of the user's browser the ${PRODUCT} may read (the user clicked its icon there, or gave it access to all sites), with their ids, titles and addresses, which one is in front and which one is pinned; of the other tabs only how many there are. Pass a tab's id as tab to page_info, webmcp_tools, webmcp_call, navigate, go_back, go_forward or reload to work in it without moving the pin, or call use_tab to pin it. After list_tabs, pass tab with every call: another conversation may pin another tab. The titles and addresses are the pages' own text.`,
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			async execute(): Promise<TabList> {
				const [all, setting, front] = await Promise.all([
					chrome.tabs(),
					targets.setting(),
					chrome.front().catch(() => undefined),
				]);
				const readable = all.filter((tab) => mayList(tab.url));
				const pin = setting.mode === "pinned" ? setting.pin : undefined;
				const pinState =
					pin === undefined
						? "none"
						: readable.some((tab) => tab.id === pin)
							? "listed"
							: all.some((tab) => tab.id === pin)
								? "not-readable"
								: "closed";
				const listed = readable.slice(0, MAX_LISTED_TABS).map(
					(tab): ListedTab => ({
						tab: tabArgument(tab.id),
						title: cut(tab.title, MAX_TAB_TITLE),
						url: cut(tab.url, MAX_TAB_URL),
						...(tab.id === front?.id ? { inFront: true as const } : {}),
						...(tab.id === pin ? { pinned: true as const } : {}),
					}),
				);
				const more = readable.length - listed.length;
				const notReadable = all.length - readable.length;
				return {
					mode: setting.mode === "front" ? "the tab in front" : "a pinned tab",
					tabs: listed,
					...(more > 0 ? { more } : {}),
					...(notReadable > 0 ? { notReadable } : {}),
					note: [
						whereCallsGo(setting, pinState),
						notReadable > 0
							? `${notReadable} more tab${notReadable === 1 ? " is" : "s are"} open that the ${PRODUCT} may not read (no click on its icon there and no access to all sites, or a browser page); they are not listed, and you cannot use them.`
							: "",
						more > 0
							? `${more} more tab${more === 1 ? "" : "s"} it may read ${more === 1 ? "is" : "are"} not listed (at most ${MAX_LISTED_TABS} are).`
							: "",
						"Titles and addresses are the pages' own text.",
					]
						.filter((line) => line !== "")
						.join(" "),
				};
			},
		},
		{
			name: "use_tab",
			title: "Work in a tab",
			description: `Pins a tab from list_tabs: calls without a tab argument go to it from now on, wherever the user is, until another tab is pinned (use_tab, or the user in the ${PANEL}). If the user had AI apps work in the tab in front, this changes that setting to a pinned tab; the ${PANEL} shows it. The page_<name> tools become that tab's. Only a tab the ${PRODUCT} may read can be pinned. Returns the tab's page_info. The pin is shared by every conversation: keep passing tab with your calls.`,
			inputSchema: {
				type: "object",
				properties: {
					tab: {
						...TAB_ARGUMENT,
						description: "The id of the tab to pin, from list_tabs.",
					},
				},
				required: ["tab"],
				additionalProperties: false,
			},
			// It changes where later calls go, nothing in a page.
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				untrustedContentHint: true,
			},
			async execute(args) {
				const tab = await targets.peek(String(args["tab"]));
				// Only a tab the extension may read now: this throws
				// page_info's message.
				const page = await chrome.page(tab);
				await targets.use(tab.id);
				// The page_<name> tools are that tab's before the answer.
				await refresh().catch(() => {});
				return {
					tab: tabArgument(tab.id),
					pinned: true,
					...page,
					note: "Calls without a tab argument now go to this tab, wherever the user is, until another one is pinned.",
				};
			},
		},
	];
}
