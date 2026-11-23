/**
 * The AI access switch glows while an AI app's call runs and a moment after
 * (DEC-225): the same checks in Chrome and in Firefox, on the test build,
 * whose hold is `TEST_GLOW_AFTER_MS` (1.5 s) and not the extension's 5 s.
 */

import { expect } from "bun:test";
import { TEST_GLOW_AFTER_MS } from "../src/sidepanel/glow.ts";

const LABEL = `document.getElementById("ai-switch").closest(".switch")`;

/**
 * The switch's label: whether it glows, its box, what its ring and halo
 * draw; and whether a question shows, read in the same look.
 */
interface Look {
	glows: boolean;
	question: boolean;
	box: number[];
	ring: string;
	halo: string;
}

const LOOK = `(() => {
	const label = ${LABEL};
	const box = label.getBoundingClientRect();
	return {
		glows: label.hasAttribute("data-calling"),
		question: document.querySelector("[data-question]") !== null,
		box: [box.x, box.y, box.width, box.height],
		ring: getComputedStyle(label, "::before").backgroundImage,
		halo: getComputedStyle(label, "::after").animationName,
	};
})()`;

type Eval = <T>(expression: string) => Promise<T>;

/**
 * Wait for a look that passes `check`; that look, and the milliseconds it
 * took. `what` names the wait in the error.
 */
async function lookUntil(
	panel: Eval,
	check: (look: Look) => boolean,
	ms: number,
	what: string,
): Promise<{ look: Look; took: number }> {
	const start = Date.now();
	for (;;) {
		const look = await panel<Look>(LOOK);
		if (check(look)) return { look, took: Date.now() - start };
		if (Date.now() - start > ms)
			throw new Error(`${what}: the last look ${JSON.stringify(look)}`);
		await Bun.sleep(50);
	}
}

const dark = (look: Look) => !look.glows;

/**
 * `ask` starts a call that asks in the panel, `answer` allows it there. The
 * switch glows while the question waits (the call runs), with the ring and
 * the halo and without moving; still after the call ended, for the hold;
 * then not. Returns the call's result.
 */
export async function glowsWhileCalling<R extends { isError?: boolean }>(
	panel: Eval,
	ask: () => Promise<R>,
	answer: () => Promise<void>,
): Promise<R> {
	// The calls before this one have had their hold.
	const { look: before } = await lookUntil(
		panel,
		dark,
		10_000,
		"the switch kept glowing before the call",
	);
	expect(before.ring).toBe("none");
	const pending = ask();
	// The glow comes as the call starts, the question a moment later (the
	// worker reads the tab first): glowing with the question showing, in one
	// look, is the call running while it waits.
	const { look: during } = await lookUntil(
		panel,
		(look) => look.glows && look.question,
		10_000,
		"the switch never glowed with the question showing",
	);
	expect(during.box).toEqual(before.box);
	expect(during.ring).toStartWith("linear-gradient(");
	expect(during.halo).toBe("calling");
	await answer();
	const result = await pending;
	expect(result.isError).toBeFalsy();
	// Held: most calls take a blink, and the glow has to be seen.
	const { took: held } = await lookUntil(
		panel,
		dark,
		TEST_GLOW_AFTER_MS + 2000,
		"the switch kept glowing after the hold",
	);
	expect(held).toBeGreaterThan(TEST_GLOW_AFTER_MS - 700);
	return result;
}
