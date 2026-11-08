/**
 * The parts that need no browser: the manifest of each build, the key's id,
 * reading a page, the tool and the refusals.
 */

import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createManifest, extensionId, mitText } from "../scripts/build.ts";
import { pageInfo } from "../src/content.ts";
import { relayProblem } from "../src/sidepanel/relay.ts";
import { createTools } from "../src/sidepanel/tools.ts";
import { noAccess } from "../src/tabs.ts";

describe("manifest", () => {
	test("the development build has the key and no host access", () => {
		const manifest = createManifest("1.2.3", { key: "KEY" });
		expect(manifest["key"]).toBe("KEY");
		expect(manifest["host_permissions"]).toBeUndefined();
		expect(manifest["optional_host_permissions"]).toEqual(["<all_urls>"]);
		expect(manifest["permissions"]).toEqual([
			"activeTab",
			"scripting",
			"sidePanel",
			"storage",
		]);
	});

	test("the test build has host access and no key; the store build neither", () => {
		expect(createManifest("1.0.0", { test: true })).toMatchObject({
			host_permissions: ["<all_urls>"],
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
		title: "Example",
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
				state: { available: false, tools: [], mirrored: [] },
				refresh: async () => {},
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
	});

	test("browser pages and the Web Store cannot be read at all", () => {
		expect(noAccess("chrome://settings/").message).toContain("browser page");
		expect(
			noAccess("https://chromewebstore.google.com/detail/x").message,
		).toContain("Chrome Web Store");
	});

	test("a web page needs a click or host access", () => {
		expect(noAccess("https://example.com/").message).toContain(
			"click its icon",
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
