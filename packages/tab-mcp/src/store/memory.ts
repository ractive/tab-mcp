import type {
	GrantSummary,
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
		grants.set(r.grantId, {
			grantId: r.grantId,
			clientId: r.clientId,
			clientName: r.clientName,
			scopes: [...r.scopes],
			createdAt: r.grantCreatedAt,
		});
	}
	return [...grants.values()].sort(
		(a, b) => a.createdAt - b.createdAt || a.grantId.localeCompare(b.grantId),
	);
}

/** Tokens in process memory; everything is lost on restart. */
export class MemoryTokenStore implements TokenStore {
	readonly #records = new Map<string, TokenRecord>();

	async put(record: TokenRecord): Promise<void> {
		this.#records.set(record.hash, copy(record));
	}

	async get(hash: string): Promise<TokenRecord | undefined> {
		const r = this.#records.get(hash);
		return r === undefined ? undefined : copy(r);
	}

	async markUsed(hash: string, now: number): Promise<boolean> {
		const r = this.#records.get(hash);
		if (r === undefined || r.usedAt !== undefined) return false;
		r.usedAt = now;
		return true;
	}

	async revoke(selector: RevokeSelector): Promise<number> {
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
		let n = 0;
		for (const [hash, r] of this.#records) {
			if (r.expiresAt <= now) {
				this.#records.delete(hash);
				n++;
			}
		}
		return n;
	}

	async close(): Promise<void> {
		this.#records.clear();
	}
}
