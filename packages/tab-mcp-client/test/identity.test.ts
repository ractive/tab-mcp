/**
 * The library's side of identity binding against a scripted relay: which
 * answers count, and what happens when none comes (review of PR #13).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { TabMcp } from "../src/tab-mcp.ts";
import { newTab, nextEvent, setTiming } from "./helpers.ts";
import { StubRelay } from "./stub-relay.ts";

let relay: StubRelay;
let tab: TabMcp | undefined;
let restore: () => void;

beforeEach(() => {
	restore = setTiming({ answerTimeoutMs: 100 });
	relay = new StubRelay();
	relay.pairing = "oidc";
});
afterEach(async () => {
	restore();
	tab?.disconnect();
	tab = undefined;
	await relay.stop();
});

test("an answer to an assertion sent before signOut() is ignored", async () => {
	tab = newTab(relay.url, { identityAssertion: () => "a.b.c" });
	await tab.connect({ resume: true });
	const sent = await relay.next("identity");
	expect(tab.identity).toBe("pending");
	const out = tab.signOut();
	await relay.next("identity.logout");
	await out; // no grants to remove
	relay.send({ type: "identity.bound", round: sent["round"] }); // the answer to the old assertion
	await relay.settled();
	expect(tab.identity).toBe("none");
});

test("only the answer to the newest assertion counts", async () => {
	let n = 0;
	tab = newTab(relay.url, { identityAssertion: () => `a.b.${++n}` });
	await tab.connect({ resume: true });
	const first = await relay.next("identity", (m) => m["assertion"] === "a.b.1");
	const second = tab.refreshIdentity();
	const latest = await relay.next(
		"identity",
		(m) => m["assertion"] === "a.b.2",
	);
	// The first one was refused; the second is still being checked.
	relay.send({
		type: "error",
		code: "identity_refused",
		message: "old",
		round: first["round"],
	});
	await relay.settled();
	expect(tab.identity).toBe("pending");
	relay.send({ type: "identity.bound", round: latest["round"] });
	expect(await second).toBe("bound");
	expect(tab.identity).toBe("bound");
});

test("refreshIdentity() gives up when the relay never answers", async () => {
	tab = newTab(relay.url, {
		identityAssertion: () => "a.b.c",
	});
	await tab.connect({ resume: true });
	const first = await relay.next("identity");
	const refreshed = tab.refreshIdentity();
	const second = await relay.next("identity");
	expect(await refreshed).toBe("none");
	expect(tab.identity).toBe("none");
	// A late answer of a given-up round is dropped.
	relay.send({ type: "identity.bound", round: first["round"] });
	relay.send({ type: "identity.bound", round: second["round"] });
	await relay.settled();
	expect(tab.identity).toBe("none");
});

test("after a lost answer, the next assertion still binds (review of PR #13)", async () => {
	tab = newTab(relay.url, {
		identityAssertion: () => "a.b.c",
	});
	await tab.connect({ resume: true });
	await relay.next("identity"); // its answer is lost
	if (tab.identity !== "none") await nextEvent(tab, "identitychange");
	expect(tab.identity).toBe("none");
	const again = tab.refreshIdentity();
	const sent = await relay.next("identity");
	expect(typeof sent["round"]).toBe("number");
	relay.send({ type: "identity.bound", round: sent["round"] });
	expect(await again).toBe("bound");
	expect(tab.identity).toBe("bound");
});

test("an answer without the newest round never counts", async () => {
	tab = newTab(relay.url, {
		identityAssertion: () => "a.b.c",
	});
	await tab.connect({ resume: true });
	await relay.next("identity");
	relay.send({ type: "identity.bound" });
	await relay.settled();
	expect(tab.identity).toBe("pending");
});

test("the timeout also covers an identityAssertion that never settles (iteration 13)", async () => {
	tab = newTab(relay.url, {
		identityAssertion: () => new Promise<string>(() => {}),
	});
	const gaveUp = new Promise<void>((resolve) =>
		tab?.addEventListener("identitychange", (e) => {
			if (e.detail.identity === "none") resolve();
		}),
	);
	await tab.connect({ resume: true });
	expect(tab.identity).toBe("pending");
	await gaveUp;
	expect(tab.identity).toBe("none");
	expect(relay.received.filter((m) => m.type === "identity")).toEqual([]);
});

const GRANT = {
	grantId: "g_1",
	client: { id: "https://claude.ai/c.json", name: "Claude", host: "claude.ai" },
	createdAt: "2026-10-19T20:00:00.000Z",
};

test("signOut() settles: on the grants' removal, on store_unavailable, or after the answer wait (CU 10)", async () => {
	relay.grants = [GRANT];
	tab = newTab(relay.url, { identityAssertion: () => "a.b.c" });
	const t = tab;
	await t.connect({ resume: true });
	await relay.next("identity");
	// The relay removes the grants: resolves.
	const done = t.signOut();
	await relay.next("identity.logout");
	relay.send({ type: "grant.removed", grantId: "g_1", reason: "revoked" });
	await done;
	expect(t.grants).toEqual([]);
	// Grants again (a later pairing), and the relay's store fails: rejects with it.
	relay.send({ type: "grant.added", grant: GRANT });
	await relay.settled();
	const failed = t.signOut();
	await relay.next("identity.logout");
	// An error about something else does not settle it.
	relay.send({ type: "error", code: "bad_message", message: "other" });
	relay.send({
		type: "error",
		code: "store_unavailable",
		message: "the relay cannot change grants right now; try again shortly",
	});
	const error = await failed.then(
		() => undefined,
		(e: unknown) => e as Error & { code?: string },
	);
	expect(error?.code).toBe("store_unavailable");
	// No answer at all (100 ms here, 15 s for pages): a TimeoutError.
	const silent = t.signOut();
	await relay.next("identity.logout");
	await expect(silent).rejects.toMatchObject({ name: "TimeoutError" });
});

test("refreshIdentity() without the hook is a TypeError, not 'not connected'", async () => {
	tab = newTab(relay.url);
	await tab.connect({ resume: true });
	await expect(tab.refreshIdentity()).rejects.toThrow(
		new TypeError("TabMcp: no identityAssertion"),
	);
});
