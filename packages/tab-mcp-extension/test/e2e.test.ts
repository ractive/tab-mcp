/**
 * End to end: the extension in Chrome for Testing, its side panel opened by
 * a real click on the icon and connected to a relay in this process, and an
 * MCP client (as the AI app) calling `page_info`. Pages are served through the
 * DevTools Protocol on https://site.test, https://www.site.test and
 * https://other.test; WebMCP is on (`--enable-features=WebMCP`).
 *
 * The test build has host access, so the content script follows navigations
 * and tab switches; the store package has none and works on a tab only after
 * a click on the icon there, until the tab goes to another origin.
 *
 * Needs Chrome for Testing 156 or newer (`CHROME_PATH`, or Puppeteer's or
 * Playwright's cache): required in CI, skipped elsewhere without it.
 */

import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	startTestRelay,
	type TestRelay,
	tokenFor,
} from "@ractive-ch/tab-mcp/testing";
import { TabMcp } from "@ractive-ch/tab-mcp-client";
import { build } from "../scripts/build.ts";
import {
	Browser,
	chromeMajor,
	findChromeForTesting,
	type Page,
	type Served,
	type Worker,
} from "./browser.ts";

// `bun run verify` runs these with Bun's default of 5 s a test: too short on
// CI for a navigation, an icon click and the tools following.
setDefaultTimeout(30_000);

const SITE = "https://site.test";
const OTHER = "https://other.test";
/** Same site as SITE, another origin. */
const SUBDOMAIN = "https://www.site.test";

const found = findChromeForTesting();
const chrome =
	found !== undefined && chromeMajor(found) >= 156 ? found : undefined;
if (chrome === undefined && process.env["CI"])
	throw new Error(
		"Chrome for Testing 156 or newer is needed for the extension's end-to-end tests in CI",
	);

async function serve(url: string): Promise<Served> {
	const { origin, pathname } = new URL(url);
	const name = pathname.slice(1);
	const file = Bun.file(join(import.meta.dir, "pages", name));
	if (
		![SITE, OTHER, SUBDOMAIN].includes(origin) ||
		!/^[a-z]+\.html$/.test(name) ||
		!(await file.exists())
	)
		return { status: 404, body: "not found" };
	return {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
		body: await file.bytes(),
	};
}

interface Stack {
	browser: Browser;
	relay: TestRelay;
	/** The tab the icon was clicked on. */
	tab: Page;
	/** The side panel, while it is open. */
	panel: Page;
	/** The service worker, where the connection lives. */
	worker: Worker;
	address: string;
	client: Client;
	/** The unpacked build. */
	extension: string;
	stop(): Promise<void>;
}

const panelUrl = (browser: Browser) =>
	`chrome-extension://${browser.extensionId}/sidepanel/index.html`;

/** Click the icon on `tab` and attach to the side panel it opens. */
async function openPanel(browser: Browser, tab: Page): Promise<Page> {
	await browser.clickIcon(tab);
	const panel = await browser.attach(
		(await browser.waitForTarget((t) => t.url === panelUrl(browser))).targetId,
	);
	// The state from the worker has come once the relay is shown.
	await panel.waitFor(`document.getElementById("relay").value !== ""`);
	return panel;
}

/** Close the side panel (of the first window), as the user would. */
async function closePanel(stack: Stack): Promise<void> {
	await stack.worker.eval(
		`chrome.windows.getLastFocused().then((w) => chrome.sidePanel.close({ windowId: w.id }))`,
	);
	const end = Date.now() + 10_000;
	for (;;) {
		const { targetInfos } = (await stack.browser.send("Target.getTargets")) as {
			targetInfos: { url: string }[];
		};
		if (!targetInfos.some((t) => t.url === panelUrl(stack.browser))) return;
		if (Date.now() > end) throw new Error("the side panel stayed open");
		await Bun.sleep(100);
	}
}

/** Set the relay in the panel's settings; resolves once the connection uses it. */
async function setRelay(panel: Page, relay: string): Promise<void> {
	// The relay address is under "Settings", closed at first.
	await panel.eval(`document.querySelector("details.settings").open = true`);
	await panel.eval(
		`document.getElementById("relay").value = ${JSON.stringify(relay)}`,
	);
	// Saving needs no click of the user's; a click right after "Settings"
	// opened could land before the layout settled. The field is emptied
	// after: the panel fills it again only from a state whose relay is a new
	// one, that is once the connection (in the worker) uses it. No hook for
	// the tests in the panel (ES 7), and the same in the store build.
	await panel.eval(`(() => {
		document.getElementById("relay-form").requestSubmit();
		document.getElementById("relay").value = "";
	})()`);
	await panel.waitFor(
		`document.getElementById("relay").value === ${JSON.stringify(relay)}`,
	);
}

/** An MCP client (the AI app) with a token for `address`. */
async function mcpClient(relay: TestRelay, address: string): Promise<Client> {
	const token = await tokenFor(relay.store, address);
	const client = new Client(
		{ name: "extension-e2e", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL(address), {
			requestInit: { headers: { authorization: `Bearer ${token}` } },
		}),
	);
	return client;
}

/**
 * Chrome with a build of the extension, `first` open in a tab, the side panel
 * opened by a click on the icon there, set to the test relay and connected,
 * and an MCP client with a token for the connection's address.
 */
async function start(
	options: { store: boolean; profile?: string },
	first: string,
): Promise<Stack> {
	const dir = mkdtempSync(join(tmpdir(), "tab-mcp-ext-"));
	const relay = startTestRelay();
	let browser: Browser | undefined;
	const stop = async () => {
		await browser?.close();
		await relay.stop();
		rmSync(dir, { recursive: true, force: true });
	};
	try {
		const outdir = join(dir, "dist");
		await build({
			outdir,
			...(options.store ? { store: true } : { test: true, minify: false }),
		});
		browser = await launch(outdir, options.profile);
		const tab = await browser.newPage(first);
		const panel = await openPanel(browser, tab);
		await setRelay(panel, relay.url);
		await panel.click("#connect");
		const address = await panel.waitFor<string>(
			`document.getElementById("address").textContent`,
			15_000,
		);
		const worker = await browser.serviceWorker(browser.extensionId as string);
		const client = await mcpClient(relay, address);
		return {
			browser,
			relay,
			tab,
			panel,
			worker,
			address,
			client,
			extension: outdir,
			stop,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}

function launch(extension: string, profile?: string): Promise<Browser> {
	return Browser.launch(chrome as string, {
		extension,
		args: [
			"--enable-features=WebMCP",
			...(process.env["CHROME_LOG"]
				? ["--enable-logging=stderr", "--v=0"]
				: []),
		],
		serve,
		...(profile ? { profile } : {}),
	});
}

interface CallResult {
	isError?: boolean;
	content: { type: string; text?: string }[];
	structuredContent?: Record<string, unknown>;
}

const call = (
	stack: Stack,
	name: string,
	args: Record<string, unknown> = {},
	options: { signal?: AbortSignal } = {},
) =>
	stack.client.callTool(
		{ name, arguments: args },
		options,
	) as Promise<CallResult>;

const pageInfo = (stack: Stack) => call(stack, "page_info");

/** The AI app's tool names, sorted. */
async function toolNames(stack: Stack): Promise<string[]> {
	return (await stack.client.listTools()).tools.map((t) => t.name).sort();
}

/** Wait until the AI app's tool list passes `check`. */
async function waitForTools(
	stack: Stack,
	check: (names: string[]) => boolean,
): Promise<string[]> {
	const end = Date.now() + 10_000;
	for (;;) {
		const names = await toolNames(stack);
		if (check(names)) return names;
		if (Date.now() > end)
			throw new Error(`the tool list stayed ${JSON.stringify(names)}`);
		await Bun.sleep(100);
	}
}

/** The extension's own tools, sorted. */
const OWN_TOOLS = [
	"go_back",
	"go_forward",
	"navigate",
	"page_info",
	"reload",
	"webmcp_call",
	"webmcp_tools",
];

const PAGE_TOOLS = [
	"page_get_greeting",
	"page_mcp_result",
	"page_mirrored_tool",
	"page_place_order",
	"page_slow_tool",
];

/** Answer the newest question in the side panel with `answer`. */
async function answerInPanel(
	stack: Stack,
	answer: "allow" | "site" | "deny",
): Promise<void> {
	// Allow counts only once the panel has been focused a while.
	await stack.panel.send("Emulation.setFocusEmulationEnabled", {
		enabled: true,
	});
	const selector = `[...document.querySelectorAll('[data-question] button[data-answer="${answer}"]')].at(-1)`;
	await stack.panel.waitFor(
		`${selector} && ${selector}.getAttribute("aria-disabled") !== "true"`,
		10_000,
	);
	await stack.panel.eval(`${selector}.id = "e2e-answer"`);
	await stack.panel.click("#e2e-answer");
	await stack.panel.eval(
		`document.getElementById("e2e-answer")?.removeAttribute("id")`,
	);
}

/**
 * An expression: the panel's element `selector` is there and takes clicks
 * (not `aria-disabled` during a wait after the layout moved, EQ 11).
 */
const takesClicks = (selector: string) =>
	`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e !== null && e.getAttribute("aria-disabled") !== "true"; })()`;

/** A tool's "Ask first" switch in the panel's tool list. */
const askFirst = (name: string) => `input.ask-first[data-tool="${name}"]`;

/** An expression: tool `name`'s "Ask first" switch is on (`true`) or off. */
const asksFirst = (name: string, on: boolean) =>
	`document.querySelector(${JSON.stringify(askFirst(name))})?.checked === ${on}`;

/** The worker's settings in its IndexedDB, read in the worker (`kv.ts`). */
const kvAll = (worker: Worker) =>
	worker.eval<Record<string, unknown>>(`new Promise((resolve, reject) => {
		const open = indexedDB.open("tab-mcp");
		// Not there (deleted): make nothing, for the worker to make it.
		let missing = false;
		open.onupgradeneeded = () => {
			missing = true;
			open.transaction.abort();
		};
		open.onerror = () => (missing ? resolve({}) : reject(open.error));
		open.onsuccess = () => {
			const db = open.result;
			// Out of the worker's way: a deletion waits for every connection.
			db.onversionchange = () => db.close();
			const store = db.transaction("settings").objectStore("settings");
			const keys = store.getAllKeys();
			const values = store.getAll();
			values.onsuccess = () => {
				db.close();
				resolve(Object.fromEntries(keys.result.map((k, i) => [k, values.result[i]])));
			};
			values.onerror = () => {
				db.close();
				reject(values.error);
			};
		};
	})`);

/** The ids of the extension's notifications on screen. */
const notifications = (stack: Stack) =>
	stack.worker.eval<string[]>(
		"chrome.notifications.getAll().then((all) => Object.keys(all))",
	);

/** Wait for a notification that is not one of `seen`; returns its id. */
async function newNotification(
	stack: Stack,
	seen: string[] = [],
): Promise<string> {
	const end = Date.now() + 10_000;
	for (;;) {
		const id = (await notifications(stack)).find((n) => !seen.includes(n));
		if (id !== undefined) return id;
		if (Date.now() > end) throw new Error("no notification came");
		await Bun.sleep(100);
	}
}

/**
 * Click button `index` of notification `id` (0 Don't allow, 1 Allow): the
 * DevTools Protocol cannot click one, so the test calls the function the
 * click's listener calls.
 */
const clickNotification = (stack: Stack, id: string, index: number) =>
	stack.worker.eval(
		`tabMcpNotificationButton(${JSON.stringify(id)}, ${index})`,
	);

describe.skipIf(chrome === undefined)("the test build (host access)", () => {
	let stack: Stack;
	let tab: Page;

	beforeAll(async () => {
		stack = await start({ store: false }, `${SITE}/webmcp.html`);
		tab = stack.tab;
	}, 60_000);

	afterAll(async () => {
		await stack?.client.close();
		await stack?.stop();
	});

	test("the AI app gets page_info, webmcp_tools and the page's tools", async () => {
		const names = await waitForTools(
			stack,
			(n) => n.length >= OWN_TOOLS.length + PAGE_TOOLS.length,
		);
		// mirrored_tool is a tab-mcp page's mirror, offered all the same: the
		// AI app may not be paired with the page itself (WM 1).
		expect(names).toEqual([...OWN_TOOLS, ...PAGE_TOOLS].sort());
		const { tools } = await stack.client.listTools();
		const byName = (name: string) => tools.find((t) => t.name === name);
		expect(byName("page_info")?.annotations?.readOnlyHint).toBe(true);
		const greeting = byName("page_get_greeting");
		expect(greeting?.description).toBe(`From ${SITE}: Greets a name.`);
		expect(greeting?.annotations?.readOnlyHint).toBe(true);
		expect(byName("page_place_order")?.annotations?.readOnlyHint).toBe(false);
	});

	test("there is no chrome.storage: the settings are where a content script cannot reach", async () => {
		// No `storage` permission: no area a content script could read or
		// write, in its world (where a page's compromised renderer would run
		// its code with the extension's APIs) or in the worker.
		expect(
			await stack.worker.eval("chrome.runtime.getManifest().permissions"),
		).not.toContain("storage");
		const world = await tab.isolatedWorld("tab-mcp for Chrome");
		// The world is the content script's: it has the extension's runtime.
		expect(await tab.eval("typeof chrome.runtime?.sendMessage", world)).toBe(
			"function",
		);
		expect(await tab.eval("typeof chrome.storage", world)).toBe("undefined");
		expect(await stack.worker.eval("typeof chrome.storage")).toBe("undefined");
		// The settings are in IndexedDB, in the extension's origin, which a
		// content script (in the page's origin) cannot open at all.
		expect(Object.keys(await kvAll(stack.worker))).toContain("relay");
	});

	test("page_info tells the page in front and its WebMCP tools", async () => {
		const result = await pageInfo(stack);
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			url: `${SITE}/webmcp.html`,
			title: "Page with WebMCP tools",
			language: "de-CH",
			webmcp: { available: true, tools: 5 },
		});
	});

	test("webmcp_tools lists them with their input schemas", async () => {
		const result = await call(stack, "webmcp_tools");
		expect(result.structuredContent).toMatchObject({
			origin: SITE,
			available: true,
		});
		expect(result.structuredContent).not.toHaveProperty("mirrored");
		const tools = result.structuredContent?.["tools"] as {
			name: string;
			tool?: string;
			readOnly: boolean;
			inputSchema?: unknown;
		}[];
		expect(tools.map((t) => t.tool).sort()).toEqual(PAGE_TOOLS);
		expect(tools.find((t) => t.name === "place_order")?.readOnly).toBe(false);
		// What webmcp_call needs to call a tool the AI app has no entry for (EQ 1).
		expect(tools.find((t) => t.name === "get_greeting")?.inputSchema).toEqual({
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		});
	});

	test("a read-only tool runs at once, with the page's answer", async () => {
		const result = await call(stack, "page_get_greeting", { name: "Ada" });
		expect(result.isError).toBeFalsy();
		expect(result.content).toEqual([{ type: "text", text: "Hello, Ada!" }]);
		expect(await tab.eval("window.calls.at(-1)")).toEqual([
			"get_greeting",
			"Ada",
		]);
	});

	test("arguments are checked against the page's schema (Chrome does not)", async () => {
		const result = await call(stack, "page_get_greeting", { name: 42 });
		expect(result.isError).toBe(true);
		expect(await tab.eval("window.calls.length")).toBe(1);
	});

	test("an MCP result from the page passes as its content", async () => {
		expect((await call(stack, "page_mcp_result")).content).toEqual([
			{ type: "text", text: "from an MCP result" },
		]);
	});

	test("a tool not marked read-only asks in the side panel first", async () => {
		const allowed = call(stack, "page_place_order", { item: "tea" });
		// "Don't ask again on <host>" is offered too.
		await stack.panel.waitFor(
			`document.querySelector('[data-question] button[data-answer="site"]')`,
		);
		expect(
			await stack.panel.eval(
				`document.querySelector('[data-question] button[data-answer="site"]').textContent`,
			),
		).toBe(`Don't ask again on ${new URL(SITE).host}`);
		// The verified site on a line of its own, the page's title apart.
		const [ask, ...lines] = await stack.panel.eval<string[]>(
			`[...document.querySelectorAll("[data-question] p")].slice(0, 3).map((p) => p.textContent)`,
		);
		expect(ask).toEndWith(" wants to run page_place_order.");
		expect(lines).toEqual([
			`Site (verified) ${SITE}`,
			"Title (from the page) place_order",
		]);
		await answerInPanel(stack, "allow");
		const result = await allowed;
		expect(result.isError).toBeFalsy();
		expect(result.content[0]?.text).toContain("tea");
		// Arguments longer than a panel ever cut them are there in full.
		const long = `coffee ${"c".repeat(5000)}`;
		const declined = call(stack, "page_place_order", { item: long });
		await stack.panel.waitFor(`document.querySelector("[data-question] pre")`);
		expect(
			JSON.parse(
				await stack.panel.eval<string>(
					`document.querySelector("[data-question] pre").textContent`,
				),
			),
		).toEqual({ item: long });
		await answerInPanel(stack, "deny");
		expect((await declined).isError).toBe(true);
		expect(await tab.eval("window.calls.map((c) => c[1])")).not.toContain(
			"coffee",
		);
	});

	test("Don't ask again on <host> allows the tool on the site, as the panel's switch does (EQ 10)", async () => {
		const first = call(stack, "page_place_order", { item: "once more" });
		await answerInPanel(stack, "site");
		expect((await first).isError).toBeFalsy();
		// Kept where the panel's "allowed" is, and shown there.
		expect(
			((await kvAll(stack.worker))["allowedTools"] as Record<string, string[]>)[
				SITE
			],
		).toEqual(["place_order"]);
		await stack.panel.waitFor(asksFirst("place_order", false));
		// The next call runs without a question, also through webmcp_call.
		expect(
			(await call(stack, "page_place_order", { item: "unasked" })).isError,
		).toBeFalsy();
		expect(
			(
				await call(stack, "webmcp_call", {
					name: "place_order",
					arguments: { item: "unasked too" },
				})
			).isError,
		).toBeFalsy();
		expect(
			await stack.panel.eval(
				`document.querySelectorAll("[data-question]").length`,
			),
		).toBe(0);
		// Back to "Ask first" for the tests after this one.
		await stack.panel.waitFor(takesClicks(askFirst("place_order")));
		await stack.panel.click(askFirst("place_order"));
		// The click flips the switch at once; the worker's write comes after.
		await allowedOn(SITE, (n) => !n.includes("place_order"));
		await stack.panel.waitFor(asksFirst("place_order", true));
	});

	test("webmcp_call calls a page tool by name, with the same confirmation", async () => {
		const read = await call(stack, "webmcp_call", {
			name: "get_greeting",
			arguments: { name: "Bo" },
		});
		expect(read.content).toEqual([{ type: "text", text: "Hello, Bo!" }]);
		const bad = await call(stack, "webmcp_call", {
			name: "get_greeting",
			arguments: { name: 7 },
		});
		expect(bad.isError).toBe(true);
		const ordered = call(stack, "webmcp_call", {
			name: "place_order",
			arguments: { item: "cake" },
		});
		await answerInPanel(stack, "allow");
		expect((await ordered).content[0]?.text).toContain("cake");
	});

	test("the AI access switch: its knob sits flush at both ends, light, dark and forced colours", async () => {
		/**
		 * The track's width, the knob's gaps to the track's outer edges, on
		 * and off, and whether the track may grow. The knob sits in the padding
		 * box, so a border or padding moves it: the text fields' rules (8 px
		 * padding, a 1 px border, flex: 1) once made the track wider than the
		 * knob's travel. Without the transition, so no waiting.
		 */
		const measure = () =>
			stack.panel.eval<{
				width: number;
				on: [number, number];
				off: [number, number];
				grows: string;
			}>(`(() => {
				const input = document.getElementById("ai-switch");
				const still = document.createElement("style");
				still.textContent = "#ai-switch, #ai-switch::after { transition: none !important; }";
				document.head.append(still);
				const was = input.checked;
				const style = getComputedStyle(input);
				const width = input.getBoundingClientRect().width;
				const gaps = (checked) => {
					// Not a click: no change event, no command.
					input.checked = checked;
					const knob = getComputedStyle(input, "::after");
					const left =
						parseFloat(style.borderLeftWidth) +
						parseFloat(knob.left) +
						new DOMMatrix(knob.transform === "none" ? "" : knob.transform).m41;
					return [left, width - left - parseFloat(knob.width)];
				};
				const result = { width, on: gaps(true), off: gaps(false), grows: style.flexGrow };
				input.checked = was;
				still.remove();
				return result;
			})()`);
		const flush: Awaited<ReturnType<typeof measure>> = {
			width: 34,
			on: [16, 2],
			off: [2, 16],
			grows: "0",
		};
		for (const features of [
			[{ name: "prefers-color-scheme", value: "light" }],
			[{ name: "prefers-color-scheme", value: "dark" }],
			[{ name: "forced-colors", value: "active" }],
		]) {
			await stack.panel.send("Emulation.setEmulatedMedia", { features });
			expect(await measure()).toEqual(flush);
		}
		// Forced colours: the track is outlined, not left to a background.
		expect(
			await stack.panel.eval(
				`getComputedStyle(document.getElementById("ai-switch")).borderTopStyle`,
			),
		).toBe("solid");
		await stack.panel.send("Emulation.setEmulatedMedia", { features: [] });
	});

	test("the AI access switch and a tool's Ask first: knob on track and track on the paper at least 3:1, light and dark, on and off (EQ 17, DEC-160)", async () => {
		/** The contrast ratios Chrome's computed colours give, on and off. */
		const contrast = (selector: string) =>
			stack.panel.eval<{
				on: { knob: number; track: number };
				off: { knob: number; track: number };
			}>(`(() => {
				const input = document.querySelector(${JSON.stringify(selector)});
				const still = document.createElement("style");
				still.textContent = "input, input::after { transition: none !important; }";
				document.head.append(still);
				const was = input.checked;
				const rgb = (color) => {
					const c = document.createElement("canvas").getContext("2d");
					c.fillStyle = color;
					c.fillRect(0, 0, 1, 1);
					return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3);
				};
				const lum = (color) => {
					const [r, g, b] = rgb(color).map((v) => {
						const s = v / 255;
						return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
					});
					return 0.2126 * r + 0.7152 * g + 0.0722 * b;
				};
				const ratio = (a, b) => {
					const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
					return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
				};
				// The sections are on the paper (the body), not on a card.
				const card = getComputedStyle(document.body).backgroundColor;
				// The wait after the layout moved makes a tool's switch flat.
				const waits = input.getAttribute("aria-disabled");
				input.removeAttribute("aria-disabled");
				const at = (checked) => {
					input.checked = checked;
					const track = getComputedStyle(input).backgroundColor;
					const knob = getComputedStyle(input, "::after").backgroundColor;
					return { knob: ratio(knob, track), track: ratio(track, card) };
				};
				const result = { on: at(true), off: at(false) };
				input.checked = was;
				if (waits !== null) input.setAttribute("aria-disabled", waits);
				still.remove();
				return result;
			})()`);
		await stack.panel.waitFor(`document.querySelector("input.ask-first")`);
		for (const selector of ["#ai-switch", "input.ask-first"]) {
			const measured: Record<string, unknown> = {};
			for (const value of ["light", "dark"]) {
				await stack.panel.send("Emulation.setEmulatedMedia", {
					features: [{ name: "prefers-color-scheme", value }],
				});
				const m = await contrast(selector);
				measured[value] = m;
				for (const ratio of [m.on.knob, m.on.track, m.off.knob, m.off.track])
					expect(ratio).toBeGreaterThanOrEqual(3);
			}
			// The tokens' pairs (test/contrast.test.ts): on, the knob
			// (--on-strong) on the ink track (--strong), which is ink on paper;
			// off, the knob on the edge (--edge), and the edge on paper. Before
			// the tokens: 5.02 / 3.77 in light, 9.48 / 3.42 in dark; before
			// EQ 17 the dark "on" knob was 1.7:1, the light "off" track 2.5:1.
			expect(measured).toEqual({
				light: {
					on: { knob: 16.07, track: 14.61 },
					off: { knob: 3.86, track: 3.51 },
				},
				dark: {
					on: { knob: 15.89, track: 15.89 },
					off: { knob: 4.39, track: 4.39 },
				},
			});
		}
		await stack.panel.send("Emulation.setEmulatedMedia", { features: [] });
	});

	test("How do I add it? under the address: the commands fit, light and dark, Copy keeps its width", async () => {
		// With an app paired, the address is behind "+ Add another AI app".
		const adding = !(await stack.panel.eval<boolean>(
			`document.getElementById("pairing").hidden === false`,
		));
		if (adding) await stack.panel.click("#add-app");
		await stack.panel.waitFor(
			`!document.getElementById("setup").hidden && document.getElementById("setup").offsetHeight > 0`,
		);
		expect(
			await stack.panel.eval<boolean>(`document.getElementById("setup").open`),
		).toBe(false);
		await stack.panel.click("#setup summary");
		await stack.panel.waitFor(`document.getElementById("setup").open`);
		const measure = () =>
			stack.panel.eval<{
				apps: string[];
				commands: string[];
				overflow: boolean;
				widths: [number, number];
				pre: [string, string];
			}>(`(() => {
				const setup = document.getElementById("setup");
				const pres = [...setup.querySelectorAll("pre")];
				const copy = setup.querySelector("button.copy");
				const before = copy.getBoundingClientRect().width;
				copy.textContent = "Copied";
				const after = copy.getBoundingClientRect().width;
				copy.textContent = "Copy";
				const style = getComputedStyle(pres[0]);
				return {
					apps: [...setup.querySelectorAll("li > strong")].map((e) => e.textContent),
					commands: pres.map((e) => e.textContent),
					overflow:
						document.documentElement.scrollWidth > document.documentElement.clientWidth ||
						pres.some((e) => e.scrollWidth > e.clientWidth),
					widths: [before, after],
					pre: [style.color, style.backgroundColor],
				};
			})()`);
		const seen: [string, string][] = [];
		for (const value of ["light", "dark"]) {
			await stack.panel.send("Emulation.setEmulatedMedia", {
				features: [{ name: "prefers-color-scheme", value }],
			});
			const m = await measure();
			expect(m.apps).toEqual([
				"Claude (claude.ai and the desktop app)",
				"ChatGPT",
				"Claude Code",
				"Codex",
			]);
			expect(m.commands).toEqual([
				`claude mcp add --transport http tab-mcp-for-chrome ${stack.address}`,
				`codex features enable mcp_2026_07_28\ncodex mcp add tab-mcp-for-chrome --url ${stack.address}\ncodex mcp login tab-mcp-for-chrome`,
			]);
			expect(m.overflow).toBe(false);
			expect(m.widths[1]).toBe(m.widths[0]);
			expect(m.pre[0]).not.toBe(m.pre[1]);
			seen.push(m.pre);
		}
		// The scheme's own colours, not one fixed pair.
		expect(seen[0]).not.toEqual(seen[1]);
		await stack.panel.send("Emulation.setEmulatedMedia", { features: [] });
		await stack.panel.click("#setup summary");
		if (adding) await stack.panel.click("#pair-done");
	});

	test("the look: nothing past the panel's edge at 345, 360 and 420 px, no amber button, each scheme's tokens (DEC-160 to DEC-163)", async () => {
		const panel = stack.panel;
		/**
		 * Chrome's narrowest side panel with a classic scrollbar beside its
		 * content (15 px on Windows and Linux), the same without one, and a
		 * common width.
		 */
		const WIDTHS = [345, 360, 420];
		const AMBER = "rgb(255, 176, 0)";
		/**
		 * What reaches past the right edge of the panel's content (the
		 * scrolling element's `clientWidth`: the window's less a scrollbar),
		 * and the buttons filled or outlined in amber.
		 */
		const measure = () =>
			panel.eval<{
				scroll: number;
				client: number;
				past: string[];
				amber: string[];
			}>(`(() => {
				const shown = (e) => e.getClientRects().length > 0;
				const root = document.scrollingElement;
				return {
					scroll: root.scrollWidth,
					client: root.clientWidth,
					past: [...document.querySelectorAll("body *")]
						.filter((e) => shown(e) && !e.closest(".visually-hidden") && e.getBoundingClientRect().right > root.clientWidth + 0.5)
						.map((e) => e.tagName + "#" + e.id + "." + e.className),
					amber: [...document.querySelectorAll("button")]
						.filter((e) => {
							const style = getComputedStyle(e);
							return style.backgroundColor === ${JSON.stringify(AMBER)} || style.borderTopColor === ${JSON.stringify(AMBER)};
						})
						.map((e) => e.id || e.textContent),
				};
			})()`);
		/** At each width: no sideways scroll, nothing past the edge, no amber. */
		const holds = async () => {
			for (const width of WIDTHS) {
				await panel.send("Emulation.setDeviceMetricsOverride", {
					width,
					height: 900,
					deviceScaleFactor: 1,
					mobile: false,
				});
				await panel.waitFor(`innerWidth === ${width}`);
				const seen = await measure();
				expect(seen.client).toBeLessThanOrEqual(width);
				expect(seen.scroll).toBeLessThanOrEqual(seen.client);
				expect(seen.past).toEqual([]);
				expect(seen.amber).toEqual([]);
			}
		};
		const adding = !(await panel.eval<boolean>(
			`document.getElementById("pairing").hidden === false`,
		));
		try {
			// The tab's tools with their switches, and the address and the code.
			if (adding) await panel.click("#add-app");
			await panel.waitFor(
				`!document.getElementById("pairing").hidden && !document.getElementById("tools-head").hidden && document.querySelector("input.ask-first") !== null`,
			);
			await holds();
			// "How do I add it?" (its commands) and Settings open, and the two
			// notices, with words that have nowhere to break. The next state
			// hides the notices again.
			const LONG = "x".repeat(120);
			await panel.eval(`(() => {
				document.getElementById("setup").open = true;
				document.querySelector("details.settings").open = true;
				for (const id of ["local-problem", "replaced"]) document.getElementById(id).hidden = false;
				document.getElementById("local-problem").textContent = "Could not reach the relay at https://${LONG}.example";
				document.getElementById("replaced-text").textContent = "Another tab or program took over this address ${LONG}";
			})()`);
			await holds();
			// A problem is red in its fill and edge, its words in ink; the
			// notice is the warning's; a button on it keeps its edge.
			expect(
				await panel.eval<string[]>(`(() => {
					const css = (id) => getComputedStyle(document.getElementById(id));
					const root = getComputedStyle(document.documentElement);
					const token = (name) => {
						const probe = document.createElement("i");
						probe.style.color = "var(" + name + ")";
						document.body.append(probe);
						const colour = getComputedStyle(probe).color;
						probe.remove();
						return colour;
					};
					return [
						css("local-problem").backgroundColor === token("--danger-bg"),
						css("local-problem").borderTopColor === token("--danger"),
						css("local-problem").color === token("--ink"),
						css("replaced").backgroundColor === token("--warn-bg"),
						css("replaced").borderTopColor === token("--warn-edge"),
						css("replaced-new-address").borderTopColor === token("--edge"),
					].map(String);
				})()`),
			).toEqual(["true", "true", "true", "true", "true", "true"]);
			// A question with arguments and a title that have nowhere to break.
			const asked = call(stack, "page_place_order", { item: LONG.repeat(4) });
			await panel.waitFor(`document.querySelector("[data-question] pre")`);
			await holds();
			// It is a sheet with an edge; "Allow once" is ink, not amber, and
			// while it takes no click it is flat, in colours of its own.
			const question = await panel.eval<Record<string, string>>(`(() => {
				const card = getComputedStyle(document.querySelector("[data-question]"));
				const allow = document.querySelector('[data-question] button[data-answer="allow"]');
				const was = allow.getAttribute("aria-disabled");
				const still = document.createElement("style");
				still.textContent = "button { transition: none !important; }";
				document.head.append(still);
				allow.setAttribute("aria-disabled", "true");
				const waiting = getComputedStyle(allow).backgroundColor;
				const opacity = getComputedStyle(allow).opacity;
				allow.removeAttribute("aria-disabled");
				const ready = getComputedStyle(allow).backgroundColor;
				if (was !== null) allow.setAttribute("aria-disabled", was);
				still.remove();
				return {
					sheet: card.backgroundColor,
					edge: card.borderTopColor,
					shadow: card.boxShadow,
					class: allow.className,
					waiting,
					opacity,
					ready,
				};
			})()`);
			await answerInPanel(stack, "deny");
			expect((await asked).isError).toBe(true);
			await panel.waitFor(
				`document.querySelectorAll("[data-question]").length === 0`,
			);
			// Each scheme's tokens arrive: paper and ink, a default button's
			// edge, the strong button's fill, an armed button's red.
			const read = () =>
				panel.eval<Record<string, string>>(`(() => {
					const root = getComputedStyle(document.documentElement);
					const still = document.createElement("style");
					still.textContent = "button { transition: none !important; }";
					document.head.append(still);
					const armed = document.createElement("button");
					armed.className = "small";
					armed.setAttribute("data-armed", "");
					armed.textContent = "Disconnect? Click again";
					document.querySelector("main").append(armed);
					const result = {
						paper: root.getPropertyValue("--paper").trim(),
						ink: root.getPropertyValue("--ink").trim(),
						body: getComputedStyle(document.body).backgroundColor,
						text: getComputedStyle(document.body).color,
						section: getComputedStyle(document.querySelector("main > .card")).backgroundColor,
						edge: getComputedStyle(document.getElementById("allow-tools")).borderTopColor,
						field: getComputedStyle(document.getElementById("relay")).borderTopColor,
						strong: getComputedStyle(document.querySelector("#relay-form button")).backgroundColor,
						onStrong: getComputedStyle(document.querySelector("#relay-form button")).color,
						armed: getComputedStyle(armed).backgroundColor,
						onArmed: getComputedStyle(armed).color,
					};
					armed.remove();
					still.remove();
					return result;
				})()`);
			const scheme = (value: string) =>
				panel.send("Emulation.setEmulatedMedia", {
					features: [{ name: "prefers-color-scheme", value }],
				});
			await scheme("light");
			// Wait for the "Don't ask for these tools" button to take clicks
			// again: it is flat for a moment after the question went.
			await panel.waitFor(takesClicks("#allow-tools"));
			expect(await read()).toEqual({
				paper: "#f6f4ee",
				ink: "#1b2130",
				body: "rgb(246, 244, 238)",
				text: "rgb(27, 33, 48)",
				// A section is on the paper: no card.
				section: "rgba(0, 0, 0, 0)",
				edge: "rgb(123, 130, 145)",
				field: "rgb(123, 130, 145)",
				strong: "rgb(27, 33, 48)",
				onStrong: "rgb(255, 255, 255)",
				armed: "rgb(179, 38, 30)",
				onArmed: "rgb(255, 255, 255)",
			});
			expect(question).toEqual({
				sheet: "rgb(255, 255, 255)",
				edge: "rgb(123, 130, 145)",
				shadow: "none",
				class: "strong",
				waiting: "rgb(235, 232, 224)",
				opacity: "1",
				ready: "rgb(27, 33, 48)",
			});
			await scheme("dark");
			expect(await read()).toEqual({
				paper: "#11141a",
				ink: "#eceef3",
				body: "rgb(17, 20, 26)",
				text: "rgb(236, 238, 243)",
				section: "rgba(0, 0, 0, 0)",
				edge: "rgb(115, 124, 142)",
				field: "rgb(115, 124, 142)",
				strong: "rgb(236, 238, 243)",
				onStrong: "rgb(17, 20, 26)",
				armed: "rgb(255, 143, 133)",
				onArmed: "rgb(17, 20, 26)",
			});
			// Nothing is said in a tooltip alone: the address is shown whole,
			// and what "Ask first" does is a line over the list.
			expect(
				await panel.eval(`(() => {
					const address = document.getElementById("address");
					const input = document.querySelector("input.ask-first");
					return [
						address.title,
						address.scrollWidth <= address.clientWidth,
						input.closest("label").title,
						input.getAttribute("aria-describedby"),
						document.getElementById("ask-first-note").textContent,
						// As the panel is drawn now, not only as its HTML is.
						[...document.querySelectorAll("[title]")].map((e) => e.id || e.className),
					];
				})()`),
			).toEqual([
				"",
				true,
				"",
				"ask-first-note",
				[],
				`Ask first, on: the tool asks you before each call. Off: it runs without asking on ${SITE}, for every paired AI app.`,
			]);
		} finally {
			await panel.send("Emulation.setEmulatedMedia", { features: [] });
			await panel.send("Emulation.clearDeviceMetricsOverride");
			await panel.eval(`(() => {
				document.getElementById("setup").open = false;
				document.querySelector("details.settings").open = false;
				for (const id of ["local-problem", "replaced"]) document.getElementById(id).hidden = true;
			})()`);
			if (adding)
				await panel.eval(`document.getElementById("pair-done").click()`);
		}
	}, 90_000);

	test("Don't ask for these tools and Ask first for these tools, for the tools listed at the click only", async () => {
		const head = `document.getElementById("allow-tools")`;
		const DONT_ASK = JSON.stringify("Don't ask for these tools");
		const ASK = JSON.stringify("Ask first for these tools");
		// Off for a moment after a question went (the layout moved).
		await stack.panel.waitFor(
			`!document.getElementById("tools-head").hidden && ${head}.textContent === ${DONT_ASK} && ${takesClicks("#allow-tools")}`,
		);
		await stack.panel.click("#allow-tools");
		await stack.panel.waitFor(`${head}.textContent === ${ASK}`);
		expect(await stack.panel.eval(asksFirst("place_order", false))).toBe(true);
		const allowed = await call(stack, "page_place_order", { item: "all" });
		expect(allowed.content[0]?.text).toContain("all");
		// A tool the page registers later asks first.
		await tab.eval(`document.modelContext.registerTool({
			name: "late_order",
			description: "Orders, registered later.",
			inputSchema: { type: "object" },
			async execute() { return "late order"; },
		})`);
		await waitForTools(stack, (n) => n.includes("page_late_order"));
		// The button changed under the pointer (another label, one more tool):
		// a click right then allows nothing.
		await stack.panel.waitFor(
			`${head}.getAttribute("aria-label") === "Don't ask for the 2 tools listed on ${SITE}, for every paired AI app"`,
		);
		expect(await stack.panel.eval(takesClicks("#allow-tools"))).toBe(false);
		// Not `disabled`: it stays in the tab order (EQ 11).
		expect(await stack.panel.eval(`${head}.disabled`)).toBe(false);
		await stack.panel.click("#allow-tools");
		await Bun.sleep(300);
		expect(
			((await kvAll(stack.worker))["allowedTools"] as Record<string, string[]>)[
				SITE
			],
		).not.toContain("late_order");
		const late = call(stack, "page_late_order");
		await stack.panel.waitFor(`document.querySelector("[data-question]")`);
		await answerInPanel(stack, "deny");
		expect((await late).isError).toBe(true);
		// One asks again: "Don't ask" again takes the late one too.
		await stack.panel.waitFor(
			`${head}.textContent === ${DONT_ASK} && ${takesClicks("#allow-tools")}`,
		);
		await stack.panel.click("#allow-tools");
		await stack.panel.waitFor(`${head}.textContent === ${ASK}`);
		expect((await call(stack, "page_late_order")).isError).toBeFalsy();
		// "Ask first" (once it may be clicked: its label just changed): every
		// one asks first again.
		await stack.panel.waitFor(takesClicks("#allow-tools"));
		await stack.panel.click("#allow-tools");
		await stack.panel.waitFor(`${head}.textContent === ${DONT_ASK}`);
		const asks = call(stack, "page_place_order", { item: "asks" });
		await stack.panel.waitFor(`document.querySelector("[data-question]")`);
		await answerInPanel(stack, "deny");
		expect((await asks).isError).toBe(true);
	});

	/** Send panel commands over a port of the panel's own, as its page does. */
	const sendCommands = (commands: unknown[]) =>
		stack.panel.eval(`(async () => {
			const port = chrome.runtime.connect({ name: "panel" });
			for (const command of ${JSON.stringify(commands)}) port.postMessage(command);
			await new Promise((resolve) => setTimeout(resolve, 200));
			port.disconnect();
		})()`);

	/** The tools allowed on `origin`, once `check` holds for them (polled). */
	async function allowedOn(
		origin: string,
		check: (names: string[]) => boolean,
	): Promise<string[]> {
		const end = Date.now() + 10_000;
		for (;;) {
			const all = (await kvAll(stack.worker))["allowedTools"] as
				| Record<string, string[]>
				| undefined;
			const names = all?.[origin] ?? [];
			if (check(names)) return names;
			if (Date.now() > end)
				throw new Error(`allowed on ${origin}: ${JSON.stringify(names)}`);
			await Bun.sleep(100);
		}
	}

	test("Allow all takes only tools the worker offers on that origin", async () => {
		await sendCommands([
			{
				type: "set-allowed-all",
				origin: SITE,
				names: ["place_order", "not_offered", "get_greeting"],
				on: true,
			},
			{
				type: "set-allowed-all",
				origin: OTHER,
				names: ["place_order"],
				on: true,
			},
		]);
		// The one it offers there and that asks first: allowed.
		const names = await allowedOn(SITE, (n) => n.includes("place_order"));
		// Not a name it does not offer, not a read-only one, not another site.
		expect(names).toEqual(["place_order"]);
		expect(await allowedOn(OTHER, () => true)).toEqual([]);
		await sendCommands([
			{
				type: "set-allowed-all",
				origin: SITE,
				names: ["place_order"],
				on: false,
			},
		]);
		await allowedOn(SITE, (n) => n.length === 0);
	});

	test("Ask for all also takes away a tool the page dropped since: back, it asks first", async () => {
		const register = `document.modelContext.registerTool({
			name: "dropped_order",
			description: "Orders; the page drops it and brings it back.",
			inputSchema: { type: "object" },
			async execute() { return "dropped order"; },
		})`;
		await tab.eval(register);
		await waitForTools(stack, (n) => n.includes("page_dropped_order"));
		await call(stack, "webmcp_tools");
		const command = (on: boolean) => ({
			type: "set-allowed-all",
			origin: SITE,
			names: ["dropped_order"],
			on,
		});
		await sendCommands([command(true)]);
		await allowedOn(SITE, (n) => n.includes("dropped_order"));
		// The page drops it (another page of the site, without it), and the
		// panel's "Ask for all" still names it.
		await tab.goto(`${SITE}/plain.html`);
		await call(stack, "webmcp_tools");
		await sendCommands([command(false)]);
		await allowedOn(SITE, (n) => !n.includes("dropped_order"));
		// It comes back as a tool that changes things: it asks first.
		await tab.goto(`${SITE}/webmcp.html`);
		await tab.eval(register);
		await waitForTools(stack, (n) => n.includes("page_dropped_order"));
		await call(stack, "webmcp_tools");
		const asked = call(stack, "page_dropped_order");
		await stack.panel.waitFor(`document.querySelector("[data-question]")`);
		await answerInPanel(stack, "deny");
		expect((await asked).isError).toBe(true);
	});

	test("a tool whose Ask first is switched off in the panel runs without asking, for that site", async () => {
		const toggle = askFirst("place_order");
		// Off for a moment after the last question went (the layout moved).
		await stack.panel.waitFor(takesClicks(toggle));
		// A switch with a label that stays (EQ 11).
		expect(
			await stack.panel.eval(`(() => {
				const e = document.querySelector(${JSON.stringify(toggle)});
				return [e.type, e.getAttribute("role"), e.getAttribute("aria-label"), e.checked];
			})()`),
		).toEqual(["checkbox", "switch", "Ask first: place_order", true]);
		// The switch as drawn now: the click flips it at once, the worker's
		// state then draws the list anew.
		await stack.panel.eval(
			`document.querySelector(${JSON.stringify(toggle)}).dataset.e2eOld = "1"`,
		);
		await stack.panel.click(toggle);
		// Written by the worker, then shown from its state.
		await allowedOn(SITE, (n) => n.includes("place_order"));
		await stack.panel.waitFor(
			`(() => { const e = document.querySelector(${JSON.stringify(toggle)}); return e !== null && e.dataset.e2eOld === undefined && !e.checked; })()`,
		);
		expect(
			await stack.panel.eval(
				`document.querySelector(${JSON.stringify(toggle)}).getAttribute("aria-label")`,
			),
		).toBe("Ask first: place_order");
		// The list was made anew with the state: the focus is on the same
		// tool's switch, not on the page's body (EQ 11).
		expect(
			await stack.panel.eval(
				`document.activeElement?.matches(${JSON.stringify(toggle)}) === true`,
			),
		).toBe(true);
		const result = await call(stack, "page_place_order", { item: "allowed" });
		expect(result.isError).toBeFalsy();
		expect(await tab.eval("window.calls.at(-1)")).toEqual([
			"place_order",
			"allowed",
		]);
		// Switched back: it asks again.
		await stack.panel.click(toggle);
		await allowedOn(SITE, (n) => !n.includes("place_order"));
		await stack.panel.waitFor(asksFirst("place_order", true));
		const asked = call(stack, "page_place_order", { item: "asked" });
		await answerInPanel(stack, "deny");
		expect((await asked).isError).toBe(true);
	});

	test("cancelling a call cancels it in the page", async () => {
		const controller = new AbortController();
		const slow = call(
			stack,
			"page_slow_tool",
			{},
			{ signal: controller.signal },
		);
		// Once the page's tool runs: aborted earlier, it would never start.
		await tab.waitFor("window.slowStarted");
		controller.abort();
		await slow.catch(() => undefined);
		await tab.waitFor("window.aborted");
	});

	test("the list follows toolchange, without a navigation", async () => {
		await tab.eval(`document.modelContext.registerTool({
			name: "late_tool",
			description: "Registered later.",
			inputSchema: { type: "object" },
			annotations: { readOnlyHint: true },
			async execute() { return "late"; },
		})`);
		await waitForTools(stack, (n) => n.includes("page_late_tool"));
		expect((await call(stack, "page_late_tool")).content).toEqual([
			{ type: "text", text: "late" },
		]);
	});

	test("a page that replaces document.modelContext fools only itself", async () => {
		await tab.goto(`${SITE}/forged.html`);
		const names = await waitForTools(stack, (n) =>
			n.includes("page_real_tool"),
		);
		expect(names).not.toContain("page_forged_tool");
		expect(names).not.toContain("page_get_greeting");
	});

	test("a page tool that takes the tab to another page answers with that page, not a failure (WM 2)", async () => {
		await tab.goto(`${SITE}/checkout.html`);
		await waitForTools(stack, (n) => n.includes("page_checkout"));
		const result = await call(stack, "page_checkout");
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			navigated: true,
			page: { url: `${SITE}/plain.html`, title: "Plain page" },
		});
		expect(String(result.structuredContent?.["note"])).toContain(
			"may have completed",
		);
	});

	test("it follows a navigation", async () => {
		await tab.goto(`${SITE}/plain.html`);
		const result = await pageInfo(stack);
		expect(result.structuredContent).toMatchObject({
			url: `${SITE}/plain.html`,
			title: "Plain page",
			webmcp: { available: true, tools: 0 },
		});
		expect(
			await waitForTools(stack, (n) => n.length === OWN_TOOLS.length),
		).toEqual(OWN_TOOLS);
		// The panel on a page without tools: what still works, instead of a
		// bare "No WebMCP" (EQ 7).
		await stack.panel.waitFor(`!document.getElementById("no-tools").hidden`);
		expect(
			await stack.panel.eval(
				`[document.getElementById("no-webmcp").hidden, document.getElementById("tab-badges").textContent]`,
			),
		).toEqual([true, ""]);
	});

	test("it follows a tab switch, tools included", async () => {
		const other = await stack.browser.newPage(`${OTHER}/webmcp.html`);
		await other.activate();
		expect((await pageInfo(stack)).structuredContent).toMatchObject({
			url: `${OTHER}/webmcp.html`,
		});
		await waitForTools(stack, (n) => n.includes("page_get_greeting"));
		const { tools } = await stack.client.listTools();
		expect(tools.find((t) => t.name === "page_get_greeting")?.description).toBe(
			`From ${OTHER}: Greets a name.`,
		);
		await tab.activate();
		expect((await pageInfo(stack)).structuredContent).toMatchObject({
			url: `${SITE}/plain.html`,
		});
		await waitForTools(stack, (n) => !n.includes("page_get_greeting"));
	});
});

describe.skipIf(chrome === undefined)(
	"the connection without the side panel",
	() => {
		let stack: Stack;

		beforeAll(async () => {
			stack = await start({ store: false }, `${SITE}/webmcp.html`);
			await waitForTools(stack, (n) => n.includes("page_place_order"));
		}, 60_000);

		afterAll(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		const badge = () =>
			stack.worker.eval<string>("chrome.action.getBadgeText({})");

		test("a question in the panel of the tab's focused window sends no notification", async () => {
			// Every notification the worker makes, also one cleared at once.
			await stack.worker.eval(`(() => {
				globalThis.e2eCreated = [];
				const create = chrome.notifications.create.bind(chrome.notifications);
				chrome.notifications.create = (...args) => {
					globalThis.e2eCreated.push(args[0]);
					return create(...args);
				};
			})()`);
			const asked = call(stack, "page_place_order", { item: "panel" });
			await stack.panel.waitFor(`document.querySelector("[data-question]")`);
			expect(await badge()).toBe("?");
			// A short line for screen readers, not the card (EQ 11); the time
			// left on the card (EQ 13).
			expect(
				await stack.panel.waitFor<string>(
					`document.getElementById("question-status").textContent`,
				),
			).toEndWith("asks to run page_place_order.");
			expect(
				await stack.panel.eval(
					`document.querySelector("[data-question] .countdown").textContent`,
				),
			).toMatch(/^(59|60) s left to answer; no answer is Don't allow\.$/);
			await answerInPanel(stack, "allow");
			expect((await asked).isError).toBeFalsy();
			expect(await badge()).toBe("on");
			// Routed and answered: none was made.
			expect(await stack.worker.eval("globalThis.e2eCreated")).toEqual([]);
		});

		test("when a question goes, what moves up under the pointer cannot allow at once", async () => {
			const first = call(stack, "page_place_order", { item: "first" });
			await stack.panel.waitFor(
				`document.querySelectorAll("[data-question]").length === 1`,
			);
			// A question that came moved everything below it down: the tools'
			// switches wait too (ES 5).
			expect(
				await stack.panel.eval(
					`[...document.querySelectorAll("input.ask-first")].map((b) => b.getAttribute("aria-disabled"))`,
				),
			).toEqual(["true"]);
			const second = call(stack, "page_place_order", { item: "second" });
			await stack.panel.waitFor(
				`document.querySelectorAll("[data-question]").length === 2`,
			);
			await stack.panel.send("Emulation.setFocusEmulationEnabled", {
				enabled: true,
			});
			const top = `document.querySelector('[data-question] button[data-answer="allow"]')`;
			await stack.panel.waitFor(
				`${top}.getAttribute("aria-disabled") !== "true"`,
			);
			await stack.panel.eval(`${top}.id = "e2e-answer"`);
			await stack.panel.click("#e2e-answer");
			expect((await first).isError).toBeFalsy();
			await stack.panel.waitFor(
				`document.querySelectorAll("[data-question]").length === 1`,
			);
			// The question left, and the tools' switches, wait again.
			expect(
				await stack.panel.eval(
					`[...document.querySelectorAll('[data-question] button[data-answer]:not([data-answer="deny"]), input.ask-first')].map((b) => b.getAttribute("aria-disabled"))`,
				),
			).toEqual(["true", "true", "true"]);
			// A click on the waiting switch changes nothing.
			await stack.panel.click(askFirst("place_order"));
			await Bun.sleep(300);
			expect(await stack.panel.eval(asksFirst("place_order", true))).toBe(true);
			await stack.panel.waitFor(
				`![...document.querySelectorAll("input.ask-first")].some((b) => b.getAttribute("aria-disabled") === "true")`,
			);
			const allowedTools = (await kvAll(stack.worker))["allowedTools"] as
				| Record<string, string[]>
				| undefined;
			expect(allowedTools?.[SITE] ?? []).not.toContain("place_order");
			await answerInPanel(stack, "deny");
			expect((await second).isError).toBe(true);
		});

		test("a panel closed during a question hands it to a notification", async () => {
			const asked = call(stack, "page_place_order", { item: "handed" });
			await stack.panel.waitFor(`document.querySelector("[data-question]")`);
			await closePanel(stack);
			const id = await newNotification(stack);
			// After the guard against an Allow that came too soon.
			await Bun.sleep(600);
			await clickNotification(stack, id, 0);
			const result = await asked;
			expect(result.isError).toBeFalsy();
			expect(result.content[0]?.text).toContain("handed");
			// Answered: the notification is gone.
			expect(await notifications(stack)).toEqual([]);
		});

		test("with the panel closed the AI app still calls the page's tools", async () => {
			const result = await call(stack, "page_get_greeting", { name: "Cy" });
			expect(result.content).toEqual([{ type: "text", text: "Hello, Cy!" }]);
			expect(await badge()).toBe("on");
		});

		test("with the panel closed a question is a notification: Allow, closing it, late clicks, no second button", async () => {
			const denied = call(stack, "page_place_order", { item: "no" });
			const first = await newNotification(stack);
			expect(await badge()).toBe("?");
			expect(
				await stack.worker.eval(
					`chrome.notifications.getAll().then((all) => Object.keys(all).length)`,
				),
			).toBe(1);
			// Don't allow is closing it.
			await stack.worker.eval(
				`tabMcpNotificationDismissed(${JSON.stringify(first)})`,
			);
			const no = await denied;
			expect(no.isError).toBe(true);
			expect(
				await stack.tab.eval("window.calls.map((c) => c[1])"),
			).not.toContain("no");
			// A click on a notification whose call is settled answers nothing.
			const allowed = call(stack, "page_place_order", { item: "yes" });
			const second = await newNotification(stack, [first]);
			await Bun.sleep(600);
			await clickNotification(stack, first, 0);
			await Bun.sleep(200);
			expect(await notifications(stack)).toEqual([second]);
			await clickNotification(stack, second, 0);
			expect((await allowed).content[0]?.text).toContain("yes");
			// Allow is its only button: allowing a tool on the site needs the
			// whole question (the panel or the question's window). A second
			// button counts as nothing.
			await stack.worker.eval(`(() => {
				globalThis.e2eButtons = [];
				const create = chrome.notifications.create.bind(chrome.notifications);
				chrome.notifications.create = (id, options) => {
					globalThis.e2eButtons.push(options.buttons.map((b) => b.title));
					return create(id, options);
				};
			})()`);
			const once = call(stack, "page_place_order", { item: "once" });
			const third = await newNotification(stack, [first, second]);
			expect(await stack.worker.eval("globalThis.e2eButtons")).toEqual([
				["Allow once"],
			]);
			await Bun.sleep(600);
			await clickNotification(stack, third, 1);
			await Bun.sleep(200);
			expect(await notifications(stack)).toEqual([third]);
			await clickNotification(stack, third, 0);
			expect((await once).isError).toBeFalsy();
			// Allowed once: the next call asks again.
			const again = call(stack, "page_place_order", { item: "again" });
			const fourth = await newNotification(stack, [first, second, third]);
			await stack.worker.eval(
				`tabMcpNotificationDismissed(${JSON.stringify(fourth)})`,
			);
			expect((await again).isError).toBe(true);
			expect(await notifications(stack)).toEqual([]);
		});

		test("a click on a notification's body shows the whole question; closing that window is Don't allow", async () => {
			await stack.tab.goto(`${SITE}/webmcp.html`);
			await call(stack, "webmcp_tools");
			// What the notifications say.
			await stack.worker.eval(`(() => {
				globalThis.e2eMessages = [];
				const create = chrome.notifications.create.bind(chrome.notifications);
				chrome.notifications.create = (id, options) => {
					globalThis.e2eMessages.push(options.message);
					return create(id, options);
				};
			})()`);
			const item = `long ${"z".repeat(6000)} end`;
			const asked = call(stack, "page_place_order", { item });
			const id = await newNotification(stack);
			const [text] = await stack.worker.eval<string[]>(
				"globalThis.e2eMessages",
			);
			expect(text).toEndWith("Arguments cut: click to see them in full.");
			// The DevTools Protocol gives no user gesture (Chrome gives one to a
			// real click on a notification): sidePanel.open is refused here, so
			// the question opens in a window of its own.
			expect(
				await stack.worker.eval(
					`chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => chrome.sidePanel.open({ tabId: t.id, windowId: t.windowId })).then(() => "opened", (e) => e.message)`,
				),
			).toContain("user gesture");
			const questionUrl = `chrome-extension://${stack.browser.extensionId}/question/index.html`;
			await stack.worker.eval(
				`tabMcpNotificationClicked(${JSON.stringify(id)})`,
			);
			const popup = await stack.browser.attach(
				(await stack.browser.waitForTarget((t) => t.url === questionUrl))
					.targetId,
			);
			await popup.waitFor(`document.querySelector("[data-question] pre")`);
			// The notification went; the question waits in the window, whole.
			expect(await notifications(stack)).toEqual([]);
			const shown = await popup.eval<string[]>(
				`[...document.querySelectorAll("[data-question] p, [data-question] pre")].map((e) => e.textContent)`,
			);
			expect(shown).toContain(`Site (verified) ${SITE}`);
			expect(shown).toContain("Title (from the page) place_order");
			expect(JSON.parse(shown.find((t) => t.startsWith("{")) ?? "")).toEqual({
				item,
			});
			// The arguments scroll.
			expect(
				await popup.eval(
					`(() => { const pre = document.querySelector("[data-question] pre"); return pre.scrollHeight > pre.clientHeight && getComputedStyle(pre).overflowY; })()`,
				),
			).toBe("auto");
			// The panel's look (DEC-160): on paper, the question a sheet, and
			// nothing past the window's edge, whatever the arguments are.
			expect(
				await popup.eval(`(() => {
					const root = document.scrollingElement;
					const token = (name) => {
						const probe = document.createElement("i");
						probe.style.color = "var(" + name + ")";
						document.body.append(probe);
						const colour = getComputedStyle(probe).color;
						probe.remove();
						return colour;
					};
					return [
						getComputedStyle(document.body).backgroundColor === token("--paper"),
						getComputedStyle(document.querySelector("[data-question]")).backgroundColor === token("--sheet"),
						root.scrollWidth <= root.clientWidth,
					];
				})()`),
			).toEqual([true, true, true]);
			// Its closing after the click answers nothing: the question waits.
			await stack.worker.eval(
				`tabMcpNotificationDismissed(${JSON.stringify(id)})`,
			);
			await Bun.sleep(200);
			expect(
				await popup.eval(`document.querySelectorAll("[data-question]").length`),
			).toBe(1);
			expect(await stack.tab.eval("window.calls.length")).toBe(0);
			await popup.send("Emulation.setFocusEmulationEnabled", { enabled: true });
			const allow = `document.querySelector('[data-question] button[data-answer="allow"]')`;
			await popup.waitFor(`${allow}.getAttribute("aria-disabled") !== "true"`);
			await popup.click(`[data-question] button[data-answer="allow"]`);
			const result = await asked;
			expect(result.isError).toBeFalsy();
			expect(result.content[0]?.text).toContain("end");
			// Answered: its window closes.
			const end = Date.now() + 5000;
			for (;;) {
				const { targetInfos } = (await stack.browser.send(
					"Target.getTargets",
				)) as { targetInfos: { url: string }[] };
				if (!targetInfos.some((t) => t.url === questionUrl)) break;
				if (Date.now() > end) throw new Error("the question window stayed");
				await Bun.sleep(100);
			}
			// Again, and the window closed by the user: Don't allow.
			const declined = call(stack, "page_place_order", { item: "closed" });
			const second = await newNotification(stack, [id]);
			await stack.worker.eval(
				`tabMcpNotificationClicked(${JSON.stringify(second)})`,
			);
			const target = await stack.browser.waitForTarget(
				(t) => t.url === questionUrl,
			);
			const popup2 = await stack.browser.attach(target.targetId);
			await popup2.waitFor(`document.querySelector("[data-question]")`);
			await stack.browser.send("Target.closeTarget", {
				targetId: target.targetId,
			});
			expect((await declined).isError).toBe(true);
			expect(
				await stack.tab.eval("window.calls.map((c) => c[1])"),
			).not.toContain("closed");
		});

		test("reopening the panel shows the same connection", async () => {
			stack.panel = await openPanel(stack.browser, stack.tab);
			// Connected all along: on (the test's AI app listed) or waiting
			// for one, never connecting again.
			const status = await stack.panel.waitFor<string>(
				`["on", "waiting"].includes(document.getElementById("state").dataset.state) && document.getElementById("state").dataset.state`,
			);
			const grants = await stack.panel.eval<string[]>(
				`[...document.querySelectorAll("#grants .app-name")].map((s) => s.textContent)`,
			);
			expect(grants).toEqual(status === "on" ? ["Test client"] : []);
			// The same address: shown with the code (at once with no app paired,
			// else after "+ Add another AI app").
			if (status === "on") await stack.panel.click("#add-app");
			await stack.panel.waitFor(
				`document.getElementById("address").textContent === ${JSON.stringify(stack.address)}`,
			);
			if (status === "on") await stack.panel.click("#pair-done");
			expect(
				await stack.panel.eval(
					`document.getElementById("tab-title").textContent`,
				),
			).toBe("Page with WebMCP tools");
		});

		test("a panel covered by another extension's panel for the tab hands its questions to notifications", async () => {
			const { browser } = stack;
			const { id: other } = (await browser.send("Extensions.loadUnpacked", {
				path: join(import.meta.dir, "other-extension"),
			})) as { id: string };
			await (await browser.serviceWorker(other)).eval("true");
			// A new page, as the user would have it.
			await stack.tab.goto(`${SITE}/webmcp.html`);
			// webmcp_tools reads the page again: its tools are registered anew.
			await call(stack, "webmcp_tools");
			// Asked while our panel is on screen: there, no notification.
			const first = call(stack, "page_place_order", { item: "covered" });
			await stack.panel.waitFor(`document.querySelector("[data-question]")`);
			expect(await notifications(stack)).toEqual([]);
			// The other extension's panel for this tab covers ours.
			await browser.clickIcon(stack.tab, other);
			await stack.panel.waitFor(`document.visibilityState === "hidden"`);
			const handed = await newNotification(stack);
			await Bun.sleep(600);
			await clickNotification(stack, handed, 0);
			expect((await first).content[0]?.text).toContain("covered");
			// Asked while covered: a notification at once.
			const second = call(stack, "page_place_order", { item: "hidden" });
			const asked = await newNotification(stack, [handed]);
			await Bun.sleep(600);
			await clickNotification(stack, asked, 0);
			expect((await second).content[0]?.text).toContain("hidden");
			// Ours in front again.
			await browser.clickIcon(stack.tab);
			await stack.panel.waitFor(`document.visibilityState === "visible"`);
		});
	},
);

describe.skipIf(chrome === undefined)(
	"panel commands, and the address taken over",
	() => {
		let stack: Stack;

		beforeAll(async () => {
			stack = await start({ store: false }, `${SITE}/webmcp.html`);
		}, 60_000);

		afterAll(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		const stored = async <T>(key: string) =>
			((await kvAll(stack.worker))[key] ?? null) as T;

		test("commands run one after another: a connect then a stop ends off, two allowed writes both hold", async () => {
			await stack.panel.eval(`(async () => {
				const port = chrome.runtime.connect({ name: "panel" });
				port.postMessage({ type: "connect" });
				port.postMessage({ type: "stop" });
				for (const name of ["a", "b"])
					port.postMessage({ type: "set-allowed", origin: "${SITE}", name, on: true });
				await new Promise((resolve) => setTimeout(resolve, 1500));
				port.disconnect();
			})()`);
			expect(await stored<boolean>("aiOn")).toBe(false);
			await stack.panel.waitFor(
				`document.getElementById("state").dataset.state === "off"`,
			);
			expect(
				(await stored<Record<string, string[]>>("allowedTools"))[SITE],
			).toEqual(["a", "b"]);
		});

		test("a takeover is kept across a restart: no taking the address back by itself, the notice stays", async () => {
			await stack.panel.click("#connect");
			// The AI app (the test's client) is paired by now: the card lists it
			// and keeps the address out of sight until "+ Add another AI app".
			await stack.panel.waitFor(
				`document.getElementById("state").dataset.state === "on"`,
				15_000,
			);
			expect(
				await stack.panel.eval(
					`[document.getElementById("state-text").textContent, document.getElementById("pairing").hidden, document.getElementById("add-app").hidden, document.querySelector("#grants button")?.textContent]`,
				),
			).toEqual(["Connected · Test client", true, false, "Disconnect"]);
			// The row shows the state (a green dot), Disconnect is a button
			// with an outline, not grey text that reads as a state.
			expect(
				await stack.panel.eval(`(() => {
					const dot = document.querySelector("#grants .app .dot");
					const button = document.querySelector("#grants button");
					return [
						dot !== null && getComputedStyle(dot).backgroundColor !== "rgba(0, 0, 0, 0)",
						button.classList.contains("quiet"),
						getComputedStyle(button).borderTopStyle,
					];
				})()`),
			).toEqual([true, false, "solid"]);
			// Off: the app stays paired, its dot grey, the list "Paired".
			const appRow = () =>
				stack.panel.eval<[number, boolean, string | null, string]>(`(() => {
					const list = document.getElementById("grants");
					const dot = list.querySelector(".dot");
					return [
						list.querySelectorAll("li").length,
						dot?.classList.contains("on") ?? false,
						list.getAttribute("aria-label"),
						dot ? getComputedStyle(dot).backgroundColor : "",
					];
				})()`);
			const [, , , green] = await appRow();
			await stack.panel.click("#ai-switch");
			await stack.panel.waitFor(
				`document.getElementById("state").dataset.state === "off"`,
			);
			const off = await appRow();
			expect(off.slice(0, 3)).toEqual([1, false, "Paired AI apps"]);
			expect(off[3]).not.toBe(green);
			// No Disconnect while off: only the relay can disconnect an app,
			// and the panel says so (EQ 8).
			const offView = () =>
				stack.panel.eval(
					`[document.getElementById("state-text").textContent, document.querySelectorAll("#grants li").length, document.querySelectorAll("#grants button").length, document.getElementById("grants-note").hidden, document.getElementById("grants-note").textContent]`,
				);
			const expectedOff = [
				"AI access is off · paired apps stay paired",
				1,
				0,
				false,
				"Turn on AI access to disconnect an app.",
			];
			expect(await offView()).toEqual(expectedOff);
			// A new worker (an update, or the old one stopped while idle) still
			// lists the app: kept from the relay's last list.
			await restartWorker();
			stack.panel = await openPanel(stack.browser, stack.tab);
			await stack.panel.waitFor(
				`document.querySelectorAll("#grants li").length === 1`,
			);
			expect(await offView()).toEqual(expectedOff);
			expect(await stored("grants")).toEqual([
				{
					grantId: expect.any(String),
					name: "Test client",
					host: expect.any(String),
				},
			]);
			await stack.panel.click("#connect");
			await stack.panel.waitFor(
				`document.getElementById("state").dataset.state === "on"`,
				15_000,
			);
			expect((await appRow()).slice(0, 3)).toEqual([
				1,
				true,
				"Connected AI apps",
			]);
			await stack.panel.click("#add-app");
			await stack.panel.waitFor(
				`document.getElementById("address").textContent === ${JSON.stringify(stack.address)} && !document.getElementById("pair-done").hidden`,
			);
			await stack.panel.click("#pair-done");
			await stack.panel.waitFor(`document.getElementById("pairing").hidden`);
			// Disconnect asks first: one click only arms it, and the second
			// click of a double click does not confirm it.
			await stack.panel.click("#grants button");
			await stack.panel.click("#grants button");
			// The list is drawn anew, and the focus stays on the app's button:
			// a keyboard user's second Enter finds it.
			expect(
				await stack.panel.eval(
					`[document.querySelector("#grants button")?.textContent, document.querySelectorAll("#grants li").length, document.activeElement === document.querySelector("#grants button")]`,
				),
			).toEqual(["Disconnect? Click again", 1, true]);
			// Armed, it is another button to the eye too: filled in red.
			expect(
				await stack.panel.eval(`(() => {
					const button = document.querySelector("#grants button");
					const probe = document.createElement("i");
					probe.style.color = "var(--danger)";
					document.body.append(probe);
					const danger = getComputedStyle(probe).color;
					probe.remove();
					return [button.hasAttribute("data-armed"), getComputedStyle(button).borderTopColor === danger];
				})()`),
			).toEqual([true, true]);
			await Bun.sleep(800);
			for (const type of ["keyDown", "keyUp"])
				await stack.panel.send("Input.dispatchKeyEvent", {
					type,
					key: "Enter",
					code: "Enter",
					windowsVirtualKeyCode: 13,
					...(type === "keyDown" ? { text: "\r" } : {}),
				});
			await stack.panel.waitFor(
				`document.querySelectorAll("#grants li").length === 0 && document.getElementById("state").dataset.state === "waiting"`,
			);
			// Another program with a copy of the address secret takes it over.
			const secrets = Object.fromEntries(
				Object.entries(await kvAll(stack.worker)).filter(([k]) =>
					k.startsWith("tab-mcp:secret:"),
				),
			) as Record<string, string>;
			const impostor = new TabMcp({
				relay: stack.relay.url,
				server: { name: "tab-mcp-for-chrome", version: "1.0.0" },
				storage: {
					getItem: (key) => secrets[key] ?? null,
					setItem: () => {},
				},
			});
			try {
				expect((await impostor.connect({ resume: true })).address).toBe(
					stack.address,
				);
				await stack.panel.waitFor(
					`!document.getElementById("replaced").hidden`,
				);
				expect(await stored("replaced")).toEqual({ sibling: false });
				// A notification a worker leaves behind answers nothing after it.
				await stack.worker.eval(
					`chrome.notifications.create("e2e-stale", { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon-128.png"), title: "stale", message: "stale" })`,
				);
				// The extension restarts (an update, a reload).
				await stack.browser.send("Extensions.loadUnpacked", {
					path: stack.extension,
				});
				await Bun.sleep(1000);
				stack.worker = await stack.browser.serviceWorker(
					stack.browser.extensionId as string,
				);
				await stack.worker.eval("true");
				// The alarm comes: still nothing taken back.
				await stack.worker.eval(
					`chrome.alarms.create("tab-mcp-keepup", { when: Date.now() + 50 })`,
				);
				await Bun.sleep(1500);
				expect(impostor.state).toBe("connected");
				expect(await notifications(stack)).toEqual([]);
				// The panel shows the notice from what was kept.
				stack.panel = await openPanel(stack.browser, stack.tab);
				await stack.panel.waitFor(
					`!document.getElementById("replaced").hidden`,
				);
				expect(
					await stack.panel.eval(
						`document.getElementById("state").dataset.state`,
					),
				).toBe("off");
				// New address: the old one is taken back, then a new one made.
				await stack.panel.click("#replaced-new-address");
				const fresh = await stack.panel.waitFor<string>(
					`(() => { const a = document.getElementById("address").textContent; return a && a !== ${JSON.stringify(stack.address)} && a; })()`,
					15_000,
				);
				expect(fresh).not.toBe(stack.address);
				expect(impostor.state).toBe("disconnected");
				expect(await stored("replaced")).toBeNull();
				expect(
					await stack.panel.eval(`document.getElementById("replaced").hidden`),
				).toBe(true);
			} finally {
				await impostor.disconnect();
			}
		});

		/** Reload the extension (an update): the worker starts again. */
		async function restartWorker(): Promise<void> {
			await stack.browser.send("Extensions.loadUnpacked", {
				path: stack.extension,
			});
			await Bun.sleep(1000);
			stack.worker = await stack.browser.serviceWorker(
				stack.browser.extensionId as string,
			);
			await stack.worker.eval("true");
		}

		test("the database deleted under the worker: the next write opens it again, and it holds across a start", async () => {
			// The test before reloaded the extension: the worker may have restarted.
			stack.worker = await stack.browser.serviceWorker(
				stack.browser.extensionId as string,
			);
			stack.panel = await openPanel(stack.browser, stack.tab);
			// The site data cleared, say: the worker's connection is asked to
			// close, and closes.
			await stack.worker.eval(`new Promise((resolve, reject) => {
				const deleting = indexedDB.deleteDatabase("tab-mcp");
				deleting.onsuccess = () => resolve(true);
				deleting.onerror = () => reject(deleting.error);
			})`);
			// A write after it: the worker opens the database again (made anew).
			await stack.panel.eval(`(async () => {
				const port = chrome.runtime.connect({ name: "panel" });
				port.postMessage({ type: "set-allowed", origin: "${SITE}", name: "place_order", on: true });
				await new Promise((resolve) => setTimeout(resolve, 300));
				port.disconnect();
			})()`);
			const end = Date.now() + 10_000;
			let kv = await kvAll(stack.worker);
			while (kv["allowedTools"] === undefined) {
				if (Date.now() > end)
					throw new Error(`no write after the reopen: ${JSON.stringify(kv)}`);
				await Bun.sleep(100);
				kv = await kvAll(stack.worker);
			}
			expect(kv["allowedTools"]).toEqual({ [SITE]: ["place_order"] });
			// It holds across the next start.
			await restartWorker();
			expect((await kvAll(stack.worker))["allowedTools"]).toEqual({
				[SITE]: ["place_order"],
			});
		});
	},
);

describe.skipIf(chrome === undefined)("a restart", () => {
	test("the same profile connects again by itself, with the same address", async () => {
		const profile = mkdtempSync(join(tmpdir(), "tab-mcp-ext-profile-"));
		let stack: Stack | undefined;
		let again: Browser | undefined;
		try {
			stack = await start({ store: false, profile }, `${SITE}/plain.html`);
			expect((await pageInfo(stack)).isError).toBeFalsy();
			await stack.client.close();
			await stack.browser.close();
			// Chrome again, with the same profile and build; no click, no panel.
			again = await launch(stack.extension, profile);
			await again.newPage(`${SITE}/plain.html`);
			const end = Date.now() + 20_000;
			let client: Client | undefined;
			while (client === undefined) {
				client = await mcpClient(stack.relay, stack.address).catch(
					() => undefined,
				);
				if (client === undefined) {
					if (Date.now() > end)
						throw new Error("the address did not answer after the restart");
					await Bun.sleep(250);
				}
			}
			const result = (await client.callTool({
				name: "page_info",
			})) as CallResult;
			expect(result.structuredContent).toMatchObject({
				url: `${SITE}/plain.html`,
			});
			await client.close();
		} finally {
			await again?.close();
			await stack?.stop();
			rmSync(profile, { recursive: true, force: true });
		}
	}, 90_000);

	test("with the relay out of reach at a start, it keeps trying: the alarm is set and the panel says so (EQ 3, EQ 14)", async () => {
		const profile = mkdtempSync(join(tmpdir(), "tab-mcp-ext-profile-"));
		let stack: Stack | undefined;
		let again: Browser | undefined;
		try {
			stack = await start({ store: false, profile }, `${SITE}/plain.html`);
			await stack.client.close();
			// As after an update, which clears the alarms.
			await stack.worker.eval(`chrome.alarms.clear("tab-mcp-keepup")`);
			await stack.browser.close();
			// The relay is gone; Chrome starts again with AI access left on.
			await stack.relay.stop();
			again = await launch(stack.extension, profile);
			const tab = await again.newPage(`${SITE}/plain.html`);
			const worker = await again.serviceWorker(again.extensionId as string);
			const end = Date.now() + 10_000;
			while (
				!(await worker.eval<boolean>(
					`chrome.alarms.get("tab-mcp-keepup").then((a) => a?.periodInMinutes === 1)`,
				))
			) {
				if (Date.now() > end)
					throw new Error("no keep-up alarm after the start");
				await Bun.sleep(100);
			}
			const panel = await openPanel(again, tab);
			// Not "off": the switch stays on, and the alarm brings it back.
			await panel.waitFor(
				`document.getElementById("state").dataset.state === "retrying"`,
			);
			expect(
				await panel.eval(`document.getElementById("ai-switch").checked`),
			).toBe(true);
			expect(
				await panel.eval(`document.getElementById("connect").hidden`),
			).toBe(true);
		} finally {
			await again?.close();
			await stack?.stop().catch(() => {});
			rmSync(profile, { recursive: true, force: true });
		}
	}, 90_000);
});

/**
 * Whether the service worker keeps running on a quiet connection (only the
 * relay's heartbeat), with nothing attached to it: DevTools keeps a worker
 * alive, so the test lets go of it first. And, for comparison, that it stops
 * once AI access is off. Over two minutes, so only with TAB_MCP_E2E_IDLE=1.
 */
describe.skipIf(chrome === undefined || !process.env["TAB_MCP_E2E_IDLE"])(
	"the service worker on a quiet connection",
	() => {
		/** Whether the worker runs, without attaching to it. */
		async function workerRuns(browser: Browser): Promise<boolean> {
			const { targetInfos } = (await browser.send("Target.getTargets")) as {
				targetInfos: { type: string; url: string }[];
			};
			return targetInfos.some(
				(t) =>
					t.type === "service_worker" &&
					t.url.startsWith(`chrome-extension://${browser.extensionId}/`),
			);
		}

		/** Whether the worker ran all through `ms`, looked at every 5 s. */
		async function runsThrough(browser: Browser, ms: number): Promise<boolean> {
			const end = Date.now() + ms;
			while (Date.now() < end) {
				if (!(await workerRuns(browser))) return false;
				await Bun.sleep(5_000);
			}
			return workerRuns(browser);
		}

		test("it keeps running while connected, and stops once AI access is off", async () => {
			const stack = await start({ store: false }, `${SITE}/webmcp.html`);
			try {
				await closePanel(stack);
				await stack.browser.detachServiceWorkers();
				expect(await runsThrough(stack.browser, 70_000)).toBe(true);
				const result = await pageInfo(stack);
				expect(result.isError).toBeFalsy();
				// Off: nothing keeps the worker; Chrome stops it after 30 s idle.
				stack.panel = await openPanel(stack.browser, stack.tab);
				await stack.panel.click("#ai-switch");
				await stack.panel.waitFor(
					`document.getElementById("state").dataset.state === "off"`,
				);
				stack.worker = await stack.browser.serviceWorker(
					stack.browser.extensionId as string,
				);
				await closePanel(stack);
				await stack.browser.detachServiceWorkers();
				expect(await runsThrough(stack.browser, 70_000)).toBe(false);
			} finally {
				await stack.client.close();
				await stack.stop();
			}
		}, 200_000);
	},
);

describe.skipIf(chrome === undefined)(
	"the store package (no host access)",
	() => {
		let stack: Stack;
		let tab: Page;

		beforeAll(async () => {
			stack = await start({ store: true }, `${SITE}/plain.html`);
			tab = stack.tab;
		}, 60_000);

		afterAll(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		test("the tab the icon was clicked on can be read", async () => {
			expect((await pageInfo(stack)).structuredContent).toMatchObject({
				url: `${SITE}/plain.html`,
			});
		});

		test("on the same origin after a navigation too (Chrome keeps the grant)", async () => {
			await tab.goto(`${SITE}/webmcp.html`);
			expect((await pageInfo(stack)).structuredContent).toMatchObject({
				url: `${SITE}/webmcp.html`,
				webmcp: { available: true, tools: 5 },
			});
		});

		test("another origin of the same site needs a click too", async () => {
			await tab.goto(`${SUBDOMAIN}/plain.html`);
			const refused = await pageInfo(stack);
			expect(refused.isError).toBe(true);
			expect(refused.content[0]?.text).toContain("may not read this tab yet");
			// The panel in its own words: the toolbar icon, or host access,
			// whose button is explained before Chrome's prompt (EQ 6, EQ 9).
			await stack.panel.waitFor(
				`document.getElementById("tab-badges").textContent === "Not readable"`,
			);
			const [access, hidden, button] = await stack.panel.eval<
				[string, boolean, string]
			>(
				`[document.getElementById("tab-access").textContent, document.getElementById("host-access").hidden, document.getElementById("allow-all").textContent]`,
			);
			// Chrome reports the address of this tab or hides it, depending on
			// when it is asked; hidden, the line adds that browser pages cannot
			// be read either.
			expect(access).toStartWith(
				"Click the tab-mcp icon in Chrome's toolbar to let it read this tab.",
			);
			expect([hidden, button]).toEqual([
				false,
				"Read all sites without a click",
			]);
			await stack.browser.clickIcon(tab);
			expect((await pageInfo(stack)).structuredContent).toMatchObject({
				url: `${SUBDOMAIN}/plain.html`,
			});
		});

		test("on another site it may not, until the next click there", async () => {
			await tab.goto(`${OTHER}/webmcp.html`);
			const refused = await pageInfo(stack);
			expect(refused.isError).toBe(true);
			expect(refused.content[0]?.text).toContain("may not read this tab yet");
			// No page tools, and webmcp_tools says why.
			const listed = await call(stack, "webmcp_tools");
			expect(listed.structuredContent?.["error"]).toContain(
				"may not read this tab yet",
			);
			expect(await toolNames(stack)).toEqual(OWN_TOOLS);
			await stack.browser.clickIcon(tab);
			expect((await pageInfo(stack)).structuredContent).toMatchObject({
				url: `${OTHER}/webmcp.html`,
				webmcp: { available: true, tools: 5 },
			});
			// After the click its tools are offered (the content script says so).
			await waitForTools(stack, (n) => n.includes("page_get_greeting"));
		});

		test("a click shows the panel over another extension's panel for the tab, and gives the tab's tools", async () => {
			const { browser } = stack;
			const { id: other } = (await browser.send("Extensions.loadUnpacked", {
				path: join(import.meta.dir, "other-extension"),
			})) as { id: string };
			await (await browser.serviceWorker(other)).eval("true");
			// A new tab, so no click has granted anything there yet.
			const page = await browser.newPage(`${SITE}/webmcp.html`);
			/** Whether the panel at `url` is the one on screen. */
			const shown = async (url: string) => {
				const target = await browser.waitForTarget((t) => t.url === url);
				return (await browser.attach(target.targetId)).eval<string>(
					"document.visibilityState",
				);
			};
			const otherPanel = `chrome-extension://${other}/panel.html`;
			await browser.clickIcon(page, other);
			await stack.panel.waitFor(`document.visibilityState === "hidden"`);
			expect(await shown(otherPanel)).toBe("visible");
			// Chrome kept the other panel when ours was opened for the window only.
			await browser.clickIcon(page);
			await stack.panel.waitFor(`document.visibilityState === "visible"`);
			expect(await shown(otherPanel)).toBe("hidden");
			expect((await pageInfo(stack)).structuredContent).toMatchObject({
				url: `${SITE}/webmcp.html`,
				webmcp: { available: true, tools: 5 },
			});
			await waitForTools(stack, (n) => n.includes("page_get_greeting"));
		});
	},
);

/** The address of the page in `stack`'s tab. */
const tabUrl = (stack: Stack) => stack.tab.eval<string>("location.href");

/** The texts of the newest question card in the panel. */
const questionLines = (stack: Stack) =>
	stack.panel.eval<string[]>(
		`[...[...document.querySelectorAll("[data-question]")].at(-1).querySelectorAll("p.ask, p.line")].map((p) => p.textContent)`,
	);

/** No question waits in the panel. */
const noQuestion = async (stack: Stack) =>
	expect(
		await stack.panel.eval<number>(
			"document.querySelectorAll('[data-question]').length",
		),
	).toBe(0);

describe.skipIf(chrome === undefined)(
	"navigation (iteration 27, test build)",
	() => {
		let stack: Stack;

		beforeAll(async () => {
			stack = await start({ store: false }, `${SITE}/plain.html`);
		}, 60_000);

		afterAll(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		test("navigate on the page's origin runs at once, with the new page's page_info and tools", async () => {
			const result = await call(stack, "navigate", { url: "/webmcp.html" });
			expect(result.isError).toBeFalsy();
			expect(result.structuredContent).toMatchObject({
				url: `${SITE}/webmcp.html`,
				title: "Page with WebMCP tools",
				webmcp: { available: true, tools: 5 },
			});
			await waitForTools(stack, (n) => n.includes("page_get_greeting"));
			await noQuestion(stack);
		});

		test("only http(s) addresses; the tab stays", async () => {
			for (const url of [
				"javascript:alert(1)",
				"data:text/html,x",
				"chrome://settings",
				"file:///etc/hosts",
			]) {
				const refused = await call(stack, "navigate", { url });
				expect(refused.isError).toBe(true);
				expect(refused.content[0]?.text).toContain("Only http and https");
			}
			expect(await tabUrl(stack)).toBe(`${SITE}/webmcp.html`);
		});

		test("to another origin it asks in the side panel, without Don't ask again: Don't allow stays, Allow goes", async () => {
			const declined = call(stack, "navigate", { url: `${OTHER}/plain.html` });
			await stack.panel.waitFor(`document.querySelector("[data-question]")`);
			const [ask, ...lines] = await questionLines(stack);
			expect(ask).toEndWith(
				" wants to take the tab to another site (navigate).",
			);
			expect(lines).toEqual([
				`From (verified) ${SITE}`,
				`To ${OTHER}/plain.html`,
			]);
			expect(
				await stack.panel.eval<boolean>(
					`!!document.querySelector('[data-question] button[data-answer="site"]')`,
				),
			).toBe(false);
			await answerInPanel(stack, "deny");
			const result = await declined;
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("did not allow");
			expect(await tabUrl(stack)).toBe(`${SITE}/webmcp.html`);
			const allowed = call(stack, "navigate", { url: `${OTHER}/plain.html` });
			await answerInPanel(stack, "allow");
			// With host access the new page is read.
			expect((await allowed).structuredContent).toMatchObject({
				url: `${OTHER}/plain.html`,
				title: "Plain page",
			});
		});

		test("back to another origin asks too, its address not known", async () => {
			const back = call(stack, "go_back");
			await stack.panel.waitFor(`document.querySelector("[data-question]")`);
			const lines = await questionLines(stack);
			expect(lines[1]).toBe(`From (verified) ${OTHER}`);
			expect(lines[2]).toContain("previous page");
			expect(lines[2]).toContain("not known");
			await answerInPanel(stack, "allow");
			expect((await back).structuredContent).toMatchObject({
				url: `${SITE}/webmcp.html`,
			});
		});

		test("back and forward on the page's origin run at once", async () => {
			const back = await call(stack, "go_back");
			expect(back.structuredContent).toMatchObject({
				url: `${SITE}/plain.html`,
			});
			const forward = await call(stack, "go_forward");
			expect(forward.structuredContent).toMatchObject({
				url: `${SITE}/webmcp.html`,
			});
			await noQuestion(stack);
		});

		test("reload stays and never asks; within the page (#part) it answers at once", async () => {
			await stack.tab.eval("window.e2eMarker = 1");
			const reloaded = await call(stack, "reload");
			expect(reloaded.structuredContent).toMatchObject({
				url: `${SITE}/webmcp.html`,
			});
			expect(await stack.tab.eval("typeof window.e2eMarker")).toBe("undefined");
			const started = Date.now();
			const part = await call(stack, "navigate", { url: "#part" });
			expect(part.structuredContent).toMatchObject({
				url: `${SITE}/webmcp.html#part`,
			});
			expect(Date.now() - started).toBeLessThan(5_000);
			await noQuestion(stack);
		});
	},
);

describe.skipIf(chrome === undefined)(
	"navigation in the store package (no host access)",
	() => {
		let stack: Stack;

		beforeAll(async () => {
			stack = await start({ store: true }, `${SITE}/plain.html`);
		}, 60_000);

		afterAll(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		test("on the page's origin the click's access holds: the new page is read", async () => {
			const result = await call(stack, "navigate", {
				url: `${SITE}/webmcp.html`,
			});
			expect(result.structuredContent).toMatchObject({
				url: `${SITE}/webmcp.html`,
				webmcp: { available: true, tools: 5 },
			});
			await waitForTools(stack, (n) => n.includes("page_get_greeting"));
		});

		test("to another origin, once allowed, the result says the new page needs a click; then nothing more", async () => {
			const going = call(stack, "navigate", { url: `${OTHER}/plain.html` });
			await answerInPanel(stack, "allow");
			const result = await going;
			expect(result.isError).toBeFalsy();
			expect(result.structuredContent?.["readable"]).toBe(false);
			expect(String(result.structuredContent?.["reason"])).toContain(
				"may not read this tab yet",
			);
			expect(await tabUrl(stack)).toBe(`${OTHER}/plain.html`);
			// A tab the extension may not read is not navigated.
			for (const name of ["navigate", "go_back", "reload"]) {
				const refused = await call(stack, name, {
					...(name === "navigate" ? { url: `${OTHER}/webmcp.html` } : {}),
				});
				expect(refused.isError).toBe(true);
				expect(refused.content[0]?.text).toContain("may not read this tab yet");
			}
			expect(await tabUrl(stack)).toBe(`${OTHER}/plain.html`);
			// A click on the icon gives the new page, and its origin.
			await stack.browser.clickIcon(stack.tab);
			expect(
				(await call(stack, "navigate", { url: `${OTHER}/webmcp.html` }))
					.structuredContent,
			).toMatchObject({ url: `${OTHER}/webmcp.html` });
		});
	},
);
