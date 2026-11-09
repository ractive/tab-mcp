/**
 * The address secret's storage in the service worker, which has no
 * `localStorage`: the library reads and writes it synchronously, so the
 * entries are loaded from `chrome.storage.local` before the connection is
 * made, read from memory and written through.
 */

import type { SecretStorage } from "@ractive-ch/tab-mcp-client";

/** The library's keys start so (`tab-mcp:secret:<relay origin>:<name>`). */
const PREFIX = "tab-mcp:secret:";

/** What it needs of `chrome.storage.local`. */
export interface Area {
	get(keys: null): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
}

export class CachedSecretStorage implements SecretStorage {
	readonly #area: Area;
	readonly #cache: Map<string, string>;
	/** The last write, for tests and for a clean shutdown. */
	written: Promise<void> = Promise.resolve();

	private constructor(area: Area, cache: Map<string, string>) {
		this.#area = area;
		this.#cache = cache;
	}

	/** The secrets kept in `area`, loaded. */
	static async load(area: Area): Promise<CachedSecretStorage> {
		const all = await area.get(null);
		const cache = new Map<string, string>();
		for (const [key, value] of Object.entries(all))
			if (key.startsWith(PREFIX) && typeof value === "string")
				cache.set(key, value);
		return new CachedSecretStorage(area, cache);
	}

	getItem(key: string): string | null {
		return this.#cache.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.#cache.set(key, value);
		// Writes go out in order; one that fails leaves the secret in memory
		// for this worker's life (the address changes after a restart).
		this.written = this.written
			.then(() => this.#area.set({ [key]: value }))
			.catch((error: unknown) =>
				console.warn("tab-mcp: keeping the address secret", error),
			);
	}
}
