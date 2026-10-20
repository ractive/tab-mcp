/**
 * The library in Bun against an in-process relay from iteration 1, called by
 * the MCP SDK client (tokens issued through the store; the OAuth flow is in oauth-e2e.test.ts).
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import type { TabMcp } from "../src/index.ts";
import type {
	DisconnectDetail,
	ToolCallEnd,
	ToolCallStart,
} from "../src/types.ts";
import {
	connectClient,
	MemoryStorage,
	mcpPost,
	newTab,
	nextEvent,
	readEvents,
	rpc,
	startRelay,
	type TestRelay,
	tokenFor,
} from "./helpers.ts";

let r: TestRelay;
const tabs: TabMcp[] = [];

beforeAll(() => {
	r = startRelay({ keepAliveMs: 50 });
});
afterAll(() => r.stop());
afterEach(() => {
	for (const tab of tabs.splice(0)) tab.disconnect();
});

function tab(options: Parameters<typeof newTab>[1] = {}): TabMcp {
	const t = newTab(r.url, options);
	tabs.push(t);
	t.registerTool({
		name: "add",
		title: "Add",
		description: "Add two numbers",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
		annotations: { readOnlyHint: true },
		execute: ({ a, b }) => Number(a) + Number(b),
	});
	return t;
}

describe("connect", () => {
	test("resolves with the session; state and events follow", async () => {
		const t = tab();
		const states: string[] = [];
		t.addEventListener("statechange", (e) => states.push(e.detail.state));
		const connected = nextEvent(t, "connected");
		const pending = t.connect();
		expect(t.connect()).toBe(pending); // one connection at a time
		const session = await pending;
		expect(session.address).toMatch(
			/^http:\/\/localhost:\d+\/a\/[a-z2-7]{52}\/mcp$/,
		);
		expect((await connected).detail).toEqual(session);
		expect(t.state).toBe("connected");
		expect(t.address).toBe(session.address);
		expect(states).toEqual(["connecting", "connected"]);
		expect(await t.connect()).toBe(session);
	});

	test("the address is stable for the same storage", async () => {
		const storage = new MemoryStorage();
		const a = tab({ storage });
		const first = (await a.connect()).address;
		a.disconnect();
		const b = tab({ storage });
		expect((await b.connect()).address).toBe(first);
	});

	test("a relay that is not there rejects and leaves the state disconnected", async () => {
		const t = newTab("http://127.0.0.1:9");
		await expect(t.connect()).rejects.toThrow(/Could not connect/);
		expect(t.state).toBe("disconnected");
	});
});

describe("tools through the relay", () => {
	test("the SDK client lists and calls tools, also ones registered after connect", async () => {
		const t = tab();
		const { address } = await t.connect();
		await t.registerTool({
			name: "echo",
			description: "Echo",
			execute: (input) => ({ echoed: input }),
		});
		const client = await connectClient(
			address,
			await tokenFor(r.store, address),
		);
		const { tools } = await client.listTools();
		expect(tools.map((x) => x.name)).toEqual(["add", "echo"]);
		expect(tools[0]?.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
		});
		expect(
			(await client.callTool({ name: "add", arguments: { a: 40, b: 2 } }))
				.content,
		).toEqual([{ type: "text", text: "42" }]);
		const echoed = await client.callTool({ name: "echo", arguments: { x: 1 } });
		expect(echoed.structuredContent).toEqual({ echoed: { x: 1 } });
		const bad = await client.callTool({
			name: "add",
			arguments: { a: "x", b: 1 },
		});
		expect(bad.isError).toBe(true);
		await client.close();
	});

	test("aborting a tool's signal reaches a listen stream as tools/list_changed", async () => {
		const t = tab();
		const { address } = await t.connect();
		const token = await tokenFor(r.store, address);
		const controller = new AbortController();
		await t.registerTool(
			{ name: "temp", description: "Temporary", execute: () => "" },
			{ signal: controller.signal },
		);
		const listen = await mcpPost(
			address,
			rpc(1, "subscriptions/listen", {
				notifications: { toolsListChanged: true },
			}),
			{ token },
		);
		expect(listen.status).toBe(200);
		let acknowledged!: () => void;
		const ack = new Promise<void>((resolve) => (acknowledged = resolve));
		const events = readEvents(listen, (e) => {
			if (e["method"] === "notifications/subscriptions/acknowledged")
				acknowledged();
			return e["method"] === "notifications/tools/list_changed";
		});
		await ack;
		controller.abort();
		expect((await events).map((e) => e["method"])).toEqual([
			"notifications/subscriptions/acknowledged",
			"notifications/tools/list_changed",
		]);
		const client = await connectClient(address, token);
		expect((await client.listTools()).tools.map((x) => x.name)).toEqual([
			"add",
		]);
		await client.close();
	});

	test("a consequential tool runs only after onConfirm resolves true", async () => {
		const questions: { allow: (allowed: boolean) => void; host: string }[] = [];
		let asked: () => void = () => {};
		const t = tab({
			onConfirm: (request) =>
				new Promise((resolve) => {
					questions.push({ allow: resolve, host: request.client.host });
					asked();
				}),
		});
		const events: string[] = [];
		t.addEventListener("toolcall", (e) => {
			const {
				id,
				tool,
				arguments: args,
				client,
			} = (e as CustomEvent<ToolCallStart>).detail;
			events.push(`start ${id} ${tool} ${JSON.stringify(args)} ${client.host}`);
		});
		t.addEventListener("toolcallend", (e) => {
			const { id, outcome, result, durationMs } = (
				e as CustomEvent<ToolCallEnd>
			).detail;
			expect(durationMs).toBeGreaterThanOrEqual(0);
			events.push(`end ${id} ${outcome} ${JSON.stringify(result.content)}`);
			// A listener that changes the result changes only its copy.
			result.content.length = 0;
		});
		const nextQuestion = () =>
			new Promise<(typeof questions)[number]>((resolve) => {
				asked = () => resolve(questions.shift() as (typeof questions)[number]);
			});
		let runs = 0;
		await t.registerTool({
			name: "clear_memory",
			description: "Clears the memory",
			annotations: { consequentialHint: true },
			execute: () => {
				runs++;
				return "cleared";
			},
		});
		const { address } = await t.connect();
		const client = await connectClient(
			address,
			await tokenFor(r.store, address),
		);

		let question = nextQuestion();
		const call = client.callTool({ name: "clear_memory", arguments: {} });
		const first = await question;
		expect(first.host).toBe("client.example");
		expect(runs).toBe(0);
		first.allow(true);
		expect((await call).content).toEqual([{ type: "text", text: "cleared" }]);
		expect(runs).toBe(1);

		question = nextQuestion();
		const declined = client.callTool({ name: "clear_memory", arguments: {} });
		(await question).allow(false);
		expect(await declined).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "The user declined" }],
		});
		expect(runs).toBe(1);
		const ids = events.map((line) => Number(line.split(" ")[1]));
		expect(ids[1]).toBe(ids[0]);
		expect(ids[3]).toBe(ids[2]);
		expect(ids[2]).toBeGreaterThan(ids[0] ?? 0);
		expect(events.map((line) => line.replace(/^(\w+) \d+/, "$1"))).toEqual([
			"start clear_memory {} client.example",
			'end ok [{"type":"text","text":"cleared"}]',
			"start clear_memory {} client.example",
			'end declined [{"type":"text","text":"The user declined"}]',
		]);
		await client.close();
	});

	test("an AI app that gives up aborts the tool's signal (http.cancel)", async () => {
		const t = tab();
		let started!: () => void;
		const running = new Promise<void>((resolve) => (started = resolve));
		let aborted!: () => void;
		const wasAborted = new Promise<void>((resolve) => (aborted = resolve));
		await t.registerTool({
			name: "wait",
			description: "Waits",
			execute: (_input, { signal }) => {
				signal.addEventListener("abort", () => aborted());
				started();
				return new Promise(() => {});
			},
		});
		const { address } = await t.connect();
		const token = await tokenFor(r.store, address);
		const controller = new AbortController();
		const res = await mcpPost(
			address,
			rpc(1, "tools/call", { name: "wait", arguments: {} }),
			{ token, signal: controller.signal },
		);
		const reading = res.text().catch(() => "");
		await running;
		controller.abort();
		await reading;
		await wasAborted;
	});

	test("results larger than one message are streamed in pieces", async () => {
		const t = tab();
		const big = "x".repeat(600_000);
		await t.registerTool({
			name: "big",
			description: "Big",
			execute: () => big,
		});
		for (let i = 0; i < 40; i++) {
			await t.registerTool({
				name: `schema_${i}`,
				description: "A tool with a large schema",
				inputSchema: { type: "object", description: "y".repeat(8_000) },
				execute: () => "",
			});
		}
		const { address } = await t.connect();
		const client = await connectClient(
			address,
			await tokenFor(r.store, address),
		);
		expect((await client.listTools()).tools).toHaveLength(42);
		const result = await client.callTool({ name: "big", arguments: {} });
		expect((result.content as { text: string }[])[0]?.text).toBe(big);
		await client.close();
	});
});

describe("disconnect", () => {
	test("disconnect() ends the session; the AI app gets 'the page is not open'", async () => {
		const t = tab();
		const { address } = await t.connect();
		const token = await tokenFor(r.store, address);
		const gone = nextEvent<DisconnectDetail>(t, "disconnected");
		t.disconnect();
		expect((await gone).detail).toEqual({ reason: "user", code: 1000 });
		expect(t.state).toBe("disconnected");
		expect(t.session).toBeUndefined();
		const res = await mcpPost(address, rpc(1, "tools/list"), { token });
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: { code: number } }).error.code).toBe(
			-31001,
		);
	});

	test("a second tab with the same address replaces the first", async () => {
		const storage = new MemoryStorage();
		const first = tab({ storage });
		await first.connect();
		const replaced = nextEvent(first, "replaced");
		const gone = nextEvent<DisconnectDetail>(first, "disconnected");
		await tab({ storage }).connect();
		await replaced;
		expect((await gone).detail).toEqual({ reason: "replaced", code: 4005 });
	});

	test("newAddress() connects again with a new address", async () => {
		const t = tab();
		const before = (await t.connect()).address;
		const gone = nextEvent<DisconnectDetail>(t, "disconnected");
		const after = await t.newAddress();
		expect((await gone).detail.reason).toBe("new_address");
		expect(after?.address).not.toBe(before);
		expect(t.state).toBe("connected");
	});

	test("a relay shutdown ends the session with reason shutdown", async () => {
		const own = startRelay();
		const t = newTab(own.url);
		await t.connect();
		const gone = nextEvent<DisconnectDetail>(t, "disconnected");
		await own.stop();
		expect((await gone).detail).toEqual({ reason: "shutdown", code: 4004 });
	});
});
