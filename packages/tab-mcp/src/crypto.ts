/**
 * The relay's small cryptographic helpers, in one place (RQ 14): random
 * values, SHA-256 and a constant-time comparison.
 */

import { timingSafeEqual } from "node:crypto";

/** `bytes` random bytes as base64url without padding. */
export function randomBase64url(bytes: number): string {
	return crypto
		.getRandomValues(new Uint8Array(bytes))
		.toBase64({ alphabet: "base64url", omitPadding: true });
}

/** SHA-256 of the UTF-8 text, base64url without padding. */
export function sha256Base64url(text: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(text)
		.digest()
		.toBase64({ alphabet: "base64url", omitPadding: true });
}

/** Whether two strings are equal, in time that does not depend on where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}
