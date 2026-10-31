import type {
	GrantSummary,
	RevokeOptions,
	RevokeSelector,
	TokenRecord,
	TokenStore,
} from "./types.ts";

function copy(record: TokenRecord): TokenRecord {
	return { ...record, scopes: [...record.scopes] };
}

function matches(record: TokenRecord, selector: RevokeSelector): boolean {
	return "grantId" in selector
		? record.grantId === selector.grantId
		: record.addressId === selector.addressId;
}

/** Usable at `now`: unexpired, and for refresh tokens not yet used. */
export function isLive(record: TokenRecord, now: number): boolean {
	return (
		record.expiresAt > now &&
		(record.kind === "access" || record.usedAt === undefined)
	);
}

/** Group live records into grant summaries, oldest grant first. */
export function summarizeGrants(
	records: Iterable<TokenRecord>,
	now: number,
): GrantSummary[] {
	const grants = new Map<string, GrantSummary>();
	for (const r of records) {
		if (!isLive(r, now) || grants.has(r.grantId)) continue;
		const summary: GrantSummary = {
			grantId: r.grantId,
			clientId: r.clientId,
			clientName: r.clientName,
			scopes: [...r.scopes],
			createdAt: r.grantCreatedAt,
		};
		if (r.subject !== undefined) summary.subject = r.subject;
		grants.set(r.grantId, summary);
	}
	return [...grants.values()].sort(
		(a, b) => a.createdAt - b.createdAt || a.grantId.localeCompare(b.grantId),
	);
}

/**
 * One-time values (client assertion `jti`s, DEC-106) until their expiry, in
 * process memory: `TokenStore.claimNonce` for the memory store, and the
 * relay's own fallback for stores without it.
 */
export class NonceSet {
	readonly #until = new Map<string, number>();

	get size(): number {
		return this.#until.size;
	}

	claim(key: string, expiresAt: number, now: number): boolean {
		const until = this.#until.get(key);
		if (until !== undefined && until > now) return false;
		this.#until.set(key, expiresAt);
		return true;
	}

	sweep(now: number): number {
		let n = 0;
		for (const [key, until] of this.#until) {
			if (until <= now) {
				this.#until.delete(key);
				n++;
			}
		}
		return n;
	}

	clear(): void {
		this.#until.clear();
	}
}

/** Tokens in process memory; everything is lost on restart. */
export class MemoryTokenStore implements TokenStore {
	readonly #records = new Map<string, TokenRecord>();
	readonly #nonces = new NonceSet();
	/** Revoked grants: grant id → keep until. */
	readonly #revokedGrants = new Map<string, number>();
	/** Revoked addresses: address id → { at, keep until }. */
	readonly #revokedAddresses = new Map<string, { at: number; until: number }>();

	async put(record: TokenRecord): Promise<boolean> {
		if (this.#revokedGrants.has(record.grantId)) return false;
		const address = this.#revokedAddresses.get(record.addressId);
		if (address !== undefined && record.grantCreatedAt <= address.at) {
			return false;
		}
		this.#records.set(record.hash, copy(record));
		return true;
	}

	async get(hash: string): Promise<TokenRecord | undefined> {
		const r = this.#records.get(hash);
		return r === undefined ? undefined : copy(r);
	}

	async markUsed(
		hash: string,
		now: number,
		keepUntil: number,
	): Promise<boolean> {
		const r = this.#records.get(hash);
		if (r === undefined || r.usedAt !== undefined) return false;
		r.usedAt = now;
		r.expiresAt = Math.min(r.expiresAt, keepUntil);
		return true;
	}

	async revoke(
		selector: RevokeSelector,
		options: RevokeOptions,
	): Promise<number> {
		if ("grantId" in selector) {
			this.#revokedGrants.set(selector.grantId, options.keepUntil);
		} else {
			const old = this.#revokedAddresses.get(selector.addressId);
			this.#revokedAddresses.set(selector.addressId, {
				at: Math.max(old?.at ?? 0, options.now),
				until: Math.max(old?.until ?? 0, options.keepUntil),
			});
		}
		let n = 0;
		for (const [hash, r] of this.#records) {
			if (matches(r, selector)) {
				this.#records.delete(hash);
				n++;
			}
		}
		return n;
	}

	async listGrants(addressId: string, now: number): Promise<GrantSummary[]> {
		const own = [...this.#records.values()].filter(
			(r) => r.addressId === addressId,
		);
		return summarizeGrants(own, now);
	}

	async deleteExpired(now: number): Promise<number> {
		for (const [id, until] of this.#revokedGrants) {
			if (until <= now) this.#revokedGrants.delete(id);
		}
		for (const [id, t] of this.#revokedAddresses) {
			if (t.until <= now) this.#revokedAddresses.delete(id);
		}
		this.#nonces.sweep(now);
		let n = 0;
		for (const [hash, r] of this.#records) {
			if (r.expiresAt <= now) {
				this.#records.delete(hash);
				n++;
			}
		}
		return n;
	}

	async claimNonce(
		key: string,
		expiresAt: number,
		now: number,
	): Promise<boolean> {
		return this.#nonces.claim(key, expiresAt, now);
	}

	async close(): Promise<void> {
		this.#nonces.clear();
		this.#records.clear();
		this.#revokedGrants.clear();
		this.#revokedAddresses.clear();
	}
}
