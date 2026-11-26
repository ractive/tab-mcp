/**
 * Where AI apps' calls go, as the side panel says it (DEC-230): a line in
 * the card of the tab in front, not a tooltip (DEC-160), and whether its
 * "Work here" button is there.
 */

import type { TabView, TargetView } from "../protocol.ts";

export const TARGET_PREFIX = "AI apps work in: ";

/**
 * The line: the tab in front, or the pinned tab by its title. Signed in
 * (DEC-233), the browser of the group comes first where the relay named it
 * ("work Chrome › Shop (pinned)", "this browser › the tab in front").
 */
export function targetLine(target: TargetView | undefined): string {
	const browser = target?.browser;
	const where =
		browser === undefined
			? TARGET_PREFIX
			: `${TARGET_PREFIX}${browser.self ? "this browser" : browser.label} › `;
	if (target === undefined || target.mode === "front")
		return `${where}the tab in front`;
	if (target.elsewhere) return `${where}a tab there (pinned)`;
	const { pinned } = target;
	if (pinned === undefined)
		return `${TARGET_PREFIX}the tab in front, pinned at their next call`;
	if (pinned.closed)
		return `${where}a pinned tab that was closed. Their calls fail until a tab is pinned again: Work here on another tab.`;
	if (pinned.title === "")
		return `${where}a tab the extension may not read now (pinned)`;
	return `${where}${pinned.title} (pinned)`;
}

/**
 * "Work here" is there for a tab the extension may read (its tools could
 * be read, or it has none), unless it is the pinned tab already.
 */
export function workHereFor(
	tab: TabView | undefined,
	target: TargetView | undefined,
): boolean {
	if (tab?.tabId === undefined || tab.webmcp === undefined) return false;
	const pinned = target?.mode === "pinned" ? target.pinned : undefined;
	return !(
		pinned !== undefined &&
		!pinned.closed &&
		pinned.tabId === tab.tabId
	);
}
