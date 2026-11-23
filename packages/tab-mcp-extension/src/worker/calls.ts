/**
 * The AI apps' tool calls that run through the extension now, from the
 * library's `toolcall` and `toolcallend` events: every tool of the
 * extension's (page_info, webmcp_tools, webmcp_call, the page_<name> tools,
 * the navigation tools), a call that waits for the user's answer included.
 * The library gives every start its end, also when the tool fails, the user
 * declines or the AI app cancels.
 *
 * The panel needs only whether one runs (DEC-225): `changed` is called when
 * that flips, not for every call, so calls that overlap cost the panel's
 * port two states however many there are.
 */

import type { TabMcpEventMap } from "@ractive-ch/tab-mcp-client";

export class RunningCalls {
	/** The calls running, by the library's id (unique in the worker). */
	readonly #ids = new Set<number>();
	readonly #changed: () => void;

	constructor(changed: () => void) {
		this.#changed = changed;
	}

	/** A call runs now. */
	get any(): boolean {
		return this.#ids.size > 0;
	}

	/**
	 * Follow the calls of `mcp` until `signal` aborts. The calls of the
	 * connection before are cleared here: its ends still fire, but its
	 * listeners went with its signal, so they would never be counted off
	 * (its calls in flight end as that connection is disconnected).
	 */
	watch(mcp: EventTarget, signal: AbortSignal): void {
		this.#set(() => this.#ids.clear());
		mcp.addEventListener(
			"toolcall",
			(event) => this.#set(() => this.#ids.add(idOf(event))),
			{ signal },
		);
		mcp.addEventListener(
			"toolcallend",
			(event) => this.#set(() => this.#ids.delete(idOf(event))),
			{ signal },
		);
	}

	#set(change: () => void): void {
		const was = this.any;
		change();
		if (this.any !== was) this.#changed();
	}
}

/** The call's id, as the library's `ToolCallStart` and `ToolCallEnd` have it. */
const idOf = (event: Event) =>
	(event as TabMcpEventMap["toolcall"] | TabMcpEventMap["toolcallend"]).detail
		.id;
