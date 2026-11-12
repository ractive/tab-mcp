/**
 * A question's card, in the side panel and in a question's own window: who
 * asks (the AI app's declared name beside its verified host), the tool, the
 * site it acts on on a line of its own (what Chrome reports, the part that
 * is verified), the page's title for the tool apart and labelled as the
 * page's, and the arguments in full. Allow and Always allow start disabled:
 * the page that shows the card enables them once it has been in front long
 * enough.
 */

import type { Answer, QuestionView } from "../protocol.ts";

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

export function questionCard(
	q: QuestionView,
	answer: (answer: Answer) => void,
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
	const buttons = document.createElement("div");
	buttons.className = "buttons";
	const button = (text: string, value: Answer, primary = false) => {
		const b = document.createElement("button");
		b.type = "button";
		b.textContent = text;
		b.dataset["answer"] = value;
		if (primary) b.className = "primary";
		// Allow and Always allow only once the page has been in front a while:
		// the click that brings it forward cannot approve.
		if (value !== "deny") b.disabled = true;
		b.addEventListener("click", () => {
			if (!b.disabled) answer(value);
		});
		return b;
	};
	buttons.append(button("Don't allow", "deny"), button("Allow", "allow", true));
	card.append(tool, args, buttons);
	// Not for a page without a site of its own (an opaque origin).
	// Nor for a navigation: each one to another site asks (DEC-121).
	if (q.always && !q.navigation) {
		buttons.append(button("Always allow", "always"));
		const always = document.createElement("p");
		always.className = "muted small";
		always.textContent =
			"Always allow: this tool runs without asking for this AI app, until the page changes.";
		card.append(always);
	}
	return card;
}
