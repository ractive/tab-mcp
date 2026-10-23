/**
 * The address secret (DEC-027): 32 random bytes as base64url without padding,
 * kept in `localStorage`. The relay derives the stable address from it.
 */

import type { SecretStorage } from "./types.ts";

const SECRET = /^[A-Za-z0-9_-]{43}$/;
/** base64url without padding. */
export function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

export function newSecret(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isSecret(value: unknown): value is string {
	return typeof value === "string" && SECRET.test(value);
}

/** `localStorage`, or `null` where it is missing or blocked. */
function defaultStorage(): SecretStorage | null {
	try {
		const storage = (globalThis as { localStorage?: SecretStorage })
			.localStorage;
		return storage ?? null;
	} catch {
		return null; // SecurityError: storage blocked for this page
	}
}

/** Reads, creates and rotates the secret; falls back to memory without storage. */
export class SecretStore {
	readonly #storage: SecretStorage | null;
	readonly #key: string;
	/** A key the secret may still be under (the default of 0.4 and older). */
	readonly #oldKey: string | undefined;
	/** Set once a page of this origin took over the old key's secret. */
	readonly #claimKey: string | undefined;
	#memory: string | undefined;

	constructor(
		storage: SecretStorage | null | undefined,
		key: string,
		oldKey?: string,
	) {
		this.#storage = storage === undefined ? defaultStorage() : storage;
		this.#key = key;
		this.#oldKey = oldKey;
		this.#claimKey = oldKey === undefined ? undefined : `${oldKey}#moved`;
	}

	/** The current secret; storage first, so a rotation in another tab is seen. */
	get(): string {
		let stored: string | null = null;
		try {
			stored = this.#storage?.getItem(this.#key) ?? null;
			// The old shared key's secret is copied once (DEC-083): the first page
			// keeps the address and marks it taken, so the next page gets its own.
			// The old key stays, for pages still on 0.4 and for a rollback.
			if (
				!isSecret(stored) &&
				this.#oldKey !== undefined &&
				this.#claimKey !== undefined &&
				this.#storage?.getItem(this.#claimKey) == null
			) {
				const old = this.#storage?.getItem(this.#oldKey) ?? null;
				if (isSecret(old)) {
					stored = old; // kept for this page even if the writes below fail
					this.#claim(old);
				}
			}
		} catch {
			// unreadable: use a page-lifetime secret
		}
		if (isSecret(stored)) {
			this.#memory = stored;
			return stored;
		}
		return this.#memory ?? this.rotate();
	}

	/** Make and keep a new secret (a new address). */
	rotate(): string {
		const secret = newSecret();
		this.#memory = secret;
		// Also marks the old shared secret taken: an address abandoned with "New
		// address" is not picked up again by another page of the site.
		this.#claim(secret);
		return secret;
	}

	#claim(secret: string): void {
		try {
			this.#storage?.setItem(this.#key, secret);
			if (this.#claimKey !== undefined)
				this.#storage?.setItem(this.#claimKey, this.#key);
		} catch {
			// quota or blocked: the secret lives as long as the page
		}
	}
}
