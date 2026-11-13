/**
 * The parts that need no browser: the manifest of each build, the key's id,
 * reading a page, the tool and the refusals.
 */

import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createManifest, extensionId, mitText } from "../scripts/build.ts";
import {
	callTool,
	MAX_LANGUAGE,
	MAX_PAGE_TITLE,
	MAX_SEND_RESULT,
	pageInfo,
	pageTools,
} from "../src/content.ts";
import { relayProblem } from "../src/relay.ts";
import { ask, callFailed, noAccess } from "../src/tabs.ts";
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
		expect(noAccess("").message).toContain("Read all sites without a click");
	});

	test("browser pages and the Web Store cannot be read at all", () => {
		expect(noAccess("chrome://settings/").message).toContain("browser page");
		expect(noAccess("chrome://settings/").reason).toBe("browser-page");
		const store = noAccess("https://chromewebstore.google.com/detail/x");
		expect(store.message).toContain("Chrome Web Store");
		expect(store.reason).toBe("web-store");
		expect(noAccess("file:///tmp/a.html").reason).toBe("not-site");
	});

	test("a web page needs a click or host access", () => {
		expect(noAccess("https://example.com/").message).toContain(
			"click the tab-mcp for Chrome icon in Chrome's toolbar",
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
			error: `It returned ${MAX_SEND_RESULT + 1} characters; tab-mcp for Chrome passes on at most ${MAX_SEND_RESULT}.`,
		});
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
