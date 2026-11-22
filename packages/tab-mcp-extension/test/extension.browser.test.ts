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
 * Needs Chrome for Testing 156 or newer (`CHROME_PATH`, or the pinned one in
 * Puppeteer's cache, test/browsers.ts): required in CI, skipped elsewhere
 * without it. Runs
 * with `bun run test:browser` only (test/browser-gate.ts).
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { rmSync } from "node:fs";
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
import { browserTempDir } from "../../../test/browser-dirs.ts";
import { browserTests } from "../../../test/browser-gate.ts";
import { build } from "../scripts/build.ts";
import {
	Browser,
	chromeMajor,
	findChromeForTesting,
	type Page,
	type Served,
	step,
	type Worker,
} from "./browser.ts";

// `bun run test:browser` runs these with Bun's default of 5 s a test: too
// short on CI for a navigation, an icon click and the tools following.
setDefaultTimeout(30_000);

const SITE = "https://site.test";
const OTHER = "https://other.test";
/** Same site as SITE, another origin. */
const SUBDOMAIN = "https://www.site.test";

const found = browserTests ? findChromeForTesting() : undefined;
const chrome =
	found !== undefined && chromeMajor(found) >= 156 ? found : undefined;
if (browserTests && chrome === undefined && process.env["CI"])
	throw new Error(
		"Chrome for Testing 156 or newer is needed for the extension's end-to-end tests in CI",
	);

/** `pages/library.ts` bundled, the client library in it (DEC-207), once. */
let libraryScript: Promise<Uint8Array> | undefined;
function libraryBundle(): Promise<Uint8Array> {
	libraryScript ??= Bun.build({
		entrypoints: [join(import.meta.dir, "pages", "library.ts")],
		target: "browser",
		format: "esm",
	}).then(async (result) => {
		const [output] = result.outputs;
		if (!result.success || output === undefined)
			throw new Error(`the library page did not build: ${result.logs}`);
		return new Uint8Array(await output.arrayBuffer());
	});
	return libraryScript;
}

async function serve(url: string): Promise<Served> {
	const { origin, pathname } = new URL(url);
	const name = pathname.slice(1);
	if (origin === SITE && name === "library.js")
		return {
			status: 200,
			headers: { "content-type": "text/javascript; charset=utf-8" },
			body: await libraryBundle(),
		};
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

/** At most `ms` for a diagnostic: a worker gone since (a reload) never answers. */
const within = <T>(promise: Promise<T>, ms = 3_000): Promise<T> =>
	Promise.race([
		promise,
		Bun.sleep(ms).then(() => {
			throw new Error(`no answer in ${ms} ms`);
		}),
	]);

/** Click the icon on `tab` and attach to the side panel it opens. */
async function openPanel(browser: Browser, tab: Page): Promise<Page> {
	await browser.clickIcon(tab);
	const target = await browser
		.waitForTarget((t) => t.url === panelUrl(browser))
		.catch(async (error: unknown) => {
			// What the worker logged (a failed `sidePanel.open` logs there),
			// which tab it sees in front and the panel's options there.
			const worker = await within(
				browser.serviceWorker(browser.extensionId as string),
			).catch(() => undefined);
			const seen = worker
				? await within(
						worker.eval<string>(
							`Promise.all([chrome.tabs.query({}), chrome.windows.getAll()]).then(async ([t, w]) => JSON.stringify({ tabs: t.map((x) => [x.id, x.windowId, x.active, x.url]), windows: w.map((x) => [x.id, x.focused, x.type]), options: await Promise.all(t.filter((x) => x.active).map((x) => chrome.sidePanel.getOptions({ tabId: x.id }))) }))`,
						),
					).catch((error: unknown) => `(no answer: ${error})`)
				: "(no worker)";
			const said =
				browser.extensionWorker?.console.slice(-10).join(" | ") || "nothing";
			throw new Error(
				`no side panel after a click on the icon (${error}; Chrome ${browser.running ? "running" : `exited: ${browser.ended}`}); the worker said: ${said}; it sees ${seen}`,
			);
		});
	const panel = await browser.attach(target.targetId);
	// The state from the worker has come once the relay is shown.
	await panel.waitFor(`document.getElementById("relay").value !== ""`);
	// Chrome may load the panel's page, and the worker's state reach it,
	// before it gives the panel its size: a click while the page is 0×0
	// lands on nothing at (0, 0) and is lost.
	await panel.waitFor(`innerWidth > 0 && innerHeight > 0`);
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
	const token = await tokenFor(relay, address);
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

/** The builds, made once per run: the test build, the store package. */
const builds = new Map<boolean, Promise<string>>();
const buildDirs: string[] = [];
function builtFor(store: boolean): Promise<string> {
	let made = builds.get(store);
	if (made === undefined) {
		const dir = browserTempDir("extension-build-");
		buildDirs.push(dir);
		const outdir = join(dir, "dist");
		made = build({
			outdir,
			...(store ? { store: true } : { test: true, minify: false }),
		}).then(() => outdir);
		builds.set(store, made);
	}
	return made;
}

/**
 * One Chrome per build and WebMCP flag for the whole file. Two copies of the
 * extension in one Chrome would both inject and both get the questions, so
 * the store package has a Chrome of its own, as Chrome without WebMCP has.
 */
interface Shared {
	browser: Browser;
	extension: string;
	/** A test had it: the next one gets the extension anew. */
	used: boolean;
	/** Other extensions a test loaded (`loadOtherExtension`), removed after it. */
	others: Set<string>;
}
const sharedBrowsers = new Map<string, Promise<Shared>>();
/** Every Chrome this file launched: shared, and the ones of their own. */
let launches = 0;

afterAll(async () => {
	for (const shared of sharedBrowsers.values())
		await (await shared.catch(() => undefined))?.browser.close();
	for (const dir of buildDirs) rmSync(dir, { recursive: true, force: true });
	if (launches > 0)
		console.log(
			`extension.browser.test.ts: ${launches} Chrome launches, ${builds.size} builds`,
		);
});

function sharedFor(store: boolean, webmcp: boolean): Promise<Shared> {
	const key = `${store ? "store" : "test"}-${webmcp ? "webmcp" : "polyfill"}`;
	let shared = sharedBrowsers.get(key);
	if (shared === undefined) {
		shared = builtFor(store).then(async (extension) => ({
			browser: await launch(extension, undefined, webmcp),
			extension,
			used: false,
			others: new Set<string>(),
		}));
		sharedBrowsers.set(key, shared);
	}
	return shared;
}

/** Shared Chromes, by the browser: for `loadOtherExtension`. */
const sharedOf = new Map<Browser, Shared>();

/**
 * Load the test's other extension (one with a side panel of its own) into
 * `stack`'s Chrome; it goes before the next test's start.
 */
async function loadOtherExtension(stack: Stack): Promise<string> {
	const { id } = (await stack.browser.send("Extensions.loadUnpacked", {
		path: join(import.meta.dir, "other-extension"),
	})) as { id: string };
	sharedOf.get(stack.browser)?.others.add(id);
	await stack.browser.readyWorker(id);
	return id;
}

/**
 * A start for one test: the extension as just installed in the Chrome of
 * its build and WebMCP flag (shared by the file; one of its own with
 * `own`, or for a `profile` to start again with), `first` open in a new
 * tab and every other tab closed, the side panel opened by a click on the
 * icon there, set to a relay of this test's own and connected, and an MCP
 * client with a token for the connection's address. `stop()` ends the
 * relay; it closes the Chrome only if it is the test's own.
 */
async function start(
	options: {
		store: boolean;
		profile?: string;
		webmcp?: boolean;
		own?: boolean;
	},
	first: string,
): Promise<Stack> {
	const webmcp = options.webmcp ?? true;
	const own = options.own === true || options.profile !== undefined;
	const relay = startTestRelay();
	let browser: Browser | undefined;
	const stop = async () => {
		if (own) await browser?.close();
		await relay.stop();
	};
	try {
		const outdir = await builtFor(options.store);
		if (own) browser = await launch(outdir, options.profile, webmcp);
		else {
			const shared = await sharedFor(options.store, webmcp);
			browser = shared.browser;
			sharedOf.set(browser, shared);
			if (shared.used) {
				await browser.reinstall(shared.extension, shared.others);
				shared.others.clear();
			}
			shared.used = true;
		}
		const tab = await browser.newPage(first);
		if (!own) await browser.closeTabsBut(tab);
		const panel = await openPanel(browser, tab);
		await setRelay(panel, relay.url);
		await panel.click("#connect");
		const address = await panel.waitFor<string>(
			`document.getElementById("address").textContent`,
			15_000,
		);
		// The code as the relay sends it: no space of the panel's own in it.
		await panel.waitFor(
			`/^[A-Z]{4}-[A-Z]{4}$/.test(document.getElementById("code").textContent)`,
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
			stop: async () => {
				await client.close().catch(() => {});
				await stop();
			},
		};
	} catch (error) {
		await stop();
		throw error;
	}
}

/** Chrome; with its own WebMCP unless `webmcp` is `false` (iteration 44's polyfill). */
function launch(
	extension: string,
	profile?: string,
	webmcp = true,
): Promise<Browser> {
	launches++;
	return Browser.launch(chrome as string, {
		extension,
		args: [
			...(webmcp ? ["--enable-features=WebMCP"] : []),
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
	`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e !== null && e.getAttribute("aria-disabled") !== "true" && !document.body.hasAttribute("data-quiet"); })()`;

/** A tool's "Always allow" switch in the panel's tool list. */
const alwaysAllow = (name: string) => `input.always-allow[data-tool="${name}"]`;

/** An expression: tool `name`'s "Always allow" switch is on (`true`) or off. */
const alwaysAllowed = (name: string, on: boolean) =>
	`document.querySelector(${JSON.stringify(alwaysAllow(name))})?.checked === ${on}`;

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

/**
 * Wait until the worker has stored `name` as always allowed on `origin`
 * (`on`) or not: a switch in the panel flips on the click, before the worker's
 * write, and the worker answers calls from what it wrote.
 */
async function workerAllows(
	stack: Stack,
	origin: string,
	name: string,
	on: boolean,
): Promise<void> {
	const end = Date.now() + 10_000;
	for (;;) {
		const all = (await kvAll(stack.worker))["allowedTools"] as
			| Record<string, string[]>
			| undefined;
		if ((all?.[origin] ?? []).includes(name) === on) return;
		if (Date.now() > end)
			throw new Error(
				`the worker never stored ${name} as ${on ? "allowed" : "asking"} on ${origin}: ${JSON.stringify(all)}`,
			);
		await Bun.sleep(100);
	}
}

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

	beforeEach(async () => {
		stack = await start({ store: false }, `${SITE}/webmcp.html`);
		tab = stack.tab;
	}, 60_000);

	afterEach(async () => {
		await stack?.client.close();
		await stack?.stop();
	});

	test("the AI app gets page_info, webmcp_tools and the page's tools", async () => {
		await step(
			"the AI app gets page_info, webmcp_tools and the page's tools",
			async () => {
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
				expect(byName("page_place_order")?.annotations?.readOnlyHint).toBe(
					false,
				);
			},
		);
		await step(
			"page_info tells the page in front and its WebMCP tools",
			async () => {
				const result = await pageInfo(stack);
				expect(result.isError).toBeFalsy();
				expect(result.structuredContent).toEqual({
					url: `${SITE}/webmcp.html`,
					title: "Page with WebMCP tools",
					language: "de-CH",
					webmcp: { available: true, tools: 5 },
				});
			},
		);
		await step("webmcp_tools lists them with their input schemas", async () => {
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
			expect(tools.find((t) => t.name === "get_greeting")?.inputSchema).toEqual(
				{
					type: "object",
					properties: { name: { type: "string" } },
					required: ["name"],
				},
			);
		});
		await step(
			"a read-only tool runs at once, with the page's answer",
			async () => {
				const result = await call(stack, "page_get_greeting", { name: "Ada" });
				expect(result.isError).toBeFalsy();
				expect(result.content).toEqual([{ type: "text", text: "Hello, Ada!" }]);
				expect(await tab.eval("window.calls.at(-1)")).toEqual([
					"get_greeting",
					"Ada",
				]);
			},
		);
		await step(
			"a toolchange and the reads around it (AI app, worker, panel) cost one getTools()",
			async () => {
				await readsSettled(stack.tab);
				await toolReads(stack.tab);
				await registerLater(stack.tab, "later_one");
				// The AI app asks at once; the worker reads after the content
				// script's message (250 ms), the panel after each of the bridge's
				// reads. Before DEC-177 that was five calls.
				const [info] = await Promise.all([
					pageInfo(stack),
					call(stack, "webmcp_tools"),
				]);
				expect(info.structuredContent).toMatchObject({
					webmcp: { available: true, tools: 6 },
				});
				await waitForTools(stack, (n) => n.includes("page_later_one"));
				await stack.panel.waitFor(
					`[...document.querySelectorAll("#tools li")].some((li) => li.textContent.includes("later_one"))`,
				);
				await readsSettled(stack.tab);
				// One where all of it comes within SHARE_READ_MS of the first read
				// (locally and in CI so far); a slow runner may need a second.
				expect(await toolReads(stack.tab)).toBeLessThanOrEqual(2);
			},
		);
		await step("cancelling a call cancels it in the page", async () => {
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
		await step(
			"the list follows toolchange, without a navigation",
			async () => {
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
			},
		);
	}, 90_000);

	test("a tool not marked read-only asks in the side panel first", async () => {
		const allowed = call(stack, "page_place_order", { item: "tea" });
		// "Always allow on <host>" is offered too.
		await stack.panel.waitFor(
			`document.querySelector('[data-question] button[data-answer="site"]')`,
		);
		expect(
			await stack.panel.eval(
				`document.querySelector('[data-question] button[data-answer="site"]').textContent`,
			),
		).toBe(`Always allow on ${new URL(SITE).host}`);
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

	test("the look: nothing past the panel's edge at 345, 360 and 420 px, no amber button, each scheme's tokens (DEC-160 to DEC-163)", async () => {
		await step(
			"the AI access switch: its knob sits flush at both ends, light, dark and forced colours",
			async () => {
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
			},
		);
		await step(
			"the AI access switch and a tool's Always allow: knob on track and track on the paper at least 3:1, light and dark, on and off (EQ 17, DEC-160)",
			async () => {
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
				await stack.panel.waitFor(
					`document.querySelector("input.always-allow")`,
				);
				for (const selector of ["#ai-switch", "input.always-allow"]) {
					const measured: Record<string, unknown> = {};
					for (const value of ["light", "dark"]) {
						await stack.panel.send("Emulation.setEmulatedMedia", {
							features: [{ name: "prefers-color-scheme", value }],
						});
						const m = await contrast(selector);
						measured[value] = m;
						for (const ratio of [
							m.on.knob,
							m.on.track,
							m.off.knob,
							m.off.track,
						])
							expect(ratio).toBeGreaterThanOrEqual(3);
					}
					// The tokens' pairs (test/contrast.test.ts): on, the knob
					// (--on-strong) on the ink track (--strong), which is ink on paper,
					// or for a tool's "Always allow" on the green track (--ok, DEC-184);
					// off, the knob on the edge (--edge), and the edge on paper. Before
					// the tokens: 5.02 / 3.77 in light, 9.48 / 3.42 in dark; before
					// EQ 17 the dark "on" knob was 1.7:1, the light "off" track 2.5:1.
					const green = selector === "input.always-allow";
					expect(measured).toEqual({
						light: {
							on: green
								? { knob: 6.44, track: 5.86 }
								: { knob: 16.07, track: 14.61 },
							off: { knob: 3.86, track: 3.51 },
						},
						dark: {
							on: green
								? { knob: 9.85, track: 9.85 }
								: { knob: 15.89, track: 15.89 },
							off: { knob: 4.39, track: 4.39 },
						},
					});
				}
				await stack.panel.send("Emulation.setEmulatedMedia", { features: [] });
			},
		);
		await step(
			"How do I add it? under the address: the commands fit, light and dark, Copy keeps its width",
			async () => {
				// With an app paired, the address is behind "+ Connect another AI app".
				const adding = !(await stack.panel.eval<boolean>(
					`document.getElementById("pairing").hidden === false`,
				));
				if (adding) await stack.panel.click("#add-app");
				await stack.panel.waitFor(
					`!document.getElementById("setup").hidden && document.getElementById("setup").offsetHeight > 0`,
				);
				expect(
					await stack.panel.eval<boolean>(
						`document.getElementById("setup").open`,
					),
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
						`claude mcp add --transport http tab-mcp-browser-extension ${stack.address}`,
						`codex features enable mcp_2026_07_28\ncodex mcp add tab-mcp-browser-extension --url ${stack.address}\ncodex mcp login tab-mcp-browser-extension`,
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
			},
		);
		await step(
			"the look: nothing past the panel's edge at 345, 360 and 420 px, no amber button, each scheme's tokens (DEC-160 to DEC-163)",
			async () => {
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
						`!document.getElementById("pairing").hidden && !document.getElementById("tools-head").hidden && document.querySelector("input.always-allow") !== null`,
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
							css("replaced-disconnect-all").borderTopColor === token("--edge"),
						].map(String);
					})()`),
					).toEqual(["true", "true", "true", "true", "true", "true"]);
					// A question with arguments and a title that have nowhere to break.
					const asked = call(stack, "page_place_order", {
						item: LONG.repeat(4),
					});
					await panel.waitFor(`document.querySelector("[data-question] pre")`);
					await holds();
					// It is a sheet with an edge; "Allow once" is drawn as "Don't
					// allow" is, the default button (DEC-180), and while it takes no
					// click it is flat, in colours of its own. The pointer off the
					// dialog first: it opens where the last click was, and a button
					// under the pointer takes its hover colour.
					await panel.send("Input.dispatchMouseEvent", {
						type: "mouseMoved",
						x: 1,
						y: 1,
					});
					const question = await panel.eval<Record<string, string>>(`(() => {
					const card = getComputedStyle(document.querySelector("[data-question]"));
					const button = (answer) => document.querySelector('[data-question] button[data-answer="' + answer + '"]');
					const allow = button("allow");
					const deny = button("deny");
					const was = allow.getAttribute("aria-disabled");
					const still = document.createElement("style");
					still.textContent = "button { transition: none !important; }";
					document.head.append(still);
					allow.setAttribute("aria-disabled", "true");
					const waiting = getComputedStyle(allow).backgroundColor;
					const opacity = getComputedStyle(allow).opacity;
					allow.removeAttribute("aria-disabled");
					const look = (b) => {
						const s = getComputedStyle(b);
						return [s.backgroundColor, s.color, s.borderTopColor, s.fontWeight].join(" ");
					};
					const ready = getComputedStyle(allow).backgroundColor;
					const same = look(allow) === look(deny);
					if (was !== null) allow.setAttribute("aria-disabled", was);
					still.remove();
					return {
						sheet: card.backgroundColor,
						edge: card.borderTopColor,
						shadow: card.boxShadow,
						class: allow.className + "|" + deny.className,
						same: String(same),
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
							edge: getComputedStyle(document.getElementById("replaced-disconnect-all")).borderTopColor,
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
					// Wait for the "Always allow all" switch to take clicks
					// again: it is flat for a moment after the layout moved.
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
						class: "|",
						same: "true",
						waiting: "rgb(235, 232, 224)",
						opacity: "1",
						ready: "rgb(255, 255, 255)",
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
					// and what "Always allow" does is a line over the list.
					expect(
						await panel.eval(`(() => {
						const address = document.getElementById("address");
						const input = document.querySelector("input.always-allow");
						return [
							address.title,
							address.scrollWidth <= address.clientWidth,
							input.closest("label").title,
							input.getAttribute("aria-describedby"),
							document.getElementById("always-allow-note").textContent,
							// As the panel is drawn now, not only as its HTML is.
							[...document.querySelectorAll("[title]")].map((e) => e.id || e.className),
						];
					})()`),
					).toEqual([
						"",
						true,
						"",
						"always-allow-note",
						`Always allow, on: the tool runs without asking on ${SITE}, for every connected AI app. Off: it asks you before each call.`,
						[],
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
			},
		);
	}, 150_000);

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
		// This tab on a page without tools, the other with them.
		await tab.goto(`${SITE}/plain.html`);
		await waitForTools(stack, (n) => !n.includes("page_get_greeting"));
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

		beforeEach(async () => {
			stack = await start({ store: false }, `${SITE}/webmcp.html`);
			await waitForTools(stack, (n) => n.includes("page_place_order"));
		}, 60_000);

		afterEach(async () => {
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
			// A modal dialog, the rest of the panel inert: the browser's part
			// (sidepanel.test.ts has the panel's own, that it calls showModal).
			expect(
				await stack.panel.eval(
					`[document.getElementById("questions").open, document.getElementById("questions").matches(":modal")]`,
				),
			).toEqual([true, true]);
			// A short line for screen readers, not the card (EQ 11), in the
			// dialog's own status line (the panel's is inert while it is
			// open); the time left on the card (EQ 13).
			expect(
				await stack.panel.waitFor<string>(
					`document.getElementById("question-status-modal").textContent`,
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

		test("a panel closed during a question hands it to a notification", async () => {
			await step(
				"a panel closed during a question hands it to a notification",
				async () => {
					const asked = call(stack, "page_place_order", { item: "handed" });
					await stack.panel.waitFor(
						`document.querySelector("[data-question]")`,
					);
					await closePanel(stack);
					const id = await newNotification(stack);
					// Chrome's rule the panel's way back from a notification is built on
					// (EQ 18; connection.test.ts and worker.test.ts for the rest):
					// without a user's gesture, which the DevTools Protocol does not
					// give, sidePanel.open is refused.
					expect(
						await stack.worker.eval(
							`chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => chrome.sidePanel.open({ tabId: t.id, windowId: t.windowId })).then(() => "opened", (e) => e.message)`,
						),
					).toContain("user gesture");
					// After the guard against an Allow that came too soon.
					await Bun.sleep(600);
					await clickNotification(stack, id, 0);
					const result = await asked;
					expect(result.isError).toBeFalsy();
					expect(result.content[0]?.text).toContain("handed");
					// Answered: the notification is gone.
					expect(await notifications(stack)).toEqual([]);
				},
			);
			await step(
				"with the panel closed the AI app still calls the page's tools",
				async () => {
					const result = await call(stack, "page_get_greeting", { name: "Cy" });
					expect(result.content).toEqual([
						{ type: "text", text: "Hello, Cy!" },
					]);
					expect(await badge()).toBe("on");
				},
			);
			await step("reopening the panel shows the same connection", async () => {
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
				// else after "+ Connect another AI app").
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
		}, 60_000);

		test("a notification closed is Don't allow, through Chrome's onClosed: the call is refused, the tool does not run", async () => {
			// No panel, so the question is a notification.
			await closePanel(stack);
			const asked = call(stack, "page_place_order", { item: "closed" });
			const id = await newNotification(stack);
			// Chrome's own closing (onClosed), as when the user closes it; the
			// rest of what a closing does is connection.test.ts's and
			// worker.test.ts's.
			await stack.worker.eval(
				`chrome.notifications.clear(${JSON.stringify(id)})`,
			);
			expect((await asked).isError).toBe(true);
			expect(
				await stack.tab.eval("window.calls.map((c) => c[1])"),
			).not.toContain("closed");
			expect(await notifications(stack)).toEqual([]);
		});

		test("a panel covered by another extension's panel for the tab hands its questions to notifications", async () => {
			const { browser } = stack;
			const other = await loadOtherExtension(stack);
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

		beforeEach(async () => {
			stack = await start({ store: false }, `${SITE}/webmcp.html`);
		}, 60_000);

		afterEach(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		const stored = async <T>(key: string) =>
			((await kvAll(stack.worker))[key] ?? null) as T;

		test("a takeover is kept across a restart: no taking the address back by itself, the notice stays", async () => {
			// AI access off first, which the test before this one left behind
			// until it went (connection.test.ts has its commands now).
			await stack.panel.eval(`(() => {
				window.e2eStop = chrome.runtime.connect({ name: "panel" });
				window.e2eStop.postMessage({ type: "stop" });
			})()`);
			// Stored by the worker once the stop ran.
			const end = Date.now() + 10_000;
			while ((await stored<boolean>("aiOn")) !== false) {
				if (Date.now() > end) throw new Error("AI access never went off");
				await Bun.sleep(100);
			}
			await stack.panel.eval("window.e2eStop.disconnect()");
			await stack.panel.waitFor(
				`document.getElementById("state").dataset.state === "off"`,
			);
			await stack.panel.click("#connect");
			// The AI app (the test's client) is paired by now: the card lists it
			// and keeps the address out of sight until "+ Connect another AI app".
			await stack.panel.waitFor(
				`document.getElementById("state").dataset.state === "on"`,
				15_000,
			);
			expect(
				await stack.panel.eval(
					`[document.getElementById("state-text").textContent, document.getElementById("state").classList.contains("visually-hidden"), document.getElementById("pairing").hidden, document.getElementById("add-app").hidden, document.querySelector("#grants button")?.textContent]`,
				),
			).toEqual(["Connected · Test client", true, true, false, "Disconnect"]);
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
			expect(off.slice(0, 3)).toEqual([1, false, "Connected AI apps"]);
			expect(off[3]).not.toBe(green);
			// No Disconnect while off: only the relay can disconnect an AI app,
			// and the panel says so (EQ 8).
			const offView = () =>
				stack.panel.eval(
					`[document.getElementById("state-text").textContent, document.querySelectorAll("#grants li").length, document.querySelectorAll("#grants button").length, document.getElementById("grants-note").hidden, document.getElementById("grants-note").textContent]`,
				);
			const expectedOff = [
				"AI access is off · your AI apps stay connected for next time",
				1,
				0,
				false,
				"Turn on AI access to disconnect an AI app.",
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
				server: { name: "tab-mcp-browser-extension", version: "1.0.0" },
				app: "tab-mcp-extension",
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
				stack.worker = await stack.browser.readyWorker(
					stack.browser.extensionId as string,
				);
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
				// Disconnect all apps: the connection is taken back with a new
				// secret behind it. The address names the app and stays
				// (DEC-196); the notice going away says it is done.
				await stack.panel.click("#replaced-disconnect-all");
				// The error says what the panel showed then. (It timed out in CI
				// when the click came while the panel was still 0×0: `openPanel`
				// waits for its size now.)
				await stack.panel
					.waitFor(
						`document.getElementById("replaced").hidden && ["on", "waiting"].includes(document.getElementById("state").dataset.state)`,
						15_000,
					)
					.catch(async (error: unknown) => {
						const shown = await stack.panel
							.eval<string[]>(
								`["state", "state-text", "problem", "local-problem", "replaced", "address"].map((id) => { const e = document.getElementById(id); return id + ": " + (e.hidden ? "(hidden) " : "") + (e.dataset.state ?? "") + " " + e.textContent.trim(); })`,
							)
							.catch((e: unknown) => [`(no answer: ${e})`]);
						throw new Error(
							`${error}; impostor ${impostor.state}; the panel: ${shown.join(" | ")}`,
						);
					});
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
			// The new worker, once its script has run: a click before would be lost.
			stack.worker = await stack.browser.readyWorker(
				stack.browser.extensionId as string,
			);
		}

		test("the database deleted under the worker: the next write opens it again, and it holds across a start", async () => {
			// The worker and the panel attached anew, as a test that reloaded the
			// extension before this one would need them.
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
	// One scenario in three launches of one profile (a Chrome of its own: the
	// profile must outlive the browser): start and connect; Chrome again,
	// which connects by itself; Chrome again with the relay gone, which
	// keeps trying.
	test("the same profile connects again by itself, with the same address; with the relay out of reach at a start, it keeps trying (EQ 3, EQ 14)", async () => {
		const profile = browserTempDir("extension-profile-");
		let stack: Stack | undefined;
		let again: Browser | undefined;
		let third: Browser | undefined;
		try {
			stack = await start({ store: false, profile }, `${SITE}/plain.html`);
			const first = stack;
			await step(
				"the same profile connects again by itself, with the same address",
				async () => {
					expect((await pageInfo(first)).isError).toBeFalsy();
					await first.client.close();
					await first.browser.close();
					// Chrome again, with the same profile and build; no click, no panel.
					again = await launch(first.extension, profile);
					await again.newPage(`${SITE}/plain.html`);
					const end = Date.now() + 20_000;
					let client: Client | undefined;
					while (client === undefined) {
						client = await mcpClient(first.relay, first.address).catch(
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
				},
			);
			await step(
				"with the relay out of reach at a start, it keeps trying: the alarm is set and the panel says so (EQ 3, EQ 14)",
				async () => {
					const running = again as Browser;
					const before = await running.serviceWorker(
						running.extensionId as string,
					);
					// As after an update, which clears the alarms.
					await before.eval(`chrome.alarms.clear("tab-mcp-keepup")`);
					await running.close();
					// The relay is gone; Chrome starts again with AI access left on.
					await first.relay.stop();
					third = await launch(first.extension, profile);
					const tab = await third.newPage(`${SITE}/plain.html`);
					const worker = await third.serviceWorker(third.extensionId as string);
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
					const panel = await openPanel(third, tab);
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
				},
			);
		} finally {
			await third?.close();
			await again?.close();
			await stack?.stop().catch(() => {});
			rmSync(profile, { recursive: true, force: true });
		}
	}, 150_000);
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
			const stack = await start(
				// Its own Chrome: the service worker's lifetime, with nothing else attached.
				{ store: false, own: true },
				`${SITE}/webmcp.html`,
			);
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

/**
 * Wait until the content script in `tab` has read the page's WebMCP tools
 * for the last time: no `getTools()` of its own pending, and none started,
 * for `quietMs`. Chrome (156 to 160 at least) crashes its whole browser
 * process (a libc++ assertion, `optional operator*` on a disengaged value:
 * SIGILL on Linux x64, SIGTRAP on macOS arm64) when a tab whose content script
 * runs on `activeTab` alone goes to another origin while that script's
 * `getTools()` is pending (kb/operations/chrome-webmcp-crash.md). After a
 * load the worker reads the page several times (the load, `toolchange`, the
 * panel), so a navigation right after one runs into that. Only through the
 * DevTools Protocol, in the content script's world: nothing in the build.
 *
 * The wrapper counts the reads from the first poll on; one that started
 * just before is not counted. `getTools()` answers within milliseconds, so
 * `quietMs` (1 s) covers it, and also the content script's 250 ms throttle
 * of `toolchange` plus the worker's round trip before the next read.
 */
async function readsSettled(tab: Page, quietMs = 1000): Promise<void> {
	const world = await tab.isolatedWorld("tab-mcp browser extension");
	// Strict: a wrapper that does not stick throws instead of re-arming the
	// wait at every poll.
	const settled = `(() => {
		"use strict";
		const context = document.modelContext;
		if (context === undefined) return true;
		if (context.e2eReads === undefined) {
			const reads = { pending: 0, last: Date.now(), count: 0 };
			const getTools = context.getTools.bind(context);
			context.getTools = (...args) => {
				reads.pending++;
				reads.count++;
				reads.last = Date.now();
				return getTools(...args).finally(() => {
					reads.pending--;
					reads.last = Date.now();
				});
			};
			context.e2eReads = reads;
		}
		const { pending, last } = context.e2eReads;
		return pending === 0 && Date.now() - last >= ${quietMs};
	})()`;
	const end = Date.now() + 10_000;
	while (!(await tab.eval<boolean>(settled, world))) {
		if (Date.now() > end)
			throw new Error("the extension kept reading the page's tools");
		await Bun.sleep(50);
	}
}

describe.skipIf(chrome === undefined)(
	"the store package (no host access)",
	() => {
		let stack: Stack;
		let tab: Page;

		beforeEach(async () => {
			stack = await start({ store: true }, `${SITE}/plain.html`);
			tab = stack.tab;
		}, 60_000);

		afterEach(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		test("the tab the icon was clicked on can be read", async () => {
			expect((await pageInfo(stack)).structuredContent).toMatchObject({
				url: `${SITE}/plain.html`,
			});
		});

		test("on the same origin after a navigation too (Chrome keeps the grant)", async () => {
			await step(
				"on the same origin after a navigation too (Chrome keeps the grant)",
				async () => {
					await tab.goto(`${SITE}/webmcp.html`);
					expect((await pageInfo(stack)).structuredContent).toMatchObject({
						url: `${SITE}/webmcp.html`,
						webmcp: { available: true, tools: 5 },
					});
				},
			);
			await step(
				"on the page's origin the click's access holds: the new page is read",
				async () => {
					const result = await call(stack, "navigate", {
						url: `${SITE}/webmcp.html`,
					});
					expect(result.structuredContent).toMatchObject({
						url: `${SITE}/webmcp.html`,
						webmcp: { available: true, tools: 5 },
					});
					await waitForTools(stack, (n) => n.includes("page_get_greeting"));
				},
			);
		}, 60_000);

		test("another origin of the same site needs a click too", async () => {
			await step(
				"another origin of the same site needs a click too",
				async () => {
					await readsSettled(tab);
					await tab.goto(`${SUBDOMAIN}/plain.html`);
					const refused = await pageInfo(stack);
					expect(refused.isError).toBe(true);
					expect(refused.content[0]?.text).toContain(
						"may not read this tab yet",
					);
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
					// when it is asked: the same line either way.
					expect(access).toBe(
						"Click the tab-mcp icon in Chrome's toolbar to let it read this tab.",
					);
					expect([hidden, button]).toEqual([false, "Give access to all sites"]);
					await stack.browser.clickIcon(tab);
					expect((await pageInfo(stack)).structuredContent).toMatchObject({
						url: `${SUBDOMAIN}/plain.html`,
					});
				},
			);
			await step(
				"on another site it may not, until the next click there",
				async () => {
					await readsSettled(tab);
					await tab.goto(`${OTHER}/webmcp.html`);
					const refused = await pageInfo(stack);
					expect(refused.isError).toBe(true);
					expect(refused.content[0]?.text).toContain(
						"may not read this tab yet",
					);
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
				},
			);
		}, 60_000);

		test("a click shows the panel over another extension's panel for the tab, and gives the tab's tools", async () => {
			const { browser } = stack;
			const other = await loadOtherExtension(stack);
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

/**
 * The content script's `getTools()` calls since the last time this was
 * asked (or since `readsSettled` wrapped it), counted by that wrapper.
 */
async function toolReads(tab: Page): Promise<number> {
	const world = await tab.isolatedWorld("tab-mcp browser extension");
	return tab.eval<number>(
		`(() => { const reads = document.modelContext.e2eReads; const n = reads.count; reads.count = 0; return n; })()`,
		world,
	);
}

/** Register a WebMCP tool from the page's own world, after its `toolchange`. */
const registerLater = (tab: Page, name: string) =>
	tab.eval(`new Promise((resolve) => {
		document.modelContext.addEventListener("toolchange", () => resolve(true), { once: true });
		document.modelContext.registerTool({
			name: ${JSON.stringify(name)},
			description: "Registered after the load.",
			inputSchema: { type: "object" },
			annotations: { readOnlyHint: true },
			async execute() { return "later"; },
		});
	})`);

describe.skipIf(chrome === undefined)(
	"reading the page's tools rarely (DEC-177)",
	() => {
		let stack: Stack;

		beforeEach(async () => {
			stack = await start({ store: false }, `${SITE}/webmcp.html`);
			await waitForTools(stack, (n) => n.includes("page_get_greeting"));
		}, 60_000);

		afterEach(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		test("with AI access off and the panel closed the page is not read; the panel opened reads it", async () => {
			await stack.panel.click("#ai-switch");
			await stack.panel.waitFor(
				`document.getElementById("state").dataset.state === "off"`,
			);
			await closePanel(stack);
			await readsSettled(stack.tab);
			await toolReads(stack.tab);
			await registerLater(stack.tab, "later_two");
			// The content script tells the worker after 250 ms; nobody reads.
			await Bun.sleep(1500);
			expect(await toolReads(stack.tab)).toBe(0);
			// The panel shows the page's tools as they are now.
			stack.panel = await openPanel(stack.browser, stack.tab);
			await stack.panel.waitFor(
				`[...document.querySelectorAll("#tools li")].some((li) => li.textContent.includes("later_two"))`,
			);
			await readsSettled(stack.tab);
			// One (the panel's tab and the bridge's refresh share it); as above.
			const reads = await toolReads(stack.tab);
			expect(reads).toBeGreaterThanOrEqual(1);
			expect(reads).toBeLessThanOrEqual(2);
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

		beforeEach(async () => {
			stack = await start({ store: false }, `${SITE}/plain.html`);
		}, 60_000);

		afterEach(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		test("navigate on the page's origin runs at once, with the new page's page_info and tools", async () => {
			await step(
				"navigate on the page's origin runs at once, with the new page's page_info and tools",
				async () => {
					const result = await call(stack, "navigate", { url: "/webmcp.html" });
					expect(result.isError).toBeFalsy();
					expect(result.structuredContent).toMatchObject({
						url: `${SITE}/webmcp.html`,
						title: "Page with WebMCP tools",
						webmcp: { available: true, tools: 5 },
					});
					await waitForTools(stack, (n) => n.includes("page_get_greeting"));
					await noQuestion(stack);
				},
			);
			await step(
				"to another origin it asks in the side panel, without Always allow on <host>: Don't allow stays, Allow goes",
				async () => {
					const declined = call(stack, "navigate", {
						url: `${OTHER}/plain.html`,
					});
					await stack.panel.waitFor(
						`document.querySelector("[data-question]")`,
					);
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
					const allowed = call(stack, "navigate", {
						url: `${OTHER}/plain.html`,
					});
					await answerInPanel(stack, "allow");
					// With host access the new page is read.
					expect((await allowed).structuredContent).toMatchObject({
						url: `${OTHER}/plain.html`,
						title: "Plain page",
					});
				},
			);
			await step(
				"back to another origin asks too, its address not known",
				async () => {
					const back = call(stack, "go_back");
					await stack.panel.waitFor(
						`document.querySelector("[data-question]")`,
					);
					const lines = await questionLines(stack);
					expect(lines[1]).toBe(`From (verified) ${OTHER}`);
					expect(lines[2]).toContain("previous page");
					expect(lines[2]).toContain("not known");
					await answerInPanel(stack, "allow");
					expect((await back).structuredContent).toMatchObject({
						url: `${SITE}/webmcp.html`,
					});
				},
			);
			await step(
				"back and forward on the page's origin run at once",
				async () => {
					const back = await call(stack, "go_back");
					expect(back.structuredContent).toMatchObject({
						url: `${SITE}/plain.html`,
					});
					const forward = await call(stack, "go_forward");
					expect(forward.structuredContent).toMatchObject({
						url: `${SITE}/webmcp.html`,
					});
					await noQuestion(stack);
				},
			);
			await step(
				"reload stays and never asks; within the page (#part) it answers at once",
				async () => {
					await stack.tab.eval("window.e2eMarker = 1");
					const reloaded = await call(stack, "reload");
					expect(reloaded.structuredContent).toMatchObject({
						url: `${SITE}/webmcp.html`,
					});
					expect(await stack.tab.eval("typeof window.e2eMarker")).toBe(
						"undefined",
					);
					const started = Date.now();
					const part = await call(stack, "navigate", { url: "#part" });
					expect(part.structuredContent).toMatchObject({
						url: `${SITE}/webmcp.html#part`,
					});
					expect(Date.now() - started).toBeLessThan(5_000);
					await noQuestion(stack);
				},
			);
		}, 150_000);
	},
);

describe.skipIf(chrome === undefined)(
	"navigation in the store package (no host access)",
	() => {
		let stack: Stack;

		beforeEach(async () => {
			stack = await start({ store: true }, `${SITE}/plain.html`);
		}, 60_000);

		afterEach(async () => {
			await stack?.client.close();
			await stack?.stop();
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

describe.skipIf(chrome === undefined)(
	"Chrome without WebMCP: the page-world polyfill (iteration 44)",
	() => {
		let stack: Stack;

		beforeEach(async () => {
			stack = await start(
				{ store: false, webmcp: false },
				`${SITE}/plain.html`,
			);
			// Loaded after the install registered the polyfill for every page.
			await stack.tab.goto(`${SITE}/webmcp.html`);
		}, 60_000);

		afterEach(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		test("Chrome has no WebMCP here; the page finds the polyfill's as it loads", async () => {
			await step(
				"Chrome has no WebMCP here; the page finds the polyfill's as it loads",
				async () => {
					const world = await stack.tab.isolatedWorld(
						"tab-mcp browser extension",
					);
					// The content script's world: no document.modelContext of Chrome's.
					expect(
						await stack.tab.eval(`"modelContext" in document`, world),
					).toBe(false);
					expect(
						await stack.tab.eval<string[]>(
							"document.modelContext.getTools().then((t) => t.map((x) => x.name).sort())",
						),
					).toEqual([
						"get_greeting",
						"mcp_result",
						"mirrored_tool",
						"place_order",
						"slow_tool",
					]);
				},
			);
			await step(
				"the AI app gets the page's tools and calls them",
				async () => {
					await waitForTools(stack, (n) => n.includes("page_get_greeting"));
					const result = await call(stack, "page_get_greeting", {
						name: "Ada",
					});
					expect(result.isError).toBeFalsy();
					expect(result.content).toEqual([
						{ type: "text", text: "Hello, Ada!" },
					]);
					expect((await call(stack, "page_mcp_result")).content).toEqual([
						{ type: "text", text: "from an MCP result" },
					]);
					expect(
						(await call(stack, "page_info")).structuredContent?.["webmcp"],
					).toEqual({
						available: true,
						tools: 5,
					});
				},
			);
			await step("cancelling a call aborts the page's signal", async () => {
				const controller = new AbortController();
				const pending = call(
					stack,
					"page_slow_tool",
					{},
					{ signal: controller.signal },
				);
				await stack.tab.waitFor("window.slowStarted === true");
				controller.abort();
				await pending.catch(() => {});
				await stack.tab.waitFor("window.aborted === true");
			});
			await step("the list follows toolchange", async () => {
				await stack.tab.eval(`document.modelContext.registerTool({
					name: "registered_later",
					description: "Registered after the load.",
					annotations: { readOnlyHint: true },
					execute: () => "later",
				})`);
				await waitForTools(stack, (n) => n.includes("page_registered_later"));
			});
		}, 90_000);
	},
);

/**
 * A page that uses the client library with `webmcp: true` (DEC-207): the page
 * and the extension know of each other. The page has no `onConfirm`: the
 * library's own confirmation, which an agent in the browser is never shown
 * (DEC-215); the AI app is the test's MCP client ("Test client" at
 * client.example).
 */
const TEST_APP = { name: "Test client", host: "client.example" };
/** The page's own confirmation is open. */
const pageAsks = `document.querySelector("dialog.tab-mcp-confirm") !== null`;

/**
 * AI access off and on again, so that the relay lists the test's AI app
 * (a token written into its store is not announced to a session that runs).
 */
async function listTestApp(stack: Stack): Promise<void> {
	await stack.panel.eval(`(async () => {
		const port = chrome.runtime.connect({ name: "panel" });
		port.postMessage({ type: "stop" });
		port.postMessage({ type: "connect" });
		await new Promise((resolve) => setTimeout(resolve, 500));
		port.disconnect();
	})()`);
	await stack.panel.waitFor(
		`document.getElementById("state").dataset.state === "on"`,
		15_000,
	);
}

describe.skipIf(chrome === undefined)(
	"a page with the client library, Chrome's own WebMCP (DEC-207)",
	() => {
		let stack: Stack;
		let tab: Page;

		beforeEach(async () => {
			stack = await start({ store: false }, `${SITE}/library.html`);
			tab = stack.tab;
			await listTestApp(stack);
			await waitForTools(stack, (n) => n.includes("page_complete_todo"));
		}, 60_000);

		afterEach(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		test("the page shows the AI app connected through the extension; the panel says the page has tab-mcp built in", async () => {
			await step(
				"the page shows the AI app connected through the extension; the panel says the page has tab-mcp built in",
				async () => {
					await tab.waitFor(
						"window.tabMcpPage?.mcp.extension?.apps.length === 1",
						15_000,
					);
					const version = await stack.worker.eval<string>(
						"chrome.runtime.getManifest().version",
					);
					expect(
						await tab.eval("window.tabMcpPage.mcp.extension ?? null"),
					).toEqual({
						name: "tab-mcp browser extension",
						version,
						apps: [TEST_APP],
						whileInFront: true,
					});
					await stack.panel.waitFor(
						`!document.getElementById("tab-library").hidden`,
					);
					// The AI app is not connected to the page directly: no second line.
					expect(
						await stack.panel.eval(
							`document.getElementById("tab-both").hidden`,
						),
					).toBe(true);
				},
			);
			await step(
				"with the extension's Always allow on, the AI app's call runs with no question in the page",
				async () => {
					const toggle = alwaysAllow("complete_todo");
					await stack.panel.waitFor(takesClicks(toggle));
					await stack.panel.click(toggle);
					// The click flips the switch at once; the worker's write comes after,
					// and a call before it would still be asked (or, off, not asked).
					await workerAllows(stack, SITE, "complete_todo", true);
					await stack.panel.waitFor(alwaysAllowed("complete_todo", true));
					const result = await call(stack, "page_complete_todo", { id: 1 });
					expect(result.isError).toBeFalsy();
					expect(result.content[0]?.text).toContain("Todo 1 is done.");
					expect(await tab.eval(pageAsks)).toBe(false);
					expect(
						await tab.eval("window.tabMcpPage.calls.at(-1).client"),
					).toEqual({
						kind: "webmcp",
						via: "tab-mcp-extension",
						...TEST_APP,
					});
					await stack.panel.waitFor(takesClicks(toggle));
					await stack.panel.click(toggle);
					await workerAllows(stack, SITE, "complete_todo", false);
					await stack.panel.waitFor(alwaysAllowed("complete_todo", false));
				},
			);
			await step(
				"with it off, the extension asks once and the page not at all",
				async () => {
					const pending = call(stack, "page_complete_todo", { id: 2 });
					await answerInPanel(stack, "allow");
					const result = await pending;
					expect(result.isError).toBeFalsy();
					expect(await tab.eval(pageAsks)).toBe(false);
					// Vouched for: the page knows the AI app.
					expect(
						await tab.eval("window.tabMcpPage.calls.at(-1).client"),
					).toEqual({
						kind: "webmcp",
						via: "tab-mcp-extension",
						...TEST_APP,
					});
					expect(await tab.eval("window.tabMcpPage.done")).toEqual([1, 2]);
					// Declined in the extension: the page is not asked and nothing runs.
					const declined = call(stack, "page_complete_todo", { id: 9 });
					await answerInPanel(stack, "deny");
					expect((await declined).isError).toBe(true);
					expect(await tab.eval(pageAsks)).toBe(false);
					expect(await tab.eval("window.tabMcpPage.done")).toEqual([1, 2]);
				},
			);
			await step(
				"the page's state follows when the app is disconnected in the extension",
				async () => {
					// Disconnect asks first: a click arms it, a second one after a
					// moment disconnects.
					await stack.panel.click("#grants button");
					await Bun.sleep(800);
					await stack.panel.click("#grants button");
					await tab.waitFor(
						"window.tabMcpPage.mcp.extension?.apps.length === 0",
						15_000,
					);
					expect(
						await tab.eval("document.getElementById('extension').textContent"),
					).toContain('"apps":[]');
				},
			);
		}, 90_000);
	},
);

describe.skipIf(chrome === undefined)(
	"a page with the client library, the extension's own WebMCP (DEC-207)",
	() => {
		let stack: Stack;
		let tab: Page;

		beforeEach(async () => {
			stack = await start(
				{ store: false, webmcp: false },
				`${SITE}/plain.html`,
			);
			tab = stack.tab;
			await listTestApp(stack);
			// Loaded after the install registered the polyfill for every page.
			await tab.goto(`${SITE}/library.html`);
			await waitForTools(stack, (n) => n.includes("page_complete_todo"));
		}, 60_000);

		afterEach(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		test("the page knows the extension, and a call allowed there is not asked again", async () => {
			await tab.waitFor(
				"window.tabMcpPage?.mcp.extension?.apps.length === 1",
				15_000,
			);
			const pending = call(stack, "page_complete_todo", { id: 4 });
			await answerInPanel(stack, "allow");
			expect((await pending).isError).toBeFalsy();
			expect(await tab.eval(pageAsks)).toBe(false);
			expect(await tab.eval("window.tabMcpPage.calls.at(-1).client")).toEqual({
				kind: "webmcp",
				via: "tab-mcp-extension",
				...TEST_APP,
			});
		});
	},
);
