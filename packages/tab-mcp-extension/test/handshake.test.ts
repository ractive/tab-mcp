/**
 * The extension's side of the handshake with a page that uses the client
 * library (DEC-205): the content script's `PageHandshake`, the vouch in
 * `callTool` and the bridge, the worker's check of who asks, the panel's
 * lines; and both sides together, the real library in a happy-dom page
 * with a fake native WebMCP. End to end in `handshake-e2e.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type ConfirmRequest,
	type Grant,
	TabMcp,
	type ToolCallStart,
	type ToolExecuteOptions,
} from "@ractive-ch/tab-mcp-client";
import { Window } from "happy-dom";
import { callTool } from "../src/content.ts";
import type {
	CallResult,
	ExtensionState,
	PageTool,
	PageTools,
	Vouch,
} from "../src/messages.ts";
import {
	EXTENSION_EVENT,
	MARK,
	PAGE_EVENT,
	PageHandshake,
	parsePage,
} from "../src/page-handshake.ts";
import { isHandshakeAsk, type TabView } from "../src/protocol.ts";
import { libraryNotes } from "../src/sidepanel/card.ts";
import {
	type BridgeChrome,
	type Confirm,
	PageToolBridge,
} from "../src/worker/bridge.ts";

const STATE: ExtensionState = {
	name: "tab-mcp browser extension",
	version: "0.3.0",
	on: true,
	apps: [{ name: "Claude", host: "claude.ai" }],
	whileInFront: true,
};
const VOUCH: Vouch = {
	nonce: "n1",
	app: { name: "Claude", host: "claude.ai" },
};

let window: Window;
let doc: Document;
/** What the extension told the page, parsed. */
let told: Record<string, unknown>[];

beforeEach(() => {
	window = new Window({ url: "https://todo.example/" });
	doc = window.document as unknown as Document;
	told = [];
	doc.addEventListener(EXTENSION_EVENT, (event) =>
		told.push(JSON.parse(String((event as CustomEvent).detail))),
	);
});
afterEach(async () => {
	await window.happyDOM.close();
});

/** The page says `message` (a JSON string as `detail`, as the library does). */
function pageSays(message: unknown): void {
	const detail =
		typeof message === "string" ? message : JSON.stringify(message);
	doc.dispatchEvent(
		new window.CustomEvent(PAGE_EVENT, {
			// happy-dom types `detail` as an object; the library sends a string.
			detail: detail as unknown as object,
		}) as unknown as Event,
	);
}

const hello = (extra: object = {}) => ({
	v: 1,
	type: "hello",
	library: "0.19.0",
	app: "todo",
	apps: [],
	...extra,
});

/** A handshake whose worker answers `state` (or does not, `null`). */
function handshake(state: ExtensionState | null = STATE) {
	const host = { asked: 0, changes: 0 };
	const h = new PageHandshake(doc, {
		state: async () => {
			host.asked++;
			return state ?? undefined;
		},
		changed: () => host.changes++,
	});
	h.start();
	return { h, host };
}

describe("the content script speaks only to a page that announced the library", () => {
	test("silent on a page without it: no hello, no state, no vouch", async () => {
		const { h, host } = handshake();
		h.stateChanged(STATE);
		h.vouch("buy", { n: 1 }, VOUCH);
		await Bun.sleep(0);
		expect(told).toEqual([]);
		expect(host.asked).toBe(0);
		expect(h.library).toBeUndefined();
	});

	test("the page's hello is answered with the state; its update is not; the state follows", async () => {
		const { h, host } = handshake();
		pageSays(
			hello({ type: "update", apps: [{ name: "Codex", host: "openai.com" }] }),
		);
		await Bun.sleep(0);
		expect(told).toEqual([]);
		expect(h.library).toEqual({
			version: "0.19.0",
			apps: [{ name: "Codex", host: "openai.com" }],
		});
		pageSays(hello());
		await Bun.sleep(0);
		expect(told).toEqual([{ v: 1, type: "update", ...STATE }]);
		expect(host.changes).toBe(2);
		h.stateChanged({ ...STATE, on: false, apps: [] });
		expect(told.at(-1)).toEqual({
			v: 1,
			type: "update",
			...STATE,
			on: false,
			apps: [],
		});
	});

	test("a page that marked itself before the content script came gets the hello first", async () => {
		doc.documentElement.setAttribute(MARK, "1");
		const { h } = handshake();
		await Bun.sleep(0);
		expect(told).toEqual([{ v: 1, type: "hello", ...STATE }]);
		h.vouch("buy", { n: 1 }, VOUCH);
		expect(told.at(-1)).toEqual({
			v: 1,
			type: "vouch",
			tool: "buy",
			arguments: { n: 1 },
			nonce: "n1",
			app: { name: "Claude", host: "claude.ai" },
		});
	});

	test("a worker that does not answer: nothing is told", async () => {
		handshake(null);
		pageSays(hello());
		await Bun.sleep(0);
		expect(told).toEqual([]);
	});

	test("the apps of all the page's apps together, each once; the same again is no change", async () => {
		const { h, host } = handshake();
		const claude = { name: "Claude", host: "claude.ai" };
		pageSays(hello({ type: "update", apps: [claude] }));
		pageSays(hello({ type: "update", app: "other", apps: [claude] }));
		expect(h.library?.apps).toEqual([claude]);
		pageSays(hello({ type: "update", apps: [claude] }));
		expect(host.changes).toBe(1);
	});

	test("what the page says is checked: other versions, types, shapes and sizes are ignored", () => {
		for (const bad of [
			"{not json",
			JSON.stringify(hello({ v: 2 })),
			JSON.stringify(hello({ type: "vouch" })),
			JSON.stringify(hello({ library: 19 })),
			JSON.stringify(hello({ app: "x".repeat(300) })),
			JSON.stringify(hello({ apps: "Claude" })),
			JSON.stringify(hello({ apps: [{ name: "Claude" }] })),
			JSON.stringify(
				hello({
					apps: Array.from({ length: 65 }, () => ({ name: "a", host: "b" })),
				}),
			),
			JSON.stringify([hello()]),
			{ v: 1 },
		])
			expect(parsePage(bad)).toBeUndefined();
		expect(parsePage(JSON.stringify(hello({ extra: 1 })))).toEqual({
			type: "hello",
			library: "0.19.0",
			app: "todo",
			apps: [],
		});
	});
});

describe("the vouch in the content script", () => {
	/** A page with one tool `buy` (not read-only) in a fake WebMCP. */
	function toolPage() {
		const order: string[] = [];
		const page = {
			location: {
				href: "https://todo.example/",
				origin: "https://todo.example",
			},
			modelContext: {
				getTools: async () => [
					{ name: "buy", description: "Buys.", annotations: {} },
				],
				executeTool: async (_tool: unknown, input: unknown) => {
					order.push(`run ${JSON.stringify(input)}`);
					return "ran";
				},
			},
		} as unknown as Document;
		const vouch = (args: unknown) =>
			order.push(`vouch ${JSON.stringify(args)}`);
		return { page, order, vouch };
	}
	const signal = new AbortController().signal;
	const call = { documentId: "doc-A", name: "buy", readOnly: false };

	test("goes out right before the tool runs, with the arguments it runs with", async () => {
		const { page, order, vouch } = toolPage();
		expect(
			await callTool(call, { n: 1 }, signal, page, "doc-A", vouch),
		).toEqual({ ok: true, value: "ran" });
		expect(order).toEqual(['vouch {"n":1}', 'run {"n":1}']);
		// No input: both with {}.
		order.length = 0;
		await callTool(call, undefined, signal, page, "doc-A", vouch);
		expect(order).toEqual(["vouch {}", "run {}"]);
	});

	test("never for a call that does not run: another page, a tool gone, another claim", async () => {
		const { page, order, vouch } = toolPage();
		const results: CallResult[] = [
			await callTool(call, {}, signal, page, "doc-B", vouch),
			await callTool(
				{ ...call, name: "sell" },
				{},
				signal,
				page,
				"doc-A",
				vouch,
			),
			await callTool(
				{ ...call, readOnly: true },
				{},
				signal,
				page,
				"doc-A",
				vouch,
			),
		];
		expect(results.every((r) => !r.ok && r.gone === true)).toBe(true);
		expect(order).toEqual([]);
	});
});

describe("the vouch in the bridge", () => {
	const readOnly = (name: string): PageTool => ({
		name,
		description: `The ${name} tool.`,
		inputSchema: { type: "object" },
		annotations: { readOnlyHint: true },
	});
	const asking = (name: string): PageTool => ({
		...readOnly(name),
		annotations: {},
	});
	const page = (tools: PageTool[], documentId = "doc-1"): PageTools => ({
		url: "https://todo.example/",
		origin: "https://todo.example",
		documentId,
		more: 0,
		available: true,
		tools,
	});
	const options = (): ToolExecuteOptions => ({
		signal: new AbortController().signal,
		client: {
			kind: "relay",
			grantId: "g",
			id: "https://claude.ai/oauth",
			name: "Claude",
			host: "claude.ai",
		},
	});

	/** A bridge whose calls (and their vouches) are recorded. */
	async function bridgeWith(tools: PageTool[], confirm: Confirm) {
		const calls: { name: string; vouch: Vouch | undefined }[] = [];
		let listed = page(tools);
		const chrome: BridgeChrome = {
			current: async () => ({ id: 1, url: "https://todo.example/", title: "" }),
			list: async () => listed,
			call: async (_tabId, target, _input, _signal, vouch) => {
				calls.push({ name: target.name, vouch });
				return { ok: true, value: "done" };
			},
			settled: async () => ({}),
		};
		const registered = new Map<string, Parameters<TabMcp["registerTool"]>[0]>();
		const bridge = new PageToolBridge(
			{
				registerTool: async (tool, opts) => {
					registered.set(tool.name, tool as never);
					opts.signal.addEventListener("abort", () =>
						registered.delete(tool.name),
					);
				},
			},
			chrome,
			{ confirm },
		);
		await bridge.refresh();
		return {
			bridge,
			calls,
			run: (name: string, args: Record<string, unknown> = {}) =>
				Promise.resolve(
					(
						registered.get(name) as {
							execute: (a: unknown, o: unknown) => unknown;
						}
					).execute(args, options()),
				),
			relist: async (next: PageTools) => {
				listed = next;
				await bridge.refresh();
			},
		};
	}
	const allow: Confirm = async () => {};
	const deny: Confirm = async () => {
		throw new Error("The user did not allow this call.");
	};

	test("a call the user allowed goes with a vouch: the AI app, a nonce per call", async () => {
		const { calls, run, bridge } = await bridgeWith([asking("buy")], allow);
		await run("page_buy");
		await bridge.callByName("buy", {}, options());
		expect(calls.map((c) => c.vouch?.app)).toEqual([
			{ name: "Claude", host: "claude.ai" },
			{ name: "Claude", host: "claude.ai" },
		]);
		const [first, second] = calls.map((c) => c.vouch?.nonce);
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).not.toBe(first);
	});

	test("none for a read-only tool, which nobody asks about", async () => {
		const { calls, run } = await bridgeWith([readOnly("search")], deny);
		await run("page_search");
		expect(calls).toEqual([{ name: "search", vouch: undefined }]);
	});

	test("no call and no vouch when the user did not allow it", async () => {
		const { calls, run, bridge } = await bridgeWith([asking("buy")], deny);
		await expect(run("page_buy")).rejects.toThrow("did not allow");
		await expect(bridge.callByName("buy", {}, options())).rejects.toThrow(
			"did not allow",
		);
		expect(calls).toEqual([]);
	});

	test("no call and no vouch when the page changed while the user was asked", async () => {
		let relist: ((next: PageTools) => Promise<void>) | undefined;
		const confirm: Confirm = async () => {
			await relist?.(page([asking("buy")], "doc-2"));
		};
		const b = await bridgeWith([asking("buy")], confirm);
		relist = b.relist;
		await expect(b.run("page_buy")).rejects.toThrow("changed while the user");
		expect(b.calls).toEqual([]);
	});
});

describe("the worker and the panel", () => {
	test("only this extension's content script in a tab's top frame may ask for the state", () => {
		const ask = { type: "handshake" };
		const from = { id: "ext", tab: {}, frameId: 0 };
		expect(isHandshakeAsk(ask, from, "ext")).toBe(true);
		expect(isHandshakeAsk(ask, { ...from, frameId: 2 }, "ext")).toBe(false);
		expect(isHandshakeAsk(ask, { id: "ext", frameId: 0 }, "ext")).toBe(false);
		expect(isHandshakeAsk(ask, { ...from, id: "other" }, "ext")).toBe(false);
		expect(isHandshakeAsk({ type: "webmcp-changed" }, from, "ext")).toBe(false);
	});

	test("the panel: a quiet line for a page with the library, and the apps connected both ways", () => {
		const tab = (apps?: { name: string; host: string }[]): TabView => ({
			title: "Todos",
			host: "todo.example",
			access: "",
			tools: [],
			canAllow: true,
			...(apps ? { library: { apps } } : {}),
		});
		const grants = [
			{ grantId: "g1", name: "Claude", host: "claude.ai" },
			{ grantId: "g2", name: "Codex", host: "openai.com" },
		];
		expect(libraryNotes(tab(), grants)).toEqual({ builtIn: false });
		expect(libraryNotes(tab([]), grants)).toEqual({ builtIn: true });
		// Another app of the same name elsewhere is not the same app.
		expect(
			libraryNotes(tab([{ name: "Claude", host: "evil.example" }]), grants),
		).toEqual({ builtIn: true });
		expect(
			libraryNotes(tab([{ name: "Claude", host: "claude.ai" }]), grants).both,
		).toBe(
			"Claude (claude.ai) is also connected to this page directly, so it sees the page's tools twice, once through each. Disconnect it in one of the two: above in this panel, or in the page.",
		);
		expect(
			libraryNotes(
				tab([
					{ name: "Codex", host: "openai.com" },
					{ name: "Claude", host: "claude.ai" },
				]),
				grants,
			).both,
		).toStartWith(
			"Claude (claude.ai) and Codex (openai.com) are also connected to this page directly, so they see",
		);
	});
});

describe("both sides together: the client library in the page", () => {
	/** Chrome's `ModelContext` as far as the library and the content script use it. */
	class FakeModelContext {
		readonly tools = new Map<
			string,
			{
				name: string;
				description: string;
				annotations?: object;
				execute: (i: unknown, o: unknown) => unknown;
			}
		>();
		async registerTool(tool: {
			name: string;
			description: string;
			execute: (i: unknown, o: unknown) => unknown;
		}) {
			this.tools.set(tool.name, tool);
		}
		async getTools() {
			return [...this.tools.values()];
		}
		async executeTool(tool: { name: string }, input: unknown) {
			const value = await this.tools
				.get(tool.name)
				?.execute(input, { signal: new AbortController().signal });
			return typeof value === "string" ? value : JSON.stringify(value);
		}
	}
	const g = globalThis as Record<string, unknown>;
	const saved = { Document: g["Document"], document: g["document"] };
	afterEach(() => Object.assign(g, saved));

	/** The page: a `TabMcp` with `webmcp: true` and a tool that asks. */
	async function libraryPage() {
		const native = new FakeModelContext();
		const Doc = window.Document as unknown as { prototype: object };
		Object.defineProperty(Doc.prototype, "modelContext", {
			configurable: true,
			get: () => native,
		});
		g["Document"] = Doc;
		g["document"] = doc;
		const asked: ConfirmRequest[] = [];
		const calls: ToolCallStart[] = [];
		const mcp = new TabMcp({
			server: { name: "Todos", version: "1.0.0" },
			webmcp: true,
			onConfirm: (request) => {
				asked.push(request);
				return true;
			},
		});
		mcp.addEventListener("toolcall", (e) => calls.push(e.detail));
		await mcp.registerTool(
			{
				name: "complete_todo",
				description: "Completes a todo",
				inputSchema: {
					type: "object",
					properties: { id: { type: "number" } },
				},
				annotations: { consequentialHint: true },
				execute: ({ id }) => `completed ${id}`,
			},
			{ callers: ["relay", "webmcp"] },
		);
		await Bun.sleep(5);
		return { mcp, native, asked, calls };
	}

	test("the extension's state reaches TabMcp.extension; a vouched call is not asked again", async () => {
		const { h } = handshake();
		const { mcp, native, asked, calls } = await libraryPage();
		await Bun.sleep(0);
		expect(h.library).toEqual({ version: expect.any(String), apps: [] });
		expect(mcp.extension).toEqual({
			name: "tab-mcp browser extension",
			version: "0.3.0",
			apps: [{ name: "Claude", host: "claude.ai" }],
			whileInFront: true,
		});
		const call = {
			documentId: "doc-A",
			name: "complete_todo",
			readOnly: false,
		};
		const signal = new AbortController().signal;
		// The page as the content script reads it: the native WebMCP.
		const page = {
			location: doc.location,
			modelContext: native,
		} as unknown as Document;
		const result = await callTool(
			call,
			{ id: 7 },
			signal,
			page,
			"doc-A",
			(args) => h.vouch("complete_todo", args, VOUCH),
		);
		expect(result).toEqual({ ok: true, value: "completed 7" });
		expect(asked).toEqual([]);
		expect(calls[0]?.client).toEqual({
			kind: "webmcp",
			via: "tab-mcp-extension",
			name: "Claude",
			host: "claude.ai",
		});
		// Without the vouch (another agent in the browser): asked as before.
		await callTool(call, { id: 7 }, signal, page, "doc-A");
		expect(asked).toHaveLength(1);
		h.stateChanged({ ...STATE, on: false, apps: [] });
		expect(mcp.extension).toBeUndefined();
	});

	test("the page's directly connected apps reach the panel's view", async () => {
		const { h } = handshake();
		const { mcp } = await libraryPage();
		const grant: Grant = {
			grantId: "g1",
			client: {
				id: "https://claude.ai/oauth",
				name: "Claude",
				host: "claude.ai",
			},
			createdAt: new Date().toISOString(),
		};
		// What the library sends on grantschange, as it would with a relay.
		Object.defineProperty(mcp, "grants", { value: [grant] });
		mcp.dispatchEvent(
			new CustomEvent("grantschange", { detail: { grants: [grant] } }),
		);
		expect(h.library?.apps).toEqual([{ name: "Claude", host: "claude.ai" }]);
	});
});
