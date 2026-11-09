/**
 * The side panel's "AI app" card: the next step stands out, the address
 * shows only while pairing.
 */

import { describe, expect, test } from "bun:test";
import type { PanelState } from "../src/protocol.ts";
import { cardView } from "../src/sidepanel/card.ts";

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
