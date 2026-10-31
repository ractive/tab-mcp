/**
 * `private_key_jwt` client authentication at `/token` and `/revoke` (RFC 7521
 * §4.2, RFC 7523 §2.2 and §3, OpenID Connect Core §9; DEC-106). The client
 * signs a short JWT with a key it publishes at the `jwks_uri` of its Client
 * ID Metadata Document; the signature is checked with `jwt.ts` (asymmetric
 * algorithms only, each tied to its key type, keys never from the header).
 */

import {
	audiences,
	decodeJwt,
	JwksCache,
	JwtError,
	type KeySource,
	numericDate,
	verifyJwt,
} from "../jwt.ts";
import { hashToken } from "../tokens.ts";
import type { PrivateKeyJwtAuth } from "./cimd.ts";

/** The only `client_assertion_type` (RFC 7523 §2.2). */
export const CLIENT_ASSERTION_TYPE =
	"urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/**
 * Longest an assertion may live from now: an hour, the ceiling other
 * authorization servers set (Okta) and the lifetime common libraries default
 * to. Its `jti` is single-use, so the length only bounds the replay store.
 */
export const CLIENT_ASSERTION_MAX_LIFETIME_MS: number = 60 * 60_000;
/** Clock leeway for `exp`, `iat` and `nbf`. */
export const CLIENT_ASSERTION_LEEWAY_MS = 30_000;
const MAX_JTI = 256;
const MAX_KEY_SETS = 1000;
/**
 * `typ` values accepted, compared case-insensitively (RFC 7515 §4.1.9):
 * none, `JWT`, or the explicit type of draft-ietf-oauth-rfc7523bis. Others
 * (`at+jwt`, `tab-mcp-identity+jwt`, …) are other kinds of token.
 */
const ACCEPTED_TYPES = new Set(["jwt", "client-authentication+jwt"]);

/** Records a one-time key until `expiresAt`; `false` if already recorded. */
export type ClaimNonce = (
	key: string,
	expiresAt: number,
	now: number,
) => Promise<boolean>;

export interface AssertionCheck {
	/** The client id the assertion must be for (`iss` and `sub`). */
	clientId: string;
	auth: PrivateKeyJwtAuth;
	keys: KeySource;
	/** What `aud` must contain one of: the issuer, the endpoint's URL. */
	audiences: readonly string[];
	claimNonce: ClaimNonce;
	now: number;
}

/**
 * The `sub` of an assertion, unverified: the client id when the request has
 * no `client_id` (RFC 7521 §4.2). Verification then checks it like any other.
 */
export function assertionSubject(assertion: string): string | undefined {
	try {
		const sub = decodeJwt(assertion).payload["sub"];
		return typeof sub === "string" && sub !== "" ? sub : undefined;
	} catch {
		return undefined;
	}
}

/** The replay store's key: the client and its `jti`, hashed. */
export function nonceKey(clientId: string, jti: string): string {
	return hashToken(JSON.stringify(["client_assertion", clientId, jti]));
}

/**
 * Check a client assertion; throws `JwtError` with a short reason for the
 * log. The `jti` is recorded only once everything else passed, so only the
 * holder of the client's key can add entries to the replay store.
 */
export async function verifyClientAssertion(
	assertion: string,
	check: AssertionCheck,
): Promise<void> {
	const { header, payload } = await verifyJwt(assertion, check.keys, {
		algorithms: check.auth.algorithms,
	});
	const typ = header["typ"];
	if (
		typ !== undefined &&
		(typeof typ !== "string" || !ACCEPTED_TYPES.has(typ.toLowerCase()))
	) {
		throw new JwtError("typ", "the assertion's type is not a client assertion");
	}
	if (payload["iss"] !== check.clientId) {
		throw new JwtError("iss", "the assertion's issuer is not the client");
	}
	if (payload["sub"] !== check.clientId) {
		throw new JwtError("sub", "the assertion's subject is not the client");
	}
	if (!audiences(payload).some((a) => check.audiences.includes(a))) {
		throw new JwtError("aud", "the assertion is not for this relay");
	}
	const exp = checkTimes(payload, check.now);
	const jti = payload["jti"];
	if (typeof jti !== "string" || jti === "" || jti.length > MAX_JTI) {
		throw new JwtError("jti", "the assertion needs a jti");
	}
	const key = nonceKey(check.clientId, jti);
	const until = exp + CLIENT_ASSERTION_LEEWAY_MS;
	if (!(await check.claimNonce(key, until, check.now))) {
		throw new JwtError("replayed", "the assertion was already used");
	}
}

/** `exp` required, live and at most an hour ahead; `iat` and `nbf` if given. Returns `exp` in ms. */
function checkTimes(payload: Record<string, unknown>, now: number): number {
	const exp = numericDate(payload, "exp");
	if (exp === undefined) throw new JwtError("exp", "the assertion has no exp");
	if (exp <= now - CLIENT_ASSERTION_LEEWAY_MS) {
		throw new JwtError("expired", "the assertion has expired");
	}
	if (
		exp >
		now + CLIENT_ASSERTION_MAX_LIFETIME_MS + CLIENT_ASSERTION_LEEWAY_MS
	) {
		throw new JwtError("lifetime", "the assertion lives longer than an hour");
	}
	const iat = numericDate(payload, "iat");
	if (iat !== undefined && iat > now + CLIENT_ASSERTION_LEEWAY_MS) {
		throw new JwtError("iat", "the assertion was issued in the future");
	}
	const nbf = numericDate(payload, "nbf");
	if (nbf !== undefined && nbf > now + CLIENT_ASSERTION_LEEWAY_MS) {
		throw new JwtError("nbf", "the assertion is not valid yet");
	}
	return exp;
}

/**
 * One `JwksCache` per client `jwks_uri` (10 minutes, an unknown `kid`
 * fetched again at most every 30 s, the last good keys for an hour after a
 * failure), loaded with the SSRF-guarded fetch; least recently used dropped
 * past 1000.
 */
export class ClientKeySets {
	readonly #sets = new Map<string, JwksCache>();
	readonly #load: (url: string) => Promise<unknown>;
	readonly #now: () => number;

	constructor(
		load: (url: string) => Promise<unknown>,
		now: () => number = Date.now,
	) {
		this.#load = load;
		this.#now = now;
	}

	for(jwksUri: string): KeySource {
		let set = this.#sets.get(jwksUri);
		if (set !== undefined) {
			this.#sets.delete(jwksUri);
		} else {
			set = new JwksCache(jwksUri, { load: this.#load, now: this.#now });
			if (this.#sets.size >= MAX_KEY_SETS) {
				const oldest = this.#sets.keys().next().value;
				if (oldest !== undefined) this.#sets.delete(oldest);
			}
		}
		this.#sets.set(jwksUri, set);
		return set;
	}
}
