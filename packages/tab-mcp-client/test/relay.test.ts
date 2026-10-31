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
	// pageWaitMs 0: "the page is not open" at once (DEC-074).
	r = startRelay({ keepAliveMs: 50, pageWaitMs: 0 });
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
			/^http:\/\/127\.0\.0\.1:\d+\/a\/[a-z2-7]{52}\/mcp$/,
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
		expect(res.status).toBe(200);
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
		// The new tab announced on the page's BroadcastChannel (DEC-095).
		expect((await replaced).detail).toEqual({ sibling: true });
		expect((await gone).detail).toEqual({ reason: "replaced", code: 4005 });
	});

	/** A program with a copied secret: `hello` over a plain WebSocket, no tab. */
	async function impostor(secret: string): Promise<WebSocket> {
		const ws = new WebSocket(
			`${r.url.replace("http", "ws")}/tab`,
			"tab-mcp.v1",
		);
		await new Promise((resolve) => ws.addEventListener("open", resolve));
		const session = new Promise((resolve) =>
			ws.addEventListener("message", resolve, { once: true }),
		);
		ws.send(
			JSON.stringify({
				type: "hello",
				library: { name: "impostor", version: "1.0.0" },
				page: { title: "" },
				secret,
			}),
		);
		await session;
		return ws;
	}

	test("a program with the copied secret replaces the tab: sibling false (iteration 10)", async () => {
		const storage = new MemoryStorage();
		const t = tab({ storage });
		await t.connect();
		const replaced = nextEvent(t, "replaced");
		const ws = await impostor([...storage.items.values()][0] as string);
		try {
			expect((await replaced).detail).toEqual({ sibling: false });
		} finally {
			ws.close();
		}
	});

	test("an impostor that claims the address again the moment it gets bye: the old apps are still cut off (review of PR 39)", async () => {
		const storage = new MemoryStorage();
		const t = tab({ storage });
		const { address } = await t.connect();
		const token = await tokenFor(r.store, address);
		const secret = [...storage.items.values()][0] as string;
		// A spare socket, open before it is needed, so its hello goes out at once.
		const sockets: WebSocket[] = [];
		const spare = async () => {
			const ws = new WebSocket(
				`${r.url.replace("http", "ws")}/tab`,
				"tab-mcp.v1",
			);
			sockets.push(ws);
			await new Promise((resolve) => ws.addEventListener("open", resolve));
			return ws;
		};
		const hello = JSON.stringify({
			type: "hello",
			library: { name: "impostor", version: "1.0.0" },
			page: { title: "" },
			secret,
		});
		let next = await spare();
		const claim = (ws: WebSocket) => {
			ws.addEventListener("message", (e) => {
				if (!String(e.data).includes('"bye"')) return;
				const now = next;
				claim(now); // at once, from the spare
				void spare().then((ws) => {
					next = ws;
				});
			});
			ws.send(hello);
		};
		const replaced = nextEvent(t, "replaced");
		const first = next;
		next = await spare();
		claim(first);
		try {
			await replaced;
			for (let attempt = 0; attempt < 3; attempt++) {
				const outcome = await t.newAddress().then(
					() => "renewed",
					(error: { reason?: string }) => error.reason,
				);
				if (outcome === "renewed") break;
				expect(outcome).toBe("replaced");
			}
			const res = await mcpPost(address, rpc(1, "tools/list"), { token });
			expect(res.status).toBe(401);
		} finally {
			for (const ws of sockets) ws.close();
		}
	});

	test("without BroadcastChannel, a second tab counts as unknown: sibling false", async () => {
		const g = globalThis as { BroadcastChannel?: unknown };
		const saved = g.BroadcastChannel;
		delete g.BroadcastChannel;
		try {
			const storage = new MemoryStorage();
			const first = tab({ storage });
			await first.connect();
			const replaced = nextEvent(first, "replaced");
			await tab({ storage }).connect();
			expect((await replaced).detail).toEqual({ sibling: false });
		} finally {
			g.BroadcastChannel = saved;
		}
	});

	test("newAddress() after a takeover takes the address back and disconnects its apps (iteration 10)", async () => {
		const storage = new MemoryStorage();
		const t = tab({ storage });
		const { address } = await t.connect();
		const token = await tokenFor(r.store, address);
		const replaced = nextEvent(t, "replaced");
		const ws = await impostor([...storage.items.values()][0] as string);
		try {
			await replaced;
			expect(t.state).toBe("disconnected");
			const renewed = await t.newAddress();
			expect(renewed?.address).not.toBe(address);
			expect(t.state).toBe("connected");
			// The app paired with the old address no longer reaches anyone.
			const res = await mcpPost(address, rpc(1, "tools/list"), { token });
			expect(res.status).toBe(401);
		} finally {
			ws.close();
		}
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
