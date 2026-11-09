/**
 * What the side panel's "AI app" card shows for a state: the next step is the
 * one that stands out. Off: "Turn on AI access". On with no app paired: the
 * address and the code at once. Apps paired: the apps, and "+ Add another AI
 * app" as a link, which shows the address and code again.
 */

import type { PanelState, TabView } from "../protocol.ts";

const STATUS_TEXT: Record<PanelState["status"], string> = {
	off: "AI access is off · paired apps stay paired",
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
				: STATUS_TEXT[state.status],
		switchOn: state.status !== "off",
		turnOn: state.status === "off",
		pairing,
		addApp: connected && paired && !pairing,
		done: pairing && paired,
		address: pairing ? (state.address ?? "") : "",
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

/** "Allow all" over the tab's tool list, or why it is not there. */
export interface AllowAllView {
	shown: boolean;
	label: "Allow all" | "Ask for all";
	/** The tools it is for: listed, offered, not read-only. */
	names: string[];
	/** What a click asks for: allow them (true), or ask first again. */
	on: boolean;
}

/**
 * "Allow all" for the tools listed now on a site whose tools can be allowed;
 * once they all are, "Ask for all". A tool the page adds later is not
 * among them: it asks first.
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
		label: all ? "Ask for all" : "Allow all",
		names,
		on: !all,
	};
}
