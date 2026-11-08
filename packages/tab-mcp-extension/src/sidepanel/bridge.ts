/**
 * The WebMCP bridge (iteration 20): the tools the page in front registered
 * with WebMCP, offered to the AI app as `page.<name>` tools of the side
 * panel's `TabMcp`. The list follows the tab in front and the page's
 * `toolchange`; it is advisory (a page may drop a tool any time), so a call
 * to a tool that is gone answers so instead of failing the bridge.
 *
 * Everything that comes from the page is the page's word: names, titles,
 * descriptions, schemas, hints and results. Descriptions start with the
 * page's origin and are cut; results are marked untrusted; a tool not marked
 * read-only asks the user every time (the library's confirmation).
 */

import type { Tool } from "@ractive-ch/tab-mcp-client";
import type { CallResult, PageTool, PageTools } from "../messages.ts";
import type { TargetTab } from "../tabs.ts";

/** At most this many page tools are offered. */
export const MAX_TOOLS = 64;
/** A description (after the origin) is cut to this many characters. */
export const MAX_DESCRIPTION = 1000;
/** A title is cut to this many characters. */
export const MAX_TITLE = 100;
/** A schema bigger than this (as JSON) leaves its tool out. */
export const MAX_SCHEMA_BYTES = 16 * 1024;
/** A text result is cut to this many characters. */
export const MAX_RESULT = 100_000;
/** A call the page does not answer in this time is cancelled. */
export const CALL_TIMEOUT_MS = 60_000;

const PREFIX = "page.";
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** The AI app's name for page tool `name`, or `undefined` if it cannot have one. */
export function bridgedName(name: string): string | undefined {
	const bridged = `${PREFIX}${name}`;
	return NAME.test(name) && NAME.test(bridged) ? bridged : undefined;
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

/** The input schema to offer, or why the tool is left out. */
export function schemaFor(
	schema: unknown,
): { schema: Record<string, unknown> } | { problem: string } {
	if (schema === undefined)
		return { schema: { type: "object", properties: {} } };
	if (!isObject(schema) || schema["type"] !== "object")
		return {
			problem: 'its inputSchema is not an object schema ("type": "object")',
		};
	const json = JSON.stringify(schema);
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

function blocksOf(value: unknown): Block[] | undefined {
	if (!isObject(value) || !Array.isArray(value["content"])) return undefined;
	const blocks: Block[] = [];
	for (const item of value["content"]) {
		if (!isObject(item)) return undefined;
		if (item["type"] === "text" && typeof item["text"] === "string")
			blocks.push({ type: "text", text: cut(item["text"], MAX_RESULT) });
		else if (
			item["type"] === "image" &&
			typeof item["data"] === "string" &&
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
 * `@mcp-b/global` pages return) as its text and image blocks; `null` (the
 * tool navigated) as a note.
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
	/** The page's name. */
	name: string;
	/** The AI app's name, `page.<name>`. */
	tool?: string;
	title?: string;
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
	/** Names a tab-mcp page offers itself (iteration 25), left out. */
	mirrored: string[];
	/** Why there are no tools: no access, an error. */
	error?: string;
}

/** What the bridge needs from Chrome. */
export interface BridgeChrome {
	current(): Promise<TargetTab>;
	list(tab: TargetTab): Promise<PageTools>;
	call(
		tabId: number,
		name: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<CallResult>;
}

/** Where the bridged tools go: the side panel's `TabMcp`. */
export interface Registrar {
	registerTool(tool: Tool, options: { signal: AbortSignal }): Promise<void>;
}

/** What makes two offers the same tool: re-register only when it changes. */
const keyOf = (tabId: number, origin: string, tool: PageTool) =>
	JSON.stringify([tabId, origin, tool]);

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
	#state: BridgeState = { available: false, tools: [], mirrored: [] };
	#refreshes = 0;
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

	/**
	 * Read the tools of the page in front again and offer them; a refresh that
	 * a later one overtook changes nothing.
	 */
	async refresh(): Promise<void> {
		const refresh = ++this.#refreshes;
		let tab: TargetTab;
		let tools: PageTools;
		try {
			tab = await this.#chrome.current();
			tools = await this.#chrome.list(tab);
		} catch (error) {
			if (refresh !== this.#refreshes || this.#stopped) return;
			this.#offer([]);
			this.#state = {
				available: false,
				tools: [],
				mirrored: [],
				error: error instanceof Error ? error.message : String(error),
			};
			this.#changed();
			return;
		}
		if (refresh !== this.#refreshes || this.#stopped) return;
		const offered: Offered[] = [];
		const wanted: { name: string; key: string; tool: Tool }[] = [];
		for (const pageTool of tools.tools) {
			const readOnly = pageTool.annotations?.readOnlyHint === true;
			const entry: Offered = {
				name: pageTool.name,
				...(pageTool.title ? { title: cut(pageTool.title, MAX_TITLE) } : {}),
				description: cut(pageTool.description, MAX_DESCRIPTION),
				readOnly,
			};
			offered.push(entry);
			const name = bridgedName(pageTool.name);
			if (name === undefined) {
				entry.problem = "its name is too long or not allowed";
				continue;
			}
			if (wanted.length >= MAX_TOOLS) {
				entry.problem = `more than ${MAX_TOOLS} tools`;
				continue;
			}
			const schema = schemaFor(pageTool.inputSchema);
			if ("problem" in schema) {
				entry.problem = schema.problem;
				continue;
			}
			entry.tool = name;
			wanted.push({
				name,
				key: keyOf(tab.id, tools.origin, pageTool),
				tool: this.#tool(tab.id, tools.origin, pageTool, name, schema.schema),
			});
		}
		this.#offer(wanted, offered);
		this.#state = {
			url: tools.url,
			origin: tools.origin,
			available: tools.available,
			tools: offered,
			mirrored: tools.mirrored,
			...(tools.error ? { error: tools.error } : {}),
		};
		this.#changed();
	}

	/** Unregister every page tool; the bridge does nothing more. */
	stop(): void {
		this.#stopped = true;
		this.#offer([]);
	}

	/** Make the registered tools those of `wanted`. */
	#offer(
		wanted: { name: string; key: string; tool: Tool }[],
		offered: Offered[] = [],
	): void {
		const names = new Set(wanted.map((w) => w.name));
		for (const [name, registered] of this.#registered)
			if (
				!names.has(name) ||
				wanted.find((w) => w.name === name)?.key !== registered.key
			) {
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
					this.#registered.delete(name);
					const entry = offered.find((o) => o.tool === name);
					if (entry) {
						delete entry.tool;
						entry.problem =
							error instanceof Error ? error.message : String(error);
						this.#changed();
					}
				});
		}
	}

	/** The `page.<name>` tool for a page tool of tab `tabId`. */
	#tool(
		tabId: number,
		origin: string,
		pageTool: PageTool,
		name: string,
		schema: Record<string, unknown>,
	): Tool {
		const readOnly = pageTool.annotations?.readOnlyHint === true;
		const timeoutMs = this.#timeoutMs;
		const call = this.#chrome.call;
		return {
			name,
			title: cut(pageTool.title ?? pageTool.name, MAX_TITLE),
			description: describe(origin, pageTool.description),
			inputSchema: schema,
			annotations: {
				readOnlyHint: readOnly,
				// Not read-only: the user confirms every call in the side panel.
				consequentialHint: !readOnly,
				// Whatever it answers is the page's.
				untrustedContentHint: true,
			},
			async execute(input, options) {
				const timeout = AbortSignal.timeout(timeoutMs);
				const signal = AbortSignal.any([options.signal, timeout]);
				const result = await call(tabId, pageTool.name, input, signal);
				if (timeout.aborted)
					throw new Error(
						`The page's tool ${pageTool.name} did not answer within ${Math.round(timeoutMs / 1000)} s.`,
					);
				if (!result.ok)
					throw new Error(
						result.gone
							? `${result.error} The page's tools may have changed; webmcp_tools lists them.`
							: `The page's tool ${pageTool.name} failed: ${result.error}`,
					);
				return resultOf(result.value);
			},
		};
	}
}
