/**
 * A question's card, in the side panel and in a question's own window: who
 * asks (the AI app's declared name beside its verified host), the tool, the
 * site it acts on on a line of its own (what Chrome reports, the part that
 * is verified), the page's title for the tool apart and labelled as the
 * page's, the arguments in full, and the time left to answer. "Allow once"
 * and "Don't ask again on <host>" start unavailable (`aria-disabled`, so a
 * focused button keeps its focus): the page that shows the card makes them
 * available once it has been in front long enough (`setReady`).
 */

import type { Answer, QuestionView } from "../protocol.ts";

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

/** Bring every countdown under `root` to `now`. */
export function updateCountdowns(root: ParentNode, now: number): void {
	for (const p of root.querySelectorAll<HTMLElement>("[data-expires]")) {
		const text = countdownText(Number(p.dataset["expires"]), now);
		if (p.textContent !== text) p.textContent = text;
	}
}

/** A button that is shown but takes no click yet (EQ 11: keeps its focus). */
export const isUnavailable = (button: HTMLElement): boolean =>
	button.getAttribute("aria-disabled") === "true";

/** Make `button` take clicks (`ready`) or not, without taking its focus. */
export function setAvailable(button: HTMLElement, ready: boolean): void {
	if (ready) button.removeAttribute("aria-disabled");
	else button.setAttribute("aria-disabled", "true");
}

/** "Allow once" and "Don't ask again" of the cards under `root`: ready or not. */
export function setReady(root: ParentNode, ready: boolean): void {
	for (const b of root.querySelectorAll<HTMLButtonElement>(
		'button[data-answer]:not([data-answer="deny"])',
	))
		setAvailable(b, ready);
}

/** What a screen reader is told when a question comes (EQ 11). */
export function questionAnnouncement(
	q: Pick<QuestionView, "app" | "tool" | "navigation">,
): string {
	return q.navigation
		? `${q.app} asks to take the tab to another site.`
		: `${q.app} asks to run ${q.tool}.`;
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
	if (q.navigation) {
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
	const tool = document.createElement("p");
	tool.className = "muted small";
	tool.textContent = "With these arguments from the AI app:";
	const args = document.createElement("pre");
	args.textContent = q.args;
	// Scrollable, and reachable by keyboard to scroll it.
	args.tabIndex = 0;
	args.setAttribute("aria-label", "Arguments");
	const left = document.createElement("p");
	left.className = "countdown muted small";
	left.dataset["expires"] = String(q.expiresAt);
	left.textContent = countdownText(q.expiresAt, now);
	const buttons = document.createElement("div");
	buttons.className = "buttons";
	const button = (text: string, value: Answer, primary = false) => {
		const b = document.createElement("button");
		b.type = "button";
		b.textContent = text;
		b.dataset["answer"] = value;
		if (primary) b.className = "primary";
		// Allow and "Don't ask again" only once the page has been in front a
		// while: the click that brings it forward cannot approve.
		if (value !== "deny") setAvailable(b, false);
		b.addEventListener("click", () => {
			if (!isUnavailable(b)) answer(value);
		});
		return b;
	};
	// "Allow once": this call only, beside the one that keeps (EQ 9).
	buttons.append(
		button("Don't allow", "deny"),
		button("Allow once", "allow", true),
	);
	card.append(tool, args, left, buttons);
	// Not for a page without a site of its own (an opaque origin).
	// Nor for a navigation: each one to another site asks (DEC-121).
	if (q.site && q.origin && !q.navigation) {
		const host = hostOf(q.origin);
		buttons.append(button(`Don't ask again on ${host}`, "site"));
		const note = document.createElement("p");
		note.className = "muted small";
		note.textContent = `Don't ask again: this tool runs without asking on ${host}, for every paired AI app, until you turn "Ask first" back on in the tool list.`;
		card.append(note);
	}
	return card;
}
