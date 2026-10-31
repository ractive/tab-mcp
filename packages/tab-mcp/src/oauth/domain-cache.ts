/**
 * A bounded least-recently-used map whose entries each belong to a domain
 * (DEC-106, review of PR 65). Anyone can publish client documents, so the
 * caches of documents and keys must not let one party push out the others':
 *
 * - one domain holds at most `perDomain` entries; a new one replaces that
 *   domain's least recently used entry;
 * - when the map is full, a new entry replaces one that `isDead` says may go
 *   (past its use), else the least recently used entry of the domain that
 *   holds the most.
 *
 * So many documents of one attacker push out their own. What is left: an
 * attacker with as many domains as the map has room for, one entry each,
 * ties with everyone, and least recently used goes first.
 */
export class DomainCache<V> {
	readonly #entries = new Map<string, { domain: string; value: V }>();
	readonly #counts = new Map<string, number>();
	readonly #max: number;
	readonly #perDomain: number;
	readonly #isDead: (value: V, now: number) => boolean;

	constructor(
		max: number,
		perDomain: number,
		isDead: (value: V, now: number) => boolean = () => false,
	) {
		this.#max = max;
		this.#perDomain = perDomain;
		this.#isDead = isDead;
	}

	get size(): number {
		return this.#entries.size;
	}

	/** The value, marked as most recently used. */
	get(key: string): V | undefined {
		const entry = this.#entries.get(key);
		if (entry === undefined) return undefined;
		this.#entries.delete(key);
		this.#entries.set(key, entry);
		return entry.value;
	}

	delete(key: string): void {
		const entry = this.#entries.get(key);
		if (entry === undefined) return;
		this.#entries.delete(key);
		const left = (this.#counts.get(entry.domain) ?? 1) - 1;
		if (left > 0) this.#counts.set(entry.domain, left);
		else this.#counts.delete(entry.domain);
	}

	set(key: string, domain: string, value: V, now: number): void {
		this.delete(key);
		if ((this.#counts.get(domain) ?? 0) >= this.#perDomain) {
			this.#evictOldestOf(domain);
		} else if (this.#entries.size >= this.#max) {
			this.#evict(now);
		}
		this.#entries.set(key, { domain, value });
		this.#counts.set(domain, (this.#counts.get(domain) ?? 0) + 1);
	}

	#evict(now: number): void {
		for (const [key, entry] of this.#entries) {
			if (this.#isDead(entry.value, now)) {
				this.delete(key);
				return;
			}
		}
		const most = Math.max(0, ...this.#counts.values());
		// The least recently used entry among the domains that hold the most.
		for (const [key, entry] of this.#entries) {
			if (this.#counts.get(entry.domain) === most) {
				this.delete(key);
				return;
			}
		}
	}

	/** Insertion order is use order: the first entry of a domain is its oldest. */
	#evictOldestOf(domain: string): void {
		for (const [key, entry] of this.#entries) {
			if (entry.domain === domain) {
				this.delete(key);
				return;
			}
		}
	}
}
