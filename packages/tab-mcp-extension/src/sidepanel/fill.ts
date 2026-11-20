/**
 * "Fill in the code for me" under "Pair an AI app" (DEC-203): the user gives
 * the extension access to the relay's site, and from then on, when an AI app
 * opens the relay's pairing page in this browser, the extension asks and
 * fills in its code there. Without that access nothing changes: the code is
 * typed by hand, as always. The access is one origin of the optional host
 * permissions, asked for with this click (the browser asks the user);
 * "access to all sites" covers it too.
 */

import { BROWSER } from "../browser.ts";
import { fillAccess, relayPageOrigin } from "../fill.ts";
import type { PanelState } from "../protocol.ts";

export interface FillView {
	/** What filling in does, or would do once allowed: one line. */
	text: string;
	/** "Fill in the code for me": the access is not there yet. */
	on: boolean;
	/** "Stop filling in the code": the access is the relay's alone. */
	off: boolean;
}

/**
 * The view for relay `relay`, with access to its site `granted` or not;
 * `undefined` for an address that has no site. With access to all sites the
 * relay's cannot be taken away alone: no "Stop" then.
 */
export function fillView(
	relay: string,
	granted: boolean,
	allSites: boolean,
): FillView | undefined {
	const origin = relayPageOrigin(relay);
	if (origin === undefined) return undefined;
	const where = `the sign-in page of ${new URL(origin).host} in this ${BROWSER} profile`;
	return granted
		? {
				text: `When an AI app opens ${where}, tab-mcp asks you and fills in the code.`,
				on: false,
				off: !allSites,
			}
		: {
				text: `Then, when an AI app opens ${where}, tab-mcp asks you and fills in the code. ${BROWSER} asks you first.`,
				on: true,
				off: false,
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
 * Wire the buttons; returns what takes each state. Whether the access is
 * there is the browser's to say, asked again when the relay or the
 * permissions change.
 */
export function fillPanel(
	elements: FillElements,
	problem: (text: string) => void,
): { show(state: PanelState): void } {
	let relay: string | undefined;
	let allSites = false;
	let granted = false;
	let checks = 0;
	const render = () => {
		const view =
			relay === undefined ? undefined : fillView(relay, granted, allSites);
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
		if (access === undefined) return;
		// From the click, before any await: the browser asks the user.
		chrome.permissions
			.request(access)
			.then(check, (error: unknown) => problem(String(error)));
	});
	elements.off.addEventListener("click", () => {
		const access = relay === undefined ? undefined : fillAccess(relay);
		if (access === undefined) return;
		chrome.permissions
			.remove(access)
			.then(check, (error: unknown) => problem(String(error)));
	});
	chrome.permissions.onAdded.addListener(() => void check());
	chrome.permissions.onRemoved.addListener(() => void check());
	return {
		show(state) {
			if (state.relay === relay && state.allSites === allSites) return;
			relay = state.relay;
			allSites = state.allSites;
			render();
			void check();
		},
	};
}
