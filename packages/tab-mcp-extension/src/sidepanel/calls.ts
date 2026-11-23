/**
 * "Recent calls" (DEC-226): the last calls of AI apps through the
 * extension, newest first, in the AI access card. The worker sends the
 * list when the section opens and each change while it is open. Every
 * text is the worker's, already cut and on one line, and is set as text,
 * never as HTML. No live region: the list is not read out as it changes.
 */

import type { CallView } from "../protocol.ts";

/** The calls the panel keeps, as the worker does. */
export const MAX_SHOWN = 100;
/**
 * The arguments' characters that fit one line at 345 px (about 40 of the
 * monospace); longer ones unfold.
 */
export const ARGS_LINE = 36;

export const CALLS_TITLE = "Recent calls";
export const CALLS_EMPTY =
	"No AI app has called a tool since the extension started.";
export const CALLS_NOTE =
	"The last 100 calls of your AI apps, newest first, with their arguments cut. Not saved: they are gone when the extension stops.";

/** The summary's text: the title and the count. */
export const summaryText = (count: number) => `${CALLS_TITLE} (${count})`;

/** How the call went, in words. */
export function outcomeText(call: CallView): string {
	const by =
		call.allowed === "once"
			? "Allowed by you · "
			: call.allowed === "always"
				? "Always allowed · "
				: "";
	switch (call.state) {
		case "running":
			return `${by}Running`;
		case "waiting":
			return "Waiting for your answer";
		case "ok":
			return `${by}Ran`;
		case "failed":
			return call.error ? `${by}Failed: ${call.error}` : `${by}Failed`;
		case "declined":
			return "Declined by you";
		case "unanswered":
			return "Not answered in time";
		case "cancelled":
			return `${by}Cancelled by the AI app`;
		case "timeout":
			return `${by}The page did not answer in time`;
	}
}

/** The AI app as the entry names it: its own name beside its verified host. */
export const appText = (call: CallView) =>
	call.app ? `${call.app} (${call.host})` : call.host;

/** The site's host, or the site as it is. */
export function siteText(site: string): string {
	try {
		return new URL(site).host || site;
	} catch {
		return site;
	}
}

/** The time as the user's locale writes it, with seconds. */
export const timeText = (at: number) =>
	new Date(at).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});

/** The panel's copy of the list: newest first, at most `MAX_SHOWN`. */
export class CallList {
	#calls: CallView[] = [];

	get calls(): readonly CallView[] {
		return this.#calls;
	}

	/** The whole list, as the worker sent it when the section opened. */
	set(calls: CallView[]): void {
		this.#calls = [...calls].sort((a, b) => b.id - a.id).slice(0, MAX_SHOWN);
	}

	/** A call added or changed. */
	put(call: CallView): void {
		const i = this.#calls.findIndex((c) => c.id === call.id);
		if (i >= 0) this.#calls[i] = call;
		else {
			this.#calls.push(call);
			this.#calls.sort((a, b) => b.id - a.id);
			this.#calls.splice(MAX_SHOWN);
		}
	}
}

/** One entry of the list: tool and time, how it went, the app and site, the arguments. */
export function callItem(doc: Document, call: CallView): HTMLLIElement {
	const li = doc.createElement("li");
	li.dataset["call"] = String(call.id);
	li.dataset["state"] = call.state;
	const head = doc.createElement("p");
	head.className = "call-head";
	const tool = doc.createElement("code");
	tool.className = "call-tool";
	tool.textContent = call.tool;
	const time = doc.createElement("time");
	time.className = "muted small";
	time.dateTime = new Date(call.at).toISOString();
	time.textContent = timeText(call.at);
	head.append(tool, time);
	const outcome = doc.createElement("p");
	outcome.className = "call-outcome small";
	outcome.textContent = outcomeText(call);
	const who = doc.createElement("p");
	who.className = "muted small";
	who.textContent = call.site
		? `${appText(call)} · on ${siteText(call.site)}`
		: appText(call);
	const code = doc.createElement("code");
	code.textContent = call.args;
	let args: HTMLElement = code;
	// Longer than a line at the panel's narrowest: it unfolds to the whole of
	// the cut line (a click, Enter or Space), never said in a `title` alone.
	if (call.args.length > ARGS_LINE) {
		args = doc.createElement("details");
		const summary = doc.createElement("summary");
		summary.append(code);
		args.append(summary);
	}
	args.classList.add("call-args");
	li.append(head, outcome, who, args);
	return li;
}

/**
 * Draw `calls` into `list` (an `<ol>`), and the empty line. The arguments
 * the user unfolded stay unfolded, and the keyboard's focus on one stays.
 */
export function drawCalls(
	list: HTMLElement,
	empty: HTMLElement,
	calls: readonly CallView[],
): void {
	const doc = list.ownerDocument;
	const idOf = (e: Element | null) =>
		e?.closest<HTMLElement>("li[data-call]")?.dataset["call"];
	const unfolded = new Set(
		[...list.querySelectorAll("details.call-args[open]")].map(idOf),
	);
	const focused = list.contains(doc.activeElement)
		? idOf(doc.activeElement)
		: undefined;
	list.replaceChildren(...calls.map((call) => callItem(doc, call)));
	for (const li of list.querySelectorAll<HTMLElement>("li[data-call]")) {
		const id = li.dataset["call"];
		const details = li.querySelector<HTMLDetailsElement>("details.call-args");
		if (details !== null && unfolded.has(id)) details.open = true;
		if (id === focused) li.querySelector<HTMLElement>("summary")?.focus();
	}
	empty.hidden = calls.length > 0;
	list.hidden = calls.length === 0;
}
