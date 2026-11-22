/**
 * A hash of the page's secret: what the tabs of one page tell each other by
 * when one of them takes over (DEC-095), in place of the secret. It is not the
 * relay's address id, which is of the app and the secret (DEC-196), and never
 * part of a URL. Part of the lazily loaded chunk
 * (DEC-035), not the core.
 */

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lower case, without padding (the relay's address ids). */
function base32(bytes: Uint8Array): string {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += BASE32[(buffer >>> bits) & 31];
		}
		buffer &= (1 << bits) - 1;
	}
	if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
	return out;
}

/**
 * The hash of a secret that the tabs of a page name it by:
 * base32(sha256(secret)). `undefined` where Web Crypto is missing (`null`: a
 * page on plain http other than localhost) or fails; a replaced tab then
 * cannot tell a sibling tab from an impostor.
 */
export async function addressIdOf(
	secret: string,
	subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<string | undefined> {
	if (subtle === null) return undefined;
	try {
		const digest = await subtle.digest(
			"SHA-256",
			new TextEncoder().encode(secret),
		);
		return base32(new Uint8Array(digest));
	} catch {
		return undefined;
	}
}
