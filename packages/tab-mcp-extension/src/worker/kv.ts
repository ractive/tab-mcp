/**
 * The extension's settings in IndexedDB, in the extension's own origin and
 * used from the service worker only (DEC-116). Content scripts run in the
 * page's origin and cannot reach it, whatever Chrome's version and from the
 * first moment of a browser start; `chrome.storage.local` they can read and
 * write by default.
 */

/** What the worker keeps: a key, a value that IndexedDB can clone. */
export interface Kv {
	get(key: string): Promise<unknown>;
	/** Every entry. */
	all(): Promise<Record<string, unknown>>;
	/** Write several entries at once (one transaction). */
	set(entries: Record<string, unknown>): Promise<void>;
	remove(key: string): Promise<void>;
}

const DATABASE = "tab-mcp";
const STORE = "settings";

const done = <T>(request: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

const finished = (transaction: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		// A failed request's error comes before the abort sets transaction.error.
		transaction.onerror = (event) =>
			reject((event.target as IDBRequest | null)?.error ?? transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});

/** The settings database of the extension, opened (and made the first time). */
export async function openKv(name = DATABASE): Promise<Kv> {
	const open = indexedDB.open(name, 1);
	open.onupgradeneeded = () => open.result.createObjectStore(STORE);
	const db = await done(open);
	const store = (mode: IDBTransactionMode) =>
		db.transaction(STORE, mode).objectStore(STORE);
	return {
		get: (key) => done(store("readonly").get(key)),
		async all() {
			const s = store("readonly");
			const [keys, values] = await Promise.all([
				done(s.getAllKeys()),
				done(s.getAll()),
			]);
			return Object.fromEntries(keys.map((k, i) => [String(k), values[i]]));
		},
		set(entries) {
			const s = store("readwrite");
			try {
				for (const [key, value] of Object.entries(entries)) s.put(value, key);
			} catch (error) {
				// A value IndexedDB cannot clone throws here, after earlier puts:
				// abort so all or none of the entries land (the migration's marker
				// must not land without its entries).
				s.transaction.abort();
				return Promise.reject(error);
			}
			return finished(s.transaction);
		},
		remove(key) {
			const s = store("readwrite");
			s.delete(key);
			return finished(s.transaction);
		},
	};
}

/** A `Kv` in memory, for tests. */
export function memoryKv(initial: Record<string, unknown> = {}): Kv & {
	data: Map<string, unknown>;
} {
	const data = new Map(Object.entries(initial));
	return {
		data,
		get: async (key) => data.get(key),
		all: async () => Object.fromEntries(data),
		async set(entries) {
			// Clone all first, as IndexedDB's transaction is all or nothing.
			const cloned = Object.entries(entries).map(
				([key, value]) => [key, structuredClone(value)] as const,
			);
			for (const [key, value] of cloned) data.set(key, value);
		},
		async remove(key) {
			data.delete(key);
		},
	};
}

/** The keys that used to be in `chrome.storage.local` (before IndexedDB). */
export function isSettingKey(key: string): boolean {
	return (
		key === "relay" ||
		key === "aiOn" ||
		key === "replaced" ||
		key === "allowedTools" ||
		key.startsWith("tab-mcp:secret:")
	);
}

/** What the migration needs of `chrome.storage.local`. */
export interface OldArea {
	get(keys: null): Promise<Record<string, unknown>>;
	remove(keys: string[]): Promise<void>;
}

/** In `kv` once the settings were moved: from then on nothing is taken from the old area. */
export const MIGRATED = "migrated";

/**
 * Move the settings from `chrome.storage.local` into `kv`, once: the moved
 * entries and the `MIGRATED` marker are written in one transaction, also when
 * there was nothing to move (a first start), then the old keys are removed.
 * After that nothing is ever taken from the old area again: where Chrome does
 * not keep content scripts out of it, one could write a relay or a secret
 * there for the next start to pick up. What setting keys are still found
 * there (a removal a crash cut short, or a content script's) are only
 * removed. A key already in `kv` is kept. Returns the keys moved.
 */
export async function migrate(old: OldArea, kv: Kv): Promise<string[]> {
	const done = (await kv.get(MIGRATED)) !== undefined;
	const stored = await old.get(null);
	const keys = Object.keys(stored).filter(isSettingKey);
	if (done) {
		if (keys.length > 0) await old.remove(keys);
		return [];
	}
	const present = await kv.all();
	const missing = Object.fromEntries(
		keys.filter((k) => !(k in present)).map((k) => [k, stored[k]]),
	);
	await kv.set({ ...missing, [MIGRATED]: 1 });
	if (keys.length > 0) await old.remove(keys);
	return Object.keys(missing);
}
