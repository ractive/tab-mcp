/**
 * The last calls of AI apps through the extension, for the panel's "Recent
 * calls" (DEC-226): in the worker's memory only, never in IndexedDB or
 * `chrome.storage`, gone when the worker stops.
 *
 * Where each fact comes from:
 * - the library's `toolcall` and `toolcallend` events: every call of every
 *   tool of the extension's (its own and the page's, both ways of calling
 *   a page tool), with its AI app, the tool as the AI app named it, its
 *   arguments, and how it ended (ran, failed, cancelled);
 * - the tools' `execute`, wrapped where they are registered (`wrap`): the
 *   call's signal, which the bridge and the questions carry, so that they
 *   can say more of the same call (`note`): the site a page tool or a
 *   navigation acts on, that it waits for the user's answer, the answer
 *   (allowed, "Always allow", declined, not answered), that the page did
 *   not answer in time.
 *
 * Every text is other people's (an AI app's arguments and names, a page's
 * errors): invisible characters escaped, on one line, cut here, so the
 * worker never holds a long value; the panel sets it as text, never HTML.
 */

import type {
	Tool,
	ToolCallClient,
	ToolCallEnd,
	ToolCallStart,
} from "@ractive-ch/tab-mcp-client";
import { escapeInvisible } from "@ractive-ch/tab-mcp-client/visible";
import type { CallView } from "../protocol.ts";

/** The calls kept; the oldest goes when another starts. */
export const MAX_CALLS = 100;
/** The arguments as one line of JSON, cut to this (as a notification's). */
export const MAX_ARGS = 150;
/** An AI app's name, a tool's name, a host or a site, cut to this. */
export const MAX_NAME = 80;
/** The first words of an error. */
export const MAX_ERROR = 120;

/** What the bridge, the questions and a navigation add to a call. */
export type CallFact =
	| { site: string }
	| { waiting: true }
	/** The user's answer to its question, or "busy": not asked. */
	| { answer: "allow" | "site" | "deny" | "timeout" | "busy" }
	/** Allowed on its site before: it runs without a question. */
	| { allowedBefore: true }
	/** The page did not answer within the extension's time limit. */
	| { timedOut: true };

/** One line, invisible characters escaped, at most `max` characters. */
export function oneLine(text: string, max: number): string {
	const line = escapeInvisible(text).replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The arguments as one line of JSON, cut. */
export function argsLine(args: unknown): string {
	let json: string | undefined;
	try {
		json = JSON.stringify(args);
	} catch {
		json = undefined;
	}
	return oneLine(json ?? "{}", MAX_ARGS);
}

/** The first line of a failed call's error, from its result, cut. */
function errorOf(end: ToolCallEnd): string {
	for (const block of end.result.content) {
		const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
		if (type === "text" && typeof text === "string")
			return oneLine(text.split("\n", 1)[0] ?? "", MAX_ERROR);
	}
	return "";
}

const appOf = (client: ToolCallClient) => ({
	app: oneLine(("name" in client ? client.name : undefined) ?? "", MAX_NAME),
	host: oneLine("host" in client ? client.host : client.kind, MAX_NAME),
});

/** A call as the worker keeps it: the panel's view, and what is noted. */
interface Entry {
	view: CallView;
	answer?: "declined" | "unanswered";
	timedOut?: true;
	/** Its `execute` ran (`bind`). */
	bound: boolean;
}

export class RecentCalls {
	/** Newest first. */
	readonly #calls: Entry[] = [];
	/** A call's entry by the signal its `execute` got. */
	readonly #bySignal = new WeakMap<AbortSignal, Entry>();
	readonly #changed: (call: CallView, added: boolean) => void;
	readonly #now: () => number;

	/**
	 * `changed`: an entry was added (`added`) or changed; the entry as the
	 * panel gets it.
	 */
	constructor(
		changed: (call: CallView, added: boolean) => void,
		now: () => number = Date.now,
	) {
		this.#changed = changed;
		this.#now = now;
	}

	/** Newest first, copies. */
	get list(): CallView[] {
		return this.#calls.map((c) => ({ ...c.view }));
	}

	get count(): number {
		return this.#calls.length;
	}

	/**
	 * Follow the calls of `mcp` (a `TabMcp`, one per connection) that start
	 * until `signal` aborts. Their ends are heard after it too: a call in
	 * flight when the relay changes ends as its connection goes, and would
	 * otherwise stay "running" in the list.
	 */
	watch(mcp: EventTarget, signal: AbortSignal): void {
		mcp.addEventListener(
			"toolcall",
			(event) => this.started((event as CustomEvent<ToolCallStart>).detail),
			{ signal },
		);
		mcp.addEventListener("toolcallend", (event) =>
			this.ended((event as CustomEvent<ToolCallEnd>).detail),
		);
	}

	started(call: ToolCallStart): void {
		const entry: Entry = {
			view: {
				id: call.id,
				at: this.#now(),
				...appOf(call.client),
				tool: oneLine(call.tool, MAX_NAME),
				args: argsLine(call.arguments),
				state: "running",
			},
			bound: false,
		};
		this.#calls.unshift(entry);
		this.#calls.splice(MAX_CALLS);
		this.#changed({ ...entry.view }, true);
	}

	/**
	 * A tool's `execute` runs: bind its signal to the newest running call of
	 * that tool by that AI app whose `execute` had not run yet (the library
	 * calls it right after `toolcall`, once the arguments passed its check).
	 */
	bind(tool: string, client: ToolCallClient, signal: AbortSignal): void {
		const { host } = appOf(client);
		const name = oneLine(tool, MAX_NAME);
		const entry = this.#calls.find(
			(c) =>
				!c.bound &&
				isRunning(c.view) &&
				c.view.tool === name &&
				c.view.host === host,
		);
		if (entry === undefined) return;
		entry.bound = true;
		this.#bySignal.set(signal, entry);
	}

	/** `tool` with an `execute` that binds its call first. */
	wrap(tool: Tool): Tool {
		return {
			...tool,
			execute: (input, options) => {
				this.bind(tool.name, options.client, options.signal);
				return tool.execute(input, options);
			},
		};
	}

	/** Something more of the call whose `execute` got `signal`. */
	note(signal: AbortSignal, fact: CallFact): void {
		const entry = this.#bySignal.get(signal);
		// Not an AI app's call through the record, or ended already.
		if (entry === undefined || !isRunning(entry.view)) return;
		const { view } = entry;
		if ("site" in fact) view.site = oneLine(fact.site, MAX_NAME);
		else if ("waiting" in fact) view.state = "waiting";
		else if ("allowedBefore" in fact) view.allowed = "always";
		else if ("timedOut" in fact) entry.timedOut = true;
		else {
			view.state = "running";
			if (fact.answer === "allow") view.allowed = "once";
			else if (fact.answer === "site") view.allowed = "always";
			else if (fact.answer === "deny") entry.answer = "declined";
			else if (fact.answer === "timeout") entry.answer = "unanswered";
		}
		this.#changed({ ...view }, false);
	}

	ended(end: ToolCallEnd): void {
		const entry = this.#calls.find((c) => c.view.id === end.id);
		if (entry === undefined || !isRunning(entry.view)) return;
		const { view } = entry;
		view.state = stateOf(entry, end);
		if (view.state === "failed") view.error = errorOf(end);
		this.#changed({ ...view }, false);
	}
}

const isRunning = (view: CallView) =>
	view.state === "running" || view.state === "waiting";

/** How a call ended, from the library's outcome and what was noted. */
function stateOf(entry: Entry, end: ToolCallEnd): CallView["state"] {
	if (end.outcome === "cancelled") return "cancelled";
	if (entry.answer === "declined" || end.outcome === "declined")
		return "declined";
	if (entry.answer === "unanswered" || end.outcome === "unanswered")
		return "unanswered";
	if (entry.timedOut === true) return "timeout";
	return end.outcome === "ok" ? "ok" : "failed";
}
