/**
 * The page tools the user allowed to run without asking, per site: in the
 * side panel a tool's "asks first" turns into "allowed". Kept in the
 * extension's storage by exact origin and the page's tool name, so another
 * site's tool of the same name still asks.
 */

const KEY = "allowedTools";

/** Origin → the page's tool names allowed there. */
export type AllowedTools = Record<string, string[]>;

export async function loadAllowed(): Promise<AllowedTools> {
	const stored = (await chrome.storage.local.get(KEY))[KEY];
	return typeof stored === "object" && stored !== null
		? (stored as AllowedTools)
		: {};
}

export function isAllowed(
	allowed: AllowedTools,
	origin: string,
	name: string,
): boolean {
	return allowed[origin]?.includes(name) === true;
}

/** Allow or stop allowing `name` on `origin`; returns the new state. */
export async function setAllowed(
	origin: string,
	name: string,
	on: boolean,
): Promise<AllowedTools> {
	const allowed = await loadAllowed();
	const names = new Set(allowed[origin] ?? []);
	if (on) names.add(name);
	else names.delete(name);
	if (names.size > 0) allowed[origin] = [...names].sort();
	else delete allowed[origin];
	await chrome.storage.local.set({ [KEY]: allowed });
	return allowed;
}
