/**
 * The side panel's "AI access" card: the next step stands out, the address
 * shows only while pairing, with "How do I add it?" under it.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { join } from "node:path";
import { SETUP_GUIDE } from "@ractive-ch/tab-mcp-client/setup";
import { Window } from "happy-dom";
import { allSitesButton } from "../src/browser.ts";
import type { PanelState, TabView } from "../src/protocol.ts";
import {
	ALWAYS_ALLOW_ALL,
	allowAllLabel,
	allowAllView,
	alwaysAllowNote,
	CONFIRM_DELAY_MS,
	cardView,
	confirms,
	ICON_AFTER,
	introText,
	noAccessText,
	type SwitchIntent,
	switchExpiry,
	switchShown,
	webmcpNote,
} from "../src/sidepanel/card.ts";
import {
	GLOW_AFTER_MS,
	Glow,
	type GlowInput,
	glowAfterMs,
	TEST_GLOW_AFTER_MS,
} from "../src/sidepanel/glow.ts";
import {
	countdownText,
	questionAnnouncement,
	timeLeftShare,
} from "../src/sidepanel/question.ts";
import {
	COPIED_MS,
	copyText,
	SELECTED,
	setupSteps,
} from "../src/sidepanel/setup.ts";

const base: PanelState = {
	relay: "https://relay.example",
	status: "off",
	grants: [],
	pairing: false,
	calling: false,
	recentCalls: 0,
	allSites: false,
	questions: [],
	expired: [],
};
const ADDRESS = "https://relay.example/s/tab-mcp/mcp";
const claude = { grantId: "g1", name: "Claude", host: "claude.ai" };

describe("the AI access card", () => {
	test("off: the switch is off, Turn on AI access is the step, no address", () => {
		expect(cardView(base, false)).toEqual({
			// Nothing paired: no promise about paired apps (EQ 7).
			stateText: "AI access is off",
			stateShown: true,
			switchOn: false,
			turnOn: true,
			pairing: false,
			addApp: false,
			done: false,
			address: "",
			intro: true,
			disconnect: false,
			grantsNote: "",
		});
	});

	test("off with apps paired: they stay listed, without Disconnect, and the panel says why (EQ 8)", () => {
		const view = cardView({ ...base, grants: [claude] }, false);
		expect(view).toMatchObject({
			stateText: "AI access is off · your AI apps stay connected for next time",
			stateShown: true,
			intro: false,
			disconnect: false,
			grantsNote: "Turn on AI access to disconnect an AI app.",
		});
		for (const status of ["connecting", "retrying"] as const)
			expect(
				cardView({ ...base, status, grants: [claude] }, false),
			).toMatchObject({
				disconnect: false,
				grantsNote:
					"An AI app can be disconnected once the connection is back.",
			});
		expect(
			cardView({ ...base, status: "on", grants: [claude] }, false),
		).toMatchObject({ disconnect: true, grantsNote: "" });
	});

	test("the first look says what the extension does and names the relay (EQ 7)", () => {
		expect(introText("https://relay.example:8443")).toBe(
			"Lets an AI app outside this browser use the tab in front: read it, navigate it and call the page's WebMCP tools. AI access connects to the relay relay.example:8443.",
		);
	});

	test("connecting: the switch is on (to stop it), nothing to pair yet", () => {
		const view = cardView({ ...base, status: "connecting" }, false);
		expect(view).toMatchObject({
			stateText: "Connecting…",
			stateShown: true,
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
			stateText: "On · no AI app connected yet",
			stateShown: true,
			switchOn: true,
			turnOn: false,
			pairing: true,
			addApp: false,
			done: false,
			address: ADDRESS,
			intro: true,
			disconnect: true,
			grantsNote: "",
		});
	});

	test("apps paired: their names, + Connect another AI app, the address hidden until asked", () => {
		const state: PanelState = {
			...base,
			status: "on",
			address: ADDRESS,
			grants: [claude, { grantId: "g2", name: "", host: "chatgpt.com" }],
		};
		expect(cardView(state, false)).toEqual({
			stateText: "Connected · Claude, chatgpt.com",
			stateShown: false,
			switchOn: true,
			turnOn: false,
			pairing: false,
			addApp: true,
			done: false,
			address: "",
			intro: false,
			disconnect: true,
			grantsNote: "",
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

describe("the AI access switch glows while an AI app calls (DEC-225)", () => {
	/** A glow on timers the test runs by hand; `shown`: what it drew, in order. */
	function glowing() {
		const shown: boolean[] = [];
		const pending = new Set<{ run: () => void; ms: number }>();
		const glow = new Glow((on) => shown.push(on), GLOW_AFTER_MS, {
			set: (run, ms) => {
				const timer = { run, ms };
				pending.add(timer);
				return timer;
			},
			clear: (timer) =>
				pending.delete(timer as { run: () => void; ms: number }),
		});
		const holds = () => [...pending].map((t) => t.ms);
		/** The hold runs out. */
		const later = () => {
			for (const timer of [...pending]) {
				pending.delete(timer);
				timer.run();
			}
		};
		return { glow, shown, holds, later };
	}
	const on: GlowInput = { status: "on", calling: false };
	const calling: GlowInput = { status: "on", calling: true };

	test("on while a call runs, held for 5 s after it ended, then gone", () => {
		const t = glowing();
		t.glow.update(on);
		expect(t.shown).toEqual([]);
		t.glow.update(calling);
		expect(t.glow.on).toBe(true);
		expect(t.holds()).toEqual([]);
		t.glow.update(on);
		// Still on: most calls take a blink.
		expect(t.glow.on).toBe(true);
		expect(t.holds()).toEqual([GLOW_AFTER_MS]);
		// Other states meanwhile (a tab change) start no other hold.
		t.glow.update(on);
		expect(t.holds()).toEqual([GLOW_AFTER_MS]);
		t.later();
		expect(t.glow.on).toBe(false);
		// Drawn once each way, not on every state.
		expect(t.shown).toEqual([true, false]);
	});

	test("a call while it is held keeps it on; the hold starts again after that call", () => {
		const t = glowing();
		t.glow.update(calling);
		t.glow.update(on);
		expect(t.holds()).toEqual([GLOW_AFTER_MS]);
		t.glow.update(calling);
		expect(t.holds()).toEqual([]);
		expect(t.glow.on).toBe(true);
		t.glow.update(on);
		expect(t.holds()).toEqual([GLOW_AFTER_MS]);
		t.later();
		expect(t.shown).toEqual([true, false]);
	});

	test("calls that overlap: one glow, one hold after the last (the worker says calling until then)", () => {
		const t = glowing();
		// Two calls, then the first ends: the worker's flag stays on.
		for (const state of [calling, calling, calling]) t.glow.update(state);
		expect(t.holds()).toEqual([]);
		t.glow.update(on);
		expect(t.holds()).toEqual([GLOW_AFTER_MS]);
		t.later();
		expect(t.shown).toEqual([true, false]);
	});

	test("gone at once when the connection goes, during a call or in the hold, and not back with it", () => {
		for (const down of ["off", "connecting", "retrying"] as const) {
			const during = glowing();
			during.glow.update(calling);
			during.glow.update({ status: down, calling: true });
			expect(during.glow.on).toBe(false);
			expect(during.holds()).toEqual([]);

			const held = glowing();
			held.glow.update(calling);
			held.glow.update(on);
			held.glow.update({ status: down, calling: false });
			expect(held.glow.on).toBe(false);
			// The hold is dropped: the connection back is no glow.
			expect(held.holds()).toEqual([]);
			held.glow.update(on);
			expect(held.glow.on).toBe(false);
			expect(held.shown).toEqual([true, false]);
		}
	});

	test("only while the connection is up: connected with or without an app paired", () => {
		for (const status of ["off", "connecting", "retrying"] as const) {
			const t = glowing();
			t.glow.update({ status, calling: true });
			expect(t.shown).toEqual([]);
		}
		const waiting = glowing();
		waiting.glow.update({ status: "waiting", calling: true });
		expect(waiting.glow.on).toBe(true);
	});

	test("5 s in the extension, 1.5 s in the test build only", () => {
		expect(GLOW_AFTER_MS).toBe(5000);
		expect(TEST_GLOW_AFTER_MS).toBe(1500);
		// No `define` here, as in the store build.
		expect(glowAfterMs).toBe(GLOW_AFTER_MS);
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

describe("the tab card's texts", () => {
	const tab = (over: Partial<TabView>): TabView => ({
		title: "Shop",
		host: "shop.example",
		access: "",
		tools: [],
		canAllow: false,
		...over,
	});

	test("an unreadable tab in the user's words: the toolbar icon, no AI app wording (EQ 6)", () => {
		const click =
			"Click the tab-mcp icon in Chrome's toolbar or puzzle-piece menu to let it read this tab.";
		expect(noAccessText("no-grant", false)).toBe(click);
		// The panel puts the extension's icon right after these words.
		expect(click).toContain(`${ICON_AFTER} in`);
		// A hidden address may be a browser page, where the click cannot help
		// (not worth a sentence); with host access on all sites it can only be one.
		expect(noAccessText("hidden", false)).toBe(click);
		expect(noAccessText("hidden", true)).toBe(
			"Chrome does not let extensions read browser pages.",
		);
		for (const reason of [
			"hidden",
			"no-grant",
			"browser-page",
			"web-store",
			"not-site",
		] as const)
			for (const allSites of [false, true]) {
				const text = noAccessText(reason, allSites);
				expect(text).not.toContain("The user");
				expect(text).not.toContain("on the tab,");
			}
	});

	test("no tools: whether WebMCP is off or the page offers none (EQ 7)", () => {
		expect(webmcpNote(undefined)).toBeUndefined();
		// Not readable: the access line says why, no note on tools.
		expect(webmcpNote(tab({ noAccess: "no-grant" }))).toBeUndefined();
		expect(webmcpNote(tab({ webmcp: { available: false, tools: 0 } }))).toBe(
			"no-webmcp",
		);
		expect(webmcpNote(tab({ webmcp: { available: true, tools: 0 } }))).toBe(
			"no-tools",
		);
		expect(
			webmcpNote(tab({ webmcp: { available: true, tools: 2 } })),
		).toBeUndefined();
	});

	test("WebMCP given late (DEC-223): nothing while it is on its way, its own line when the page registered nothing", () => {
		expect(
			webmcpNote(
				tab({ webmcp: { available: false, tools: 0, pending: true } }),
			),
		).toBeUndefined();
		expect(
			webmcpNote(tab({ webmcp: { available: true, tools: 0, late: true } })),
		).toBe("late-webmcp");
		expect(
			webmcpNote(tab({ webmcp: { available: true, tools: 1, late: true } })),
		).toBeUndefined();
	});

	test("the panel's texts in index.html: by what they act on (EQ 9), roles for what changes (EQ 11)", async () => {
		const html = await Bun.file(
			join(import.meta.dir, "../src/sidepanel/index.html"),
		).text();
		const window = new Window({
			url: "chrome-extension://x/sidepanel/index.html",
		});
		const doc = window.document as unknown as Document;
		doc.write(html);
		try {
			const text = (id: string) =>
				doc.getElementById(id)?.textContent?.replace(/\s+/g, " ").trim();
			// The button's label is set from one place (`allSitesButton`).
			expect(text("allow-all")).toBe("");
			expect(allSitesButton).toBe("Give access to all sites");
			expect(text("disallow-all")).toBe("Remove access to all sites");
			// What changes, and that Chrome asks first.
			expect(text("host-access-note")).toBe(
				"Or let it read every tab without a click. Chrome asks you first.",
			);
			// A switch for all the tools' switches, named as they are.
			const allowTools = doc.getElementById("allow-tools");
			expect(allowTools?.getAttribute("role")).toBe("switch");
			expect(allowTools?.closest("label")?.textContent).toBe(ALWAYS_ALLOW_ALL);
			// Problems are announced; a question's card is not a live region
			// (its arguments can be 1 MiB), a short line is.
			expect(doc.getElementById("problem")?.getAttribute("role")).toBe("alert");
			expect(doc.getElementById("local-problem")?.getAttribute("role")).toBe(
				"alert",
			);
			expect(doc.getElementById("tab-access")?.getAttribute("role")).toBe(
				"status",
			);
			expect(doc.getElementById("questions")?.hasAttribute("aria-live")).toBe(
				false,
			);
			expect(doc.getElementById("question-status")?.getAttribute("role")).toBe(
				"status",
			);
			// The dialog's own, for while the rest of the panel is inert.
			expect(
				doc
					.getElementById("questions")
					?.querySelector("#question-status-modal")
					?.getAttribute("role"),
			).toBe("status");
			// Where WebMCP comes from, and what works without it.
			expect(text("no-webmcp")).toContain(
				"chrome://flags/#enable-webmcp-testing",
			);
			// The polyfill's conditions: AI access on for a page that comes to
			// it later (DEC-223), all sites and a reload for one that looks
			// only as it loads.
			expect(text("no-webmcp")).toContain("While AI access is on");
			expect(text("no-webmcp")).toContain("access to all sites and a reload");
			expect(text("late-webmcp")).toContain("after it had loaded");
			expect(text("late-webmcp")).toContain("With access to all sites");
			expect(text("no-tools")).toContain("page_info and the navigation tools");
			// The chat in a tab of this profile (EQ 2).
			expect(text("pairing")).toContain("outside this Chrome profile");
			// The look (DEC-160, DEC-161): the main actions are ink ("strong"),
			// none is "primary" (amber in Overmark); nothing is in a tooltip
			// alone; the line for the "Always allow" switches is there to be filled.
			expect(
				[...doc.querySelectorAll("button.strong")].map((b) =>
					b.textContent?.trim(),
				),
			).toEqual(["Turn on AI access", "Done", "Save"]);
			expect(doc.querySelector(".primary")).toBeNull();
			expect(doc.querySelectorAll("[title]").length).toBe(0);
			expect(doc.getElementById("always-allow-note")?.hidden).toBe(true);
			expect(
				[...doc.querySelectorAll("h2, h3")].map((h) => h.textContent),
			).toEqual([
				"AI access",
				"Connect your AI app",
				"Tab in front",
				"Tools",
				"Your browsers",
				"AI apps connected to all your browsers",
			]);
			// The AI access switch is named by the card's heading: no second
			// "AI access" beside it.
			expect(
				doc.getElementById("ai-switch")?.getAttribute("aria-labelledby"),
			).toBe("ai-heading");
			expect(doc.querySelector("label.switch")?.textContent?.trim()).toBe("");
		} finally {
			await window.happyDOM.close();
		}
	});

	test("what Always allow does is a line for everyone, with the site (DEC-160)", () => {
		expect(alwaysAllowNote("https://shop.example")).toBe(
			"Always allow, on: the tool runs without asking on https://shop.example, for every connected AI app. Off: it asks you before each call.",
		);
	});

	test("the announcement of a question is one short line (EQ 11)", () => {
		expect(
			questionAnnouncement({ app: "Claude (claude.ai)", tool: "page_order" }),
		).toBe("Claude (claude.ai) asks to run page_order.");
		expect(
			questionAnnouncement({
				app: "Claude (claude.ai)",
				tool: "navigate",
				navigation: { to: "https://evil.test/" },
			}),
		).toBe("Claude (claude.ai) asks to take the tab to another site.");
		expect(countdownText(10_000, 9_001)).toBe(
			"1 s left to answer; no answer is Don't allow.",
		);
		expect(countdownText(10_000, 12_000)).toBe(
			"0 s left to answer; no answer is Don't allow.",
		);
	});

	test("the countdown's bar: the share of the 60 s left, from 1 to 0", () => {
		expect(timeLeftShare(60_000, 0)).toBe(1);
		expect(timeLeftShare(60_000, 45_000)).toBe(0.25);
		expect(timeLeftShare(60_000, 61_000)).toBe(0);
		// A clock that went back does not overfill it.
		expect(timeLeftShare(60_000, -5_000)).toBe(1);
	});
});

describe("Always allow all, over the tool list", () => {
	const tab = (tools: TabView["tools"], canAllow = true): TabView => ({
		title: "Shop",
		host: "shop.example",
		access: "",
		origin: "https://shop.example",
		tools,
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
			checked: false,
			names: ["order", "pay"],
			on: true,
		});
	});

	test("some allowed: off, a click allows the rest; none asks: on, a click asks again", () => {
		expect(allowAllView(tab([{ ...order, allowed: true }, pay]))).toMatchObject(
			{ checked: false, on: true },
		);
		expect(
			allowAllView(
				tab([{ ...order, allowed: true }, { ...pay, allowed: true }, read]),
			),
		).toEqual({
			shown: true,
			checked: true,
			names: ["order", "pay"],
			on: false,
		});
	});

	test("its accessible name: the count, the site and every connected AI app", () => {
		const site = "https://shop.example";
		expect(allowAllLabel(allowAllView(tab([order, pay, read])), site)).toBe(
			"Always allow all: the 2 tools listed on https://shop.example, for every connected AI app",
		);
		expect(
			allowAllLabel(allowAllView(tab([{ ...order, allowed: true }])), site),
		).toBe(
			"Always allow all: the 1 tool listed on https://shop.example, for every connected AI app",
		);
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
			`claude mcp add --transport http tab-mcp-browser-extension ${ADDRESS}`,
			`codex features enable mcp_2026_07_28\ncodex mcp add tab-mcp-browser-extension --url ${ADDRESS}\ncodex mcp login tab-mcp-browser-extension`,
		]);
		const copies = items.flatMap((li) => [...li.querySelectorAll("button")]);
		expect(copies.map((b) => [b.type, b.getAttribute("aria-label")])).toEqual([
			["button", "Copy Claude Code command"],
			["button", "Copy Codex command"],
		]);
		expect(items[2]?.querySelector(".note code")?.textContent).toBe("/mcp");
		expect(items[3]?.querySelector(".note")?.textContent).toContain(
			"The last line opens the sign-in",
		);
	});

	test("Copy copies the command whole and says Copied, then Copy again", async () => {
		const copied = stubClipboard();
		const said: string[] = [];
		const items = setupSteps(doc, ADDRESS, (t) => said.push(t));
		jest.useFakeTimers();
		const copy = items[3]?.querySelector("button") as HTMLButtonElement;
		copy.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(copied()).toBe(
			`codex features enable mcp_2026_07_28\ncodex mcp add tab-mcp-browser-extension --url ${ADDRESS}\ncodex mcp login tab-mcp-browser-extension`,
		);
		expect(copy.textContent).toBe("Copied");
		expect(copy.getAttribute("aria-label")).toBe("Copied Codex command");
		jest.advanceTimersByTime(COPIED_MS);
		expect(copy.textContent).toBe("Copy");
		expect(copy.getAttribute("aria-label")).toBe("Copy Codex command");
		// Said for a screen reader too, whose focus stays on the button.
		expect(said).toEqual(["Copied Codex command"]);
	});

	test("a refused clipboard selects the command in place, its lines kept", async () => {
		stubClipboard(true);
		const said: string[] = [];
		const items = setupSteps(doc, ADDRESS, (t) => said.push(t));
		const block = items[3] as HTMLLIElement;
		doc.body.append(block);
		(block.querySelector("button") as HTMLButtonElement).click();
		await Bun.sleep(0);
		expect(said).toEqual([SELECTED]);
		expect(doc.getSelection()?.toString()).toBe(
			`codex features enable mcp_2026_07_28\ncodex mcp add tab-mcp-browser-extension --url ${ADDRESS}\ncodex mcp login tab-mcp-browser-extension`,
		);
		block.remove();
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
