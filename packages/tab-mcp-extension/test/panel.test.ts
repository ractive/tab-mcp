/**
 * The side panel's "AI app" card: the next step stands out, the address
 * shows only while pairing.
 */

import { describe, expect, test } from "bun:test";
import type { PanelState, TabView } from "../src/protocol.ts";
import {
	allowAllView,
	CONFIRM_DELAY_MS,
	cardView,
	confirms,
	switchShown,
} from "../src/sidepanel/card.ts";

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
