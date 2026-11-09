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

/**
 * Whether tools of `origin` may be allowed at all: only an http(s) origin
 * names one site. Every opaque origin (a sandboxed frame, a data: page) is
 * "null", and allowing a tool there would allow it on all of them.
 */
export function allowable(origin: string): boolean {
	try {
		const url = new URL(origin);
		return (
			(url.protocol === "https:" || url.protocol === "http:") &&
			url.origin === origin
		);
	} catch {
		return false;
	}
}

export function isAllowed(
	allowed: AllowedTools,
	origin: string,
	name: string,
): boolean {
	return allowable(origin) && allowed[origin]?.includes(name) === true;
}

/**
 * Allow or stop allowing `name` on `origin`; returns the new state. An
 * origin that cannot be allowed (see `allowable`) changes nothing.
 */
export async function setAllowed(
	origin: string,
	name: string,
	on: boolean,
): Promise<AllowedTools> {
	const allowed = await loadAllowed();
	if (!allowable(origin)) return allowed;
	const names = new Set(allowed[origin] ?? []);
	if (on) names.add(name);
	else names.delete(name);
	if (names.size > 0) allowed[origin] = [...names].sort();
	else delete allowed[origin];
	await chrome.storage.local.set({ [KEY]: allowed });
	return allowed;
}
