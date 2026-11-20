/**
 * "Fill in the code for me" under "Pair an AI app" (DEC-203): a setting of
 * its own, off by default, also for a user who gave access to all sites.
 * Turned on, the extension asks and fills in its code when an AI app opens
 * the relay's pairing page in this browser; it needs the relay's site, one
 * origin of the optional host permissions, asked for with this click when
 * the extension does not have it yet. "Stop filling in the code" turns it
 * off and gives the relay's site back (not access to all sites). Off,
 * nothing changes: the code is typed by hand, as always.
 */

import { relayPageOrigin } from "@ractive-ch/tab-mcp-client/extension";
import { BROWSER } from "../browser.ts";
import { fillAccess } from "../fill.ts";
import type { PanelState } from "../protocol.ts";

export interface FillView {
	/** What filling in does, or would do once on: one line. */
	text: string;
	/** "Fill in the code for me": off, or on without the relay's site. */
	on: boolean;
	/** "Stop filling in the code": while it is on. */
	off: boolean;
}

/** What the panel says for a relay address that gives no pattern. */
export const NO_PATTERN =
	"tab-mcp cannot fill in the code for this relay's address: type the code instead.";

/** What the panel says when the browser would not ask for the relay's site. */
export const NOT_ASKED =
	"tab-mcp could not ask for access to the relay's site: type the code instead.";

/**
 * The view for relay `relay`: filling in `on` or not, its site `granted` or
 * not. Without a pattern for the relay's address, one sentence and no button.
 */
export function fillView(
	relay: string,
	on: boolean,
	granted: boolean,
): FillView {
	const origin = relayPageOrigin(relay);
	if (origin === undefined || fillAccess(relay) === undefined)
		return { text: NO_PATTERN, on: false, off: on };
	const where = `the sign-in page of ${new URL(origin).host} in this ${BROWSER} profile`;
	if (on && granted)
		return {
			text: `When an AI app opens ${where}, tab-mcp asks you and fills in the code.`,
			on: false,
			off: true,
		};
	return {
		text: `Then, when an AI app opens ${where}, tab-mcp asks you and fills in the code.${granted ? "" : ` ${BROWSER} asks you first.`}`,
		on: true,
		// On, but the site was taken away (in the browser's settings).
		off: on,
	};
}

/** The part of the panel this works with. */
export interface FillElements {
	box: HTMLElement;
	text: HTMLElement;
	on: HTMLButtonElement;
	off: HTMLButtonElement;
}

/**
 * Wire the buttons; returns what takes each state. `setFill` tells the
 * worker. Whether the relay's site is granted is the browser's to say, asked
 * again when the relay, the setting or the permissions change.
 */
export function fillPanel(
	elements: FillElements,
	setFill: (on: boolean) => void,
	problem: (text: string) => void,
): { show(state: PanelState): void } {
	let relay: string | undefined;
	let on = false;
	let allSites = false;
	let granted = false;
	let checks = 0;
	const render = () => {
		const view = relay === undefined ? undefined : fillView(relay, on, granted);
		elements.box.hidden = view === undefined;
		if (elements.text.textContent !== (view?.text ?? ""))
			elements.text.textContent = view?.text ?? "";
		elements.on.hidden = view?.on !== true;
		elements.off.hidden = view?.off !== true;
	};
	const check = async () => {
		const check = ++checks;
		const access = relay === undefined ? undefined : fillAccess(relay);
		const has =
			access !== undefined &&
			(await chrome.permissions.contains(access).catch(() => false));
		if (check !== checks) return;
		granted = has;
		render();
	};
	elements.on.addEventListener("click", () => {
		const access = relay === undefined ? undefined : fillAccess(relay);
		if (access === undefined) {
			problem(NO_PATTERN);
			return;
		}
		// From the click, before any await: the browser asks the user, or
		// answers at once when the extension has the site already.
		chrome.permissions.request(access).then(
			(given) => {
				if (given) setFill(true);
				void check();
			},
			() => problem(NOT_ASKED),
		);
	});
	elements.off.addEventListener("click", () => setFill(false));
	chrome.permissions.onAdded.addListener(() => void check());
	chrome.permissions.onRemoved.addListener(() => void check());
	return {
		show(state) {
			const fill = state.fillCode === true;
			if (state.relay === relay && fill === on && state.allSites === allSites)
				return;
			relay = state.relay;
			on = fill;
			allSites = state.allSites;
			render();
			void check();
		},
	};
}
