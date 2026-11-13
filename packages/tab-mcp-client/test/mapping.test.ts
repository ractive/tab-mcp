import { describe, expect, test } from "bun:test";
import {
	ANNOTATIONS_META_KEY,
	isCallToolResult,
	mapAnnotations,
	markUntrusted,
	resultText,
	thrownResult,
	toCallToolResult,
} from "../src/mapping.ts";

describe("annotations (DEC-022)", () => {
	test("readOnlyHint → readOnlyHint true, destructiveHint false", () => {
		expect(mapAnnotations({ readOnlyHint: true })).toEqual({
			annotations: { readOnlyHint: true, destructiveHint: false },
			meta: { readOnlyHint: true },
		});
	});
	test("consequentialHint → destructiveHint true", () => {
		expect(mapAnnotations({ consequentialHint: true }).annotations).toEqual({
			destructiveHint: true,
		});
	});
	test("untrustedContentHint → openWorldHint true", () => {
		expect(mapAnnotations({ untrustedContentHint: true }).annotations).toEqual({
			openWorldHint: true,
		});
	});
	test("MCP-only hints set directly win", () => {
		expect(
			mapAnnotations({
				readOnlyHint: true,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false,
			}).annotations,
		).toEqual({
			readOnlyHint: true,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		});
	});
	test("WebMCP originals are kept for _meta, debugging included", () => {
		expect(
			mapAnnotations({ debugging: true, consequentialHint: false }).meta,
		).toEqual({
			debugging: true,
			consequentialHint: false,
		});
		expect(ANNOTATIONS_META_KEY).toBe("ch.ractive.tab-mcp/annotations");
	});
	test("no hints, no annotations", () => {
		expect(mapAnnotations({})).toEqual({});
	});
});

describe("results (DEC-023)", () => {
	test("a string is one text block", () => {
		expect(toCallToolResult("hi")).toEqual({
			content: [{ type: "text", text: "hi" }],
		});
	});
	test("an object with a content array passes through", () => {
		const r = {
			content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
			isError: false,
		};
		expect(toCallToolResult(r)).toBe(r);
	});
	test("only an MCP result passes through: domain data with a content array is JSON (CC 3)", () => {
		const results = [
			{ content: [] },
			{ content: [], isError: false, structuredContent: { a: 1 } },
			// Other keys next to blocks are allowed, as MCP allows them.
			{ content: [{ type: "text", text: "a" }], invalid: "rows skipped" },
			{ content: [{ type: "text", text: "a" }], isError: true },
			{
				content: [
					{ type: "resource_link", uri: "https://x.example/a", name: "a" },
					{ type: "audio", data: "AA==", mimeType: "audio/wav" },
					{
						type: "resource",
						resource: { uri: "file:///a", text: "a" },
					},
				],
				structuredContent: { a: 1 },
				_meta: { "example.com/k": 1 },
			},
		];
		for (const r of results) {
			expect(isCallToolResult(r)).toBe(true);
			expect(toCallToolResult(r)).toBe(r);
		}
		const data = [
			// ProseMirror / TipTap
			{ type: "doc", content: [{ type: "paragraph", content: [] }] },
			{ title: "Post", content: ["para 1", "para 2"] },
			{ content: [{ type: "paragraph" }] },
			{ content: [{ text: "no type" }] },
			{ content: [null] },
			{ content: [{ type: "text", text: "a" }], isError: "yes" },
			{ content: [], structuredContent: [1] },
			{ content: [], _meta: "x" },
			// An empty content with keys a result does not have (review of PR 118)
			{ title: "Groceries", content: [] },
			// Blocks without the fields their type needs: a chat message, say
			{
				role: "user",
				content: [{ type: "image", source: { type: "base64", data: "AA==" } }],
			},
			{ content: [{ type: "text", text: 5 }] },
			{ content: [{ type: "image", data: "AA==" }] },
			{ content: [{ type: "resource_link", uri: "https://x.example/a" }] },
			{ content: [{ type: "resource", resource: { text: "a" } }] },
		];
		for (const d of data) {
			expect(isCallToolResult(d)).toBe(false);
			expect(toCallToolResult(d)).toEqual({
				content: [{ type: "text", text: JSON.stringify(d) }],
				structuredContent: JSON.parse(JSON.stringify(d)),
			});
		}
		expect(isCallToolResult([{ type: "text" }])).toBe(false);
		expect(isCallToolResult(null)).toBe(false);
	});
	test("a Date or URL is its JSON text, without structuredContent (CC 3)", () => {
		const date = new Date("2026-11-13T00:00:00.000Z");
		expect(toCallToolResult(date)).toEqual({
			content: [{ type: "text", text: '"2026-11-13T00:00:00.000Z"' }],
		});
		expect(toCallToolResult(new URL("https://x.example/a"))).toEqual({
			content: [{ type: "text", text: '"https://x.example/a"' }],
		});
		// structuredContent is what the text says: toJSON applied inside too.
		expect(toCallToolResult({ at: date })).toEqual({
			content: [{ type: "text", text: '{"at":"2026-11-13T00:00:00.000Z"}' }],
			structuredContent: { at: "2026-11-13T00:00:00.000Z" },
		});
	});
	test("resultText joins the text blocks", () => {
		expect(
			resultText({
				content: [
					{ type: "text", text: "a" },
					{ type: "image", data: "AA==", mimeType: "image/png" },
					{ type: "text", text: "" },
					{ type: "text", text: "b" },
				],
			}),
		).toBe("a\nb");
	});
	test("other JSON: text with its JSON, structuredContent for objects", () => {
		expect(toCallToolResult({ x: 1 })).toEqual({
			content: [{ type: "text", text: '{"x":1}' }],
			structuredContent: { x: 1 },
		});
		expect(toCallToolResult([1, 2])).toEqual({
			content: [{ type: "text", text: "[1,2]" }],
		});
		expect(toCallToolResult(42)).toEqual({
			content: [{ type: "text", text: "42" }],
		});
		expect(toCallToolResult(null)).toEqual({
			content: [{ type: "text", text: "null" }],
		});
	});
	test("undefined is an empty result; non-JSON is an error", () => {
		expect(toCallToolResult(undefined)).toEqual({ content: [] });
		const cyclic: Record<string, unknown> = {};
		cyclic["self"] = cyclic;
		expect(toCallToolResult(cyclic).isError).toBe(true);
		expect(toCallToolResult(1n).isError).toBe(true);
	});
	test("a thrown error becomes isError with its message", () => {
		expect(thrownResult(new Error("kaput"))).toEqual({
			content: [{ type: "text", text: "kaput" }],
			isError: true,
		});
		expect(thrownResult("plain")).toEqual({
			content: [{ type: "text", text: "plain" }],
			isError: true,
		});
	});
	test("markUntrusted sets the marker, keeps the result's own _meta and changes nothing in place (DEC-166)", () => {
		const own = {
			content: [{ type: "text", text: "x" }],
			_meta: {
				"example.com/a": 1,
				[ANNOTATIONS_META_KEY]: { untrustedContentHint: false, other: true },
			},
		};
		const before = structuredClone(own);
		expect(markUntrusted(own)).toEqual({
			content: [{ type: "text", text: "x" }],
			_meta: {
				"example.com/a": 1,
				[ANNOTATIONS_META_KEY]: { untrustedContentHint: true, other: true },
			},
		});
		expect(own).toEqual(before);
		expect(markUntrusted({ content: [] })).toEqual({
			content: [],
			_meta: { [ANNOTATIONS_META_KEY]: { untrustedContentHint: true } },
		});
	});
});
