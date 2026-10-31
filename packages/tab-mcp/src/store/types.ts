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
 *   even when several run at the same time; that call also cuts `expiresAt`
 *   to its `keepUntil` (never extends it).
 * - `revoke` leaves a tombstone at least until `keepUntil`: until then `put` refuses
 *   (returns `false`, stores nothing) a record of a revoked grant, or of a
 *   grant of a revoked address created at or before the revocation. Checking
 *   the tombstone and inserting must be atomic, so tokens minted by a refresh
 *   that raced a revocation can never outlive it.
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
	/**
	 * Identity binding (DEC-077): the hashed (provider, subject) the grant was
	 * made for. Must be stored and returned unchanged; a store that drops it
	 * makes every request of such a grant fail as a mismatch.
	 */
	subject?: string;
	/**
	 * Client authentication binding (DEC-106): `private_key_jwt` when the
	 * grant was made or refreshed with a client assertion; its refresh tokens
	 * then need one too. Must be stored and returned unchanged: a store that
	 * drops it lets such a grant's refresh tokens be redeemed without the
	 * client's key.
	 */
	clientAuth?: "private_key_jwt";
}

/** One connected AI app of an address. */
export interface GrantSummary {
	grantId: string;
	clientId: string;
	clientName: string;
	scopes: string[];
	createdAt: number;
	/** The grant's `subject`, if it has one (DEC-077). */
	subject?: string;
}

export type RevokeSelector = { grantId: string } | { addressId: string };

export interface RevokeOptions {
	/** When the revocation happens. */
	now: number;
	/** Keep the tombstone until then (the longest a token issued before could live). */
	keepUntil: number;
}

export interface TokenStore {
	/**
	 * Insert or replace a token record. Returns `false`, and stores nothing,
	 * if its grant was revoked (see the tombstone rule above).
	 */
	put(record: TokenRecord): Promise<boolean>;
	/** The record for a token hash, or `undefined`. */
	get(hash: string): Promise<TokenRecord | undefined>;
	/**
	 * Mark a token as used at `now` and cut its `expiresAt` to `keepUntil`
	 * if that is earlier (never later), in one step. Returns `true` for the
	 * one call that marked it, `false` (changing nothing) if it was already
	 * used or does not exist. Must be atomic.
	 *
	 * The relay keeps a used refresh token only to detect its reuse, for a
	 * window (24 hours, DEC-091); the cut lets `deleteExpired` drop it then.
	 * A store that ignores `keepUntil` stays correct but keeps every used
	 * refresh token until its own expiry.
	 */
	markUsed(hash: string, now: number, keepUntil: number): Promise<boolean>;
	/**
	 * Delete every token of a grant or of an address and leave a tombstone
	 * until `options.keepUntil`. Returns how many tokens were deleted.
	 */
	revoke(selector: RevokeSelector, options: RevokeOptions): Promise<number>;
	/**
	 * The grants of an address that still have a usable token at `now` (an
	 * unexpired access token or an unexpired, unused refresh token), oldest
	 * first.
	 */
	listGrants(addressId: string, now: number): Promise<GrantSummary[]>;
	/** Delete every record with `expiresAt <= now` and tombstones past `keepUntil`. Returns how many records. */
	deleteExpired(now: number): Promise<number>;
	/**
	 * Optional (DEC-106): remember a one-time value (the hash of a client
	 * assertion's client id and `jti`) until `expiresAt`. Returns `true` for
	 * the one call that recorded it, `false` while it is remembered; an entry
	 * with `expiresAt <= now` counts as absent. Must be atomic, like
	 * `markUsed`. `deleteExpired` should drop expired entries. Without it the
	 * relay remembers them in its own memory, which is per instance.
	 */
	claimNonce?(key: string, expiresAt: number, now: number): Promise<boolean>;
	/** Release resources (database handles). Optional. */
	close?(): Promise<void>;
}
