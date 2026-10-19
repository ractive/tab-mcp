/**
 * The token store (DEC-030, DEC-041): where the relay keeps grants and the
 * hashes of access and refresh tokens. Implementations: `MemoryTokenStore`,
 * `SqliteTokenStore`, or the library user's own (Prisma, Redis, libSQL, …),
 * checked with the conformance suite in `@ractive-ch/tab-mcp/testing`.
 *
 * Guarantees every implementation must give:
 * - Records are keyed by `hash`, the SHA-256 of the token; plain tokens never
 *   reach the store.
 * - `put` inserts or replaces the record with the same hash.
 * - `get` returns the record even when it is expired or used; the caller
 *   decides. It returns `undefined` after `revoke` or `deleteExpired` removed it.
 * - `markUsed` is atomic: for one hash, exactly one call ever returns `true`,
 *   even when several run at the same time.
 * - Times are milliseconds since the Unix epoch.
 */

export type TokenKind = "access" | "refresh";

export interface TokenRecord {
	/** SHA-256 of the token, base64url without padding. */
	hash: string;
	kind: TokenKind;
	grantId: string;
	/** The address the grant belongs to (DEC-027). */
	addressId: string;
	/** The OAuth client id (the CIMD URL). */
	clientId: string;
	/** The client's self-declared name, for display only. */
	clientName: string;
	scopes: string[];
	/** When the grant was created (the first token of the grant). */
	grantCreatedAt: number;
	issuedAt: number;
	expiresAt: number;
	/** Refresh tokens: when it was exchanged for a new one. */
	usedAt?: number;
}

/** One connected AI app of an address. */
export interface GrantSummary {
	grantId: string;
	clientId: string;
	clientName: string;
	scopes: string[];
	createdAt: number;
}

export type RevokeSelector = { grantId: string } | { addressId: string };

export interface TokenStore {
	/** Insert or replace a token record. */
	put(record: TokenRecord): Promise<void>;
	/** The record for a token hash, or `undefined`. */
	get(hash: string): Promise<TokenRecord | undefined>;
	/**
	 * Mark a token as used at `now`. Returns `true` for the one call that marked
	 * it, `false` if it was already used or does not exist. Must be atomic.
	 */
	markUsed(hash: string, now: number): Promise<boolean>;
	/** Delete every token of a grant or of an address. Returns how many. */
	revoke(selector: RevokeSelector): Promise<number>;
	/**
	 * The grants of an address that still have a usable token at `now` (an
	 * unexpired access token or an unexpired, unused refresh token), oldest
	 * first.
	 */
	listGrants(addressId: string, now: number): Promise<GrantSummary[]>;
	/** Delete every record with `expiresAt <= now`. Returns how many. */
	deleteExpired(now: number): Promise<number>;
	/** Release resources (database handles). Optional. */
	close?(): Promise<void>;
}
