/**
 * Stable addresses (DEC-027): the page keeps a random secret, the address id is
 * `base32(sha256(secret))`. The relay stores nothing to recognise an address.
 */

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lower case, without padding. */
export function base32(bytes: Uint8Array): string {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += BASE32_ALPHABET[(buffer >>> bits) & 31];
		}
		buffer &= (1 << bits) - 1;
	}
	if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
	return out;
}

/** 32 random bytes as base64url without padding: 43 characters. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** An address id: base32 of a SHA-256 digest, 52 characters. */
const ADDRESS_ID_PATTERN = /^[a-z2-7]{52}$/;

export function isWellFormedSecret(secret: string): boolean {
	return SECRET_PATTERN.test(secret);
}

export function isAddressId(id: string): boolean {
	return ADDRESS_ID_PATTERN.test(id);
}

/** The address id for a page secret: base32(sha256(UTF-8 secret)). */
export function addressIdFromSecret(secret: string): string {
	const digest = new Bun.CryptoHasher("sha256").update(secret).digest();
	return base32(
		new Uint8Array(digest.buffer, digest.byteOffset, digest.length),
	);
}

/** A new page secret (what the browser library does; used by tests and tools). */
export function newSecret(): string {
	return crypto
		.getRandomValues(new Uint8Array(32))
		.toBase64({ alphabet: "base64url", omitPadding: true });
}

/** Shortened address id for logs: enough to correlate, too short to use. */
export function shortAddress(id: string): string {
	return id.slice(0, 8);
}
