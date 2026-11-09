/**
 * In-memory token buckets keyed by IP, address or host (threat model A8).
 * Bounded: when full, the least recently created bucket is dropped, which at
 * worst gives that key a fresh, full bucket. A limiter that must never hand
 * out a fresh bucket that way (the pairing-code guess limits) drops only
 * buckets that are full again, and refuses new keys while none is.
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
	/**
	 * When `maxKeys` are kept: `evict-oldest` (default) drops the oldest
	 * bucket, whatever it holds; `fail-closed` drops only buckets that are
	 * full again and, while every bucket still remembers something, refuses
	 * new keys. A drained bucket is then never forgotten early, so churning
	 * through many keys cannot reset it.
	 */
	whenFull?: "evict-oldest" | "fail-closed";
}

export class RateLimiter {
	readonly #buckets = new Map<string, Bucket>();
	readonly #capacity: number;
	readonly #refill: number;
	readonly #maxKeys: number;
	readonly #failClosed: boolean;
	/**
	 * While full (fail-closed): no bucket is full again before this time, so
	 * a refused new key does not sweep every bucket again before then.
	 */
	#roomAt = 0;

	constructor(options: RateLimitOptions) {
		this.#capacity = options.capacity;
		this.#refill = options.refillPerSecond;
		this.#maxKeys = options.maxKeys ?? 10_000;
		this.#failClosed = options.whenFull === "fail-closed";
	}

	/** Number of keys kept. */
	get size(): number {
		return this.#buckets.size;
	}

	/** Take one token for `key`; false when the bucket is empty. */
	take(key: string, now: number = Date.now()): boolean {
		let bucket = this.#buckets.get(key);
		if (bucket === undefined) {
			if (this.#buckets.size >= this.#maxKeys) {
				if (this.#failClosed) {
					if (now < this.#roomAt) return false;
					this.sweep(now);
					if (this.#buckets.size >= this.#maxKeys) return false;
				} else {
					const oldest = this.#buckets.keys().next().value;
					if (oldest !== undefined) this.#buckets.delete(oldest);
				}
			}
			bucket = { tokens: this.#capacity, updatedAt: now };
			this.#buckets.set(key, bucket);
			// Full again one token's refill after this take, at the earliest.
			if (this.#refill > 0) {
				this.#roomAt = Math.min(this.#roomAt, now + 1000 / this.#refill);
			}
		} else {
			this.#refillBucket(bucket, now);
		}
		if (bucket.tokens < 1) return false;
		bucket.tokens -= 1;
		return true;
	}

	/**
	 * Give back the token a request took, once it turned out to deserve no
	 * charge (a token request that succeeded). Never above capacity.
	 */
	refund(key: string, now: number = Date.now()): void {
		const bucket = this.#buckets.get(key);
		if (bucket === undefined) return;
		this.#refillBucket(bucket, now);
		bucket.tokens = Math.min(this.#capacity, bucket.tokens + 1);
		this.#roomAt = 0; // this bucket may be full sooner now
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

	/**
	 * Drop buckets that are full again (nothing to remember), and note when
	 * the next of the others will be.
	 */
	sweep(now: number = Date.now()): void {
		let roomAt = Number.POSITIVE_INFINITY;
		for (const [key, b] of this.#buckets) {
			const elapsed = Math.max(0, now - b.updatedAt) / 1000;
			const tokens = b.tokens + elapsed * this.#refill;
			if (tokens >= this.#capacity) {
				this.#buckets.delete(key);
			} else if (this.#refill > 0) {
				const fullAt = now + ((this.#capacity - tokens) / this.#refill) * 1000;
				if (fullAt < roomAt) roomAt = fullAt;
			}
		}
		this.#roomAt = roomAt;
	}

	#refillBucket(bucket: Bucket, now: number): void {
		const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
		bucket.tokens = Math.min(
			this.#capacity,
			bucket.tokens + elapsed * this.#refill,
		);
		bucket.updatedAt = now;
	}
}
