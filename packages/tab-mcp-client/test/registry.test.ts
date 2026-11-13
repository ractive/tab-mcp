import { describe, expect, test } from "bun:test";
import { compileRegistry } from "../src/mcp.ts";
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

	test("data in default, examples, const and enum is not read as schema; nor are property names (CC 13)", () => {
		const r = new ToolRegistry();
		r.register(
			tool({
				name: "search",
				inputSchema: {
					type: "object",
					properties: {
						filter: {
							type: "object",
							properties: { pattern: { type: "string" } },
							default: { pattern: "*" },
							examples: [{ pattern: "*.ts", $ref: "#/nowhere" }],
						},
						mode: { enum: [{ $anchor: "x", "x-mcp-header": "M" }] },
						fixed: { const: { pattern: "(" } },
						"x-mcp-header": { type: "string" },
					},
				},
			}),
		);
		expect(r.get("search")).toBeDefined();
		// The keywords themselves are still checked next to such data.
		expect(() =>
			r.register(
				tool({
					name: "bad",
					inputSchema: {
						type: "object",
						properties: {
							a: { type: "string", pattern: "(", default: "x" },
						},
					},
				}),
			),
		).toThrow(/pattern "\(" is not a valid regular expression/);
		expect(() =>
			r.register(
				tool({
					name: "deep",
					inputSchema: {
						type: "object",
						$defs: { s: { type: "string", "x-mcp-header": "S" } },
					},
				}),
			),
		).toThrow(/x-mcp-header/);
	});

	test("a $ref with a malformed escape is a TypeError, not a URIError (CC 13)", () => {
		const r = new ToolRegistry();
		expect(() =>
			r.register(
				tool({
					name: "uri",
					inputSchema: {
						type: "object",
						properties: { a: { $ref: "#/$defs/%E0%A4%A" } },
					},
				}),
			),
		).toThrow(
			new TypeError(
				'registerTool: the inputSchema of uri: $ref "#/$defs/%E0%A4%A" does not resolve',
			),
		);
	});

	test("once the validator is loaded, it checks the schemas too, also of tools registered before (iteration 13)", () => {
		const r = new ToolRegistry();
		// The core's own check passes these; the nested $id moves the $ref's base.
		const nested = {
			type: "object",
			properties: { a: { $id: "https://y.example/t", $ref: "#/$defs/s" } },
			$defs: { s: { type: "string" } },
		};
		const duplicate = {
			type: "object",
			$defs: {
				a: { $id: "https://z.example/a" },
				b: { $id: "https://z.example/a" },
			},
		};
		r.register(tool({ name: "early_bad", inputSchema: nested }));
		r.register(tool({ name: "early_good" }));
		let changes = 0;
		r.onChange(() => changes++);
		const refused = compileRegistry(r);
		expect(refused.map((e) => [e.name, e.message])).toEqual([
			[
				"TypeError",
				'registerTool: the inputSchema of early_bad: $ref "#/$defs/s" does not resolve; the tool was unregistered',
			],
		]);
		expect(r.list().map((t) => t.name)).toEqual(["early_good"]);
		expect(changes).toBe(1);
		expect(() =>
			r.register(tool({ name: "late_bad", inputSchema: nested })),
		).toThrow(
			new TypeError(
				'registerTool: the inputSchema of late_bad: $ref "#/$defs/s" does not resolve',
			),
		);
		expect(() =>
			r.register(tool({ name: "late_dup", inputSchema: duplicate })),
		).toThrow(
			new TypeError(
				'registerTool: the inputSchema of late_dup: Duplicate schema URI "https://z.example/a".',
			),
		);
		r.register(tool({ name: "late_good" }));
		expect(r.list().map((t) => t.name)).toEqual(["early_good", "late_good"]);
		expect(compileRegistry(r)).toEqual([]);
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

	test("an already aborted signal throws its reason and registers nothing, as WebMCP (WM 11)", () => {
		const r = new ToolRegistry();
		const reason = new Error("gone");
		expect(() =>
			r.register(tool(), { signal: AbortSignal.abort(reason) }),
		).toThrow(reason);
		expect(() => r.register(tool(), { signal: AbortSignal.abort() })).toThrow(
			expect.objectContaining({ name: "AbortError" }),
		);
		expect(r.list()).toEqual([]);
	});

	test("outputSchema: an object schema, copied as JSON; anything else is refused (WM 3)", () => {
		const r = new ToolRegistry();
		const outputSchema = {
			type: "object",
			properties: { sum: { type: "number" } },
		};
		r.register({ ...tool(), outputSchema });
		const registered = r.get("add");
		expect(registered?.outputSchema).toEqual(outputSchema);
		expect(registered?.outputSchema).not.toBe(outputSchema);
		for (const bad of [{ type: "string" }, [], "x"])
			expect(() =>
				r.register({
					...tool(),
					name: "bad",
					outputSchema: bad as unknown as Record<string, unknown>,
				}),
			).toThrow(
				'registerTool: the outputSchema of bad must be a JSON Schema object with "type": "object"',
			);
		const cyclic: Record<string, unknown> = { type: "object" };
		cyclic["self"] = cyclic;
		expect(() =>
			r.register({ ...tool(), name: "cyclic", outputSchema: cyclic }),
		).toThrow("registerTool: the outputSchema of cyclic must be JSON");
	});

	test("exposedTo is kept for the native registration", () => {
		const r = new ToolRegistry();
		r.register(tool(), { exposedTo: ["https://a.example"] });
		expect(r.get("add")?.exposedTo).toEqual(["https://a.example"]);
	});

	test("a hint that is not a boolean is refused, so a consequential tool cannot run without asking (CC 2)", () => {
		const r = new ToolRegistry();
		for (const [key, value] of [
			["consequentialHint", "true"],
			["consequentialHint", 1],
			["consequentialHint", null],
			["readOnlyHint", "yes"],
			["destructiveHint", 0],
			["debugging", "on"],
		] as const) {
			expect(() =>
				r.register(tool({ annotations: { [key]: value } as never })),
			).toThrow(new TypeError(`registerTool: ${key} of add must be a boolean`));
		}
		expect(r.list()).toEqual([]);
		// Undefined is no hint; other keys that are not booleans are ignored.
		r.register(
			tool({
				annotations: {
					readOnlyHint: true,
					consequentialHint: undefined,
					title: "Add",
					custom: true,
				} as never,
			}),
		);
		expect(r.get("add")?.annotations).toEqual({
			readOnlyHint: true,
			custom: true,
		} as never);
	});

	test("webmcp must be a boolean (CC 2)", () => {
		const r = new ToolRegistry();
		expect(() => r.register(tool(), { webmcp: "true" as never })).toThrow(
			new TypeError("registerTool: webmcp must be a boolean"),
		);
		r.register(tool(), { webmcp: false });
		expect(r.get("add")?.webmcp).toBe(false);
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

	test("appName is 1-64 characters without control characters; server needs name and version", () => {
		const make = (o: object) => () =>
			new TabMcp({
				relay: "https://r.example",
				server: { name: "t", version: "1" },
				storage: null,
				...o,
			});
		expect(make({ appName: "x".repeat(64) })).not.toThrow();
		expect(make({ appName: "x".repeat(65) })).toThrow(/appName/);
		// What the relay would refuse in hello is refused here already.
		expect(make({ appName: "" })).toThrow(/appName/);
		expect(make({ appName: "  " })).toThrow(/appName/);
		expect(make({ appName: "a\nb" })).toThrow(/appName/);
		expect(make({ server: { name: "t" } })).toThrow(/server/);
	});
});
