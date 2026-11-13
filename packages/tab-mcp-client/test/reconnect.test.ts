/**
 * Reconnecting by itself (iteration 9): after a broken connection the tab
 * connects again with growing waits, at once on `online` or when the tab is
 * visible again, and never after the user or the relay ended it on purpose.
 */
import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import type { TabMcp } from "../src/tab-mcp.ts";
import type { TabMcpOptions } from "../src/types.ts";
import {
	connectClient,
	newTab,
	nextEnd,
	nextEvent,
	nextState,
	setTiming,
	startRelay,
	tokenFor,
} from "./helpers.ts";
import { StubRelay } from "./stub-relay.ts";

let relay: StubRelay;
let tab: TabMcp | undefined;
let restore: (() => void) | undefined;

beforeEach(() => {
	relay = new StubRelay();
});
afterEach(async () => {
	restore?.();
	restore = undefined;
	jest.useRealTimers();
	tab?.disconnect();
	tab = undefined;
	await relay.stop();
});

/** The waits before each attempt (`timing`, CU 17) until the test ends. */
function waits(delays: number[]): void {
	restore?.();
	restore = setTiming({ reconnectDelaysMs: delays });
}

async function connected(
	delays?: number[],
	options: Partial<TabMcpOptions> = {},
) {
	if (delays !== undefined) waits(delays);
	tab = newTab(relay.url, options);
	await tab.connect({ resume: true });
	await relay.next("hello");
	return tab;
}

/**
 * Each reconnect attempt announced (a `statechange` to `reconnecting`, by
 * its number) and `null` when reconnecting ended.
 */
function record(t: TabMcp): (number | null)[] {
	const seen: (number | null)[] = [];
	let was = false;
	t.addEventListener("statechange", (e) => {
		if (e.detail.state === "reconnecting")
			seen.push(t.reconnecting?.attempt ?? -1);
		else if (was) seen.push(null);
		was = e.detail.state === "reconnecting";
	});
	return seen;
}

test("after the relay shut down, the tab connects again by itself", async () => {
	const t = await connected([20]);
	const seen = record(t);
	const gone = nextEnd(t);
	relay.close(4004, "shutdown");
	expect(await gone).toEqual({ state: "reconnecting", reason: "shutdown" });
	expect(t.reconnecting).toMatchObject({ reason: "shutdown", attempt: 1 });
	await nextState(t, "connected");
	await relay.next("hello");
	expect(t.state).toBe("connected");
	expect(t.reconnecting).toBeUndefined();
	expect(seen).toEqual([1, null]);
});

test("the state stays reconnecting through an attempt (CU 10)", async () => {
	const t = await connected([20]);
	const states: string[] = [];
	t.addEventListener("statechange", (e) => states.push(e.detail.state));
	relay.answerHello = false;
	relay.close(4004);
	await relay.next("hello"); // the first attempt is running
	expect(t.state).toBe("reconnecting");
	relay.close(4004); // it fails: the second is scheduled
	await relay.next("hello");
	relay.answerHello = true;
	relay.close(4004);
	await nextState(t, "connected");
	expect(states).toEqual([
		"reconnecting",
		"reconnecting",
		"reconnecting",
		"connected",
	]);
});

test("the waits grow: 5, 10, 20, 40 s, then every 60 s", async () => {
	const t = await connected();
	const delays: number[] = [];
	let failed = Promise.withResolvers<void>();
	t.addEventListener("statechange", (e) => {
		if (e.detail.state !== "reconnecting") return;
		delays.push((t.reconnecting?.at ?? 0) - Date.now());
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
	// Each within 20 % of its step (CC 11).
	const steps = [5, 10, 20, 40, 60, 60, 60];
	expect(delays).toHaveLength(steps.length);
	delays.forEach((d, i) => {
		const step = (steps[i] ?? 0) * 1000;
		expect(d).toBeGreaterThanOrEqual(step * 0.8 - 5);
		expect(d).toBeLessThanOrEqual(step * 1.2 + 5);
	});
	expect(t.reconnecting).toMatchObject({ reason: "heartbeat", attempt: 7 });
	// The relay is back: the next attempt connects and starts over.
	relay.refuse = false;
	jest.advanceTimersByTime(delays.at(-1) ?? 0);
	jest.useRealTimers();
	await nextState(t, "connected");
	expect(t.reconnecting).toBeUndefined();
});

test("the network coming back connects at once", async () => {
	const t = await connected([600_000]);
	relay.close(4004);
	await nextState(t, "reconnecting");
	globalThis.dispatchEvent(new Event("online"));
	await relay.next("hello");
	await nextState(t, "connected");
});

test("the tab coming back to the front connects at once", async () => {
	const doc = Object.assign(new EventTarget(), {
		visibilityState: "hidden",
	});
	const g = globalThis as { document?: unknown };
	g.document = doc;
	try {
		const t = await connected([600_000]);
		relay.close(4004);
		await nextState(t, "reconnecting");
		doc.dispatchEvent(new Event("visibilitychange")); // still hidden
		await Bun.sleep(30);
		expect(relay.received.filter((m) => m.type === "hello")).toEqual([]);
		doc.visibilityState = "visible";
		doc.dispatchEvent(new Event("visibilitychange"));
		await relay.next("hello");
		await nextState(t, "connected");
	} finally {
		delete g.document;
	}
});

test("connect() while waiting makes the attempt now", async () => {
	const t = await connected([600_000]);
	relay.close(4004);
	await nextState(t, "reconnecting");
	const session = await t.connect(); // no user activation in Bun: allowed while reconnecting
	expect(t.session).toBe(session);
	expect(t.reconnecting).toBeUndefined();
});

test("disconnect() stops reconnecting", async () => {
	const t = await connected([30]);
	const seen = record(t);
	jest.useFakeTimers(); // the attempt's timer is a fake one
	relay.close(4004);
	await nextState(t, "reconnecting");
	const off = nextState(t, "disconnected");
	t.disconnect();
	expect(t.reconnecting).toBeUndefined();
	expect(seen).toEqual([1, null]);
	// The page turned it off: the reason says so also from reconnecting.
	expect(await off).toEqual({ state: "disconnected", reason: "user" });
	jest.advanceTimersByTime(60_000); // an attempt would start connecting now
	expect(t.state).toBe("disconnected");
});

test("no reconnecting after replaced, expired, idle, a refusal, or with reconnect: false", async () => {
	for (const code of [4005, 4001, 4002, 1008]) {
		const t = await connected([10]);
		const seen = record(t);
		const gone = nextEnd(t);
		relay.close(code);
		expect((await gone).state).toBe("disconnected");
		expect(seen).toEqual([]);
		expect(t.reconnecting).toBeUndefined();
		t.disconnect();
	}
	const t = await connected(undefined, { reconnect: false });
	const seen = record(t);
	relay.close(4004);
	expect(await nextEnd(t)).toEqual({
		state: "disconnected",
		reason: "shutdown",
	});
	expect(seen).toEqual([]);
	expect(t.reconnecting).toBeUndefined();
});

test("a page that connects in its own listener of the end makes the first attempt, once", async () => {
	const t = await connected([600_000]);
	t.addEventListener("statechange", (e) => {
		if (e.detail.reason !== undefined)
			t.connect({ resume: true }).catch(() => {});
	});
	relay.close(4004);
	await nextState(t, "connected");
	await relay.next("hello");
	await Bun.sleep(30);
	expect(relay.received.filter((m) => m.type === "hello")).toEqual([]);
	expect(t.reconnecting).toBeUndefined();
});

test("reconnecting asks for the identity again and resumes pairing", async () => {
	relay.pairing = "oidc";
	let asked = 0;
	const t = await connected([10], {
		identityAssertion: () => `a.b.${++asked}`,
	});
	const first = await relay.next("identity");
	relay.send({ type: "identity.bound", round: first["round"] });
	t.startPairing();
	await relay.next("pairing.start");
	await nextEvent(t, "identitychange");
	expect(t.identity).toBe("bound");

	relay.close(4003);
	await nextState(t, "connected");
	expect(t.identity).toBe("pending");
	await relay.next("pairing.start");
	const again = await relay.next("identity");
	expect(again["assertion"]).toBe("a.b.2");
	relay.send({ type: "identity.bound", round: again["round"] });
	await nextEvent(t, "identitychange");
	expect(t.identity).toBe("bound");
});

test("newAddress() while waiting connects with the new address", async () => {
	waits([600_000]);
	const t = newTab(relay.url);
	tab = t;
	await t.connect({ resume: true });
	const before = await relay.next("hello");
	relay.close(4004);
	await nextState(t, "reconnecting");
	await t.newAddress();
	expect(t.state).toBe("connected");
	expect(t.reconnecting).toBeUndefined();
	// The old address is taken back first (DEC-136).
	expect(await relay.next("hello")).toMatchObject({
		secret: before["secret"],
		revokeAll: true,
	});
	const after = await relay.next("hello");
	expect(after["secret"]).not.toBe(before["secret"]);
});

test("a restarted relay: the tab is back on the same address, and the AI app's tools work again", async () => {
	const first = startRelay();
	const port = first.relay.port;
	waits([50]);
	const t = newTab(first.url);
	tab = t;
	await t.registerTool({
		name: "ping",
		description: "Ping",
		execute: () => "pong",
	});
	const before = await t.connect({ resume: true });
	const back = nextState(t, "connected");
	await first.stop(); // bye shutdown, close 4004
	expect(t.reconnecting?.reason).toBe("shutdown");
	const second = startRelay({ port });
	try {
		await back;
		const after = t.session?.address ?? "";
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

test("disconnect() in the page's own listener of the end: no attempt (review of PR #20)", async () => {
	const t = await connected([10]);
	const seen = record(t);
	t.addEventListener(
		"statechange",
		(e) => {
			if (e.detail.reason !== undefined) t.disconnect();
		},
		{ once: true },
	);
	relay.close(4004);
	await nextState(t, "disconnected");
	await Bun.sleep(60);
	expect(seen).toEqual([1, null]);
	expect(t.reconnecting).toBeUndefined();
	expect(relay.received.filter((m) => m.type === "hello")).toEqual([]);
});

test("a relay that refuses the reconnect attempt stops reconnecting (review of PR #20)", async () => {
	const t = await connected([10]);
	const seen = record(t);
	relay.answerHello = false;
	relay.close(4004);
	await relay.next("hello"); // the first attempt
	const stopped = nextState(t, "disconnected");
	relay.send({
		type: "error",
		code: "origin_not_allowed",
		message: "This origin is not allowed",
	});
	expect(await stopped).toEqual({ state: "disconnected" });
	expect(t.reconnecting).toBeUndefined();
	await Bun.sleep(60);
	expect(relay.received.filter((m) => m.type === "hello")).toEqual([]);
	expect(seen).toEqual([1, null]);
});

test("a refused attempt of its own says why with error, just before the state is disconnected", async () => {
	const t = await connected([10]);
	const events: string[] = [];
	t.addEventListener("error", (e) =>
		events.push(`error: ${e.detail.error.message}`),
	);
	t.addEventListener("statechange", (e) => events.push(e.detail.state));
	relay.answerHello = false;
	relay.close(4004);
	await relay.next("hello");
	const stopped = nextState(t, "disconnected");
	relay.send({
		type: "error",
		code: "origin_not_allowed",
		message: "This origin is not allowed",
	});
	await stopped;
	expect(events.slice(-2)).toEqual([
		"error: The relay refused the connection: This origin is not allowed",
		"disconnected",
	]);
});

test("a refused connect() while reconnecting rejects its promise, and error says why it stopped (CC 10)", async () => {
	const t = await connected([60_000]);
	const errors: string[] = [];
	t.addEventListener("error", (e) => errors.push(e.detail.error.message));
	relay.answerHello = false;
	relay.close(4004);
	await nextState(t, "reconnecting");
	const attempt = t.connect({ resume: true });
	await relay.next("hello");
	relay.send({
		type: "error",
		code: "origin_not_allowed",
		message: "This origin is not allowed",
	});
	await expect(attempt).rejects.toThrow("This origin is not allowed");
	expect(t.reconnecting).toBeUndefined();
	expect(t.state).toBe("disconnected");
	expect(errors).toEqual([
		"The relay refused the connection: This origin is not allowed",
	]);
});

test("a relay that ends the attempt with 1008 stops reconnecting; 4004 retries", async () => {
	const t = await connected([10]);
	relay.answerHello = false;
	relay.close(4004);
	await relay.next("hello");
	relay.close(4004); // shutting down again while opening: retried
	await relay.next("hello");
	expect(t.reconnecting?.attempt).toBe(2);
	const stopped = nextState(t, "disconnected");
	relay.close(1008, "policy");
	await stopped;
	expect(t.reconnecting).toBeUndefined();
});

test("a connect() that joins the attempt the library started: its promise rejects, and error says why (CC 10)", async () => {
	const t = await connected([10]);
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
	expect(errors).toEqual([
		"The relay refused the connection: This origin is not allowed",
	]);
});

test("a connect() from a statechange listener after a failed attempt does not stop reconnecting (CC 10)", async () => {
	const t = await connected([10]);
	relay.answerHello = false;
	relay.close(4004);
	await relay.next("hello"); // the first attempt
	let joined = false;
	t.addEventListener("statechange", () => {
		if ((t.reconnecting?.attempt ?? 0) < 2 || joined) return;
		joined = true;
		t.connect({ resume: true }).catch(() => {});
	});
	relay.close(4004); // the first attempt fails; the listener starts the next
	await relay.next("hello");
	await Bun.sleep(40); // a timer of the failed attempt would fire meanwhile
	relay.answerHello = true;
	relay.close(4004); // the listener's attempt fails too
	await nextState(t, "connected"); // and reconnecting goes on
	expect(t.reconnecting).toBeUndefined();
});

test("the waits vary by up to 20 % (CC 11)", async () => {
	const random = spyOn(Math, "random");
	try {
		for (const [r, factor] of [
			[0, 0.8],
			[0.5, 1],
			[0.999_999, 1.2],
		] as const) {
			random.mockReturnValue(r);
			const t = await connected([600_000]);
			relay.close(4004);
			await nextState(t, "reconnecting");
			const at = t.reconnecting?.at ?? 0;
			expect(at - Date.now()).toBeGreaterThan(600_000 * factor - 50);
			expect(at - Date.now()).toBeLessThanOrEqual(600_000 * factor);
			t.disconnect();
		}
	} finally {
		random.mockRestore();
	}
});

test("when error says why it stopped, reconnecting is over already: connect() from the listener starts afresh", async () => {
	const t = await connected([10]);
	const seen: { reconnecting: unknown; state: string }[] = [];
	t.addEventListener("error", () =>
		seen.push({ reconnecting: t.reconnecting, state: t.state }),
	);
	relay.answerHello = false;
	relay.close(4004);
	await relay.next("hello");
	const stopped = nextState(t, "disconnected");
	relay.send({
		type: "error",
		code: "origin_not_allowed",
		message: "This origin is not allowed",
	});
	await stopped;
	expect(seen).toEqual([{ reconnecting: undefined, state: "disconnected" }]);
});

test("connect() from the listener of the error that stopped it: connecting, no statechange to disconnected after it", async () => {
	const t = await connected([10]);
	const states: string[] = [];
	relay.answerHello = false;
	relay.close(4004);
	await relay.next("hello");
	t.addEventListener("statechange", (e) => states.push(e.detail.state));
	t.addEventListener(
		"error",
		() => {
			relay.answerHello = true;
			t.connect({ resume: true }).catch(() => {});
		},
		{ once: true },
	);
	relay.send({
		type: "error",
		code: "origin_not_allowed",
		message: "This origin is not allowed",
	});
	await nextState(t, "connected");
	expect(states).toEqual(["connecting", "connected"]);
});
