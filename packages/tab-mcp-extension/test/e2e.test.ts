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
import { build } from "../scripts/build.ts";
import {
	Browser,
	chromeMajor,
	findChromeForTesting,
	type Page,
	type Served,
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
	panel: Page;
	client: Client;
	stop(): Promise<void>;
}

/**
 * Chrome with a build of the extension, `first` open in a tab, the side panel
 * opened by a click on the icon there, set to the test relay and connected,
 * and an MCP client with a token for the panel's address.
 */
async function start(
	options: { store: boolean },
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
		browser = await Browser.launch(chrome as string, {
			extension: outdir,
			args: ["--enable-features=WebMCP"],
			serve,
		});
		const tab = await browser.newPage(first);
		await browser.clickIcon(tab);
		const panelUrl = `chrome-extension://${browser.extensionId}/sidepanel/index.html`;
		const panel = await browser.attach(
			(await browser.waitForTarget((t) => t.url === panelUrl)).targetId,
		);
		await panel.waitFor(`document.getElementById("relay")?.value`);
		// The relay address is under "Settings", closed at first.
		await panel.eval(`document.querySelector("details.settings").open = true`);
		await panel.eval(
			`document.getElementById("relay").value = ${JSON.stringify(relay.url)}`,
		);
		// Saving needs no click of the user's; a click right after "Settings"
		// opened could land before the layout settled.
		await panel.eval(`document.getElementById("relay-form").requestSubmit()`);
		// The panel marks the relay it switched to (after saving it).
		await panel.waitFor(
			`document.documentElement.dataset.relay === ${JSON.stringify(relay.url)}`,
		);
		await panel.click("#connect");
		const address = await panel.waitFor<string>(
			`document.getElementById("address").textContent`,
			15_000,
		);
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
		return { browser, relay, tab, panel, client, stop };
	} catch (error) {
		await stop();
		throw error;
	}
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
const OWN_TOOLS = ["page_info", "webmcp_call", "webmcp_tools"];

const PAGE_TOOLS = [
	"page_get_greeting",
	"page_mcp_result",
	"page_place_order",
	"page_slow_tool",
];

/** Answer the library's confirmation in the side panel with `button`. */
async function answerInPanel(
	stack: Stack,
	button: "Allow" | "Don't allow",
): Promise<void> {
	// The dialog arms "Allow" only while its page has focus.
	await stack.panel.send("Emulation.setFocusEmulationEnabled", {
		enabled: true,
	});
	const selector = `(() => [...document.querySelectorAll("dialog.tab-mcp-dialog button")].find((b) => b.textContent.trim() === ${JSON.stringify(button)} && !b.disabled))()`;
	await stack.panel.waitFor(`!!${selector}`, 10_000);
	await stack.panel.eval(`${selector}.id = "e2e-answer"`);
	await stack.panel.click("#e2e-answer");
}

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
		await answerInPanel(stack, "Allow");
		const result = await allowed;
		expect(result.isError).toBeFalsy();
		expect(result.content[0]?.text).toContain("tea");
		const declined = call(stack, "page_place_order", { item: "coffee" });
		await answerInPanel(stack, "Don't allow");
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
		await answerInPanel(stack, "Allow");
		expect((await ordered).content[0]?.text).toContain("cake");
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
	},
);
