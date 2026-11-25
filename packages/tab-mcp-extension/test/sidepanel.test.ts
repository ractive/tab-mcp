/**
 * The side panel's page itself (`sidepanel/main.ts`, `index.html`) in
 * happy-dom, with a fake Chrome: what it draws from the worker's state,
 * what its clicks send, and the waits that keep a click from counting
 * (EQ 11). The end-to-end tests asked this of a real Chrome where only
 * this code decided (iteration 50). The dialog's being modal (`:modal`,
 * the rest inert) is Chrome's: extension.browser.test.ts "a question in the
 * panel of the tab's focused window sends no notification" checks it; here,
 * that the panel shows it with `showModal()` (happy-dom has no `:modal`).
 */

import {
	afterAll,
	afterEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import type {
	CallView,
	PanelCommand,
	PanelState,
	QuestionSummary,
	ToolView,
	WorkerMessage,
} from "../src/protocol.ts";
import {
	ARGS_LINE,
	CALLS_EMPTY,
	CALLS_NOTE,
	CallsView,
	displayWidth,
	MAX_SHOWN,
	summaryText,
} from "../src/sidepanel/calls.ts";

const SITE = "https://shop.example";
/** The panel's waits (main.ts `ALLOW_DELAY_MS`), and a bit. */
const WAIT_MS = 750;

const GLOBALS = [
	"document",
	"HTMLElement",
	"HTMLInputElement",
	"HTMLDialogElement",
	"HTMLButtonElement",
	"HTMLLIElement",
	"CSS",
	"Event",
	"KeyboardEvent",
	"MouseEvent",
	"navigator",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"requestAnimationFrame",
	"cancelAnimationFrame",
] as const;

const g = globalThis as Record<string, unknown>;
const saved = new Map<string, unknown>(
	[...GLOBALS, "window", "chrome"].map((k) => [k, g[k]]),
);
const windows: Window[] = [];
afterEach(async () => {
	setSystemTime();
	for (const win of windows.splice(0)) await win.happyDOM.close();
	for (const [key, value] of saved) g[key] = value;
});

/**
 * main.ts as the Firefox build has it (`TAB_MCP_FIREFOX` true: its words,
 * its sidebar, its server name), bundled once into a folder of its own,
 * removed after the file's tests.
 */
let firefoxMain: Promise<string> | undefined;
let firefoxDir: string | undefined;
function firefoxBundle(): Promise<string> {
	firefoxMain ??= (async () => {
		const result = await Bun.build({
			entrypoints: [join(import.meta.dir, "../src/sidepanel/main.ts")],
			target: "browser",
			format: "esm",
			define: { TAB_MCP_TEST: "true", TAB_MCP_FIREFOX: "true" },
		});
		const [output] = result.outputs;
		if (!result.success || output === undefined)
			throw new Error(`the Firefox panel did not build: ${result.logs}`);
		firefoxDir = mkdtempSync(join(tmpdir(), "tab-mcp-firefox-panel-"));
		const file = join(firefoxDir, "main.js");
		await Bun.write(file, await output.text());
		return file;
	})();
	return firefoxMain;
}
afterAll(() => {
	if (firefoxDir !== undefined)
		rmSync(firefoxDir, { recursive: true, force: true });
});

/**
 * A panel of its own: index.html in a new window, main.ts loaded anew in
 * it, its timers the window's (closed with it). `show` gives it a state as
 * the worker's port would.
 */
async function openPanel(options: { firefox?: boolean } = {}) {
	const win = new Window({
		url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel/index.html",
	});
	windows.push(win);
	win.document.write(
		await Bun.file(join(import.meta.dir, "../src/sidepanel/index.html")).text(),
	);
	const sent: PanelCommand[] = [];
	let deliver: (message: unknown) => void = () => {};
	let dropped: () => void = () => {};
	const port = {
		postMessage: (m: PanelCommand) => void sent.push(m),
		onMessage: {
			addListener: (l: (m: unknown) => void) => {
				deliver = l;
			},
		},
		onDisconnect: {
			addListener: (l: () => void) => {
				dropped = l;
			},
		},
		disconnect: () => {},
	};
	for (const key of GLOBALS) {
		const value = (win as unknown as Record<string, unknown>)[key];
		g[key] =
			typeof value === "function" && /^[a-z]/.test(key)
				? (value as (...a: unknown[]) => unknown).bind(win)
				: value;
	}
	g["window"] = win;
	g["chrome"] = {
		windows: { getCurrent: async () => ({ id: 1 }) },
		runtime: {
			connect: () => port,
			getURL: (path: string) =>
				`chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
		},
		permissions: {
			contains: async () => true,
			request: async () => true,
			remove: async () => true,
			onAdded: { addListener: () => {} },
			onRemoved: { addListener: () => {} },
		},
	};
	await import(
		`${options.firefox ? await firefoxBundle() : "../src/sidepanel/main.ts"}?panel=${windows.length}-${Date.now()}`
	);
	const doc = win.document as unknown as Document;
	const panel = {
		doc,
		sent,
		show: (state: PanelState) => deliver({ type: "state", state }),
		/** Any other message of the worker's. */
		post: (message: WorkerMessage) => deliver(message),
		/** Chrome ends the port (the worker stopped, an update, a reload). */
		drop: () => dropped(),
		/** The clock `ms` on, and the panel's own check of its waits run. */
		later: (ms: number) => {
			setSystemTime(Date.now() + ms);
			win.dispatchEvent(new win.Event("focus"));
		},
		$: <T extends HTMLElement = HTMLElement>(selector: string) =>
			doc.querySelector(selector) as T | null,
		/** The commands sent since the last call. */
		take: () => sent.splice(0),
		/** The next animation frame drawn (the panel's own, asked for before, first). */
		frame: () =>
			new Promise<void>((resolve) =>
				win.requestAnimationFrame(() => resolve()),
			),
	};
	return panel;
}

const tool = (name: string, allowed = false): ToolView => ({
	name,
	readOnly: false,
	allowed,
});

/** The worker's state with the tab of `SITE` and its tools. */
function stateWith(
	tools: ToolView[],
	questions: QuestionSummary[] = [],
): PanelState {
	return {
		relay: "https://relay.example",
		status: "on",
		grants: [{ grantId: "g1", name: "Claude", host: "claude.ai" }],
		pairing: false,
		calling: false,
		recentCalls: 0,
		allSites: true,
		questions,
		expired: [],
		tab: {
			title: "Shop",
			host: "shop.example",
			access: "",
			origin: SITE,
			webmcp: { available: true, tools: tools.length },
			tools,
			canAllow: true,
		},
	};
}

const question = (id: string): QuestionSummary => ({
	id,
	app: "Claude (claude.ai)",
	host: "claude.ai",
	tool: "page_place_order",
	title: "place_order",
	origin: SITE,
	site: true,
	expiresAt: Date.now() + 60_000,
});

const switchOf = (name: string) => `input.always-allow[data-tool="${name}"]`;
const allowOf = (id: string) =>
	`[data-question="${id}"] button[data-answer="allow"]`;
const disabled = (e: Element | null) => e?.getAttribute("aria-disabled");

describe("Recent calls (DEC-226)", () => {
	const call = (id: number, more: Partial<CallView> = {}): CallView => ({
		id,
		at: Date.UTC(2026, 10, 24, 9, 30, id),
		app: "Claude",
		host: "claude.ai",
		tool: "page_get_greeting",
		args: '{"name":"Ada"}',
		state: "ok",
		...more,
	});

	async function opened() {
		const panel = await openPanel();
		panel.show({ ...stateWith([]), recentCalls: 2 });
		const section = panel.$<HTMLDetailsElement>("#calls");
		if (section === null) throw new Error("no #calls");
		// happy-dom fires `toggle` as the attribute changes (a browser, a task later).
		const toggle = (open: boolean) => {
			section.open = open;
		};
		const rows = () =>
			[...panel.doc.querySelectorAll("#calls-list > li")].map((li) =>
				[...li.children].map((e) => e.textContent),
			);
		const summary = () => panel.$("#calls-summary")?.textContent;
		return { panel, section, toggle, rows, summary };
	}

	test("closed at first, its count from the state, nothing asked for until it opens", async () => {
		const { panel, section, summary } = await opened();
		expect(section.open).toBe(false);
		expect(summary()).toBe(summaryText(2));
		expect(panel.sent.some((c) => c.type === "calls")).toBe(false);
		expect(panel.$("#calls-note")?.textContent).toBe(CALLS_NOTE);
		expect(panel.$("#calls-empty")?.textContent).toBe(CALLS_EMPTY);
		// A list, no live region: the calls are not read out as they come.
		expect(panel.$("#calls-list")?.tagName).toBe("OL");
		expect(
			panel.doc.querySelectorAll(
				"#calls [aria-live], #calls [role=status], #calls [role=alert]",
			),
		).toHaveLength(0);
	});

	test("opened: it asks for the list, shows it newest first, follows each change, and stops asking once closed", async () => {
		const { panel, toggle, rows, summary } = await opened();
		toggle(true);
		expect(panel.take().filter((c) => c.type === "calls")).toEqual([
			{ type: "calls", open: true },
		]);
		panel.post({
			type: "calls",
			calls: [
				call(1),
				call(2, {
					tool: "page_place_order",
					args: '{"item":"tea"}',
					site: "https://shop.example",
					state: "declined",
				}),
			],
		});
		const time = (id: number) =>
			new Date(Date.UTC(2026, 10, 24, 9, 30, id)).toLocaleTimeString(
				undefined,
				{ hour: "2-digit", minute: "2-digit", second: "2-digit" },
			);
		expect(rows()).toEqual([
			[
				`page_place_order${time(2)}`,
				"Declined by you",
				"Claude claude.ai · on shop.example",
				'{"item":"tea"}',
			],
			[
				`page_get_greeting${time(1)}`,
				"Ran",
				"Claude claude.ai",
				'{"name":"Ada"}',
			],
		]);
		// The AI app as the AI access card lists it: its name, then its host.
		expect(
			[...(panel.$("#calls-list li .call-who")?.children ?? [])].map((e) => [
				e.className,
				e.textContent,
			]),
		).toEqual([
			["call-app", "Claude"],
			["call-host", "claude.ai"],
		]);
		expect(panel.$("#calls-empty")?.hidden).toBe(true);
		// A new call, running, then waiting, then allowed and done.
		panel.post({ type: "call", call: call(3, { state: "running" }) });
		await panel.frame();
		expect(rows()[0]?.[1]).toBe("Running");
		expect(summary()).toBe(summaryText(3));
		panel.post({ type: "call", call: call(3, { state: "waiting" }) });
		await panel.frame();
		expect(rows()[0]?.[1]).toBe("Waiting for your answer");
		panel.post({ type: "call", call: call(3, { allowed: "once" }) });
		await panel.frame();
		expect(rows()[0]?.[1]).toBe("Allowed by you · Ran");
		expect(rows()).toHaveLength(3);
		// A state that comes meanwhile changes neither list nor count.
		panel.show({ ...stateWith([]), recentCalls: 3 });
		expect(rows()).toHaveLength(3);
		toggle(false);
		expect(panel.take().filter((c) => c.type === "calls")).toEqual([
			{ type: "calls", open: false },
		]);
	});

	test("each outcome in words", async () => {
		const { panel, toggle, rows } = await opened();
		toggle(true);
		const outcomes: [Partial<CallView>, string][] = [
			[
				{ state: "failed", error: "The page's tool threw." },
				"Failed: The page's tool threw.",
			],
			[
				{ state: "failed", allowed: "always", error: "x" },
				"Always allowed · Failed: x",
			],
			[{ state: "unanswered" }, "Not answered in time"],
			[{ state: "cancelled" }, "Cancelled by the AI app"],
			[{ state: "timeout" }, "The page did not answer in time"],
			[{ state: "ok", allowed: "always" }, "Always allowed · Ran"],
			[{ state: "ok", app: "" }, "Ran"],
		];
		panel.post({
			type: "calls",
			calls: outcomes.map(([more], i) => call(i + 1, more)),
		});
		expect(rows().map((r) => r[1])).toEqual(
			outcomes.map(([, words]) => words).reverse(),
		);
		// No name of its own: the verified host alone.
		expect(rows()[0]?.[2]).toBe("claude.ai");
	});

	test("empty: the line says so; at most 100 shown; other people's text stays text", async () => {
		const { panel, toggle, rows } = await opened();
		toggle(true);
		panel.post({ type: "calls", calls: [] });
		expect(panel.$("#calls-empty")?.hidden).toBe(false);
		expect(panel.$("#calls-list")?.hidden).toBe(true);
		panel.post({
			type: "calls",
			calls: Array.from({ length: MAX_SHOWN + 3 }, (_, i) => call(i + 1)),
		});
		expect(rows()).toHaveLength(MAX_SHOWN);
		panel.post({
			type: "call",
			call: call(500, {
				tool: "<b>bold</b>",
				app: '<img src=x onerror="alert(1)">',
				args: '{"html":"<script>alert(1)</script>"}',
			}),
		});
		await panel.frame();
		expect(rows()).toHaveLength(MAX_SHOWN);
		// The newest at the top, the oldest gone.
		expect(panel.$("#calls-list > li")?.dataset["call"]).toBe("500");
		expect(panel.$("#calls-list > li:last-child")?.dataset["call"]).toBe("5");
		const first = panel.doc.querySelector("#calls-list > li");
		expect(first?.querySelectorAll("b, img, script")).toHaveLength(0);
		expect(rows()[0]?.[3]).toBe('{"html":"<script>alert(1)</script>"}');
		// Nothing in a `title`: a line longer than ARGS_LINE unfolds instead.
		expect(panel.doc.querySelectorAll("#calls [title]")).toHaveLength(0);
	});

	test("arguments wider than a line unfold, and stay unfolded, with the focus, as other calls change and come", async () => {
		const { panel, toggle } = await opened();
		toggle(true);
		const long = `{"item":"${"t".repeat(ARGS_LINE)}"}`;
		// The reviewer's: 30 code units, but its characters take two columns.
		const cjk = '{"q":"東京都千代田区丸の内一丁目九番一号東京駅"}';
		expect(cjk.length).toBeLessThanOrEqual(ARGS_LINE);
		expect(displayWidth(cjk)).toBeGreaterThan(ARGS_LINE);
		expect(displayWidth("🙂a")).toBe(3);
		panel.post({
			type: "calls",
			calls: [
				call(1),
				call(2, { args: long, state: "running" }),
				call(3, { args: cjk }),
			],
		});
		const args = (id: number) =>
			panel.$(`#calls-list li[data-call="${id}"] .call-args`);
		// Short: a line of code, nothing to unfold.
		expect(args(1)?.tagName).toBe("CODE");
		expect(args(2)?.tagName).toBe("DETAILS");
		expect(args(3)?.tagName).toBe("DETAILS");
		expect(args(2)?.querySelector("summary code")?.textContent).toBe(long);
		const row = panel.$('#calls-list li[data-call="2"]');
		const unfolded = args(2) as HTMLDetailsElement;
		unfolded.open = true;
		const summary = unfolded.querySelector<HTMLElement>("summary");
		summary?.focus();
		// Another call changes, a new one comes, then this one ends.
		panel.post({ type: "call", call: call(1, { state: "failed" }) });
		panel.post({ type: "call", call: call(4, { state: "running" }) });
		await panel.frame();
		panel.post({ type: "call", call: call(2, { args: long, state: "ok" }) });
		await panel.frame();
		expect(row?.getAttribute("data-state")).toBe("ok");
		// The same nodes, not new ones: open and focused as the user left them.
		expect(panel.$('#calls-list li[data-call="2"]')).toBe(row);
		expect(args(2)).toBe(unfolded);
		expect(unfolded.open).toBe(true);
		expect(panel.doc.activeElement).toBe(summary);
		expect(
			[...panel.doc.querySelectorAll("#calls-list > li")].map(
				(li) => (li as HTMLElement).dataset["call"],
			),
		).toEqual(["4", "3", "2", "1"]);
	});

	test("a burst of changes is drawn once, in the next frame", () => {
		const win = new Window();
		windows.push(win);
		const doc = win.document as unknown as Document;
		const list = doc.createElement("ol");
		const empty = doc.createElement("p");
		const frames: (() => void)[] = [];
		let drawn = 0;
		const view = new CallsView(list, empty, {
			schedule: (draw) => frames.push(draw),
			drawn: () => drawn++,
		});
		for (let id = 1; id <= 20; id++)
			for (const state of ["running", "waiting", "ok"] as const)
				view.put(call(id, { state }));
		expect([frames.length, view.draws, list.children.length]).toEqual([
			1, 0, 0,
		]);
		frames.shift()?.();
		expect([view.draws, drawn, view.count]).toEqual([1, 1, 20]);
		expect((list.firstElementChild as HTMLElement).dataset["call"]).toBe("20");
		expect(
			[...list.children].every(
				(li) => (li as HTMLElement).dataset["state"] === "ok",
			),
		).toBe(true);
		expect(frames).toEqual([]);
	});
});

describe("the glow while an AI app calls (DEC-225)", () => {
	/** Every text and `aria-*` or `role` value of the panel. */
	const spoken = (doc: Document) => ({
		text: doc.body.textContent,
		aria: [...doc.querySelectorAll("*")].flatMap((e) =>
			[...e.attributes]
				.filter((a) => a.name.startsWith("aria-") || a.name === "role")
				.map((a) => `${e.id || e.tagName}:${a.name}=${a.value}`),
		),
	});

	test("on the AI access switch's label, a style alone; gone at once with the connection", async () => {
		const panel = await openPanel();
		const glows = () =>
			panel.$("#ai-switch")?.closest(".switch")?.hasAttribute("data-calling");
		panel.show(stateWith([]));
		expect(glows()).toBe(false);
		const before = spoken(panel.doc);
		panel.show({ ...stateWith([]), calling: true });
		expect(glows()).toBe(true);
		// Only the label's attribute: no text, name or aria-* value changed.
		expect(spoken(panel.doc)).toEqual(before);
		expect(panel.doc.querySelectorAll("[data-calling]")).toHaveLength(1);
		expect(panel.$(".card-head .switch")?.hasAttribute("data-calling")).toBe(
			true,
		);
		// The relay's connection lost: no hold.
		panel.show({ ...stateWith([]), status: "retrying", calling: true });
		expect(glows()).toBe(false);
	});

	test("gone at once when the port to the worker goes (an update, a reload), back with a state that says a call runs", async () => {
		const panel = await openPanel();
		const glows = () =>
			panel.$("#ai-switch")?.closest(".switch")?.hasAttribute("data-calling");
		panel.show({ ...stateWith([]), calling: true });
		expect(glows()).toBe(true);
		panel.drop();
		expect(glows()).toBe(false);
		// The worker restarted and a call still runs.
		panel.show({ ...stateWith([]), calling: true });
		expect(glows()).toBe(true);
	});
});

describe("a tool's Always allow switch", () => {
	test("drawn from the worker's state: on where the site's tool is allowed (EQ 10)", async () => {
		const panel = await openPanel();
		panel.show(stateWith([tool("place_order", true), tool("pay")]));
		expect(panel.$<HTMLInputElement>(switchOf("place_order"))?.checked).toBe(
			true,
		);
		expect(panel.$<HTMLInputElement>(switchOf("pay"))?.checked).toBe(false);
	});

	test("a switch with a label that stays; a click sends it for the site, and the focus stays on it when the list is drawn anew (EQ 11)", async () => {
		const panel = await openPanel();
		panel.show(stateWith([tool("place_order")]));
		panel.later(WAIT_MS);
		const toggle = panel.$<HTMLInputElement>(switchOf("place_order"));
		expect([
			toggle?.type,
			toggle?.getAttribute("role"),
			toggle?.getAttribute("aria-label"),
			toggle?.checked,
		]).toEqual(["checkbox", "switch", "Always allow: place_order", false]);
		panel.take();
		toggle?.focus();
		toggle?.click();
		expect(panel.take()).toEqual([
			{ type: "set-allowed", origin: SITE, name: "place_order", on: true },
		]);
		// The worker's state draws the list anew: a new element, on, focused.
		panel.show(stateWith([tool("place_order", true)]));
		const drawn = panel.$<HTMLInputElement>(switchOf("place_order"));
		expect(drawn).not.toBe(toggle);
		expect(drawn?.checked).toBe(true);
		expect(drawn?.getAttribute("aria-label")).toBe("Always allow: place_order");
		expect(panel.doc.activeElement).toBe(drawn);
		// Switched back: sent off.
		drawn?.click();
		expect(panel.take()).toEqual([
			{ type: "set-allowed", origin: SITE, name: "place_order", on: false },
		]);
	});
});

describe("Always allow all, a switch over the list", () => {
	test("on allows the tools listed at the click; changed under the pointer it waits and allows nothing; off asks again", async () => {
		const panel = await openPanel();
		const head = () => panel.$<HTMLInputElement>("#allow-tools");
		// The page's tools read, none yet; then the page registers one.
		panel.show(stateWith([]));
		panel.later(WAIT_MS);
		panel.show(stateWith([tool("place_order")]));
		// The switch just came: it waits, as a click meant for what was there
		// before would land on it.
		expect(disabled(head())).toBe("true");
		panel.later(WAIT_MS);
		expect(head()?.getAttribute("role")).toBe("switch");
		expect(head()?.checked).toBe(false);
		expect(disabled(head())).toBeNull();
		panel.take();
		head()?.click();
		expect(panel.take()).toEqual([
			{
				type: "set-allowed-all",
				origin: SITE,
				names: ["place_order"],
				on: true,
			},
		]);
		panel.show(stateWith([tool("place_order", true)]));
		expect(head()?.checked).toBe(true);
		// The page registers another tool: off again, one more tool listed.
		// A click right then (meant to turn it off) allows nothing.
		panel.show(stateWith([tool("place_order", true), tool("late_order")]));
		expect(head()?.checked).toBe(false);
		expect(head()?.getAttribute("aria-label")).toBe(
			`Always allow all: the 2 tools listed on ${SITE}, for every connected AI app`,
		);
		expect(disabled(head())).toBe("true");
		// Not `disabled`: it stays in the tab order (EQ 11).
		expect(head()?.disabled).toBe(false);
		head()?.click();
		expect(panel.take()).toEqual([]);
		// After the wait, a click allows the rest.
		panel.later(WAIT_MS);
		head()?.click();
		expect(panel.take()).toEqual([
			{
				type: "set-allowed-all",
				origin: SITE,
				names: ["place_order", "late_order"],
				on: true,
			},
		]);
		// All allowed: on; a click asks for all again.
		panel.show(
			stateWith([tool("place_order", true), tool("late_order", true)]),
		);
		expect(head()?.checked).toBe(true);
		head()?.click();
		expect(panel.take()).toEqual([
			{
				type: "set-allowed-all",
				origin: SITE,
				names: ["place_order", "late_order"],
				on: false,
			},
		]);
	});
});

describe("a switch to another tab", () => {
	/** `state` as the worker sends it for the tab with Chrome's id `tabId`. */
	const onTab = (tabId: number, state: PanelState, read = true): PanelState => {
		const tab = { ...state.tab, tabId } as NonNullable<PanelState["tab"]>;
		if (!read) delete tab.origin;
		return { ...state, tab };
	};
	const quietNow = (panel: { doc: Document }) =>
		panel.doc.body.hasAttribute("data-quiet");

	test("its list shows at once whether a tool is allowed and waits unseen; the page's own change waits in the disabled look", async () => {
		const panel = await openPanel();
		const head = () => panel.$<HTMLInputElement>("#allow-tools");
		// The panel opens on a tab: the list waits, unseen.
		panel.show(onTab(1, stateWith([tool("place_order", true)])));
		expect(panel.$<HTMLInputElement>(switchOf("place_order"))?.checked).toBe(
			true,
		);
		expect(disabled(panel.$(switchOf("place_order")))).toBeNull();
		expect(disabled(head())).toBeNull();
		expect(quietNow(panel)).toBe(true);
		panel.take();
		panel.$<HTMLInputElement>(switchOf("place_order"))?.click();
		head()?.click();
		expect(panel.take()).toEqual([]);
		panel.later(WAIT_MS);
		expect(quietNow(panel)).toBe(false);
		// Another tab comes to the front, read first without its tools, then
		// with them, however late (the page may hold its read back): unseen
		// again.
		panel.show(onTab(2, stateWith([]), false));
		panel.later(3000);
		panel.show(onTab(2, stateWith([tool("add_note", true), tool("clear")])));
		const allowed = panel.$<HTMLInputElement>(switchOf("add_note"));
		expect(allowed?.checked).toBe(true);
		expect(disabled(allowed)).toBeNull();
		expect(quietNow(panel)).toBe(true);
		panel.$<HTMLInputElement>(switchOf("clear"))?.click();
		expect(panel.take()).toEqual([]);
		panel.later(WAIT_MS);
		panel.$<HTMLInputElement>(switchOf("clear"))?.click();
		expect(panel.take()).toEqual([
			{ type: "set-allowed", origin: SITE, name: "clear", on: true },
		]);
		// The same tab's page adds a tool: the wait in the disabled look.
		panel.show(
			onTab(2, stateWith([tool("add_note", true), tool("clear"), tool("x")])),
		);
		expect(disabled(head())).toBe("true");
		expect(disabled(panel.$(switchOf("clear")))).toBe("true");
		panel.later(WAIT_MS);
		// Back to the first tab: unseen again.
		panel.show(onTab(1, stateWith([tool("place_order", true)])));
		expect(disabled(panel.$(switchOf("place_order")))).toBeNull();
		expect(quietNow(panel)).toBe(true);
	});
});

describe("questions in the panel", () => {
	test("a modal dialog; the question left after an answer waits again; a click right after the dialog closed allows nothing; the switches under it keep their look", async () => {
		const modal: string[] = [];
		const panel = await openPanel();
		const dialog = panel.$<HTMLDialogElement>(
			"#questions",
		) as HTMLDialogElement;
		const showModal = dialog.showModal.bind(dialog);
		dialog.showModal = () => {
			modal.push("showModal");
			showModal();
		};
		panel.show(stateWith([tool("place_order")]));
		panel.later(WAIT_MS);
		panel.show(stateWith([tool("place_order")], [question("q1")]));
		// Modal (the rest of the panel inert is Chrome's), over the panel.
		expect([dialog.open, modal]).toEqual([true, ["showModal"]]);
		// Nothing moved under it: the switch does not wait, also once the
		// panel's own check of its waits ran.
		panel.later(0);
		expect(disabled(panel.$(switchOf("place_order")))).toBeNull();
		panel.show(
			stateWith([tool("place_order")], [question("q1"), question("q2")]),
		);
		expect(disabled(panel.$(allowOf("q1")))).toBe("true");
		panel.later(WAIT_MS);
		expect(disabled(panel.$(allowOf("q1")))).toBeNull();
		expect(disabled(panel.$(allowOf("q2")))).toBeNull();
		panel.take();
		panel.$<HTMLButtonElement>(allowOf("q1"))?.click();
		expect(panel.take()).toEqual([
			{ type: "answer", id: "q1", answer: "allow" },
		]);
		// The question left moved up in the dialog: its Allow waits again.
		panel.show(stateWith([tool("place_order")], [question("q2")]));
		expect(disabled(panel.$(allowOf("q2")))).toBe("true");
		panel.later(WAIT_MS);
		panel
			.$<HTMLButtonElement>(`[data-question="q2"] button[data-answer="deny"]`)
			?.click();
		expect(panel.take()).toEqual([
			{ type: "answer", id: "q2", answer: "deny" },
		]);
		// The last answer closes the dialog; a click on the switch right after
		// it (the second click of a double click) changes nothing.
		panel.show(stateWith([tool("place_order")]));
		expect(dialog.open).toBe(false);
		const toggle = panel.$<HTMLInputElement>(switchOf("place_order"));
		expect(disabled(toggle)).toBeNull();
		expect(panel.doc.body.hasAttribute("data-quiet")).toBe(true);
		toggle?.click();
		expect(panel.take()).toEqual([]);
		expect(toggle?.checked).toBe(false);
		// After the quiet time it counts again.
		panel.later(WAIT_MS);
		expect(panel.doc.body.hasAttribute("data-quiet")).toBe(false);
		toggle?.click();
		expect(panel.take()).toEqual([
			{ type: "set-allowed", origin: SITE, name: "place_order", on: true },
		]);
	});
});

describe("the sign-in hosts filled in for without a question (DEC-213)", () => {
	test("Remove sends that host for the worker to forget", async () => {
		const panel = await openPanel();
		panel.show({
			...stateWith([]),
			fillCode: true,
			fillAlways: ["claude.ai", "chatgpt.com"],
		});
		const remove = panel.$<HTMLButtonElement>(
			'#fill-always-list button[data-host="claude.ai"]',
		);
		expect(remove).not.toBeNull();
		panel.take();
		remove?.click();
		expect(panel.take()).toEqual([
			{ type: "forget-fill-host", host: "claude.ai" },
		]);
	});
});

describe("a tab the extension may not read (the owner's words, iteration 51)", () => {
	/** The state of a tab it may not read, without access to all sites. */
	const unreadable = (): PanelState => ({
		...stateWith([]),
		allSites: false,
		tab: {
			title: "Shop",
			host: "shop.example",
			access: "",
			noAccess: "no-grant",
			tools: [],
			canAllow: false,
		},
	});
	const seen = (panel: Awaited<ReturnType<typeof openPanel>>) => {
		const access = panel.$("#tab-access") as HTMLElement;
		const icon = access.querySelector("img");
		return {
			access: access.textContent,
			/** What comes before the icon in the line. */
			beforeIcon: icon?.previousSibling?.textContent,
			icon: icon && {
				src: icon.getAttribute("src"),
				alt: icon.getAttribute("alt"),
				hidden: icon.getAttribute("aria-hidden"),
			},
			button: panel.$("#allow-all")?.textContent,
			shown: !(panel.$("#host-access") as HTMLElement).hidden,
			note: panel.$("#host-access-note")?.textContent,
			/** No line of its own on pinning the icon (the owner's shorter words). */
			hint: panel.$("#toolbar-hint"),
		};
	};
	const icon = {
		src: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/icons/icon-16.png",
		alt: "",
		hidden: "true",
	};

	test("Chrome: the line with the extension's icon after its words, the button, what access to all sites does", async () => {
		const panel = await openPanel();
		panel.show(unreadable());
		expect(seen(panel)).toEqual({
			access:
				"Click the tab-mcp icon in Chrome's toolbar or puzzle-piece menu to let it read this tab.",
			beforeIcon: "Click the tab-mcp icon",
			icon,
			button: "Give access to all sites",
			shown: true,
			note: "Or let it read every tab without a click. Chrome asks you first.",
			hint: null,
		});
		// The same state again leaves the line as it is (a live region).
		const line = panel.$("#tab-access")?.firstChild;
		panel.show(unreadable());
		expect(panel.$("#tab-access")?.firstChild).toBe(line as ChildNode);
		// With access to all sites the button and its lines go, as before.
		panel.show({ ...unreadable(), allSites: true });
		expect(seen(panel).shown).toBe(false);
	});

	test("Firefox: its words, its extensions panel, a click on every new page", async () => {
		const panel = await openPanel({ firefox: true });
		panel.show(unreadable());
		expect(seen(panel)).toEqual({
			access:
				"Click the tab-mcp icon in Firefox's toolbar or extensions panel to let it read this page. Firefox asks again on every new page.",
			beforeIcon: "Click the tab-mcp icon",
			icon,
			button: "Give access to all sites",
			shown: true,
			note: "Or let it read every page without a click. Firefox asks you first.",
			hint: null,
		});
	});
});

describe("the Firefox build's panel", () => {
	test("the panel speaks of Firefox, not Chrome", async () => {
		const panel = await openPanel({ firefox: true });
		// With the address shown, so the setup commands are made.
		panel.show({
			...stateWith([]),
			status: "waiting",
			grants: [],
			pairing: true,
			address: "https://relay.example/s/abcdefghijklmnop/mcp",
			code: "BCDF-GHJK",
		});
		expect(panel.doc.title).toBe("tab-mcp browser extension");
		const html = panel.doc.body.innerHTML;
		expect(html).not.toContain("Chrome");
		expect(html).not.toContain("chrome://");
		expect(html).toContain("tab-mcp-browser-extension-firefox");
		expect(html).toContain("Click into the sidebar to answer.");
		expect(html.toLowerCase()).not.toContain("for-chrome");
	});
});
