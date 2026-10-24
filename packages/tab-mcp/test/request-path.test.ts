/**
 * Iteration 11: the relay's request path (review of 2026-10-24). Each block
 * pins one finding; finding 3 is in identity.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { addressIdFromSecret, newSecret } from "../src/address.ts";
import type { CreateRelayOptions } from "../src/relay.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import {
	mcpPost,
	ORIGIN,
	rpc,
	ScriptedTab,
	startRelay,
	type TabOptions,
	type TestRelay,
	tokenFor,
	waitFor,
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
async function connected(
	r: TestRelay,
	onRequest: TabOptions["onRequest"],
	options: TabOptions = {},
) {
	const t = tab(r, {
		...options,
		...(onRequest === undefined ? {} : { onRequest }),
	});
	const session = await t.connect();
	const token = await tokenFor(r.store, t.addressId);
	return { t, address: session.address, token };
}

/**
 * Send one keep-alive HTTP/1.1 request on a raw socket; reports the status
 * line and when the server closes the connection.
 */
async function rawRequest(
	port: number,
	path: string,
	body: unknown,
	token: string | undefined,
) {
	const text = JSON.stringify(body);
	const request = [
		`POST ${path} HTTP/1.1`,
		"Host: 127.0.0.1",
		"Content-Type: application/json",
		"Accept: application/json, text/event-stream",
		"MCP-Protocol-Version: 2026-07-28",
		`Mcp-Method: ${(body as { method: string }).method}`,
		...(token === undefined ? [] : [`Authorization: Bearer ${token}`]),
		`Content-Length: ${Buffer.byteLength(text)}`,
		"",
		text,
	].join("\r\n");
	const started = Date.now();
	let received = "";
	let resolveClosed: (ms: number) => void = () => {};
	const closedAfterMs = new Promise<number>((resolve) => {
		resolveClosed = resolve;
	});
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
	socket.write(request);
	return {
		closedAfterMs,
		received: () => received,
		end: () => socket.end(),
	};
}

describe("1: a listen stream must be an event stream", () => {
	const chunk = "x".repeat(9000);

	test("a JSON answer to a relay-started listen stream fails at once and cancels the tab", async () => {
		const r = relay({ maxMessageBytes: 16_384, keepAliveMs: 30 });
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
		});
		const res = await mcpPost(
			address,
			rpc(1, "subscriptions/listen", { notifications: {} }),
			{ token },
		);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		const text = await res.text();
		expect(text).toContain('"code":-31007');
		expect(text).not.toContain(chunk);
		expect((await t.next("http.cancel")).type).toBe("http.cancel");
		expect(await t.next("error")).toEqual({
			type: "error",
			code: "bad_message",
			message: expect.stringContaining("event stream"),
			id: expect.any(String),
		});
	});

	test("a JSON stream started by the tab for a listen request is refused with 502", async () => {
		const r = relay({ maxMessageBytes: 16_384 });
		const { t, address, token } = await connected(r, (msg, tab) => {
			tab.send({
				type: "http.response.start",
				id: msg.id,
				status: 200,
				headers: { "content-type": "application/json" },
			});
			tab.send({ type: "http.response.chunk", id: msg.id, data: chunk });
		});
		const res = await mcpPost(
			address,
			rpc(1, "subscriptions/listen", { notifications: {} }),
			{ token },
		);
		expect(res.status).toBe(502);
		expect(await res.text()).toContain('"code":-31007');
		expect((await t.next("http.cancel")).type).toBe("http.cancel");
	});

	test("a chunk before http.response.start on a relay-started stream is refused", async () => {
		const r = relay({ maxMessageBytes: 16_384, keepAliveMs: 30 });
		const { t, address, token } = await connected(r, async (msg, tab) => {
			await Bun.sleep(80);
			for (let i = 0; i < 5; i++)
				tab.send({
					type: "http.response.chunk",
					id: msg.id,
					data: `data: ${chunk}\n\n`,
				});
		});
		const res = await mcpPost(
			address,
			rpc(1, "subscriptions/listen", { notifications: {} }),
			{ token },
		);
		const text = await res.text();
		expect(text).toContain('"code":-31007');
		expect(text).not.toContain(chunk);
		expect((await t.next("http.cancel")).type).toBe("http.cancel");
	});
});

describe("2: Bun's idle timeout comes back after an authenticated request", () => {
	test("after a page-not-open answer the keep-alive socket is closed when idle", async () => {
		const r = relay({ httpIdleTimeoutS: 1, pageWaitMs: 200 });
		const secret = newSecret();
		const address = new URL(r.relay.addressFor(secret));
		const token = await tokenFor(r.store, addressIdFromSecret(secret));
		const probe = await rawRequest(
			r.relay.port,
			address.pathname,
			rpc(1, "tools/list"),
			token,
		);
		const ms = await Promise.race([
			probe.closedAfterMs,
			Bun.sleep(6000).then(() => -1),
		]);
		probe.end();
		expect(probe.received()).toStartWith("HTTP/1.1 200");
		expect(probe.received()).toContain('"code":-31001');
		expect(ms).toBeGreaterThan(0);
	}, 8000);

	test("after a forwarded request the keep-alive socket is closed when idle", async () => {
		const r = relay({ httpIdleTimeoutS: 1 });
		const { address, token } = await connected(r, undefined);
		const probe = await rawRequest(
			r.relay.port,
			new URL(address).pathname,
			rpc(1, "tools/list"),
			token,
		);
		const ms = await Promise.race([
			probe.closedAfterMs,
			Bun.sleep(6000).then(() => -1),
		]);
		probe.end();
		expect(probe.received()).toStartWith("HTTP/1.1 200");
		expect(ms).toBeGreaterThan(0);
	}, 8000);

	test("after a refused request (429) the keep-alive socket is closed when idle", async () => {
		const r = relay({ httpIdleTimeoutS: 1, maxConcurrentRequests: 1 });
		const { address, token } = await connected(r, () => {}); // never answers
		void mcpPost(address, rpc(1, "tools/list"), { token }).catch(
			() => undefined,
		);
		await Bun.sleep(50);
		const probe = await rawRequest(
			r.relay.port,
			new URL(address).pathname,
			rpc(2, "tools/list"),
			token,
		);
		const ms = await Promise.race([
			probe.closedAfterMs,
			Bun.sleep(6000).then(() => -1),
		]);
		probe.end();
		expect(probe.received()).toStartWith("HTTP/1.1 429");
		expect(ms).toBeGreaterThan(0);
	}, 8000);
});

describe("4: requests wait for a page within its site's limit", () => {
	test("no more requests wait than the site lets run, so none gets 429 when the page comes", async () => {
		const r = relay({
			allowedOrigins: [],
			sites: [{ origin: ORIGIN, limits: { maxConcurrentRequests: 2 } }],
			pageWaitMs: 3000,
		});
		const secret = newSecret();
		// The page was open once: the relay knows its site.
		const first = tab(r, { secret });
		await first.connect();
		first.close();
		await waitFor(() => r.relay.sessionCount === 0, "the page to go");
		const token = await tokenFor(r.store, first.addressId);
		const address = r.relay.addressFor(secret);
		const answered: number[] = [];
		const requests = [1, 2, 3, 4].map((i) =>
			mcpPost(address, rpc(i, "tools/list"), { token }).then(async (res) => {
				answered.push(i);
				return { status: res.status, text: await res.text() };
			}),
		);
		await waitFor(() => answered.length === 2, "two immediate answers");
		const page = tab(r, { secret });
		await page.connect();
		const results = await Promise.all(requests);
		expect(results.map((x) => x.status)).not.toContain(429);
		expect(results.filter((x) => x.text.includes('"tools"'))).toHaveLength(2);
		expect(results.filter((x) => x.text.includes("-31001"))).toHaveLength(2);
	});
});

describe("5: during shutdown AI apps are told the relay restarts", () => {
	test("a request waiting for the page gets the restarting answer", async () => {
		const r = relay({ pageWaitMs: 5000 });
		const secret = newSecret();
		const token = await tokenFor(r.store, addressIdFromSecret(secret));
		const pending = mcpPost(
			r.relay.addressFor(secret),
			rpc(1, "tools/call", { name: "add", arguments: { a: 1, b: 2 } }),
			{ token },
		);
		await Bun.sleep(100);
		const stopping = r.relay.stop();
		const res = await pending;
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("restarting");
		expect(text).not.toContain("not open");
		await stopping;
	});

	test("a request in flight when the relay stops is not told to open the page", async () => {
		const r = relay();
		const { address, token } = await connected(r, () => {}); // never answers
		const pending = mcpPost(address, rpc(1, "tools/list"), { token });
		await Bun.sleep(100);
		const stopping = r.relay.stop();
		const res = await pending;
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			error: { code: number; message: string };
		};
		expect(body.error.code).toBe(-31010);
		expect(body.error.message).toContain("restarting");
		await stopping;
	});

	test("a notification during shutdown gets 503 with Retry-After", async () => {
		const r = relay({ pageWaitMs: 5000 });
		const secret = newSecret();
		const token = await tokenFor(r.store, addressIdFromSecret(secret));
		const { id: _id, ...notification } = rpc(1, "notifications/x");
		const pending = mcpPost(r.relay.addressFor(secret), notification, {
			token,
		});
		await Bun.sleep(100);
		const stopping = r.relay.stop();
		const res = await pending;
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).not.toBeNull();
		expect(await res.text()).toContain("-31010");
		await stopping;
	});

	test("a notification in flight when the relay stops gets 503 with -31010 and Retry-After (review of PR #30)", async () => {
		const r = relay();
		const { t, address, token } = await connected(r, () => {}); // never answers
		const { id: _id, ...notification } = rpc(1, "notifications/x");
		const pending = mcpPost(address, notification, { token });
		await t.next("http.request");
		const stopping = r.relay.stop();
		const res = await pending;
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).not.toBeNull();
		expect(await res.text()).toContain('"code":-31010');
		await stopping;
	});
});

describe("6: one AI app cannot hold every slot of a page with listen streams", () => {
	test("a grant may hold two listen streams; the third gets 429; another grant still can listen", async () => {
		const r = relay({ keepAliveMs: 50 });
		const { t, address, token } = await connected(r, () => {}); // never answers
		const listen = (t: string, i: number) =>
			mcpPost(address, rpc(i, "subscriptions/listen", { notifications: {} }), {
				token: t,
			});
		const a = await listen(token, 1);
		const b = await listen(token, 2);
		const c = await listen(token, 3);
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		expect(c.status).toBe(429);
		expect(await c.text()).toContain('"code":-31004');
		const other = await tokenFor(r.store, t.addressId);
		const d = await listen(other, 4);
		expect(d.status).toBe(200);
		for (const res of [a, b, d]) await res.body?.cancel();
	});
});

describe("7: store errors are logged by name only", () => {
	test("a store error's message does not reach the log", async () => {
		const store = new MemoryTokenStore();
		store.get = async () => {
			throw new Error("connection postgres://user:hunter2@db failed");
		};
		const r = relay({ store });
		const res = await mcpPost(
			r.relay.addressFor(newSecret()),
			rpc(1, "tools/list"),
			{ token: "tmcp_at_whatever" },
		);
		expect(res.status).toBe(503);
		expect(r.logs.events("store.error")).toEqual([
			expect.objectContaining({ op: "get", error: "Error" }),
		]);
		expect(r.logs.lines.join("\n")).not.toContain("hunter2");
	});
});

describe("8: oversized tab frames are refused before they are parsed", () => {
	test("a frame over the site's limit is not JSON-parsed", async () => {
		const r = relay({
			allowedOrigins: [],
			maxMessageBytes: 65_536,
			sites: [{ origin: ORIGIN, limits: { maxMessageBytes: 16_384 } }],
		});
		const { t, address, token } = await connected(r, (msg, tab) => {
			tab.ws.send(
				JSON.stringify({
					type: "http.response",
					id: msg.id,
					status: 200,
					headers: { "content-type": "application/json" },
					body: "x".repeat(40_000),
				}),
			);
		});
		const parse = JSON.parse;
		let parsedLarge = 0;
		JSON.parse = ((text: string, reviver?: never) => {
			if (typeof text === "string" && text.length > 16_384) parsedLarge++;
			return parse(text, reviver);
		}) as typeof JSON.parse;
		try {
			const res = await mcpPost(address, rpc(1, "tools/list"), { token });
			expect(res.status).toBe(502);
			expect(await res.text()).toContain('"code":-31006');
			expect(await t.next("error")).toEqual({
				type: "error",
				code: "too_large",
				message: expect.any(String),
				id: expect.any(String),
			});
		} finally {
			JSON.parse = parse;
		}
		expect(parsedLarge).toBe(0);
	});
});

describe("9: the body deadline is cleared when reading the body fails", () => {
	test("a client that closes mid-body leaves no deadline timer behind", async () => {
		const bodyTimeoutMs = 4321;
		const r = relay({ bodyTimeoutMs });
		const realSet = globalThis.setTimeout;
		const realClear = globalThis.clearTimeout;
		const deadlines = new Set<unknown>();
		globalThis.setTimeout = ((
			fn: () => void,
			ms?: number,
			...rest: never[]
		) => {
			const timer = realSet(fn, ms, ...rest);
			if (ms === bodyTimeoutMs) deadlines.add(timer);
			return timer;
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((timer?: Timer) => {
			deadlines.delete(timer);
			realClear(timer);
		}) as typeof clearTimeout;
		try {
			const address = new URL(r.relay.addressFor(newSecret()));
			const socket = await Bun.connect({
				hostname: "127.0.0.1",
				port: r.relay.port,
				socket: { data: () => {} },
			});
			socket.write(
				`POST ${address.pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"jsonrpc":`,
			);
			await waitFor(() => deadlines.size > 0, "the body deadline");
			socket.end();
			await waitFor(
				() => r.logs.events("mcp.request").length > 0,
				"the request log line",
			);
			expect(r.logs.events("mcp.request")[0]?.["status"]).toBe(400);
			expect(deadlines.size).toBe(0);
		} finally {
			globalThis.setTimeout = realSet;
			globalThis.clearTimeout = realClear;
		}
	});
});
