/**
 * The library's side of identity binding against a scripted relay: which
 * answers count, and what happens when none comes (review of PR #13).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { TabMcp } from "../src/tab-mcp.ts";
import { newTab } from "./helpers.ts";
import { StubRelay } from "./stub-relay.ts";

let relay: StubRelay;
let tab: TabMcp | undefined;

beforeEach(() => {
	relay = new StubRelay();
	relay.pairing = "oidc";
});
afterEach(async () => {
	tab?.disconnect();
	tab = undefined;
	await relay.stop();
});

test("an answer to an assertion sent before signOut() is ignored", async () => {
	tab = newTab(relay.url, { identityAssertion: () => "a.b.c" });
	await tab.connect({ resume: true });
	await relay.next("identity");
	expect(tab.identity).toBe("pending");
	expect(tab.signOut()).toBe(true);
	await relay.next("identity.logout");
	relay.send({ type: "identity.bound" }); // the answer to the old assertion
	await Bun.sleep(50);
	expect(tab.identity).toBe("none");
});

test("only the answer to the newest assertion counts", async () => {
	let n = 0;
	tab = newTab(relay.url, { identityAssertion: () => `a.b.${++n}` });
	await tab.connect({ resume: true });
	await relay.next("identity", (m) => m["assertion"] === "a.b.1");
	const second = tab.refreshIdentity();
	await relay.next("identity", (m) => m["assertion"] === "a.b.2");
	// The first one was refused; the second is still being checked.
	relay.send({ type: "error", code: "identity_refused", message: "old" });
	await Bun.sleep(50);
	expect(tab.identity).toBe("pending");
	relay.send({ type: "identity.bound" });
	expect(await second).toBe(true);
	expect(tab.identity).toBe("bound");
});

test("refreshIdentity() gives up when the relay never answers", async () => {
	tab = newTab(relay.url, {
		identityAssertion: () => "a.b.c",
		identityTimeoutMs: 100,
	});
	await tab.connect({ resume: true });
	await relay.next("identity");
	expect(await tab.refreshIdentity()).toBe(false);
	expect(tab.identity).toBe("none");
	// A late answer of a given-up round is dropped.
	relay.send({ type: "identity.bound" });
	relay.send({ type: "identity.bound" });
	await Bun.sleep(50);
	expect(tab.identity).toBe("none");
});
