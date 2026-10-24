/**
 * Reconnecting by itself (iteration 9): after a broken connection the tab
 * connects again with growing waits, at once on `online` or when the tab is
 * visible again, and never after the user or the relay ended it on purpose.
 */
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import type { TabMcp } from "../src/tab-mcp.ts";
import type { ReconnectingInfo, TabMcpOptions } from "../src/types.ts";
import {
	connectClient,
	newTab,
	nextEvent,
	startRelay,
	tokenFor,
} from "./helpers.ts";
import { StubRelay } from "./stub-relay.ts";

let relay: StubRelay;
let tab: TabMcp | undefined;

beforeEach(() => {
	relay = new StubRelay();
});
afterEach(async () => {
	jest.useRealTimers();
	tab?.disconnect();
	tab = undefined;
	await relay.stop();
});

async function connected(options: Partial<TabMcpOptions> = {}) {
	tab = newTab(relay.url, options);
	await tab.connect({ resume: true });
	await relay.next("hello");
	return tab;
}

/** Every `reconnecting` event of `t`. */
function record(t: TabMcp): (ReconnectingInfo | null)[] {
	const seen: (ReconnectingInfo | null)[] = [];
	t.addEventListener("reconnecting", (e) => seen.push(e.detail));
	return seen;
}

test("after the relay shut down, the tab connects again by itself", async () => {
	const t = await connected({ reconnect: { delaysMs: [20] } });
	const seen = record(t);
	const disconnected = nextEvent(t, "disconnected");
	relay.close(4004, "shutdown");
	expect((await disconnected).detail).toEqual({
		reason: "shutdown",
		code: 4004,
	});
	expect(t.reconnecting).toMatchObject({ reason: "shutdown", attempt: 1 });
	await nextEvent(t, "connected");
	await relay.next("hello");
	expect(t.state).toBe("connected");
	expect(t.reconnecting).toBeUndefined();
	expect(seen.map((s) => s?.attempt ?? null)).toEqual([1, null]);
});

test("the waits grow: 5, 10, 20, 40 s, then every 60 s", async () => {
	const t = await connected();
	const delays: number[] = [];
	let failed = Promise.withResolvers<void>();
	t.addEventListener("reconnecting", (e) => {
		if (e.detail === null) return;
		delays.push(e.detail.at - Date.now());
		failed.resolve();
	});
	relay.refuse = true;
	jest.useFakeTimers();
	relay.close(4003, "heartbeat");
	for (let i = 0; i < 6; i++) {
		await failed.promise;
		failed = Promise.withResolvers<void>();
		const wait = delays.at(-1) ?? 0;
		jest.advanceTimersByTime(wait); // the attempt starts and is refused
	}
	await failed.promise;
	expect(delays.map((d) => Math.round(d / 1000))).toEqual([
		5, 10, 20, 40, 60, 60, 60,
	]);
	expect(t.reconnecting).toMatchObject({ reason: "heartbeat", attempt: 7 });
	// The relay is back: the next attempt connects and starts over.
	relay.refuse = false;
	jest.advanceTimersByTime(60_000);
	jest.useRealTimers();
	await nextEvent(t, "connected");
	expect(t.reconnecting).toBeUndefined();
});

test("the network coming back connects at once", async () => {
	const t = await connected({ reconnect: { delaysMs: [600_000] } });
	relay.close(4004);
	await nextEvent(t, "reconnecting");
	globalThis.dispatchEvent(new Event("online"));
	await relay.next("hello");
	await nextEvent(t, "connected");
});

test("the tab coming back to the front connects at once", async () => {
	const doc = Object.assign(new EventTarget(), {
		visibilityState: "hidden",
	});
	const g = globalThis as { document?: unknown };
	g.document = doc;
	try {
		const t = await connected({ reconnect: { delaysMs: [600_000] } });
		relay.close(4004);
		await nextEvent(t, "reconnecting");
		doc.dispatchEvent(new Event("visibilitychange")); // still hidden
		await Bun.sleep(30);
		expect(relay.received.filter((m) => m.type === "hello")).toEqual([]);
		doc.visibilityState = "visible";
		doc.dispatchEvent(new Event("visibilitychange"));
		await relay.next("hello");
		await nextEvent(t, "connected");
	} finally {
		delete g.document;
	}
});

test("connect() while waiting makes the attempt now", async () => {
	const t = await connected({ reconnect: { delaysMs: [600_000] } });
	relay.close(4004);
	await nextEvent(t, "reconnecting");
	const session = await t.connect(); // no user activation in Bun: allowed while reconnecting
	expect(session.address).toBe(t.address as string);
	expect(t.reconnecting).toBeUndefined();
});

test("disconnect() stops reconnecting", async () => {
	const t = await connected({ reconnect: { delaysMs: [30] } });
	const seen = record(t);
	jest.useFakeTimers(); // the attempt's timer is a fake one
	relay.close(4004);
	await nextEvent(t, "reconnecting");
	t.disconnect();
	expect(t.reconnecting).toBeUndefined();
	expect(seen).toEqual([expect.objectContaining({ attempt: 1 }), null]);
	jest.advanceTimersByTime(60_000); // an attempt would start connecting now
	expect(t.state).toBe("disconnected");
});

test("no reconnecting after replaced, expired, idle, a refusal, or with reconnect: false", async () => {
	for (const code of [4005, 4001, 4002, 1008]) {
		const t = await connected({ reconnect: { delaysMs: [10] } });
		const seen = record(t);
		const gone = nextEvent(t, "disconnected");
		relay.close(code);
		await gone;
		// A reconnect is scheduled (and announced) before the event resolves this.
		expect(seen).toEqual([]);
		expect(t.reconnecting).toBeUndefined();
		expect(t.state).toBe("disconnected");
		t.disconnect();
	}
	const t = await connected({ reconnect: false });
	const seen = record(t);
	relay.close(4004);
	await nextEvent(t, "disconnected");
	expect(seen).toEqual([]);
	expect(t.reconnecting).toBeUndefined();
});

test("a page that reconnects in its own disconnected listener is not doubled", async () => {
	const t = await connected({ reconnect: { delaysMs: [10] } });
	const seen = record(t);
	t.addEventListener("disconnected", () => {
		t.connect({ resume: true }).catch(() => {});
	});
	relay.close(4004);
	await nextEvent(t, "connected");
	expect(seen).toEqual([]);
});

test("reconnecting asks for the identity again and resumes pairing", async () => {
	relay.pairing = "oidc";
	let asked = 0;
	const t = await connected({
		reconnect: { delaysMs: [10] },
		identityAssertion: () => `a.b.${++asked}`,
	});
	const first = await relay.next("identity");
	relay.send({ type: "identity.bound", round: first["round"] });
	t.startPairing();
	await relay.next("pairing.start");
	await nextEvent(t, "identitychange");
	expect(t.identity).toBe("bound");

	relay.close(4003);
	await nextEvent(t, "connected");
	expect(t.identity).toBe("pending");
	await relay.next("pairing.start");
	const again = await relay.next("identity");
	expect(again["assertion"]).toBe("a.b.2");
	relay.send({ type: "identity.bound", round: again["round"] });
	await nextEvent(t, "identitychange");
	expect(t.identity).toBe("bound");
});

test("newAddress() while waiting connects with the new address", async () => {
	const t = newTab(relay.url, { reconnect: { delaysMs: [600_000] } });
	tab = t;
	await t.connect({ resume: true });
	const before = await relay.next("hello");
	relay.close(4004);
	await nextEvent(t, "reconnecting");
	const session = await t.newAddress();
	expect(session).toBeDefined();
	expect(t.reconnecting).toBeUndefined();
	const after = await relay.next("hello");
	expect(after["secret"]).not.toBe(before["secret"]);
});

test("invalid reconnect waits are refused", () => {
	expect(() => newTab(relay.url, { reconnect: { delaysMs: [] } })).toThrow(
		TypeError,
	);
	expect(() => newTab(relay.url, { reconnect: { delaysMs: [-1] } })).toThrow(
		TypeError,
	);
});

test("a restarted relay: the tab is back on the same address, and the AI app's tools work again", async () => {
	const first = startRelay();
	const port = first.relay.port;
	const t = newTab(first.url, { reconnect: { delaysMs: [50] } });
	tab = t;
	await t.registerTool({
		name: "ping",
		description: "Ping",
		execute: () => "pong",
	});
	const before = await t.connect({ resume: true });
	const back = new Promise<string>((resolve) =>
		t.addEventListener("connected", (e) => resolve(e.detail.address), {
			once: true,
		}),
	);
	await first.stop(); // bye shutdown, close 4004
	expect(t.reconnecting?.reason).toBe("shutdown");
	const second = startRelay({ port });
	try {
		const after = await back;
		expect(after).toBe(before.address);
		const client = await connectClient(
			after,
			await tokenFor(second.store, after),
		);
		const result = await client.callTool({ name: "ping", arguments: {} });
		expect(result.content).toEqual([{ type: "text", text: "pong" }]);
		await client.close();
	} finally {
		t.disconnect();
		await second.stop();
	}
});

test("disconnect() in the page's own disconnected listener: no reconnecting (review of PR #20)", async () => {
	const t = await connected({ reconnect: { delaysMs: [10] } });
	const seen = record(t);
	t.addEventListener("disconnected", () => t.disconnect(), { once: true });
	const gone = nextEvent(t, "disconnected");
	relay.close(4004);
	await gone;
	await Bun.sleep(60);
	expect(seen).toEqual([]);
	expect(t.reconnecting).toBeUndefined();
	expect(relay.received.filter((m) => m.type === "hello")).toEqual([]);
});

test("a relay that refuses the reconnect attempt stops reconnecting (review of PR #20)", async () => {
	const t = await connected({ reconnect: { delaysMs: [10] } });
	const seen = record(t);
	relay.answerHello = false;
	relay.close(4004);
	await relay.next("hello"); // the first attempt
	const stopped = new Promise<void>((resolve) =>
		t.addEventListener("reconnecting", (e) => {
			if (e.detail === null) resolve();
		}),
	);
	relay.send({
		type: "error",
		code: "origin_not_allowed",
		message: "This origin is not allowed",
	});
	await stopped;
	expect(t.reconnecting).toBeUndefined();
	expect(t.state).toBe("disconnected");
	await Bun.sleep(60);
	expect(relay.received.filter((m) => m.type === "hello")).toEqual([]);
	expect(seen.map((s) => s?.attempt ?? null)).toEqual([1, null]);
});

test("a refused attempt of its own says why with error, just before reconnecting turns null", async () => {
	const t = await connected({ reconnect: { delaysMs: [10] } });
	const events: string[] = [];
	t.addEventListener("error", (e) =>
		events.push(`error: ${e.detail.error.message}`),
	);
	t.addEventListener("reconnecting", (e) =>
		events.push(e.detail === null ? "null" : "waiting"),
	);
	relay.answerHello = false;
	relay.close(4004);
	await relay.next("hello");
	const stopped = new Promise<void>((resolve) =>
		t.addEventListener("reconnecting", (e) => {
			if (e.detail === null) resolve();
		}),
	);
	relay.send({
		type: "error",
		code: "origin_not_allowed",
		message: "This origin is not allowed",
	});
	await stopped;
	expect(events.slice(-2)).toEqual([
		"error: The relay refused the connection: This origin is not allowed",
		"null",
	]);
});

test("a refused connect() while reconnecting rejects its promise and emits no error", async () => {
	const t = await connected({ reconnect: { delaysMs: [60_000] } });
	const errors: string[] = [];
	t.addEventListener("error", (e) => errors.push(e.detail.error.message));
	relay.answerHello = false;
	relay.close(4004);
	await nextEvent(t, "reconnecting");
	const attempt = t.connect({ resume: true });
	await relay.next("hello");
	relay.send({
		type: "error",
		code: "origin_not_allowed",
		message: "This origin is not allowed",
	});
	await expect(attempt).rejects.toThrow("This origin is not allowed");
	expect(t.reconnecting).toBeUndefined();
	expect(errors).toEqual([]);
});

test("a relay that ends the attempt with 1008 stops reconnecting; 4004 retries", async () => {
	const t = await connected({ reconnect: { delaysMs: [10] } });
	relay.answerHello = false;
	relay.close(4004);
	await relay.next("hello");
	relay.close(4004); // shutting down again while opening: retried
	await relay.next("hello");
	expect(t.reconnecting?.attempt).toBe(2);
	const stopped = new Promise<void>((resolve) =>
		t.addEventListener("reconnecting", (e) => {
			if (e.detail === null) resolve();
		}),
	);
	relay.close(1008, "policy");
	await stopped;
	expect(t.reconnecting).toBeUndefined();
});

test("a connect() that joins the attempt the library started is told by its promise only", async () => {
	const t = await connected({ reconnect: { delaysMs: [10] } });
	const errors: string[] = [];
	t.addEventListener("error", (e) => errors.push(e.detail.error.message));
	relay.answerHello = false;
	relay.close(4004);
	await relay.next("hello"); // the timer's attempt is running
	const joined = t.connect({ resume: true });
	relay.send({
		type: "error",
		code: "origin_not_allowed",
		message: "This origin is not allowed",
	});
	await expect(joined).rejects.toThrow("This origin is not allowed");
	expect(t.reconnecting).toBeUndefined();
	expect(errors).toEqual([]);
});

test("when error says why it stopped, reconnecting is over already: connect() from the listener starts afresh", async () => {
	const t = await connected({ reconnect: { delaysMs: [10] } });
	const seen: { reconnecting: unknown; state: string }[] = [];
	t.addEventListener("error", () =>
		seen.push({ reconnecting: t.reconnecting, state: t.state }),
	);
	relay.answerHello = false;
	relay.close(4004);
	await relay.next("hello");
	const stopped = new Promise<void>((resolve) =>
		t.addEventListener("reconnecting", (e) => {
			if (e.detail === null) resolve();
		}),
	);
	relay.send({
		type: "error",
		code: "origin_not_allowed",
		message: "This origin is not allowed",
	});
	await stopped;
	expect(seen).toEqual([{ reconnecting: undefined, state: "disconnected" }]);
});
