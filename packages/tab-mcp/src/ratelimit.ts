/**
 * In-memory token buckets keyed by IP, address or host (threat model A8).
 * Bounded: when full, the least recently created bucket is dropped, which at
 * worst gives that key a fresh, full bucket.
 */

interface Bucket {
	tokens: number;
	updatedAt: number;
}

export interface RateLimitOptions {
	/** Burst size: how many requests a fresh key may make at once. */
	capacity: number;
	/** Tokens added per second. */
	refillPerSecond: number;
	/** Most keys kept in memory. */
	maxKeys?: number;
}

export class RateLimiter {
	readonly #buckets = new Map<string, Bucket>();
	readonly #capacity: number;
	readonly #refill: number;
	readonly #maxKeys: number;

	constructor(options: RateLimitOptions) {
		this.#capacity = options.capacity;
		this.#refill = options.refillPerSecond;
		this.#maxKeys = options.maxKeys ?? 10_000;
	}

	/** Take one token for `key`; false when the bucket is empty. */
	take(key: string, now: number = Date.now()): boolean {
		let bucket = this.#buckets.get(key);
		if (bucket === undefined) {
			if (this.#buckets.size >= this.#maxKeys) {
				const oldest = this.#buckets.keys().next().value;
				if (oldest !== undefined) this.#buckets.delete(oldest);
			}
			bucket = { tokens: this.#capacity, updatedAt: now };
			this.#buckets.set(key, bucket);
		} else {
			const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
			bucket.tokens = Math.min(
				this.#capacity,
				bucket.tokens + elapsed * this.#refill,
			);
			bucket.updatedAt = now;
		}
		if (bucket.tokens < 1) return false;
		bucket.tokens -= 1;
		return true;
	}

	/** Whether `take` would succeed for `key` now; takes nothing. */
	available(key: string, now: number = Date.now()): boolean {
		const bucket = this.#buckets.get(key);
		if (bucket === undefined) return this.#capacity >= 1;
		const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
		return (
			Math.min(this.#capacity, bucket.tokens + elapsed * this.#refill) >= 1
		);
	}

	/** Drop buckets that are full again (nothing to remember). */
	sweep(now: number = Date.now()): void {
		for (const [key, b] of this.#buckets) {
			const elapsed = Math.max(0, now - b.updatedAt) / 1000;
			if (b.tokens + elapsed * this.#refill >= this.#capacity) {
				this.#buckets.delete(key);
			}
		}
	}
}
