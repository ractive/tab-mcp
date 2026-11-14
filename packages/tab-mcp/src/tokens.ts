import { randomBase64url, sha256Base64url } from "./crypto.ts";
import type { TokenKind, TokenStore } from "./store/types.ts";

/** Prefixes make leaked tokens recognisable to secret scanners. */
const PREFIX: Record<TokenKind, string> = {
	access: "tmcp_at_",
	refresh: "tmcp_rt_",
};

/** A new opaque token with 256 bits of randomness. */
export function newToken(kind: TokenKind): string {
	return PREFIX[kind] + randomBase64url(32);
}

/** A random identifier with a readable prefix, e.g. `g_…`, `s_…`. */
export function newId(prefix: string): string {
	return `${prefix}_${randomBase64url(12)}`;
}

/** SHA-256 of a token, base64url without padding: the store key. */
export function hashToken(token: string): string {
	return sha256Base64url(token);
}

/** The parts of a grant needed to issue tokens for it. */
export interface GrantInput {
	grantId: string;
	addressId: string;
	clientId: string;
	clientName: string;
	scopes: string[];
	grantCreatedAt: number;
	/** The hashed identity of an identity-bound grant (DEC-077). */
	subject?: string;
	/** Refreshes need a client assertion (DEC-106). */
	clientAuth?: "private_key_jwt";
}

/**
 * A new access token and refresh token for a grant (DEC-029). Neither lives
 * beyond `grantEndsAt` (DEC-062). Returns `undefined` if the store refuses
 * them because the grant was revoked meanwhile (its tombstone, DEC-063).
 */
export async function issueTokenPair(
	store: TokenStore,
	grant: GrantInput,
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
		...(grant.subject === undefined ? {} : { subject: grant.subject }),
		...(grant.clientAuth === undefined ? {} : { clientAuth: grant.clientAuth }),
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
