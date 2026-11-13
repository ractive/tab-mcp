/**
 * The WebMCP bridge without a browser: names, descriptions, schemas, results,
 * how the offered tools follow the page, and calls by name.
 */

import { describe, expect, test } from "bun:test";
import type {
	ConfirmRequest,
	Tool,
	ToolExecuteOptions,
} from "@ractive-ch/tab-mcp-client";
import type { CallResult, PageTool, PageTools } from "../src/messages.ts";
import {
	type BridgeChrome,
	bridgedName,
	type CallTarget,
	type Confirm,
	describe as describeTool,
	type LookedUp,
	MAX_BLOCKS,
	MAX_DESCRIPTION,
	MAX_IMAGES_BASE64,
	MAX_NAME,
	MAX_RESULT,
	MAX_SCHEMA_BYTES,
	MAX_TOOLS,
	PageToolBridge,
	resultOf,
	schemaFor,
} from "../src/worker/bridge.ts";
import {
	createTools,
	MAX_LISTED_SCHEMAS,
	OWN_TOOL_NAMES,
} from "../src/worker/tools.ts";

describe("names, descriptions, schemas", () => {
	test("page tools are page_<name>, in names every AI app takes (Claude: no dots, 64)", () => {
		expect(bridgedName("search")).toBe("page_search");
		expect(bridgedName("dotted.name")).toBe("page_dotted_name");
		expect(bridgedName("with space")).toBe("page_with_space");
		expect(bridgedName("a".repeat(59))).toBe(`page_${"a".repeat(59)}`);
		expect(bridgedName("a".repeat(60))).toBeUndefined();
		expect(bridgedName("")).toBeUndefined();
	});

	test("descriptions start with the page's origin and are cut", () => {
		expect(describeTool("https://shop.example", "Finds things.")).toBe(
			"From https://shop.example: Finds things.",
		);
		const long = describeTool("https://x.example", "y".repeat(5000));
		expect(long.length).toBe(
			"From https://x.example: ".length + MAX_DESCRIPTION,
		);
		expect(long.endsWith("…")).toBe(true);
		expect(describeTool("https://x.example", "  ")).toBe(
			"From https://x.example: (no description)",
		);
	});

	test("schemas: object schemas pass, others and big ones are left out", () => {
		expect(schemaFor({})).toEqual({
			schema: { type: "object", properties: {} },
		});
		expect(
			schemaFor({
				inputSchema: { type: "object", properties: { q: { type: "string" } } },
			}),
		).toEqual({
			schema: { type: "object", properties: { q: { type: "string" } } },
		});
		expect(schemaFor({ inputSchema: { type: "string" } })).toHaveProperty(
			"problem",
		);
		expect(schemaFor({ inputSchema: ["object"] })).toHaveProperty("problem");
		expect(schemaFor({ schemaTooBig: true })).toHaveProperty("problem");
		const big = { type: "object", description: "z".repeat(MAX_SCHEMA_BYTES) };
		expect(schemaFor({ inputSchema: big })).toHaveProperty("problem");
	});

	test("the page's regular expressions are not run in the panel", () => {
		expect(
			schemaFor({
				inputSchema: {
					type: "object",
					properties: { q: { type: "string", pattern: "^(a+)+$" } },
					patternProperties: { "^x": { type: "number" } },
				},
			}),
		).toEqual({
			schema: { type: "object", properties: { q: { type: "string" } } },
		});
	});

	test("a parameter named pattern stays: only the keyword goes (ES 2)", () => {
		const schema = {
			type: "object",
			properties: {
				pattern: { type: "string", pattern: "^(a+)+$" },
				patternProperties: { type: "object" },
			},
			required: ["pattern"],
			additionalProperties: false,
			$defs: { pattern: { type: "string", pattern: "x" } },
			dependentSchemas: { pattern: { required: ["patternProperties"] } },
			dependencies: { pattern: ["patternProperties"] },
			// Data, not schemas: kept as they are.
			default: { pattern: "keep" },
			examples: [{ pattern: "keep" }],
			enum: [{ pattern: "keep" }],
			// A keyword the validator does not know but would reach by a $ref.
			"x-extra": { type: "string", pattern: "(a|a)*$" },
			anyOf: [{ properties: { q: { pattern: "y" } } }],
		};
		expect(schemaFor({ inputSchema: schema })).toEqual({
			schema: {
				type: "object",
				properties: {
					pattern: { type: "string" },
					patternProperties: { type: "object" },
				},
				required: ["pattern"],
				additionalProperties: false,
				$defs: { pattern: { type: "string" } },
				dependentSchemas: { pattern: { required: ["patternProperties"] } },
				dependencies: { pattern: ["patternProperties"] },
				default: { pattern: "keep" },
				examples: [{ pattern: "keep" }],
				enum: [{ pattern: "keep" }],
				"x-extra": { type: "string" },
				anyOf: [{ properties: { q: {} } }],
			},
		});
	});
});

describe("results", () => {
	test("a string is the text, cut to the limit", () => {
		expect(resultOf("Hello")).toBe("Hello");
		expect((resultOf("x".repeat(MAX_RESULT + 10)) as string).length).toBe(
			MAX_RESULT,
		);
	});

	test("the JSON of an MCP result passes as its text and image blocks", () => {
		expect(
			resultOf(JSON.stringify({ content: [{ type: "text", text: "hi" }] })),
		).toEqual({ content: [{ type: "text", text: "hi" }] });
		expect(
			resultOf(
				JSON.stringify({
					content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
					isError: true,
				}),
			),
		).toEqual({
			content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			isError: true,
		});
	});

	test("the text of all blocks together stays within the budget", () => {
		const many = JSON.stringify({
			content: Array.from({ length: 5 }, () => ({
				type: "text",
				text: "y".repeat(MAX_RESULT / 2),
			})),
		});
		const result = resultOf(many) as { content: { text: string }[] };
		const total = result.content.reduce((n, b) => n + b.text.length, 0);
		expect(total).toBeLessThanOrEqual(MAX_RESULT);
	});

	test("images share one budget that fits the relay's 1 MiB; one beyond it is a note (ES 6)", () => {
		const half = "A".repeat(MAX_IMAGES_BASE64 / 2);
		const result = resultOf(
			JSON.stringify({
				content: [
					{ type: "image", data: half, mimeType: "image/png" },
					{ type: "image", data: half, mimeType: "image/png" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
					{ type: "text", text: "after" },
				],
			}),
		) as { content: { type: string; text?: string }[] };
		expect(result.content.map((b) => b.type)).toEqual([
			"image",
			"image",
			"text",
			"text",
		]);
		expect(result.content[2]?.text).toContain("left out");
		expect(result.content[3]?.text).toBe("after");
		// The most a result can carry: under 1 MiB as JSON (text as 3-byte UTF-8).
		expect(MAX_IMAGES_BASE64 + MAX_RESULT * 3).toBeLessThan(1024 * 1024);
	});

	test("too many blocks, bad images, other JSON stay (cut) text", () => {
		const tooMany = JSON.stringify({
			content: Array.from({ length: MAX_BLOCKS + 1 }, () => ({
				type: "text",
				text: "t",
			})),
		});
		expect(typeof resultOf(tooMany)).toBe("string");
		const notBase64 = JSON.stringify({
			content: [{ type: "image", data: "<svg/>", mimeType: "image/png" }],
		});
		expect(resultOf(notBase64)).toBe(notBase64);
		expect(resultOf('{"ordered":"tea"}')).toBe('{"ordered":"tea"}');
		const odd = JSON.stringify({
			content: [{ type: "resource", uri: "file:///etc/passwd" }],
		});
		expect(resultOf(odd)).toBe(odd);
		expect(resultOf("{not json")).toBe("{not json");
	});
});

/** A registrar like `TabMcp`: tools by name, gone when their signal aborts. */
function registrar(refuse: (tool: Tool) => boolean = () => false) {
	const tools = new Map<string, Tool>();
	return {
		tools,
		async registerTool(tool: Tool, options: { signal: AbortSignal }) {
			if (refuse(tool)) throw new TypeError(`refused ${tool.name}`);
			if (tools.has(tool.name)) throw new Error(`duplicate ${tool.name}`);
			tools.set(tool.name, tool);
			options.signal.addEventListener("abort", () => tools.delete(tool.name));
		},
	};
}

const pageTool = (name: string, extra: Partial<PageTool> = {}): PageTool => ({
	name,
	description: `The ${name} tool.`,
	inputSchema: { type: "object" },
	annotations: { readOnlyHint: true },
	...extra,
});

function page(tools: PageTool[], extra: Partial<PageTools> = {}): PageTools {
	return {
		url: "https://shop.example/",
		origin: "https://shop.example",
		documentId: "doc-1",
		more: 0,
		available: true,
		tools,
		...extra,
	};
}

/** Chrome as the bridge sees it, with the page's answer set by the test. */
function fakeChrome(initial: PageTools) {
	const state = {
		tabId: 1,
		/** The tab's address as Chrome reports it. */
		url: "https://shop.example/",
		page: initial as PageTools | Error,
		calls: [] as { tabId: number; target: CallTarget; input: unknown }[],
		answer: (async () => ({ ok: true, value: "done" })) as (
			signal: AbortSignal,
		) => Promise<CallResult>,
		settled: [] as number[],
		settledSignals: [] as AbortSignal[],
	};
	const chrome: BridgeChrome = {
		current: async () => ({ id: state.tabId, url: state.url, title: "" }),
		list: async () => {
			if (state.page instanceof Error) throw state.page;
			return state.page;
		},
		call: async (tabId, target, input, signal) => {
			state.calls.push({ tabId, target, input });
			return state.answer(signal);
		},
		settled: async (tabId, signal) => {
			state.settled.push(tabId);
			state.settledSignals.push(signal);
			return { url: "https://shop.example/thanks", title: "Thanks" };
		},
	};
	return { state, chrome };
}

/** A confirmation that answers `allow` and records what it was asked. */
function confirmer(allow: boolean | string = true) {
	const asked: { request: ConfirmRequest; tool: LookedUp }[] = [];
	const confirm: Confirm = async (request, tool) => {
		asked.push({ request, tool });
		if (allow === true) return;
		throw new Error(
			typeof allow === "string" ? allow : "The user did not allow this call.",
		);
	};
	return { asked, confirm };
}

const client = {
	kind: "relay" as const,
	grantId: "g",
	id: "https://client.example",
	host: "client.example",
};
const options = (
	signal = new AbortController().signal,
): ToolExecuteOptions => ({
	signal,
	client,
});

describe("PageToolBridge", () => {
	test("offers the page's tools with the bridge's hints", async () => {
		const reg = registrar();
		const { chrome } = fakeChrome(
			page([pageTool("search"), pageTool("buy", { annotations: {} })]),
		);
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		expect([...reg.tools.keys()].sort()).toEqual(["page_buy", "page_search"]);
		expect(reg.tools.get("page_search")?.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			untrustedContentHint: true,
		});
		// Not read-only: asks every time (the bridge itself, not the library);
		// untrusted whatever the page said.
		expect(reg.tools.get("page_buy")?.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			untrustedContentHint: true,
		});
		expect(reg.tools.get("page_search")?.description).toBe(
			"From https://shop.example: The search tool.",
		);
		// The listed descriptions carry the origin too.
		expect(bridge.state.tools[0]?.description).toStartWith(
			"From https://shop.example: ",
		);
	});

	test("webmcp_tools gives each offered tool's input schema, as offered (EQ 1)", async () => {
		const reg = registrar();
		const schema = {
			type: "object",
			properties: { q: { type: "string", pattern: "^x" } },
			required: ["q"],
		};
		const { chrome } = fakeChrome(
			page([
				pageTool("search", { inputSchema: schema }),
				pageTool("odd", { inputSchema: { type: "array" } }),
			]),
		);
		const bridge = new PageToolBridge(reg, chrome);
		const listed = createTools(
			{
				current: async () => ({ id: 1, url: "", title: "" }),
				page: async () => ({}) as never,
			},
			() => bridge,
		).find((t) => t.name === "webmcp_tools");
		const state = (await listed?.execute({}, options())) as typeof bridge.state;
		const offered = {
			type: "object",
			properties: { q: { type: "string" } },
			required: ["q"],
		};
		expect(state.tools.find((t) => t.name === "search")?.inputSchema).toEqual(
			offered,
		);
		// The same schema the page_<name> tool has.
		expect(reg.tools.get("page_search")?.inputSchema).toEqual(offered);
		// One that is not offered has none.
		expect(state.tools.find((t) => t.name === "odd")).not.toHaveProperty(
			"inputSchema",
		);
		expect(state.tabId).toBe(1);
	});

	test("the schemas webmcp_tools lists stay within a budget; past it a tool says where its schema is", async () => {
		const reg = registrar();
		// 64 tools with schemas near the 16 KB cap.
		const big = (i: number) => ({
			type: "object",
			description: `${i} ${"d".repeat(MAX_SCHEMA_BYTES - 200)}`,
		});
		const { chrome } = fakeChrome(
			page(
				Array.from({ length: MAX_TOOLS }, (_, i) =>
					pageTool(`t${i}`, { inputSchema: big(i) }),
				),
			),
		);
		const bridge = new PageToolBridge(reg, chrome);
		const listed = createTools(
			{
				current: async () => ({ id: 1, url: "", title: "" }),
				page: async () => ({}) as never,
			},
			() => bridge,
		).find((t) => t.name === "webmcp_tools");
		const state = (await listed?.execute({}, options())) as typeof bridge.state;
		const withSchema = state.tools.filter((t) => t.inputSchema !== undefined);
		expect(withSchema.length).toBeGreaterThan(0);
		expect(withSchema.length).toBeLessThan(MAX_TOOLS);
		expect(
			JSON.stringify(withSchema.map((t) => t.inputSchema)).length,
		).toBeLessThanOrEqual(MAX_LISTED_SCHEMAS + MAX_TOOLS);
		const left = state.tools.find((t) => t.inputSchema === undefined);
		expect(left?.schemaLeftOut).toContain(`inputSchema of ${left?.tool}`);
		// Twice (text and structuredContent) it still fits the relay's 1 MiB.
		expect(JSON.stringify(state).length * 2.2).toBeLessThan(1024 * 1024);
		// The bridge's own state keeps every schema (webmcp_call checks them).
		expect(bridge.state.tools.every((t) => t.inputSchema !== undefined)).toBe(
			true,
		);
	});

	test("a page that says it is another site than Chrome reports gets no tools (ES 4)", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(
			page([pageTool("buy", { annotations: {} })], {
				origin: "https://bank.example",
				url: "https://bank.example/",
			}),
		);
		const { asked, confirm } = confirmer();
		const bridge = new PageToolBridge(reg, chrome, { confirm });
		await bridge.refresh();
		expect(reg.tools.size).toBe(0);
		expect(bridge.state.error).toContain("changed while its tools were read");
		await expect(bridge.callByName("buy", {}, options())).rejects.toThrow(
			"offers no tool",
		);
		expect(asked).toEqual([]);
		// The same page on its own address: offered.
		state.url = "https://bank.example/account";
		await bridge.refresh();
		expect([...reg.tools.keys()]).toEqual(["page_buy"]);
	});

	test("follows the page: tools come, go, change, and a new page replaces all", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(page([pageTool("a"), pageTool("b")]));
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		const first = reg.tools.get("page_a");
		state.page = page([pageTool("a"), pageTool("c", { description: "New." })]);
		await bridge.refresh();
		expect([...reg.tools.keys()].sort()).toEqual(["page_a", "page_c"]);
		// An unchanged tool is not registered again.
		expect(reg.tools.get("page_a")).toBe(first);
		state.page = page([pageTool("a", { description: "Changed." })]);
		await bridge.refresh();
		expect(reg.tools.get("page_a")?.description).toContain("Changed.");
		// The same names on another page (a navigation) are other tools.
		const beforeNavigation = reg.tools.get("page_a");
		state.page = page([pageTool("a", { description: "Changed." })], {
			documentId: "doc-2",
		});
		await bridge.refresh();
		expect(reg.tools.get("page_a")).not.toBe(beforeNavigation);
		state.page = new Error("tab-mcp for Chrome may not read this tab yet.");
		await bridge.refresh();
		expect(reg.tools.size).toBe(0);
		expect(bridge.state.error).toContain("may not read");
	});

	test("leaves out what cannot be offered, says why, and bounds what it lists", async () => {
		const reg = registrar((tool) => tool.name === "page_refused");
		const many = Array.from({ length: MAX_TOOLS + 2 }, (_, i) =>
			pageTool(`t${i}`),
		);
		const { chrome } = fakeChrome(
			page(
				[
					pageTool("x".repeat(5000)),
					pageTool("odd", { inputSchema: { type: "array" } }),
					pageTool("refused"),
					...many,
				],
				{ more: 10 },
			),
		);
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		await Bun.sleep(0);
		const { tools, more } = bridge.state;
		expect(tools.length).toBe(MAX_TOOLS);
		expect(more).toBe(10 + 3 + MAX_TOOLS + 2 - MAX_TOOLS);
		expect(tools[0]?.name.length).toBe(MAX_NAME);
		expect(tools[0]?.problem).toContain("name");
		expect(tools.find((t) => t.name === "odd")?.problem).toContain("object");
		expect(tools.find((t) => t.name === "refused")?.problem).toContain(
			"refused",
		);
		// A tool the library refused carries no schema in the list either.
		expect(tools.find((t) => t.name === "refused")).not.toHaveProperty(
			"inputSchema",
		);
		expect(reg.tools.size).toBeLessThanOrEqual(MAX_TOOLS);
	});

	test("two page names that become one tool name: the second is left out", async () => {
		const reg = registrar();
		const { chrome } = fakeChrome(page([pageTool("a.b"), pageTool("a_b")]));
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		expect([...reg.tools.keys()]).toEqual(["page_a_b"]);
		expect(bridge.state.tools[1]?.problem).toContain("page_a_b");
	});

	test("a page tool whose name becomes one of the extension's own is left out, also from webmcp_call", async () => {
		// The extension's own tools are those names.
		const own = createTools(
			{
				current: async () => ({ id: 1, url: "", title: "" }),
				page: async () => ({}) as never,
			},
			() => ({}) as never,
		).map((t) => t.name);
		expect(own.sort()).toEqual([...OWN_TOOL_NAMES].sort());
		const reg = registrar();
		const { state, chrome } = fakeChrome(
			page([pageTool("info", { annotations: {} }), pageTool("search")]),
		);
		const bridge = new PageToolBridge(reg, chrome, {
			confirm: confirmer().confirm,
		});
		await bridge.refresh();
		expect([...reg.tools.keys()]).toEqual(["page_search"]);
		const info = bridge.state.tools.find((t) => t.name === "info");
		expect(info?.tool).toBeUndefined();
		expect(info?.problem).toContain("page_info");
		await expect(bridge.callByName("info", {}, options())).rejects.toThrow(
			"not offered",
		);
		expect(state.calls).toEqual([]);
	});

	test("a tool the library refuses is not callable through webmcp_call either", async () => {
		let refusals = 0;
		const reg = registrar((tool) => {
			if (tool.name !== "page_refused") return false;
			refusals++;
			return true;
		});
		const { state, chrome } = fakeChrome(
			page([pageTool("refused"), pageTool("search")]),
		);
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		await Bun.sleep(0);
		// Read again (webmcp_call refreshes first): not offered again.
		await bridge.refresh();
		expect(refusals).toBe(1);
		expect(
			bridge.state.tools.find((t) => t.name === "refused")?.problem,
		).toContain("refused");
		await expect(bridge.callByName("refused", {}, options())).rejects.toThrow(
			"refused",
		);
		expect(state.calls).toEqual([]);
		expect(await bridge.callByName("search", {}, options())).toBe("done");
	});

	test("a question names the page tool and the page it was listed from", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(
			page([pageTool("buy", { annotations: {} })]),
		);
		const { asked, confirm } = confirmer();
		const bridge = new PageToolBridge(reg, chrome, { confirm });
		await bridge.refresh();
		await reg.tools.get("page_buy")?.execute({}, options());
		expect(asked[0]?.tool).toEqual({
			tabId: 1,
			origin: "https://shop.example",
			documentId: "doc-1",
			name: "buy",
			readOnly: false,
		});
		state.page = page([pageTool("buy", { annotations: {} })], {
			documentId: "doc-2",
		});
		await bridge.refresh();
		await reg.tools.get("page_buy")?.execute({}, options());
		expect(asked[1]?.tool.documentId).toBe("doc-2");
	});

	test("page_<name> asks in the bridge; why a call did not run reaches the AI app (EQ 4)", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(
			page([pageTool("buy", { annotations: {} })]),
		);
		const answer = {
			allow: "The user was asked and did not answer within 60 s." as
				| boolean
				| string,
		};
		const bridge = new PageToolBridge(reg, chrome, {
			confirm: async () => {
				if (answer.allow !== true) throw new Error(String(answer.allow));
			},
		});
		await bridge.refresh();
		const tool = reg.tools.get("page_buy");
		// Not the library's "The user declined": the bridge's own reason.
		await expect(Promise.resolve(tool?.execute({}, options()))).rejects.toThrow(
			"did not answer within 60 s",
		);
		answer.allow =
			"5 calls of this AI app already wait for the user's answer; this one was not asked.";
		await expect(Promise.resolve(tool?.execute({}, options()))).rejects.toThrow(
			"was not asked",
		);
		expect(state.calls).toEqual([]);
		answer.allow = true;
		expect(await tool?.execute({}, options())).toBe("done");
	});

	test("a page that changed while the user was asked: the tool does not run", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(
			page([pageTool("buy", { annotations: {} })]),
		);
		let bridge: PageToolBridge | undefined;
		let documents = 1;
		const confirm: Confirm = async () => {
			// While the question is open, the tab navigates.
			state.page = page([pageTool("buy", { annotations: {} })], {
				documentId: `doc-${++documents}`,
			});
			await bridge?.refresh();
		};
		bridge = new PageToolBridge(reg, chrome, { confirm });
		await bridge.refresh();
		const tool = reg.tools.get("page_buy");
		await expect(Promise.resolve(tool?.execute({}, options()))).rejects.toThrow(
			"changed while the user was asked",
		);
		await expect(bridge.callByName("buy", {}, options())).rejects.toThrow(
			"changed while the user was asked",
		);
		expect(state.calls).toEqual([]);
	});

	test("a call goes to the page the tool was listed from, with its claim", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(page([pageTool("search")]));
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		state.answer = async () => ({
			ok: true,
			value: JSON.stringify({ content: [{ type: "text", text: "found" }] }),
		});
		const result = await reg.tools
			.get("page_search")
			?.execute({ q: "tea" }, options());
		expect(result).toEqual({ content: [{ type: "text", text: "found" }] });
		expect(state.calls).toEqual([
			{
				tabId: 1,
				target: { documentId: "doc-1", name: "search", readOnly: true },
				input: { q: "tea" },
			},
		]);
	});

	test("a tool that is gone, a failing tool, and one that does not answer", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(page([pageTool("search")]));
		const bridge = new PageToolBridge(reg, chrome, { timeoutMs: 50 });
		await bridge.refresh();
		const tool = reg.tools.get("page_search");
		state.answer = async () => ({
			ok: false,
			error: "The page in the tab changed since its tools were listed.",
			gone: true,
		});
		await expect(Promise.resolve(tool?.execute({}, options()))).rejects.toThrow(
			"webmcp_tools lists them",
		);
		state.answer = async () => ({ ok: false, error: "boom" });
		await expect(Promise.resolve(tool?.execute({}, options()))).rejects.toThrow(
			"failed: boom",
		);
		// A page that never answers, not even on cancel: the call still ends.
		state.answer = () => new Promise(() => {});
		await expect(Promise.resolve(tool?.execute({}, options()))).rejects.toThrow(
			"did not answer within",
		);
	});

	test("a tool that navigates the tab is not a failure: the new page's page_info, its tools offered (WM 2)", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(page([pageTool("checkout")]));
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		state.answer = async () => {
			// The tool took the tab to the next page.
			state.page = page([pageTool("track_order")], {
				documentId: "doc-2",
				url: "https://shop.example/thanks",
			});
			return {
				ok: false,
				error: "The page went away while the tool ran.",
				navigated: true,
			};
		};
		const cancel = new AbortController();
		const result = (await reg.tools
			.get("page_checkout")
			?.execute({}, options(cancel.signal))) as Record<string, unknown>;
		expect(result["navigated"]).toBe(true);
		// The wait for the new page ends only with the AI app's cancel, not
		// with what is left of the call's own time limit.
		expect(state.settledSignals[0]).toBe(cancel.signal);
		expect(result["note"]).toContain("may have completed");
		expect(result["page"]).toEqual({
			url: "https://shop.example/thanks",
			title: "Thanks",
		});
		expect(state.settled).toEqual([1]);
		// Offered before the answer.
		expect([...reg.tools.keys()]).toEqual(["page_track_order"]);
		// Chrome's own word for it (executeTool resolved with null): the same.
		state.answer = async () => ({ ok: true, value: null });
		const tracked = (await reg.tools
			.get("page_track_order")
			?.execute({}, options())) as Record<string, unknown>;
		expect(tracked["navigated"]).toBe(true);
		expect(state.settled).toEqual([1, 1]);
	});

	test("cancelling the AI app's call cancels the page's, and ends it", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(page([pageTool("slow")]));
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		let cancelled = false;
		state.answer = (signal) =>
			new Promise(() => {
				signal.addEventListener("abort", () => {
					cancelled = true;
				});
			});
		const controller = new AbortController();
		const running = reg.tools
			.get("page_slow")
			?.execute({}, options(controller.signal));
		controller.abort();
		await expect(Promise.resolve(running)).rejects.toThrow("cancelled");
		expect(cancelled).toBe(true);
	});

	test("stop unregisters everything, and a refresh after it changes nothing", async () => {
		const reg = registrar();
		const { chrome } = fakeChrome(page([pageTool("a")]));
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		bridge.stop();
		expect(reg.tools.size).toBe(0);
		await bridge.refresh();
		expect(reg.tools.size).toBe(0);
	});

	test("refreshes run one at a time; one asked for meanwhile reads again", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(page([pageTool("old")]));
		let reads = 0;
		let release: () => void = () => {};
		const list = chrome.list;
		chrome.list = async (tab) => {
			reads++;
			const answer = await list(tab);
			if (reads === 1)
				await new Promise<void>((r) => {
					release = r;
				});
			return answer;
		};
		const bridge = new PageToolBridge(reg, chrome);
		const first = bridge.refresh();
		await Bun.sleep(0);
		state.page = page([pageTool("new")]);
		// Asked three times while the first runs: one more read, not three.
		const second = bridge.refresh();
		void bridge.refresh();
		void bridge.refresh();
		release();
		await Promise.all([first, second]);
		expect(reads).toBe(2);
		expect([...reg.tools.keys()]).toEqual(["page_new"]);
		// A caller that asked meanwhile sees the state of the later read.
		expect(bridge.state.tools.map((t) => t.name)).toEqual(["new"]);
	});

	test("webmcp_call waiting for a page that does not answer ends with the AI app's cancel (ES 1)", async () => {
		const reg = registrar();
		const { chrome } = fakeChrome(page([pageTool("search")]));
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		// The page's main thread is blocked: the list never comes.
		chrome.list = () => new Promise(() => {});
		const controller = new AbortController();
		const call = bridge.callByName("search", {}, options(controller.signal));
		controller.abort();
		await expect(call).rejects.toThrow("cancelled");
	});
});

describe("webmcp_call (by name)", () => {
	const setup = async (tools: PageTool[]) => {
		const reg = registrar();
		const fake = fakeChrome(page(tools));
		const asked: ConfirmRequest[] = [];
		const answer = { allow: false };
		const bridge = new PageToolBridge(reg, fake.chrome, {
			confirm: async (request) => {
				asked.push(request);
				if (!answer.allow) throw new Error("The user did not allow this call.");
			},
		});
		await bridge.refresh();
		return { bridge, ...fake, asked, answer };
	};

	const searchSchema = {
		type: "object",
		properties: { q: { type: "string" } },
		required: ["q"],
	};

	test("a read-only tool runs without asking", async () => {
		const { bridge, state, asked } = await setup([
			pageTool("search", { inputSchema: searchSchema }),
		]);
		expect(await bridge.callByName("search", { q: "tea" }, options())).toBe(
			"done",
		);
		expect(asked).toEqual([]);
		expect(state.calls[0]?.target.documentId).toBe("doc-1");
	});

	test("arguments are checked against the page's schema", async () => {
		const { bridge, state, answer } = await setup([
			pageTool("search", { inputSchema: searchSchema }),
		]);
		answer.allow = true;
		await expect(
			bridge.callByName("search", { q: 42 }, options()),
		).rejects.toThrow("do not match");
		expect(state.calls).toEqual([]);
	});

	test("a tool not marked read-only asks first, and runs only if allowed", async () => {
		const { bridge, state, asked, answer } = await setup([
			pageTool("buy", { annotations: {} }),
		]);
		await expect(bridge.callByName("buy", {}, options())).rejects.toThrow(
			"did not allow",
		);
		expect(state.calls).toEqual([]);
		expect(asked[0]?.tool.name).toBe("page_buy");
		expect(asked[0]?.tool.description).toStartWith(
			"From https://shop.example: ",
		);
		answer.allow = true;
		expect(await bridge.callByName("buy", {}, options())).toBe("done");
		expect(state.calls[0]?.target.readOnly).toBe(false);
	});

	test("it asks under the tool's own name, as page_<name> does", async () => {
		const { bridge, asked, answer } = await setup([
			pageTool("place.order", { annotations: {} }),
		]);
		answer.allow = true;
		await bridge.callByName("place.order", {}, options());
		expect(asked[0]?.tool.name).toBe("page_place_order");
	});

	test("a name the page does not offer says so", async () => {
		const { bridge } = await setup([pageTool("search")]);
		await expect(bridge.callByName("nope", {}, options())).rejects.toThrow(
			"offers no tool nope",
		);
	});
});
