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
import { hostEnd, MAX_TITLE_HOST } from "./navigation.ts";

/** The calls kept; the oldest goes when another starts. */
export const MAX_CALLS = 100;
/** The arguments as one line of JSON, cut to this (as a notification's). */
export const MAX_ARGS = 150;
/**
 * An AI app's name or a tool's name, cut to this. A host, also a site's,
 * keeps its end, `MAX_TITLE_HOST` characters (`hostLine`).
 */
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

/**
 * How much of a text the worker reads to make a line of at most `max`
 * characters: `PREFIX` times as many code points. Escaping only lengthens
 * and folding white space only shortens a run of it, so this is enough for
 * any line short of one that is nearly all white space; the rest of a long
 * value is never looked at.
 */
export const PREFIX = 4;

/**
 * The first `points` code points of `text` (never half a surrogate pair),
 * and whether there was more.
 */
export function prefixOf(
	text: string,
	points: number,
): { head: string; more: boolean } {
	let i = 0;
	for (let n = 0; n < points && i < text.length; n++)
		i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
	return { head: text.slice(0, i), more: i < text.length };
}

/**
 * `line` cut to at most `max` code points with an ellipsis, also when `more`
 * of it was left out before. Never inside a surrogate pair nor inside a
 * `\uXXXX` escape (`escapeInvisible`'s, or JSON's).
 */
function cut(line: string, max: number, more: boolean): string {
	const points = Array.from(line);
	if (points.length <= max && !more) return line;
	let kept = points.slice(0, Math.min(points.length, max - 1)).join("");
	// A backslash, or `\u` with fewer than four hex digits, at the end: the
	// start of an escape the cut went through.
	kept = kept.replace(/\\(u[0-9A-Fa-f]{0,3})?$/, "");
	return `${kept.trimEnd()}…`;
}

/** One line, invisible characters escaped, at most `max` code points. */
export function oneLine(text: string, max: number): string {
	const { head, more } = prefixOf(text, max * PREFIX);
	const line = escapeInvisible(head).replace(/\s+/g, " ").trim();
	return cut(line, max, more);
}

/**
 * The start of `value`'s JSON, at least `budget` characters of it where it
 * is longer, and whether there was more. Only that much of the value is
 * read (a long string, a long array, an object with many keys): JSON of a
 * call's arguments, which the library parsed, so no cycles or functions.
 */
export function jsonPrefix(
	value: unknown,
	budget: number,
): { json: string; more: boolean } {
	let json = "";
	let more = false;
	const full = () => {
		if (json.length >= budget) more = true;
		return more;
	};
	const text = (s: string) => {
		const { head, more: longer } = prefixOf(s, budget);
		json += JSON.stringify(head);
		if (longer) {
			// The quote that would close it: the string goes on.
			json = json.slice(0, -1);
			more = true;
		}
	};
	const walk = (v: unknown): void => {
		if (typeof v === "string") {
			text(v);
			return;
		}
		if (typeof v === "number" || typeof v === "boolean" || v === null) {
			json += JSON.stringify(v);
			return;
		}
		if (Array.isArray(v)) {
			json += "[";
			for (let i = 0; i < v.length; i++) {
				if (full()) return;
				if (i > 0) json += ",";
				walk(v[i] ?? null);
			}
			json += "]";
			return;
		}
		if (typeof v === "object") {
			json += "{";
			let first = true;
			for (const key in v) {
				if (full()) return;
				if (!first) json += ",";
				first = false;
				text(key);
				if (more) return;
				json += ":";
				walk((v as Record<string, unknown>)[key]);
			}
			json += "}";
			return;
		}
		json += "null";
	};
	walk(value ?? {});
	return { json, more: more || json.length > budget };
}

/** The arguments as one line of JSON, cut. */
export function argsLine(args: unknown): string {
	const { json, more } = jsonPrefix(args, MAX_ARGS * PREFIX);
	const { head, more: longer } = prefixOf(json, MAX_ARGS * PREFIX);
	const line = escapeInvisible(head).replace(/\s+/g, " ").trim();
	return cut(line, MAX_ARGS, more || longer);
}

/** The first line of a failed call's error, from its result, cut. */
function errorOf(end: ToolCallEnd): string {
	for (const block of end.result.content) {
		const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
		if (type === "text" && typeof text === "string") {
			const { head, more } = prefixOf(text, MAX_ERROR * PREFIX);
			const lineEnd = head.indexOf("\n");
			const first = lineEnd >= 0 ? head.slice(0, lineEnd) : head;
			const line = escapeInvisible(first).replace(/\s+/g, " ").trim();
			return cut(line, MAX_ERROR, lineEnd < 0 && more);
		}
	}
	return "";
}

/**
 * A host kept by its end, where the site it names is (`hostEnd`): a long
 * host's start can say anything (`accounts.google.com.aaaa….evil.example`).
 */
export function hostLine(host: string): string {
	// Only its end is read; a host is ASCII (the URL parser's punycode).
	const tail = host.slice(-MAX_TITLE_HOST * PREFIX);
	return hostEnd(escapeInvisible(tail).replace(/\s+/g, ""));
}

/**
 * A site's origin with its host kept by its end (`hostLine`), so that it
 * stays scheme, host and port; anything that is not an origin, as one line.
 */
export function siteLine(site: string): string {
	try {
		const url = new URL(site);
		if (url.protocol === "http:" || url.protocol === "https:")
			return `${url.protocol}//${hostLine(url.hostname)}${url.port ? `:${url.port}` : ""}`;
	} catch {
		// Not an address: below.
	}
	return oneLine(site, MAX_NAME);
}

/**
 * The AI app: its own name, else the name the connected apps list gives
 * its grant (`nameOf`), cut; its verified host kept by its end.
 */
function appOf(
	client: ToolCallClient,
	nameOf: (grantId: string) => string | undefined,
): { app: string; host: string } {
	const name =
		("name" in client ? client.name : undefined) ||
		(client.kind === "relay" ? nameOf(client.grantId) : undefined) ||
		"";
	return {
		app: oneLine(name, MAX_NAME),
		host: "host" in client ? hostLine(client.host) : client.kind,
	};
}

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
	readonly #nameOf: (grantId: string) => string | undefined;

	/**
	 * `changed`: an entry was added (`added`) or changed; the entry as the
	 * panel gets it. `nameOf`: the name the connected apps list gives a
	 * grant, for a call whose client the library gave no name.
	 */
	constructor(
		changed: (call: CallView, added: boolean) => void,
		options: {
			now?: () => number;
			nameOf?: (grantId: string) => string | undefined;
		} = {},
	) {
		this.#changed = changed;
		this.#now = options.now ?? Date.now;
		this.#nameOf = options.nameOf ?? (() => undefined);
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
				...appOf(call.client, this.#nameOf),
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
		const { host } = appOf(client, this.#nameOf);
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
		if ("site" in fact) view.site = siteLine(fact.site);
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
