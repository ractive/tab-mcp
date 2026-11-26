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
	/**
	 * The app of that address: the `<app>` of `/s/<app>/mcp`, where the token
	 * is valid (DEC-196). Must be stored and returned unchanged: a store that
	 * drops it makes every token invalid.
	 */
	app: string;
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

/**
 * A browser's sign-in (DEC-231): the address id of a signed-in browser
 * (its extension's page) bound to an account. Every binding with the same
 * `group` is a member of that account's group.
 */
export interface BindingRecord {
	/** The browser's address id; one binding per address. */
	addressId: string;
	/** A hash of the provider and the account's stable id, never the account itself. */
	group: string;
	/** The member's id as the group sees it; it does not reveal the address id. */
	memberId: string;
	/** The provider signed in with (`google`, `microsoft`, `github`). */
	provider: string;
	/** The app of the address (the extension's app id). */
	app: string;
	/** The member's name in the group ("Chrome on macOS"), renamable by any member. */
	label: string;
	/** When the browser signed in. */
	createdAt: number;
	/** When the binding ends without a new sign-in (90 days after it). */
	expiresAt: number;
}

/** One binding, by its address or by its member id in a group. */
export type BindingSelector =
	| { addressId: string }
	| { group: string; memberId: string };

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
	/**
	 * Delete every record with `expiresAt <= now` and tombstones past
	 * `keepUntil` (and expired bindings, where the store has them). Returns
	 * how many token records.
	 */
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
	/**
	 * Optional, all five or none (DEC-231): the bindings of signed-in
	 * browsers. A relay that lets browsers sign in (`signIn`) refuses to start
	 * with a store that lacks them. Bindings with `expiresAt <= now` count as
	 * absent everywhere; `deleteExpired` should drop them.
	 *
	 * `putBinding` inserts the binding of `record.addressId`, or replaces it
	 * (a browser that signs in again, also with another account). It returns
	 * `"full"`, and stores nothing, when the group already has `maxMembers`
	 * live bindings of other addresses. Counting and inserting must be atomic,
	 * so two browsers signing in at once cannot both take the last place.
	 * `memberId` is unique across groups.
	 */
	putBinding?(
		record: BindingRecord,
		maxMembers: number,
		now: number,
	): Promise<"ok" | "full">;
	/** The live binding of an address, or `undefined`. */
	getBinding?(
		addressId: string,
		now: number,
	): Promise<BindingRecord | undefined>;
	/** The live bindings of a group, oldest first. */
	listBindings?(group: string, now: number): Promise<BindingRecord[]>;
	/** Rename a live member of a group; `false` if there is none. */
	renameBinding?(
		group: string,
		memberId: string,
		label: string,
		now: number,
	): Promise<boolean>;
	/** Delete one binding; returns it (live or not), or `undefined` if there was none. */
	deleteBinding?(selector: BindingSelector): Promise<BindingRecord | undefined>;
	/** Release resources (database handles). Optional. */
	close?(): Promise<void>;
}
