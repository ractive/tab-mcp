/**
 * The address id in the `/tab` URL (DEC-098): a load balancer in front of
 * several relays routes every request of one address to one instance by it.
 * Part of the lazily loaded chunk (DEC-035), not the core.
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
 * The address id of a secret, as the relay derives it (DEC-027):
 * base32(sha256(secret)). `undefined` where Web Crypto is missing (`null`: a
 * page on plain http other than localhost) or fails; the URL then has no id,
 * which one relay accepts and only a load balancer cannot route.
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

/** The `/tab` URL with `?a=<id>`. Never the secret: URLs end up in logs. */
export function withAddress(url: string, address: string | undefined): string {
	if (address === undefined) return url;
	const u = new URL(url);
	u.searchParams.set("a", address);
	return u.href;
}
