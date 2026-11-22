/**
 * `/healthz` checks the token store (DEC-099): what a load balancer or an
 * uptime check reads. From multi-instance.test.ts, whose other half (the
 * address id in the `/tab` URL, DEC-098) went with the fixed address
 * (DEC-196).
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { MemoryTokenStore } from "../src/store/memory.ts";
import type { TokenRecord } from "../src/store/types.ts";
import { startRelay, type TestRelay } from "./helpers.ts";

/**
 * `run` on a clock 1.1 s on, past the second for which a probe's answer is
 * reused (`Date.now()` in the relay); the real clock is back when it ends,
 * however it ends.
 */
async function pastReuse<T>(run: () => Promise<T>): Promise<T> {
	setSystemTime(Date.now() + 1_100);
	try {
		return await run();
	} finally {
		setSystemTime();
	}
}

const relays: TestRelay[] = [];
afterEach(async () => {
	setSystemTime(); // first: whatever fails below, no moved clock stays
	for (const r of relays.splice(0)) await r.stop();
});

function relay(options: Parameters<typeof startRelay>[0] = {}): TestRelay {
	const r = startRelay(options);
	relays.push(r);
	return r;
}

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
		// Within the second the answer is reused: no second read.
		const gets = store.gets;
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
		const r = relay({ store });
		expect((await fetch(`${r.relay.url}/healthz`)).status).toBe(503);
		// The store recovers, but the first read is lost for good.
		store.mode = "ok";
		const gets = store.gets;
		// Past the reused second, on the clock the relay reads (no real wait).
		const res = await pastReuse(() => fetch(`${r.relay.url}/healthz`));
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
		const res = await pastReuse(() => fetch(`${r.relay.url}/healthz`));
		expect(res.status).toBe(200);
	});
});
