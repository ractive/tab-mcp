/**
 * The side panel's "AI app" card: the next step stands out, the address
 * shows only while pairing, with "How do I add it?" under it.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { join } from "node:path";
import { SETUP_GUIDE } from "@ractive-ch/tab-mcp-client/setup";
import { Window } from "happy-dom";
import type { PanelState, TabView } from "../src/protocol.ts";
import {
	allowAllView,
	CONFIRM_DELAY_MS,
	cardView,
	confirms,
	type SwitchIntent,
	switchExpiry,
	switchShown,
} from "../src/sidepanel/card.ts";
import { COPIED_MS, copyText, setupSteps } from "../src/sidepanel/setup.ts";

const base: PanelState = {
	relay: "https://relay.example",
	status: "off",
	grants: [],
	pairing: false,
	allSites: false,
	questions: [],
};
const ADDRESS = "https://relay.example/a/x/mcp";
const claude = { grantId: "g1", name: "Claude", host: "claude.ai" };

describe("the AI app card", () => {
	test("off: the switch is off, Turn on AI access is the step, no address", () => {
		expect(cardView(base, false)).toEqual({
			stateText: "AI access is off · paired apps stay paired",
			switchOn: false,
			turnOn: true,
			pairing: false,
			addApp: false,
			done: false,
			address: "",
		});
	});

	test("connecting: the switch is on (to stop it), nothing to pair yet", () => {
		const view = cardView({ ...base, status: "connecting" }, false);
		expect(view).toMatchObject({
			stateText: "Connecting…",
			switchOn: true,
			turnOn: false,
			pairing: false,
		});
	});

	test("on with no app paired: the address and the code at once, no Done", () => {
		const view = cardView(
			{ ...base, status: "waiting", address: ADDRESS },
			false,
		);
		expect(view).toEqual({
			stateText: "On · no AI app paired yet",
			switchOn: true,
			turnOn: false,
			pairing: true,
			addApp: false,
			done: false,
			address: ADDRESS,
		});
	});

	test("apps paired: their names, + Add another AI app, the address hidden until asked", () => {
		const state: PanelState = {
			...base,
			status: "on",
			address: ADDRESS,
			grants: [claude, { grantId: "g2", name: "", host: "chatgpt.com" }],
		};
		expect(cardView(state, false)).toEqual({
			stateText: "Connected · Claude, chatgpt.com",
			switchOn: true,
			turnOn: false,
			pairing: false,
			addApp: true,
			done: false,
			address: "",
		});
		expect(cardView(state, true)).toMatchObject({
			pairing: true,
			addApp: false,
			done: true,
			address: ADDRESS,
		});
	});
});

describe("the card's clicks", () => {
	test("the second click of a double click does not confirm Disconnect", () => {
		expect(confirms(1000, 1000 + 120)).toBe(false);
		expect(confirms(1000, 1000 + CONFIRM_DELAY_MS - 1)).toBe(false);
		expect(confirms(1000, 1000 + CONFIRM_DELAY_MS)).toBe(true);
	});

	test("the switch keeps the user's flip until the state follows, or the wait ends", () => {
		const intent = { on: true, until: 5000 };
		// A state from before the connect: the switch stays on.
		expect(switchShown(false, intent, 1000)).toEqual({ checked: true, intent });
		// The state follows: the intent is done.
		expect(switchShown(true, intent, 1200)).toEqual({
			checked: true,
			intent: undefined,
		});
		// It never followed: the state wins after the wait.
		expect(switchShown(false, intent, 5000)).toEqual({
			checked: false,
			intent: undefined,
		});
		expect(switchShown(true, undefined, 0)).toEqual({
			checked: true,
			intent: undefined,
		});
	});
});

describe("the switch with no state to follow", () => {
	test("the panel redraws once the flip has run out, if it is still the last one", () => {
		const timers: { run: () => void; ms: number }[] = [];
		const schedule = (run: () => void, ms: number) => timers.push({ run, ms });
		const intent: SwitchIntent = { on: true, until: 11_000 };
		let current: SwitchIntent | undefined = intent;
		let redraws = 0;
		switchExpiry(
			intent,
			() => current,
			() => redraws++,
			() => 1000,
			schedule,
		);
		// At the end of the wait, not before.
		expect(timers.map((t) => t.ms)).toEqual([10_000]);
		timers[0]?.run();
		expect(redraws).toBe(1);
		// After the redraw the switch shows the state ("off": the connect failed).
		expect(switchShown(false, intent, 11_000).checked).toBe(false);
		// A newer flip meanwhile: the older timer does nothing.
		current = { on: false, until: 20_000 };
		timers[0]?.run();
		expect(redraws).toBe(1);
	});
});

describe("Allow all", () => {
	const tab = (tools: TabView["tools"], canAllow = true): TabView => ({
		title: "Shop",
		host: "shop.example",
		access: "",
		origin: "https://shop.example",
		tools,
		mirrored: 0,
		canAllow,
	});
	const order = { name: "order", readOnly: false, allowed: false };
	const pay = { name: "pay", readOnly: false, allowed: false };
	const read = { name: "read", readOnly: true, allowed: false };
	const broken = {
		name: "broken",
		readOnly: false,
		allowed: false,
		problem: "too long",
	};

	test("for the listed tools that ask first, not read-only or left-out ones", () => {
		expect(allowAllView(tab([order, pay, read, broken]))).toEqual({
			shown: true,
			label: "Allow all",
			names: ["order", "pay"],
			on: true,
		});
	});

	test("some allowed: still Allow all; all allowed: Ask for all", () => {
		expect(allowAllView(tab([{ ...order, allowed: true }, pay])).label).toBe(
			"Allow all",
		);
		expect(
			allowAllView(
				tab([{ ...order, allowed: true }, { ...pay, allowed: true }, read]),
			),
		).toEqual({
			shown: true,
			label: "Ask for all",
			names: ["order", "pay"],
			on: false,
		});
	});

	test("hidden where tools cannot be allowed, or none asks first", () => {
		expect(allowAllView(tab([order], false)).shown).toBe(false);
		expect(allowAllView(tab([read, broken])).shown).toBe(false);
		expect(allowAllView(undefined).shown).toBe(false);
	});
});

describe("How do I add it? (the pairing box)", () => {
	let window: Window;
	let doc: Document;
	beforeEach(() => {
		window = new Window({ url: "chrome-extension://x/sidepanel/index.html" });
		doc = window.document as unknown as Document;
	});
	afterEach(async () => {
		jest.useRealTimers();
		await window.happyDOM.close();
	});

	/** The clipboard: what was written, or a refusal. */
	function stubClipboard(refuse = false): () => string {
		let copied = "";
		Object.defineProperty(window.navigator, "clipboard", {
			value: {
				writeText: async (text: string) => {
					if (refuse) throw new Error("Document is not focused.");
					copied = text;
				},
			},
			configurable: true,
		});
		return () => copied;
	}

	test("in the pairing box under the address, collapsed, the guide at its end", async () => {
		const html = await Bun.file(
			join(import.meta.dir, "../src/sidepanel/index.html"),
		).text();
		doc.write(html);
		const details = doc.querySelector(
			"#pairing > #setup",
		) as HTMLDetailsElement;
		expect(details.tagName).toBe("DETAILS");
		expect(details.open).toBe(false);
		// Right after the address: shown and hidden with it.
		expect(details.previousElementSibling?.className).toBe("address");
		expect(details.querySelector("summary")?.textContent).toBe(
			"How do I add it?",
		);
		const guide = details.lastElementChild?.querySelector("a");
		expect(guide?.getAttribute("href")).toBe(SETUP_GUIDE);
		expect(guide?.getAttribute("target")).toBe("_blank");
		expect(guide?.getAttribute("rel")).toBe("noopener");
		// Every Copy says what it copies.
		expect(
			[...doc.querySelectorAll("#pairing button.copy")].map((b) =>
				b.getAttribute("aria-label"),
			),
		).toEqual(["Copy address", "Copy code"]);
	});

	test("each app with its steps; Claude Code and Codex with a command and its own Copy", () => {
		const items = setupSteps(doc, ADDRESS, () => {});
		expect(items.map((li) => li.querySelector("strong")?.textContent)).toEqual([
			"Claude (claude.ai and the desktop app)",
			"ChatGPT",
			"Claude Code",
			"Codex",
		]);
		expect(
			items.map((li) => li.querySelector("pre")?.textContent ?? null),
		).toEqual([
			null,
			null,
			`claude mcp add --transport http tab-mcp-for-chrome ${ADDRESS}`,
			`codex features enable mcp_2026_07_28\ncodex mcp add tab-mcp-for-chrome --url ${ADDRESS}`,
		]);
		const copies = items.flatMap((li) => [...li.querySelectorAll("button")]);
		expect(copies.map((b) => [b.type, b.getAttribute("aria-label")])).toEqual([
			["button", "Copy Claude Code command"],
			["button", "Copy Codex command"],
		]);
		expect(items[3]?.querySelector(".note code")?.textContent).toBe(
			"codex features disable mcp_2026_07_28",
		);
	});

	test("Copy copies the command whole and says Copied, then Copy again", async () => {
		const copied = stubClipboard();
		const failed: string[] = [];
		const items = setupSteps(doc, ADDRESS, (t) => failed.push(t));
		jest.useFakeTimers();
		const copy = items[3]?.querySelector("button") as HTMLButtonElement;
		copy.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(copied()).toBe(
			`codex features enable mcp_2026_07_28\ncodex mcp add tab-mcp-for-chrome --url ${ADDRESS}`,
		);
		expect(copy.textContent).toBe("Copied");
		expect(copy.getAttribute("aria-label")).toBe("Copied Codex command");
		jest.advanceTimersByTime(COPIED_MS);
		expect(copy.textContent).toBe("Copy");
		expect(copy.getAttribute("aria-label")).toBe("Copy Codex command");
		expect(failed).toEqual([]);
	});

	test("a refused clipboard hands the text over to be shown whole", async () => {
		stubClipboard(true);
		const button = doc.createElement("button");
		button.textContent = "Copy";
		const failed: string[] = [];
		copyText(button, "the text", (t) => failed.push(t), "address");
		await Bun.sleep(0);
		expect(failed).toEqual(["the text"]);
		expect(button.textContent).toBe("Copy");
	});

	test("an address that is not shell-plain: the steps without commands", () => {
		const items = setupSteps(doc, `${ADDRESS}?a=1&b`, () => {});
		expect(items).toHaveLength(4);
		expect(items.some((li) => li.querySelector("pre, button"))).toBe(false);
		expect(items[2]?.textContent).toContain("claude mcp add --transport http");
	});
});
