/**
 * The settings the worker keeps in its IndexedDB (`kv.ts`): the relay the
 * user chose, whether AI access is on, and whether the address was taken
 * over.
 */

import { DEFAULT_RELAY, relayProblem } from "../relay.ts";
import type { Kv } from "./kv.ts";

const RELAY = "relay";
const AI_ON = "aiOn";
const REPLACED = "replaced";

export async function loadRelay(kv: Kv): Promise<string> {
	const stored = await kv.get(RELAY);
	return typeof stored === "string" && relayProblem(stored) === undefined
		? stored
		: DEFAULT_RELAY;
}

export async function saveRelay(kv: Kv, relay: string): Promise<void> {
	await kv.set({ [RELAY]: relay });
}

/** Whether the user left AI access on (connect again at the next start). */
export async function loadAiOn(kv: Kv): Promise<boolean> {
	return (await kv.get(AI_ON)) === true;
}

export async function saveAiOn(kv: Kv, on: boolean): Promise<void> {
	await kv.set({ [AI_ON]: on });
}

/**
 * Another tab or program took the address over (`replaced`): kept across
 * worker restarts, so a restart does not take the address back by itself
 * (and the two sides do not take it from each other every minute).
 */
export interface Replaced {
	sibling: boolean;
}

export async function loadReplaced(kv: Kv): Promise<Replaced | undefined> {
	const stored = await kv.get(REPLACED);
	return typeof stored === "object" &&
		stored !== null &&
		typeof (stored as Replaced).sibling === "boolean"
		? { sibling: (stored as Replaced).sibling }
		: undefined;
}

export async function saveReplaced(
	kv: Kv,
	replaced: Replaced | undefined,
): Promise<void> {
	if (replaced === undefined) await kv.remove(REPLACED);
	else await kv.set({ [REPLACED]: { sibling: replaced.sibling } });
}
