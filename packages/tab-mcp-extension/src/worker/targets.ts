/**
 * Where an AI app's call goes (iteration 53, DEC-230): the tab in front (the
 * default, as before) or a pinned tab, one setting for the browser. In mode
 * "a pinned tab" the first call without a pin pins the tab in front at that
 * moment, and later calls go to that tab wherever the user is: switching
 * tabs moves nothing. A pinned tab that was closed fails the call, with the
 * hint to call list_tabs: a call never lands in another tab by itself. A
 * call's `tab` argument (an id from list_tabs) always wins and leaves the
 * pin as it is.
 *
 * The mode and the pin live behind `TargetStore`: for now the mode in the
 * worker's IndexedDB and the pin in the browser session's storage
 * (`kvTargetStore`); later the relay's record of a signed-in group. Tab ids are the
 * browser's, as decimal strings; a group's will carry a member before them
 * (`<member>:<tab>`), which the relay takes off before the call reaches the
 * extension.
 */

import type { TargetTab } from "../tabs.ts";
import type { Kv } from "./kv.ts";

/** "the tab in front" or "a pinned tab". */
export type TargetMode = "front" | "pinned";

/** The setting: the mode, and in mode "pinned" the pinned tab once there is one. */
export interface TargetSetting {
	mode: TargetMode;
	/** The pinned tab's id (mode "pinned" only); none until a call or the user pins one. */
	pin?: number;
}

/** Where the setting is kept. */
export interface TargetStore {
	load(): Promise<TargetSetting>;
	save(setting: TargetSetting): Promise<void>;
}

const KEY = "aiTarget";

/** A stored setting, checked: anything else is the default, the tab in front. */
export function parseTargetSetting(stored: unknown): TargetSetting {
	if (typeof stored !== "object" || stored === null) return { mode: "front" };
	const { mode, pin } = stored as Record<string, unknown>;
	if (mode !== "pinned") return { mode: "front" };
	return typeof pin === "number" && Number.isSafeInteger(pin) && pin >= 0
		? { mode, pin }
		: { mode };
}

/** A store of the browser session: what `chrome.storage.session` gives. */
export interface SessionArea {
	get(key: string): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(key: string): Promise<void>;
}

const PIN = "pinnedTab";

/**
 * The mode in the worker's IndexedDB (`kv.ts`), as `allowedTools` is; the
 * pin in `session`, `chrome.storage.session`, which the browser empties with
 * every browser session (tab ids start anew then, and an old pin could name
 * another tab) and which content scripts cannot reach. A pin of the session
 * before is so never read, whatever the extension was told of the start
 * (nothing, when it was off then).
 */
export function kvTargetStore(kv: Kv, session: SessionArea): TargetStore {
	return {
		async load() {
			const { mode } = parseTargetSetting(await kv.get(KEY));
			if (mode === "front") return { mode };
			const pin = (await session.get(PIN))[PIN];
			return parseTargetSetting({ mode, pin });
		},
		async save({ mode, pin }) {
			await kv.set({ [KEY]: { mode } });
			if (pin === undefined) await session.remove(PIN);
			else await session.set({ [PIN]: pin });
		},
	};
}

/** `chrome.storage.session` as a `SessionArea`. */
export function chromeSession(): SessionArea {
	return {
		get: (key) => chrome.storage.session.get(key),
		set: (items) => chrome.storage.session.set(items),
		remove: (key) => chrome.storage.session.remove(key),
	};
}

/** A `SessionArea` in memory, for tests (no product code uses it). */
export function memorySession(): SessionArea & {
	data: Map<string, unknown>;
} {
	const data = new Map<string, unknown>();
	return {
		data,
		get: async (key) => (data.has(key) ? { [key]: data.get(key) } : {}),
		async set(items) {
			for (const [key, value] of Object.entries(items)) data.set(key, value);
		},
		async remove(key) {
			data.delete(key);
		},
	};
}

/** What the targets need from the browser. */
export interface TargetChrome {
	/** The tab in front (`tabInFront`); throws when there is none. */
	front(): Promise<TargetTab>;
	/** Tab `id` if it is open in a normal window, `undefined` otherwise. */
	tab(id: number): Promise<TargetTab | undefined>;
	/** Whether the extension may read `tab` now (`page_info` would answer). */
	mayPin(tab: TargetTab): Promise<boolean>;
}

/** What a call that cannot find its tab tells the AI app to do. */
export const LIST_TABS_HINT =
	"Call list_tabs for the tabs you may use, then pass tab with the call, or use_tab to pin one.";

/** The id of tab `id` as list_tabs gives it, and as the `tab` argument takes it. */
export const tabArgument = (id: number): string => String(id);

/** The browser's id of the tab a `tab` argument names; throws if it names none. */
export function tabIdOf(tab: string): number {
	const id = /^\d{1,15}$/.test(tab) ? Number(tab) : Number.NaN;
	if (!Number.isSafeInteger(id))
		throw new TypeError(
			`Not a tab id from list_tabs: ${JSON.stringify(tab.slice(0, 40))}. ${LIST_TABS_HINT}`,
		);
	return id;
}

export class Targets {
	readonly #store: TargetStore;
	readonly #chrome: TargetChrome;
	readonly #changed: () => void;
	/** The setting as last loaded or saved. */
	#setting: Promise<TargetSetting> | undefined;
	/** Pinning and setting, one after the other: two first calls pin one tab. */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(
		store: TargetStore,
		chrome: TargetChrome,
		changed: () => void = () => {},
	) {
		this.#store = store;
		this.#chrome = chrome;
		this.#changed = changed;
	}

	/** The setting now. One that cannot be loaded is the default, and is loaded again next time. */
	setting(): Promise<TargetSetting> {
		if (this.#setting === undefined) {
			const loading: Promise<TargetSetting> = this.#store.load().catch(() => {
				if (this.#setting === loading) this.#setting = undefined;
				return { mode: "front" };
			});
			this.#setting = loading;
		}
		return this.#setting;
	}

	/**
	 * The tab a call goes to: the one `tab` names, else the pinned tab, else
	 * the tab in front; in mode "pinned" without a pin, the tab in front,
	 * pinned now.
	 */
	forCall(tab?: string): Promise<TargetTab> {
		if (tab !== undefined) return this.#named(tab);
		return this.#serial(async () => {
			const setting = await this.setting();
			if (setting.mode === "front") return this.#chrome.front();
			if (setting.pin !== undefined) return this.#pinned(setting.pin);
			const front = await this.#chrome.front();
			// Only a tab the extension may read, as use_tab pins: a new tab
			// page or a tab without a grant is answered as in mode "the tab
			// in front" (the call says why it cannot read it), and the next
			// call may pin.
			if (await this.#chrome.mayPin(front))
				await this.#save({ mode: "pinned", pin: front.id });
			return front;
		});
	}

	/**
	 * The same without pinning: the tab whose tools the bridge offers, and
	 * the check after a question that the call's tab is still the target.
	 */
	async peek(tab?: string): Promise<TargetTab> {
		if (tab !== undefined) return this.#named(tab);
		const setting = await this.setting();
		if (setting.mode === "pinned" && setting.pin !== undefined)
			return this.#pinned(setting.pin);
		return this.#chrome.front();
	}

	/**
	 * Before the call of a `page_<name>` tool offered from tab `id`: whether
	 * it may run there. In mode "the tab in front" always, as before (the
	 * tools follow that tab); in mode "pinned" only in the pinned tab, and
	 * without a pin it pins tab `id`, where the call goes (the tab in front
	 * when its tools were read).
	 */
	callIn(id: number): Promise<boolean> {
		return this.#serial(async () => {
			const setting = await this.setting();
			if (setting.mode === "front") return true;
			if (setting.pin !== undefined) return setting.pin === id;
			await this.#save({ mode: "pinned", pin: id });
			return true;
		});
	}

	/** `use_tab` and the panel's "Work here": pin tab `id`, in mode "pinned". */
	use(id: number): Promise<void> {
		return this.#serial(() => this.#save({ mode: "pinned", pin: id }));
	}

	/**
	 * The panel's setting. "the tab in front" drops the pin; "a pinned tab"
	 * pins at the next call (a pin there is already stays).
	 */
	setMode(mode: TargetMode): Promise<void> {
		return this.#serial(async () => {
			const setting = await this.setting();
			if (setting.mode === mode) return;
			await this.#save({ mode });
		});
	}

	async #named(tab: string): Promise<TargetTab> {
		const found = await this.#chrome.tab(tabIdOf(tab));
		if (found === undefined)
			throw new Error(
				`No tab ${tab} is open: it was closed, or the id is not one list_tabs gave. ${LIST_TABS_HINT}`,
			);
		return found;
	}

	async #pinned(id: number): Promise<TargetTab> {
		const found = await this.#chrome.tab(id);
		if (found === undefined)
			throw new Error(
				`The pinned tab was closed; nothing was done in another tab. ${LIST_TABS_HINT}`,
			);
		return found;
	}

	async #save(setting: TargetSetting): Promise<void> {
		await this.#store.save(setting);
		this.#setting = Promise.resolve(setting);
		this.#changed();
	}

	#serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(task);
		this.#queue = run.catch(() => {});
		return run;
	}
}
