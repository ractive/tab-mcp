/**
 * Where AI apps' calls go, as the side panel says it (DEC-230): a line in
 * the card of the tab in front, not a tooltip (DEC-160), and whether its
 * "Work here" button is there.
 */

import type { TabView, TargetView } from "../protocol.ts";

export const TARGET_PREFIX = "AI apps work in: ";

/** The line: the tab in front, or the pinned tab by its title. */
export function targetLine(target: TargetView | undefined): string {
	if (target === undefined || target.mode === "front")
		return `${TARGET_PREFIX}the tab in front`;
	const { pinned } = target;
	if (pinned === undefined)
		return `${TARGET_PREFIX}the tab in front, pinned at their next call`;
	if (pinned.closed)
		return `${TARGET_PREFIX}a pinned tab that was closed. Their calls fail until a tab is pinned again: Work here on another tab.`;
	if (pinned.title === "")
		return `${TARGET_PREFIX}a tab the extension may not read now (pinned)`;
	return `${TARGET_PREFIX}${pinned.title} (pinned)`;
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
