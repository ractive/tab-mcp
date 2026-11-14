/**
 * What the side panel's "AI app" card shows for a state: the next step is the
 * one that stands out. Off: "Turn on AI access". On with no app paired: the
 * address and the code at once. Apps paired: the apps, and "+ Add another AI
 * app" as a link, which shows the address and code again. Also the tab
 * card's texts, in the user's words.
 */

import type { PanelState, TabView } from "../protocol.ts";
import type { NoAccessReason } from "../tabs.ts";

const STATUS_TEXT: Record<PanelState["status"], string> = {
	off: "AI access is off",
	connecting: "Connecting…",
	retrying: "Connection lost · retrying",
	waiting: "On · no AI app paired yet",
	on: "Connected",
};

export interface CardView {
	stateText: string;
	/** The AI access switch is on (also while connecting or retrying). */
	switchOn: boolean;
	/** The primary "Turn on AI access". */
	turnOn: boolean;
	/** The address and the code (pairing on in the worker). */
	pairing: boolean;
	/** "+ Add another AI app". */
	addApp: boolean;
	/** "Done" under the code: only when adding another app. */
	done: boolean;
	/** The address, shown only while pairing. */
	address: string;
	/** What the extension does and which relay it uses: no app paired yet (EQ 7). */
	intro: boolean;
	/** Disconnect works: only while connected, through the relay (EQ 8). */
	disconnect: boolean;
	/** Why the paired apps have no Disconnect now ("" when they have). */
	grantsNote: string;
}

/** The card for `state`; `adding`: the user asked to add another app. */
export function cardView(state: PanelState, adding: boolean): CardView {
	const connected = state.status === "waiting" || state.status === "on";
	const paired = state.grants.length > 0;
	const pairing = connected && (!paired || adding);
	const names = state.grants.map((g) => g.name || g.host);
	return {
		stateText:
			state.status === "on"
				? `Connected · ${names.join(", ")}`
				: state.status === "off" && paired
					? "AI access is off · paired apps stay paired"
					: STATUS_TEXT[state.status],
		switchOn: state.status !== "off",
		turnOn: state.status === "off",
		pairing,
		addApp: connected && paired && !pairing,
		done: pairing && paired,
		address: pairing ? (state.address ?? "") : "",
		intro: !paired,
		disconnect: connected,
		grantsNote:
			!paired || connected
				? ""
				: state.status === "off"
					? "Turn on AI access to disconnect an app."
					: "An app can be disconnected once connected again.",
	};
}

/** What the extension does, with the relay's host, for a first look (EQ 7). */
export function introText(relay: string): string {
	let host = relay;
	try {
		host = new URL(relay).host || relay;
	} catch {
		// Shown as it is.
	}
	return `Lets an AI app outside this browser use the tab in front: read it, navigate it and call the page's WebMCP tools. AI access connects to the relay ${host}.`;
}

const CLICK_ICON =
	"Click the tab-mcp icon in Chrome's toolbar to let it read this tab.";
const BROWSER_PAGE = "Chrome does not let extensions read browser pages.";

/**
 * Why the tab cannot be read, in the panel's words (EQ 6). Chrome hides the
 * address of a page the extension may not read and of its own pages alike:
 * with host access on all sites a hidden address can only be a browser page,
 * without it either, and the click on the icon helps only on a web page.
 */
export function noAccessText(
	reason: NoAccessReason,
	allSites: boolean,
): string {
	switch (reason) {
		case "hidden":
			return allSites
				? BROWSER_PAGE
				: `${CLICK_ICON} Chrome's own pages, such as a new tab, cannot be read at all.`;
		case "no-grant":
			return CLICK_ICON;
		case "browser-page":
			return BROWSER_PAGE;
		case "web-store":
			return "Chrome does not let extensions read the Chrome Web Store.";
		case "not-site":
			return "tab-mcp reads only pages of http(s) sites.";
	}
}

/** The tab card's line about the page's tools, when it has none to list (EQ 7). */
export function webmcpNote(
	tab: TabView | undefined,
): "no-webmcp" | "no-tools" | undefined {
	if (tab?.webmcp === undefined) return undefined;
	if (!tab.webmcp.available) return "no-webmcp";
	return tab.webmcp.tools === 0 ? "no-tools" : undefined;
}

/** A confirming click this soon after the first one (a double click) counts as nothing. */
export const CONFIRM_DELAY_MS = 750;

/** Whether a second click, `now`, confirms a first one at `armedAt`. */
export function confirms(armedAt: number, now: number): boolean {
	return now - armedAt >= CONFIRM_DELAY_MS;
}

/** How long the switch shows the user's flip while waiting for the worker. */
export const SWITCH_WAIT_MS = 10_000;

/** The user's last flip of the AI access switch, until the state follows. */
export interface SwitchIntent {
	on: boolean;
	until: number;
}

/**
 * The switch as shown: the user's flip, until a state that matches it comes
 * (a state sent before the connect or stop was done would flip it back) or
 * the wait runs out.
 */
export function switchShown(
	stateOn: boolean,
	intent: SwitchIntent | undefined,
	now: number,
): { checked: boolean; intent: SwitchIntent | undefined } {
	if (intent === undefined || stateOn === intent.on || now >= intent.until)
		return { checked: stateOn, intent: undefined };
	return { checked: intent.on, intent };
}

/**
 * Call `redraw` once `intent` has run out, if it is still the user's last
 * flip (`current()`): `switchShown` drops it only when it is asked again.
 */
export function switchExpiry(
	intent: SwitchIntent,
	current: () => SwitchIntent | undefined,
	redraw: () => void,
	now: () => number = Date.now,
	schedule: (run: () => void, ms: number) => unknown = setTimeout,
): void {
	schedule(
		() => {
			if (current() === intent) redraw();
		},
		Math.max(0, intent.until - now()),
	);
}

/** The button over the tab's tool list, or why it is not there. */
export interface AllowAllView {
	shown: boolean;
	label: typeof TURN_OFF_ASK_FIRST | typeof TURN_ON_ASK_FIRST;
	/** The tools it is for: listed, offered, not read-only. */
	names: string[];
	/** What a click asks for: allow them (true), or ask first again. */
	on: boolean;
}

/**
 * The labels use the per-tool switch's word, "Ask first" (DEC-176); the line
 * under the button names the site and every paired AI app (EQ 9).
 */
export const TURN_OFF_ASK_FIRST = "Turn off Ask first";
export const TURN_ON_ASK_FIRST = "Turn on Ask first";

/**
 * What a tool's "Ask first" switch does on `site`: a line over the tool
 * list, for everyone, not a tooltip on each switch (DEC-160).
 */
export const askFirstNote = (site: string): string =>
	`Ask first, on: the tool asks you before each call. Off: it runs without asking on ${site}, for every paired AI app.`;

/**
 * "Turn off Ask first" for the tools listed now on a site whose tools can be
 * allowed; once none asks, "Turn on Ask first". A tool the page adds later is
 * not among them: it asks first.
 */
export function allowAllView(tab: TabView | undefined): AllowAllView {
	const names = (tab?.tools ?? [])
		.filter((t) => !t.readOnly && t.problem === undefined)
		.map((t) => t.name);
	const all =
		names.length > 0 &&
		(tab?.tools ?? []).every(
			(t) => t.readOnly || t.problem !== undefined || t.allowed,
		);
	return {
		shown: tab?.canAllow === true && names.length > 0,
		label: all ? TURN_ON_ASK_FIRST : TURN_OFF_ASK_FIRST,
		names,
		on: !all,
	};
}

/**
 * The button's accessible name: what it does, how many tools, which site and
 * for whom, as the line under it says to a sighted user.
 */
export function allowAllLabel(view: AllowAllView, site: string): string {
	const n = view.names.length;
	return `${view.label} for the ${n} ${n === 1 ? "tool" : "tools"} listed on ${site}, for every paired AI app`;
}
