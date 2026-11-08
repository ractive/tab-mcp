/**
 * End to end: the extension in Chrome for Testing, its side panel opened by
 * a real click on the icon and connected to a relay in this process, and an
 * MCP client (as the AI app) calling `page_info`. Pages are served through the
 * DevTools Protocol on https://site.test and https://other.test; WebMCP is on
 * (`--enable-features=WebMCP`).
 *
 * The test build has host access, so the content script follows navigations
 * and tab switches; the store package has none and works on a tab only after
 * a click on the icon there, until the page changes.
 *
 * Needs Chrome for Testing 156 or newer (`CHROME_PATH`, or Puppeteer's or
 * Playwright's cache) and a relay Chrome can reach on 127.0.0.1: required in
 * CI unless `TAB_MCP_EXTENSION_E2E=skip` (CI sets it when neither the
 * extension nor the client changed), skipped elsewhere without Chrome.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

const SITE = "https://site.test";
const OTHER = "https://other.test";

const skipped = process.env["TAB_MCP_EXTENSION_E2E"] === "skip";
const found = skipped ? undefined : findChromeForTesting();
const chrome =
	found !== undefined && chromeMajor(found) >= 156 ? found : undefined;
if (chrome === undefined && !skipped && process.env["CI"])
	throw new Error(
		"Chrome for Testing 156 or newer is needed for the extension's end-to-end tests in CI",
	);

async function serve(url: string): Promise<Served> {
	const { origin, pathname } = new URL(url);
	const name = pathname.slice(1);
	const file = Bun.file(join(import.meta.dir, "pages", name));
	if (
		(origin !== SITE && origin !== OTHER) ||
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
		await panel.eval(
			`document.getElementById("relay").value = ${JSON.stringify(relay.url)}`,
		);
		await panel.click(`#relay-form button[type=submit]`);
		await panel.waitFor(
			`document.getElementById("relay").value === ${JSON.stringify(relay.url)}`,
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

const pageInfo = (stack: Stack) =>
	stack.client.callTool({
		name: "page_info",
		arguments: {},
	}) as Promise<CallResult>;

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

	test("the AI app gets page_info, read-only", async () => {
		const { tools } = await stack.client.listTools();
		expect(tools.map((t) => t.name)).toEqual(["page_info"]);
		expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
	});

	test("page_info tells the page in front and its WebMCP tools", async () => {
		const result = await pageInfo(stack);
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			url: `${SITE}/webmcp.html`,
			title: "Page with WebMCP tools",
			language: "de-CH",
			webmcp: { available: true, tools: 2 },
		});
	});

	test("it follows a navigation", async () => {
		await tab.goto(`${SITE}/plain.html`);
		const result = await pageInfo(stack);
		expect(result.structuredContent).toMatchObject({
			url: `${SITE}/plain.html`,
			title: "Plain page",
			webmcp: { available: true, tools: 0 },
		});
	});

	test("it follows a tab switch", async () => {
		const other = await stack.browser.newPage(`${OTHER}/plain.html`);
		await other.activate();
		expect((await pageInfo(stack)).structuredContent).toMatchObject({
			url: `${OTHER}/plain.html`,
		});
		await tab.activate();
		expect((await pageInfo(stack)).structuredContent).toMatchObject({
			url: `${SITE}/plain.html`,
		});
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

		test("on the same site after a navigation too (Chrome keeps the grant)", async () => {
			await tab.goto(`${SITE}/webmcp.html`);
			expect((await pageInfo(stack)).structuredContent).toMatchObject({
				url: `${SITE}/webmcp.html`,
				webmcp: { available: true, tools: 2 },
			});
		});

		test("on another site it may not, until the next click there", async () => {
			await tab.goto(`${OTHER}/webmcp.html`);
			const refused = await pageInfo(stack);
			expect(refused.isError).toBe(true);
			expect(refused.content[0]?.text).toContain("may not read this tab yet");
			await stack.browser.clickIcon(tab);
			expect((await pageInfo(stack)).structuredContent).toMatchObject({
				url: `${OTHER}/webmcp.html`,
				webmcp: { available: true, tools: 2 },
			});
		});
	},
);
