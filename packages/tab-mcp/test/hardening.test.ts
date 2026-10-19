/**
 * Hardening tests from the review of PR #1: each block pins one finding.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { newSecret } from "../src/address.ts";
import { Exchange } from "../src/exchange.ts";
import { parseTabMessage } from "../src/protocol.ts";
import type { CreateRelayOptions } from "../src/relay.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import {
	mcpPost,
	rpc,
	ScriptedTab,
	startRelay,
	type TabOptions,
	type TestRelay,
	tokenFor,
} from "./helpers.ts";

let current: TestRelay | undefined;
const tabs: ScriptedTab[] = [];

function relay(options: CreateRelayOptions = {}): TestRelay {
	current = startRelay(options);
	return current;
}

function tab(r: TestRelay, options: TabOptions = {}): ScriptedTab {
	const t = new ScriptedTab(r.wsUrl, options);
	tabs.push(t);
	return t;
}

afterEach(async () => {
	for (const t of tabs.splice(0)) {
		if (t.ws.readyState <= 1) t.close();
	}
	await current?.stop();
	current = undefined;
});

/** A connected tab with `onRequest`, its address and a token. */
async function connected(r: TestRelay, onRequest: TabOptions["onRequest"]) {
	const t = tab(r, onRequest === undefined ? {} : { onRequest });
	const session = await t.connect();
	const token = await tokenFor(r.store, t.addressId);
	return { t, address: session.address, token };
}

describe("1: a tab cannot crash the relay with bad responses", () => {
	test("header values must be RFC 9110 field values", () => {
		for (const bad of [
			"application/json☃",
			"a\r\nb",
			"a\nb",
			"a\u0000b",
			"a\u0001b",
			"a\u007fb",
		]) {
			const r = parseTabMessage(
				JSON.stringify({
					type: "http.response",
					id: "r1",
					status: 200,
					headers: { "content-type": bad },
					body: "",
				}),
			);
			expect(r.ok).toBe(false);
		}
		const good = parseTabMessage(
			JSON.stringify({
				type: "http.response",
				id: "r1",
				status: 200,
				headers: {
					"content-type": "text/plain; charset=utf-8",
					"cache-control": "no-cache\tx",
				},
				body: "",
			}),
		);
		expect(good.ok).toBe(true);
	});

	for (const type of ["http.response", "http.response.start"] as const) {
		test(`an invalid header value in ${type} fails only that request`, async () => {
			const r = relay();
			const { t, address, token } = await connected(r, (msg, tab) => {
				tab.send({
					type,
					id: msg.id,
					status: 200,
					headers: { "content-type": "application/json☃" },
					...(type === "http.response" ? { body: "{}" } : {}),
				});
			});
			const res = await mcpPost(address, rpc(1, "tools/list"), { token });
			expect(res.status).toBe(502);
			expect((await t.next("error")).type).toBe("error");
			// the relay and the session still work
			expect((await fetch(`${r.relay.url}/healthz`)).status).toBe(200);
			expect(t.ws.readyState).toBe(WebSocket.OPEN);
		});
	}

	for (const status of [204, 205, 304]) {
		test(`status ${status} with a body fails the request with 502`, async () => {
			const r = relay();
			const { t, address, token } = await connected(r, (msg, tab) => {
				tab.send({
					type: "http.response",
					id: msg.id,
					status,
					headers: {},
					body: "not allowed",
				});
			});
			const res = await mcpPost(address, rpc(1, "tools/list"), { token });
			expect(res.status).toBe(502);
			expect(t.ws.readyState).toBe(WebSocket.OPEN);
		});
	}

	test("status 204 without a body passes", async () => {
		const r = relay();
		const { address, token } = await connected(r, (msg, tab) => {
			tab.send({
				type: "http.response",
				id: msg.id,
				status: 204,
				headers: {},
				body: "",
			});
		});
		const res = await mcpPost(address, rpc(1, "tools/list"), { token });
		expect(res.status).toBe(204);
	});

	test("process: an unhandled rejection is logged and the relay keeps running", () => {
		const run = Bun.spawnSync([
			"bun",
			join(import.meta.dir, "fixtures/crash-logging.ts"),
			"rejection",
		]);
		const out = run.stdout.toString();
		expect(run.exitCode).toBe(0);
		expect(out).toContain('"event":"process.unhandled_rejection"');
		expect(out).toContain('"error":"TypeError"');
		expect(out).toContain("still running");
		expect(out).not.toContain("PRIVATE-DETAIL");
	});

	test("process: an uncaught exception is logged and exits with 1", () => {
		const run = Bun.spawnSync([
			"bun",
			join(import.meta.dir, "fixtures/crash-logging.ts"),
			"exception",
		]);
		const out = run.stdout.toString();
		expect(run.exitCode).toBe(1);
		expect(out).toContain('"event":"process.uncaught_exception"');
		expect(out).not.toContain("still running");
		expect(out).not.toContain("PRIVATE-DETAIL");
	});

	test("a streamed null-body status fails the request with 502", async () => {
		const r = relay();
		const { address, token } = await connected(r, (msg, tab) => {
			tab.send({
				type: "http.response.start",
				id: msg.id,
				status: 204,
				headers: {},
			});
		});
		const res = await mcpPost(address, rpc(1, "tools/list"), { token });
		expect(res.status).toBe(502);
	});
});

/** Open a raw TCP connection, send `data`, and report when the server closes it. */
async function stalledRequest(
	port: number,
	data: string,
): Promise<{ closedAfterMs: Promise<number>; received: () => string }> {
	const started = Date.now();
	let resolveClosed: (ms: number) => void = () => {};
	const closedAfterMs = new Promise<number>((resolve) => {
		resolveClosed = resolve;
	});
	let received = "";
	const socket = await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			data: (_s, chunk) => {
				received += new TextDecoder().decode(chunk);
			},
			close: () => resolveClosed(Date.now() - started),
			error: () => resolveClosed(Date.now() - started),
		},
	});
	socket.write(data);
	return { closedAfterMs, received: () => received };
}

describe("2: unauthenticated requests keep Bun's idle timeout", () => {
	test("a stalled unauthenticated POST to the MCP endpoint is closed after the idle timeout", async () => {
		const r = relay({ httpIdleTimeoutS: 1, bodyTimeoutMs: 500 });
		const address = new URL(r.relay.addressFor(newSecret()));
		const { closedAfterMs, received } = await stalledRequest(
			r.relay.port,
			`POST ${address.pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nMCP-Protocol-Version: 2026-07-28\r\nContent-Length: 100\r\n\r\n{"jsonrpc":`,
		);
		const ms = await Promise.race([
			closedAfterMs,
			Bun.sleep(4000).then(() => -1),
		]);
		expect(ms).toBeGreaterThan(0);
		expect(ms).toBeLessThan(2500);
		expect(received()).toStartWith("HTTP/1.1 408");
	}, 6000);

	test("a stalled POST with a valid token is closed the same way (nothing is forwarded)", async () => {
		const r = relay({ bodyTimeoutMs: 500 });
		const { t, address, token } = await connected(r, undefined);
		const { closedAfterMs, received } = await stalledRequest(
			r.relay.port,
			`POST ${new URL(address).pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nMCP-Protocol-Version: 2026-07-28\r\nContent-Length: 100\r\n\r\n{`,
		);
		const ms = await Promise.race([
			closedAfterMs,
			Bun.sleep(4000).then(() => -1),
		]);
		expect(ms).toBeGreaterThan(0);
		expect(received()).toStartWith("HTTP/1.1 408");
		expect(t.received.some((m) => m.type === "http.request")).toBe(false);
	}, 6000);

	test("an authenticated, forwarded request still outlives the idle timeout", async () => {
		const r = relay({ httpIdleTimeoutS: 1, keepAliveMs: 20_000 });
		const { address, token } = await connected(r, async (msg, tab) => {
			await Bun.sleep(2200);
			tab.send({
				type: "http.response",
				id: msg.id,
				status: 200,
				headers: { "content-type": "application/json" },
				body: '{"jsonrpc":"2.0","id":1,"result":{}}',
			});
		});
		const res = await mcpPost(address, rpc(1, "tools/list"), { token });
		expect(res.status).toBe(200);
	}, 6000);
});

describe("3: response size and backpressure", () => {
	const chunk = "x".repeat(900);

	test("a streamed response over maxBodyBytes ends with an error and cancels the tab", async () => {
		const r = relay({ maxMessageBytes: 2000 });
		const { t, address, token } = await connected(r, (msg, tab) => {
			tab.send({
				type: "http.response.start",
				id: msg.id,
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
			for (let i = 0; i < 5; i++) {
				tab.send({
					type: "http.response.chunk",
					id: msg.id,
					data: `data: ${chunk}\n\n`,
				});
			}
			tab.send({ type: "http.response.end", id: msg.id });
		});
		const res = await mcpPost(address, rpc(1, "tools/call", { name: "x" }), {
			token,
		});
		const text = await res.text();
		expect(text.length).toBeLessThan(2000 + 300);
		expect(text).toContain('"code":-31006');
		expect(await t.next("http.cancel")).toEqual({
			type: "http.cancel",
			id: expect.any(String),
			reason: "error",
		});
	});

	test("a wrapped (non-SSE) streamed body over maxBodyBytes fails too", async () => {
		const r = relay({ maxMessageBytes: 2000, keepAliveMs: 30 });
		const { t, address, token } = await connected(r, async (msg, tab) => {
			await Bun.sleep(80); // the relay starts the event stream first
			tab.send({
				type: "http.response.start",
				id: msg.id,
				status: 200,
				headers: { "content-type": "application/json" },
			});
			for (let i = 0; i < 5; i++)
				tab.send({ type: "http.response.chunk", id: msg.id, data: chunk });
			tab.send({ type: "http.response.end", id: msg.id });
		});
		const res = await mcpPost(address, rpc(1, "tools/call", { name: "x" }), {
			token,
		});
		const text = await res.text();
		expect(text).not.toContain(chunk);
		expect(text).toContain('"code":-31006');
		expect((await t.next("http.cancel")).type).toBe("http.cancel");
	});

	test("listen streams have no total limit", async () => {
		const r = relay({ maxMessageBytes: 2000 });
		const { address, token } = await connected(r, (msg, tab) => {
			tab.send({
				type: "http.response.start",
				id: msg.id,
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
			for (let i = 0; i < 5; i++)
				tab.send({
					type: "http.response.chunk",
					id: msg.id,
					data: `data: ${chunk}\n\n`,
				});
			tab.send({ type: "http.response.end", id: msg.id });
		});
		const res = await mcpPost(
			address,
			rpc(1, "subscriptions/listen", { notifications: {} }),
			{ token },
		);
		expect((await res.text()).split(chunk).length - 1).toBe(5);
	});

	test("an AI app that does not read: the queue is bounded and the tab is cancelled", async () => {
		const cancels: string[] = [];
		const exchange = new Exchange({
			id: "r1",
			rpcId: 1,
			isListen: true,
			requestTimeoutMs: 60_000,
			keepAliveMs: 60_000,
			maxBodyBytes: 4000,
			extraHeaders: {},
			cancel: (reason) => cancels.push(reason),
			onDone: () => {},
		});
		exchange.onStart({
			type: "http.response.start",
			id: "r1",
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		await exchange.response; // never read
		for (let i = 0; i < 20 && !exchange.done; i++) {
			exchange.onChunk(`data: ${chunk}\n\n`);
		}
		expect(exchange.done).toBe(true);
		expect(cancels).toEqual(["error"]);
	});
});

describe("4: an open listen stream keeps the session from going idle", () => {
	test("a session whose only request is a listen stream is not closed as idle", async () => {
		const r = relay({ heartbeatMs: 20, idleTimeoutMs: 80, keepAliveMs: 50 });
		const { t, address, token } = await connected(r, (msg, tab) => {
			tab.send({
				type: "http.response.start",
				id: msg.id,
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		const abort = new AbortController();
		const res = await mcpPost(
			address,
			rpc(1, "subscriptions/listen", { notifications: {} }),
			{ token, signal: abort.signal },
		);
		expect(res.status).toBe(200);
		await Bun.sleep(400);
		expect(t.ws.readyState).toBe(WebSocket.OPEN);
		expect(t.received.some((m) => m.type === "bye")).toBe(false);
		// once the stream is gone, the idle timeout applies again
		abort.abort();
		expect(await t.next("bye")).toEqual({ type: "bye", reason: "idle" });
		expect((await t.closed).code).toBe(4002);
	});
});

describe("5: a failing token store is not an invalid token", () => {
	test("a store error answers 503 with Retry-After, so clients keep their tokens", async () => {
		const store = new MemoryTokenStore();
		store.get = async () => {
			throw new Error("database is locked");
		};
		const r = relay({ store });
		const res = await mcpPost(
			r.relay.addressFor(newSecret()),
			rpc(4, "tools/list"),
			{ token: "tmcp_at_whatever" },
		);
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).toBe("5");
		expect(res.headers.get("www-authenticate")).toBeNull();
		const body = (await res.json()) as { id: number; error: { code: number } };
		expect(body.id).toBe(4);
		expect(body.error.code).toBe(-31008);
		expect(r.logs.events("store.error")).toEqual([
			expect.objectContaining({ op: "get" }),
		]);
	});
});

describe("6: a request aborted before forwarding is not forwarded", () => {
	test("aborting while the token is checked: no http.request, no slot held", async () => {
		const store = new MemoryTokenStore();
		const get = store.get.bind(store);
		store.get = async (hash) => {
			await Bun.sleep(200);
			return get(hash);
		};
		const r = relay({ store, maxConcurrentRequests: 1 });
		const t = tab(r, { onRequest: () => {} }); // never answers
		const session = await t.connect();
		const token = await tokenFor(store, t.addressId);
		const abort = new AbortController();
		const pending = mcpPost(session.address, rpc(1, "tools/list"), {
			token,
			signal: abort.signal,
		}).catch(() => "aborted");
		await Bun.sleep(50);
		abort.abort();
		expect(await pending).toBe("aborted");
		await Bun.sleep(300);
		expect(t.received.some((m) => m.type === "http.request")).toBe(false);
		expect(r.logs.events("mcp.request")).toEqual([
			expect.objectContaining({ status: 499, outcome: "client_closed" }),
		]);
	});
});
