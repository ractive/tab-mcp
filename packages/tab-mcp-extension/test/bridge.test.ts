/**
 * The WebMCP bridge without a browser: names, descriptions, schemas, results,
 * and how the offered tools follow the page.
 */

import { describe, expect, test } from "bun:test";
import type { Tool } from "@ractive-ch/tab-mcp-client";
import type { CallResult, PageTool, PageTools } from "../src/messages.ts";
import {
	type BridgeChrome,
	bridgedName,
	describe as describeTool,
	MAX_DESCRIPTION,
	MAX_RESULT,
	MAX_SCHEMA_BYTES,
	MAX_TOOLS,
	PageToolBridge,
	resultOf,
	schemaFor,
} from "../src/sidepanel/bridge.ts";

describe("names, descriptions, schemas", () => {
	test("page tools are page.<name>; names that would not fit are not", () => {
		expect(bridgedName("search")).toBe("page.search");
		expect(bridgedName("a".repeat(123))).toBe(`page.${"a".repeat(123)}`);
		expect(bridgedName("a".repeat(124))).toBeUndefined();
		expect(bridgedName("with space")).toBeUndefined();
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
		expect(schemaFor(undefined)).toEqual({
			schema: { type: "object", properties: {} },
		});
		expect(
			schemaFor({ type: "object", properties: { q: { type: "string" } } }),
		).toEqual({
			schema: { type: "object", properties: { q: { type: "string" } } },
		});
		expect(schemaFor({ type: "string" })).toHaveProperty("problem");
		expect(schemaFor(["object"])).toHaveProperty("problem");
		const big = {
			type: "object",
			description: "z".repeat(MAX_SCHEMA_BYTES),
		};
		expect(schemaFor(big)).toHaveProperty("problem");
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

	test("other JSON, or MCP results with other blocks, stay text", () => {
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
		calls: [] as { tabId: number; name: string; input: unknown }[],
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
		call: async (tabId, name, input, signal) => {
			state.calls.push({ tabId, name, input });
			return state.answer(signal);
		},
	};
	return { state, chrome };
}

const options = (signal = new AbortController().signal) =>
	({ signal }) as Parameters<Tool["execute"]>[1];

describe("PageToolBridge", () => {
	test("offers the page's tools with the bridge's hints", async () => {
		const reg = registrar();
		const { chrome } = fakeChrome(
			page([pageTool("search"), pageTool("buy", { annotations: {} })]),
		);
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		expect([...reg.tools.keys()].sort()).toEqual(["page.buy", "page.search"]);
		expect(reg.tools.get("page.search")?.annotations).toEqual({
			readOnlyHint: true,
			consequentialHint: false,
			untrustedContentHint: true,
		});
		// Not read-only: asks every time; untrusted whatever the page said.
		expect(reg.tools.get("page.buy")?.annotations).toEqual({
			readOnlyHint: false,
			consequentialHint: true,
			untrustedContentHint: true,
		});
		expect(reg.tools.get("page.search")?.description).toBe(
			"From https://shop.example: The search tool.",
		);
	});

	test("follows the page: tools come, go and change", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(page([pageTool("a"), pageTool("b")]));
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		const first = reg.tools.get("page.a");
		state.page = page([pageTool("a"), pageTool("c", { description: "New." })]);
		await bridge.refresh();
		expect([...reg.tools.keys()].sort()).toEqual(["page.a", "page.c"]);
		// An unchanged tool is not registered again.
		expect(reg.tools.get("page.a")).toBe(first);
		state.page = page([pageTool("a", { description: "Changed." })]);
		await bridge.refresh();
		expect(reg.tools.get("page.a")?.description).toContain("Changed.");
		state.page = new Error("tab-mcp for Chrome may not read this tab yet.");
		await bridge.refresh();
		expect(reg.tools.size).toBe(0);
		expect(bridge.state.error).toContain("may not read");
	});

	test("leaves out what cannot be offered, and says why", async () => {
		const reg = registrar((tool) => tool.name === "page.refused");
		const many = Array.from({ length: MAX_TOOLS + 2 }, (_, i) =>
			pageTool(`t${i}`),
		);
		const { chrome } = fakeChrome(
			page([
				pageTool("x".repeat(124)),
				pageTool("odd", { inputSchema: { type: "array" } }),
				pageTool("refused"),
				...many,
			]),
		);
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		await Bun.sleep(0);
		const problems = bridge.state.tools.filter((t) => t.problem);
		expect(problems.map((t) => t.name)).toContain("odd");
		expect(problems.find((t) => t.name === "refused")?.problem).toContain(
			"refused",
		);
		expect(reg.tools.size).toBeLessThanOrEqual(MAX_TOOLS);
		expect(
			problems.some((t) => t.problem === `more than ${MAX_TOOLS} tools`),
		).toBe(true);
	});

	test("a call goes to the tab the tool came from and maps the answer", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(page([pageTool("search")]));
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		state.answer = async () => ({
			ok: true,
			value: JSON.stringify({ content: [{ type: "text", text: "found" }] }),
		});
		const result = await reg.tools
			.get("page.search")
			?.execute({ q: "tea" }, options());
		expect(result).toEqual({ content: [{ type: "text", text: "found" }] });
		expect(state.calls).toEqual([
			{ tabId: 1, name: "search", input: { q: "tea" } },
		]);
	});

	test("a tool that is gone, a failing tool, and one that does not answer", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(page([pageTool("search")]));
		const bridge = new PageToolBridge(reg, chrome, () => {}, 50);
		await bridge.refresh();
		const tool = reg.tools.get("page.search");
		state.answer = async () => ({
			ok: false,
			error: "The page has no tool search (any more).",
			gone: true,
		});
		expect(tool?.execute({}, options())).rejects.toThrow(
			"webmcp_tools lists them",
		);
		state.answer = async () => ({ ok: false, error: "boom" });
		expect(tool?.execute({}, options())).rejects.toThrow("failed: boom");
		state.answer = (signal) =>
			new Promise((resolve) =>
				signal.addEventListener("abort", () =>
					resolve({ ok: false, error: "AbortError" }),
				),
			);
		expect(tool?.execute({}, options())).rejects.toThrow(
			"did not answer within",
		);
	});

	test("cancelling the AI app's call cancels the page's", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(page([pageTool("slow")]));
		const bridge = new PageToolBridge(reg, chrome);
		await bridge.refresh();
		let cancelled = false;
		state.answer = (signal) =>
			new Promise((resolve) =>
				signal.addEventListener("abort", () => {
					cancelled = true;
					resolve({ ok: false, error: "AbortError" });
				}),
			);
		const controller = new AbortController();
		const running = reg.tools
			.get("page.slow")
			?.execute({}, options(controller.signal));
		controller.abort();
		await Promise.resolve(running).catch(() => undefined);
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

	test("a refresh that a later one overtook changes nothing", async () => {
		const reg = registrar();
		const { state, chrome } = fakeChrome(page([pageTool("old")]));
		let release: () => void = () => {};
		const slowList = chrome.list;
		chrome.list = async (tab) => {
			const answer = await slowList(tab);
			await new Promise<void>((r) => {
				release = r;
			});
			return answer;
		};
		const bridge = new PageToolBridge(reg, chrome);
		const first = bridge.refresh();
		await Bun.sleep(0);
		state.page = page([pageTool("new")]);
		chrome.list = slowList;
		await bridge.refresh();
		release();
		await first;
		expect([...reg.tools.keys()]).toEqual(["page.new"]);
	});
});
