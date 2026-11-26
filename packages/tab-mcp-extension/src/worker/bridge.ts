/**
 * The WebMCP bridge (iteration 20): the tools the page in front registered
 * with WebMCP, offered to the AI app as `page_<name>` tools of the
 * connection's `TabMcp`, and through `webmcp_call` for AI apps that read their
 * tool list only once. The list follows the tab in front and the page's
 * `toolchange`; it is advisory (a page may drop a tool any time), so a call
 * to a tool that is gone answers so instead of failing the bridge.
 *
 * "The tab in front" is the tab AI apps work in (`targets.ts`, iteration
 * 53): the tab in front, or the pinned tab. `webmcp_tools` and `webmcp_call`
 * with a `tab` argument for another tab read that tab's tools for the one
 * call (`stateOf`, `callByName`), with the same rules, and leave the
 * `page_<name>` tools offered as they are.
 *
 * Everything that comes from the page is the page's word: names, titles,
 * descriptions, schemas, hints and results. Texts are cut and descriptions
 * start with the page's origin (checked against the address Chrome reports);
 * results are marked untrusted and cut; a tool not marked read-only asks the
 * user every time (both ways of calling it ask here, through `confirm`); a
 * call runs only on the page its tool was listed from, with the read-only
 * claim it was offered with.
 *
 * A call the user allowed (asked, or allowed for its site) goes to the page
 * with a vouch, so that a page with the client library does not ask again
 * (DEC-207); an AI app's call of a read-only tool, which nobody asks about,
 * with a claim, which allows nothing (DEC-224). Either tells the library to
 * answer with the whole MCP result, pictures included. Only
 * `#allowedThenRun` makes them, a vouch after the user's "allow" and the
 * check that the tool is still the one asked about.
 */

import {
	ignoredKeyword,
	schemaArrayKeyword,
	schemaMapKeyword,
	Validator,
} from "@cfworker/json-schema";
import type {
	ConfirmRequest,
	ModelContextTool,
	ToolExecuteCallbackOptions,
} from "@ractive-ch/tab-mcp-client";
import { canonicalJson } from "../canonical.ts";
import type {
	CallResult,
	PageLibrary,
	PageTool,
	PageTools,
	Vouch,
} from "../messages.ts";
import { resultOf } from "../result.ts";
import type { TargetTab } from "../tabs.ts";
import { OWN_TOOL_NAMES } from "./tools.ts";

/** A page's result as the AI app gets it: `../result.ts`, shared with the content script. */
export {
	MAX_BLOCKS,
	MAX_IMAGES_BASE64,
	MAX_RESULT,
	resultOf,
} from "../result.ts";

/** At most this many page tools are offered (and listed). */
export const MAX_TOOLS = 64;
/**
 * A description (after the origin) is cut to this many characters: room for
 * a page's how-to, which WebMCP has no server instructions for.
 */
export const MAX_DESCRIPTION = 8000;
/**
 * All of a page's descriptions together (after the origin, in UTF-8 bytes).
 * Past it the longest are cut to one common length, so 64 long descriptions
 * cannot fill the AI app's context or the relay's 1 MiB message (DEC-192).
 */
export const MAX_DESCRIPTIONS_BYTES = 65_536;
/** A page's error, and why a tool is not offered, is cut to this many characters. */
export const MAX_ERROR = 1000;
/** A title is cut to this many characters. */
export const MAX_TITLE = 100;
/** A name shown (also one that does not fit `page_<name>`) is cut to this. */
export const MAX_NAME = 128;
/** A schema bigger than this (as JSON) leaves its tool out. */
export const MAX_SCHEMA_BYTES = 16 * 1024;
/** A pattern noted in a description (WM 8) is cut to this many characters. */
export const MAX_PATTERN = 200;
/** A call the page does not answer in this time is given up. */
export const CALL_TIMEOUT_MS = 60_000;

const PREFIX = "page_";
/** The extension's own tools: a page tool whose name becomes one is left out. */
const OWN_TOOLS: ReadonlySet<string> = new Set(OWN_TOOL_NAMES);
/**
 * Tool names every AI app takes: the Anthropic API allows only
 * `^[a-zA-Z0-9_-]{1,64}$` and drops other tools without a word (MCP and
 * WebMCP allow dots and 128 characters; Claude saw no `page_<name>` tool).
 */
const API_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The AI app's name for page tool `name`: `page_<name>`, characters other
 * than letters, digits, `_` and `-` as `_`; `undefined` if it is longer than
 * 64 characters.
 */
export function bridgedName(name: string): string | undefined {
	const bridged = `${PREFIX}${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
	return name !== "" && API_NAME.test(bridged) ? bridged : undefined;
}

const cut = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/** The page's text of a description: trimmed, cut to `MAX_DESCRIPTION`. */
const pageText = (description: string) =>
	cut(description.trim() || "(no description)", MAX_DESCRIPTION);

/** `text` in at most `max` UTF-8 bytes, ending in "…" when cut; never half a character. */
export function cutBytes(text: string, max: number): string {
	if (byteLength(text) <= max) return text;
	const room = max - byteLength("…");
	let used = 0;
	let end = 0;
	for (const char of text) {
		const size = byteLength(char);
		if (used + size > room) break;
		used += size;
		end += char.length;
	}
	return `${text.slice(0, end)}…`;
}

/**
 * The most bytes one description may keep so that all of them together fit
 * `budget`: those shorter than that stay whole, the longest share the rest
 * equally. `Infinity` when they fit as they are.
 */
export function descriptionCap(
	lengths: readonly number[],
	budget = MAX_DESCRIPTIONS_BYTES,
): number {
	const sorted = [...lengths].sort((a, b) => a - b);
	let left = budget;
	for (const [i, length] of sorted.entries()) {
		const share = Math.floor(left / (sorted.length - i));
		if (length > share) return share;
		left -= length;
	}
	return Number.POSITIVE_INFINITY;
}

/** The page's description, cut (to `maxBytes` too), after its origin. */
export function describe(
	origin: string,
	description: string,
	maxBytes = Number.POSITIVE_INFINITY,
): string {
	return `From ${origin}: ${cutBytes(pageText(description), maxBytes)}`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const has = (keywords: Record<string, unknown>, key: string) =>
	Object.hasOwn(keywords, key);

/**
 * A copy of schema `schema` without the keywords whose regular expressions
 * the validator would run in the extension (`pattern`, `patternProperties`):
 * a page's catastrophic pattern would freeze the connection. The page still
 * checks its own input as it likes.
 *
 * Only keywords go, never names: the walk follows the validator's own idea of
 * where a schema is (`dereference` in `@cfworker/json-schema`). Under
 * `properties`, `$defs`, `dependentSchemas` and the like the keys are names
 * (a parameter may be called `pattern`), and only their values are schemas;
 * `enum`, `const`, `default` and the other plain keywords are data and stay
 * as they are; any other keyword with an object value is walked as a schema,
 * as the validator would reach it through a `$ref`.
 *
 * A `pattern` that goes is added to the schema's `description` (cut to
 * `MAX_PATTERN` characters), so that the AI app still knows the format the
 * page wants (WM 8); so are the names `patternProperties` allowed.
 *
 * The copy only ever accepts more than the page's schema, never less (DEC-217).
 * For a page built with the client library this check is a first one: the
 * library checks the arguments again with the page's full schema. For a page
 * that registers with the browser's WebMCP itself, or with the extension's
 * own (`webmcp/registry.ts`), it is the only one: neither the browser nor the
 * extension's WebMCP checks arguments. There an argument the page's regular
 * expressions would have refused reaches its `execute`, as it always did
 * (patterns were never run here), and the page has to check its input
 * itself. A check that is too strict, on the other hand, refuses calls the
 * page takes, with no way around it for the AI app. Taking a keyword away
 * loosens only where the schema around it does not turn it around, so:
 * - without `patternProperties`, its keys become "additional": a restricting
 *   `additionalProperties` (false or a schema) goes with it;
 * - `unevaluatedProperties` and `unevaluatedItems` go wherever something
 *   below them went (fewer keys or items count as evaluated);
 * - `not` goes when something below it went (a looser `not` is stricter),
 *   and so does `if` with its `then` and `else` (a looser `if` picks `then`
 *   more often); `oneOf` becomes `anyOf` (two branches that now both match
 *   would fail it), or goes when there is an `anyOf` already; `maxContains`
 *   goes when its `contains` got looser;
 * - a `$ref` counts as something below that went when what it leads to lost
 *   something, itself or through its own `$ref`s (`lostRefs`, the second
 *   pass of `widen`); one that may lead anywhere (not a `#/…` pointer, an
 *   `$id` below the root, `$dynamicRef`, `$recursiveRef`) always does.
 * `propertyNames`, `properties`, `items`, `allOf`, `anyOf`, `then`, `else`
 * and the like only get looser with what is below them, and stay.
 */
function withoutPatterns(schema: unknown): unknown {
	const first = widen(schema);
	return first.loosened
		? widen(schema, lostRefs(schema, first)).schema
		: first.schema;
}

const REFS = ["$ref", "$dynamicRef", "$recursiveRef"];

/** What `widen` makes of a schema. */
interface Widened {
	schema: unknown;
	/** Something in it went (or, with `lost`, it has a `$ref` that counts so). */
	loosened: boolean;
	/** The `$ref`s in it, as written. */
	refs: string[];
	/** It has an `$id` below the root, which moves where `#/…` resolves. */
	ids: boolean;
}

/**
 * Which `$ref`s of `root` (its first pass, `first`) lead to a schema that
 * lost something, itself or through its own `$ref`s, to any depth: a fixed
 * point over the distinct pointers, so that cycles end and no path is
 * walked twice. A `$ref` that is not a `#/…` pointer into `root`, or any one
 * in a schema with an `$id` below the root, counts as lost.
 */
function lostRefs(root: unknown, first: Widened): (ref: string) => boolean {
	if (first.ids) return () => true;
	const targets = new Map<string, Widened | undefined>();
	const queue = [...first.refs];
	for (let ref = queue.pop(); ref !== undefined; ref = queue.pop()) {
		if (targets.has(ref)) continue;
		const target = pointed(root, ref);
		const made = target === undefined ? undefined : widen(target.value);
		targets.set(ref, made);
		if (made !== undefined) queue.push(...made.refs);
	}
	const lost = new Map<string, boolean>();
	for (const [ref, made] of targets) lost.set(ref, made?.loosened ?? true);
	for (let changed = true; changed; ) {
		changed = false;
		for (const [ref, made] of targets)
			if (!lost.get(ref) && made?.refs.some((r) => lost.get(r) ?? true)) {
				lost.set(ref, true);
				changed = true;
			}
	}
	return (ref) => lost.get(ref) ?? true;
}

/** What `#` or a `#/…` JSON pointer `ref` names in `root`; `undefined` if nothing. */
function pointed(root: unknown, ref: string): { value: unknown } | undefined {
	if (ref !== "#" && !ref.startsWith("#/")) return undefined;
	let node = root;
	for (const raw of ref === "#" ? [] : ref.slice(2).split("/")) {
		let part: string;
		try {
			part = decodeURIComponent(raw)
				.replaceAll("~1", "/")
				.replaceAll("~0", "~");
		} catch {
			return undefined;
		}
		if (Array.isArray(node) && /^(0|[1-9]\d*)$/.test(part))
			node = node[Number(part)];
		else if (isObject(node) && Object.hasOwn(node, part)) node = node[part];
		else return undefined;
	}
	return node === undefined ? undefined : { value: node };
}

/**
 * `withoutPatterns` for `schema` (`root`: it is the whole schema), and
 * whether anything in it went; with `lost`, a `$ref` counts as something
 * that went where `lost` says its target lost something.
 */
function widen(
	schema: unknown,
	lost?: (ref: string) => boolean,
	root = true,
): Widened {
	if (!isObject(schema))
		return { schema, loosened: false, refs: [], ids: false };
	const out: Record<string, unknown> = {};
	const looser = new Set<string>();
	const refs: string[] = [];
	let ids = !root && "$id" in schema;
	const notes: string[] = [];
	const { pattern, patternProperties, description } = schema;
	if (typeof pattern === "string")
		notes.push(
			`(Must match the regular expression ${cut(pattern, MAX_PATTERN)}.)`,
		);
	if (isObject(patternProperties) && Object.keys(patternProperties).length)
		notes.push(
			`(Properties whose names match the regular expression ${Object.keys(
				patternProperties,
			)
				.map((p) => cut(p, MAX_PATTERN))
				.join(" or ")} are allowed too.)`,
		);
	const sub = (key: string, value: unknown) => {
		const made = widen(value, lost, false);
		if (made.loosened) looser.add(key);
		refs.push(...made.refs);
		ids ||= made.ids;
		return made.schema;
	};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "pattern" || key === "patternProperties") {
			looser.add(key);
			continue;
		}
		if (REFS.includes(key)) {
			const pointer = key === "$ref" && typeof value === "string";
			if (pointer) refs.push(value);
			if (lost !== undefined && (!pointer || lost(value))) looser.add(key);
		}
		if (
			(has(schemaMapKeyword, key) || key === "dependencies") &&
			isObject(value)
		) {
			// Names, each with a schema (`dependencies`: or a list of names).
			const map: Record<string, unknown> = {};
			for (const [name, item] of Object.entries(value))
				map[name] = sub(key, item);
			out[key] = map;
		} else if (Array.isArray(value))
			out[key] = has(schemaArrayKeyword, key)
				? value.map((item) => sub(key, item))
				: value;
		else if (has(ignoredKeyword, key)) out[key] = value;
		else out[key] = sub(key, value);
	}
	if (notes.length)
		// A description that is not a string (not valid JSON Schema) gives way.
		out["description"] = [
			...(typeof description === "string" && description ? [description] : []),
			...notes,
		].join(" ");
	if (!looser.size) return { schema: out, loosened: false, refs, ids };
	if (looser.has("patternProperties")) delete out["additionalProperties"];
	delete out["unevaluatedProperties"];
	delete out["unevaluatedItems"];
	if (looser.has("not")) delete out["not"];
	if (looser.has("if")) {
		delete out["if"];
		delete out["then"];
		delete out["else"];
	}
	if (looser.has("oneOf")) {
		if (!("anyOf" in out)) out["anyOf"] = out["oneOf"];
		delete out["oneOf"];
	}
	if (looser.has("contains")) delete out["maxContains"];
	return { schema: out, loosened: true, refs, ids };
}

/** The input schema to offer, or why the tool is left out. */
export function schemaFor(
	tool: Pick<PageTool, "inputSchema" | "schemaTooBig">,
): { schema: Record<string, unknown> } | { problem: string } {
	if (tool.schemaTooBig)
		return {
			problem: `its inputSchema is bigger than ${MAX_SCHEMA_BYTES} bytes`,
		};
	const schema = tool.inputSchema;
	if (schema === undefined)
		return { schema: { type: "object", properties: {} } };
	if (!isObject(schema) || schema["type"] !== "object")
		return {
			problem: 'its inputSchema is not an object schema ("type": "object")',
		};
	const json = JSON.stringify(withoutPatterns(schema));
	if (new TextEncoder().encode(json).length > MAX_SCHEMA_BYTES)
		return {
			problem: `its inputSchema is bigger than ${MAX_SCHEMA_BYTES} bytes`,
		};
	return { schema: JSON.parse(json) as Record<string, unknown> };
}

/**
 * The page's `outputSchema` to show (WM 3): an object, patterns noted as in
 * the input schema, at most `MAX_SCHEMA_BYTES`; `undefined` otherwise.
 */
export function outputSchemaOf(
	schema: unknown,
): Record<string, unknown> | undefined {
	if (!isObject(schema)) return undefined;
	const json = JSON.stringify(withoutPatterns(schema));
	return new TextEncoder().encode(json).length > MAX_SCHEMA_BYTES
		? undefined
		: (JSON.parse(json) as Record<string, unknown>);
}

/** A page tool as the bridge offers it, or why it does not. */
export interface Offered {
	/** The page's name, cut. */
	name: string;
	/** The AI app's name, `page_<name>`. */
	tool?: string;
	title?: string;
	/** The page's description after its origin, cut. */
	description: string;
	readOnly: boolean;
	/**
	 * It may change things the user cares about, as its `page_<name>` tool's
	 * `destructiveHint` says (`destructiveOf`, DEC-214).
	 */
	destructive: boolean;
	/**
	 * The arguments it takes, as offered (`webmcp_call` checks them against
	 * it): only for a tool that is offered.
	 */
	inputSchema?: Record<string, unknown>;
	/**
	 * The page's schema of the result (the draft's `outputSchema`, patterns
	 * noted as in `inputSchema`), only for a tool that is offered: shown in
	 * `webmcp_tools`, not declared on its `page_<name>` tool (DEC-144).
	 */
	outputSchema?: Record<string, unknown>;
	/** Why `webmcp_tools` lists no schema for it although it is offered (size). */
	schemaLeftOut?: string;
	/** Why it is not offered. */
	problem?: string;
}

/** What the bridge knows about the page in front, for `webmcp_tools` and the panel. */
export interface BridgeState {
	/** The tab it was read from. */
	tabId?: number;
	/** The page in it (the content script's id), once read. */
	documentId?: string;
	url?: string;
	origin?: string;
	/** `document.modelContext` is there. */
	available: boolean;
	tools: Offered[];
	/** Tools the page has beyond those listed. */
	more?: number;
	/** Why there are no tools: no access, an error. */
	error?: string;
	/** The page announced the client library (DEC-207). */
	library?: PageLibrary;
}

/** Which page tool a call is for: the page it was listed from, its claim. */
export interface CallTarget {
	documentId: string;
	name: string;
	readOnly: boolean;
	/**
	 * The tool as it was offered, as `canonicalJson` of its `PageTool`: the
	 * content script runs it only if the page's tool is still that one.
	 */
	definition: string;
}

/** What the bridge needs from Chrome. */
export interface BridgeChrome {
	current(): Promise<TargetTab>;
	list(tab: TargetTab): Promise<PageTools>;
	/**
	 * `vouch`: an AI app's call (`allowed`: the user allowed it); the page is
	 * told before it runs.
	 */
	call(
		tabId: number,
		target: CallTarget,
		input: unknown,
		signal: AbortSignal,
		vouch?: Vouch,
	): Promise<CallResult>;
	/**
	 * Tab `tabId` after its page went away during a call: wait until it has
	 * loaded and give its `page_info` (or why it cannot be read).
	 */
	settled(tabId: number, signal: AbortSignal): Promise<unknown>;
}

/** Where the bridged tools go: the connection's `TabMcp`. */
export interface Registrar {
	registerTool(
		tool: ModelContextTool,
		options: { signal: AbortSignal },
	): Promise<void>;
}

/** The page tool a question is about. */
export interface LookedUp {
	tabId: number;
	/** Its page's origin, as Chrome reports the tab's address. */
	origin: string;
	/** The page in the tab it was listed from (the content script's id). */
	documentId: string;
	name: string;
	readOnly: boolean;
}

/**
 * Asks before a tool that is not read-only runs; resolves if it may run and
 * rejects, with what to tell the AI app, if not.
 */
export type Confirm = (
	request: ConfirmRequest,
	tool: LookedUp,
) => Promise<void>;

/** What a bridge is made with besides its registrar and Chrome. */
export interface BridgeOptions {
	/** Called after each refresh (for the panel). */
	changed?: () => void;
	/** Asks the user; without it, every tool that is not read-only is refused. */
	confirm?: Confirm;
	/**
	 * More of the call whose `execute` got `signal`, for "Recent calls"
	 * (DEC-226): the site it runs on, that the page did not answer in time.
	 */
	note?: (
		signal: AbortSignal,
		fact: { site: string } | { timedOut: true },
	) => void;
	timeoutMs?: number;
	/**
	 * Before a `page_<name>` tool's call: whether tab `tabId`, which the
	 * tool was offered from, is still the tab calls go to (in mode "a pinned
	 * tab" without a pin, it pins it: the first call pins). Without it,
	 * always.
	 */
	callIn?: (tabId: number) => Promise<boolean>;
	/** How long after a read that caught the tab between two pages it reads once more. */
	pageChangedRetryMs?: number;
}

/** A read that caught the tab between two pages, or a page that says it is another site. */
class PageChangedError extends Error {}

/** See `BridgeOptions.pageChangedRetryMs`. */
export const PAGE_CHANGED_RETRY_MS = 1000;

/** A tool of the page in front as the bridge keeps it, to call. */
interface Callable {
	/** The tool as the page offered it (`keyOf`). */
	key: string;
	tabId: number;
	origin: string;
	target: CallTarget;
	title: string;
	description: string;
	validator: Validator;
	/** Its `page_<name>` tool's `destructiveHint` (`destructiveOf`). */
	destructive: boolean;
}

/**
 * The `destructiveHint` the AI app gets for a page tool (DEC-214): false for
 * a read-only one, else what the page says with `consequentialHint`, and
 * true when the page said nothing (no annotations: the worst case, MCP's
 * own default). It only describes the tool: the bridge asks before every
 * call of a tool that is not read-only all the same (DEC-141).
 */
export function destructiveOf(tool: PageTool): boolean {
	if (tool.annotations?.readOnlyHint === true) return false;
	return tool.annotations?.consequentialHint !== false;
}

/**
 * Whether `a` and `b` are the same tool of the same page in the same tab, as
 * the page offered it: its title, description, schemas and hints too
 * (`keyOf`), so that an answer the user gave about one definition never
 * runs another.
 */
const sameTool = (a: Callable, b: Callable): boolean =>
	a.key === b.key && a.origin === b.origin;

/** A page tool's schema and validator, or why it has none. */
type Compiled =
	| { schema: Record<string, unknown>; validator: Validator }
	| { problem: string };

function compile(tool: PageTool): Compiled {
	const made = schemaFor(tool);
	if ("problem" in made) return made;
	try {
		return {
			schema: made.schema,
			validator: new Validator(made.schema, "2020-12", false),
		};
	} catch (error) {
		return { problem: `its inputSchema cannot be used: ${message(error)}` };
	}
}

/**
 * What makes two offers the same tool: re-register only when it changes.
 * `canonicalJson`, so that the same tool with its fields in another order
 * is the same (DEC-217).
 */
const keyOf = (tabId: number, documentId: string, tool: PageTool) =>
	canonicalJson([tabId, documentId, tool]);

/** The origin of `url` as Chrome reports a tab's address; `undefined` if none. */
function originOf(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

const refuse: Confirm = async () => {
	throw new Error("The user did not allow this call.");
};

export class PageToolBridge {
	readonly #registrar: Registrar;
	readonly #chrome: BridgeChrome;
	readonly #timeoutMs: number;
	readonly #pageChangedRetryMs: number;
	/** A read again after a PageChangedError is planned or done, until a read succeeds. */
	#retried = false;
	readonly #changed: () => void;
	readonly #confirm: Confirm;
	readonly #note: NonNullable<BridgeOptions["note"]>;
	readonly #callIn: NonNullable<BridgeOptions["callIn"]>;
	/** The registered tools by AI app name, with what they were made from. */
	readonly #registered = new Map<
		string,
		{ key: string; controller: AbortController }
	>();
	/** The page's offered tools by their page name, for `webmcp_call`. */
	#callable = new Map<string, Callable>();
	/** The schemas and validators of the last read, by `keyOf`. */
	#compiled = new Map<string, Compiled>();
	/**
	 * Those of the last read of a tab whose tools are not offered (the
	 * panel's tab in front while a pinned one is, a `tab` argument): read
	 * again and again, it compiles each tool once.
	 */
	#otherCompiled = new Map<string, Compiled>();
	#state: BridgeState = { available: false, tools: [] };
	/** The refresh running, and whether another was asked for meanwhile. */
	#running: Promise<void> | undefined;
	#again = false;
	#stopped = false;

	constructor(
		registrar: Registrar,
		chrome: BridgeChrome,
		options: BridgeOptions = {},
	) {
		this.#registrar = registrar;
		this.#chrome = chrome;
		this.#changed = options.changed ?? (() => {});
		this.#confirm = options.confirm ?? refuse;
		this.#note = options.note ?? (() => {});
		this.#callIn = options.callIn ?? (async () => true);
		this.#timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
		this.#pageChangedRetryMs =
			options.pageChangedRetryMs ?? PAGE_CHANGED_RETRY_MS;
	}

	get state(): BridgeState {
		return this.#state;
	}

	/**
	 * Read the tools of the page in front again and offer them. One read runs
	 * at a time; asked again meanwhile, it reads once more after. Resolves
	 * when the state is that of a read that started after this call.
	 */
	refresh(): Promise<void> {
		if (this.#running) {
			this.#again = true;
			return this.#running;
		}
		const loop = async () => {
			do {
				this.#again = false;
				await this.#read();
			} while (this.#again && !this.#stopped);
		};
		this.#running = loop().finally(() => {
			this.#running = undefined;
		});
		return this.#running;
	}

	/** Unregister every page tool; the bridge does nothing more. */
	stop(): void {
		this.#stopped = true;
		this.#offer([]);
		this.#callable = new Map();
	}

	/**
	 * The state of `tab` as `webmcp_tools` lists it, read again now (unless
	 * `refresh` is false: the panel's read, after a refresh). For the tab
	 * whose tools are offered, the bridge's own state; for another tab (a
	 * `tab` argument, the panel's tab in front while a pinned one is
	 * offered), a read of its own that offers nothing.
	 */
	async stateOf(
		tab: TargetTab,
		{ refresh = true }: { refresh?: boolean } = {},
	): Promise<BridgeState> {
		if (refresh) await this.refresh();
		if (this.#state.tabId === tab.id) return this.#state;
		try {
			return (await this.#readOther(tab)).state;
		} catch (error) {
			return {
				tabId: tab.id,
				available: false,
				tools: [],
				error: message(error),
			};
		}
	}

	/**
	 * `webmcp_call`: call the page's tool `name` (its page name) with the same
	 * rules as its `page_<name>` tool, for AI apps that read their tool list
	 * once and so do not see `page_<name>` tools that came later. `tab`: the
	 * tab the call is for (a `tab` argument, or the target); one whose tools
	 * are not the ones offered is read for this call alone. `named`: a `tab`
	 * argument named it, so it stays the call's tab whatever comes to the
	 * front or is pinned meanwhile.
	 */
	async callByName(
		name: string,
		args: unknown,
		options: ToolExecuteCallbackOptions,
		tab?: TargetTab,
		named = false,
	): Promise<unknown> {
		// A page that does not answer is given up by the read itself; the AI
		// app's cancel ends the wait too.
		await Promise.race([this.refresh(), abortedWith(options.signal)]);
		let callable: Callable | undefined;
		let state: BridgeState;
		let now: () => Promise<Callable | undefined>;
		if (tab === undefined || tab.id === this.#state.tabId) {
			callable = this.#callable.get(name);
			state = this.#state;
			// A tab the call's `tab` argument named stays its tab throughout
			// (DEC-230): after the question its tool is looked up there, in
			// the offered tools only while they are still that tab's.
			now =
				named && tab !== undefined
					? async () =>
							this.#state.tabId === tab.id
								? this.#callable.get(name)
								: (
										await this.#readOther(tab).catch(() => undefined)
									)?.callable.get(name)
					: async () => this.#callable.get(name);
		} else {
			const read = await Promise.race([
				this.#readOther(tab),
				abortedWith(options.signal),
			]);
			callable = read.callable.get(name);
			state = read.state;
			now = async () =>
				(await this.#readOther(tab).catch(() => undefined))?.callable.get(name);
		}
		if (callable === undefined) {
			const left = state.tools.find(
				(t) => t.name === cut(name, MAX_NAME) && t.problem !== undefined,
			);
			throw new Error(
				left === undefined
					? `The page in the tab offers no tool ${cut(name, MAX_NAME)}; webmcp_tools lists its tools.${state.error === undefined ? "" : ` (${state.error})`}`
					: `The page's tool ${left.name} is not offered: ${left.problem}.`,
			);
		}
		const input = args ?? {};
		const checked = callable.validator.validate(input);
		if (!checked.valid)
			throw new TypeError(
				`The arguments do not match the inputSchema of ${name}: ${checked.errors
					.slice(0, 3)
					.map((e) => `${e.instanceLocation} ${e.error}`)
					.join("; ")}`,
			);
		return this.#allowedThenRun(callable, input, options, now);
	}

	/**
	 * Ask first for a tool that is not read-only (both ways of calling it),
	 * then run it if it is still the tool the user was asked about (`now`:
	 * the tool of that name as its tab offers it after the question). An AI
	 * app's call goes to the page with a vouch (allowed) or, for a
	 * read-only tool, a claim: the one place either is made (DEC-207,
	 * DEC-224).
	 */
	async #allowedThenRun(
		callable: Callable,
		input: unknown,
		options: ToolExecuteCallbackOptions,
		now: () => Promise<Callable | undefined>,
	): Promise<unknown> {
		const { target } = callable;
		const { client } = options;
		this.#note(options.signal, { site: callable.origin });
		if (!target.readOnly) {
			await this.#confirm(
				{
					tool: {
						// The AI app's name of the tool, for both ways of calling it.
						name: bridgedName(target.name) ?? `${PREFIX}${target.name}`,
						title: callable.title,
						description: callable.description,
					},
					arguments: input as Record<string, unknown>,
					client: options.client,
					signal: options.signal,
				},
				{
					tabId: callable.tabId,
					origin: callable.origin,
					documentId: target.documentId,
					name: target.name,
					readOnly: target.readOnly,
				},
			);
			// A page that changed while the question was open (a navigation,
			// another tab in front with a tool of the same name, the tool
			// offered again with another title, description, schema or hint)
			// gets nothing.
			const after = await now();
			if (after === undefined || !sameTool(after, callable))
				throw new Error(
					`The page's tool ${cut(target.name, MAX_NAME)} changed while the user was asked; it did not run. webmcp_tools lists the page's tools now.`,
				);
		}
		// Allowed and still the same tool (the page may skip its own
		// question), or read-only: the page learns the call is the
		// extension's, for this AI app, and gives it the whole MCP result,
		// pictures too. Only an AI app through the relay gets past `decide`;
		// a read-only call of any other caller goes without.
		return client.kind === "relay"
			? this.#run(callable, input, options, {
					nonce: crypto.randomUUID(),
					app: { name: client.name ?? "", host: client.host },
					allowed: !target.readOnly,
				})
			: this.#run(callable, input, options);
	}

	/** Call a page tool with the timeout and cancellation; the call always ends. */
	async #run(
		callable: Callable,
		input: unknown,
		options: ToolExecuteCallbackOptions,
		vouch?: Vouch,
	): Promise<unknown> {
		const { target } = callable;
		// Cancelled before it reached the page: no call, whose cancel could
		// never come (an abort that came before it is no event any more).
		if (options.signal.aborted)
			throw new Error(`The call to ${target.name} was cancelled.`);
		const timeout = AbortSignal.timeout(this.#timeoutMs);
		const signal = AbortSignal.any([options.signal, timeout]);
		// Ends when the signal aborts, even if the page never answers (a blocked
		// page cannot even take the cancel message).
		const result = await Promise.race([
			this.#chrome.call(callable.tabId, target, input, signal, vouch),
			abortedWith(signal).catch(() => "aborted" as const),
		]);
		if (result === "aborted" || timeout.aborted) {
			if (timeout.aborted) {
				this.#note(options.signal, { timedOut: true });
				throw new Error(
					`The page's tool ${target.name} did not answer within ${Math.round(this.#timeoutMs / 1000)} s.`,
				);
			}
			throw new Error(`The call to ${target.name} was cancelled.`);
		}
		if (result.ok ? result.value === null : result.navigated === true) {
			// The tool navigated (Chrome's `null`), or the page went away while
			// it ran: a tool that navigates (a checkout, a search) ends so. Not
			// a failure: it may well have done its work (WM 2).
			// Only the AI app's cancel ends this wait, not what is left of the
			// call's 60 s: the load has its own limit (then `loading: true`).
			const page = await this.#chrome
				.settled(callable.tabId, options.signal)
				.catch((error: unknown) => ({
					readable: false,
					reason: message(error),
				}));
			// The new page's page_<name> tools are offered before the answer.
			await this.refresh().catch(() => {});
			return {
				navigated: true,
				note: `The page in the tab changed while ${target.name} ran (the tool navigated it, or the tab closed): the tool may have completed. page is the tab's page now; webmcp_tools lists its tools.`,
				page,
			};
		}
		if (!result.ok)
			throw new Error(
				result.gone
					? `${result.error} The page's tools may have changed; webmcp_tools lists them.`
					: `The page's tool ${target.name} failed: ${result.error}`,
			);
		return resultOf(result.value ?? "");
	}

	/**
	 * The tools of the page in `tab`. The origin is the content script's
	 * word; what Chrome reports for the tab is not the page's. A page that
	 * says it is another site (or a tab that navigated meanwhile) gets no
	 * tools.
	 */
	async #list(tab: TargetTab): Promise<PageTools> {
		const tools = await this.#chrome.list(tab);
		if (originOf(tab.url) !== tools.origin)
			throw new PageChangedError(
				"The page in the tab changed while its tools were read; they are read again once it has loaded.",
			);
		return tools;
	}

	/** The tools of `tab`, a tab whose tools are not offered, for one call. */
	async #readOther(tab: TargetTab): Promise<Made> {
		const made = this.#make(tab, await this.#list(tab));
		this.#otherCompiled = made.compiled;
		return made;
	}

	async #read(): Promise<void> {
		let tab: TargetTab;
		let tools: PageTools;
		let readFrom: number | undefined;
		try {
			tab = await this.#chrome.current();
			readFrom = tab.id;
			tools = await this.#list(tab);
		} catch (error) {
			if (this.#stopped) return;
			this.#offer([]);
			this.#callable = new Map();
			// The tab it failed on, so the panel can say why its tools are missing.
			this.#state = {
				...(readFrom !== undefined ? { tabId: readFrom } : {}),
				available: false,
				tools: [],
				error: message(error),
			};
			this.#changed();
			// Caught between two pages (a page Chrome shows again from its
			// back/forward cache loads nothing, so no later event reads it):
			// once more shortly after. A page that keeps saying it is another
			// site stays without tools.
			if (error instanceof PageChangedError && !this.#retried) {
				this.#retried = true;
				setTimeout(() => {
					if (!this.#stopped) this.refresh().catch(() => {});
				}, this.#pageChangedRetryMs);
			}
			return;
		}
		this.#retried = false;
		if (this.#stopped) return;
		const made = this.#make(tab, tools);
		this.#offer(made.wanted, made.offered);
		this.#callable = made.callable;
		this.#compiled = made.compiled;
		this.#state = made.state;
		this.#changed();
	}

	/**
	 * What the bridge offers of the tools `tools` of the page in `tab`: the
	 * listing, the tools to register, the callables; the schemas compiled
	 * once per tool as offered (`#compiled` is only read here).
	 */
	#make(tab: TargetTab, tools: PageTools): Made {
		const offered: Offered[] = [];
		const wanted: { name: string; key: string; tool: ModelContextTool }[] = [];
		const callable = new Map<string, Callable>();
		const compiled = new Map<string, Compiled>();
		let more = tools.more;
		// The descriptions of the tools offered share one budget.
		const cap = descriptionCap(
			tools.tools
				.slice(0, MAX_TOOLS)
				.map((t) => byteLength(pageText(t.description))),
		);
		for (const pageTool of tools.tools) {
			if (offered.length >= MAX_TOOLS) {
				more++;
				continue;
			}
			const readOnly = pageTool.annotations?.readOnlyHint === true;
			const destructive = destructiveOf(pageTool);
			const title = cut(pageTool.title ?? pageTool.name, MAX_TITLE);
			const description = describe(tools.origin, pageTool.description, cap);
			const entry: Offered = {
				name: cut(pageTool.name, MAX_NAME),
				...(pageTool.title ? { title: cut(pageTool.title, MAX_TITLE) } : {}),
				description,
				readOnly,
				destructive,
			};
			offered.push(entry);
			// WebMCP's hint for tools meant for the page's developers (WM 8).
			if (pageTool.annotations?.debugging === true) {
				entry.problem =
					"it is marked as a debugging tool, for the page's developers";
				continue;
			}
			const name = bridgedName(pageTool.name);
			if (name === undefined) {
				entry.problem = "its name is too long (page_<name> over 64 characters)";
				continue;
			}
			// `info` would become the extension's own page_info: not offered,
			// nor callable through webmcp_call.
			if (OWN_TOOLS.has(name)) {
				entry.problem = `its name becomes ${name}, the extension's own tool`;
				continue;
			}
			const clash = [...callable.values()].find(
				(c) => bridgedName(c.target.name) === name,
			);
			if (clash !== undefined) {
				entry.problem = `its name becomes ${name}, as ${cut(clash.target.name, MAX_NAME)} does`;
				continue;
			}
			// The schema and its validator once per tool as offered, not on
			// every refresh (each tab switch, each toolchange).
			const key = keyOf(tab.id, tools.documentId, pageTool);
			const made =
				this.#compiled.get(key) ??
				this.#otherCompiled.get(key) ??
				compile(pageTool);
			compiled.set(key, made);
			if ("problem" in made) {
				entry.problem = made.problem;
				continue;
			}
			const { schema, validator } = made;
			entry.tool = name;
			entry.inputSchema = schema;
			const output = outputSchemaOf(pageTool.outputSchema);
			if (output !== undefined) entry.outputSchema = output;
			const item: Callable = {
				key,
				tabId: tab.id,
				origin: tools.origin,
				target: {
					documentId: tools.documentId,
					name: pageTool.name,
					readOnly,
					// The content script compares it with the tool it is about
					// to call (DEC-217): the same spelling as its `definitionOf`.
					definition: canonicalJson(pageTool),
				},
				title,
				description,
				validator,
				destructive,
			};
			callable.set(pageTool.name, item);
			wanted.push({ name, key, tool: this.#tool(item, name, schema) });
		}
		return {
			offered,
			wanted,
			callable,
			compiled,
			state: {
				tabId: tab.id,
				documentId: tools.documentId,
				url: tools.url,
				origin: tools.origin,
				available: tools.available,
				tools: offered,
				...(more ? { more } : {}),
				...(tools.error ? { error: cut(tools.error, MAX_ERROR) } : {}),
				...(tools.library ? { library: tools.library } : {}),
			},
		};
	}

	/** Make the registered tools those of `wanted`. */
	#offer(
		wanted: { name: string; key: string; tool: ModelContextTool }[],
		offered: Offered[] = [],
	): void {
		const keys = new Map(wanted.map((w) => [w.name, w.key]));
		for (const [name, registered] of this.#registered)
			if (keys.get(name) !== registered.key) {
				registered.controller.abort();
				this.#registered.delete(name);
			}
		for (const { name, key, tool } of wanted) {
			if (this.#registered.has(name)) continue;
			const controller = new AbortController();
			this.#registered.set(name, { key, controller });
			this.#registrar
				.registerTool(tool, { signal: controller.signal })
				.catch((error: unknown) => {
					// Unregistered since (a newer read): nothing to undo.
					if (this.#registered.get(name)?.controller !== controller) return;
					// The library refused it (its schema, say): not offered, and
					// not callable through webmcp_call either. Kept as this tool's
					// problem, so the next read neither offers it again nor makes
					// it callable for a moment.
					const problem = cut(message(error), MAX_ERROR);
					this.#registered.delete(name);
					this.#compiled.set(key, { problem });
					for (const [pageName, c] of this.#callable)
						if (bridgedName(c.target.name) === name)
							this.#callable.delete(pageName);
					const entry = offered.find((o) => o.tool === name);
					if (entry) {
						delete entry.tool;
						delete entry.inputSchema;
						delete entry.outputSchema;
						entry.problem = problem;
						this.#changed();
					}
				});
		}
	}

	/**
	 * The `page_<name>` tool for a page tool. Not `consequentialHint`: the
	 * bridge asks itself (`confirm`), as `webmcp_call` does, so that the AI
	 * app hears why a call did not run (not answered in time, too many
	 * questions waiting) and not only "declined". `destructiveHint` passes
	 * on what the page says about the tool, not that the bridge asks.
	 */
	#tool(
		callable: Callable,
		name: string,
		schema: Record<string, unknown>,
	): ModelContextTool {
		return {
			name,
			title: callable.title,
			description: callable.description,
			inputSchema: schema,
			annotations: {
				readOnlyHint: callable.target.readOnly,
				// Always given: MCP's default for a missing one is true.
				destructiveHint: callable.destructive,
				// Whatever it answers is the page's.
				untrustedContentHint: true,
			},
			// It follows the tab calls go to (it can take no `tab` argument,
			// which could clash with the page's own): offered from a tab that
			// is no longer that one (another was pinned since), it does not run.
			execute: async (input, options) => {
				if (!(await this.#callIn(callable.tabId))) {
					void this.refresh().catch(() => {});
					throw new Error(
						`AI apps work in another tab now (it was pinned after ${name} was offered); ${name} did not run. webmcp_tools lists the tools of that tab.`,
					);
				}
				return this.#allowedThenRun(callable, input, options, async () =>
					this.#callable.get(callable.target.name),
				);
			},
		};
	}
}

/** What `#make` makes of a page's tools. */
interface Made {
	offered: Offered[];
	wanted: { name: string; key: string; tool: ModelContextTool }[];
	callable: Map<string, Callable>;
	compiled: Map<string, Compiled>;
	state: BridgeState;
}

/**
 * Rejects once `signal` aborts (never resolves). Meant for `Promise.race`:
 * a rejection after the race was decided is not reported as unhandled.
 */
function abortedWith(signal: AbortSignal): Promise<never> {
	const aborted = new Promise<never>((_, reject) => {
		const abort = () => reject(new Error("The call was cancelled."));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
	aborted.catch(() => {});
	return aborted;
}
