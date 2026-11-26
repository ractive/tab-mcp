/**
 * Stable addresses (DEC-027, DEC-196): the page keeps a random secret, and the
 * address id of a page is `base32(sha256(app + "\n" + secret))`, of its app id
 * and that secret. The relay stores nothing to recognise an address. The id
 * is what sessions, grants and tokens are kept by; it is in no URL.
 */

import { randomBase64url } from "./crypto.ts";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** The prefix of a group's address id (DEC-232). */
const GROUP_PREFIX = "group:";

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

/**
 * The address id of a page: base32(sha256(UTF-8 of app, a line feed, secret)).
 * The app is part of it, so the same secret under another app is another
 * page: it cannot take over the first one's session, grants or tokens
 * (DEC-197 holds against a copied secret). An app id has no line feed.
 */
export function addressIdFromSecret(secret: string, app: string): string {
	const digest = new Bun.CryptoHasher("sha256")
		.update(`${app}\n${secret}`)
		.digest();
	return base32(
		new Uint8Array(digest.buffer, digest.byteOffset, digest.length),
	);
}

/** A new page secret (what the browser library does; used by tests and tools). */
export function newSecret(): string {
	return randomBase64url(32);
}

/** Shortened address id for logs: enough to correlate, too short to use. */
export function shortAddress(id: string): string {
	return id.slice(0, id.startsWith(GROUP_PREFIX) ? GROUP_PREFIX.length + 8 : 8);
}

/**
 * The address id of a group's grants (DEC-232): what a group grant's token
 * record holds instead of a page's address id, so that revoking, listing
 * and the tombstones work for it as for a page. No page has it: a page's
 * address id is base32 (`a-z`, `2-7`), never with a colon.
 */
export function groupAddress(group: string): string {
	return `${GROUP_PREFIX}${group}`;
}

/** The group of a group's address id (`groupAddress`); `undefined` for a page's. */
export function groupOf(addressId: string): string | undefined {
	return addressId.startsWith(GROUP_PREFIX)
		? addressId.slice(GROUP_PREFIX.length)
		: undefined;
}
