/**
 * The page's side of the handshake with the tab-mcp browser extension
 * (DEC-207), against a fake native `ModelContext` as in `webmcp.test.ts`;
 * the test plays the extension with the DOM events it would send. With the
 * real extension: `packages/tab-mcp-extension/test/extension.browser.test.ts`
 * (Chrome) and `packages/tab-mcp-extension/test/firefox-smoke.browser.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { showConnectDialog } from "../src/connect.ts";
import { canonical, VOUCH_MS } from "../src/handshake.ts";
import type { TabMcp } from "../src/tab-mcp.ts";
import type {
	BrowserExtension,
	ConfirmRequest,
	Grant,
	TabMcpOptions,
	ToolCallStart,
} from "../src/types.ts";
import { VERSION } from "../src/version.ts";
import { newTab } from "./helpers.ts";
import { StubRelay } from "./stub-relay.ts";

interface NativeTool {
	name: string;
	execute: (input: unknown, options: { signal: AbortSignal }) => unknown;
}

/** Chrome's `ModelContext`, as far as the library and an agent use it. */
class FakeModelContext {
	readonly tools = new Map<string, NativeTool>();
	registerTool(tool: NativeTool, options: { signal?: AbortSignal } = {}) {
		if (this.tools.has(tool.name))
			return Promise.reject(new DOMException("taken", "InvalidStateError"));
		this.tools.set(tool.name, tool);
		options.signal?.addEventListener("abort", () => {
			if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
		});
		return Promise.resolve();
	}
	/** An agent's call (the extension's `executeTool`). */
	call(name: string, input: unknown) {
		const tool = this.tools.get(name);
		if (tool === undefined) throw new Error(`no native tool ${name}`);
		return Promise.resolve().then(() =>
			tool.execute(input, { signal: new AbortController().signal }),
		);
	}
}

let window: Window;
let native: FakeModelContext;
const g = globalThis as Record<string, unknown>;
const saved = { Document: g["Document"], document: g["document"] };
const warn = spyOn(console, "warn").mockImplementation(() => {});
const tabs: TabMcp[] = [];
let scope = new AbortController();
/** What the page told the extension, parsed. */
let heard: Record<string, unknown>[] = [];

/** A fresh page (a reload) with native WebMCP, the extension listening. */
function newPage(): void {
	window = new Window({ url: "https://page.example/" });
	native = new FakeModelContext();
	const Doc = window.Document as unknown as { prototype: object };
	Object.defineProperty(Doc.prototype, "modelContext", {
		configurable: true,
		get: () => native,
	});
	g["Document"] = Doc;
	g["document"] = window.document;
	heard = [];
	window.document.addEventListener("tab-mcp-page", (event) =>
		heard.push(
			JSON.parse(String((event as unknown as CustomEvent<string>).detail)),
		),
	);
}

beforeEach(() => {
	newPage();
	warn.mockClear();
});

afterEach(async () => {
	scope.abort();
	scope = new AbortController();
	for (const t of tabs.splice(0)) t.disconnect();
	Object.assign(g, saved);
	await window.happyDOM.close();
});

/** A page's `TabMcp`, the mirror on by default; its tools go when the test ends. */
function tab(options: Partial<TabMcpOptions> = {}): TabMcp {
	const t = newTab("https://relay.example", options);
	const register = t.registerTool.bind(t);
	t.registerTool = (tool, opts = {}) =>
		register(tool, {
			...opts,
			signal:
				opts.signal === undefined
					? scope.signal
					: AbortSignal.any([opts.signal, scope.signal]),
		});
	tabs.push(t);
	return t;
}

/** The extension says `message` (a JSON string as `detail`, as it sends it). */
function tell(message: unknown): void {
	window.document.dispatchEvent(
		new window.CustomEvent("tab-mcp-extension", {
			// happy-dom types `detail` as an object; the extension sends a string.
			detail: (typeof message === "string"
				? message
				: JSON.stringify(message)) as unknown as object,
		}),
	);
}

/** The mirror's chunk loads a moment after the `TabMcp` is made. */
const settle = () => Bun.sleep(5);

const CLAUDE = { name: "Claude", host: "claude.ai" };
const ON = {
	v: 1,
	type: "update",
	name: "tab-mcp browser extension",
	on: true,
	whileInFront: true,
	apps: [CLAUDE],
};

/** A consequential tool offered to agents in the browser too. */
const complete = {
	name: "complete_todo",
	description: "Marks a todo as done",
	inputSchema: {
		type: "object",
		properties: { id: { type: "number" }, note: { type: "string" } },
		required: ["id"],
	},
	annotations: { consequentialHint: true },
	execute: ({ id }: Record<string, unknown>) => `done ${id}`,
};
const callers = { callers: ["relay", "webmcp"] as ("relay" | "webmcp")[] };

let nonces = 0;
const vouch = (args: Record<string, unknown>, extra: object = {}) => ({
	v: 1,
	type: "vouch",
	tool: "complete_todo",
	arguments: args,
	nonce: `n${++nonces}`,
	app: CLAUDE,
	...extra,
});

/** A page with `complete_todo` mirrored; `asked` lists what `onConfirm` saw. */
async function todoPage(options: Partial<TabMcpOptions> = {}) {
	const asked: ConfirmRequest[] = [];
	const calls: ToolCallStart[] = [];
	const t = tab({
		onConfirm: (request) => {
			asked.push(request);
			return true;
		},
		...options,
	});
	t.addEventListener("toolcall", (e) => calls.push(e.detail));
	await t.registerTool(complete, callers);
	await settle();
	return { t, asked, calls };
}

describe("the announcement", () => {
	test("a page that mirrors (the default, no webmcp option) says hello once it starts and marks <html>", async () => {
		tab();
		await settle();
		expect(heard).toEqual([
			{ v: 1, type: "hello", library: VERSION, app: "test-page", apps: [] },
		]);
		expect(
			window.document.documentElement.getAttribute("data-tab-mcp-handshake"),
		).toBe("1");
	});

	test("with webmcp: false, or without WebMCP, the page says nothing and is not marked", async () => {
		const off = newTab("https://relay.example", { webmcp: false });
		tabs.push(off);
		await settle();
		delete (window.Document.prototype as { modelContext?: unknown })
			.modelContext;
		tabs.push(tab());
		await settle();
		// Nor does it answer the extension, or hear it.
		tell(ON);
		tell({ ...ON, type: "hello" });
		expect(heard).toEqual([]);
		expect(off.extension).toBeUndefined();
		expect(
			window.document.documentElement.hasAttribute("data-tab-mcp-handshake"),
		).toBe(false);
	});

	test("the extension's hello is answered with an update; its update is not", async () => {
		tab({ app: "todo" });
		await settle();
		heard = [];
		tell({ ...ON, type: "update" });
		expect(heard).toEqual([]);
		tell({ ...ON, type: "hello" });
		expect(heard).toEqual([
			{ v: 1, type: "update", library: VERSION, app: "todo", apps: [] },
		]);
	});

	test("the AI apps connected to the page directly go out as they change", async () => {
		const relay = new StubRelay();
		const grant: Grant = {
			grantId: "g1",
			client: {
				id: "https://claude.ai/oauth",
				name: "Claude",
				host: "claude.ai",
			},
			createdAt: new Date().toISOString(),
		};
		const t = newTab(relay.url);
		tabs.push(t);
		try {
			await settle();
			await t.connect({ resume: true });
			relay.send({ type: "grant.added", grant });
			await relay.settled();
			expect(heard.at(-1)).toEqual({
				v: 1,
				type: "update",
				library: VERSION,
				app: "test-page",
				apps: [CLAUDE],
			});
			// The extension asks again: the same list.
			tell({ ...ON, type: "hello" });
			expect(heard.at(-1)?.["apps"]).toEqual([CLAUDE]);
		} finally {
			t.disconnect();
			await relay.stop();
		}
	});

	test("at most 64 AI apps go out, as the extension takes no more", async () => {
		const t = tab();
		await settle();
		const grants: Grant[] = Array.from({ length: 70 }, (_, i) => ({
			grantId: `g${i}`,
			client: { id: `https://app${i}.example`, name: `App ${i}`, host: "x" },
			createdAt: new Date().toISOString(),
		}));
		Object.defineProperty(t, "grants", { value: grants });
		t.dispatchEvent(new CustomEvent("grantschange", { detail: { grants } }));
		const apps = heard.at(-1)?.["apps"] as unknown[];
		expect(apps).toHaveLength(64);
		expect(apps[63]).toEqual({ name: "App 63", host: "x" });
	});

	test("in a frame the page takes no part (the extension speaks to the top frame only)", async () => {
		const top = g["top"];
		g["top"] = {};
		try {
			tab();
			await settle();
			expect(heard).toEqual([]);
		} finally {
			g["top"] = top;
		}
	});
});

describe("the extension's state", () => {
	test("extension and extensionchange: on with its apps, the same again is no change, off is undefined", async () => {
		const t = tab();
		const changes: (BrowserExtension | undefined)[] = [];
		t.addEventListener("extensionchange", (e) =>
			changes.push(e.detail.extension),
		);
		await settle();
		expect(t.extension).toBeUndefined();
		tell(ON);
		const expected = {
			name: "tab-mcp browser extension",
			apps: [CLAUDE],
			whileInFront: true,
		};
		expect(t.extension).toEqual(expected);
		expect(Object.isFrozen(t.extension)).toBe(true);
		expect(Object.isFrozen(t.extension?.apps[0])).toBe(true);
		tell({ ...ON, type: "hello" });
		expect(changes).toEqual([expected]);
		tell({ ...ON, apps: [] });
		expect(t.extension?.apps).toEqual([]);
		tell({ v: 1, type: "update", on: false });
		expect(t.extension).toBeUndefined();
		expect(changes).toHaveLength(3);
	});

	test("the extension tells no version (DEC-221); one an older extension sends is not kept", async () => {
		const t = tab();
		await settle();
		tell(ON);
		expect(t.extension?.apps).toEqual([CLAUDE]);
		tell({ v: 1, type: "update", on: false });
		// The tab-mcp browser extension 0.3.2 and older: with its version.
		tell({ ...ON, version: "0.3.2" });
		expect(t.extension).toEqual({
			name: "tab-mcp browser extension",
			apps: [CLAUDE],
			whileInFront: true,
		});
		expect(t.extension).not.toHaveProperty("version");
	});

	test("a TabMcp made after the extension spoke knows it at once", async () => {
		tab();
		await settle();
		tell(ON);
		const later = tab({ server: { name: "Later", version: "1" } });
		await settle();
		expect(later.extension?.apps).toEqual([CLAUDE]);
	});

	test("malformed messages, other versions and unknown types are ignored; unknown fields too", async () => {
		const t = tab();
		await settle();
		tell({ ...ON, extra: { anything: true } });
		expect(t.extension?.apps).toEqual([CLAUDE]);
		const before = t.extension;
		for (const bad of [
			"{not json",
			{ ...ON, v: 2, on: false },
			{ ...ON, v: "1", on: false },
			{ ...ON, type: "goodbye", on: false },
			{ ...ON, on: "no" },
			{ ...ON, apps: "Claude" },
			{ ...ON, apps: [{ name: "Claude" }] },
			{ ...ON, apps: [{ name: 1, host: "claude.ai" }] },
			{ ...ON, name: 7 },
			[ON],
			null,
		])
			tell(bad);
		// An object as `detail`, not a string: what does not cross worlds.
		window.document.dispatchEvent(
			new window.CustomEvent("tab-mcp-extension", {
				detail: { ...ON, on: false },
			}),
		);
		expect(t.extension).toBe(before);
	});

	test("reported also with trustExtension: false", async () => {
		const t = tab({ trustExtension: false });
		await settle();
		tell(ON);
		expect(t.extension?.apps).toEqual([CLAUDE]);
	});
});

describe("the vouch", () => {
	test("a vouched call runs without the page's question or onConfirm, and names the AI app", async () => {
		const { asked, calls } = await todoPage();
		tell(vouch({ id: 3 }));
		await expect(native.call("complete_todo", { id: 3 })).resolves.toBe(
			"done 3",
		);
		expect(asked).toEqual([]);
		expect(calls.map((c) => c.client)).toEqual([
			{
				kind: "webmcp",
				via: "tab-mcp-extension",
				name: "Claude",
				host: "claude.ai",
			},
		]);
	});

	test("a call that matches no vouch is asked as today: other arguments, another tool, no vouch", async () => {
		const { t, asked, calls } = await todoPage();
		await t.registerTool({ ...complete, name: "other" }, callers);
		await settle();
		tell(vouch({ id: 3 }));
		await native.call("complete_todo", { id: 4 });
		await native.call("other", { id: 3 });
		expect(asked.map((r) => r.arguments)).toEqual([{ id: 4 }, { id: 3 }]);
		expect(asked.every((r) => r.client.kind === "webmcp")).toBe(true);
		expect(calls.map((c) => c.client)).toEqual([
			{ kind: "webmcp" },
			{ kind: "webmcp" },
		]);
		// The vouch for id 3 is still there for its own call.
		await native.call("complete_todo", { id: 3 });
		expect(asked).toHaveLength(2);
	});

	test("a vouch is used once: the same call twice with one vouch asks the second time", async () => {
		const { asked } = await todoPage();
		tell(vouch({ id: 3 }));
		await native.call("complete_todo", { id: 3 });
		await native.call("complete_todo", { id: 3 });
		expect(asked).toHaveLength(1);
	});

	test("the same tool with equal arguments twice, each vouched: neither asks", async () => {
		const { asked } = await todoPage();
		tell(vouch({ id: 3 }));
		tell(vouch({ id: 3 }));
		await Promise.all([
			native.call("complete_todo", { id: 3 }),
			native.call("complete_todo", { id: 3 }),
		]);
		expect(asked).toEqual([]);
	});

	test("two calls at once with other arguments: each takes its own vouch", async () => {
		const { asked, calls } = await todoPage();
		tell(vouch({ id: 1 }));
		tell(vouch({ id: 2 }, { app: { name: "Codex", host: "openai.com" } }));
		const results = await Promise.all([
			native.call("complete_todo", { id: 2 }),
			native.call("complete_todo", { id: 1 }),
		]);
		expect(results).toEqual(["done 2", "done 1"]);
		expect(asked).toEqual([]);
		expect(
			calls.map((c) => [
				c.arguments["id"],
				(c.client as { host?: string }).host,
			]),
		).toEqual([
			[2, "openai.com"],
			[1, "claude.ai"],
		]);
	});

	test("the same vouch heard twice (its nonce) counts once", async () => {
		const { asked } = await todoPage();
		const once = vouch({ id: 3 });
		tell(once);
		tell(once);
		await native.call("complete_todo", { id: 3 });
		await native.call("complete_todo", { id: 3 });
		expect(asked).toHaveLength(1);
	});

	test("equal arguments in another key order match; other nested values do not", async () => {
		const { asked } = await todoPage();
		tell(vouch({ note: "x", id: 3 }));
		await native.call("complete_todo", { id: 3, note: "x" });
		expect(asked).toHaveLength(0);
		tell(vouch({ id: 3, note: "x" }));
		await native.call("complete_todo", { id: 3, note: "y" });
		expect(asked).toHaveLength(1);
	});

	test(`a call after its vouch expired (${VOUCH_MS} ms) is asked; a vouch never used is dropped`, async () => {
		const { asked } = await todoPage();
		let now = 1_000;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		try {
			tell(vouch({ id: 3 }));
			now += VOUCH_MS + 1;
			await native.call("complete_todo", { id: 3 });
			expect(asked).toHaveLength(1);
			// Just within the time: taken.
			tell(vouch({ id: 5 }));
			now += VOUCH_MS;
			await native.call("complete_todo", { id: 5 });
			expect(asked).toHaveLength(1);
		} finally {
			clock.mockRestore();
		}
	});

	test("a tool registered anew after the vouch does not get it (the page changed it meanwhile)", async () => {
		const { t, asked } = await todoPage();
		tell(vouch({ id: 3 }));
		scope.abort();
		scope = new AbortController();
		await t.registerTool(
			{ ...complete, description: "Deletes the todo instead" },
			callers,
		);
		await settle();
		await native.call("complete_todo", { id: 3 });
		expect(asked).toHaveLength(1);
		expect(asked[0]?.tool.description).toBe("Deletes the todo instead");
	});

	test("a vouch for a tool the page does not have (unregistered) is dropped", async () => {
		const { t, asked } = await todoPage();
		scope.abort();
		scope = new AbortController();
		tell(vouch({ id: 3 }));
		await t.registerTool(complete, callers);
		await settle();
		await native.call("complete_todo", { id: 3 });
		expect(asked).toHaveLength(1);
	});

	test("trustExtension: false asks every call, vouched or not", async () => {
		const { asked, calls } = await todoPage({ trustExtension: false });
		tell(vouch({ id: 3 }));
		await native.call("complete_todo", { id: 3 });
		expect(asked).toHaveLength(1);
		expect(calls[0]?.client).toEqual({ kind: "webmcp" });
	});

	test("a withdrawn vouch is dropped: the equal call that comes after is asked", async () => {
		const { asked } = await todoPage();
		const once = vouch({ id: 3 });
		tell(once);
		tell({ v: 1, type: "withdraw", nonce: once.nonce });
		await native.call("complete_todo", { id: 3 });
		expect(asked).toHaveLength(1);
	});

	test("a withdrawal drops only its own vouch; one for a vouch used, unknown or malformed changes nothing", async () => {
		const { asked } = await todoPage();
		const used = vouch({ id: 1 });
		tell(used);
		await native.call("complete_todo", { id: 1 });
		const kept = vouch({ id: 1 });
		const other = vouch({ id: 2 });
		tell(kept);
		tell(other);
		tell({ v: 1, type: "withdraw", nonce: used.nonce });
		tell({ v: 1, type: "withdraw", nonce: "unknown" });
		tell({ v: 1, type: "withdraw", nonce: 7 });
		tell({ v: 1, type: "withdraw" });
		tell({ v: 2, type: "withdraw", nonce: kept.nonce });
		tell({ v: 1, type: "withdraw", nonce: other.nonce });
		await native.call("complete_todo", { id: 1 });
		expect(asked).toHaveLength(0);
		await native.call("complete_todo", { id: 2 });
		expect(asked).toHaveLength(1);
	});

	test("a malformed vouch is ignored", async () => {
		const { asked } = await todoPage();
		for (const bad of [
			vouch({ id: 3 }, { app: { name: "Claude" } }),
			vouch({ id: 3 }, { tool: 7 }),
			vouch({ id: 3 }, { nonce: undefined }),
			{ ...vouch({}), arguments: [3] },
			vouch({ id: 3 }, { v: 2 }),
		])
			tell(bad);
		await native.call("complete_todo", { id: 3 });
		expect(asked).toHaveLength(1);
	});

	test("a page that reloads between vouch and call asks: the vouch was the old page's", async () => {
		await todoPage();
		tell(vouch({ id: 3 }));
		newPage();
		const { asked } = await todoPage();
		await native.call("complete_todo", { id: 3 });
		expect(asked).toHaveLength(1);
	});

	test("a vouched call still checks its arguments and runs only the tool that is registered", async () => {
		const { asked, calls } = await todoPage();
		tell(vouch({ id: "three" }));
		await expect(
			native.call("complete_todo", { id: "three" }),
		).resolves.toMatchObject({ error: expect.stringContaining("Invalid") });
		expect(asked).toEqual([]);
		expect(calls).toHaveLength(1);
	});
});

describe("the connect dialog", () => {
	test("says first which AI apps are connected through the extension; connecting here stays as it was", async () => {
		const relay = new StubRelay();
		const t = newTab(relay.url);
		tabs.push(t);
		const doc = window.document as unknown as Document;
		try {
			await settle();
			tell({ ...ON, apps: [CLAUDE, { name: "Codex", host: "openai.com" }] });
			const connecting = t.connect({ resume: true });
			const closed = showConnectDialog(t, connecting, doc);
			const session = await connecting;
			await relay.next("pairing.start");
			const dialog = doc.querySelector(
				"dialog.tab-mcp-connect",
			) as HTMLDialogElement;
			const via = dialog.querySelector(".tab-mcp-via-extension") as HTMLElement;
			expect(via.hidden).toBe(false);
			expect(via.textContent).toBe(
				"Claude (claude.ai) and Codex (openai.com) are connected through the tab-mcp browser extension, while this tab is in front.",
			);
			// Before everything else the dialog says.
			const status = dialog.querySelector(".tab-mcp-status") as HTMLElement;
			expect(
				via.compareDocumentPosition(status) &
					window.Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			// The address and the code are still there, for a phone or another browser.
			expect((dialog.querySelector("input") as HTMLInputElement).value).toBe(
				session.address,
			);
			tell({ ...ON, apps: [CLAUDE], whileInFront: false });
			expect(via.textContent).toBe(
				"Claude (claude.ai) is connected through the tab-mcp browser extension.",
			);
			tell({ ...ON, apps: [] });
			expect(via.hidden).toBe(true);
			tell({ ...ON });
			tell({ v: 1, type: "update", on: false });
			expect(via.hidden).toBe(true);
			dialog.close();
			await closed;
		} finally {
			t.disconnect();
			await relay.stop();
		}
	});
});

test("canonical: the keys of every object sorted, arrays in their order", () => {
	expect(canonical({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } })).toBe(
		'{"a":{"c":null,"d":[2,{"x":0,"y":1}]},"b":1}',
	);
	expect(canonical([2, 1])).not.toBe(canonical([1, 2]));
});
