/**
 * The tab side of the protocol against a scripted relay: hello, heartbeat,
 * pairing and grants (the relay implements those in iteration 3), errors.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TabMcp } from "../src/index.ts";
import type {
	DisconnectDetail,
	Grant,
	PairingCode,
	ToolCallClient,
} from "../src/types.ts";
import { newTab, nextEvent } from "./helpers.ts";
import { STUB_LIMITS, StubRelay } from "./stub-relay.ts";

let relay: StubRelay;
let t: TabMcp;

const GRANT: Grant = {
	grantId: "g_1",
	client: {
		id: "https://claude.ai/oauth/claude-code-client-metadata",
		name: "Claude Code",
		host: "claude.ai",
	},
	createdAt: "2026-10-19T20:00:00.000Z",
};

beforeEach(() => {
	relay = new StubRelay();
	t = newTab(relay.url, { appName: "saturnus" });
});
afterEach(async () => {
	t.disconnect();
	await relay.stop();
});

test("hello carries the library, the page title, the app name and the secret", async () => {
	await t.connect();
	const hello = await relay.next("hello");
	expect(hello).toEqual({
		type: "hello",
		library: {
			name: "@ractive-ch/tab-mcp-client",
			version: expect.any(String),
		},
		page: { title: "" },
		app: { name: "saturnus" },
		secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
	});
	expect(t.session?.appName).toBe("saturnus");
});

test("the version sent in hello is the package version", async () => {
	const pkg = (await Bun.file(`${import.meta.dir}/../package.json`).json()) as {
		version: string;
	};
	await t.connect();
	expect(
		((await relay.next("hello"))["library"] as { version: string }).version,
	).toBe(pkg.version);
});

test("ping is answered with pong and the same t", async () => {
	await t.connect();
	relay.send({ type: "ping", t: 12345 });
	expect(await relay.next("pong")).toEqual({ type: "pong", t: 12345 });
});

test("two missed pings end the session (reason heartbeat)", async () => {
	relay.limits = { ...STUB_LIMITS, heartbeatMs: 40 };
	await t.connect();
	const gone = await nextEvent<DisconnectDetail>(t, "disconnected");
	expect(gone.detail.reason).toBe("heartbeat");
	expect(t.state).toBe("disconnected");
});

test("bye replaced, then close 4005: replaced and disconnected", async () => {
	await t.connect();
	const replaced = nextEvent(t, "replaced");
	const gone = nextEvent<DisconnectDetail>(t, "disconnected");
	relay.send({ type: "bye", reason: "replaced" });
	relay.close(4005, "replaced");
	await replaced;
	expect((await gone).detail).toEqual({ reason: "replaced", code: 4005 });
});

test.each([
	[4001, "expired"],
	[4002, "idle"],
	[4003, "heartbeat"],
	[4008, "rate_limited"],
	[1008, "policy"],
	[3999, "closed"],
])("close code %d means %s", async (code, reason) => {
	await t.connect();
	const gone = nextEvent<DisconnectDetail>(t, "disconnected");
	relay.close(code);
	expect((await gone).detail).toEqual({
		reason: reason as DisconnectDetail["reason"],
		code,
	});
});

test("disconnect() says bye", async () => {
	await t.connect();
	t.disconnect();
	expect(await relay.next("bye")).toEqual({ type: "bye", reason: "user" });
});

describe("errors", () => {
	test("an unknown type with an id gets unknown_type; a malformed known one bad_message", async () => {
		await t.connect();
		relay.send({ type: "future.thing", id: "x1" });
		expect(await relay.next("error")).toEqual({
			type: "error",
			code: "unknown_type",
			message: "unknown type future.thing",
			id: "x1",
		});
		relay.send({ type: "http.request", id: "r9" });
		expect(await relay.next("error")).toMatchObject({
			code: "bad_message",
			id: "r9",
		});
		relay.send({ type: "future.notice" }); // no id: ignored
		relay.send({ type: "ping", t: 1 });
		await relay.next("pong");
		expect(relay.received.filter((m) => m.type === "error")).toEqual([]);
	});

	test("an error from the relay is an error event", async () => {
		await t.connect();
		const error = nextEvent<{ error: Error }>(t, "error");
		relay.send({ type: "error", code: "rate_limited", message: "slow down" });
		expect((await error).detail.error.message).toContain("rate_limited");
	});

	test("an error before the session rejects connect()", async () => {
		relay.answerHello = false;
		void relay.next("hello").then(() =>
			relay.send({
				type: "error",
				code: "bad_message",
				message: "secret must be 43 base64url characters",
			}),
		);
		await expect(t.connect()).rejects.toThrow(
			/refused the connection: secret must be/,
		);
		expect(t.state).toBe("disconnected");
	});
});

describe("user activation", () => {
	const nav = globalThis.navigator as unknown as Record<string, unknown>;
	afterEach(() => {
		delete nav["userActivation"];
	});

	test("connect() needs a user action where the browser tracks it; resume skips that", async () => {
		Object.defineProperty(nav, "userActivation", {
			value: { isActive: false },
			configurable: true,
		});
		await expect(t.connect()).rejects.toHaveProperty("name", "NotAllowedError");
		expect(t.state).toBe("disconnected");
		await t.connect({ resume: true });
		expect(t.state).toBe("connected");
	});
});

describe("pairing (DEC-028)", () => {
	test("startPairing before connect sends pairing.start after the session; codes become events", async () => {
		t.startPairing();
		await t.connect();
		await relay.next("pairing.start");
		const code = nextEvent<PairingCode | null>(t, "pairingcode");
		relay.send({
			type: "pairing.code",
			code: "123456",
			expiresAt: "2026-10-20T10:00:00.000Z",
		});
		expect((await code).detail).toEqual({
			code: "123456",
			expiresAt: "2026-10-20T10:00:00.000Z",
		});
		expect(t.pairingCode?.code).toBe("123456");
		const cleared = nextEvent<PairingCode | null>(t, "pairingcode");
		t.stopPairing();
		await relay.next("pairing.stop");
		expect((await cleared).detail).toBeNull();
		expect(t.pairingCode).toBeUndefined();
	});

	test("codes are ignored while pairing is off; a disconnect clears the code", async () => {
		await t.connect();
		relay.send({
			type: "pairing.code",
			code: "111111",
			expiresAt: "2026-10-20T10:00:00.000Z",
		});
		relay.send({ type: "ping", t: 1 });
		await relay.next("pong"); // the code has been handled
		t.startPairing();
		await relay.next("pairing.start");
		expect(t.pairingCode).toBeUndefined();
		relay.send({
			type: "pairing.code",
			code: "222222",
			expiresAt: "2026-10-20T10:00:00.000Z",
		});
		await nextEvent(t, "pairingcode");
		const cleared = nextEvent<PairingCode | null>(t, "pairingcode");
		relay.close(4002);
		expect((await cleared).detail).toBeNull();
	});
});

describe("grants", () => {
	test("the session's grants, grant.added and grant.removed keep the list; revoke sends grant.revoke", async () => {
		relay.grants = [GRANT];
		await t.connect();
		expect(t.grants).toEqual([GRANT]);
		const added = nextEvent<{ grants: Grant[] }>(t, "grantschange");
		const second = {
			...GRANT,
			grantId: "g_2",
			client: { ...GRANT.client, name: "ChatGPT", host: "chatgpt.com" },
		};
		relay.send({ type: "grant.added", grant: second });
		expect((await added).detail.grants.map((g) => g.grantId)).toEqual([
			"g_1",
			"g_2",
		]);
		t.revoke("g_1");
		expect(await relay.next("grant.revoke")).toEqual({
			type: "grant.revoke",
			grantId: "g_1",
		});
		const removed = nextEvent<{ grants: Grant[] }>(t, "grantschange");
		relay.send({ type: "grant.removed", grantId: "g_1", reason: "revoked" });
		expect((await removed).detail.grants.map((g) => g.grantId)).toEqual([
			"g_2",
		]);
	});

	test("a tool call names its client from the grants list", async () => {
		relay.grants = [GRANT];
		let seen: ToolCallClient | undefined;
		await t.registerTool({
			name: "who",
			description: "Who calls",
			execute: (_input, { client }) => {
				seen = client;
				return "ok";
			},
		});
		await t.connect();
		relay.send({
			type: "http.request",
			id: "r1",
			method: "POST",
			path: "/mcp",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2026-07-28",
				"mcp-method": "tools/call",
				"mcp-name": "who",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "who",
					arguments: {},
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
			grant: { grantId: "g_1", clientId: GRANT.client.id, scopes: ["tools"] },
		});
		expect(await relay.next("http.response.start")).toMatchObject({
			id: "r1",
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const chunk = await relay.next("http.response.chunk");
		expect(String(chunk["data"])).toContain('"text":"ok"');
		expect(await relay.next("http.response.end")).toEqual({
			type: "http.response.end",
			id: "r1",
		});
		expect(seen).toEqual({
			grantId: "g_1",
			id: GRANT.client.id,
			name: "Claude Code",
			host: "claude.ai",
		});
	});

	test("http.cancel aborts the tool and nothing more is sent for that id", async () => {
		let aborted!: () => void;
		const wasAborted = new Promise<void>((resolve) => (aborted = resolve));
		await t.registerTool({
			name: "wait",
			description: "Waits",
			execute: (_input, { signal }) => {
				signal.addEventListener("abort", () => aborted());
				return new Promise((resolve) =>
					signal.addEventListener("abort", () => resolve("late")),
				);
			},
		});
		await t.connect();
		relay.send({
			type: "http.request",
			id: "r2",
			method: "POST",
			path: "/mcp",
			headers: {
				"content-type": "application/json",
				"mcp-protocol-version": "2026-07-28",
				"mcp-method": "tools/call",
				"mcp-name": "wait",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: {
					name: "wait",
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
			grant: {
				grantId: "g_9",
				clientId: "https://x.example/c.json",
				scopes: ["tools"],
			},
		});
		await relay.next("http.response.start");
		relay.send({ type: "http.cancel", id: "r2", reason: "client_closed" });
		await wasAborted;
		relay.send({ type: "ping", t: 7 });
		await relay.next("pong");
		expect(relay.received.filter((m) => m["id"] === "r2")).toEqual([]);
	});

	test("newAddress revokes all grants, says bye, and connects with a new secret", async () => {
		await t.connect();
		const firstSecret = (await relay.next("hello"))["secret"];
		const again = t.newAddress();
		expect(await relay.next("grants.revokeAll")).toEqual({
			type: "grants.revokeAll",
		});
		expect(await relay.next("bye")).toEqual({ type: "bye", reason: "user" });
		const hello = await relay.next("hello");
		expect(hello["secret"]).not.toBe(firstSecret);
		await again;
		expect(t.state).toBe("connected");
	});
});

test("pieces never split a surrogate pair", async () => {
	const { pieces } = await import("../src/connection.ts");
	const text = "ab😀cd😀😀e";
	for (let max = 1; max <= text.length; max++) {
		const parts = [...pieces(text, max)];
		expect(parts.join("")).toBe(text);
		for (const part of parts) {
			expect(part.length).toBeLessThanOrEqual(Math.max(max, 2));
			expect(() => encodeURIComponent(part)).not.toThrow(); // throws on a lone surrogate
		}
	}
});
