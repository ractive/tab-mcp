/**
 * End to end in Firefox (iteration 44): the Firefox test build installed as
 * a temporary add-on over WebDriver BiDi, a page on http://localhost that
 * registers its tools wherever `document.modelContext` exists (the same page
 * as Chrome's tests), the panel (opened by the test build in a popup window)
 * set to a relay in this process and connected, and an MCP client as the AI
 * app. Firefox has no WebMCP: the page's tools reach the AI app only through
 * the extension's own `document.modelContext` (`src/firefox/webmcp.ts`).
 *
 * Needs Firefox 128 or newer (`FIREFOX_PATH`, or where it is installed);
 * skipped without it.
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
import { build, FIREFOX_ID } from "../scripts/build.ts";
import { Firefox, findFirefox, firefoxMajor, Tab } from "./firefox.ts";

setDefaultTimeout(30_000);

const binary = findFirefox();
const firefoxOk = binary !== undefined && firefoxMajor(binary) >= 128;

/** The add-on's UUID in the test profile, so the panel's address is known. */
const UUID = "3f9a6c2e-1b7d-4e8a-9c5f-2d4b6a8e0c1f";
const PANEL = `moz-extension://${UUID}/sidepanel/index.html`;

interface CallResult {
	isError?: boolean;
	content: { type: string; text?: string }[];
	structuredContent?: Record<string, unknown>;
}

interface Stack {
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
function libraryBundle(): Promise<string> {
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
function serve() {
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
async function findPanel(firefox: Firefox): Promise<Tab> {
	const end = Date.now() + 15_000;
	for (;;) {
		const found = (await firefox.tabs()).find((t) => t.url === PANEL);
		if (found) return new Tab(firefox, found.context);
		if (Date.now() > end) throw new Error("the panel did not open");
		await Bun.sleep(100);
	}
}

/** Set the relay in the panel's settings; resolves once the connection uses it. */
async function setRelay(panel: Tab, relay: string): Promise<void> {
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

async function mcpClient(relay: TestRelay, address: string): Promise<Client> {
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

async function start(
	page: string,
	prefs: Record<string, string | number | boolean> = {},
): Promise<Stack> {
	const dir = mkdtempSync(join(tmpdir(), "tab-mcp-firefox-ext-"));
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

async function toolNames(stack: Stack): Promise<string[]> {
	return (await stack.client.listTools()).tools.map((t) => t.name).sort();
}

async function waitForTools(
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

/** Answer the newest question in the panel with `answer`. */
async function answerInPanel(
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

describe.skipIf(!firefoxOk)("the Firefox build (the test build)", () => {
	let stack: Stack;

	beforeAll(async () => {
		stack = await start("webmcp.html");
	}, 90_000);

	afterAll(async () => {
		await stack?.client.close();
		await stack?.stop();
	});

	test("the page finds document.modelContext as it loads, and registers", async () => {
		expect(
			await stack.tab.eval(
				`typeof document.modelContext?.registerTool + " " + ("modelContext" in navigator)`,
			),
		).toBe("function true");
		const tools = await stack.tab.eval<{ name: string }[]>(
			"document.modelContext.getTools()",
		);
		expect(tools.map((t) => t.name).sort()).toEqual([
			"get_greeting",
			"mcp_result",
			"mirrored_tool",
			"place_order",
			"slow_tool",
		]);
	});

	test("the panel speaks of Firefox, not Chrome", async () => {
		expect(await stack.panel.eval("document.title")).toBe(
			"tab-mcp browser extension",
		);
		const html = await stack.panel.eval<string>("document.body.innerHTML");
		expect(html).not.toContain("Chrome");
		expect(html).not.toContain("chrome://");
		// The setup commands, made once the address is there.
		expect(html).toContain("tab-mcp-browser-extension-firefox");
		expect(html).toContain("Click into the sidebar to answer.");
		expect(html.toLowerCase()).not.toContain("for-chrome");
	});

	test("the AI app gets page_info, webmcp_tools and the page's tools", async () => {
		const names = await waitForTools(
			stack,
			(n) => n.length >= OWN_TOOLS.length + PAGE_TOOLS.length,
		);
		expect(names).toEqual([...OWN_TOOLS, ...PAGE_TOOLS].sort());
		const { tools } = await stack.client.listTools();
		const greeting = tools.find((t) => t.name === "page_get_greeting");
		expect(greeting?.description).toBe(`From ${stack.site}: Greets a name.`);
		expect(greeting?.annotations?.readOnlyHint).toBe(true);
	});

	test("page_info tells the page in front and its WebMCP tools", async () => {
		const result = await call(stack, "page_info");
		expect(result.structuredContent).toEqual({
			url: `${stack.site}/webmcp.html`,
			title: "Page with WebMCP tools",
			language: "de-CH",
			webmcp: { available: true, tools: 5 },
		});
	});

	test("a read-only tool runs at once, with the page's answer", async () => {
		const result = await call(stack, "page_get_greeting", { name: "Ada" });
		expect(result.isError).toBeFalsy();
		expect(result.content).toEqual([{ type: "text", text: "Hello, Ada!" }]);
		expect(await stack.tab.eval("window.calls.at(-1)")).toEqual([
			"get_greeting",
			"Ada",
		]);
	});

	test("arguments are checked against the page's schema", async () => {
		const before = await stack.tab.eval<number>("window.calls.length");
		const result = await call(stack, "page_get_greeting", { name: 42 });
		expect(result.isError).toBe(true);
		expect(await stack.tab.eval("window.calls.length")).toBe(before);
	});

	test("an MCP result from the page passes as its content", async () => {
		expect((await call(stack, "page_mcp_result")).content).toEqual([
			{ type: "text", text: "from an MCP result" },
		]);
	});

	test("a tool not marked read-only asks in the panel first", async () => {
		const allowed = call(stack, "page_place_order", { item: "tea" });
		await answerInPanel(stack, "allow").catch(async (error: unknown) => {
			// How the call ended, if it did: why no question showed.
			const ended = await Promise.race([
				allowed,
				Bun.sleep(1000).then(() => "pending"),
			]);
			throw new Error(`${String(error)}\nThe call: ${JSON.stringify(ended)}`);
		});
		const result = await allowed;
		expect(result.content[0]?.text).toContain("tea");
		expect(result.isError).toBeFalsy();
		const declined = call(stack, "page_place_order", { item: "coffee" });
		await answerInPanel(stack, "deny");
		expect((await declined).isError).toBe(true);
		expect(await stack.tab.eval("window.calls.map((c) => c[1])")).not.toContain(
			"coffee",
		);
	});

	test("cancelling a call aborts the page's signal", async () => {
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

	test("the list follows toolchange: a tool registered later, and one whose signal aborts", async () => {
		await stack.tab.eval(`(() => {
			window.later = new AbortController();
			return document.modelContext.registerTool({
				name: "registered_later",
				description: "Registered after the load.",
				annotations: { readOnlyHint: true },
				execute: () => "later",
			}, { signal: window.later.signal });
		})()`);
		await waitForTools(stack, (n) => n.includes("page_registered_later"));
		expect((await call(stack, "page_registered_later")).content).toEqual([
			{ type: "text", text: "later" },
		]);
		await stack.tab.eval("window.later.abort()");
		await waitForTools(stack, (n) => !n.includes("page_registered_later"));
	});

	test("the page can break only its own object: a replaced getter leaves the extension's tools", async () => {
		await stack.tab.eval(`(() => {
			Object.defineProperty(Document.prototype, "modelContext", { get: () => ({ getTools: async () => [] }), configurable: true });
		})()`);
		const result = await call(stack, "page_info");
		expect(result.structuredContent?.["webmcp"]).toMatchObject({
			available: true,
			tools: 5,
		});
	});

	// navigator.modelContext from here: the test before replaced the document's getter.
	test("registerTool then unregisterTool in one tick: the page's order holds", async () => {
		const names = await stack.tab.eval<string[]>(`(async () => {
			const context = navigator.modelContext;
			const done = context.registerTool({ name: "short_lived", description: "d", execute: () => "x" });
			context.unregisterTool("short_lived");
			await done;
			return (await context.getTools()).map((t) => t.name);
		})()`);
		expect(names).not.toContain("short_lived");
	});

	test("provideContext with an invalid tool changes nothing; at most 1024 tools over all calls", async () => {
		const seen = await stack.tab.eval<{
			invalid: string;
			afterInvalid: number;
			quota: string;
			total: number;
		}>(`(async () => {
			const context = navigator.modelContext;
			const tool = (name) => ({ name, description: "d", execute: () => "x" });
			const count = async () => (await context.getTools()).length;
			const before = await count();
			let invalid = "none";
			try {
				await context.provideContext({ tools: [tool("ok_one"), { name: "broken" }] });
			} catch (e) {
				invalid = e.name;
			}
			const afterInvalid = (await count()) - before;
			for (let i = 0; i < 1000; i++) await context.registerTool(tool("r" + i));
			let quota = "none";
			try {
				await context.provideContext({ tools: Array.from({ length: 1000 }, (_, i) => tool("p" + i)) });
			} catch (e) {
				quota = e.name;
			}
			return { invalid, afterInvalid, quota, total: await count() };
		})()`);
		expect(seen.invalid).toBe("TypeError");
		expect(seen.afterInvalid).toBe(0);
		expect(seen.quota).toBe("QuotaExceededError");
		expect(seen.total).toBeLessThanOrEqual(1024);
	});
});

describe.skipIf(!firefoxOk)(
	"the event page (Firefox has no extension service workers)",
	() => {
		let stack: Stack;

		beforeAll(async () => {
			// Firefox stops an idle event page after 30 s; here after 3 s.
			stack = await start("webmcp.html", {
				"extensions.background.idle.timeout": 3_000,
			});
		}, 90_000);

		afterAll(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		test("with the panel open, the connection outlasts the idle timeout", async () => {
			await Bun.sleep(10_000);
			const result = await call(stack, "page_info");
			expect(result.structuredContent?.["webmcp"]).toMatchObject({ tools: 5 });
		}, 30_000);

		test("with the panel closed too", async () => {
			await stack.panel.eval("window.close()").catch(() => {});
			await Bun.sleep(10_000);
			const result = await call(stack, "page_info");
			expect(result.structuredContent?.["webmcp"]).toMatchObject({ tools: 5 });
		}, 30_000);
	},
);

describe.skipIf(!firefoxOk)("an extension reload or update", () => {
	let stack: Stack;

	beforeAll(async () => {
		stack = await start("webmcp.html", {
			"extensions.webextensions.keepUuidOnUninstall": true,
		});
	}, 90_000);

	afterAll(async () => {
		await stack?.client.close().catch(() => {});
		await stack?.stop();
	});

	test("the page's tools outlive the content script: a new one takes them over at once", async () => {
		const before = await stack.tab.eval<string[]>(
			`document.modelContext.getTools().then((t) => t.map((x) => x.name))`,
		);
		expect(before).toHaveLength(5);
		// What the page holds: its object, and handlers on it. A handler
		// runs for an event the page dispatches itself too.
		expect(
			await stack.tab.eval(`(() => {
				window.held = document.modelContext;
				window.changes = 0;
				window.activated = 0;
				document.modelContext.ontoolchange = () => { window.changes++; };
				document.modelContext.ontoolactivated = () => { window.activated++; };
				document.modelContext.dispatchEvent(new Event("toolactivated"));
				return window.activated;
			})()`),
		).toBe(1);
		await stack.firefox.send("webExtension.uninstall", {
			extension: FIREFOX_ID,
		});
		// The getter is the page's own (bound), the methods were the script's.
		expect(
			await stack.tab.eval(`(async () => {
				if (document.modelContext !== window.held) return "another object";
				try { await document.modelContext.getTools(); return "worked"; }
				catch (e) { return String(e); }
			})()`),
		).toBe("TypeError: can't access dead object");
		// Installed again (an update): the extension puts the content script
		// into the open page itself, and it takes the page's tools over.
		await stack.firefox.installExtension(stack.outdir);
		const panel = await findPanel(stack.firefox);
		expect(
			await stack.tab.waitFor<string[]>(
				`document.modelContext.getTools().then((t) => t.map((x) => x.name))`,
			),
		).toEqual(before);
		const info = await panel.eval<{ webmcp: unknown }>(`(async () => {
			const [tab] = await chrome.tabs.query({ url: "http://localhost/*" });
			return chrome.tabs.sendMessage(tab.id, { type: "page-info" });
		})()`);
		expect(info.webmcp).toEqual({ available: true, tools: 5 });
		expect(
			await stack.tab.eval(`(async () => {
				const context = document.modelContext;
				const greeting = await context.executeTool({ name: "get_greeting" }, { name: "Ada" });
				await context.registerTool({ name: "after_reload", description: "d", execute: () => "x" });
				context.dispatchEvent(new Event("toolactivated"));
				return {
					activated: window.activated,
					same: context === window.held && navigator.modelContext === context,
					greeting,
					changes: window.changes,
					handler: typeof context.ontoolchange,
					tools: (await context.getTools()).length,
				};
			})()`),
		).toEqual({
			activated: 2,
			same: true,
			greeting: "Hello, Ada!",
			changes: 1,
			handler: "function",
			tools: 6,
		});
	}, 60_000);
});

describe.skipIf(!firefoxOk)(
	"a page with the client library, the Firefox build's WebMCP (DEC-207)",
	() => {
		let stack: Stack;

		beforeAll(async () => {
			stack = await start("library.html");
			// Off and on again: the relay lists the test's AI app (a token
			// written into its store is not announced to a running session).
			await stack.panel.eval(`(async () => {
				const port = chrome.runtime.connect({ name: "panel" });
				port.postMessage({ type: "stop" });
				port.postMessage({ type: "connect" });
				await new Promise((resolve) => setTimeout(resolve, 500));
				port.disconnect();
			})()`);
			await waitForTools(stack, (n) => n.includes("page_complete_todo"));
		}, 90_000);

		afterAll(async () => {
			await stack?.client.close();
			await stack?.stop();
		});

		test("the page knows the extension and its AI app; a call allowed there is not asked again", async () => {
			await stack.tab.waitFor(
				"window.tabMcpPage?.mcp.extension?.apps.length === 1",
				15_000,
			);
			expect(
				await stack.tab.eval("window.tabMcpPage.mcp.extension.apps"),
			).toEqual([{ name: "Test client", host: "client.example" }]);
			const pending = call(stack, "page_complete_todo", { id: 5 });
			await answerInPanel(stack, "allow");
			expect((await pending).isError).toBeFalsy();
			expect(
				await stack.tab.eval(
					`document.querySelector("dialog.tab-mcp-confirm") === null`,
				),
			).toBe(true);
			expect(
				await stack.tab.eval("window.tabMcpPage.calls.at(-1).client"),
			).toEqual({
				kind: "webmcp",
				via: "tab-mcp-extension",
				name: "Test client",
				host: "client.example",
			});
		});
	},
);
