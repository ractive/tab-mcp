import { describe, expect, test } from "bun:test";
import { isAppId } from "../../tab-mcp/src/config.ts";
import { compileRegistry } from "../src/mcp.ts";
import { ToolRegistry } from "../src/registry.ts";
import { toolsFor } from "../src/serve.ts";
import { appIdOf, TabMcp } from "../src/tab-mcp.ts";
import type { ModelContextTool, ToolCaller } from "../src/types.ts";
import { MemoryStorage } from "./helpers.ts";

const tool = (over: Partial<ModelContextTool> = {}): ModelContextTool => ({
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
			// The draft's error (DEC-227).
			expect(() => new ToolRegistry().register(tool({ name }))).toThrow(
				expect.objectContaining({ name: "InvalidStateError" }),
			);
		},
	);

	test("an empty description is an InvalidStateError; no name, description or execute a TypeError (DEC-227)", () => {
		const r = new ToolRegistry();
		expect(() => r.register(tool({ description: "" }))).toThrow(
			new DOMException(
				"registerTool: add needs a description",
				"InvalidStateError",
			),
		);
		for (const missing of [
			{ description: "d", execute: () => 0 },
			{ name: "x", execute: () => 0 },
		])
			expect(() => r.register(missing as ModelContextTool)).toThrow(
				new TypeError("registerTool: a tool needs a name and a description"),
			);
		expect(() =>
			r.register({ name: "x", description: "d" } as ModelContextTool),
		).toThrow(new TypeError("registerTool: x needs an execute function"));
		expect(r.list()).toEqual([]);
	});

	test("name, title and description are converted to strings, as WebIDL does (DEC-227)", () => {
		const r = new ToolRegistry();
		r.register(
			tool({
				name: 42,
				title: 7,
				description: " ",
			} as never as ModelContextTool),
		);
		expect(r.get("42")).toMatchObject({
			name: "42",
			title: "7",
			description: " ",
		});
		expect(() =>
			r.register(tool({ name: Symbol("s") } as never as ModelContextTool)),
		).toThrow(TypeError);
		// Once each: a second conversion could give another value.
		let calls = 0;
		const description = { toString: () => (calls++ === 0 ? "Adds" : "") };
		r.register(tool({ name: "once", description } as never));
		expect(calls).toBe(1);
		expect(r.get("once")?.description).toBe("Adds");
	});

	test("the checks come in the draft's order (DEC-227)", () => {
		const r = new ToolRegistry();
		r.register(tool());
		const aborted = AbortSignal.abort(new Error("gone"));
		const taken = new DOMException(
			"registerTool: a tool named add is already registered",
			"InvalidStateError",
		);
		// A duplicate before the description, the schema and the signal.
		expect(() =>
			r.register(tool({ description: "", inputSchema: { type: "string" } }), {
				signal: aborted,
			}),
		).toThrow(taken);
		// The description before the schema.
		expect(() =>
			r.register(
				tool({ name: "b", description: "", inputSchema: { type: "string" } }),
			),
		).toThrow(
			new DOMException(
				"registerTool: b needs a description",
				"InvalidStateError",
			),
		);
		// The schema before the signal, the signal before exposedTo.
		expect(() =>
			r.register(tool({ name: "b", inputSchema: { type: "string" } }), {
				signal: aborted,
			}),
		).toThrow(/"type": "object"/);
		expect(() =>
			r.register(tool({ name: "b" }), {
				signal: aborted,
				exposedTo: ["http://a.example"],
			}),
		).toThrow("gone");
		// The validator's check, once loaded, with the schemas: before the signal.
		r.setCompiler((t) => {
			if (t.name === "late") throw new TypeError("the validator refused it");
		});
		expect(() =>
			r.register(tool({ name: "late" }), { signal: aborted }),
		).toThrow("the validator refused it");
		// WebIDL's conversion before everything: a bad hint, a schema that is no
		// object, a signal that is none, the old option, all on a taken name.
		for (const [over, options] of [
			[{ annotations: { readOnlyHint: "yes" } }, {}],
			[{ inputSchema: "" }, {}],
			[{ outputSchema: null }, {}],
			[{}, { signal: {} }],
			[{}, { signal: null }],
			[{}, { webmcp: false }],
		] as const)
			expect(() => r.register(tool(over as never), options as never)).toThrow(
				TypeError,
			);
		expect(r.list().map((t) => t.name)).toEqual(["add"]);
	});

	test("null options are no options, as WebIDL takes them", () => {
		const r = new ToolRegistry();
		r.register(tool(), null);
		expect(r.get("add")?.callers).toBeUndefined();
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

	test("the output schema gets the validator's check too, before and after it is loaded (the review of 2026-11-22)", () => {
		const r = new ToolRegistry();
		// The review's schema: the core's check passes it, an AI app's validator does not.
		const nested = {
			type: "object",
			$defs: { s: { type: "string" } },
			properties: { a: { $id: "https://y.example/t", $ref: "#/$defs/s" } },
		};
		const duplicate = {
			type: "object",
			$defs: {
				a: { $id: "https://z.example/a" },
				b: { $id: "https://z.example/a" },
			},
		};
		r.register(tool({ name: "early_out", outputSchema: nested }));
		r.register(tool({ name: "early_in", inputSchema: nested }));
		r.register(tool({ name: "early_good", outputSchema: { type: "object" } }));
		expect(compileRegistry(r).map((e) => e.message)).toEqual([
			'registerTool: the outputSchema of early_out: $ref "#/$defs/s" does not resolve; the tool was unregistered',
			'registerTool: the inputSchema of early_in: $ref "#/$defs/s" does not resolve; the tool was unregistered',
		]);
		expect(r.list().map((t) => t.name)).toEqual(["early_good"]);
		expect(() =>
			r.register(tool({ name: "late_out", outputSchema: nested })),
		).toThrow(
			new TypeError(
				'registerTool: the outputSchema of late_out: $ref "#/$defs/s" does not resolve',
			),
		);
		expect(() =>
			r.register(tool({ name: "late_dup", outputSchema: duplicate })),
		).toThrow(
			new TypeError(
				'registerTool: the outputSchema of late_dup: Duplicate schema URI "https://z.example/a".',
			),
		);
		// The same schema as input and as output: the input's problem is named.
		expect(() =>
			r.register(
				tool({ name: "late_both", inputSchema: nested, outputSchema: nested }),
			),
		).toThrow(
			new TypeError(
				'registerTool: the inputSchema of late_both: $ref "#/$defs/s" does not resolve',
			),
		);
		r.register(
			tool({
				name: "late_good",
				outputSchema: {
					type: "object",
					$defs: { s: { type: "string" } },
					properties: { a: { $ref: "#/$defs/s" } },
				},
			}),
		);
		expect(r.list().map((t) => t.name)).toEqual(["early_good", "late_good"]);
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
				// "x" is no object: WebIDL's conversion refuses it first.
				/^registerTool: the outputSchema of bad must be (a JSON Schema object with "type": "object"|an object)$/,
			);
		// Checked like inputSchema: an AI app compiles it when it lists the tools.
		expect(() =>
			r.register({
				...tool(),
				name: "dangling",
				outputSchema: { type: "object", $ref: "#/$defs/Item" },
			}),
		).toThrow(
			'registerTool: the outputSchema of dangling: $ref "#/$defs/Item" does not resolve',
		);
		expect(() =>
			r.register({
				...tool(),
				name: "badPattern",
				outputSchema: {
					type: "object",
					properties: { a: { type: "string", pattern: "(" } },
				},
			}),
		).toThrow(
			'registerTool: the outputSchema of badPattern: pattern "(" is not',
		);
		const cyclic: Record<string, unknown> = { type: "object" };
		cyclic["self"] = cyclic;
		expect(() =>
			r.register({ ...tool(), name: "cyclic", outputSchema: cyclic }),
		).toThrow("registerTool: the outputSchema of cyclic must be JSON");
	});

	test("exposedTo is kept as origins for the native registration", () => {
		const r = new ToolRegistry();
		const exposedTo = [
			"https://a.example/path?q",
			"wss://b.example",
			"http://localhost:8080",
			"http://app.localhost",
			"http://127.1",
			"http://[::1]:3000",
			"http://localhost.:3000",
			"blob:https://c.example/7d2e",
		];
		r.register(tool(), { exposedTo });
		exposedTo.push("https://later.example");
		expect(r.get("add")?.exposedTo).toEqual([
			"https://a.example",
			"wss://b.example",
			"http://localhost:8080",
			"http://app.localhost",
			"http://127.0.0.1",
			"http://[::1]:3000",
			"http://localhost.:3000",
			"https://c.example",
		]);
	});

	test.each([
		"http://a.example",
		"not a url",
		"data:text/plain,x",
		"file:///etc/passwd",
		"ftp://a.example",
		"blob:http://a.example/7d2e",
		"http://localhost.example",
	])(
		"an exposedTo entry %p that is no potentially trustworthy origin is a SecurityError (DEC-227)",
		(entry) => {
			const r = new ToolRegistry();
			expect(() => r.register(tool(), { exposedTo: [entry] })).toThrow(
				new DOMException(
					`registerTool: exposedTo ${JSON.stringify(entry)} is not a potentially trustworthy origin`,
					"SecurityError",
				),
			);
			expect(r.list()).toEqual([]);
		},
	);

	test("an exposedTo that is no list is a TypeError", () => {
		const r = new ToolRegistry();
		for (const exposedTo of ["https://a.example", 5, {}])
			expect(() =>
				r.register(tool(), { exposedTo: exposedTo as never }),
			).toThrow(TypeError);
		expect(r.list()).toEqual([]);
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

	test("callers must list relay, local or webmcp; the list is copied (DEC-165)", () => {
		const r = new ToolRegistry();
		for (const callers of [["relay", "agents"], [true]]) {
			expect(() => r.register(tool(), { callers: callers as never })).toThrow(
				new TypeError(
					'registerTool: callers must be "relay", "local" or "webmcp"; option webmcp is gone',
				),
			);
		}
		// The option `callers` replaced is refused, not ignored (review of PR 129):
		// an ignored `webmcp: false` would put the tool into WebMCP.
		for (const webmcp of [false, true, undefined]) {
			expect(() => r.register(tool(), { webmcp } as never)).toThrow(
				/option webmcp is gone/,
			);
		}
		// Not a list at all.
		for (const callers of ["relay", null])
			expect(() => r.register(tool(), { callers: callers as never })).toThrow(
				new TypeError("registerTool: callers must be a list"),
			);
		// The same message for exposedTo (Sitegloss's probe of 0.25.0-rc.1).
		expect(() => r.register(tool(), { exposedTo: null as never })).toThrow(
			new TypeError("registerTool: exposedTo must be a list"),
		);
		expect(() => r.register(tool(), { callers: {} as never })).toThrow(
			TypeError,
		);
		expect(r.list()).toEqual([]);
		const callers: ToolCaller[] = ["local"];
		r.register(tool(), { callers });
		callers.push("relay");
		expect(r.get("add")?.callers).toEqual(["local"]);
		r.register(tool({ name: "none" }), { callers: [] });
		expect(r.get("none")?.callers).toEqual([]);
	});

	test("toolsFor: the relay and a port see every tool by default, else those whose callers list them", () => {
		const r = new ToolRegistry();
		r.register(tool({ name: "plain" }));
		r.register(
			tool({ name: "wipe", annotations: { consequentialHint: true } }),
		);
		r.register(tool({ name: "webOnly" }), { callers: ["webmcp"] });
		r.register(tool({ name: "localOnly" }), { callers: ["local"] });
		r.register(tool({ name: "nobody" }), { callers: [] });
		const relay = toolsFor(r, "relay");
		const local = toolsFor(r, "local");
		expect(relay.list().map((t) => t.name)).toEqual(["plain", "wipe"]);
		expect(local.list().map((t) => t.name)).toEqual([
			"plain",
			"wipe",
			"localOnly",
		]);
		expect(relay.get("localOnly")).toBeUndefined();
		expect(local.get("localOnly")?.name).toBe("localOnly");
		expect(local.get("webOnly")).toBeUndefined();
		expect(local.get("missing")).toBeUndefined();
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
		await expect(m.registerTool(tool({ name: "" }))).rejects.toHaveProperty(
			"name",
			"InvalidStateError",
		);
		await expect(
			m.registerTool({ name: "x" } as ModelContextTool),
		).rejects.toBeInstanceOf(TypeError);
		await expect(m.registerTool(tool())).rejects.toHaveProperty(
			"name",
			"InvalidStateError",
		);
	});

	test("emits toolchange", async () => {
		const m = mcp();
		const seen: string[][] = [];
		m.addEventListener("toolchange", (e) => seen.push([...e.detail.tools]));
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

	test("app is an app id as the relay takes it: 1-32 of a-z, 0-9 and -, none at either end; with or without a relay", () => {
		for (const relay of [{ relay: "https://r.example" }, {}]) {
			const make = (app: unknown) => () =>
				new TabMcp({
					...relay,
					server: { name: "t", version: "1" },
					storage: null,
					app: app as string,
				});
			for (const app of ["a", "0", "a-b", "a--b", "calc-2", "x".repeat(32)]) {
				expect(isAppId(app)).toBe(true);
				expect(make(app)).not.toThrow();
			}
			for (const app of [
				"",
				"A",
				"Calc",
				"-a",
				"a-",
				"-",
				"a b",
				"a_b",
				"a.b",
				"a/b",
				"ü",
				" a",
				"a\n",
				"x".repeat(33),
			]) {
				expect(isAppId(app)).toBe(false);
				expect(make(app)).toThrow(TypeError);
				expect(make(app)).toThrow(/^TabMcp: app must be 1-32 characters/);
			}
		}
	});

	// A regular expression alone would take these: it tests them as strings,
	// and hello would carry a number or an array as `app.id`.
	test("app that is not a string is refused, even if it reads like an app id", () => {
		const make = (app: unknown) => () =>
			new TabMcp({
				relay: "https://r.example",
				server: { name: "t", version: "1" },
				storage: null,
				app: app as string,
			});
		for (const app of [123, ["calc"], { toString: () => "calc" }, true])
			expect(make(app)).toThrow(/^TabMcp: app must be/);
	});

	test("a server.name that gives no app id needs app when there is a relay, and only then", () => {
		const make = (o: object) => () =>
			new TabMcp({
				server: { name: "日本語", version: "1" },
				storage: null,
				...o,
			});
		for (const name of ["日本語", "", "   ", "---", "🙂"]) {
			const server = { name, version: "1" };
			expect(make({ relay: "https://r.example", server })).toThrow(TypeError);
			expect(make({ relay: "https://r.example", server })).toThrow(
				/^TabMcp: server\.name has no letter a-z and no digit .*: set app$/,
			);
			// `app` says it instead.
			expect(
				make({ relay: "https://r.example", server, app: "nihongo" }),
			).not.toThrow();
			// Without a relay there is no address: `serve()` and WebMCP need none.
			expect(make({ server })).not.toThrow();
			expect(make({ server })().hasRelay).toBe(false);
		}
	});
});

describe("appIdOf: the app id a server name gives (DEC-196)", () => {
	// The id is part of the address every AI app keeps: a name must give the
	// same id in every release.
	test.each([
		// Case.
		["saturnus", "saturnus"],
		["Saturnus", "saturnus"],
		["HP-48GX", "hp-48gx"],
		["42", "42"],
		// Letters without their marks, composed or not.
		["Über Café", "uber-cafe"],
		["Ångström", "angstrom"],
		["Cafe\u0301", "cafe"],
		["İstanbul", "istanbul"],
		["Crème brûlée", "creme-brulee"],
		// A letter that is no a-z without a mark is like any other character.
		["Straße", "stra-e"],
		["Søren", "s-ren"],
		// Each run of anything else is one "-".
		["test page", "test-page"],
		["a  --__  b", "a-b"],
		["calc: v2.1", "calc-v2-1"],
		["a:b#c", "a-b-c"],
		["my_app/tools", "my-app-tools"],
		["日本語 calc", "calc"],
		// None at either end.
		["--calc--", "calc"],
		["  (calc)  ", "calc"],
		["!a", "a"],
		["a!", "a"],
		["\u0301calc", "calc"],
	])("%p gives %p", (name, id) => {
		expect(appIdOf(name)).toBe(id);
		expect(isAppId(id)).toBe(true);
	});

	test("at most 32 characters, and the cut does not end in -", () => {
		expect(appIdOf("a".repeat(32))).toBe("a".repeat(32));
		expect(appIdOf("a".repeat(40))).toBe("a".repeat(32));
		// The 32nd character would be the "-" of a run: 31 are left.
		expect(appIdOf(`${"a".repeat(31)} b`)).toBe("a".repeat(31));
		expect(appIdOf(`${"a".repeat(31)}  --  b`)).toBe("a".repeat(31));
		// The run right after the cut does not matter.
		expect(appIdOf(`${"a".repeat(32)} b`)).toBe("a".repeat(32));
		expect(appIdOf(`${"a".repeat(30)} bc`)).toBe(`${"a".repeat(30)}-b`);
		// The 32 are counted after the marks went and the ends were cut.
		expect(appIdOf(`  ${"é".repeat(32)}`)).toBe("e".repeat(32));
	});

	test("nothing left: the empty string", () => {
		for (const name of ["", " ", "---", "_", "日本語", "🙂", "\u0301", "ß"])
			expect(appIdOf(name)).toBe("");
	});

	test("whatever the name, the result is empty or an app id the relay takes, and gives itself", () => {
		const parts = [
			"a",
			"Z",
			"9",
			"-",
			" ",
			"_",
			".",
			"é",
			"\u0301",
			"ß",
			"語",
			"🙂",
			"İ",
			"\u0000",
		];
		let seed = 45;
		const next = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed;
		};
		for (let i = 0; i < 2000; i++) {
			let name = "";
			for (let n = next() % 45; n > 0; n--)
				name += parts[next() % parts.length] as string;
			const id = appIdOf(name);
			if (id !== "") expect([name, isAppId(id)]).toEqual([name, true]);
			expect(appIdOf(id)).toBe(id);
		}
	});
});
