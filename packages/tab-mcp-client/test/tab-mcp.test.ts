/**
 * `TabMcp` itself: its options, what its getters hand out, and its connect
 * dialog (review of the browser library, iteration 13).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { TabMcp } from "../src/tab-mcp.ts";
import type { Grant } from "../src/types.ts";
import { newTab, nextEvent } from "./helpers.ts";
import { StubRelay } from "./stub-relay.ts";

describe("options", () => {
	test("confirmDelayMs and identityTimeoutMs must be a number of ms", () => {
		for (const bad of [
			Number.NaN,
			-1,
			Number.POSITIVE_INFINITY,
			2 ** 31,
			"750",
		]) {
			expect(() =>
				newTab("https://relay.example", {
					confirmDelayMs: bad as number,
				}),
			).toThrow(/confirmDelayMs/);
			expect(() =>
				newTab("https://relay.example", {
					identityTimeoutMs: bad as number,
				}),
			).toThrow(/identityTimeoutMs/);
		}
		expect(() =>
			newTab("https://relay.example", {
				confirmDelayMs: 0,
				identityTimeoutMs: 0,
			}),
		).not.toThrow();
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
			await nextEvent(tab, "connected");
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
			expect(tab.pairing).toBe(false);
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
});
