/**
 * The parts that need no browser: the manifest of each build, the key's id,
 * reading a page, the tool and the refusals.
 */

import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
	createManifest,
	extensionId,
	mitText,
	readKey,
	STORE_ID,
} from "../scripts/build.ts";
import { openSidebar, type SidebarAction } from "../src/browser.ts";
import { connectPolyfill } from "../src/chrome/webmcp-port.ts";
import {
	callTool,
	FIREFOX_NO_WEBMCP_NOTE,
	MAX_LANGUAGE,
	MAX_PAGE_TITLE,
	MAX_SEND_RESULT,
	pageInfo,
	pageTools,
	SHARE_READ_MS,
	ToolReads,
} from "../src/content.ts";
import { SERVER_NAME } from "../src/protocol.ts";
import { relayProblem } from "../src/relay.ts";
import { ask, callFailed, noAccess } from "../src/tabs.ts";
import { PageError, readTool, ToolRegistry } from "../src/webmcp/registry.ts";
import { createTools } from "../src/worker/tools.ts";

describe("manifest", () => {
	test("the development build has the key and no host access", () => {
		const manifest = createManifest("1.2.3", { key: "KEY" });
		expect(manifest["key"]).toBe("KEY");
		expect(manifest["host_permissions"]).toBeUndefined();
		// Sites only, no file: pages; no Incognito tabs (ES 9).
		expect(manifest["optional_host_permissions"]).toEqual([
			"http://*/*",
			"https://*/*",
		]);
		expect(manifest["incognito"]).toBe("not_allowed");
		expect(manifest["permissions"]).toEqual([
			"activeTab",
			"alarms",
			"notifications",
			"scripting",
			"sidePanel",
		]);
	});

	test("the test build has host access and no key; the store build neither", () => {
		expect(createManifest("1.0.0", { test: true })).toMatchObject({
			host_permissions: ["http://*/*", "https://*/*"],
		});
		const store = createManifest("1.0.0", {});
		expect(store["key"]).toBeUndefined();
		expect(store["host_permissions"]).toBeUndefined();
	});

	test("the description is the store summary: at most 132 characters", () => {
		const description = String(createManifest("1.0.0", {})["description"]);
		expect(description.length).toBeLessThanOrEqual(132);
		// It names both things the extension does: the tools and navigation.
		expect(description).toContain("WebMCP tools");
		expect(description).toContain("open pages");
	});

	test("the development build's key gives the Chrome Web Store id", async () => {
		expect(extensionId(await readKey())).toBe(STORE_ID);
	});

	test("the id is Chrome's: the SHA-256 of the key, written with a to p", () => {
		const der = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		}).publicKey.export({ type: "spki", format: "der" });
		const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
		const expected = [...hex]
			.map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
			.join("");
		expect(extensionId(der.toString("base64"))).toBe(expected);
		expect(expected).toMatch(/^[a-p]{32}$/);
	});

	test("a notice without an MIT text stops the build", () => {
		expect(() => mitText("x", "no licence here")).toThrow("no MIT licence");
		expect(mitText("x", "header\nMIT License\ntext")).toBe("MIT License\ntext");
	});
});

/** A document as far as `pageInfo` reads it. */
function fakeDocument(options: {
	lang?: string;
	title?: string;
	tools?: number | Error;
}): Document {
	const context =
		options.tools === undefined
			? undefined
			: {
					getTools: async () => {
						if (options.tools instanceof Error) throw options.tools;
						return new Array(options.tools).fill({});
					},
				};
	return {
		location: { href: "https://example.com/a" },
		title: options.title ?? "Example",
		documentElement: { lang: options.lang ?? "" },
		...(context ? { modelContext: context } : {}),
	} as unknown as Document;
}

describe("pageInfo", () => {
	test("a page without WebMCP", async () => {
		expect(await pageInfo(fakeDocument({}))).toEqual({
			url: "https://example.com/a",
			title: "Example",
			webmcp: { available: false, tools: 0 },
		});
	});

	test("Firefox: a page without WebMCP says to reload it (it loaded before tab-mcp had access)", async () => {
		const global = globalThis as { TAB_MCP_FIREFOX?: boolean };
		global.TAB_MCP_FIREFOX = true;
		try {
			expect((await pageInfo(fakeDocument({}))).webmcp).toEqual({
				available: false,
				tools: 0,
				note: FIREFOX_NO_WEBMCP_NOTE,
			});
			expect((await pageInfo(fakeDocument({ tools: 1 }))).webmcp).toEqual({
				available: true,
				tools: 1,
			});
		} finally {
			delete global.TAB_MCP_FIREFOX;
		}
	});

	test("a page with WebMCP and its tools, and its language", async () => {
		expect(await pageInfo(fakeDocument({ lang: " fr ", tools: 3 }))).toEqual({
			url: "https://example.com/a",
			title: "Example",
			language: "fr",
			webmcp: { available: true, tools: 3 },
		});
	});

	test("tools that cannot be counted say why", async () => {
		const info = await pageInfo(
			fakeDocument({ tools: new Error("disallowed by permissions policy") }),
		);
		expect(info.webmcp).toEqual({
			available: true,
			tools: 0,
			error: "disallowed by permissions policy",
		});
	});

	test("the page's title and language are cut: a 2 MB title cannot fill every answer (ES 6)", async () => {
		const info = await pageInfo(
			fakeDocument({ title: "t".repeat(2_000_000), lang: "x".repeat(1000) }),
		);
		expect(info.title.length).toBe(MAX_PAGE_TITLE);
		expect(info.language?.length).toBe(MAX_LANGUAGE);
	});
});

describe("page_info", () => {
	test("read-only, untrusted, and answers for the tab in front", async () => {
		const [tool] = createTools(
			{
				current: async () => ({
					id: 7,
					url: "https://example.com/",
					title: "",
				}),
				page: async (tab) => ({
					url: tab.url,
					title: "From the page",
					webmcp: { available: false, tools: 0 },
				}),
			},
			() => ({
				state: { available: false, tools: [] },
				refresh: async () => {},
				callByName: async () => undefined,
			}),
		);
		expect(tool?.name).toBe("page_info");
		expect(tool?.annotations).toEqual({
			readOnlyHint: true,
			untrustedContentHint: true,
		});
		const options = {} as Parameters<NonNullable<typeof tool>["execute"]>[1];
		expect(await tool?.execute({}, options)).toEqual({
			url: "https://example.com/",
			title: "From the page",
			webmcp: { available: false, tools: 0 },
		});
	});
});

describe("refusals", () => {
	test("a hidden address (no grant) is any page", () => {
		expect(noAccess("").message).toContain("may not read this tab yet");
		expect(noAccess("").reason).toBe("hidden");
		expect(noAccess("https://shop.example/").reason).toBe("no-grant");
		// The icon is in the toolbar, not on the tab; the host access button
		// by its label (EQ 6, EQ 9).
		expect(noAccess("").message).toContain("icon in Chrome's toolbar");
		expect(noAccess("").message).toContain("Give access to all sites");
	});

	test("browser pages and the Web Store cannot be read at all", () => {
		expect(noAccess("chrome://settings/").message).toContain("browser page");
		expect(noAccess("chrome://settings/").reason).toBe("browser-page");
		const store = noAccess("https://chromewebstore.google.com/detail/x");
		expect(store.message).toContain("Chrome Web Store");
		expect(store.reason).toBe("web-store");
		expect(noAccess("file:///tmp/a.html").reason).toBe("not-site");
	});

	test("the MCP server name is the product's (DEC-193)", () => {
		expect(SERVER_NAME).toBe("tab-mcp-browser-extension");
	});

	test("a web page needs a click or host access", () => {
		expect(noAccess("https://example.com/").message).toContain(
			"The tab-mcp browser extension may not read this tab yet. The user can click its icon in Chrome's toolbar",
		);
	});
});

describe("relay address", () => {
	test("https, and plain http only for localhost", () => {
		expect(relayProblem("https://tab-mcp.ractive.ch")).toBeUndefined();
		expect(relayProblem("http://127.0.0.1:8080")).toBeUndefined();
		expect(relayProblem("http://relay.example")).toContain("localhost");
		expect(relayProblem("ftp://relay.example")).toContain("https:");
		expect(relayProblem("nonsense")).toBe("Not an address.");
	});
});

/** A document with WebMCP tools, as the content script reads it. */
function toolDocument(
	tools: { name: string; readOnly: boolean }[],
	mirrored = "",
	result = "ran",
) {
	const executed: string[] = [];
	const registered = tools.map((t) => ({
		name: t.name,
		description: `${t.name}.`,
		inputSchema: { type: "object" },
		annotations: { readOnlyHint: t.readOnly },
	}));
	const doc = {
		location: { href: "https://shop.example/", origin: "https://shop.example" },
		title: "Shop",
		documentElement: {
			lang: "",
			getAttribute: (name: string) =>
				name === "data-tab-mcp-webmcp" ? mirrored : null,
		},
		modelContext: {
			getTools: async () => registered,
			executeTool: async (tool: { name: string }) => {
				executed.push(tool.name);
				return result;
			},
		},
	} as unknown as Document;
	return { doc, executed };
}

describe("calls in the content script", () => {
	const signal = new AbortController().signal;

	test("a call listed from this page, with the same claim, runs", async () => {
		const { doc, executed } = toolDocument([{ name: "buy", readOnly: false }]);
		const listed = await pageTools(doc, "doc-A");
		expect(listed.documentId).toBe("doc-A");
		expect(
			await callTool(
				{ documentId: "doc-A", name: "buy", readOnly: false },
				{},
				signal,
				doc,
				"doc-A",
			),
		).toEqual({ ok: true, value: "ran" });
		expect(executed).toEqual(["buy"]);
	});

	test("a call listed from another page (the tab navigated) never runs", async () => {
		const { doc, executed } = toolDocument([{ name: "buy", readOnly: false }]);
		const result = await callTool(
			{ documentId: "doc-A", name: "buy", readOnly: false },
			{},
			signal,
			doc,
			"doc-B",
		);
		expect(result).toMatchObject({ ok: false, gone: true });
		expect(executed).toEqual([]);
	});

	test("a tool whose read-only claim changed since it was listed never runs", async () => {
		// Offered as read-only (no confirmation), now consequential: refused.
		const { doc, executed } = toolDocument([{ name: "buy", readOnly: false }]);
		const result = await callTool(
			{ documentId: "doc-A", name: "buy", readOnly: true },
			{},
			signal,
			doc,
			"doc-A",
		);
		expect(result).toMatchObject({ ok: false, gone: true });
		expect(executed).toEqual([]);
	});

	test("tools a tab-mcp page mirrors are offered and called like its own (WM 1)", async () => {
		// `data-tab-mcp-webmcp` says nothing about whether the AI app is paired
		// with the page itself.
		const { doc, executed } = toolDocument(
			[
				{ name: "own", readOnly: true },
				{ name: "mirror", readOnly: true },
			],
			"mirror",
		);
		const listed = await pageTools(doc, "doc-A");
		expect(listed.tools.map((t) => t.name)).toEqual(["own", "mirror"]);
		expect(listed).not.toHaveProperty("mirrored");
		expect(
			await callTool(
				{ documentId: "doc-A", name: "mirror", readOnly: true },
				{},
				signal,
				doc,
				"doc-A",
			),
		).toEqual({ ok: true, value: "ran" });
		expect(executed).toEqual(["mirror"]);
	});

	test("a result over the size passed on is refused with its own error (ES 6)", async () => {
		const { doc } = toolDocument(
			[{ name: "big", readOnly: true }],
			"",
			"r".repeat(MAX_SEND_RESULT + 1),
		);
		const result = await callTool(
			{ documentId: "doc-A", name: "big", readOnly: true },
			{},
			signal,
			doc,
			"doc-A",
		);
		expect(result).toEqual({
			ok: false,
			error: `It returned ${MAX_SEND_RESULT + 1} characters; the tab-mcp browser extension passes on at most ${MAX_SEND_RESULT}.`,
		});
	});

	test("a tool is sent with what the bridge uses: readOnlyHint, debugging, consequentialHint, outputSchema (WM 3, WM 8)", async () => {
		const outputSchema = { type: "object", properties: { n: {} } };
		const doc = {
			location: {
				href: "https://shop.example/",
				origin: "https://shop.example",
			},
			title: "Shop",
			documentElement: { lang: "" },
			modelContext: {
				getTools: async () => [
					{
						name: "typed",
						description: "d",
						outputSchema,
						annotations: {
							readOnlyHint: true,
							consequentialHint: true,
							untrustedContentHint: true,
							debugging: true,
						},
					},
					{
						name: "huge",
						description: "d",
						outputSchema: { type: "object", description: "z".repeat(17000) },
					},
					{
						name: "add",
						description: "d",
						annotations: {
							consequentialHint: false,
							debugging: false,
							readOnlyHint: false,
							untrustedContentHint: false,
						},
					},
					{
						name: "odd",
						description: "d",
						annotations: { consequentialHint: "yes" },
					},
				],
				executeTool: async () => "ran",
			},
		} as unknown as Document;
		const listed = await pageTools(doc, "doc-A");
		expect(listed.tools).toEqual([
			{
				name: "typed",
				description: "d",
				outputSchema,
				annotations: {
					readOnlyHint: true,
					debugging: true,
					consequentialHint: true,
				},
			},
			// An output schema over 16 KB is left out; the tool is not. No
			// annotations: no consequentialHint, nothing is known (DEC-214).
			{
				name: "huge",
				description: "d",
				annotations: { readOnlyHint: false, debugging: false },
			},
			{
				name: "add",
				description: "d",
				annotations: {
					readOnlyHint: false,
					debugging: false,
					consequentialHint: false,
				},
			},
			// A hint that is no boolean (not from Chrome) is as none.
			{
				name: "odd",
				description: "d",
				annotations: { readOnlyHint: false, debugging: false },
			},
		]);
	});

	test("what a page sends is capped", async () => {
		const { doc } = toolDocument(
			Array.from({ length: 300 }, (_, i) => ({
				name: `t${i}`,
				readOnly: true,
			})),
		);
		const listed = await pageTools(doc, "doc-A");
		expect(listed.tools.length).toBe(256);
		expect(listed.more).toBe(44);
	});
});

/** A `document.modelContext` that counts its `getTools()` calls. */
class CountingContext extends EventTarget {
	calls = 0;
	/** Resolves the calls still waiting, if `hold` kept them waiting. */
	readonly waiting: (() => void)[] = [];
	hold = false;
	tools = [
		{ name: "a", description: "A.", annotations: { readOnlyHint: true } },
	];

	getTools(): Promise<typeof this.tools> {
		this.calls++;
		const tools = [...this.tools];
		if (!this.hold) return Promise.resolve(tools);
		return new Promise((resolve) => this.waiting.push(() => resolve(tools)));
	}

	executeTool(): Promise<string> {
		return Promise.resolve("ran");
	}

	release(): void {
		for (const resolve of this.waiting.splice(0)) resolve();
	}
}

describe("reading the page's tools rarely (DEC-177)", () => {
	const setup = () => {
		const context = new CountingContext();
		let now = 1_000;
		const reads = new ToolReads(context, () => now);
		return {
			context,
			reads,
			advance: (ms: number) => {
				now += ms;
			},
		};
	};

	test("the reads after a load (list, page info, again) are one getTools()", async () => {
		const context = new CountingContext();
		const doc = {
			location: {
				href: "https://shop.example/",
				origin: "https://shop.example",
			},
			title: "Shop",
			documentElement: { lang: "" },
			modelContext: context,
		} as unknown as Document;
		context.hold = true;
		const first = Promise.all([pageTools(doc, "doc-A"), pageInfo(doc)]);
		context.release();
		const [listed, info] = await first;
		expect(listed.tools.map((t) => t.name)).toEqual(["a"]);
		expect(info.webmcp).toEqual({ available: true, tools: 1 });
		await pageTools(doc, "doc-A");
		await pageInfo(doc);
		expect(context.calls).toBe(1);
	});

	test("a read is shared for SHARE_READ_MS after it started, then read again", async () => {
		const { context, reads, advance } = setup();
		await reads.get();
		advance(SHARE_READ_MS - 1);
		await reads.get();
		expect(context.calls).toBe(1);
		advance(1);
		await reads.get();
		expect(context.calls).toBe(2);
	});

	test("toolchange: the next read is a new one, also over a read still in flight", async () => {
		const { context, reads } = setup();
		await reads.get();
		context.tools.push({
			name: "b",
			description: "B.",
			annotations: { readOnlyHint: true },
		});
		context.dispatchEvent(new Event("toolchange"));
		expect((await reads.get()).map((t) => t.name)).toEqual(["a", "b"]);
		expect(context.calls).toBe(2);
		// In flight when the page's tools change: not shared after.
		context.hold = true;
		const old = reads.get();
		context.tools.pop();
		context.dispatchEvent(new Event("toolchange"));
		const now = reads.get();
		expect(context.calls).toBe(3);
		context.release();
		expect((await old).map((t) => t.name)).toEqual(["a", "b"]);
		expect((await now).map((t) => t.name)).toEqual(["a"]);
		expect((await reads.get()).map((t) => t.name)).toEqual(["a"]);
		expect(context.calls).toBe(3);
	});

	test("a call shares only a read in flight, never one that is done", async () => {
		const { context, reads, advance } = setup();
		await reads.get();
		await reads.get({ fresh: true });
		expect(context.calls).toBe(2);
		advance(SHARE_READ_MS);
		context.hold = true;
		const listing = reads.get();
		const calling = reads.get({ fresh: true });
		expect(context.calls).toBe(3);
		context.release();
		await Promise.all([listing, calling]);
		await reads.get();
		expect(context.calls).toBe(3);
	});

	test("a failed read is shared like an answer", async () => {
		const failing = {
			calls: 0,
			getTools() {
				this.calls++;
				return Promise.reject(new Error("disallowed"));
			},
		};
		const reads = new ToolReads(failing as unknown as CountingContext, () => 0);
		await expect(reads.get()).rejects.toThrow("disallowed");
		await expect(reads.get()).rejects.toThrow("disallowed");
		expect(failing.calls).toBe(1);
	});
});

describe("asking a tab's content script", () => {
	/** Chrome's tabs and scripting, as `ask` uses them, set by each test. */
	function stubChrome(stub: {
		sendMessage: () => Promise<unknown>;
		status?: string;
		inject?: () => Promise<unknown>;
	}) {
		const injected: number[] = [];
		const before = (globalThis as { chrome?: unknown }).chrome;
		(globalThis as { chrome?: unknown }).chrome = {
			tabs: {
				sendMessage: stub.sendMessage,
				get: async () => ({ status: stub.status ?? "complete" }),
			},
			scripting: {
				executeScript: async ({ target }: { target: { tabId: number } }) => {
					injected.push(target.tabId);
					return stub.inject?.();
				},
			},
		};
		return {
			injected,
			restore: () => {
				(globalThis as { chrome?: unknown }).chrome = before;
			},
		};
	}
	const tab = { id: 4, url: "https://shop.example/", title: "Shop" };

	test("a page that does not answer is given up, so it cannot hold every tab (ES 1)", async () => {
		const chrome = stubChrome({ sendMessage: () => new Promise(() => {}) });
		try {
			await expect(ask(tab, { type: "webmcp-list" }, 50)).rejects.toThrow(
				"did not answer within",
			);
		} finally {
			chrome.restore();
		}
	});

	test("only pages of http(s) sites, also where a click granted a file: page (DEC-142)", async () => {
		let sent = 0;
		const chrome = stubChrome({
			sendMessage: async () => {
				sent++;
				return { ok: true };
			},
		});
		try {
			await expect(
				ask(
					{ ...tab, url: "file:///home/me/report.html" },
					{ type: "page-info" },
				),
			).rejects.toThrow("works only on pages of http(s) sites");
			expect(sent).toBe(0);
			expect(chrome.injected).toEqual([]);
		} finally {
			chrome.restore();
		}
	});

	test("a page still loading gets the content script all the same (EQ 15)", async () => {
		let sent = 0;
		const chrome = stubChrome({
			status: "loading",
			sendMessage: async () => {
				if (sent++ === 0) throw new Error("Receiving end does not exist.");
				return { ok: true, value: null };
			},
		});
		try {
			expect(await ask(tab, { type: "page-info" })).toEqual({
				ok: true,
				value: null,
			});
			expect(chrome.injected).toEqual([4]);
		} finally {
			chrome.restore();
		}
	});

	test("putting it in fails: still loading, or not allowed, says which", async () => {
		const refused = async () => {
			throw new Error("Cannot access contents of the page.");
		};
		const missing = async () => {
			throw new Error("Receiving end does not exist.");
		};
		let chrome = stubChrome({
			status: "loading",
			sendMessage: missing,
			inject: refused,
		});
		try {
			await expect(ask(tab, { type: "page-info" })).rejects.toThrow(
				"still loading",
			);
		} finally {
			chrome.restore();
		}
		chrome = stubChrome({ sendMessage: missing, inject: refused });
		try {
			await expect(ask(tab, { type: "page-info" })).rejects.toThrow(
				"may not read this tab",
			);
		} finally {
			chrome.restore();
		}
	});

	test("a call whose page went away: before it ran (gone) or while it ran (navigated, WM 2)", () => {
		expect(
			callFailed(
				new Error(
					"Could not establish connection. Receiving end does not exist.",
				),
			),
		).toMatchObject({ ok: false, gone: true });
		expect(callFailed(new Error("No tab with id: 4."))).toMatchObject({
			gone: true,
		});
		expect(
			callFailed(
				new Error(
					"A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received",
				),
			),
		).toMatchObject({ ok: false, navigated: true });
		expect(
			callFailed(
				new Error("The message port closed before a response was received."),
			),
		).toMatchObject({ navigated: true });
		expect(
			callFailed(
				new Error(
					"The page keeping the extension port is moved into back/forward cache, so the message channel is closed.",
				),
			),
		).toMatchObject({ navigated: true });
		// Anything else: a plain failure, nothing says the tool ran.
		const other = callFailed(new Error("An unexpected error occurred"));
		expect(other).toEqual({
			ok: false,
			error: "The call did not reach the page: An unexpected error occurred",
		});
	});
});

describe("Firefox's sidebar for a question", () => {
	const action = (open: boolean[]) => {
		const calls: string[] = [];
		const fake: SidebarAction = {
			open: () => {
				calls.push("open");
				return Promise.resolve();
			},
			isOpen: ({ windowId }) => {
				calls.push(`isOpen ${windowId}`);
				return Promise.resolve(open.shift() ?? false);
			},
		};
		return { fake, calls };
	};

	test("opened at once (in the gesture), and open in the question's window", async () => {
		const { fake, calls } = action([true]);
		const opened = openSidebar(fake, 7);
		expect(calls).toEqual(["open"]);
		await opened;
		expect(calls).toEqual(["open", "isOpen 7"]);
	});

	test("opened in another window (the one in front): refused, so a notification follows", async () => {
		const { fake } = action([false]);
		await expect(openSidebar(fake, 7)).rejects.toThrow("another window");
	});

	test("no sidebarAction: refused", async () => {
		await expect(openSidebar(undefined, 7)).rejects.toThrow("no sidebarAction");
	});
});

describe("Chrome's page-world polyfill: the content script's port", () => {
	test("a hello that comes late (a page busy after its load) still counts", async () => {
		const win = {
			postMessage: (
				_message: unknown,
				_origin: string,
				ports: MessagePort[],
			) => {
				const port = ports[0] as MessagePort;
				port.onmessage = (event) => {
					const request = event.data as { type: string; id: number };
					if (request.type === "list")
						port.postMessage({ type: "tools", id: request.id, tools: [] });
				};
				setTimeout(() => port.postMessage({ type: "hello" }), 1_500);
			},
		} as unknown as Window;
		const context = await connectPolyfill(win);
		expect(await context.getTools()).toEqual([]);
	});
});

describe("the polyfill's registry: taken over by the next content script (Firefox)", () => {
	const tool = (name: string) => ({
		name,
		description: name,
		execute: () => name,
	});

	test("records and restore keep the order, signals and provideContext's tools, without a change event", () => {
		const first = new ToolRegistry(() => {});
		const controller = new AbortController();
		first.provide([tool("c"), tool("e")]);
		first.register(tool("a"));
		first.register(tool("b"), controller.signal);
		let changes = 0;
		const next = new ToolRegistry(() => changes++);
		next.restore(first.records());
		expect(changes).toBe(0);
		expect(next.list().map((t) => t.name)).toEqual(["c", "e", "a", "b"]);
		// The signal still ends its tool; provideContext still replaces its own.
		controller.abort();
		expect(next.list().map((t) => t.name)).toEqual(["c", "e", "a"]);
		next.provide([tool("d")]);
		expect(next.list().map((t) => t.name)).toEqual(["a", "d"]);
		expect(changes).toBe(2);
	});

	describe("code review 2026-11-22, CR-04: provideContext owns its registrations, not their names", () => {
		/** "save" given by provideContext, unregistered, then registered on its own. */
		const independent = () => {
			const registry = new ToolRegistry(() => {});
			registry.provide([{ ...tool("save"), description: "old context" }]);
			registry.unregister("save");
			registry.register({ ...tool("save"), description: "independent tool" });
			return registry;
		};
		const description = (registry: ToolRegistry) =>
			registry.get("save")?.info.description;

		test("the next provideContext() leaves the tool registered on its own", () => {
			const registry = independent();
			registry.provide([]);
			expect(description(registry)).toBe("independent tool");
		});

		test("a new context with a tool of that name does not replace it", () => {
			const registry = independent();
			registry.provide([{ ...tool("save"), description: "new context" }]);
			expect(description(registry)).toBe("independent tool");
			registry.provide([]);
			expect(description(registry)).toBe("independent tool");
		});

		test("records() and restore() keep it the page's own", () => {
			const registry = independent();
			registry.provide([tool("other")]);
			const records = registry.records();
			expect(records.map((r) => [r.tool.name, r.provided])).toEqual([
				["save", false],
				["other", true],
			]);
			const next = new ToolRegistry(() => {});
			next.restore(records);
			next.provide([]);
			expect(next.list().map((t) => t.name)).toEqual(["save"]);
		});
	});

	test("a record that no longer reads as a tool is left out", () => {
		const next = new ToolRegistry(() => {});
		next.restore([
			{ tool: { name: "" }, provided: false },
			{ tool: tool("ok"), provided: false },
			{ tool: { name: "" }, provided: true },
			{ tool: tool("given"), provided: true },
		]);
		expect(next.list().map((t) => t.name)).toEqual(["ok", "given"]);
		next.provide([]);
		expect(next.list().map((t) => t.name)).toEqual(["ok"]);
	});

	test("annotations are listed as Chrome lists them (DEC-214)", () => {
		const annotations = (value?: unknown) =>
			readTool({
				...tool("t"),
				...(value === undefined ? {} : { annotations: value }),
			}).info.annotations;
		const none = {
			consequentialHint: false,
			debugging: false,
			readOnlyHint: false,
			untrustedContentHint: false,
		};
		expect(annotations()).toBeUndefined();
		expect(annotations({})).toEqual(none);
		expect(annotations(null)).toEqual(none);
		expect(annotations({ readOnlyHint: false })).toEqual(none);
		expect(annotations({ consequentialHint: "yes", other: true })).toEqual({
			...none,
			consequentialHint: true,
		});
		expect(() => annotations("consequential")).toThrow(PageError);
	});
});
