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
	askFirstNote,
	CONFIRM_DELAY_MS,
	cardView,
	confirms,
	DONT_ASK_ALL,
	introText,
	noAccessText,
	type SwitchIntent,
	switchExpiry,
	switchShown,
	webmcpNote,
} from "../src/sidepanel/card.ts";
import {
	countdownText,
	questionAnnouncement,
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
	allSites: false,
	questions: [],
	expired: [],
};
const ADDRESS = "https://relay.example/a/x/mcp";
const claude = { grantId: "g1", name: "Claude", host: "claude.ai" };

describe("the AI app card", () => {
	test("off: the switch is off, Turn on AI access is the step, no address", () => {
		expect(cardView(base, false)).toEqual({
			// Nothing paired: no promise about paired apps (EQ 7).
			stateText: "AI access is off",
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
			stateText: "AI access is off · paired apps stay paired",
			intro: false,
			disconnect: false,
			grantsNote: "Turn on AI access to disconnect an app.",
		});
		for (const status of ["connecting", "retrying"] as const)
			expect(
				cardView({ ...base, status, grants: [claude] }, false),
			).toMatchObject({
				disconnect: false,
				grantsNote: "An app can be disconnected once connected again.",
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
			intro: true,
			disconnect: true,
			grantsNote: "",
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
		expect(noAccessText("no-grant", false)).toBe(
			"Click the tab-mcp icon in Chrome's toolbar to let it read this tab.",
		);
		// A hidden address may be a browser page, where the click cannot help;
		// with host access on all sites it can only be one.
		expect(noAccessText("hidden", false)).toBe(
			"Click the tab-mcp icon in Chrome's toolbar to let it read this tab. Chrome's own pages, such as a new tab, cannot be read at all.",
		);
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
			expect(text("allow-all")).toBe("Read all sites without a click");
			expect(text("disallow-all")).toBe("Stop reading all sites");
			// What Chrome will ask, before its prompt.
			expect(text("host-access")).toContain(
				'"Read and change all your data on all websites"',
			);
			expect(text("allow-tools")).toBe(DONT_ASK_ALL);
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
			// Where WebMCP comes from, and what works without it.
			expect(text("no-webmcp")).toContain(
				"chrome://flags/#enable-webmcp-testing",
			);
			expect(text("no-tools")).toContain("page_info and the navigation tools");
			// The chat in a tab of this profile (EQ 2).
			expect(text("pairing")).toContain("outside this Chrome profile");
			// The look (DEC-160, DEC-161): the main actions are ink ("strong"),
			// none is "primary" (amber in Overmark); nothing is in a tooltip
			// alone; the line for the "Ask first" switches is there to be filled.
			expect(
				[...doc.querySelectorAll("button.strong")].map((b) =>
					b.textContent?.trim(),
				),
			).toEqual(["Turn on AI access", "Done", "Save"]);
			expect(doc.querySelector(".primary")).toBeNull();
			expect(doc.querySelectorAll("[title]").length).toBe(0);
			expect(doc.getElementById("ask-first-note")?.hidden).toBe(true);
			expect(
				[...doc.querySelectorAll("h2, h3")].map((h) => h.textContent),
			).toEqual(["AI app", "Pair an AI app", "Tab in front", "Tools"]);
		} finally {
			await window.happyDOM.close();
		}
	});

	test("what Ask first does is a line for everyone, with the site (DEC-160)", () => {
		expect(askFirstNote("https://shop.example")).toBe(
			"Ask first, on: the tool asks you before each call. Off: it runs without asking on https://shop.example, for every paired AI app.",
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
});

describe("Don't ask for these tools", () => {
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
			label: "Don't ask for these tools",
			names: ["order", "pay"],
			on: true,
		});
	});

	test("some allowed: still Don't ask; none asks: Ask first for these tools", () => {
		expect(allowAllView(tab([{ ...order, allowed: true }, pay])).label).toBe(
			DONT_ASK_ALL,
		);
		expect(
			allowAllView(
				tab([{ ...order, allowed: true }, { ...pay, allowed: true }, read]),
			),
		).toEqual({
			shown: true,
			label: "Ask first for these tools",
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
			`codex features enable mcp_2026_07_28\ncodex mcp add tab-mcp-for-chrome --url ${ADDRESS}\ncodex mcp login tab-mcp-for-chrome`,
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
		const said: string[] = [];
		const items = setupSteps(doc, ADDRESS, (t) => said.push(t));
		jest.useFakeTimers();
		const copy = items[3]?.querySelector("button") as HTMLButtonElement;
		copy.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(copied()).toBe(
			`codex features enable mcp_2026_07_28\ncodex mcp add tab-mcp-for-chrome --url ${ADDRESS}\ncodex mcp login tab-mcp-for-chrome`,
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
			`codex features enable mcp_2026_07_28\ncodex mcp add tab-mcp-for-chrome --url ${ADDRESS}\ncodex mcp login tab-mcp-for-chrome`,
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
