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
 * The arguments' columns that fit one line at 345 px (about 40 of the
 * monospace); a wider line unfolds. A wide character (East Asian wide or
 * fullwidth, an emoji) takes two (`displayWidth`).
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

/**
 * The site's host and port: the origin without its scheme. Not parsed as
 * an address: the worker cut a long host at its start with "…", which the
 * URL parser would turn into "...".
 */
export const siteText = (site: string) =>
	site.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");

/** One formatter for every row: hours, minutes, seconds, as the user's locale writes them. */
const TIME = new Intl.DateTimeFormat(undefined, {
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
});

export const timeText = (at: number) => TIME.format(at);

/** Takes two columns in the monospace: East Asian wide and fullwidth, emoji. */
const WIDE =
	/[\p{Extended_Pictographic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ᄀ-ᅟ⺀-〾㄰-㆏ꥠ-꥿가-힣豈-﫿︰-﹏！-｠￠-￦]/u;

/** The columns `text` takes in the monospace. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const ch of text) width += WIDE.test(ch) ? 2 : 1;
	return width;
}

/** One row's parts that change while its call runs. */
interface Row {
	li: HTMLLIElement;
	outcome: HTMLElement;
	who: HTMLElement;
	/** What they show now. */
	shown: string;
}

/** The AI app as the AI access card lists it: its name, then its verified host. */
function drawWho(who: HTMLElement, call: CallView): void {
	const doc = who.ownerDocument;
	const parts: (Node | string)[] = [];
	if (call.app) {
		const name = doc.createElement("span");
		name.className = "call-app";
		name.textContent = call.app;
		parts.push(name, " ");
	}
	const host = doc.createElement("span");
	host.className = "call-host";
	host.textContent = call.host;
	parts.push(host);
	if (call.site) parts.push(` · on ${siteText(call.site)}`);
	who.replaceChildren(...parts);
}

/** What a row shows of `call` that can change. */
const shownOf = (call: CallView) =>
	JSON.stringify([call.state, call.allowed, call.error, call.site, call.app]);

/** A new row: tool and time, how it went, the app and site, the arguments. */
function newRow(doc: Document, call: CallView): Row {
	const li = doc.createElement("li");
	li.dataset["call"] = String(call.id);
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
	const who = doc.createElement("p");
	who.className = "call-who muted small";
	const code = doc.createElement("code");
	code.className = "call-line";
	code.textContent = call.args;
	let args: HTMLElement = code;
	// Wider than a line at the panel's narrowest: it unfolds to the whole of
	// the cut line (a click, Enter or Space), never said in a `title` alone.
	if (displayWidth(call.args) > ARGS_LINE) {
		args = doc.createElement("details");
		const summary = doc.createElement("summary");
		summary.append(code);
		args.append(summary);
	}
	args.classList.add("call-args");
	li.append(head, outcome, who, args);
	const row: Row = { li, outcome, who, shown: "" };
	update(row, call);
	return row;
}

/** A row brought up to `call`: only what changed, the nodes kept. */
function update(row: Row, call: CallView): void {
	const shown = shownOf(call);
	if (shown === row.shown) return;
	row.shown = shown;
	row.li.dataset["state"] = call.state;
	row.outcome.textContent = outcomeText(call);
	drawWho(row.who, call);
}

/**
 * The list in the panel, newest first, at most `MAX_SHOWN`: one row per
 * call, by its id. A change updates its row in place, a new call's row goes
 * in at the top and the oldest out past `MAX_SHOWN`; the other rows stay as
 * they are, so an unfolded one stays unfolded and the focus stays where it
 * is. Changes are drawn together once per animation frame.
 */
export class CallsView {
	readonly #list: HTMLElement;
	readonly #empty: HTMLElement;
	readonly #schedule: (draw: () => void) => void;
	readonly #drawn: () => void;
	readonly #rows = new Map<number, Row>();
	readonly #pending = new Map<number, CallView>();
	#scheduled = false;
	/** How many times it drew (for the tests). */
	draws = 0;

	/**
	 * `list`: the `<ol>`; `empty`: the line shown without calls. `drawn`:
	 * after each draw (the summary's count). `schedule`: the next frame.
	 */
	constructor(
		list: HTMLElement,
		empty: HTMLElement,
		options: {
			drawn?: () => void;
			schedule?: (draw: () => void) => void;
		} = {},
	) {
		this.#list = list;
		this.#empty = empty;
		this.#drawn = options.drawn ?? (() => {});
		this.#schedule =
			options.schedule ?? ((draw) => void requestAnimationFrame(draw));
	}

	/** The calls listed (after the last draw). */
	get count(): number {
		return this.#rows.size;
	}

	/** The whole list, as the worker sent it when the section opened: drawn anew now. */
	set(calls: readonly CallView[]): void {
		this.#pending.clear();
		this.#rows.clear();
		this.#list.replaceChildren();
		this.#put([...calls].sort((a, b) => a.id - b.id));
		this.#show();
	}

	/** A call added or changed: drawn with the others of this frame. */
	put(call: CallView): void {
		this.#pending.set(call.id, call);
		if (this.#scheduled) return;
		this.#scheduled = true;
		this.#schedule(() => {
			this.#scheduled = false;
			const calls = [...this.#pending.values()].sort((a, b) => a.id - b.id);
			this.#pending.clear();
			this.#put(calls);
			this.#show();
		});
	}

	/** `calls`, oldest first, into the rows. */
	#put(calls: readonly CallView[]): void {
		const doc = this.#list.ownerDocument;
		for (const call of calls) {
			const row = this.#rows.get(call.id);
			if (row !== undefined) {
				update(row, call);
				continue;
			}
			// Older than every row of a full list: it would go at once.
			if (this.#rows.size >= MAX_SHOWN && call.id < this.#oldest()) continue;
			const added = newRow(doc, call);
			this.#rows.set(call.id, added);
			// Its place by id: in practice the top.
			let before: Element | null = this.#list.firstElementChild;
			while (
				before !== null &&
				Number((before as HTMLElement).dataset["call"]) > call.id
			)
				before = before.nextElementSibling;
			this.#list.insertBefore(added.li, before);
			while (this.#rows.size > MAX_SHOWN) {
				const last = this.#list.lastElementChild as HTMLElement | null;
				if (last === null) break;
				this.#rows.delete(Number(last.dataset["call"]));
				last.remove();
			}
		}
	}

	#oldest(): number {
		const last = this.#list.lastElementChild as HTMLElement | null;
		return last === null
			? Number.NEGATIVE_INFINITY
			: Number(last.dataset["call"]);
	}

	#show(): void {
		this.draws++;
		this.#empty.hidden = this.#rows.size > 0;
		this.#list.hidden = this.#rows.size === 0;
		this.#drawn();
	}
}
