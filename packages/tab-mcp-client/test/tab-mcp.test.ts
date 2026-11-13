/**
 * `TabMcp` itself: its options, what its getters hand out, and its connect
 * dialog (review of the browser library, iteration 13).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { TabMcp } from "../src/tab-mcp.ts";
import type { Grant } from "../src/types.ts";
import { newTab, nextState } from "./helpers.ts";
import { StubRelay } from "./stub-relay.ts";

describe("methods that ask the relay (CU 10)", () => {
	test("reject with an InvalidStateError while not connected", async () => {
		const tab = newTab("https://relay.example", {
			identityAssertion: () => "assertion",
		});
		for (const call of [() => tab.signOut(), () => tab.refreshIdentity()]) {
			const error = await call().then(
				() => undefined,
				(e: unknown) => e as DOMException,
			);
			expect(error?.name).toBe("InvalidStateError");
		}
	});

	test("revoke() of a grant the page does not list resolves at once", async () => {
		await newTab("https://relay.example").revoke("g_unknown");
	});
});

describe("with a relay", () => {
	let relay: StubRelay;
	let tab: TabMcp;
	const GRANT: Grant = {
		grantId: "g_1",
		client: {
			id: "https://claude.ai/c.json",
			name: "Claude",
			host: "claude.ai",
		},
		createdAt: "2026-10-19T20:00:00.000Z",
	};

	beforeEach(() => {
		relay = new StubRelay();
		relay.grants = [GRANT];
		tab = newTab(relay.url);
	});
	afterEach(async () => {
		tab.disconnect();
		await relay.stop();
	});

	test("grants cannot be changed through the getter", async () => {
		await tab.connect({ resume: true });
		const grants = tab.grants;
		expect(grants).toEqual([GRANT]);
		expect(Object.isFrozen(grants)).toBe(true);
		expect(() => (grants as Grant[]).push(GRANT)).toThrow();
		expect(() => {
			(grants[0] as { grantId: string }).grantId = "g_2";
		}).toThrow();
		expect(tab.grants[0]?.grantId).toBe("g_1");
		// Stable between changes, as a store snapshot needs.
		expect(tab.grants).toBe(grants);
	});

	test("revoke() resolves once the relay removed the grant (CU 10)", async () => {
		await tab.connect({ resume: true });
		let done = false;
		const revoked = tab.revoke("g_1").then(() => (done = true));
		expect((await relay.next("grant.revoke"))["grantId"]).toBe("g_1");
		await Bun.sleep(10);
		expect(done).toBe(false);
		relay.send({ type: "grant.removed", grantId: "g_1", reason: "revoked" });
		await revoked;
		expect(tab.grants).toEqual([]);
	});

	test("revoke() rejects with the relay's error, and when the session ends first", async () => {
		await tab.connect({ resume: true });
		const refused = tab.revoke("g_1");
		await relay.next("grant.revoke");
		relay.send({
			type: "error",
			code: "store_unavailable",
			message: "the relay cannot change grants right now; try again shortly",
		});
		const error = await refused.then(
			() => undefined,
			(e: unknown) => e as Error & { code?: string },
		);
		expect(error?.code).toBe("store_unavailable");
		expect(tab.grants.length).toBe(1);
		const ended = tab.revoke("g_1");
		await relay.next("grant.revoke");
		tab.disconnect();
		// Sent, but the session ended first: a NetworkError (DEC-170).
		const lost = await ended.then(
			() => undefined,
			(e: unknown) => e as DOMException,
		);
		expect(lost?.name).toBe("NetworkError");
		// Disconnected, the grant still listed: only the relay can revoke it,
		// and nothing was sent: an InvalidStateError.
		const unsent = await tab.revoke("g_1").then(
			() => undefined,
			(e: unknown) => e as DOMException,
		);
		expect(unsent?.name).toBe("InvalidStateError");
		expect(unsent?.message).toContain("not connected");
	});

	test("an error that names its grant settles only that revoke() (relay 0.10.2, DEC-168)", async () => {
		const second: Grant = { ...GRANT, grantId: "g_2" };
		relay.grants = [GRANT, second];
		await tab.connect({ resume: true });
		const first = tab.revoke("g_1");
		const other = tab.revoke("g_2");
		await relay.next("grant.revoke");
		await relay.next("grant.revoke");
		let otherSettled = false;
		void other.then(
			() => (otherSettled = true),
			() => (otherSettled = true),
		);
		relay.send({
			type: "error",
			code: "store_unavailable",
			message: "the relay cannot change grants right now; try again shortly",
			for: "grant.revoke",
			grantId: "g_1",
		});
		const error = await first.then(
			() => undefined,
			(e: unknown) => e as Error & { code?: string; grantId?: string },
		);
		expect(error).toMatchObject({ code: "store_unavailable", grantId: "g_1" });
		await Bun.sleep(10);
		expect(otherSettled).toBe(false);
		relay.send({ type: "grant.removed", grantId: "g_2", reason: "revoked" });
		await other;
		expect(tab.grants.map((g) => g.grantId)).toEqual(["g_1"]);
	});

	test("an error without for (relay 0.10.1) settles every pending revoke(), as before", async () => {
		const second: Grant = { ...GRANT, grantId: "g_2" };
		relay.grants = [GRANT, second];
		await tab.connect({ resume: true });
		const both = [tab.revoke("g_1"), tab.revoke("g_2")];
		await relay.next("grant.revoke");
		await relay.next("grant.revoke");
		relay.send({
			type: "error",
			code: "store_unavailable",
			message: "the relay cannot change grants right now; try again shortly",
		});
		const results = await Promise.allSettled(both);
		expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
		expect(tab.grants.length).toBe(2);
	});

	test("unknown_id for a grant drops it from grants, and its revoke() resolves (DEC-168)", async () => {
		const second: Grant = { ...GRANT, grantId: "g_2" };
		relay.grants = [GRANT, second];
		await tab.connect({ resume: true });
		const changes: string[][] = [];
		tab.addEventListener("grantschange", (e) =>
			changes.push(e.detail.grants.map((g) => g.grantId)),
		);
		const gone = tab.revoke("g_1");
		const other = tab.revoke("g_2");
		await relay.next("grant.revoke");
		await relay.next("grant.revoke");
		relay.send({
			type: "error",
			code: "unknown_id",
			message: "unknown grant",
			for: "grant.revoke",
			grantId: "g_1",
		});
		await gone;
		expect(changes).toEqual([["g_2"]]);
		expect(tab.grants.map((g) => g.grantId)).toEqual(["g_2"]);
		// The other one still waits for its own answer.
		relay.send({ type: "grant.removed", grantId: "g_2", reason: "revoked" });
		await other;
	});

	test("an error naming another message does not settle signOut()", async () => {
		relay.pairing = "oidc";
		await tab.connect({ resume: true });
		let settled = false;
		const out = tab.signOut().then(
			() => (settled = true),
			(e: unknown) => {
				settled = true;
				throw e;
			},
		);
		await relay.next("identity.logout");
		relay.send({
			type: "error",
			code: "store_unavailable",
			message: "x",
			for: "grant.revoke",
			grantId: "g_1",
		});
		await Bun.sleep(10);
		expect(settled).toBe(false);
		relay.send({
			type: "error",
			code: "store_unavailable",
			message: "x",
			for: "identity.logout",
		});
		await expect(out).rejects.toMatchObject({ code: "store_unavailable" });
	});

	test("a schema the validator cannot use: unregistered at connect, refused after it", async () => {
		// Passes the core's check; only the validator (loaded by connect()) sees it.
		const inputSchema = {
			type: "object",
			properties: { a: { $id: "https://y.example/t", $ref: "#/$defs/s" } },
			$defs: { s: { type: "string" } },
		};
		const execute = () => "ran";
		await tab.registerTool({
			name: "early",
			description: "d",
			inputSchema,
			execute,
		});
		await tab.registerTool({ name: "fine", description: "d", execute });
		const errors: Error[] = [];
		tab.addEventListener("error", (e) => errors.push(e.detail.error));
		await tab.connect({ resume: true });
		expect(errors.map((e) => e.message)).toEqual([
			'registerTool: the inputSchema of early: $ref "#/$defs/s" does not resolve; the tool was unregistered',
		]);
		expect(tab.tools).toEqual(["fine"]);
		await expect(
			tab.registerTool({
				name: "late",
				description: "d",
				inputSchema,
				execute,
			}),
		).rejects.toThrow(
			new TypeError(
				'registerTool: the inputSchema of late: $ref "#/$defs/s" does not resolve',
			),
		);
		expect(tab.tools).toEqual(["fine"]);
	});

	test("a second showConnectDialog() while one is open shows no second dialog", async () => {
		const window = new Window({ url: "https://page.example/" });
		const doc = window.document as unknown as Document;
		try {
			const first = tab.showConnectDialog({ document: doc });
			const second = tab.showConnectDialog({ document: doc });
			await nextState(tab, "connected");
			await relay.next("pairing.start");
			await Bun.sleep(0); // the UI chunk is loaded by now
			const dialogs = doc.querySelectorAll("dialog");
			expect(dialogs.length).toBe(1);
			let firstDone = false;
			let secondDone = false;
			void first.then(() => (firstDone = true));
			void second.then(() => (secondDone = true));
			(dialogs[0] as HTMLDialogElement).close();
			await Promise.all([first, second]);
			expect([firstDone, secondDone]).toEqual([true, true]);
			await relay.next("pairing.stop");
			// Once closed, it opens again.
			const again = tab.showConnectDialog({ document: doc });
			await relay.next("pairing.start");
			await Bun.sleep(0);
			expect(doc.querySelectorAll("dialog").length).toBe(1);
			(doc.querySelector("dialog") as HTMLDialogElement).close();
			await again;
		} finally {
			await window.happyDOM.close();
		}
	});

	test("showConnectDialog() for another document while one is open rejects (review of PR #31)", async () => {
		const window = new Window({ url: "https://page.example/" });
		const other = new Window({ url: "https://page.example/frame" });
		const doc = window.document as unknown as Document;
		const otherDoc = other.document as unknown as Document;
		try {
			const first = tab.showConnectDialog({ document: doc });
			const elsewhere = tab.showConnectDialog({ document: otherDoc });
			const error = await elsewhere.then(
				() => undefined,
				(e: unknown) => e as DOMException,
			);
			expect(error?.name).toBe("InvalidStateError");
			expect(error?.message).toMatch(/already open in another document/);
			await relay.next("pairing.start");
			await Bun.sleep(0);
			expect(doc.querySelectorAll("dialog").length).toBe(1);
			expect(otherDoc.querySelectorAll("dialog").length).toBe(0);
			// The same document, given or as the default, reuses the open one.
			const same = tab.showConnectDialog({ document: doc });
			(doc.querySelector("dialog") as HTMLDialogElement).close();
			await Promise.all([first, same]);
		} finally {
			await window.happyDOM.close();
			await other.happyDOM.close();
		}
	});
});
