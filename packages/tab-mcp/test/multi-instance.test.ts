/**
 * Several relay instances behind a load balancer (DEC-098): the address id in
 * the `/tab` URL, checked against the secret in `hello`; and `/healthz`
 * checking the token store (DEC-099).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { addressIdFromSecret, newSecret } from "../src/address.ts";
import { createLogger } from "../src/log.ts";
import { createTestRelay } from "../src/relay.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import type { TokenRecord } from "../src/store/types.ts";
import {
	ORIGIN,
	ScriptedTab,
	startRelay,
	type TestRelay,
	waitFor,
} from "./helpers.ts";

const relays: TestRelay[] = [];
const tabs: ScriptedTab[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const t of tabs.splice(0)) if (t.ws.readyState <= 1) t.close();
	for (const r of relays.splice(0)) await r.stop();
	for (const stop of stops.splice(0)) await stop();
});
const quietLogger = createLogger("error", () => {});

function relay(options: Parameters<typeof startRelay>[0] = {}): TestRelay {
	const r = startRelay(options);
	relays.push(r);
	return r;
}

function tab(url: string, secret?: string): ScriptedTab {
	const t = new ScriptedTab(url, secret === undefined ? {} : { secret });
	tabs.push(t);
	return t;
}

/** A WebSocket handshake by hand, to see the answer before an upgrade. */
function handshake(r: TestRelay, query: string): Promise<Response> {
	return fetch(`${r.relay.url}/tab${query}`, {
		headers: {
			origin: ORIGIN,
			connection: "Upgrade",
			upgrade: "websocket",
			"sec-websocket-version": "13",
			"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			"sec-websocket-protocol": "tab-mcp.v1",
		},
	});
}

describe("the address id in the /tab URL", () => {
	test("a matching ?a= connects; the session is the same as without it", async () => {
		const r = relay();
		const secret = newSecret();
		const id = addressIdFromSecret(secret);
		const t = tab(`${r.wsUrl}?a=${id}`, secret);
		const session = await t.connect();
		expect(session.address).toBe(`${r.relay.url}/a/${id}/mcp`);
	});

	test("without ?a= (older libraries) the session still opens", async () => {
		const r = relay();
		const t = tab(r.wsUrl);
		const session = await t.connect();
		expect(session.address).toContain(`/a/${t.addressId}/mcp`);
	});

	test("an id that is not the secret's: error address_mismatch, close 4009, no session", async () => {
		const r = relay();
		const other = addressIdFromSecret(newSecret());
		const t = tab(`${r.wsUrl}?a=${other}`);
		await t.opened;
		t.send({
			type: "hello",
			library: { name: "scripted-tab", version: "0.0.0" },
			page: { title: "Test page" },
			secret: t.secret,
		});
		const error = await t.next("error");
		expect(error).toMatchObject({ type: "error", code: "address_mismatch" });
		// The message never echoes the secret or the derived address.
		expect(JSON.stringify(error)).not.toContain(t.secret);
		expect(JSON.stringify(error)).not.toContain(t.addressId);
		const closed = await t.closed;
		expect(closed.code).toBe(4009);
		expect(t.received.some((m) => m.type === "session")).toBe(false);
		// The address was never claimed: a correct tab of that secret is not
		// "replaced", and the address is not taken by the refused one.
		await waitFor(() => r.relay.sessionCount === 0, "the session to end");
		expect(r.logs.events("tab.refused").at(-1)).toMatchObject({
			reason: "address_mismatch",
		});
	});

	test("a mismatched tab does not replace the address's open session", async () => {
		const r = relay();
		const secret = newSecret();
		const good = tab(`${r.wsUrl}?a=${addressIdFromSecret(secret)}`, secret);
		await good.connect();
		// Same secret, the id of another address in the URL.
		const bad = tab(`${r.wsUrl}?a=${addressIdFromSecret(newSecret())}`, secret);
		await bad.opened;
		bad.send({
			type: "hello",
			library: { name: "scripted-tab", version: "0.0.0" },
			page: { title: "Test page" },
			secret,
		});
		expect((await bad.closed).code).toBe(4009);
		expect(good.ws.readyState).toBe(WebSocket.OPEN);
		expect(good.received.some((m) => m.type === "bye")).toBe(false);
	});

	test("a malformed or repeated ?a= is refused before the upgrade (400 bad_address)", async () => {
		const r = relay();
		const id = addressIdFromSecret(newSecret());
		for (const query of [
			"?a=",
			"?a=nope",
			`?a=${id.toUpperCase()}`,
			`?a=${id}&a=${id}`,
			// Percent-encoded: decodes to a valid id, but a load balancer
			// matching the literal id would route it elsewhere (review of PR 38).
			`?a=${[...id].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("")}`,
			`?a=%61${id.slice(1)}`,
			`?%61=${id}`,
			`?a=${id}&%61=${id}`,
		]) {
			const res = await handshake(r, query);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "bad_address" });
		}
		// A well-formed id upgrades (101), other parameters are ignored.
		const ok = await handshake(r, `?a=${id}&v=1`);
		expect(ok.status).toBe(101);
	});
});

/** A memory store whose `get` can fail or hang (the health probe reads). */
class FlakyStore extends MemoryTokenStore {
	mode: "ok" | "fail" | "hang" = "ok";
	gets = 0;
	override get(hash: string): Promise<TokenRecord | undefined> {
		this.gets++;
		if (this.mode === "fail") {
			return Promise.reject(
				new Error("connect postgres://admin:hunter2@db.internal failed"),
			);
		}
		if (this.mode === "hang") return new Promise(() => {});
		return super.get(hash);
	}
}

describe("/healthz checks the token store", () => {
	test("a store that answers: 200 ok", async () => {
		const store = new FlakyStore();
		const r = relay({ store });
		const res = await fetch(`${r.relay.url}/healthz`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { status: string }).status).toBe("ok");
		expect(store.gets).toBeGreaterThan(0);
	});

	test("a store that throws: 503 store_unavailable, nothing of the error in the answer", async () => {
		const store = new FlakyStore();
		store.mode = "fail";
		const r = relay({ store });
		const res = await fetch(`${r.relay.url}/healthz`);
		expect(res.status).toBe(503);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({
			status: "unhealthy",
			reason: "store_unavailable",
			version: expect.any(String),
		});
		expect(text).not.toContain("hunter2");
		expect(text).not.toContain("postgres");
		// The log names the error class only (log.ts: names, never messages).
		const logged = r.logs.events("health.store");
		expect(logged.at(-1)).toMatchObject({ error: "Error" });
		expect(JSON.stringify(logged)).not.toContain("hunter2");
	});

	test("a store that hangs: 503 store_timeout within about a second", async () => {
		const store = new FlakyStore();
		store.mode = "hang";
		const r = relay({ store });
		const started = Date.now();
		const res = await fetch(`${r.relay.url}/healthz`);
		expect(Date.now() - started).toBeLessThan(2500);
		expect(res.status).toBe(503);
		expect(((await res.json()) as { reason: string }).reason).toBe(
			"store_timeout",
		);
		// While that read still hangs, no second read is started.
		const gets = store.gets;
		await Bun.sleep(1100);
		const again = await fetch(`${r.relay.url}/healthz`);
		expect(again.status).toBe(503);
		expect(store.gets).toBe(gets);
	});

	test("probes are shared: a burst of /healthz reads the store once", async () => {
		const store = new FlakyStore();
		const r = relay({ store });
		const before = store.gets;
		const answers = await Promise.all(
			Array.from({ length: 20 }, () => fetch(`${r.relay.url}/healthz`)),
		);
		expect(answers.every((a) => a.status === 200)).toBe(true);
		expect(store.gets - before).toBe(1);
	});

	test("one read that never settles does not make the instance unhealthy for good (review of PR 38)", async () => {
		const store = new FlakyStore();
		store.mode = "hang";
		const r = createTestRelay(
			{
				development: true,
				port: 0,
				host: "127.0.0.1",
				allowedOrigins: [ORIGIN],
				store,
				logger: quietLogger,
			},
			{ healthRetryMs: 1500 },
		);
		stops.push(() => r.stop());
		expect((await fetch(`${r.url}/healthz`)).status).toBe(503);
		// The store recovers, but the first read is lost for good.
		store.mode = "ok";
		const gets = store.gets;
		await Bun.sleep(1100);
		// Still inside the retry window: no new read yet.
		expect((await fetch(`${r.url}/healthz`)).status).toBe(503);
		expect(store.gets).toBe(gets);
		await Bun.sleep(600);
		const res = await fetch(`${r.url}/healthz`);
		expect(res.status).toBe(200);
		expect(store.gets).toBe(gets + 1);
	});

	test("a store that throws synchronously: 503, and later probes run again (review of PR 38)", async () => {
		const store = new FlakyStore();
		let throwNow = true;
		const get = store.get.bind(store);
		store.get = (hash: string) => {
			if (throwNow) throw new TypeError("sync");
			return get(hash);
		};
		const r = relay({ store });
		const first = await fetch(`${r.relay.url}/healthz`);
		expect(first.status).toBe(503);
		expect(((await first.json()) as { reason: string }).reason).toBe(
			"store_unavailable",
		);
		throwNow = false;
		await Bun.sleep(1100);
		expect((await fetch(`${r.relay.url}/healthz`)).status).toBe(200);
	});
});
