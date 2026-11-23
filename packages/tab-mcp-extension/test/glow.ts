/**
 * The AI access switch glows while an AI app's call runs and a moment after
 * (DEC-225): the same checks in Chrome and in Firefox, on the test build,
 * whose hold is `TEST_GLOW_AFTER_MS` (1.5 s) and not the extension's 5 s.
 */

import { expect } from "bun:test";
import { TEST_GLOW_AFTER_MS } from "../src/sidepanel/glow.ts";

const LABEL = `document.getElementById("ai-switch").closest(".switch")`;

/** The switch's label: whether it glows, its box, what its ring and halo draw. */
interface Look {
	glows: boolean;
	box: number[];
	ring: string;
	halo: string;
}

const LOOK = `(() => {
	const label = ${LABEL};
	const box = label.getBoundingClientRect();
	return {
		glows: label.hasAttribute("data-calling"),
		box: [box.x, box.y, box.width, box.height],
		ring: getComputedStyle(label, "::before").backgroundImage,
		halo: getComputedStyle(label, "::after").animationName,
	};
})()`;

type Eval = <T>(expression: string) => Promise<T>;

/** Wait until the switch glows (`on`) or not; the milliseconds it took. */
async function glowsBy(panel: Eval, on: boolean, ms: number): Promise<number> {
	const start = Date.now();
	for (;;) {
		if ((await panel<Look>(LOOK)).glows === on) return Date.now() - start;
		if (Date.now() - start > ms)
			throw new Error(`the switch ${on ? "never glowed" : "kept glowing"}`);
		await Bun.sleep(50);
	}
}

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
	await glowsBy(panel, false, 10_000);
	const before = await panel<Look>(LOOK);
	expect(before.ring).toBe("none");
	const pending = ask();
	await glowsBy(panel, true, 10_000);
	expect(
		await panel<boolean>(`document.querySelector("[data-question]") !== null`),
	).toBe(true);
	const during = await panel<Look>(LOOK);
	expect(during.box).toEqual(before.box);
	expect(during.ring).toStartWith("linear-gradient(");
	expect(during.halo).toBe("calling");
	await answer();
	const result = await pending;
	expect(result.isError).toBeFalsy();
	// Held: most calls take a blink, and the glow has to be seen.
	const held = await glowsBy(panel, false, TEST_GLOW_AFTER_MS + 2000);
	expect(held).toBeGreaterThan(TEST_GLOW_AFTER_MS - 700);
	return result;
}
