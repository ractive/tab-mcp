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
	await panel.waitFor(`document.documentElement.dataset.relay`);
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
	// opened could land before the layout settled.
	await panel.eval(`document.getElementById("relay-form").requestSubmit()`);
	// The panel marks the relay the connection (in the worker) uses.
	await panel.waitFor(
		`document.documentElement.dataset.relay === ${JSON.stringify(relay)}`,
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

/** Chrome's answer to a content script that uses the closed storage area. */
const STORAGE_REFUSED = "Access to storage is not allowed from this context.";

/** The extension's own tools, sorted. */
const OWN_TOOLS = ["page_info", "webmcp_call", "webmcp_tools"];

const PAGE_TOOLS = [
	"page_get_greeting",
	"page_mcp_result",
	"page_place_order",
	"page_slow_tool",
];

/** Answer the newest question in the side panel with `answer`. */
async function answerInPanel(
	stack: Stack,
	answer: "allow" | "always" | "deny",
): Promise<void> {
	// Allow counts only once the panel has been focused a while.
	await stack.panel.send("Emulation.setFocusEmulationEnabled", {
		enabled: true,
	});
	const selector = `[...document.querySelectorAll('[data-question] button[data-answer="${answer}"]')].at(-1)`;
	await stack.panel.waitFor(`${selector} && !${selector}.disabled`, 10_000);
	await stack.panel.eval(`${selector}.id = "e2e-answer"`);
	await stack.panel.click("#e2e-answer");
	await stack.panel.eval(
		`document.getElementById("e2e-answer")?.removeAttribute("id")`,
	);
}

/** The worker's settings in its IndexedDB, read in the worker (`kv.ts`). */
const kvAll = (worker: Worker) =>
	worker.eval<Record<string, unknown>>(`new Promise((resolve, reject) => {
		const open = indexedDB.open("tab-mcp");
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const store = open.result.transaction("settings").objectStore("settings");
			const keys = store.getAllKeys();
			const values = store.getAll();
			values.onsuccess = () =>
				resolve(Object.fromEntries(keys.result.map((k, i) => [k, values.result[i]])));
			values.onerror = () => reject(values.error);
		};
	})`);

/** What is (still) in `chrome.storage.local`. */
const localAll = (worker: Worker) =>
	worker.eval<Record<string, unknown>>("chrome.storage.local.get(null)");

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
		const names = await waitForTools(stack, (n) => n.length >= 7);
		// mirrored_tool is the page's tab-mcp mirror: left out.
		expect(names).toEqual([...OWN_TOOLS, ...PAGE_TOOLS].sort());
		const { tools } = await stack.client.listTools();
		const byName = (name: string) => tools.find((t) => t.name === name);
		expect(byName("page_info")?.annotations?.readOnlyHint).toBe(true);
		const greeting = byName("page_get_greeting");
		expect(greeting?.description).toBe(`From ${SITE}: Greets a name.`);
		expect(greeting?.annotations?.readOnlyHint).toBe(true);
		expect(byName("page_place_order")?.annotations?.readOnlyHint).toBe(false);
	});

	test("a content script can neither read nor write the extension's storage", async () => {
		// The content script's world, where a page's compromised renderer
		// would run its code with the extension's APIs.
		const world = await tab.isolatedWorld("tab-mcp for Chrome");
		// The world is the content script's: it has the storage API.
		expect(await tab.eval("typeof chrome.storage?.local?.get", world)).toBe(
			"function",
		);
		const tries = await tab.eval<string[]>(
			`(async () => {
				const attempt = async (run) => {
					try {
						await run();
						return "allowed";
					} catch (error) {
						return "refused: " + error.message;
					}
				};
				return [
					await attempt(() => chrome.storage.local.get(null)),
					await attempt(() => chrome.storage.local.set({ allowedTools: { "https://evil.test": ["x"] } })),
				];
			})()`,
			world,
		);
		// Chrome's own refusal, not some other error.
		expect(tries).toEqual([
			`refused: ${STORAGE_REFUSED}`,
			`refused: ${STORAGE_REFUSED}`,
		]);
		expect(await localAll(stack.worker)).toEqual({});
		// And the settings are in IndexedDB, in the extension's origin, which
		// a content script (in the page's origin) cannot open at all.
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

	test("webmcp_tools lists them, and what is left out", async () => {
		const result = await call(stack, "webmcp_tools");
		expect(result.structuredContent).toMatchObject({
			origin: SITE,
			available: true,
			mirrored: ["mirrored_tool"],
		});
		const tools = result.structuredContent?.["tools"] as {
			name: string;
			tool?: string;
			readOnly: boolean;
		}[];
		expect(tools.map((t) => t.tool).sort()).toEqual(PAGE_TOOLS);
		expect(tools.find((t) => t.name === "place_order")?.readOnly).toBe(false);
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
		// "Always allow" is offered too (forgotten when the page changes, as
		// the bridge then registers the tool anew).
		await stack.panel.waitFor(
			`document.querySelector('[data-question] button[data-answer="always"]')`,
		);
		await answerInPanel(stack, "allow");
		const result = await allowed;
		expect(result.isError).toBeFalsy();
		expect(result.content[0]?.text).toContain("tea");
		const declined = call(stack, "page_place_order", { item: "coffee" });
		await answerInPanel(stack, "deny");
		expect((await declined).isError).toBe(true);
		expect(await tab.eval("window.calls.map((c) => c[1])")).not.toContain(
			"coffee",
		);
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

	test("a tool switched to allowed in the panel runs without asking, for that site", async () => {
		const toggle = `button[data-tool="place_order"]`;
		// Off for a moment after the last question went (the layout moved).
		await stack.panel.waitFor(
			`document.querySelector('${toggle}') && !document.querySelector('${toggle}').disabled`,
		);
		await stack.panel.click(toggle);
		await stack.panel.waitFor(
			`document.querySelector('${toggle}').textContent === "allowed"`,
		);
		const result = await call(stack, "page_place_order", { item: "allowed" });
		expect(result.isError).toBeFalsy();
		expect(await tab.eval("window.calls.at(-1)")).toEqual([
			"place_order",
			"allowed",
		]);
		// Switched back: it asks again.
		await stack.panel.click(toggle);
		await stack.panel.waitFor(
			`document.querySelector('${toggle}').textContent === "asks first"`,
		);
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

	test("it follows a navigation", async () => {
		await tab.goto(`${SITE}/plain.html`);
		const result = await pageInfo(stack);
		expect(result.structuredContent).toMatchObject({
			url: `${SITE}/plain.html`,
			title: "Plain page",
			webmcp: { available: true, tools: 0 },
		});
		expect(await waitForTools(stack, (n) => n.length === 3)).toEqual(OWN_TOOLS);
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
			const second = call(stack, "page_place_order", { item: "second" });
			await stack.panel.waitFor(
				`document.querySelectorAll("[data-question]").length === 2`,
			);
			await stack.panel.send("Emulation.setFocusEmulationEnabled", {
				enabled: true,
			});
			const top = `document.querySelector('[data-question] button[data-answer="allow"]')`;
			await stack.panel.waitFor(`!${top}.disabled`);
			await stack.panel.eval(`${top}.id = "e2e-answer"`);
			await stack.panel.click("#e2e-answer");
			expect((await first).isError).toBeFalsy();
			await stack.panel.waitFor(
				`document.querySelectorAll("[data-question]").length === 1`,
			);
			// The question left, and the tools' switches, wait again.
			expect(
				await stack.panel.eval(
					`[...document.querySelectorAll('[data-question] button[data-answer]:not([data-answer="deny"]), button.badge.toggle')].map((b) => b.disabled)`,
				),
			).toEqual([true, true, true]);
			await stack.panel.waitFor(
				`![...document.querySelectorAll("button.badge.toggle")].some((b) => b.disabled)`,
			);
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

		test("with the panel closed a question is a notification: Allow, closing it, late clicks, Always allow", async () => {
			const denied = call(stack, "page_place_order", { item: "no" });
			const first = await newNotification(stack);
			expect(await badge()).toBe("?");
			expect(
				await stack.worker.eval(
					`chrome.notifications.getAll().then((all) => Object.keys(all).length)`,
				),
			).toBe(1);
			// Don't allow is closing it (or a click on its body).
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
			// Always allow: the next call of the tool runs without asking.
			const always = call(stack, "page_place_order", { item: "always" });
			const third = await newNotification(stack, [first, second]);
			await Bun.sleep(600);
			await clickNotification(stack, third, 1);
			expect((await always).isError).toBeFalsy();
			const again = await call(stack, "page_place_order", { item: "again" });
			expect(again.content[0]?.text).toContain("again");
			expect(await notifications(stack)).toEqual([]);
		});

		test("reopening the panel shows the same connection", async () => {
			stack.panel = await openPanel(stack.browser, stack.tab);
			// Connected all along: on (the test's AI app listed) or waiting
			// for one, never connecting again.
			const status = await stack.panel.waitFor<string>(
				`["on", "waiting"].includes(document.getElementById("state").dataset.state) && document.getElementById("state").dataset.state`,
			);
			const grants = await stack.panel.eval<string[]>(
				`[...document.querySelectorAll("#grants li span:first-child")].map((s) => s.firstChild.textContent)`,
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
			// A new page: the Always allow of the test before is gone with it.
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
			expect(
				await stack.panel.eval(
					`[document.querySelector("#grants button")?.textContent, document.querySelectorAll("#grants li").length]`,
				),
			).toEqual(["Disconnect? Click again", 1]);
			await Bun.sleep(800);
			await stack.panel.click("#grants button");
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

		test("settings an older version kept in chrome.storage.local move to IndexedDB at the next start", async () => {
			const old = {
				"tab-mcp:secret:https://old.test:tab-mcp-for-chrome": "A".repeat(43),
				allowedTools: { "https://old.test": ["t"] },
			};
			// As the version before left them.
			await stack.worker.eval(
				`chrome.storage.local.set(${JSON.stringify(old)})`,
			);
			const before = (await kvAll(stack.worker))["allowedTools"];
			expect(before).toBeDefined();
			// The next start of the worker (an update).
			await stack.browser.send("Extensions.loadUnpacked", {
				path: stack.extension,
			});
			await Bun.sleep(1000);
			stack.worker = await stack.browser.serviceWorker(
				stack.browser.extensionId as string,
			);
			const end = Date.now() + 10_000;
			while (Object.keys(await localAll(stack.worker)).length > 0) {
				if (Date.now() > end) throw new Error("the old settings stayed");
				await Bun.sleep(100);
			}
			const kv = await kvAll(stack.worker);
			expect(kv["tab-mcp:secret:https://old.test:tab-mcp-for-chrome"]).toBe(
				"A".repeat(43),
			);
			// One that was already in IndexedDB is newer: kept.
			expect(kv["allowedTools"]).toEqual(before);
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
