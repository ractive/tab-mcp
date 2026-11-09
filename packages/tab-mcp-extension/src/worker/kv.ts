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
		transaction.onerror = () => reject(transaction.error);
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
			for (const [key, value] of Object.entries(entries)) s.put(value, key);
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
			for (const [key, value] of Object.entries(entries))
				data.set(key, structuredClone(value));
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

/**
 * Move the settings from `chrome.storage.local` into `kv`, once. Crash-safe
 * and idempotent: the entries are written first, then removed from the old
 * area; one already in `kv` (from a migration a crash cut short) is kept, as
 * it may have changed since. Returns the keys moved.
 */
export async function migrate(old: OldArea, kv: Kv): Promise<string[]> {
	const stored = await old.get(null);
	const keys = Object.keys(stored).filter(isSettingKey);
	if (keys.length === 0) return [];
	const present = await kv.all();
	const missing = Object.fromEntries(
		keys.filter((k) => !(k in present)).map((k) => [k, stored[k]]),
	);
	if (Object.keys(missing).length > 0) await kv.set(missing);
	await old.remove(keys);
	return keys;
}
