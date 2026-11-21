/**
 * What the side panel's "AI app" card shows for a state: the next step is the
 * one that stands out. Off: "Turn on AI access". On with no app paired: the
 * address and the code at once. Apps paired: the apps, and "+ Add another AI
 * app" as a link, which shows the address and code again. Also the tab
 * card's texts, in the user's words.
 */

import { BROWSER, STORE_TEXT } from "../browser.ts";
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
	/**
	 * The state line is shown. Not while connected with apps paired: their
	 * rows' green dots say it, and a line with a dot and their names above
	 * them reads as one more app. It stays for screen readers (a status).
	 */
	stateShown: boolean;
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
		stateShown: !(state.status === "on" && paired),
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

const CLICK_ICON = `Click the tab-mcp icon in ${BROWSER}'s toolbar to let it read this tab.`;
const BROWSER_PAGE = `${BROWSER} does not let extensions read browser pages.`;

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
			return allSites ? BROWSER_PAGE : CLICK_ICON;
		case "no-grant":
			return CLICK_ICON;
		case "browser-page":
			return BROWSER_PAGE;
		case "web-store":
			return STORE_TEXT;
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

/** "A", "A and B", "A, B and C". */
const listOf = (names: string[]) =>
	names.length < 2
		? (names[0] ?? "")
		: `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * The tab card's lines about a page with the client library (DEC-207): that
 * it has tab-mcp built in (`builtIn`), and which AI apps paired with the
 * extension are connected to the page directly too (`both`), by name and
 * host as the page announced them. Such an app sees the page's tools twice.
 */
export function libraryNotes(
	tab: TabView | undefined,
	grants: PanelState["grants"],
): { builtIn: boolean; both?: string } {
	const library = tab?.library;
	if (library === undefined) return { builtIn: false };
	const names = [
		...new Set(
			grants
				.filter((g) =>
					library.apps.some((a) => a.host === g.host && a.name === g.name),
				)
				.map((g) => (g.name ? `${g.name} (${g.host})` : g.host)),
		),
	];
	if (names.length === 0) return { builtIn: true };
	const one = names.length === 1;
	return {
		builtIn: true,
		both: `${listOf(names)} ${one ? "is" : "are"} also connected to this page directly, so ${one ? "it sees" : "they see"} the page's tools twice, once through each. Disconnect ${one ? "it" : "them"} in one of the two: above in this panel, or in the page.`,
	};
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

/** The switch over the tab's tool list, or why it is not there. */
export interface AllowAllView {
	shown: boolean;
	/** On: every tool it is for is allowed. */
	checked: boolean;
	/** The tools it is for: listed, offered, not read-only. */
	names: string[];
	/** What a click asks for: allow them (true), or ask first again. */
	on: boolean;
}

/**
 * A switch for all the tools' "Always allow" switches (DEC-184), as a
 * "select all": the line over the list names the site and every paired AI
 * app (EQ 9).
 */
export const ALWAYS_ALLOW_ALL = "Always allow all";

/**
 * What a tool's "Always allow" switch does on `site`: a line over the tool
 * list, for everyone, not a tooltip on each switch (DEC-160).
 */
export const alwaysAllowNote = (site: string): string =>
	`Always allow, on: the tool runs without asking on ${site}, for every paired AI app. Off: it asks you before each call.`;

/**
 * "Always allow all" for the tools listed now on a site whose tools can be
 * allowed: on once none asks; turned off, every one asks again. Off while
 * one asks, and a click allows the rest. A tool the page adds later is not
 * among them: it asks first, and the switch is off again.
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
		checked: all,
		names,
		on: !all,
	};
}

/**
 * The switch's accessible name: what it is for, how many tools, which site
 * and for whom, as the line over the list says to a sighted user; on or off
 * is its own state.
 */
export function allowAllLabel(view: AllowAllView, site: string): string {
	const n = view.names.length;
	// Starts with the visible label, so speech input finds it (WCAG 2.5.3).
	return `${ALWAYS_ALLOW_ALL}: the ${n} ${n === 1 ? "tool" : "tools"} listed on ${site}, for every paired AI app`;
}
