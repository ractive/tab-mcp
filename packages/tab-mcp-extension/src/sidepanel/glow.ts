/**
 * The AI access switch glows while a connected AI app's tool call runs and
 * for `GLOW_AFTER_MS` after the last one ended (DEC-225, after Sitegloss's
 * AI button): most calls take a blink, and the glow has to be seen. Only
 * while the connection is up: off, connecting or retrying, it goes at once.
 * A style alone (`style.css`): no text, name or `aria-*` value changes, so
 * a screen reader hears nothing of it.
 */

import type { PanelState } from "../protocol.ts";

/** `true` only in the test build (`scripts/build.ts --test`, a `define`). */
declare const TAB_MCP_TEST: boolean | undefined;

/** How long the glow stays after the last call ended. */
export const GLOW_AFTER_MS = 5000;

/** The test build's hold: its tests need not sit out five seconds. */
export const TEST_GLOW_AFTER_MS = 1500;

/** The hold of this build. */
export const glowAfterMs =
	typeof TAB_MCP_TEST !== "undefined" && TAB_MCP_TEST
		? TEST_GLOW_AFTER_MS
		: GLOW_AFTER_MS;

/** What the glow follows: the connection's status, and whether a call runs. */
export type GlowInput = Pick<PanelState, "status" | "calling">;

/** The timers the glow uses: the browser's, or a test's. */
export interface GlowTimers {
	set(run: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const browserTimers: GlowTimers = {
	set: (run, ms) => setTimeout(run, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The glow of one panel; `show(on)` puts it on the switch or takes it off. */
export class Glow {
	readonly #show: (on: boolean) => void;
	readonly #after: number;
	readonly #timers: GlowTimers;
	#on = false;
	/** The hold after the last call, while it runs. */
	#hold: unknown;

	constructor(
		show: (on: boolean) => void,
		after = glowAfterMs,
		timers: GlowTimers = browserTimers,
	) {
		this.#show = show;
		this.#after = after;
		this.#timers = timers;
	}

	/** Whether it glows now. */
	get on(): boolean {
		return this.#on;
	}

	/** Follow a state from the worker. */
	update(state: GlowInput): void {
		const up = state.status === "on" || state.status === "waiting";
		if (!up || state.calling) {
			this.#stopHold();
			this.#set(up);
			return;
		}
		// No call runs: the glow stays for the hold, from the first state
		// that says so; a later state starts no new one.
		if (!this.#on || this.#hold !== undefined) return;
		this.#hold = this.#timers.set(() => {
			this.#hold = undefined;
			this.#set(false);
		}, this.#after);
	}

	#stopHold(): void {
		if (this.#hold === undefined) return;
		this.#timers.clear(this.#hold);
		this.#hold = undefined;
	}

	#set(on: boolean): void {
		if (on === this.#on) return;
		this.#on = on;
		this.#show(on);
	}
}
