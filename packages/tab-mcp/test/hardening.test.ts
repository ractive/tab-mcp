/**
 * Hardening tests from the review of PR #1: each block pins one finding.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { newSecret } from "../src/address.ts";
import { parseTabMessage } from "../src/protocol.ts";
import type { CreateRelayOptions } from "../src/relay.ts";
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
