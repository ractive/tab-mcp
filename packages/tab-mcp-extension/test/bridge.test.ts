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
	describe as describeTool,
	MAX_BLOCKS,
	MAX_DESCRIPTION,
	MAX_NAME,
	MAX_RESULT,
	MAX_SCHEMA_BYTES,
	MAX_TOOLS,
	PageToolBridge,
	resultOf,
	schemaFor,
} from "../src/sidepanel/bridge.ts";

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
});

describe("results", () => {
	test("a string is the text, cut to the limit", () => {
		expect(resultOf("Hello")).toBe("Hello");
		expect((resultOf("x".repeat(MAX_RESULT + 10)) as string).length).toBe(
			MAX_RESULT,
		);
	});

	test("a navigation is a note", () => {
		expect(resultOf(null)).toContain("navigation");
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
		mirrored: [],
		...extra,
	};
}

/** Chrome as the bridge sees it, with the page's answer set by the test. */
function fakeChrome(initial: PageTools) {
	const state = {
		tabId: 1,
		page: initial as PageTools | Error,
		calls: [] as { tabId: number; target: CallTarget; input: unknown }[],
		answer: (async () => ({ ok: true, value: "done" })) as (
			signal: AbortSignal,
		) => Promise<CallResult>,
	};
	const chrome: BridgeChrome = {
		current: async () => ({ id: state.tabId, url: "", title: "" }),
		list: async () => {
			if (state.page instanceof Error) throw state.page;
			return state.page;
		},
		call: async (tabId, target, input, signal) => {
			state.calls.push({ tabId, target, input });
			return state.answer(signal);
		},
	};
	return { state, chrome };
}

const client = {
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
			consequentialHint: false,
			untrustedContentHint: true,
		});
		// Not read-only: asks every time; untrusted whatever the page said.
		expect(reg.tools.get("page_buy")?.annotations).toEqual({
			readOnlyHint: false,
			consequentialHint: true,
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
				{ more: 10, mirrored: ["m".repeat(5000)] },
			),
		);
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		await Bun.sleep(0);
		const { tools, more, mirrored } = bridge.state;
		expect(tools.length).toBe(MAX_TOOLS);
		expect(more).toBe(10 + 3 + MAX_TOOLS + 2 - MAX_TOOLS);
		expect(tools[0]?.name.length).toBe(MAX_NAME);
		expect(tools[0]?.problem).toContain("name");
		expect(tools.find((t) => t.name === "odd")?.problem).toContain("object");
		expect(tools.find((t) => t.name === "refused")?.problem).toContain(
			"refused",
		);
		expect(mirrored[0]?.length).toBe(MAX_NAME);
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
		const bridge = new PageToolBridge(reg, chrome, () => {}, 50);
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
});

describe("webmcp_call (by name)", () => {
	const setup = async (tools: PageTool[]) => {
		const reg = registrar();
		const fake = fakeChrome(page(tools));
		const bridge = new PageToolBridge(reg, fake.chrome);
		await bridge.refresh();
		const asked: ConfirmRequest[] = [];
		const confirm = (answer: boolean) => async (request: ConfirmRequest) => {
			asked.push(request);
			return answer;
		};
		return { bridge, ...fake, asked, confirm };
	};

	const searchSchema = {
		type: "object",
		properties: { q: { type: "string" } },
		required: ["q"],
	};

	test("a read-only tool runs without asking", async () => {
		const { bridge, state, asked, confirm } = await setup([
			pageTool("search", { inputSchema: searchSchema }),
		]);
		expect(
			await bridge.callByName(
				"search",
				{ q: "tea" },
				options(),
				confirm(false),
			),
		).toBe("done");
		expect(asked).toEqual([]);
		expect(state.calls[0]?.target.documentId).toBe("doc-1");
	});

	test("arguments are checked against the page's schema", async () => {
		const { bridge, state, confirm } = await setup([
			pageTool("search", { inputSchema: searchSchema }),
		]);
		await expect(
			bridge.callByName("search", { q: 42 }, options(), confirm(true)),
		).rejects.toThrow("do not match");
		expect(state.calls).toEqual([]);
	});

	test("a tool not marked read-only asks first, and runs only if allowed", async () => {
		const { bridge, state, asked, confirm } = await setup([
			pageTool("buy", { annotations: {} }),
		]);
		await expect(
			bridge.callByName("buy", {}, options(), confirm(false)),
		).rejects.toThrow("did not allow");
		expect(state.calls).toEqual([]);
		expect(asked[0]?.tool.name).toBe("page_buy");
		expect(asked[0]?.tool.description).toStartWith(
			"From https://shop.example: ",
		);
		expect(await bridge.callByName("buy", {}, options(), confirm(true))).toBe(
			"done",
		);
		expect(state.calls[0]?.target.readOnly).toBe(false);
	});

	test("it asks under the tool's own name (one Always allow for both paths)", async () => {
		const { bridge, asked, confirm } = await setup([
			pageTool("place.order", { annotations: {} }),
		]);
		await bridge.callByName("place.order", {}, options(), confirm(true));
		expect(asked[0]?.tool.name).toBe("page_place_order");
	});

	test("a name the page does not offer says so", async () => {
		const { bridge, confirm } = await setup([pageTool("search")]);
		await expect(
			bridge.callByName("nope", {}, options(), confirm(true)),
		).rejects.toThrow("offers no tool nope");
	});
});
