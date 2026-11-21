/**
 * The settings the worker keeps in its IndexedDB (`kv.ts`): the relay the
 * user chose, whether AI access is on, whether the address was taken over,
 * and the paired AI apps as last listed.
 */

import type { GrantView } from "../protocol.ts";
import { DEFAULT_RELAY, relayProblem } from "../relay.ts";
import type { Kv } from "./kv.ts";

const RELAY = "relay";
const AI_ON = "aiOn";
const REPLACED = "replaced";
const GRANTS = "grants";
const FILL_FOR = "fillCodeFor";
const FILL_LOST = "fillCodeLost";

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

/**
 * The paired AI apps as the relay last listed them: the panel shows them
 * while AI access is off or down, when a new worker's library knows of none
 * (EQ 8). Only what the panel shows; the relay's list replaces it once
 * connected.
 */
export async function loadGrants(kv: Kv): Promise<GrantView[]> {
	const stored = await kv.get(GRANTS);
	if (!Array.isArray(stored)) return [];
	return stored
		.filter(
			(g): g is GrantView =>
				typeof g === "object" &&
				g !== null &&
				typeof g.grantId === "string" &&
				typeof g.name === "string" &&
				typeof g.host === "string",
		)
		.map(({ grantId, name, host }) => ({ grantId, name, host }));
}

export async function saveGrants(kv: Kv, grants: GrantView[]): Promise<void> {
	await kv.set({ [GRANTS]: grants });
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

/**
 * The relay for which the user turned on filling in the code on its pairing
 * page (DEC-203), or `undefined`: off by default, and off for any other
 * relay until turned on there.
 */
export async function loadFillFor(kv: Kv): Promise<string | undefined> {
	const stored = await kv.get(FILL_FOR);
	return typeof stored === "string" ? stored : undefined;
}

export async function saveFillFor(
	kv: Kv,
	relay: string | undefined,
): Promise<void> {
	if (relay === undefined) await kv.remove(FILL_FOR);
	else await kv.set({ [FILL_FOR]: relay });
}

/**
 * The relay for which filling in went off by itself because its site was
 * taken away (in the browser's settings), or `undefined`: the panel says so
 * until the user turns it on or off, or uses another relay.
 */
export async function loadFillLost(kv: Kv): Promise<string | undefined> {
	const stored = await kv.get(FILL_LOST);
	return typeof stored === "string" ? stored : undefined;
}

export async function saveFillLost(
	kv: Kv,
	relay: string | undefined,
): Promise<void> {
	if (relay === undefined) await kv.remove(FILL_LOST);
	else await kv.set({ [FILL_LOST]: relay });
}
