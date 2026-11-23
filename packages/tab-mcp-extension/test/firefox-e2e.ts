/**
 * The harness of the extension's Firefox end-to-end tests (iteration 44), for
 * firefox-smoke.browser.test.ts and firefox-full.browser.test.ts: the Firefox
 * test build installed as a temporary add-on over WebDriver BiDi, a page on
 * http://localhost that registers its tools wherever `document.modelContext`
 * exists (the same page as Chrome's tests), the panel (opened by the test
 * build in a popup window) set to a relay in this process and connected, and
 * an MCP client as the AI app. Firefox has no WebMCP: the page's tools reach
 * the AI app only through the extension's own `document.modelContext`
 * (`src/firefox/webmcp.ts`).
 */

import { expect } from "bun:test";
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
import { browserTempDir } from "../../../test/browser-dirs.ts";
import { browserTests } from "../../../test/browser-gate.ts";
import { build, FIREFOX_ID } from "../scripts/build.ts";
import { Firefox, firefoxMajor, Tab } from "./firefox.ts";

let binary: string | undefined;

/**
 * The Firefox `start` launches: `found`, the test file's own
 * `findFirefox()` (scripts/test-browser.ts reads which browsers a file
 * needs from its calls), if it is 140 or newer. Whether the tests run.
 */
export function useFirefox(found: string | undefined): boolean {
	const ok = found !== undefined && firefoxMajor(found) >= 140;
	if (browserTests && !ok && process.env["CI"])
		throw new Error(
			"Firefox 140 or newer is needed for the extension's Firefox tests in CI",
		);
	binary = ok ? found : undefined;
	return ok;
}

/** The add-on's UUID in the test profile, so the panel's address is known. */
export const UUID = "3f9a6c2e-1b7d-4e8a-9c5f-2d4b6a8e0c1f";
export const PANEL = `moz-extension://${UUID}/sidepanel/index.html`;

export interface CallResult {
	isError?: boolean;
	content: { type: string; text?: string }[];
	structuredContent?: Record<string, unknown>;
}

export interface Stack {
	firefox: Firefox;
	relay: TestRelay;
	server: ReturnType<typeof Bun.serve>;
	site: string;
	tab: Tab;
	panel: Tab;
	address: string;
	client: Client;
	/** The test build, installed from here. */
	outdir: string;
	stop(): Promise<void>;
}

/** `pages/library.ts` bundled, the client library in it (DEC-207), once. */
let libraryScript: Promise<string> | undefined;
export function libraryBundle(): Promise<string> {
	libraryScript ??= Bun.build({
		entrypoints: [join(import.meta.dir, "pages", "library.ts")],
		target: "browser",
		format: "esm",
	}).then((result) => {
		const [output] = result.outputs;
		if (!result.success || output === undefined)
			throw new Error(`the library page did not build: ${result.logs}`);
		return output.text();
	});
	return libraryScript;
}

/** The test pages, on http://localhost (a secure context). */
export function serve() {
	return Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const name = new URL(request.url).pathname.slice(1);
			if (name === "library.js")
				return new Response(await libraryBundle(), {
					headers: { "content-type": "text/javascript; charset=utf-8" },
				});
			const file = Bun.file(join(import.meta.dir, "pages", name));
			if (!/^[a-z]+\.html$/.test(name) || !(await file.exists()))
				return new Response("not found", { status: 404 });
			return new Response(file, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		},
	});
}

/** The panel's tab, once the build has opened it. */
export async function findPanel(firefox: Firefox): Promise<Tab> {
	const end = Date.now() + 15_000;
	for (;;) {
		const found = (await firefox.tabs()).find((t) => t.url === PANEL);
		if (found) return new Tab(firefox, found.context);
		if (Date.now() > end) throw new Error("the panel did not open");
		await Bun.sleep(100);
	}
}

/** Set the relay in the panel's settings; resolves once the connection uses it. */
export async function setRelay(panel: Tab, relay: string): Promise<void> {
	await panel.waitFor(`document.getElementById("relay")?.value !== ""`);
	await panel.eval(`document.querySelector("details.settings").open = true`);
	await panel.eval(
		`document.getElementById("relay").value = ${JSON.stringify(relay)}`,
	);
	await panel.eval(`(() => {
		document.getElementById("relay-form").requestSubmit();
		document.getElementById("relay").value = "";
	})()`);
	await panel.waitFor(
		`document.getElementById("relay").value === ${JSON.stringify(relay)}`,
	);
}

export async function mcpClient(
	relay: TestRelay,
	address: string,
): Promise<Client> {
	const token = await tokenFor(relay, address);
	const client = new Client(
		{ name: "firefox-e2e", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL(address), {
			requestInit: { headers: { authorization: `Bearer ${token}` } },
		}),
	);
	return client;
}

export async function start(
	page: string,
	prefs: Record<string, string | number | boolean> = {},
): Promise<Stack> {
	const dir = browserTempDir("firefox-build-");
	const relay = startTestRelay();
	const server = serve();
	let firefox: Firefox | undefined;
	const stop = async () => {
		await firefox?.close();
		await relay.stop();
		server.stop(true);
		rmSync(dir, { recursive: true, force: true });
	};
	try {
		const outdir = join(dir, "dist");
		await build({ outdir, firefox: true, test: true, minify: false });
		firefox = await Firefox.launch(binary as string, {
			prefs: {
				"extensions.webextensions.uuids": JSON.stringify({
					[FIREFOX_ID]: UUID,
				}),
				...prefs,
			},
		});
		expect(await firefox.installExtension(outdir)).toBe(FIREFOX_ID);
		const panel = await findPanel(firefox);
		const site = `http://localhost:${server.port}`;
		// In a window of its own: the panel's tab stays in front in the first.
		const tab = await firefox.newTab(`${site}/${page}`, "window");
		await setRelay(panel, relay.url);
		await panel.eval(`document.getElementById("connect").click()`);
		const address = await panel
			.waitFor<string>(`document.getElementById("address").textContent`, 15_000)
			.catch(async (error: unknown) => {
				const text = await panel.eval<string>("document.body.innerText");
				throw new Error(`${String(error)}\nThe panel says:\n${text}`);
			});
		const client = await mcpClient(relay, address);
		return {
			firefox,
			relay,
			server,
			site,
			tab,
			panel,
			address,
			client,
			outdir,
			stop,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}

/** `expression` evaluated in the extension's background page, as `bg`, from the panel. */
export const inBackground = <T = unknown>(stack: Stack, expression: string) =>
	stack.panel.eval<T>(
		`browser.runtime.getBackgroundPage().then((bg) => JSON.parse(JSON.stringify(${expression} ?? null)))`,
	);

export interface Shown {
	title: string;
	message: string;
	contextMessage?: string;
	iconUrl?: string;
	buttons?: unknown;
	requireInteraction?: unknown;
}

/** What the Firefox test build's recorder holds: shown notifications by id. */
export const recorded = (stack: Stack) =>
	inBackground<Record<string, Shown>>(stack, "bg.tabMcpNotificationRecorder()");

/**
 * A click on the extension's icon over the stack's page, as far as Firefox
 * is concerned: the action's own `triggerAction` (what a click and the
 * keyboard shortcut run, which grants `activeTab`), called in Firefox's
 * chrome window whose selected tab is the page (BiDi's `moz:scope: "chrome"`,
 * with the system access the harness has). BiDi cannot click the toolbar.
 */
export async function clickIcon(stack: Stack): Promise<void> {
	const { contexts } = (await stack.firefox.send("browsingContext.getTree", {
		maxDepth: 0,
		"moz:scope": "chrome",
	})) as { contexts: { context: string; url: string }[] };
	for (const { context, url } of contexts) {
		if (!url.startsWith("chrome://browser/content/browser.xhtml")) continue;
		const window = new Tab(stack.firefox, context);
		const selected = await window.eval<string>(
			"gBrowser.selectedBrowser.currentURI.spec",
		);
		if (!selected.startsWith(stack.site)) continue;
		const clicked = await window.eval<string>(`(() => {
			const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
			const extension = ExtensionParent.GlobalManager.getExtension(${JSON.stringify(FIREFOX_ID)});
			const action = ExtensionParent.apiManager.global.browserActionFor?.(extension);
			if (typeof action?.triggerAction !== "function") return "no triggerAction";
			action.triggerAction(window);
			return "clicked";
		})()`);
		if (clicked !== "clicked") throw new Error(`no click: ${clicked}`);
		return;
	}
	throw new Error(`no Firefox window shows ${stack.site}`);
}

/** The recorded notification whose message names `word`, once there. */
export async function notificationFor(
	stack: Stack,
	word: string,
): Promise<[string, Shown]> {
	for (
		const end = Date.now() + 10_000;
		Date.now() < end;
		await Bun.sleep(100)
	) {
		const hit = Object.entries(await recorded(stack)).find(([, shown]) =>
			shown.message.includes(word),
		);
		if (hit) return hit;
	}
	throw new Error(
		`no notification for ${word}: ${JSON.stringify(await recorded(stack))}`,
	);
}

export const call = (
	stack: Stack,
	name: string,
	args: Record<string, unknown> = {},
	options: { signal?: AbortSignal } = {},
) =>
	stack.client.callTool(
		{ name, arguments: args },
		options,
	) as Promise<CallResult>;

export async function toolNames(stack: Stack): Promise<string[]> {
	return (await stack.client.listTools()).tools.map((t) => t.name).sort();
}

export async function waitForTools(
	stack: Stack,
	check: (names: string[]) => boolean,
): Promise<string[]> {
	const end = Date.now() + 15_000;
	for (;;) {
		const names = await toolNames(stack);
		if (check(names)) return names;
		if (Date.now() > end)
			throw new Error(`the tool list stayed ${JSON.stringify(names)}`);
		await Bun.sleep(100);
	}
}

export const OWN_TOOLS = [
	"go_back",
	"go_forward",
	"navigate",
	"page_info",
	"reload",
	"webmcp_call",
	"webmcp_tools",
];

export const PAGE_TOOLS = [
	"page_get_greeting",
	"page_mcp_result",
	"page_mirrored_tool",
	"page_place_order",
	"page_slow_tool",
];

/** Answer the newest question in the panel with `answer`. */
export async function answerInPanel(
	stack: Stack,
	answer: "allow" | "site" | "deny",
): Promise<void> {
	const selector = `[...document.querySelectorAll('[data-question] button[data-answer="${answer}"]')].at(-1)`;
	// Allow counts once the panel has been in front a while. BiDi cannot
	// activate an extension's page; the panel brings its own window forward.
	await stack.panel.eval(
		"chrome.windows.getCurrent().then((w) => chrome.windows.update(w.id, { focused: true })).then(() => true)",
	);
	// Asked again on every check: headless Firefox hands the focus to a
	// window it created after the panel's, at times.
	await stack.panel
		.waitFor(
			`(void chrome.windows.getCurrent().then((w) => chrome.windows.update(w.id, { focused: true })), ${selector} && ${selector}.getAttribute("aria-disabled") !== "true")`,
			10_000,
		)
		.catch(async (error: unknown) => {
			const seen = await stack.panel.eval(
				`({ button: Boolean(${selector}), focus: document.hasFocus(), visibility: document.visibilityState, text: document.body.innerText.slice(0, 1500) })`,
			);
			throw new Error(`${String(error)}\nThe panel: ${JSON.stringify(seen)}`);
		});
	// Allow takes clicks: the hint why it waits is gone.
	expect(
		await stack.panel.eval(`document.getElementById("focus-hint").hidden`),
	).toBe(true);
	await stack.panel.eval(`${selector}.click()`);
}
