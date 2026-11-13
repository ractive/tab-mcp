/**
 * The WebMCP bridge (iteration 20): the tools the page in front registered
 * with WebMCP, offered to the AI app as `page_<name>` tools of the
 * connection's `TabMcp`, and through `webmcp_call` for AI apps that read their
 * tool list only once. The list follows the tab in front and the page's
 * `toolchange`; it is advisory (a page may drop a tool any time), so a call
 * to a tool that is gone answers so instead of failing the bridge.
 *
 * Everything that comes from the page is the page's word: names, titles,
 * descriptions, schemas, hints and results. Texts are cut and descriptions
 * start with the page's origin (checked against the address Chrome reports);
 * results are marked untrusted and cut; a tool not marked read-only asks the
 * user every time (both ways of calling it ask here, through `confirm`); a
 * call runs only on the page its tool was listed from, with the read-only
 * claim it was offered with.
 */

import {
	ignoredKeyword,
	schemaArrayKeyword,
	schemaMapKeyword,
	Validator,
} from "@cfworker/json-schema";
import type {
	ConfirmRequest,
	Tool,
	ToolExecuteOptions,
} from "@ractive-ch/tab-mcp-client";
import type { CallResult, PageTool, PageTools } from "../messages.ts";
import type { TargetTab } from "../tabs.ts";
import { OWN_TOOL_NAMES } from "./tools.ts";

/** At most this many page tools are offered (and listed). */
export const MAX_TOOLS = 64;
/** A description (after the origin) is cut to this many characters. */
export const MAX_DESCRIPTION = 1000;
/** A title is cut to this many characters. */
export const MAX_TITLE = 100;
/** A name shown (also one that does not fit `page_<name>`) is cut to this. */
export const MAX_NAME = 128;
/** A schema bigger than this (as JSON) leaves its tool out. */
export const MAX_SCHEMA_BYTES = 16 * 1024;
/** A result's text, all blocks together, is cut to this many characters. */
export const MAX_RESULT = 100_000;
/** At most this many content blocks. */
export const MAX_BLOCKS = 32;
/**
 * The image data of one result, all images together (base64 characters).
 * With the text above, a result stays under the relay's default limit of
 * 1 MiB per response; an image beyond it is left out with a note.
 */
export const MAX_IMAGES_BASE64 = 640 * 1024;
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

/** The page's description, cut, after its origin. */
export function describe(origin: string, description: string): string {
	const text = description.trim() || "(no description)";
	return `From ${origin}: ${cut(text, MAX_DESCRIPTION)}`;
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
 */
function withoutPatterns(schema: unknown): unknown {
	if (!isObject(schema)) return schema;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "pattern" || key === "patternProperties") continue;
		if (
			(has(schemaMapKeyword, key) || key === "dependencies") &&
			isObject(value)
		) {
			// Names, each with a schema (`dependencies`: or a list of names).
			const map: Record<string, unknown> = {};
			for (const [name, sub] of Object.entries(value))
				map[name] = withoutPatterns(sub);
			out[key] = map;
		} else if (Array.isArray(value))
			out[key] = has(schemaArrayKeyword, key)
				? value.map(withoutPatterns)
				: value;
		else if (has(ignoredKeyword, key)) out[key] = value;
		else out[key] = withoutPatterns(value);
	}
	return out;
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

/** An MCP content block a page result may carry through. */
type Block =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The blocks of an MCP result, within the budget; `undefined` if it is none. */
function blocksOf(value: unknown): Block[] | undefined {
	if (!isObject(value) || !Array.isArray(value["content"])) return undefined;
	if (value["content"].length > MAX_BLOCKS) return undefined;
	const blocks: Block[] = [];
	let text = MAX_RESULT;
	let images = MAX_IMAGES_BASE64;
	for (const item of value["content"]) {
		if (!isObject(item)) return undefined;
		if (item["type"] === "text" && typeof item["text"] === "string") {
			if (text <= 0) continue;
			const kept = cut(item["text"], text);
			text -= kept.length;
			blocks.push({ type: "text", text: kept });
		} else if (
			item["type"] === "image" &&
			typeof item["data"] === "string" &&
			BASE64.test(item["data"]) &&
			typeof item["mimeType"] === "string" &&
			/^image\/(png|jpeg|gif|webp)$/.test(item["mimeType"])
		) {
			if (item["data"].length > images) {
				blocks.push({
					type: "text",
					text: `[An image of ${Math.ceil(item["data"].length / 1024)} KiB (base64) was left out: the images of one result may have ${MAX_IMAGES_BASE64 / 1024} KiB together.]`,
				});
				continue;
			}
			images -= item["data"].length;
			blocks.push({
				type: "image",
				data: item["data"],
				mimeType: item["mimeType"],
			});
		} else return undefined;
	}
	return blocks;
}

/**
 * What `executeTool()` returned, as the tool's result: a string as one text
 * block; the JSON of an MCP result (`{"content": [...]}`, what
 * `@mcp-b/global` pages return) as its text and image blocks within the
 * budget. (`null`, the tool navigated, is answered with the new page.)
 */
export function resultOf(value: string): unknown {
	if (value.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(value);
			const blocks = blocksOf(parsed);
			if (blocks !== undefined)
				return isObject(parsed) && parsed["isError"] === true
					? { content: blocks, isError: true }
					: { content: blocks };
		} catch {
			// Not JSON: the text as it is.
		}
	}
	return cut(value, MAX_RESULT);
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
	 * The arguments it takes, as offered (`webmcp_call` checks them against
	 * it): only for a tool that is offered.
	 */
	inputSchema?: Record<string, unknown>;
	/** Why it is not offered. */
	problem?: string;
}

/** What the bridge knows about the page in front, for `webmcp_tools` and the panel. */
export interface BridgeState {
	/** The tab it was read from. */
	tabId?: number;
	url?: string;
	origin?: string;
	/** `document.modelContext` is there. */
	available: boolean;
	tools: Offered[];
	/** Tools the page has beyond those listed. */
	more?: number;
	/** Why there are no tools: no access, an error. */
	error?: string;
}

/** Which page tool a call is for: the page it was listed from, its claim. */
export interface CallTarget {
	documentId: string;
	name: string;
	readOnly: boolean;
}

/** What the bridge needs from Chrome. */
export interface BridgeChrome {
	current(): Promise<TargetTab>;
	list(tab: TargetTab): Promise<PageTools>;
	call(
		tabId: number,
		target: CallTarget,
		input: unknown,
		signal: AbortSignal,
	): Promise<CallResult>;
	/**
	 * Tab `tabId` after its page went away during a call: wait until it has
	 * loaded and give its `page_info` (or why it cannot be read).
	 */
	settled(tabId: number, signal: AbortSignal): Promise<unknown>;
}

/** Where the bridged tools go: the connection's `TabMcp`. */
export interface Registrar {
	registerTool(tool: Tool, options: { signal: AbortSignal }): Promise<void>;
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
	timeoutMs?: number;
}

/** A tool of the page in front as the bridge keeps it, to call. */
interface Callable {
	tabId: number;
	origin: string;
	target: CallTarget;
	title: string;
	description: string;
	validator: Validator;
}

/** Whether `a` and `b` are the same tool of the same page in the same tab. */
const sameTool = (a: Callable, b: Callable): boolean =>
	a.tabId === b.tabId &&
	a.origin === b.origin &&
	a.target.documentId === b.target.documentId &&
	a.target.name === b.target.name &&
	a.target.readOnly === b.target.readOnly;

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

/** What makes two offers the same tool: re-register only when it changes. */
const keyOf = (tabId: number, documentId: string, tool: PageTool) =>
	JSON.stringify([tabId, documentId, tool]);

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
	readonly #changed: () => void;
	readonly #confirm: Confirm;
	/** The registered tools by AI app name, with what they were made from. */
	readonly #registered = new Map<
		string,
		{ key: string; controller: AbortController }
	>();
	/** The page's offered tools by their page name, for `webmcp_call`. */
	#callable = new Map<string, Callable>();
	/** The schemas and validators of the last read, by `keyOf`. */
	#compiled = new Map<string, Compiled>();
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
		this.#timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
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
	 * `webmcp_call`: call the page's tool `name` (its page name) with the same
	 * rules as its `page_<name>` tool, for AI apps that read their tool list
	 * once and so do not see `page_<name>` tools that came later.
	 */
	async callByName(
		name: string,
		args: unknown,
		options: ToolExecuteOptions,
	): Promise<unknown> {
		// A page that does not answer is given up by the read itself; the AI
		// app's cancel ends the wait too.
		await Promise.race([this.refresh(), abortedWith(options.signal)]);
		const callable = this.#callable.get(name);
		if (callable === undefined) {
			const left = this.#state.tools.find(
				(t) => t.name === cut(name, MAX_NAME) && t.problem !== undefined,
			);
			throw new Error(
				left === undefined
					? `The page in front offers no tool ${cut(name, MAX_NAME)}; webmcp_tools lists its tools.`
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
		return this.#allowedThenRun(callable, input, options);
	}

	/**
	 * Ask first for a tool that is not read-only (both ways of calling it),
	 * then run it if it is still the tool the user was asked about.
	 */
	async #allowedThenRun(
		callable: Callable,
		input: unknown,
		options: ToolExecuteOptions,
	): Promise<unknown> {
		const { target } = callable;
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
			// another tab in front with a tool of the same name) gets nothing.
			const now = this.#callable.get(target.name);
			if (now === undefined || !sameTool(now, callable))
				throw new Error(
					`The page's tool ${cut(target.name, MAX_NAME)} changed while the user was asked; it did not run. webmcp_tools lists the tools of the page in front.`,
				);
		}
		return this.#run(callable, input, options);
	}

	/** Call a page tool with the timeout and cancellation; the call always ends. */
	async #run(
		callable: Callable,
		input: unknown,
		options: ToolExecuteOptions,
	): Promise<unknown> {
		const { target } = callable;
		const timeout = AbortSignal.timeout(this.#timeoutMs);
		const signal = AbortSignal.any([options.signal, timeout]);
		// Ends when the signal aborts, even if the page never answers (a blocked
		// page cannot even take the cancel message).
		const result = await Promise.race([
			this.#chrome.call(callable.tabId, target, input, signal),
			abortedWith(signal).catch(() => "aborted" as const),
		]);
		if (result === "aborted" || timeout.aborted) {
			if (timeout.aborted)
				throw new Error(
					`The page's tool ${target.name} did not answer within ${Math.round(this.#timeoutMs / 1000)} s.`,
				);
			throw new Error(`The call to ${target.name} was cancelled.`);
		}
		if (result.ok ? result.value === null : result.navigated === true) {
			// The tool navigated (Chrome's `null`), or the page went away while
			// it ran: a tool that navigates (a checkout, a search) ends so. Not
			// a failure: it may well have done its work (WM 2).
			const page = await this.#chrome
				.settled(callable.tabId, signal)
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

	async #read(): Promise<void> {
		let tab: TargetTab;
		let tools: PageTools;
		try {
			tab = await this.#chrome.current();
			tools = await this.#chrome.list(tab);
			// The origin is the content script's word; what Chrome reports for
			// the tab is not the page's. A page that says it is another site
			// (or a tab that navigated meanwhile) gets no tools.
			if (originOf(tab.url) !== tools.origin)
				throw new Error(
					"The page in the tab changed while its tools were read; they are read again once it has loaded.",
				);
		} catch (error) {
			if (this.#stopped) return;
			this.#offer([]);
			this.#callable = new Map();
			this.#state = { available: false, tools: [], error: message(error) };
			this.#changed();
			return;
		}
		if (this.#stopped) return;
		const offered: Offered[] = [];
		const wanted: { name: string; key: string; tool: Tool }[] = [];
		const callable = new Map<string, Callable>();
		const compiled = new Map<string, Compiled>();
		let more = tools.more;
		for (const pageTool of tools.tools) {
			if (offered.length >= MAX_TOOLS) {
				more++;
				continue;
			}
			const readOnly = pageTool.annotations?.readOnlyHint === true;
			const title = cut(pageTool.title ?? pageTool.name, MAX_TITLE);
			const description = describe(tools.origin, pageTool.description);
			const entry: Offered = {
				name: cut(pageTool.name, MAX_NAME),
				...(pageTool.title ? { title: cut(pageTool.title, MAX_TITLE) } : {}),
				description,
				readOnly,
			};
			offered.push(entry);
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
			const made = this.#compiled.get(key) ?? compile(pageTool);
			compiled.set(key, made);
			if ("problem" in made) {
				entry.problem = made.problem;
				continue;
			}
			const { schema, validator } = made;
			entry.tool = name;
			entry.inputSchema = schema;
			const item: Callable = {
				tabId: tab.id,
				origin: tools.origin,
				target: { documentId: tools.documentId, name: pageTool.name, readOnly },
				title,
				description,
				validator,
			};
			callable.set(pageTool.name, item);
			wanted.push({ name, key, tool: this.#tool(item, name, schema) });
		}
		this.#offer(wanted, offered);
		this.#callable = callable;
		this.#compiled = compiled;
		this.#state = {
			tabId: tab.id,
			url: tools.url,
			origin: tools.origin,
			available: tools.available,
			tools: offered,
			...(more ? { more } : {}),
			...(tools.error ? { error: cut(tools.error, MAX_DESCRIPTION) } : {}),
		};
		this.#changed();
	}

	/** Make the registered tools those of `wanted`. */
	#offer(
		wanted: { name: string; key: string; tool: Tool }[],
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
					const problem = cut(message(error), MAX_DESCRIPTION);
					this.#registered.delete(name);
					this.#compiled.set(key, { problem });
					for (const [pageName, c] of this.#callable)
						if (bridgedName(c.target.name) === name)
							this.#callable.delete(pageName);
					const entry = offered.find((o) => o.tool === name);
					if (entry) {
						delete entry.tool;
						delete entry.inputSchema;
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
	 * questions waiting) and not only "declined".
	 */
	#tool(
		callable: Callable,
		name: string,
		schema: Record<string, unknown>,
	): Tool {
		return {
			name,
			title: callable.title,
			description: callable.description,
			inputSchema: schema,
			annotations: {
				readOnlyHint: callable.target.readOnly,
				// Not read-only: the user confirms every call (MCP's hint for it).
				destructiveHint: !callable.target.readOnly,
				// Whatever it answers is the page's.
				untrustedContentHint: true,
			},
			execute: (input, options) =>
				this.#allowedThenRun(callable, input, options),
		};
	}
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
