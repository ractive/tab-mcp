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

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import type {
	PanelCommand,
	PanelState,
	QuestionSummary,
	ToolView,
} from "../src/protocol.ts";

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
 * A panel of its own: index.html in a new window, main.ts loaded anew in
 * it, its timers the window's (closed with it). `show` gives it a state as
 * the worker's port would.
 */
/**
 * main.ts as the Firefox build has it (`TAB_MCP_FIREFOX` true: its words,
 * its sidebar, its server name), bundled once into a file of its own.
 */
let firefoxMain: Promise<string> | undefined;
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
		const dir = mkdtempSync(join(tmpdir(), "tab-mcp-firefox-panel-"));
		const file = join(dir, "main.js");
		await Bun.write(file, await output.text());
		return file;
	})();
	return firefoxMain;
}

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
	const port = {
		postMessage: (m: PanelCommand) => void sent.push(m),
		onMessage: {
			addListener: (l: (m: unknown) => void) => {
				deliver = l;
			},
		},
		onDisconnect: { addListener: () => {} },
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
		runtime: { connect: () => port },
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
		/** The clock `ms` on, and the panel's own check of its waits run. */
		later: (ms: number) => {
			setSystemTime(Date.now() + ms);
			win.dispatchEvent(new win.Event("focus"));
		},
		$: <T extends HTMLElement = HTMLElement>(selector: string) =>
			doc.querySelector(selector) as T | null,
		/** The commands sent since the last call. */
		take: () => sent.splice(0),
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
