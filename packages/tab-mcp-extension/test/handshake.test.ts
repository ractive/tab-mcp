/**
 * The extension's side of the handshake with a page that uses the client
 * library (DEC-207): the content script's `PageHandshake`, the vouch in
 * `callTool` and the bridge, the worker's check of who asks, the panel's
 * lines; and both sides together, the real library in a happy-dom page
 * with a fake native WebMCP. End to end in `extension.browser.test.ts`
 * (Chrome) and `firefox.browser.test.ts`.
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
import { callTool, definitionOf, pageTools } from "../src/content.ts";
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

/** Retries in these tests: 10 ms, then 20 ms. */
const RETRIES = [10, 20];

/** The call target of page tool `name` of `page`, as the bridge sends it. */
async function offered(page: Document, name: string) {
	const tool = (await pageTools(page, "doc-A")).tools.find(
		(t) => t.name === name,
	);
	if (tool === undefined) throw new Error(`no tool ${name}`);
	return {
		documentId: "doc-A",
		name,
		readOnly: tool.annotations?.readOnlyHint === true,
		definition: definitionOf(tool),
	};
}

/**
 * A handshake whose worker answers `state` (or does not, `null`), or each
 * ask with the next of `answers` (`"throw"`: `sendMessage` rejects).
 */
function handshake(
	state: ExtensionState | null = STATE,
	answers?: (ExtensionState | null | "throw")[],
) {
	const host = { asked: 0, changes: 0 };
	const h = new PageHandshake(
		doc,
		{
			state: async () => {
				host.asked++;
				const answer = answers === undefined ? state : answers.shift();
				if (answer === "throw") throw new Error("no worker");
				return answer ?? undefined;
			},
			changed: () => host.changes++,
		},
		RETRIES,
	);
	h.start();
	return { h, host };
}

describe("the content script speaks only to a page that announced the library", () => {
	test("silent on a page without it: no hello, no state, no vouch", async () => {
		const { h, host } = handshake();
		h.stateChanged(STATE);
		h.vouch("buy", { n: 1 }, VOUCH);
		h.withdraw("n1");
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
		h.withdraw("n1");
		expect(told.at(-1)).toEqual({ v: 1, type: "withdraw", nonce: "n1" });
	});

	test("a worker that never answers: asked again twice, then not; nothing is told", async () => {
		const { host } = handshake(null);
		pageSays(hello());
		await Bun.sleep(80);
		expect(told).toEqual([]);
		expect(host.asked).toBe(1 + RETRIES.length);
	});

	test("a worker that answers only on a retry: the page learns the state then", async () => {
		const { host } = handshake(null, ["throw", null, STATE]);
		pageSays(hello());
		await Bun.sleep(5);
		expect(told).toEqual([]);
		await Bun.sleep(60);
		expect(host.asked).toBe(3);
		expect(told).toEqual([{ v: 1, type: "update", ...STATE }]);
	});

	test("a page that spoke first and a worker slow to start: the hello comes on a retry", async () => {
		doc.documentElement.setAttribute(MARK, "1");
		handshake(null, [null, STATE]);
		await Bun.sleep(40);
		expect(told).toEqual([{ v: 1, type: "hello", ...STATE }]);
	});

	test("no more retries once the page went away", async () => {
		const { host } = handshake(null);
		pageSays(hello());
		await Bun.sleep(0);
		window.dispatchEvent(new window.Event("pagehide"));
		await Bun.sleep(60);
		expect(host.asked).toBe(1);
	});

	test("a change from the worker during the retries is told, and ends them", async () => {
		const { h, host } = handshake(null);
		pageSays(hello());
		await Bun.sleep(0);
		h.stateChanged(STATE);
		await Bun.sleep(60);
		expect(host.asked).toBe(1);
		expect(told).toEqual([{ v: 1, type: "update", ...STATE }]);
	});

	test("many hellos in a row cost one message to the worker; later ones are answered from the last state", async () => {
		const { h, host } = handshake();
		for (let i = 0; i < 100; i++) pageSays(hello());
		await Bun.sleep(0);
		for (let i = 0; i < 100; i++) pageSays(hello());
		await Bun.sleep(0);
		expect(host.asked).toBe(1);
		expect(told).toHaveLength(100 + 1);
		// The worker's next change is what later hellos are answered with.
		const off = { ...STATE, on: false, apps: [] };
		h.stateChanged(off);
		pageSays(hello());
		expect(told.at(-1)).toEqual({ v: 1, type: "update", ...off });
		expect(host.asked).toBe(1);
	});

	test("many hellos while the worker cannot answer: still one ask per try", async () => {
		const { host } = handshake(null);
		for (let i = 0; i < 100; i++) pageSays(hello());
		await Bun.sleep(15);
		for (let i = 0; i < 100; i++) pageSays(hello());
		await Bun.sleep(60);
		expect(host.asked).toBe(1 + RETRIES.length);
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

	test("several app ids of other versions: the version is that of the first, whatever comes after", () => {
		const { h } = handshake();
		pageSays(hello({ type: "update", app: "a", library: "0.19.0" }));
		pageSays(hello({ type: "update", app: "b", library: "0.20.0" }));
		pageSays(hello({ type: "update", app: "b", library: "0.20.1" }));
		pageSays(hello({ type: "update", app: "a", library: "0.19.0" }));
		expect(h.library?.version).toBe("0.19.0");
	});

	test("more than 64 apps either way are cut to 64, not refused", async () => {
		const many = Array.from({ length: 70 }, (_, i) => ({
			name: `App ${i}`,
			host: "apps.example",
		}));
		expect(parsePage(JSON.stringify(hello({ apps: many })))?.apps).toEqual(
			many.slice(0, 64),
		);
		const { h } = handshake({ ...STATE, apps: many });
		pageSays(hello({ apps: many }));
		await Bun.sleep(0);
		expect(h.library?.apps).toHaveLength(64);
		expect(told.at(-1)?.["apps"]).toEqual(many.slice(0, 64));
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
	/**
	 * A page with one tool `buy` (not read-only) in a fake WebMCP whose
	 * `executeTool` fails with `fails`, or (`"abort"`) as the browser does
	 * for an aborted signal.
	 */
	function toolPage(fails?: Error | "abort") {
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
				executeTool: async (
					_tool: unknown,
					input: unknown,
					options: { signal: AbortSignal },
				) => {
					if (fails === "abort") {
						options.signal.throwIfAborted();
						throw new Error("not aborted");
					}
					if (fails !== undefined) throw fails;
					order.push(`run ${JSON.stringify(input)}`);
					return "ran";
				},
			},
		} as unknown as Document;
		const vouch = {
			send: (args: unknown) => order.push(`vouch ${JSON.stringify(args)}`),
			withdraw: () => order.push("withdraw"),
		};
		return { page, order, vouch };
	}
	const signal = new AbortController().signal;
	const call = {
		documentId: "doc-A",
		name: "buy",
		readOnly: false,
		// `buy` as the content script offers it.
		definition: definitionOf({
			name: "buy",
			description: "Buys.",
			annotations: { readOnlyHint: false, debugging: false },
		}),
	};

	test("goes out right before the tool runs, with the arguments it runs with; withdrawn after", async () => {
		const { page, order, vouch } = toolPage();
		expect(
			await callTool(call, { n: 1 }, signal, page, "doc-A", vouch),
		).toEqual({ ok: true, value: "ran" });
		expect(order).toEqual(['vouch {"n":1}', 'run {"n":1}', "withdraw"]);
		// No input: both with {}.
		order.length = 0;
		await callTool(call, undefined, signal, page, "doc-A", vouch);
		expect(order).toEqual(["vouch {}", "run {}", "withdraw"]);
	});

	test("withdrawn when the call fails or is cancelled before it reaches the page", async () => {
		const failing = toolPage(new Error("The tool is not registered."));
		expect(
			await callTool(call, {}, signal, failing.page, "doc-A", failing.vouch),
		).toEqual({ ok: false, error: "The tool is not registered." });
		expect(failing.order).toEqual(["vouch {}", "withdraw"]);
		const aborted = toolPage("abort");
		const cancel = new AbortController();
		cancel.abort();
		const result = await callTool(
			call,
			{},
			cancel.signal,
			aborted.page,
			"doc-A",
			aborted.vouch,
		);
		expect(result.ok).toBe(false);
		expect(aborted.order).toEqual(["vouch {}", "withdraw"]);
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
			// Offered with another definition (DEC-217).
			await callTool(
				{
					...call,
					definition: definitionOf({ name: "buy", description: "x" }),
				},
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
			"Claude (claude.ai) is also connected to this page directly, so it sees the page's tools twice, once through each. Disconnect it in one of the two: above in this panel, or on the page.",
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
		async executeTool(
			tool: { name: string },
			input: unknown,
			options?: { signal?: AbortSignal },
		) {
			// As the browser: an aborted call does not reach the page.
			options?.signal?.throwIfAborted();
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
		const signal = new AbortController().signal;
		// The page as the content script reads it: the native WebMCP.
		const page = {
			location: doc.location,
			modelContext: native,
		} as unknown as Document;
		const call = await offered(page, "complete_todo");
		const result = await callTool(call, { id: 7 }, signal, page, "doc-A", {
			send: (args) => h.vouch("complete_todo", args, VOUCH),
			withdraw: () => h.withdraw(VOUCH.nonce),
		});
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

	test("a call cancelled before it reached the page takes its vouch back: an agent's equal call is asked", async () => {
		const { h } = handshake();
		const { native, asked } = await libraryPage();
		await Bun.sleep(0);
		const page = {
			location: doc.location,
			modelContext: native,
		} as unknown as Document;
		const call = await offered(page, "complete_todo");
		const cancelled = new AbortController();
		cancelled.abort();
		const result = await callTool(
			call,
			{ id: 7 },
			cancelled.signal,
			page,
			"doc-A",
			{
				send: (args) => h.vouch("complete_todo", args, VOUCH),
				withdraw: () => h.withdraw(VOUCH.nonce),
			},
		);
		expect(result.ok).toBe(false);
		expect(asked).toEqual([]);
		// Another agent in the browser, at once, with equal arguments.
		await callTool(
			call,
			{ id: 7 },
			new AbortController().signal,
			page,
			"doc-A",
		);
		expect(asked).toHaveLength(1);
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
