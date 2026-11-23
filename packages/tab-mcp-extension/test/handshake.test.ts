/**
 * The extension's side of the handshake with a page that uses the client
 * library (DEC-207): the content script's `PageHandshake`, the vouch in
 * `callTool` and the bridge, the worker's check of who asks, the panel's
 * lines; and both sides together, the real library in a happy-dom page
 * with a fake native WebMCP. End to end in `extension.browser.test.ts`
 * (Chrome) and `firefox-smoke.browser.test.ts`.
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
	resultOf,
} from "../src/worker/bridge.ts";

const STATE: ExtensionState = {
	name: "tab-mcp browser extension",
	on: true,
	apps: [{ name: "Claude", host: "claude.ai" }],
	whileInFront: true,
};
/** AI access off (or not connected), as the worker sends it. */
const OFF: ExtensionState = { ...STATE, on: false, apps: [] };
/** What a page told "on" hears once AI access goes off (DEC-221). */
const TOLD_OFF = { v: 1, type: "update", on: false };
const VOUCH: Vouch = {
	nonce: "n1",
	app: { name: "Claude", host: "claude.ai" },
	allowed: true,
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
	const host = { asked: 0, changes: 0, alive: true };
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
			alive: () => host.alive,
		},
		RETRIES,
	);
	h.start();
	return { h, host };
}

/**
 * A page that marked itself and was greeted with the state: the content
 * script reads what it says from now on. `told` is emptied.
 */
async function toldOn(state: ExtensionState | null = STATE) {
	doc.documentElement.setAttribute(MARK, "1");
	const made = handshake(state);
	await Bun.sleep(0);
	if (state === null) made.h.stateChanged(STATE);
	expect(told.map((m) => m["type"])).toEqual(["hello"]);
	told.length = 0;
	return made;
}

const CODEX = { name: "Codex", host: "openai.com" };

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

	test("the page's first word is noted, not read; once on it is greeted with hello, and its answer is read; its update is not answered, its hello is", async () => {
		const { h, host } = handshake();
		pageSays(hello({ type: "update", apps: [CODEX] }));
		// Noted: the panel may say the page has tab-mcp built in, no more.
		expect(h.library).toEqual({ apps: [] });
		expect(host.changes).toBe(1);
		await Bun.sleep(0);
		expect(told).toEqual([{ v: 1, type: "hello", ...STATE }]);
		// The page's answer to that hello.
		pageSays(hello({ type: "update", apps: [CODEX] }));
		expect(h.library).toEqual({ version: "0.19.0", apps: [CODEX] });
		expect(told).toHaveLength(1);
		pageSays(hello({ apps: [CODEX] }));
		expect(told.at(-1)).toEqual({ v: 1, type: "update", ...STATE });
		expect(host.changes).toBe(2);
		h.stateChanged(OFF);
		expect(told.at(-1)).toEqual(TOLD_OFF);
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
			result: "mcp",
		});
		h.withdraw("n1");
		expect(told.at(-1)).toEqual({ v: 1, type: "withdraw", nonce: "n1" });
		// A call the extension runs without asking: a claim, the same fields.
		h.vouch("search", { q: "a" }, { ...VOUCH, nonce: "n2", allowed: false });
		expect(told.at(-1)).toEqual({
			v: 1,
			type: "claim",
			tool: "search",
			arguments: { q: "a" },
			nonce: "n2",
			app: { name: "Claude", host: "claude.ai" },
			result: "mcp",
		});
		h.withdraw("n2");
		expect(told.at(-1)).toEqual({ v: 1, type: "withdraw", nonce: "n2" });
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
		expect(told).toEqual([{ v: 1, type: "hello", ...STATE }]);
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
		expect(told).toEqual([{ v: 1, type: "hello", ...STATE }]);
	});

	test("many hellos in a row cost one message to the worker; later ones are answered from the last state", async () => {
		const { h, host } = handshake();
		for (let i = 0; i < 100; i++) pageSays(hello());
		await Bun.sleep(0);
		for (let i = 0; i < 100; i++) pageSays(hello());
		await Bun.sleep(0);
		expect(host.asked).toBe(1);
		// The first hundred noted, one greeting; the next hundred answered.
		expect(told).toHaveLength(100 + 1);
		expect(told[0]?.["type"]).toBe("hello");
		// The worker's next change is what later hellos are answered with:
		// off, told once, then nothing.
		h.stateChanged(OFF);
		expect(told.at(-1)).toEqual(TOLD_OFF);
		pageSays(hello());
		expect(told).toHaveLength(100 + 2);
		h.stateChanged(STATE);
		pageSays(hello());
		expect(told.at(-1)).toEqual({ v: 1, type: "update", ...STATE });
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
		const { h, host } = await toldOn();
		const claude = { name: "Claude", host: "claude.ai" };
		pageSays(hello({ type: "update", apps: [claude] }));
		pageSays(hello({ type: "update", app: "other", apps: [claude] }));
		expect(h.library?.apps).toEqual([claude]);
		pageSays(hello({ type: "update", apps: [claude] }));
		expect(host.changes).toBe(1);
	});

	test("several app ids of other versions: the version is that of the first, whatever comes after", async () => {
		const { h } = await toldOn();
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
		expect(told.at(-1)?.["apps"]).toEqual(many.slice(0, 64));
		pageSays(hello({ type: "update", apps: many }));
		expect(h.library?.apps).toHaveLength(64);
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

describe("while AI access is off the page learns nothing (DEC-221)", () => {
	/** The attributes of `<html>`, to see that nothing marks the document. */
	const marks = () =>
		doc.documentElement
			.getAttributeNames()
			.map((n) => `${n}=${doc.documentElement.getAttribute(n)}`);

	test("a page that announces while off hears nothing at all, and is not marked", async () => {
		doc.documentElement.setAttribute(MARK, "1");
		const before = marks();
		const { h, host } = handshake(OFF);
		await Bun.sleep(0);
		pageSays(hello());
		await Bun.sleep(0);
		h.stateChanged(OFF);
		h.vouch("buy", { n: 1 }, VOUCH);
		h.withdraw("n1");
		await Bun.sleep(30);
		expect(told).toEqual([]);
		expect(marks()).toEqual(before);
		// The panel learns only that the page announced: nothing it said.
		expect(h.library).toEqual({ apps: [] });
		expect(host.changes).toBe(0);
	});

	test("the page's event is not read at all before it was told on, not even its detail", async () => {
		const { h, host } = handshake(OFF);
		let reads = 0;
		const event = new window.CustomEvent(PAGE_EVENT, {
			detail: JSON.stringify(hello()) as unknown as object,
		});
		Object.defineProperty(event, "detail", {
			get: () => {
				reads++;
				return JSON.stringify(hello());
			},
		});
		doc.dispatchEvent(event as unknown as Event);
		await Bun.sleep(0);
		doc.dispatchEvent(event as unknown as Event);
		expect(reads).toBe(0);
		expect(told).toEqual([]);
		// Noted: the panel's "built in", nothing else.
		expect(h.library).toEqual({ apps: [] });
		expect(host.changes).toBe(1);
		// Once on, the page is greeted, and what it says is read.
		h.stateChanged(STATE);
		expect(told.map((m) => m["type"])).toEqual(["hello"]);
		doc.dispatchEvent(event as unknown as Event);
		expect(reads).toBe(1);
		expect(h.library?.version).toBe("0.19.0");
	});

	test("told on, a detail that is no string is ignored", async () => {
		const { h } = await toldOn();
		let walked = false;
		doc.dispatchEvent(
			new window.CustomEvent(PAGE_EVENT, {
				detail: {
					get v() {
						walked = true;
						return 1;
					},
				},
			}) as unknown as Event,
		);
		expect(walked).toBe(false);
		expect(h.library).toEqual({ apps: [] });
		expect(told).toEqual([]);
	});

	test("nothing is said in the call of the page's hello either (no reply to time)", () => {
		const { h } = handshake(OFF);
		h.stateChanged(OFF);
		pageSays(hello());
		expect(told).toEqual([]);
	});

	test("a page told on hears off once, then nothing; a later hello is not answered", async () => {
		const { h } = handshake();
		pageSays(hello());
		await Bun.sleep(0);
		expect(told).toEqual([{ v: 1, type: "hello", ...STATE }]);
		h.stateChanged(OFF);
		h.stateChanged({ ...OFF, name: "other" });
		pageSays(hello());
		await Bun.sleep(0);
		expect(told).toEqual([{ v: 1, type: "hello", ...STATE }, TOLD_OFF]);
	});

	test("a page that announces after AI access went off hears nothing", async () => {
		const { h } = handshake(null);
		h.stateChanged(OFF);
		pageSays(hello());
		await Bun.sleep(30);
		expect(told).toEqual([]);
	});

	test("turning on later reaches a page that announced earlier", async () => {
		const { h } = handshake(OFF);
		pageSays(hello());
		await Bun.sleep(0);
		h.stateChanged(STATE);
		// Greeted: nothing the page said while off was read.
		expect(told).toEqual([{ v: 1, type: "hello", ...STATE }]);
		h.stateChanged(OFF);
		expect(told.at(-1)).toEqual(TOLD_OFF);
	});

	test("a page that only marked itself gets the hello once on, so that it answers", async () => {
		doc.documentElement.setAttribute(MARK, "1");
		const { h } = handshake(OFF);
		await Bun.sleep(0);
		h.stateChanged(STATE);
		expect(told).toEqual([{ v: 1, type: "hello", ...STATE }]);
		h.stateChanged(OFF);
		h.stateChanged(STATE);
		expect(told.at(-1)).toEqual({ v: 1, type: "update", ...STATE });
	});

	test("no version in any message, whatever the worker sends", async () => {
		doc.documentElement.setAttribute(MARK, "1");
		// A state with more in it than the page may learn.
		const more = {
			...STATE,
			version: "0.3.2",
			relay: "https://relay.example",
		} as ExtensionState;
		const { h } = handshake(more);
		await Bun.sleep(0);
		pageSays(hello());
		h.vouch("buy", { n: 1 }, VOUCH);
		h.stateChanged({ ...more, on: false });
		expect(told.map((m) => m["type"])).toEqual([
			"hello",
			"update",
			"vouch",
			"update",
		]);
		for (const m of told) {
			expect(m).not.toHaveProperty("version");
			expect(m).not.toHaveProperty("relay");
		}
		expect(Object.keys(told[0] ?? {}).sort()).toEqual([
			"apps",
			"name",
			"on",
			"type",
			"v",
			"whileInFront",
		]);
	});

	test("no vouch to a page never told on; a vouch sent while on is still withdrawn after off", async () => {
		const { h } = handshake(OFF);
		pageSays(hello());
		await Bun.sleep(0);
		h.vouch("buy", { n: 1 }, VOUCH);
		h.withdraw("n1");
		expect(told).toEqual([]);
		h.stateChanged(STATE);
		h.vouch("buy", { n: 1 }, VOUCH);
		h.stateChanged(OFF);
		h.withdraw("n1");
		// Withdrawn once; a nonce never vouched for is not.
		h.withdraw("n1");
		h.withdraw("n2");
		expect(told.map((m) => m["type"])).toEqual([
			"hello",
			"vouch",
			"update",
			"withdraw",
		]);
	});

	test("a vouch that comes before the state: the page is told the call's state first, then the vouch", async () => {
		const { h } = handshake(null);
		pageSays(hello());
		await Bun.sleep(80);
		// The worker never answered: the page was told nothing.
		expect(told).toEqual([]);
		h.vouch("buy", { n: 1 }, VOUCH, STATE);
		expect(told.map((m) => m["type"])).toEqual(["hello", "vouch"]);
		expect(told[0]).toEqual({ v: 1, type: "hello", ...STATE });
		h.withdraw("n1");
		expect(told.at(-1)).toEqual({ v: 1, type: "withdraw", nonce: "n1" });
	});

	test("the state with a vouch tells no page that did not announce, and an off state tells none", async () => {
		const quiet = handshake(null);
		quiet.h.vouch("buy", { n: 1 }, VOUCH, STATE);
		expect(told).toEqual([]);
		const { h } = handshake(null);
		pageSays(hello());
		h.vouch("buy", { n: 1 }, VOUCH, OFF);
		await Bun.sleep(80);
		expect(told).toEqual([]);
	});

	test("back from the back/forward cache: the worker is asked again, and a page told on hears off", async () => {
		doc.documentElement.setAttribute(MARK, "1");
		const { host } = handshake(null, [STATE, OFF, STATE]);
		await Bun.sleep(0);
		expect(told.map((m) => m["type"])).toEqual(["hello"]);
		const show = (persisted: boolean) => {
			const event = new window.Event("pageshow");
			Object.defineProperty(event, "persisted", { value: persisted });
			window.dispatchEvent(event);
		};
		show(false);
		await Bun.sleep(0);
		expect(host.asked).toBe(1);
		show(true);
		await Bun.sleep(0);
		expect(told.at(-1)).toEqual(TOLD_OFF);
		show(true);
		await Bun.sleep(0);
		expect(told.at(-1)).toEqual({ v: 1, type: "update", ...STATE });
		expect(host.asked).toBe(3);
	});

	test("the extension gone (disabled or updated): a page told on hears off at the next occasion, then nothing", async () => {
		const { h, host } = await toldOn();
		host.alive = false;
		pageSays(hello());
		expect(told).toEqual([TOLD_OFF]);
		pageSays(hello());
		h.stateChanged(STATE);
		h.vouch("buy", { n: 1 }, VOUCH, STATE);
		const event = new window.Event("pageshow");
		Object.defineProperty(event, "persisted", { value: true });
		window.dispatchEvent(event);
		await Bun.sleep(30);
		expect(told).toEqual([TOLD_OFF]);
	});

	test("the extension gone before the page was told on: nothing at all", async () => {
		const { h, host } = handshake(OFF);
		host.alive = false;
		pageSays(hello());
		h.stateChanged(STATE);
		await Bun.sleep(30);
		expect(told).toEqual([]);
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

	test("a read-only tool, which nobody asks about, goes with a claim (not allowed); an allowed call's vouch is allowed (DEC-224)", async () => {
		const { calls, run, bridge } = await bridgeWith(
			[readOnly("search"), asking("buy")],
			allow,
		);
		await run("page_search");
		await bridge.callByName("search", {}, options());
		await run("page_buy");
		expect(
			calls.map((c) => [c.name, c.vouch?.allowed, c.vouch?.app.host]),
		).toEqual([
			["search", false, "claude.ai"],
			["search", false, "claude.ai"],
			["buy", true, "claude.ai"],
		]);
		const nonces = new Set(calls.map((c) => c.vouch?.nonce));
		expect(nonces.size).toBe(3);
	});

	test("a read-only call of another caller than an AI app through the relay goes without", async () => {
		const { calls, bridge } = await bridgeWith([readOnly("search")], deny);
		await bridge.callByName(
			"search",
			{},
			{
				signal: new AbortController().signal,
				client: { kind: "webmcp" },
			},
		);
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
		h.stateChanged(OFF);
		expect(mcp.extension).toBeUndefined();
	});

	test("a claimed read-only call brings the picture to the AI app; without the claim the page's text as before (DEC-224)", async () => {
		const { h } = handshake();
		const { mcp, native, asked, calls } = await libraryPage();
		const png = "iVBORw0KGgoAAAANSUhEUg==";
		await mcp.registerTool(
			{
				name: "snapshot",
				description: "The page as a picture",
				annotations: { readOnlyHint: true },
				execute: () => ({
					content: [
						{ type: "text", text: "The page:" },
						{ type: "image", data: png, mimeType: "image/png" },
					],
				}),
			},
			{ callers: ["relay", "webmcp"] },
		);
		await Bun.sleep(5);
		const signal = new AbortController().signal;
		const page = {
			location: doc.location,
			modelContext: native,
		} as unknown as Document;
		const call = await offered(page, "snapshot");
		expect(call.readOnly).toBe(true);
		const claim = { ...VOUCH, nonce: "c1", allowed: false };
		const claimed = await callTool(call, {}, signal, page, "doc-A", {
			send: (args) => h.vouch("snapshot", args, claim),
			withdraw: () => h.withdraw(claim.nonce),
		});
		if (!claimed.ok) throw new Error(claimed.error);
		// What the AI app gets: the bridge's unwrapping of the page's answer.
		expect(resultOf(claimed.value ?? "")).toEqual({
			content: [
				{ type: "text", text: "The page:" },
				{ type: "image", data: png, mimeType: "image/png" },
			],
		});
		expect(asked).toEqual([]);
		expect(calls[0]?.client).toEqual({
			kind: "webmcp",
			via: "tab-mcp-extension",
			name: "Claude",
			host: "claude.ai",
		});
		const plain = await callTool(call, {}, signal, page, "doc-A");
		if (!plain.ok) throw new Error(plain.error);
		expect(resultOf(plain.value ?? "")).toBe(
			"The page:\n[image content left out: WebMCP results are text.]",
		);
		expect(calls[1]?.client).toEqual({ kind: "webmcp" });
	});

	test("AI access off: the page's TabMcp sees exactly what it sees without the extension", async () => {
		const { h } = handshake(OFF);
		const { mcp, native, asked } = await libraryPage();
		const changes: unknown[] = [];
		mcp.addEventListener("extensionchange", (e) => changes.push(e.detail));
		await Bun.sleep(0);
		h.stateChanged(OFF);
		// Noted, not read.
		expect(h.library).toEqual({ apps: [] });
		expect(told).toEqual([]);
		expect(mcp.extension).toBeUndefined();
		// A WebMCP call is the page's to decide, unvouched, as without the
		// extension.
		const page = {
			location: doc.location,
			modelContext: native,
		} as unknown as Document;
		const call = await offered(page, "complete_todo");
		await callTool(
			call,
			{ id: 1 },
			new AbortController().signal,
			page,
			"doc-A",
			{
				send: (args) => h.vouch("complete_todo", args, VOUCH),
				withdraw: () => h.withdraw(VOUCH.nonce),
			},
		);
		expect(asked).toHaveLength(1);
		expect(told).toEqual([]);
		// On: the page learns it now, and its answer to the hello brings
		// what it announces.
		h.stateChanged(STATE);
		expect(mcp.extension?.apps).toEqual([
			{ name: "Claude", host: "claude.ai" },
		]);
		expect(changes).toHaveLength(1);
		expect(h.library).toEqual({ version: expect.any(String), apps: [] });
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
