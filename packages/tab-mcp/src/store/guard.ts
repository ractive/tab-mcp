import type { TokenStore } from "./types.ts";

/**
 * A token store call failed. The relay wraps its store (`guardStore`), so a
 * store failure can be told from any other error wherever it surfaces: it is
 * logged as `store.error`, and the AI app or page is told to try again
 * instead of being blamed (RQ 5, DEC-131). `cause` is the store's own error;
 * only its name and code are logged.
 */
export class StoreFailure extends Error {
	override name = "StoreFailure";
	/** The store method that failed (`get`, `put`, `markUsed`, …). */
	readonly method: string;
	constructor(method: string, cause: unknown) {
		super(`the token store failed (${method})`, { cause });
		this.method = method;
	}
}

const METHODS = [
	"put",
	"get",
	"markUsed",
	"revoke",
	"listGrants",
	"deleteExpired",
	"claimNonce",
] as const;

/**
 * The same store, with every failure of its methods (a rejection or a
 * synchronous throw) turned into a rejected `StoreFailure`. Results pass
 * through unchanged; `claimNonce` and `close` stay optional.
 */
export function guardStore(store: TokenStore): TokenStore {
	const guarded: Record<string, unknown> = {};
	for (const method of METHODS) {
		if (store[method] === undefined) continue;
		guarded[method] = (...args: unknown[]) => {
			try {
				const fn = store[method] as (...a: unknown[]) => unknown;
				return Promise.resolve(fn.apply(store, args)).catch((error) => {
					throw new StoreFailure(method, error);
				});
			} catch (error) {
				return Promise.reject(new StoreFailure(method, error));
			}
		};
	}
	if (store.close !== undefined) guarded["close"] = () => store.close?.();
	return guarded as unknown as TokenStore;
}
