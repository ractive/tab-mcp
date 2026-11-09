/**
 * The extension's settings in IndexedDB, in the extension's own origin and
 * used from the service worker only (DEC-116). Content scripts run in the
 * page's origin and cannot reach it, whatever Chrome's version and from the
 * first moment of a browser start. The extension asks for no `storage`
 * permission: there is no `chrome.storage` area a content script could read
 * or write.
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

function openDatabase(name: string): Promise<IDBDatabase> {
	const open = indexedDB.open(name, 1);
	open.onupgradeneeded = () => open.result.createObjectStore(STORE);
	return done(open);
}

/**
 * The settings database of the extension, opened (and made the first time).
 * The connection is held lazily: when Chrome closes it under the worker
 * (`close`: the site data was cleared, the database deleted) or another
 * connection asks for a new version (`versionchange`, answered by closing),
 * the next call opens it again instead of using a dead handle.
 */
export async function openKv(name = DATABASE): Promise<Kv> {
	let connection: Promise<IDBDatabase> | undefined;
	const db = (): Promise<IDBDatabase> => {
		if (connection === undefined) {
			const opening = openDatabase(name).then((opened) => {
				const forget = () => {
					if (connection === opening) connection = undefined;
				};
				opened.onclose = forget;
				opened.onversionchange = () => {
					opened.close();
					forget();
				};
				return opened;
			});
			// A failed open is not kept: the next call tries again.
			opening.catch(() => {
				if (connection === opening) connection = undefined;
			});
			connection = opening;
		}
		return connection;
	};
	const store = async (mode: IDBTransactionMode) => {
		const opened = await db();
		try {
			return opened.transaction(STORE, mode).objectStore(STORE);
		} catch (error) {
			// Closing under us (InvalidStateError): once more, on a new one.
			if ((error as DOMException).name !== "InvalidStateError") throw error;
			if (connection !== undefined && (await connection) === opened)
				connection = undefined;
			return (await db()).transaction(STORE, mode).objectStore(STORE);
		}
	};
	// Opened now, so a database that cannot be opened stops the start.
	await db();
	return {
		get: async (key) => done((await store("readonly")).get(key)),
		async all() {
			const s = await store("readonly");
			const [keys, values] = await Promise.all([
				done(s.getAllKeys()),
				done(s.getAll()),
			]);
			return Object.fromEntries(keys.map((k, i) => [String(k), values[i]]));
		},
		async set(entries) {
			const s = await store("readwrite");
			try {
				for (const [key, value] of Object.entries(entries)) s.put(value, key);
			} catch (error) {
				// A value IndexedDB cannot clone throws here, after earlier puts:
				// abort so all or none of the entries land.
				s.transaction.abort();
				throw error;
			}
			return finished(s.transaction);
		},
		async remove(key) {
			const s = await store("readwrite");
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
