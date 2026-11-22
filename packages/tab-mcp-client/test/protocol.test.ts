/**
 * The tab side of the protocol against a scripted relay: hello, heartbeat,
 * pairing and grants, errors. The real relay: relay.test.ts, oauth-e2e.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TabMcp } from "../src/index.ts";
import { timing } from "../src/tab-mcp.ts";
import type {
	DisconnectReason,
	Grant,
	PairingCode,
	ToolCallClient,
	ToolCallEnd,
} from "../src/types.ts";
import {
	MemoryStorage,
	newTab,
	nextEnd,
	nextEvent,
	setTiming,
	startRelay,
} from "./helpers.ts";
import { STUB_LIMITS, StubRelay } from "./stub-relay.ts";

let relay: StubRelay;
let t: TabMcp;
/**
 * A replaced tab's wait for a sibling's `claimed` (1 s as shipped) is not
 * what these tests are about: 100 ms here, but in the test that keeps it
 * ("a sibling whose hello was never answered does not count").
 */
let restoreGrace: () => void;

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
	restoreGrace = setTiming({ siblingGraceMs: 100 });
	relay = new StubRelay();
	t = newTab(relay.url, { appName: "saturnus" });
});
afterEach(async () => {
	t.disconnect();
	await relay.stop();
	restoreGrace();
});

test("hello carries the library, the app (its id from the server name, its name) and the secret, and nothing else", async () => {
	const session = await t.connect();
	const hello = await relay.next("hello");
	expect(hello).toEqual({
		type: "hello",
		library: {
			name: "@ractive-ch/tab-mcp-client",
			version: expect.any(String),
		},
		app: { id: "test-page", name: "saturnus" },
		secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
	});
	expect(t.session?.appName).toBe("saturnus");
	// The address is the app's (DEC-196): the relay made it from hello.app.id.
	expect(session.address).toBe(`${relay.url}/s/test-page/mcp`);
});

test("hello.app without appName has only the id", async () => {
	t = newTab(relay.url);
	await t.connect();
	const hello = await relay.next("hello");
	expect(hello["app"]).toEqual({ id: "test-page" });
	expect(Object.keys(hello["app"] as object)).toEqual(["id"]);
	expect(t.session?.appName).toBeUndefined();
});

test("hello.app.id is the app option where given, else made from server.name; the name for people is left as it is", async () => {
	t = newTab(relay.url, {
		app: "calc-2",
		appName: "Über Calc 2",
		server: { name: "Something else", version: "1.0.0" },
	});
	expect((await t.connect()).address).toBe(`${relay.url}/s/calc-2/mcp`);
	expect((await relay.next("hello"))["app"]).toEqual({
		id: "calc-2",
		name: "Über Calc 2",
	});
	t.disconnect();
	t = newTab(relay.url, {
		server: { name: "  Über Calc: v2!  ", version: "1.0.0" },
	});
	expect((await t.connect()).address).toBe(`${relay.url}/s/uber-calc-v2/mcp`);
	expect((await relay.next("hello"))["app"]).toEqual({ id: "uber-calc-v2" });
});

test("hello never sends the page title, not even an empty one (CC 6)", async () => {
	const g = globalThis as { document?: unknown };
	g.document = { title: "Inbox (3): a private subject" };
	try {
		await t.connect();
		const hello = await relay.next("hello");
		expect(hello).not.toHaveProperty("page");
		expect(JSON.stringify(hello)).not.toContain("Inbox");
	} finally {
		delete g.document;
	}
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
	const gone = await nextEnd(t);
	expect(gone.reason).toBe("heartbeat");
	expect(t.state).toBe("reconnecting");
});

test("bye replaced, then close 4005: replaced and disconnected", async () => {
	await t.connect();
	const replaced = nextEvent(t, "replaced");
	const gone = nextEnd(t);
	relay.send({ type: "bye", reason: "replaced" });
	relay.close(4005, "replaced");
	await replaced;
	expect((await gone).reason).toBe("replaced");
});

test.each([
	[4001, "expired"],
	[4002, "idle"],
	[4003, "heartbeat"],
	[4008, "rate_limited"],
	// No code of its own any more (DEC-098 withdrawn): like any unknown one.
	[4009, "closed"],
	[1008, "policy"],
	[3999, "closed"],
	// What a proxy sends when the relay behind it restarts (CC 11).
	[1001, "shutdown"],
	[1011, "shutdown"],
	[1012, "shutdown"],
	[1013, "shutdown"],
])("close code %d means %s", async (code, reason) => {
	await t.connect();
	const gone = nextEnd(t);
	relay.close(code);
	expect((await gone).reason).toBe(reason as DisconnectReason);
});

test("disconnect() says bye", async () => {
	await t.connect();
	t.disconnect();
	expect(await relay.next("bye")).toEqual({ type: "bye", reason: "user" });
});

describe("errors", () => {
	test("an unknown type or a malformed known one is dropped without an answer (CC 15)", async () => {
		await t.connect();
		relay.send({ type: "future.thing", id: "x1" });
		relay.send({ type: "http.request", id: "r9" });
		relay.send({ type: "future.notice" });
		relay.send("not json");
		await relay.settled();
		expect(t.state).toBe("connected");
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

	test("app_not_allowed and close 1008 reject connect() as policy, with the relay's text, not retried (DEC-197)", async () => {
		relay.answerHello = false;
		void relay.next("hello").then(() => {
			relay.send({
				type: "error",
				code: "app_not_allowed",
				message:
					'this relay does not let https://page.example serve the app "test-page"',
			});
			relay.close(1008, "app not allowed");
		});
		const error = (await t.connect().catch((e: unknown) => e)) as Error & {
			reason?: string;
		};
		expect(error.message).toBe(
			'The relay refused the connection: this relay does not let https://page.example serve the app "test-page"',
		);
		expect(error.reason).toBe("policy");
		expect(t.state).toBe("disconnected");
		expect(t.reconnecting).toBeUndefined();
		await Bun.sleep(30);
		expect(relay.sockets).toHaveLength(1);
	});

	test("a hello without an app id, as a library up to 0.16 sends it, is refused: by the relay, and by this stand-in alike", async () => {
		const real = startRelay();
		try {
			for (const url of [real.url, relay.url]) {
				const ws = new WebSocket(
					`${url.replace("http", "ws")}/tab`,
					"tab-mcp.v1",
				);
				await new Promise((resolve) => ws.addEventListener("open", resolve));
				const answer = new Promise<MessageEvent>((resolve) =>
					ws.addEventListener("message", resolve, { once: true }),
				);
				const closed = new Promise<CloseEvent>((resolve) =>
					ws.addEventListener("close", resolve, { once: true }),
				);
				ws.send(
					JSON.stringify({
						type: "hello",
						library: { name: "@ractive-ch/tab-mcp-client", version: "0.16.2" },
						page: { title: "" },
						app: { name: "saturnus" },
						secret: "a".repeat(43),
					}),
				);
				const error = JSON.parse(String((await answer).data)) as {
					message: string;
				};
				expect(error).toMatchObject({ type: "error", code: "bad_message" });
				expect(error.message).toStartWith("hello.app.id must be");
				expect((await closed).code).toBe(1008);
			}
		} finally {
			await real.stop();
		}
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
	test("DEC-202: pairing.open becomes pairingUntil; each startPairing() asks again; stopPairing() clears it; a malformed one is ignored", async () => {
		relay.pairing = "oidc";
		t.startPairing();
		await t.connect();
		await relay.next("pairing.start");
		expect(t.pairingUntil).toBeUndefined();
		const until = nextEvent<{ pairingUntil: string | undefined }>(
			t,
			"pairinguntil",
		);
		relay.send({ type: "pairing.open", expiresAt: "2026-11-20T10:10:00.000Z" });
		expect((await until).detail.pairingUntil).toBe("2026-11-20T10:10:00.000Z");
		expect(t.pairingUntil).toBe("2026-11-20T10:10:00.000Z");
		// Not a time, or none: ignored.
		relay.send({ type: "pairing.open", expiresAt: "soon" });
		relay.send({ type: "pairing.open" });
		await relay.settled();
		expect(t.pairingUntil).toBe("2026-11-20T10:10:00.000Z");
		// Continue: asked again although pairing is on.
		t.startPairing();
		await relay.next("pairing.start");
		relay.send({ type: "pairing.open", expiresAt: "2026-11-20T10:20:00.000Z" });
		await nextEvent(t, "pairinguntil");
		expect(t.pairingUntil).toBe("2026-11-20T10:20:00.000Z");
		const cleared = nextEvent<{ pairingUntil: string | undefined }>(
			t,
			"pairinguntil",
		);
		t.stopPairing();
		await relay.next("pairing.stop");
		expect((await cleared).detail.pairingUntil).toBeUndefined();
		expect(t.pairingUntil).toBeUndefined();
		// While pairing is off, one that comes late is not taken.
		relay.send({ type: "pairing.open", expiresAt: "2026-11-20T10:30:00.000Z" });
		await relay.settled();
		expect(t.pairingUntil).toBeUndefined();
	});

	test("DEC-202: pairing.open's expiresInMs is counted on the page's clock from its arrival; a duration that cannot be waited for falls back to expiresAt", async () => {
		relay.pairing = "oidc";
		t.startPairing();
		await t.connect();
		await relay.next("pairing.start");
		// The relay's clock is an hour behind the page's: its expiresAt is
		// long past here, the duration is not.
		const relayTime = new Date(Date.now() - 3_600_000 + 600_000).toISOString();
		const before = Date.now();
		relay.send({
			type: "pairing.open",
			expiresAt: relayTime,
			expiresInMs: 600_000,
		});
		await nextEvent(t, "pairinguntil");
		const until = Date.parse(t.pairingUntil ?? "");
		expect(until).toBeGreaterThanOrEqual(before + 600_000);
		expect(until).toBeLessThanOrEqual(Date.now() + 600_000);
		// Too long for setTimeout, negative, or not a number: the relay's time.
		for (const expiresInMs of [2 ** 31, -1, "600000", Number.NaN]) {
			t.startPairing();
			await relay.next("pairing.start");
			relay.send({ type: "pairing.open", expiresAt: relayTime, expiresInMs });
			await relay.settled();
			expect(t.pairingUntil).toBe(relayTime);
		}
	});

	test("startPairing before connect sends pairing.start after the session; codes become events", async () => {
		t.startPairing();
		await t.connect();
		await relay.next("pairing.start");
		const code = nextEvent<{ pairingCode: PairingCode | undefined }>(
			t,
			"pairingcode",
		);
		relay.send({
			type: "pairing.code",
			code: "BCDF-GHJK",
			expiresAt: "2026-10-20T10:00:00.000Z",
		});
		expect((await code).detail.pairingCode).toEqual({
			code: "BCDF-GHJK",
			expiresAt: "2026-10-20T10:00:00.000Z",
		});
		expect(t.pairingCode?.code).toBe("BCDF-GHJK");
		const cleared = nextEvent<{ pairingCode: PairingCode | undefined }>(
			t,
			"pairingcode",
		);
		t.stopPairing();
		await relay.next("pairing.stop");
		expect((await cleared).detail.pairingCode).toBeUndefined();
		expect(t.pairingCode).toBeUndefined();
	});

	test("the relay's reason for a code comes with it; an unknown one is left out", async () => {
		t.startPairing();
		await t.connect();
		await relay.next("pairing.start");
		const sent: unknown[] = [];
		// "locked" is no reason any more (DEC-196): unknown, like any other word.
		for (const reason of ["start", "used", "expired", "locked", "later", 7]) {
			const code = nextEvent<{ pairingCode: PairingCode | undefined }>(
				t,
				"pairingcode",
			);
			relay.send({
				type: "pairing.code",
				code: "BCDF-GHJK",
				expiresAt: "2026-10-20T10:00:00.000Z",
				reason,
			});
			sent.push((await code).detail.pairingCode?.reason);
		}
		expect(sent).toEqual([
			"start",
			"used",
			"expired",
			undefined,
			undefined,
			undefined,
		]);
		t.stopPairing();
	});

	test("codes are ignored while pairing is off; a disconnect clears the code", async () => {
		await t.connect();
		relay.send({
			type: "pairing.code",
			code: "BBBB-CCCC",
			expiresAt: "2026-10-20T10:00:00.000Z",
		});
		relay.send({ type: "ping", t: 1 });
		await relay.next("pong"); // the code has been handled
		t.startPairing();
		await relay.next("pairing.start");
		expect(t.pairingCode).toBeUndefined();
		relay.send({
			type: "pairing.code",
			code: "DDDD-FFFF",
			expiresAt: "2026-10-20T10:00:00.000Z",
		});
		await nextEvent(t, "pairingcode");
		const cleared = nextEvent<{ pairingCode: PairingCode | undefined }>(
			t,
			"pairingcode",
		);
		relay.close(4002);
		expect((await cleared).detail.pairingCode).toBeUndefined();
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
		const revoked = t.revoke("g_1");
		expect(await relay.next("grant.revoke")).toEqual({
			type: "grant.revoke",
			grantId: "g_1",
		});
		const removed = nextEvent<{ grants: Grant[] }>(t, "grantschange");
		relay.send({ type: "grant.removed", grantId: "g_1", reason: "revoked" });
		expect((await removed).detail.grants.map((g) => g.grantId)).toEqual([
			"g_2",
		]);
		await revoked; // settles on the removal (CU 10)
	});

	test("revoke() rejects while not connected", async () => {
		relay.grants = [GRANT];
		await t.connect();
		const gone = nextEnd(t);
		relay.close(4002);
		await gone;
		await expect(t.revoke("g_1")).rejects.toMatchObject({
			name: "InvalidStateError",
		});
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
			kind: "relay",
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

	test("disconnectAll revokes the old secret's grants (hello.revokeAll), then connects with a new secret at the same address (DEC-136, DEC-196)", async () => {
		relay.grants = [GRANT];
		const before = (await t.connect()).address;
		expect(t.grants.map((g) => g.grantId)).toEqual(["g_1"]);
		relay.grants = []; // the new secret has none
		const firstSecret = (await relay.next("hello"))["secret"];
		const states: string[] = [];
		t.addEventListener("statechange", (e) => states.push(e.detail.state));
		const again = t.disconnectAll();
		expect(await relay.next("bye")).toEqual({ type: "bye", reason: "user" });
		expect(await relay.next("hello")).toMatchObject({
			secret: firstSecret,
			revokeAll: true,
		});
		expect(await relay.next("bye")).toEqual({ type: "bye", reason: "user" });
		const hello = await relay.next("hello");
		expect(hello["secret"]).not.toBe(firstSecret);
		expect(hello["revokeAll"]).toBeUndefined();
		// Both name the same app: the address the AI apps have stays.
		expect(hello["app"]).toEqual({ id: "test-page", name: "saturnus" });
		await again;
		expect(t.state).toBe("connected");
		expect(t.session?.address).toBe(before);
		expect(t.grants).toEqual([]);
		expect(relay.received.some((m) => m.type === "grants.revokeAll")).toBe(
			false,
		);
		// The take-back's session is never the page's: one `connected`, no flicker.
		expect(states).toEqual(["disconnected", "connecting", "connected"]);
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

describe("message size (review of PR #2)", () => {
	const call = (id: string, name: string) => ({
		type: "http.request",
		id,
		method: "POST",
		path: "/mcp",
		headers: {
			"content-type": "application/json",
			"mcp-protocol-version": "2026-07-28",
			"mcp-method": "tools/call",
			"mcp-name": name,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
		grant: {
			grantId: "g_1",
			clientId: "https://x.example/c.json",
			scopes: ["tools"],
		},
	});

	test("every frame stays within a small maxMessageBytes (multi-byte text, escapes)", async () => {
		relay.limits = { ...STUB_LIMITS, maxMessageBytes: 2000 };
		const text = "\u0001".repeat(4000) + "😀é".repeat(500);
		await t.registerTool({
			name: "noisy",
			description: "Escapes a lot",
			execute: () => text,
		});
		await t.connect();
		relay.send(call("r1", "noisy"));
		await relay.next("http.response.end");
		const data = relay.received
			.filter((m) => m.type === "http.response.chunk")
			.map((m) => String(m["data"]))
			.join("");
		expect(data).toContain(JSON.stringify(text).slice(1, -1));
		expect(Math.max(...relay.frameBytes)).toBeLessThanOrEqual(2000);
	});

	/** The body the tab sent for a streamed response, chunks joined. */
	function body(): string {
		return relay.received
			.filter((m) => m.type === "http.response.chunk")
			.map((m) => String(m["data"]))
			.join("");
	}

	test("a result larger than maxBodyBytes is an error result, and toolcallend says so (CC 7)", async () => {
		relay.limits = { ...STUB_LIMITS, maxBodyBytes: 4096 };
		await t.registerTool({
			name: "big",
			description: "Returns a lot",
			execute: () => "x".repeat(10_000),
		});
		await t.connect();
		const ended = nextEvent<ToolCallEnd>(t, "toolcallend");
		relay.send(call("r1", "big"));
		await relay.next("http.response.end");
		const sent = body();
		expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(4096);
		const message = JSON.parse(sent.replace(/^event: message\ndata: /, ""));
		expect(message.result.isError).toBe(true);
		expect(message.result.content[0].text).toMatch(
			/^The result is \d+ bytes; the relay passes on at most 4096\.$/,
		);
		const end = (await ended).detail;
		expect(end.outcome).toBe("error");
		expect(end.result.isError).toBe(true);
	});

	test("a result that fits is sent as it is", async () => {
		relay.limits = { ...STUB_LIMITS, maxBodyBytes: 4096 };
		await t.registerTool({
			name: "small",
			description: "Returns a little",
			execute: () => "x".repeat(1000),
		});
		await t.connect();
		const ended = nextEvent<ToolCallEnd>(t, "toolcallend");
		relay.send(call("r1", "small"));
		await relay.next("http.response.end");
		expect(body()).toContain("x".repeat(1000));
		expect((await ended).detail.outcome).toBe("ok");
	});

	test("a result that is not JSON is an error result, and toolcallend says so", async () => {
		await t.registerTool({
			name: "bigint",
			description: "Returns a BigInt",
			execute: () => ({ content: [{ type: "text", text: "a" }], n: 1n }),
		});
		await t.connect();
		const ended = nextEvent<ToolCallEnd>(t, "toolcallend");
		relay.send(call("r1", "bigint"));
		await relay.next("http.response.end");
		expect(body()).toContain("The tool returned a result that is not JSON.");
		expect((await ended).detail.outcome).toBe("error");
	});

	test("a cancelled call whose result is not JSON ends without an unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await t.registerTool({
				name: "late",
				description: "Answers the abort with a BigInt",
				execute: (_input, { signal }) =>
					new Promise((resolve) =>
						signal.addEventListener("abort", () =>
							resolve({ content: [{ type: "text", text: "a" }], n: 1n }),
						),
					),
			});
			await t.connect();
			const ended = nextEvent<ToolCallEnd>(t, "toolcallend");
			relay.send(call("r1", "late"));
			await relay.next("http.response.start");
			relay.send({ type: "http.cancel", id: "r1", reason: "client_closed" });
			expect((await ended).detail.outcome).toBe("cancelled");
			await Bun.sleep(20);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("a limit too small to frame anything refuses to connect", async () => {
		relay.limits = { ...STUB_LIMITS, maxMessageBytes: 300 };
		await expect(t.connect()).rejects.toThrow(/message limit/);
		expect(t.state).toBe("disconnected");
	});
});

describe("taking a taken-over address back (review of PR 39, DEC-095)", () => {
	/** The relay replaces the page: `bye`, then close 4005 on the page's socket. */
	function replace(socket = relay.sockets.at(-1)): void {
		socket?.send(JSON.stringify({ type: "bye", reason: "replaced" }));
		socket?.close(4005, "replaced");
	}

	test("disconnected comes at once; replaced, with its detail, after it", async () => {
		await t.connect();
		const order: string[] = [];
		t.addEventListener("replaced", () => order.push("replaced"));
		const gone = nextEnd(t);
		replace();
		expect((await gone).reason).toBe("replaced");
		expect(t.state).toBe("disconnected");
		expect(order).toEqual([]); // still waiting for a sibling's claim
		await nextEvent(t, "replaced");
		expect(order).toEqual(["replaced"]);
	});

	test("disconnectAll() during the wait for the detail takes the address back first", async () => {
		await t.connect();
		const secret = (await relay.next("hello"))["secret"];
		const gone = nextEnd(t);
		replace();
		await gone;
		const renewed = t.disconnectAll();
		const back = await relay.next("hello");
		expect(back["secret"]).toBe(secret);
		expect(back["revokeAll"]).toBe(true);
		expect((await relay.next("hello"))["secret"]).not.toBe(secret);
		await renewed;
		expect(t.session?.address).toBeDefined();
		expect(t.state).toBe("connected");
	});

	test("disconnectAll() from a replaced listener takes the address back first", async () => {
		await t.connect();
		const secret = (await relay.next("hello"))["secret"];
		const renewed = new Promise<unknown>((resolve) =>
			t.addEventListener("replaced", () => resolve(t.disconnectAll()), {
				once: true,
			}),
		);
		replace();
		const back = await relay.next("hello");
		expect(back).toMatchObject({ secret, revokeAll: true });
		const fresh = await relay.next("hello");
		expect(fresh["secret"]).not.toBe(secret);
		expect(fresh["revokeAll"]).toBeUndefined();
		await renewed;
		expect(t.state).toBe("connected");
	});

	test("taken over again before the relay confirmed: rejects, keeps the secret, a retry takes it back again", async () => {
		await t.connect();
		const secret = (await relay.next("hello"))["secret"];
		replace();
		await nextEnd(t);
		relay.answerHello = false;
		const renewing = t.disconnectAll();
		expect(await relay.next("hello")).toMatchObject({
			secret,
			revokeAll: true,
		});
		replace(); // the impostor claimed it again first
		await expect(renewing).rejects.toMatchObject({ reason: "replaced" });
		expect(t.state).toBe("disconnected");
		relay.answerHello = true;
		const retry = t.disconnectAll();
		expect(await relay.next("hello")).toMatchObject({
			secret,
			revokeAll: true,
		});
		expect((await relay.next("hello"))["secret"]).not.toBe(secret);
		await retry;
	});

	test("a relay that ignores hello.revokeAll (older than 0.5): rejects, keeps the secret (DEC-136)", async () => {
		relay.grants = [GRANT];
		relay.ignoreRevokeAll = true;
		await t.connect();
		const secret = (await relay.next("hello"))["secret"];
		replace();
		await nextEnd(t);
		const renewing = t.disconnectAll();
		expect(await relay.next("hello")).toMatchObject({
			secret,
			revokeAll: true,
		});
		await expect(renewing).rejects.toMatchObject({ reason: "policy" });
		expect(t.state).toBe("disconnected");
		relay.ignoreRevokeAll = false;
		const retry = t.disconnectAll();
		expect(await relay.next("hello")).toMatchObject({
			secret,
			revokeAll: true,
		});
		await retry;
	});

	test("disconnected, with a secret: takes the address back, clears the grants, stays off (CC 4, CC 14)", async () => {
		relay.grants = [GRANT];
		await t.connect();
		const secret = (await relay.next("hello"))["secret"];
		t.disconnect();
		await relay.next("bye");
		expect(t.grants).toHaveLength(1); // grants stay across disconnect()
		const changes = nextEvent<{ grants: unknown[] }>(t, "grantschange");
		await t.disconnectAll();
		const back = await relay.next("hello");
		expect(back).toMatchObject({ secret, revokeAll: true });
		expect((await changes).detail.grants).toEqual([]);
		expect(t.grants).toEqual([]);
		expect(t.state).toBe("disconnected");
		expect(relay.sockets).toHaveLength(2); // nothing after the take-back
		// The next connect() uses the new secret.
		await t.connect();
		expect((await relay.next("hello"))["secret"]).not.toBe(secret);
	});

	test("a page that never had a secret makes one without connecting", async () => {
		await t.disconnectAll();
		expect(relay.urls).toEqual([]);
		expect(t.state).toBe("disconnected");
	});

	test("the relay cannot be reached: rejects, keeps the secret", async () => {
		await t.connect();
		const secret = (await relay.next("hello"))["secret"];
		t.disconnect();
		relay.refuse = true;
		// The address did not change (DEC-170).
		await expect(t.disconnectAll()).rejects.toMatchObject({
			reason: "network",
			secretChanged: false,
		});
		relay.refuse = false;
		await t.connect();
		expect((await relay.next("hello"))["secret"]).toBe(secret);
	});

	test("taken back, but connecting with the new secret fails: rejects with secretChanged (DEC-170)", async () => {
		await t.connect();
		const secret = (await relay.next("hello"))["secret"];
		relay.answerHello = false;
		const renewing = t.disconnectAll();
		const back = await relay.next("hello");
		expect(back).toMatchObject({ secret, revokeAll: true });
		relay.refuse = true;
		relay.send({
			type: "session",
			sessionId: "s_back",
			address: relay.addressOf("test-page"),
			origin: "https://page.example",
			expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			limits: relay.limits,
			grants: [],
		});
		await expect(renewing).rejects.toMatchObject({
			reason: "network",
			secretChanged: true,
		});
		// The new secret stays: the next connect() uses it.
		relay.refuse = false;
		relay.answerHello = true;
		await t.connect();
		expect((await relay.next("hello"))["secret"]).not.toBe(secret);
	});

	test("a tab that never connected takes the stored address back, which another tab uses (CC 4)", async () => {
		const storage = new MemoryStorage();
		const a = newTab(relay.url, { storage });
		const b = newTab(relay.url, { storage });
		try {
			await a.connect();
			const first = (await relay.next("hello"))["secret"];
			await b.disconnectAll();
			expect(await relay.next("hello")).toMatchObject({
				secret: first,
				revokeAll: true,
			});
			// The stored secret is new now; the next take-back is of that one.
			await a.disconnectAll();
			const second = await relay.next("hello");
			expect(second).toMatchObject({ revokeAll: true });
			expect(second["secret"]).not.toBe(first);
		} finally {
			a.disconnect();
			b.disconnect();
		}
	});

	test("connect() while disconnectAll() runs waits for it and connects with the new secret", async () => {
		await t.connect();
		const secret = (await relay.next("hello"))["secret"];
		t.disconnect();
		const renewing = t.disconnectAll();
		expect(t.disconnectAll()).toBe(renewing); // one run at a time
		const connecting = t.connect();
		await renewing;
		const session = await connecting;
		expect(session.address).toBe(relay.addressOf("test-page"));
		expect(await relay.next("hello")).toMatchObject({
			secret,
			revokeAll: true,
		});
		expect((await relay.next("hello"))["secret"]).not.toBe(secret);
		expect(t.state).toBe("connected");
		expect(relay.sockets).toHaveLength(3); // first, take-back, new: no fourth
	});

	test("after a takeover and a later session of its own that ended, disconnectAll() stays off", async () => {
		await t.connect();
		replace();
		await nextEvent(t, "replaced");
		await t.connect({ resume: true });
		const gone = nextEnd(t);
		relay.close(4002); // idle: not reconnected
		await gone;
		await t.disconnectAll();
		expect(t.state).toBe("disconnected");
	});

	test("disconnect() during the take-back cancels it and keeps the secret", async () => {
		await t.connect();
		const secret = (await relay.next("hello"))["secret"];
		relay.answerHello = false;
		const renewing = t.disconnectAll();
		await relay.next("hello", (m) => m["revokeAll"] === true);
		t.disconnect();
		await expect(renewing).rejects.toMatchObject({ name: "AbortError" });
		expect(t.state).toBe("disconnected");
		relay.answerHello = true;
		await t.connect();
		expect((await relay.next("hello"))["secret"]).toBe(secret);
	});
});

describe("telling a sibling tab from an impostor (review of PR 39, DEC-095)", () => {
	function replaceFirst(): void {
		const first = relay.sockets[0];
		first?.send(JSON.stringify({ type: "bye", reason: "replaced" }));
		first?.close(4005, "replaced");
	}

	/** A tab of the same page as `t`: same storage, so the same secret. */
	let storage: MemoryStorage;
	beforeEach(() => {
		t.disconnect();
		storage = new MemoryStorage();
		t = newTab(relay.url, { appName: "saturnus", storage });
	});

	test("a sibling whose hello was never answered does not count", async () => {
		// The one test that waits the shipped grace in full.
		restoreGrace();
		restoreGrace = () => {};
		expect(timing.siblingGraceMs).toBe(1_000);
		await t.connect();
		relay.answerHello = false;
		const sibling = newTab(relay.url, { storage });
		const failed = sibling.connect();
		failed.catch(() => {});
		// The sibling's hello: the one without an app name.
		await relay.next(
			"hello",
			(m) => (m["app"] as { name?: string }).name === undefined,
		);
		sibling.disconnect();
		await failed.catch(() => {});
		const replaced = nextEvent<{ sibling: boolean }>(t, "replaced");
		replaceFirst();
		expect((await replaced).detail).toEqual({ sibling: false });
	});

	test("a sibling whose session started counts", async () => {
		await t.connect();
		const sibling = newTab(relay.url, { storage });
		await sibling.connect();
		const replaced = nextEvent<{ sibling: boolean }>(t, "replaced");
		replaceFirst();
		try {
			expect((await replaced).detail).toEqual({ sibling: true });
		} finally {
			sibling.disconnect();
		}
	});

	test("a claim without an address, from a tab on a library up to 0.15, counts", async () => {
		await t.connect();
		const announce = new BroadcastChannel(
			`tab-mcp:secret:${relay.url}:test-page#tabs`,
		);
		const listener = new BroadcastChannel(
			`tab-mcp:secret:${relay.url}:test-page#tabs`,
		);
		const delivered = new Promise((r) => {
			listener.onmessage = r;
		});
		announce.postMessage({ type: "claimed" });
		await delivered;
		announce.close();
		listener.close();
		const replaced = nextEvent<{ sibling: boolean }>(t, "replaced");
		replaceFirst();
		expect((await replaced).detail).toEqual({ sibling: true });
	});

	test("a claim of another address does not count (CC 5)", async () => {
		await t.connect();
		// Same channel (same storage key), another secret: after disconnectAll() there.
		const other = newTab(relay.url, { storage: new MemoryStorage() });
		await other.connect();
		const replaced = nextEvent<{ sibling: boolean }>(t, "replaced");
		replaceFirst();
		try {
			expect((await replaced).detail).toEqual({ sibling: false });
		} finally {
			other.disconnect();
		}
	});

	test("a claim heard while this tab was still connecting does not count (CC 5)", async () => {
		relay.answerHello = false;
		const connecting = t.connect();
		await relay.next("hello");
		const sibling = newTab(relay.url, { storage });
		relay.answerHello = true;
		await sibling.connect(); // claims while `t` still waits for its session
		sibling.disconnect();
		// `t`'s own socket, the first one, gets its session now.
		relay.sockets[0]?.send(
			JSON.stringify({
				type: "session",
				sessionId: "s_t",
				address: relay.addressOf("test-page"),
				origin: "https://page.example",
				expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
				limits: STUB_LIMITS,
				grants: [],
			}),
		);
		await connecting;
		const replaced = nextEvent<{ sibling: boolean }>(t, "replaced");
		replaceFirst();
		expect((await replaced).detail).toEqual({ sibling: false });
	});
});
