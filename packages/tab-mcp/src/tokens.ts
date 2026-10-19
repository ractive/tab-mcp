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
 * Issue an access token for a grant and store its hash, without OAuth. An
 * internal helper for tests that need a token but not the flow; the token
 * endpoint issues through `issueTokenPair`.
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

/**
 * A new access token and refresh token for a grant (DEC-029). Neither lives
 * beyond `grantEndsAt` (DEC-062). Returns `undefined` if the store refuses
 * them because the grant was revoked meanwhile (its tombstone, DEC-063).
 */
export async function issueTokenPair(
	store: TokenStore,
	grant: Required<Omit<GrantInput, "scopes">> & { scopes: string[] },
	options: {
		accessTtlMs: number;
		refreshTtlMs: number;
		grantEndsAt: number;
		now?: number;
	},
): Promise<
	{ accessToken: string; refreshToken: string; expiresIn: number } | undefined
> {
	const now = options.now ?? Date.now();
	const accessToken = newToken("access");
	const refreshToken = newToken("refresh");
	const base = {
		grantId: grant.grantId,
		addressId: grant.addressId,
		clientId: grant.clientId,
		clientName: grant.clientName,
		scopes: grant.scopes,
		grantCreatedAt: grant.grantCreatedAt,
		issuedAt: now,
	};
	const accessExpires = Math.min(
		now + options.accessTtlMs,
		options.grantEndsAt,
	);
	// The refresh token first: a grant whose access token exists always has
	// a way to be listed and revoked. If a revocation lands between the two
	// puts, it deletes the first and its tombstone refuses the second.
	const refreshStored = await store.put({
		...base,
		hash: hashToken(refreshToken),
		kind: "refresh",
		expiresAt: Math.min(now + options.refreshTtlMs, options.grantEndsAt),
	});
	if (!refreshStored) return undefined;
	const accessStored = await store.put({
		...base,
		hash: hashToken(accessToken),
		kind: "access",
		expiresAt: accessExpires,
	});
	if (!accessStored) return undefined;
	return {
		accessToken,
		refreshToken,
		expiresIn: Math.max(0, Math.floor((accessExpires - now) / 1000)),
	};
}
