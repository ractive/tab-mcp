import type { TokenKind, TokenRecord, TokenStore } from "./store/types.ts";

/** Prefixes make leaked tokens recognisable to secret scanners. */
const PREFIX: Record<TokenKind, string> = {
	access: "tmcp_at_",
	refresh: "tmcp_rt_",
};

function random(bytes: number): string {
	return crypto
		.getRandomValues(new Uint8Array(bytes))
		.toBase64({ alphabet: "base64url", omitPadding: true });
}

/** A new opaque token with 256 bits of randomness. */
export function newToken(kind: TokenKind): string {
	return PREFIX[kind] + random(32);
}

/** A random identifier with a readable prefix, e.g. `g_…`, `s_…`. */
export function newId(prefix: string): string {
	return `${prefix}_${random(12)}`;
}

/** SHA-256 of a token, base64url without padding: the store key. */
export function hashToken(token: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(token)
		.digest()
		.toBase64({ alphabet: "base64url", omitPadding: true });
}

/** The parts of a grant needed to issue tokens for it. */
export interface GrantInput {
	grantId?: string;
	addressId: string;
	clientId: string;
	clientName: string;
	scopes?: string[];
	grantCreatedAt?: number;
}

/**
 * Issue an access token for a grant and store its hash. Used by tests until the
 * token endpoint exists (iteration 3), which will issue through the same path.
 */
export async function issueAccessToken(
	store: TokenStore,
	grant: GrantInput,
	options: { ttlMs: number; now?: number },
): Promise<{ token: string; record: TokenRecord }> {
	const now = options.now ?? Date.now();
	const token = newToken("access");
	const record: TokenRecord = {
		hash: hashToken(token),
		kind: "access",
		grantId: grant.grantId ?? newId("g"),
		addressId: grant.addressId,
		clientId: grant.clientId,
		clientName: grant.clientName,
		scopes: grant.scopes ?? ["tools"],
		grantCreatedAt: grant.grantCreatedAt ?? now,
		issuedAt: now,
		expiresAt: now + options.ttlMs,
	};
	await store.put(record);
	return { token, record };
}
