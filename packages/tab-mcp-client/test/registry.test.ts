import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../src/registry.ts";
import { TabMcp } from "../src/tab-mcp.ts";
import type { Tool } from "../src/types.ts";
import { MemoryStorage } from "./helpers.ts";

const tool = (over: Partial<Tool> = {}): Tool => ({
	name: "add",
	description: "Add two numbers",
	execute: () => 0,
	...over,
});

describe("ToolRegistry (WebMCP rules)", () => {
	test("accepts names of 1–128 characters of [A-Za-z0-9_.-]", () => {
		const r = new ToolRegistry();
		for (const name of ["a", "Z9_.-x", "x".repeat(128)])
			r.register(tool({ name }));
		expect(r.list().map((t) => t.name)).toEqual([
			"a",
			"Z9_.-x",
			"x".repeat(128),
		]);
	});

	test.each(["", "x".repeat(129), "has space", "slash/name", "ümlaut", "a:b"])(
		"rejects the name %p",
		(name) => {
			expect(() => new ToolRegistry().register(tool({ name }))).toThrow(
				TypeError,
			);
		},
	);

	test("needs a non-empty description and an execute function", () => {
		const r = new ToolRegistry();
		expect(() => r.register(tool({ description: "" }))).toThrow(/description/);
		expect(() => r.register(tool({ description: "  " }))).toThrow(
			/description/,
		);
		expect(() => r.register({ name: "x", description: "d" } as Tool)).toThrow(
			/execute/,
		);
	});

	test("inputSchema defaults to { type: object } and must be an object schema", () => {
		const r = new ToolRegistry();
		r.register(tool());
		expect(r.get("add")?.inputSchema).toEqual({ type: "object" });
		expect(() =>
			r.register(tool({ name: "s", inputSchema: { type: "string" } })),
		).toThrow(/"type": "object"/);
		expect(() =>
			r.register(
				tool({
					name: "x",
					inputSchema: {
						type: "object",
						properties: { r: { type: "string", "x-mcp-header": "R" } },
					},
				}),
			),
		).toThrow(/x-mcp-header/);
	});

	test("refuses schemas the validator would choke on: bad patterns, unresolved or remote $refs", () => {
		const r = new ToolRegistry();
		const bad = [
			{ type: "object", properties: { a: { type: "string", pattern: "(" } } },
			{ type: "object", patternProperties: { "[": { type: "string" } } },
			{ type: "object", properties: { a: { $ref: "#/$defs/missing" } } },
			{
				type: "object",
				properties: { a: { $ref: "https://example.com/s.json" } },
			},
		];
		for (const [i, inputSchema] of bad.entries()) {
			expect(() => r.register(tool({ name: `bad${i}`, inputSchema }))).toThrow(
				TypeError,
			);
		}
		r.register(
			tool({
				name: "good",
				inputSchema: {
					type: "object",
					$defs: {
						n: { type: "number" },
						"a/b": { $anchor: "ab", type: "string" },
					},
					properties: {
						a: { $ref: "#/$defs/n" },
						b: { $ref: "#/$defs/a~1b" },
						c: { $ref: "#ab" },
						d: { type: "string", pattern: "^\\p{L}+$" },
						e: { $ref: "#" },
					},
				},
			}),
		);
		expect(r.get("good")).toBeDefined();
	});

	test("keeps a copy of the schema", () => {
		const r = new ToolRegistry();
		const schema = { type: "object", properties: { a: { type: "number" } } };
		r.register(tool({ inputSchema: schema }));
		schema.properties.a.type = "string";
		expect(r.get("add")?.inputSchema).toEqual({
			type: "object",
			properties: { a: { type: "number" } },
		});
	});

	test("rejects a duplicate name with InvalidStateError", () => {
		const r = new ToolRegistry();
		r.register(tool());
		let error: unknown;
		try {
			r.register(tool());
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(DOMException);
		expect((error as DOMException).name).toBe("InvalidStateError");
	});

	test("aborting the signal unregisters and notifies; the name is free again", () => {
		const r = new ToolRegistry();
		let changes = 0;
		r.onChange(() => changes++);
		const controller = new AbortController();
		r.register(tool(), { signal: controller.signal });
		expect(changes).toBe(1);
		controller.abort();
		expect(r.get("add")).toBeUndefined();
		expect(changes).toBe(2);
		r.register(tool());
		controller.abort(); // a second abort does not remove the new tool
		expect(r.get("add")).toBeDefined();
	});

	test("an already aborted signal registers nothing", () => {
		const r = new ToolRegistry();
		r.register(tool(), { signal: AbortSignal.abort() });
		expect(r.list()).toEqual([]);
	});

	test("keeps only boolean annotations", () => {
		const r = new ToolRegistry();
		r.register(
			tool({
				annotations: { readOnlyHint: true, consequentialHint: "yes" } as never,
			}),
		);
		expect(r.get("add")?.annotations).toEqual({ readOnlyHint: true });
	});
});

describe("TabMcp.registerTool", () => {
	const mcp = () =>
		new TabMcp({
			relay: "https://relay.example",
			server: { name: "t", version: "1" },
			storage: new MemoryStorage(),
		});

	test("resolves for a valid tool and rejects an invalid one", async () => {
		const m = mcp();
		await m.registerTool(tool());
		expect(m.tools).toEqual(["add"]);
		await expect(m.registerTool(tool({ name: "" }))).rejects.toBeInstanceOf(
			TypeError,
		);
		await expect(m.registerTool(tool())).rejects.toHaveProperty(
			"name",
			"InvalidStateError",
		);
	});

	test("emits toolschange", async () => {
		const m = mcp();
		const seen: string[][] = [];
		m.addEventListener("toolschange", (e) => seen.push([...e.detail.tools]));
		const c = new AbortController();
		await m.registerTool(tool(), { signal: c.signal });
		c.abort();
		expect(seen).toEqual([["add"], []]);
	});
});

describe("TabMcp options", () => {
	test("relay URLs: https/wss, a /tab path, http only for loopback", () => {
		const ok = (relay: string) =>
			new TabMcp({ relay, server: { name: "t", version: "1" }, storage: null });
		expect(() => ok("https://relay.example")).not.toThrow();
		expect(() => ok("wss://relay.example/tab")).not.toThrow();
		expect(() => ok("http://localhost:8080")).not.toThrow();
		expect(() => ok("http://127.0.0.1:8080")).not.toThrow();
		expect(() => ok("http://relay.example")).toThrow(/https/);
		expect(() => ok("ftp://relay.example")).toThrow(TypeError);
		expect(() => ok("not a url")).toThrow(TypeError);
	});

	test("appName is at most 64 characters; server needs name and version", () => {
		const make = (o: object) => () =>
			new TabMcp({
				relay: "https://r.example",
				server: { name: "t", version: "1" },
				storage: null,
				...o,
			});
		expect(make({ appName: "x".repeat(64) })).not.toThrow();
		expect(make({ appName: "x".repeat(65) })).toThrow(/appName/);
		expect(make({ server: { name: "t" } })).toThrow(/server/);
	});
});
