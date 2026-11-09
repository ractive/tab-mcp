/**
 * The address secret's storage in the service worker, which has no
 * `localStorage`: the library reads and writes it synchronously, so the
 * entries are loaded from the worker's IndexedDB (`kv.ts`) before the
 * connection is made, read from memory and written through.
 */

import type { SecretStorage } from "@ractive-ch/tab-mcp-client";
import type { Kv } from "./kv.ts";

/** The library's keys start so (`tab-mcp:secret:<relay origin>:<name>`). */
const PREFIX = "tab-mcp:secret:";

export class CachedSecretStorage implements SecretStorage {
	readonly #kv: Kv;
	readonly #cache: Map<string, string>;
	/** The last write, for tests and for a clean shutdown. */
	written: Promise<void> = Promise.resolve();

	private constructor(kv: Kv, cache: Map<string, string>) {
		this.#kv = kv;
		this.#cache = cache;
	}

	/** The secrets kept in `kv`, loaded. */
	static async load(kv: Kv): Promise<CachedSecretStorage> {
		const all = await kv.all();
		const cache = new Map<string, string>();
		for (const [key, value] of Object.entries(all))
			if (key.startsWith(PREFIX) && typeof value === "string")
				cache.set(key, value);
		return new CachedSecretStorage(kv, cache);
	}

	getItem(key: string): string | null {
		return this.#cache.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.#cache.set(key, value);
		// Writes go out in order; one that fails leaves the secret in memory
		// for this worker's life (the address changes after a restart).
		this.written = this.written
			.then(() => this.#kv.set({ [key]: value }))
			.catch((error: unknown) =>
				console.warn("tab-mcp: keeping the address secret", error),
			);
	}
}
