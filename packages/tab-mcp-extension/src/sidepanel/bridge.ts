/**
 * The WebMCP bridge (iteration 20): the tools the page in front registered
 * with WebMCP, offered to the AI app as `page_<name>` tools of the side
 * panel's `TabMcp`, and through `webmcp_call` for AI apps that read their
 * tool list only once. The list follows the tab in front and the page's
 * `toolchange`; it is advisory (a page may drop a tool any time), so a call
 * to a tool that is gone answers so instead of failing the bridge.
 *
 * Everything that comes from the page is the page's word: names, titles,
 * descriptions, schemas, hints and results. Texts are cut and descriptions
 * start with the page's origin; results are marked untrusted and cut; a tool
 * not marked read-only asks the user every time; a call runs only on the page
 * its tool was listed from, with the read-only claim it was offered with.
 */

import { Validator } from "@cfworker/json-schema";
import type {
	ConfirmRequest,
	Tool,
	ToolExecuteOptions,
} from "@ractive-ch/tab-mcp-client";
import type { CallResult, PageTool, PageTools } from "../messages.ts";
import type { TargetTab } from "../tabs.ts";

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
/** At most this many content blocks, and image data up to this size. */
export const MAX_BLOCKS = 32;
export const MAX_IMAGE_BASE64 = 1024 * 1024;
/** A call the page does not answer in this time is given up. */
export const CALL_TIMEOUT_MS = 60_000;

const PREFIX = "page_";
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

/** The page's description, cut, after its origin. */
export function describe(origin: string, description: string): string {
	const text = description.trim() || "(no description)";
	return `From ${origin}: ${cut(text, MAX_DESCRIPTION)}`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A copy of `schema` without the keywords whose regular expressions the
 * validator would run in the side panel (`pattern`, `patternProperties`): a
 * page's catastrophic pattern would freeze the panel. The page still checks
 * its own input as it likes.
 */
function withoutPatterns(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(withoutPatterns);
	if (!isObject(schema)) return schema;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "pattern" || key === "patternProperties") continue;
		out[key] = withoutPatterns(value);
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
			item["data"].length <= MAX_IMAGE_BASE64 &&
			BASE64.test(item["data"]) &&
			typeof item["mimeType"] === "string" &&
			/^image\/(png|jpeg|gif|webp)$/.test(item["mimeType"])
		)
			blocks.push({
				type: "image",
				data: item["data"],
				mimeType: item["mimeType"],
			});
		else return undefined;
	}
	return blocks;
}

/**
 * What `executeTool()` returned, as the tool's result: a string as one text
 * block; the JSON of an MCP result (`{"content": [...]}`, what
 * `@mcp-b/global` pages return) as its text and image blocks within the
 * budget; `null` (the tool navigated) as a note.
 */
export function resultOf(value: string | null): unknown {
	if (value === null)
		return "The tool started a navigation: the page in the tab has changed.";
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
	/** Why it is not offered. */
	problem?: string;
}

/** What the bridge knows about the page in front, for `webmcp_tools` and the panel. */
export interface BridgeState {
	url?: string;
	origin?: string;
	/** `document.modelContext` is there. */
	available: boolean;
	tools: Offered[];
	/** Tools the page has beyond those listed. */
	more?: number;
	/** Names a tab-mcp page offers itself (iteration 25), left out. */
	mirrored: string[];
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
}

/** Where the bridged tools go: the side panel's `TabMcp`. */
export interface Registrar {
	registerTool(tool: Tool, options: { signal: AbortSignal }): Promise<void>;
}

/** Asks the user (the library's dialog): `webmcp_call`'s confirmation. */
export type Confirm = (request: ConfirmRequest) => Promise<boolean>;

/** A tool of the page in front as the bridge keeps it, to call. */
interface Callable {
	tabId: number;
	origin: string;
	target: CallTarget;
	title: string;
	description: string;
	validator: Validator;
}

/** What makes two offers the same tool: re-register only when it changes. */
const keyOf = (tabId: number, documentId: string, tool: PageTool) =>
	JSON.stringify([tabId, documentId, tool]);

/** Call a page tool with the timeout and cancellation; the call always ends. */
async function run(
	call: BridgeChrome["call"],
	callable: Callable,
	input: unknown,
	options: ToolExecuteOptions,
	timeoutMs: number,
): Promise<unknown> {
	const { target } = callable;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = AbortSignal.any([options.signal, timeout]);
	// Ends when the signal aborts, even if the page never answers (a blocked
	// page cannot even take the cancel message).
	const aborted = new Promise<"aborted">((resolve) => {
		if (signal.aborted) resolve("aborted");
		signal.addEventListener("abort", () => resolve("aborted"), { once: true });
	});
	const result = await Promise.race([
		call(callable.tabId, target, input, signal),
		aborted,
	]);
	if (result === "aborted" || timeout.aborted) {
		if (timeout.aborted)
			throw new Error(
				`The page's tool ${target.name} did not answer within ${Math.round(timeoutMs / 1000)} s.`,
			);
		throw new Error(`The call to ${target.name} was cancelled.`);
	}
	if (!result.ok)
		throw new Error(
			result.gone
				? `${result.error} The page's tools may have changed; webmcp_tools lists them.`
				: `The page's tool ${target.name} failed: ${result.error}`,
		);
	return resultOf(result.value);
}

export class PageToolBridge {
	readonly #registrar: Registrar;
	readonly #chrome: BridgeChrome;
	readonly #timeoutMs: number;
	readonly #changed: () => void;
	/** The registered tools by AI app name, with what they were made from. */
	readonly #registered = new Map<
		string,
		{ key: string; controller: AbortController }
	>();
	/** The page's offered tools by their page name, for `webmcp_call`. */
	#callable = new Map<string, Callable>();
	#state: BridgeState = { available: false, tools: [], mirrored: [] };
	/** The refresh running, and whether another was asked for meanwhile. */
	#running: Promise<void> | undefined;
	#again = false;
	#stopped = false;

	/** `changed` is called after each refresh (for the panel). */
	constructor(
		registrar: Registrar,
		chrome: BridgeChrome,
		changed: () => void = () => {},
		timeoutMs = CALL_TIMEOUT_MS,
	) {
		this.#registrar = registrar;
		this.#chrome = chrome;
		this.#changed = changed;
		this.#timeoutMs = timeoutMs;
	}

	get state(): BridgeState {
		return this.#state;
	}

	/** The page tool behind an offered tool name (`page_<name>`): its site and name. */
	lookup(
		toolName: string,
	): { origin: string; name: string; readOnly: boolean } | undefined {
		for (const callable of this.#callable.values())
			if (bridgedName(callable.target.name) === toolName)
				return {
					origin: callable.origin,
					name: callable.target.name,
					readOnly: callable.target.readOnly,
				};
		return undefined;
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
		confirm: Confirm,
	): Promise<unknown> {
		await this.refresh();
		const callable = this.#callable.get(name);
		if (callable === undefined)
			throw new Error(
				`The page in front offers no tool ${cut(name, MAX_NAME)}; webmcp_tools lists its tools.`,
			);
		const input = args ?? {};
		const checked = callable.validator.validate(input);
		if (!checked.valid)
			throw new TypeError(
				`The arguments do not match the inputSchema of ${name}: ${checked.errors
					.slice(0, 3)
					.map((e) => `${e.instanceLocation} ${e.error}`)
					.join("; ")}`,
			);
		if (!callable.target.readOnly) {
			const allowed = await confirm({
				tool: {
					// The tool's own name, so "Always allow" is one entry for both.
					name: bridgedName(name) ?? `${PREFIX}${name}`,
					title: callable.title,
					description: callable.description,
				},
				arguments: input as Record<string, unknown>,
				client: options.client,
				signal: options.signal,
			});
			if (!allowed) throw new Error("The user did not allow this call.");
		}
		return run(this.#chrome.call, callable, input, options, this.#timeoutMs);
	}

	async #read(): Promise<void> {
		let tab: TargetTab;
		let tools: PageTools;
		try {
			tab = await this.#chrome.current();
			tools = await this.#chrome.list(tab);
		} catch (error) {
			if (this.#stopped) return;
			this.#offer([]);
			this.#callable = new Map();
			this.#state = {
				available: false,
				tools: [],
				mirrored: [],
				error: error instanceof Error ? error.message : String(error),
			};
			this.#changed();
			return;
		}
		if (this.#stopped) return;
		const offered: Offered[] = [];
		const wanted: { name: string; key: string; tool: Tool }[] = [];
		const callable = new Map<string, Callable>();
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
			const clash = [...callable.values()].find(
				(c) => bridgedName(c.target.name) === name,
			);
			if (clash !== undefined) {
				entry.problem = `its name becomes ${name}, as ${cut(clash.target.name, MAX_NAME)} does`;
				continue;
			}
			const schema = schemaFor(pageTool);
			if ("problem" in schema) {
				entry.problem = schema.problem;
				continue;
			}
			let validator: Validator;
			try {
				validator = new Validator(schema.schema, "2020-12", false);
			} catch (error) {
				entry.problem = `its inputSchema cannot be used: ${error instanceof Error ? error.message : String(error)}`;
				continue;
			}
			entry.tool = name;
			const item: Callable = {
				tabId: tab.id,
				origin: tools.origin,
				target: { documentId: tools.documentId, name: pageTool.name, readOnly },
				title,
				description,
				validator,
			};
			callable.set(pageTool.name, item);
			wanted.push({
				name,
				key: keyOf(tab.id, tools.documentId, pageTool),
				tool: this.#tool(item, name, schema.schema),
			});
		}
		this.#offer(wanted, offered);
		this.#callable = callable;
		this.#state = {
			url: tools.url,
			origin: tools.origin,
			available: tools.available,
			tools: offered,
			...(more ? { more } : {}),
			mirrored: tools.mirrored.slice(0, MAX_TOOLS).map((m) => cut(m, MAX_NAME)),
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
					// The library refused it (its schema, say): not offered.
					if (this.#registered.get(name)?.controller === controller)
						this.#registered.delete(name);
					const entry = offered.find((o) => o.tool === name);
					if (entry) {
						delete entry.tool;
						entry.problem = cut(
							error instanceof Error ? error.message : String(error),
							MAX_DESCRIPTION,
						);
						this.#changed();
					}
				});
		}
	}

	/** The `page_<name>` tool for a page tool. */
	#tool(
		callable: Callable,
		name: string,
		schema: Record<string, unknown>,
	): Tool {
		const call = this.#chrome.call;
		const timeoutMs = this.#timeoutMs;
		return {
			name,
			title: callable.title,
			description: callable.description,
			inputSchema: schema,
			annotations: {
				readOnlyHint: callable.target.readOnly,
				// Not read-only: the user confirms every call in the side panel.
				consequentialHint: !callable.target.readOnly,
				// Whatever it answers is the page's.
				untrustedContentHint: true,
			},
			execute: (input, options) =>
				run(call, callable, input, options, timeoutMs),
		};
	}
}
