/**
 * "Fill in the code for me" under "Connect your AI app" (DEC-203, DEC-210):
 * a switch, off by default, also for a user who gave access to all sites.
 * On, the extension asks and fills in its code when an AI app opens the
 * relay's pairing page in this browser; it needs the relay's site, one
 * origin of the optional host permissions, asked for when the switch is
 * turned on and the extension does not have it yet. Off, it gives the
 * relay's site back (not access to all sites), and the code is typed by
 * hand, as always.
 */

import { relayPageOrigin } from "@ractive-ch/tab-mcp-client/extension";
import { BROWSER } from "../browser.ts";
import { fillAccess } from "../fill.ts";
import type { PanelState } from "../protocol.ts";

export interface FillView {
	/** What the switch does, and why it went off by itself: one line. */
	text: string;
	/** The switch is there. */
	shown: boolean;
	/** The switch is on: the setting, and the relay's site granted. */
	checked: boolean;
}

/** What the panel says for a relay address that gives no pattern. */
export const NO_PATTERN =
	"tab-mcp cannot fill in the code for this relay's address: type the code instead.";

/** What the panel says when the browser would not ask for the relay's site. */
export const NOT_ASKED =
	"tab-mcp could not ask for access to the relay's site: type the code instead.";

/**
 * The view for relay `relay`: filling in `on` or not, its site `granted` or
 * not, and `lost` when it went off by itself because the site was taken
 * away. The switch shows what is in effect: on only with the site. Without
 * a pattern for the relay's address, one sentence and no switch, unless the
 * setting is on there and is to be turned off.
 */
export function fillView(
	relay: string,
	on: boolean,
	granted: boolean,
	lost: boolean,
): FillView {
	const origin = relayPageOrigin(relay);
	if (origin === undefined || fillAccess(relay) === undefined)
		return { text: NO_PATTERN, shown: on, checked: on };
	const host = new URL(origin).host;
	const does = `While this is on, tab-mcp asks you and fills in the code when an AI app opens the sign-in page of ${host} in this ${BROWSER} profile.`;
	if (granted) return { text: does, shown: true, checked: on };
	// On, but the site was taken away: the worker turns it off (`lost`).
	const why =
		on || lost
			? `tab-mcp no longer has access to ${host}, so this went off. `
			: "";
	return {
		text: `${why}${does} ${BROWSER} asks you for access to that site when you turn it on.`,
		shown: true,
		checked: false,
	};
}

/** The part of the panel this works with. */
export interface FillElements {
	box: HTMLElement;
	text: HTMLElement;
	/** The switch's label, and the switch in it. */
	label: HTMLElement;
	toggle: HTMLInputElement;
}

/** The browser's permissions, as the panel uses them (the tests give their own). */
export type FillPermissions = Pick<
	typeof chrome.permissions,
	"contains" | "request" | "onAdded" | "onRemoved"
>;

/**
 * Wire the switch; returns what takes each state. `setFill` tells the
 * worker, with an id that comes back in the state once the worker handled
 * it. Whether the relay's site is granted is the browser's to say, asked
 * again when the relay, the setting or the permissions change.
 *
 * A click is the switch's state until the worker answers it (or the browser
 * declines): the worker's own permission changes meanwhile (giving the site
 * back for an "off") show neither a flicker nor "no longer has access".
 */
export function fillPanel(
	elements: FillElements,
	setFill: (on: boolean, id: string) => void,
	problem: (text: string) => void,
	permissions: FillPermissions = chrome.permissions,
): { show(state: PanelState): void } {
	let relay: string | undefined;
	let on = false;
	let lost = false;
	let allSites = false;
	let granted = false;
	let checks = 0;
	// What the user's last click turned the switch to, and the id of the
	// command sent for it, until the worker's state answers that id.
	let wanted: boolean | undefined;
	let asked: string | undefined;
	let clicks = 0;
	const render = () => {
		const view =
			relay === undefined ? undefined : fillView(relay, on, granted, lost);
		elements.box.hidden = view === undefined;
		// While a click waits, no "why": the worker has not answered yet.
		const text =
			relay !== undefined && wanted !== undefined
				? fillView(relay, false, granted, false).text
				: (view?.text ?? "");
		if (elements.text.textContent !== text) elements.text.textContent = text;
		elements.label.hidden = view?.shown !== true;
		const checked = wanted ?? view?.checked === true;
		elements.toggle.checked = checked;
		elements.toggle.setAttribute("aria-checked", String(checked));
	};
	const check = async () => {
		const check = ++checks;
		const access = relay === undefined ? undefined : fillAccess(relay);
		const has =
			access !== undefined &&
			(await permissions.contains(access).catch(() => false));
		if (check !== checks) return;
		granted = has;
		render();
	};
	const send = (value: boolean) => {
		asked = crypto.randomUUID();
		setFill(value, asked);
	};
	const notTurnedOn = () => {
		wanted = undefined;
		asked = undefined;
		render();
	};
	elements.toggle.addEventListener("click", () => {
		const click = ++clicks;
		wanted = elements.toggle.checked;
		asked = undefined;
		elements.toggle.setAttribute("aria-checked", String(wanted));
		if (!wanted) {
			send(false);
			return;
		}
		const access = relay === undefined ? undefined : fillAccess(relay);
		if (access === undefined) {
			problem(NO_PATTERN);
			notTurnedOn();
			return;
		}
		// From the click, before any await: the browser asks the user, or
		// answers at once when the extension has the site already. Declined
		// or not asked, the switch goes back to off.
		permissions.request(access).then(
			(given) => {
				if (click !== clicks) {
					// Clicked again while the browser asked. Turned off since:
					// the site granted now goes back, filling in stays off.
					if (given && wanted !== true && !on)
						setFill(false, crypto.randomUUID());
					return;
				}
				if (given) send(true);
				else notTurnedOn();
			},
			() => {
				if (click !== clicks) return;
				problem(NOT_ASKED);
				notTurnedOn();
			},
		);
	});
	permissions.onAdded.addListener(() => void check());
	permissions.onRemoved.addListener(() => void check());
	return {
		show(state) {
			const fill = state.fillCode === true;
			const gone = state.fillLost === true;
			// The worker answered the click, or another relay is used.
			const settled =
				wanted !== undefined &&
				((asked !== undefined && state.fillAnswered === asked) ||
					state.relay !== relay);
			if (settled) {
				wanted = undefined;
				asked = undefined;
			}
			if (
				!settled &&
				state.relay === relay &&
				fill === on &&
				gone === lost &&
				state.allSites === allSites
			)
				return;
			relay = state.relay;
			on = fill;
			lost = gone;
			allSites = state.allSites;
			// Rendered once the browser says whether the site is granted:
			// not "no longer has access" for a moment while it is.
			void check();
		},
	};
}
