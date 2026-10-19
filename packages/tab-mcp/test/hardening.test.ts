/**
 * Hardening tests from the review of PR #1: each block pins one finding.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
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
