/**
 * Mirroring the tools into WebMCP (iteration 25): against a fake native
 * `ModelContext` behind `Document.prototype`'s getter, as Chrome 156 has it
 * (`test/webmcp-browser.test.ts` checks the same in Chrome for Testing).
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	jest,
	spyOn,
	test,
} from "bun:test";
import { Window } from "happy-dom";
import type { TabMcp } from "../src/tab-mcp.ts";
import type {
	ConfirmRequest,
	TabMcpOptions,
	ToolCallEnd,
	ToolCallStart,
} from "../src/types.ts";
import { capture } from "../src/webmcp.ts";
import { newTab } from "./helpers.ts";
import { StubRelay } from "./stub-relay.ts";

interface NativeTool {
	name: string;
	title?: string;
	description: string;
	inputSchema?: object;
	annotations?: Record<string, boolean>;
	execute: (input: unknown, options: { signal: AbortSignal }) => unknown;
}

/** Chrome 156's `ModelContext`, as far as the library uses it. */
class FakeModelContext {
	readonly tools = new Map<string, NativeTool>();
	/** Set: `registerTool` rejects with it (a frame without `allow="tools"`). */
	refuse: Error | undefined;
	/** Unregister on abort a task later, not at once. */
	lateUnregister = false;
	registrations = 0;

	registerTool(tool: NativeTool, options: { signal?: AbortSignal } = {}) {
		this.registrations++;
		const { signal } = options;
		if (signal?.aborted)
			return Promise.reject(new DOMException("aborted", "AbortError"));
		if (this.refuse !== undefined) return Promise.reject(this.refuse);
		if (this.tools.has(tool.name))
			return Promise.reject(
				new DOMException("Duplicate tool name", "InvalidStateError"),
			);
		this.tools.set(tool.name, tool);
		signal?.addEventListener("abort", () => {
			const drop = () => {
				if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
			};
			if (this.lateUnregister) setTimeout(drop);
			else drop();
		});
		return Promise.resolve();
	}

	/** An agent's call: what `executeTool` does with the page's `execute`. */
	call(name: string, input: unknown, signal = new AbortController().signal) {
		const tool = this.tools.get(name);
		if (tool === undefined) throw new Error(`no native tool ${name}`);
		return Promise.resolve().then(() => tool.execute(input, { signal }));
	}
}

let window: Window;
let native: FakeModelContext;
const g = globalThis as Record<string, unknown>;
const saved = {
	Document: g["Document"],
	ModelContext: g["ModelContext"],
	document: g["document"],
};
const warn = spyOn(console, "warn").mockImplementation(() => {});
const tabs: TabMcp[] = [];

/** A page whose document has the native object, then the library "loads". */
beforeEach(() => {
	window = new Window({ url: "https://page.example/" });
	native = new FakeModelContext();
	const Doc = window.Document as unknown as { prototype: object };
	Object.defineProperty(Doc.prototype, "modelContext", {
		configurable: true,
		enumerable: true,
		get: () => native,
	});
	g["Document"] = Doc;
	g["ModelContext"] = FakeModelContext;
	g["document"] = window.document;
	capture();
	warn.mockClear();
});

afterEach(async () => {
	scope.abort();
	scope = new AbortController();
	for (const tab of tabs.splice(0)) tab.disconnect();
	Object.assign(g, saved);
	capture();
	await window.happyDOM.close();
});

/** Unregisters every tool of the test: the mirrors are the page's, across tests. */
let scope = new AbortController();

/** `t`, its tools unregistered after the test. */
function scoped(t: TabMcp): TabMcp {
	const register = t.registerTool.bind(t);
	t.registerTool = (tool, options = {}) =>
		register(tool, {
			...options,
			signal:
				options.signal === undefined
					? scope.signal
					: AbortSignal.any([options.signal, scope.signal]),
		});
	tabs.push(t);
	return t;
}

function tab(options: Partial<TabMcpOptions> = {}): TabMcp {
	return scoped(newTab("https://relay.example", { webmcp: true, ...options }));
}

const attribute = () =>
	window.document.documentElement.getAttribute("data-tab-mcp-webmcp");
/** Registration happens a microtask later; a retry a task later. */
const settle = () => Bun.sleep(5);

const add = {
	name: "add",
	title: "Add",
	description: "Adds two numbers",
	inputSchema: {
		type: "object",
		properties: { a: { type: "number" }, b: { type: "number" } },
		required: ["a", "b"],
	},
	annotations: {
		readOnlyHint: true,
		untrustedContentHint: false,
		debugging: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	execute: ({ a, b }: Record<string, unknown>) => ({
		sum: Number(a) + Number(b),
	}),
};
const wipe = {
	name: "wipe",
	description: "Wipes the memory",
	annotations: { consequentialHint: true },
	execute: () => "wiped",
};

describe("off by default", () => {
	test("without webmcp: true nothing is registered, not even a tool that says webmcp: true", async () => {
		const t = scoped(newTab("https://relay.example"));
		await t.registerTool(add);
		await t.registerTool(wipe, { webmcp: true });
		await settle();
		expect(native.registrations).toBe(0);
		expect(attribute()).toBeNull();
	});

	test("without native WebMCP nothing happens", async () => {
		delete (window.Document.prototype as { modelContext?: unknown })
			.modelContext;
		capture();
		const t = tab();
		await t.registerTool(add);
		await settle();
		expect(native.registrations).toBe(0);
		expect(t.tools).toEqual(["add"]);
	});
});

describe("mirroring", () => {
	test("tools that are not consequential, with the WebMCP fields and hints only", async () => {
		const t = tab();
		await t.registerTool(add);
		await t.registerTool(wipe);
		await settle();
		expect([...native.tools.keys()]).toEqual(["add"]);
		const mirrored = native.tools.get("add") as NativeTool;
		expect({ ...mirrored, execute: typeof mirrored.execute }).toEqual({
			name: "add",
			title: "Add",
			description: "Adds two numbers",
			inputSchema: add.inputSchema,
			annotations: {
				readOnlyHint: true,
				untrustedContentHint: false,
				debugging: false,
			},
			execute: "function",
		});
		// The page is not marked: <html data-tab-mcp-webmcp> is gone.
		expect(attribute()).toBeNull();
		// Through the relay, both.
		expect(t.tools).toEqual(["add", "wipe"]);
	});

	test("a consequential tool with webmcp: true; a tool with webmcp: false never", async () => {
		const t = tab();
		await t.registerTool(wipe, { webmcp: true });
		await t.registerTool({ ...add, name: "hidden" }, { webmcp: false });
		await settle();
		expect([...native.tools.keys()]).toEqual(["wipe"]);
	});

	test("after connect() too", async () => {
		const relay = new StubRelay();
		const t = scoped(newTab(relay.url, { webmcp: true }));
		try {
			await t.registerTool(add);
			await t.connect({ resume: true });
			await t.registerTool({ ...add, name: "later" });
			await settle();
			expect([...native.tools.keys()]).toEqual(["add", "later"]);
		} finally {
			t.disconnect();
			await relay.stop();
		}
	});

	test("aborting the tool's signal unmirrors it", async () => {
		const t = tab();
		const controller = new AbortController();
		await t.registerTool(add, { signal: controller.signal });
		await t.registerTool({ ...add, name: "other" });
		await settle();
		controller.abort();
		expect([...native.tools.keys()]).toEqual(["other"]);
	});

	test("a tool the validator refuses is unmirrored when the lazy chunk loads", async () => {
		const t = tab();
		const errors: string[] = [];
		t.addEventListener("error", (e) => errors.push(e.detail.error.message));
		// Passes the core's check; only the validator sees the nested $id.
		await t.registerTool({
			name: "early",
			description: "d",
			inputSchema: {
				type: "object",
				properties: { a: { $id: "https://y.example/t", $ref: "#/$defs/s" } },
				$defs: { s: { type: "string" } },
			},
			execute: () => "ran",
		});
		await t.registerTool(add);
		await settle();
		const early = native.tools.get("early") as NativeTool;
		// The first WebMCP call loads the chunk and compiles every schema.
		await expect(native.call("add", { a: 1, b: 2 })).resolves.toEqual({
			sum: 3,
		});
		expect(errors).toEqual([
			'registerTool: the inputSchema of early: $ref "#/$defs/s" does not resolve; the tool was unregistered',
		]);
		expect([...native.tools.keys()]).toEqual(["add"]);
		// A call that still holds the old function: the tool is gone.
		await expect(
			Promise.resolve().then(() =>
				early.execute({}, { signal: new AbortController().signal }),
			),
		).resolves.toEqual({ error: "The tool early is no longer available." });
	});

	test("abort and register again, also when the browser unregisters a task later", async () => {
		for (const late of [false, true]) {
			native = new FakeModelContext();
			native.lateUnregister = late;
			const t = tab();
			const first = new AbortController();
			await t.registerTool(add, { signal: first.signal });
			await settle();
			first.abort();
			await t.registerTool(add); // as React's useTool does on a change
			await settle();
			expect({ late, tools: [...native.tools.keys()] }).toEqual({
				late,
				tools: ["add"],
			});
			expect(warn).not.toHaveBeenCalled();
			await expect(native.call("add", { a: 2, b: 2 })).resolves.toEqual({
				sum: 4,
			});
			scope.abort();
			scope = new AbortController();
		}
	});
});

describe("every failure stays with the mirror", () => {
	test("a name the page holds natively: warned once, offered through the relay only", async () => {
		await native.registerTool({
			name: "add",
			description: "The page's own",
			execute: () => "page",
		});
		const t = tab();
		const controller = new AbortController();
		await t.registerTool(add, { signal: controller.signal });
		await settle();
		expect(native.tools.get("add")?.description).toBe("The page's own");
		expect(t.tools).toEqual(["add"]);
		// Registered again (useTool): still the page's, no second warning.
		controller.abort();
		await t.registerTool(add);
		await settle();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain(
			"add is not offered through WebMCP",
		);
	});

	test("the page's own later registration of a mirrored name fails, the mirror stays", async () => {
		const t = tab();
		await t.registerTool(add);
		await settle();
		await expect(
			native.registerTool({ name: "add", description: "d", execute: () => 1 }),
		).rejects.toMatchObject({ name: "InvalidStateError" });
	});

	test('a frame without allow="tools" (NotAllowedError): warned, tools unchanged', async () => {
		native.refuse = new DOMException(
			'Access to the feature "tools" is disallowed by permissions policy.',
			"NotAllowedError",
		);
		const t = tab();
		await expect(t.registerTool(add)).resolves.toBeUndefined();
		await settle();
		expect(native.tools.size).toBe(0);
		expect(t.tools).toEqual(["add"]);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	test("a tool unregistered before its retry is not registered, whatever the browser does with an aborted signal (review of PR 103)", async () => {
		const names: string[] = [];
		let calls = 0;
		native.registerTool = (tool: NativeTool) => {
			names.push(tool.name);
			// The first attempt fails; a browser that ignored an aborted signal
			// would take the retry.
			return ++calls === 1
				? Promise.reject(new DOMException("taken", "InvalidStateError"))
				: Promise.resolve();
		};
		const t = tab();
		const controller = new AbortController();
		await t.registerTool(add, { signal: controller.signal });
		await Bun.sleep(0); // the first attempt failed; the retry waits a task
		controller.abort();
		await settle();
		expect(names).toEqual(["add"]);
		expect(warn).not.toHaveBeenCalled();
	});

	test("a registerTool that throws at once", async () => {
		native.registerTool = () => {
			throw new TypeError("nope");
		};
		const t = tab();
		await t.registerTool(add);
		await settle();
		expect(t.tools).toEqual(["add"]);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});

describe("only the native object", () => {
	test("a polyfill's own document.modelContext is not used: the tools go to the native one", async () => {
		const polyfill = { registerTool: jest.fn(() => Promise.resolve()) };
		Object.defineProperty(window.document, "modelContext", {
			value: polyfill,
			configurable: true,
		});
		const t = tab();
		await t.registerTool(add);
		await settle();
		expect(polyfill.registerTool).not.toHaveBeenCalled();
		expect([...native.tools.keys()]).toEqual(["add"]);
	});

	test("a getter that does not give a ModelContext is not used", async () => {
		const forged = new FakeModelContext();
		Object.defineProperty(window.Document.prototype, "modelContext", {
			configurable: true,
			get: () => forged,
		});
		g["ModelContext"] = class Other {};
		capture();
		const t = tab();
		await t.registerTool(add);
		await settle();
		expect(forged.registrations).toBe(0);
	});
});

describe("calls", () => {
	function watched(t: TabMcp) {
		const events: { start: ToolCallStart[]; end: ToolCallEnd[] } = {
			start: [],
			end: [],
		};
		t.addEventListener("toolcall", (e) => events.start.push(e.detail));
		t.addEventListener("toolcallend", (e) => events.end.push(e.detail));
		return events;
	}

	test("a call runs and resolves with what execute returned; the events name the caller", async () => {
		const t = tab();
		let seen: { client: unknown; signal: AbortSignal } | undefined;
		await t.registerTool({
			...add,
			execute: (input, options) => {
				seen = options;
				return add.execute(input);
			},
		});
		const events = watched(t);
		await settle();
		const signal = new AbortController().signal;
		await expect(native.call("add", { a: 1, b: 2 }, signal)).resolves.toEqual({
			sum: 3,
		});
		expect(seen?.client).toEqual({ kind: "webmcp" });
		expect(seen?.signal).toBe(signal);
		expect(events.start).toEqual([
			{
				id: expect.any(Number),
				tool: "add",
				title: "Add",
				arguments: { a: 1, b: 2 },
				client: { kind: "webmcp" },
			},
		]);
		expect(events.end[0]).toMatchObject({
			tool: "add",
			client: { kind: "webmcp" },
			outcome: "ok",
			result: { structuredContent: { sum: 3 } },
		});
	});

	test("bad arguments resolve with an error the agent can read and do not run (DEC-120)", async () => {
		const t = tab();
		const execute = jest.fn(() => 1);
		await t.registerTool({ ...add, execute });
		const events = watched(t);
		await settle();
		const result = (await native.call("add", { a: "x" })) as {
			error: string;
		};
		expect(Object.keys(result)).toEqual(["error"]);
		expect(result.error).toStartWith(
			"Input validation error: Invalid arguments for tool add: ",
		);
		expect(execute).not.toHaveBeenCalled();
		expect(events.end[0]?.outcome).toBe("error");
	});

	test("input that is not an object resolves with an error, without a call", async () => {
		const t = tab();
		await t.registerTool(add);
		const events = watched(t);
		await settle();
		await expect(native.call("add", "1, 2")).resolves.toEqual({
			error: "The input must be an object.",
		});
		expect(events.start).toEqual([]);
	});

	test("a consequential tool asks onConfirm, which learns the caller; Don't allow resolves with an error", async () => {
		const asked: ConfirmRequest[] = [];
		let answer = false;
		const t = tab({
			alwaysAllow: true,
			onConfirm: (request) => {
				asked.push(request);
				return answer;
			},
		});
		await t.registerTool(wipe, { webmcp: true });
		const events = watched(t);
		await settle();
		await expect(native.call("wipe", {})).resolves.toEqual({
			error: "The user did not allow wipe to run.",
		});
		expect(asked[0]?.client).toEqual({ kind: "webmcp" });
		expect(events.end[0]?.outcome).toBe("declined");
		answer = true;
		await expect(native.call("wipe", {})).resolves.toBe("wiped");
		expect(events.end[1]?.outcome).toBe("ok");
	});

	test('onConfirm\'s "unanswered" resolves with its own error and outcome; another value is a refusal', async () => {
		let answer: unknown = "unanswered";
		const t = tab({ onConfirm: () => answer as boolean });
		await t.registerTool(wipe, { webmcp: true });
		const events = watched(t);
		await settle();
		await expect(native.call("wipe", {})).resolves.toEqual({
			error: "The user did not answer whether wipe may run.",
		});
		expect(events.end[0]?.outcome).toBe("unanswered");
		expect(events.end[0]?.result.content).toEqual([
			{ type: "text", text: "The user was asked and did not answer." },
		]);
		// From plain JavaScript: only true runs, only "unanswered" is unanswered.
		answer = "yes";
		await expect(native.call("wipe", {})).resolves.toEqual({
			error: "The user did not allow wipe to run.",
		});
		expect(events.end[1]?.outcome).toBe("declined");
	});

	test('a call cancelled while asked stays cancelled, even if onConfirm then says "unanswered" (review of PR 112)', async () => {
		const controller = new AbortController();
		const t = tab({
			onConfirm: () => {
				controller.abort();
				return "unanswered";
			},
		});
		await t.registerTool(wipe, { webmcp: true });
		const events = watched(t);
		await settle();
		await expect(
			native.call("wipe", {}, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(events.end[0]?.outcome).toBe("cancelled");
	});

	test("an isError result and a throw resolve with their message", async () => {
		const t = tab();
		const thrown = new RangeError("too big");
		await t.registerTool({
			name: "fails",
			description: "d",
			execute: () => ({
				content: [{ type: "text", text: "No such item" }],
				isError: true,
			}),
		});
		await t.registerTool({
			name: "throws",
			description: "d",
			execute: () => {
				throw thrown;
			},
		});
		const events = watched(t);
		await settle();
		await expect(native.call("fails", {})).resolves.toEqual({
			error: "No such item",
		});
		await expect(native.call("throws", {})).resolves.toEqual({
			error: "too big",
		});
		expect(events.end.map((e) => e.outcome)).toEqual(["error", "error"]);
	});

	test("a call the browser cancels still rejects with an AbortError: nobody reads it", async () => {
		const t = tab();
		const controller = new AbortController();
		await t.registerTool({
			name: "slow",
			description: "d",
			execute: (_input, { signal }) =>
				new Promise((resolve) =>
					signal.addEventListener("abort", () => resolve("late")),
				),
		});
		const events = watched(t);
		await settle();
		const call = native.call("slow", {}, controller.signal);
		await settle();
		controller.abort();
		await expect(call).rejects.toMatchObject({ name: "AbortError" });
		expect(events.end[0]?.outcome).toBe("cancelled");
	});

	test("a tool unregistered while the user is asked resolves with an error", async () => {
		let allow: (yes: boolean) => void = () => {};
		const t = tab({
			onConfirm: () =>
				new Promise<boolean>((resolve) => {
					allow = resolve;
				}),
		});
		const controller = new AbortController();
		await t.registerTool(wipe, { webmcp: true, signal: controller.signal });
		await settle();
		const call = native.call("wipe", {});
		await settle();
		controller.abort();
		allow(true);
		await expect(call).resolves.toEqual({
			error: "The tool wipe is no longer available.",
		});
	});
});
