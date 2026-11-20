/**
 * A question's card in the side panel: who asks (the AI app's declared name
 * beside its verified host), the tool, the site it acts on on a line of its
 * own (what Chrome reports, the part that is verified), the page's title for
 * the tool apart and labelled as the page's, the arguments in full, and the
 * time left to answer. The answers are buttons of one kind: nothing in their
 * look leans towards allowing (DEC-180). "Allow once" and "Always allow on
 * <host>" start unavailable (`aria-disabled`, so a focused button keeps
 * its focus): the panel makes them available once it has been in front long
 * enough (`setReady`).
 */

import { PRODUCT } from "../browser.ts";
import {
	type Answer,
	QUESTION_TIMEOUT_MS,
	type QuestionView,
} from "../protocol.ts";

/** The host of `origin` for a button's label, or the origin as it is. */
function hostOf(origin: string): string {
	try {
		return new URL(origin).host || origin;
	} catch {
		return origin;
	}
}

function line(label: string, value: string, className: string): HTMLElement {
	const p = document.createElement("p");
	p.className = `line ${className}`;
	const name = document.createElement("span");
	name.className = "line-label";
	name.textContent = label;
	// Isolated: a page's right-to-left text cannot reorder the label.
	const text = document.createElement("bdi");
	text.textContent = value;
	p.append(name, " ", text);
	return p;
}

/** What the card says of the time left (EQ 13). */
export function countdownText(expiresAt: number, now: number): string {
	const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
	return `${left} s left to answer; no answer is Don't allow.`;
}

/** The share of the time to answer that is left, 1 to 0: the bar's width. */
export function timeLeftShare(expiresAt: number, now: number): number {
	return Math.min(1, Math.max(0, (expiresAt - now) / QUESTION_TIMEOUT_MS));
}

/** Bring every countdown under `root` to `now`: its line and its bar. */
export function updateCountdowns(root: ParentNode, now: number): void {
	for (const p of root.querySelectorAll<HTMLElement>("[data-expires]")) {
		const text = countdownText(Number(p.dataset["expires"]), now);
		if (p.textContent !== text) p.textContent = text;
	}
	for (const fill of root.querySelectorAll<HTMLElement>("[data-drains]"))
		fill.style.width = `${timeLeftShare(Number(fill.dataset["drains"]), now) * 100}%`;
}

/** A button that is shown but takes no click yet (EQ 11: keeps its focus). */
export const isUnavailable = (button: HTMLElement): boolean =>
	button.getAttribute("aria-disabled") === "true";

/** Make `button` take clicks (`ready`) or not, without taking its focus. */
export function setAvailable(button: HTMLElement, ready: boolean): void {
	if (ready) button.removeAttribute("aria-disabled");
	else button.setAttribute("aria-disabled", "true");
}

/** "Allow once" and "Always allow on <host>" of the cards under `root`: ready or not. */
export function setReady(root: ParentNode, ready: boolean): void {
	for (const b of root.querySelectorAll<HTMLButtonElement>(
		'button[data-answer]:not([data-answer="deny"])',
	))
		setAvailable(b, ready);
}

/** What a screen reader is told when a question comes (EQ 11). */
export function questionAnnouncement(
	q: Pick<QuestionView, "app" | "tool" | "navigation" | "pairing">,
): string {
	if (q.pairing) return `${q.app} asks to connect.`;
	return q.navigation
		? `${q.app} asks to take the tab to another site.`
		: `${q.app} asks to run ${q.tool}.`;
}

/** What a question nobody answered in time leaves behind (EQ 13). */
export function expiredText(q: Pick<QuestionView, "tool" | "pairing">): string {
	return q.pairing
		? "Not answered in time: the code was not filled in."
		: `Not answered in time: ${q.tool} did not run.`;
}

/** A sentence of the card's own, in a paragraph. */
function paragraph(text: string, className: string): HTMLElement {
	const p = document.createElement("p");
	p.className = className;
	p.textContent = text;
	return p;
}

/**
 * A pairing question's text (DEC-203): which AI app, by the host the relay
 * verified on a line of its own above its own name for itself, and what
 * Allow does. Its name is the AI app's word: any site can call itself
 * "Claude".
 */
function pairingLines(q: QuestionView): HTMLElement[] {
	const lines = [
		paragraph(`Connect ${q.app} to the ${PRODUCT}?`, "ask"),
		line("AI app at (verified)", q.host, "app-host"),
	];
	if (q.pairing?.name)
		lines.push(
			line("Its name (from the AI app)", q.pairing.name, "muted small"),
		);
	lines.push(
		paragraph(
			"Allow fills in this extension's code on the relay's page in this browser and connects it. The AI app can then use the tab in front. Only allow an AI app you are connecting right now.",
			"muted small",
		),
	);
	return lines;
}

export function questionCard(
	q: QuestionView,
	answer: (answer: Answer) => void,
	now: number = Date.now(),
): HTMLElement {
	const card = document.createElement("section");
	card.className = "card question";
	card.dataset["question"] = q.id;
	const ask = document.createElement("p");
	ask.className = "ask";
	if (q.pairing) {
		card.append(...pairingLines(q));
	} else if (q.navigation) {
		// A navigation to another site (iteration 27): from where, to where.
		// The title is the extension's, not the page's: not shown.
		ask.textContent = `${q.app} wants to take the tab to another site (${q.tool}).`;
		card.append(ask);
		if (q.origin)
			card.append(line("From (verified)", q.origin, "site muted small"));
		card.append(line("To", q.navigation.to, "to small"));
	} else {
		ask.textContent = `${q.app} wants to run ${q.tool}.`;
		card.append(ask);
		if (q.origin)
			card.append(line("Site (verified)", q.origin, "site muted small"));
		if (q.title)
			card.append(line("Title (from the page)", q.title, "title muted small"));
	}
	// A pairing question has no arguments to show.
	const details: HTMLElement[] = [];
	if (!q.pairing) {
		const tool = document.createElement("p");
		tool.className = "muted small";
		tool.textContent = "With these arguments from the AI app:";
		const args = document.createElement("pre");
		args.textContent = q.args;
		// Scrollable, and reachable by keyboard to scroll it.
		args.tabIndex = 0;
		args.setAttribute("aria-label", "Arguments");
		details.push(tool, args);
	}
	const left = document.createElement("p");
	// The time left stands out: a line of normal size, in bold, and a bar at
	// the card's top that drains (only seen: the line says it).
	left.className = "countdown";
	left.dataset["expires"] = String(q.expiresAt);
	left.textContent = countdownText(q.expiresAt, now);
	const bar = document.createElement("div");
	bar.className = "countdown-bar";
	bar.setAttribute("aria-hidden", "true");
	const fill = document.createElement("span");
	fill.dataset["drains"] = String(q.expiresAt);
	fill.style.width = `${timeLeftShare(q.expiresAt, now) * 100}%`;
	bar.append(fill);
	card.prepend(bar);
	const buttons = document.createElement("div");
	buttons.className = "buttons";
	const button = (text: string, value: Answer) => {
		const b = document.createElement("button");
		b.type = "button";
		b.textContent = text;
		b.dataset["answer"] = value;
		// Allow and "Always allow on <host>" only once the page has been in front a
		// while: the click that brings it forward cannot approve.
		if (value !== "deny") setAvailable(b, false);
		b.addEventListener("click", () => {
			if (!isUnavailable(b)) answer(value);
		});
		return b;
	};
	// "Allow once": this call only, beside the one that keeps (EQ 9). The
	// same default kind as "Don't allow": neither answer is pushed (DEC-180).
	// A pairing question's Allow: there is nothing to allow for longer.
	buttons.append(
		button("Don't allow", "deny"),
		button(q.pairing ? "Allow" : "Allow once", "allow"),
	);
	card.append(...details, left, buttons);
	// Not for a page without a site of its own (an opaque origin).
	// Nor for a navigation: each one to another site asks (DEC-121).
	if (q.site && q.origin && !q.navigation) {
		const host = hostOf(q.origin);
		buttons.append(button(`Always allow on ${host}`, "site"));
		const note = document.createElement("p");
		note.className = "muted small";
		note.textContent = `Always allow on ${host}: this tool runs without asking there, for every paired AI app, until you turn off its "Always allow" in the tool list.`;
		card.append(note);
	}
	return card;
}
