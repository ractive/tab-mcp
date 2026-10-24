/**
 * Identity binding (DEC-075 to DEC-079): the tab assertion the web app's
 * backend signs for its user, and the key an address is bound to.
 */

import type { OidcConfig } from "./config.ts";
import {
	audiences,
	JwksCache,
	JwtError,
	type KeySource,
	numericDate,
	verifyJwt,
} from "./jwt.ts";

/** The `typ` header of a tab assertion (explicit typing, RFC 8725 §3.11). */
export const TAB_ASSERTION_TYP = "tab-mcp-identity+jwt";
/** Longest lifetime of a tab assertion. */
export const TAB_ASSERTION_MAX_LIFETIME_MS = 60_000;
/** Clock leeway for `exp`, `iat` and `nbf`. */
export const CLOCK_LEEWAY_MS = 5_000;
const MAX_SUBJECT = 255;
const MAX_JTI = 128;
const MAX_SEEN_JTI = 100_000;
/**
 * Assertions one person may have in the replay window (about a minute): two
 * a second. A page refreshes far less often; the cap keeps one signed-in user
 * from filling `MAX_SEEN_JTI` and refusing everyone else.
 */
const MAX_JTI_PER_PERSON = 120;

/** The text for a person other than the page's user (DEC-077, DEC-079). */
export const MISMATCH_TEXT =
	"This AI tool is logged in as someone other than the page.";

/**
 * The binding key: SHA-256 over the provider's issuer and the subject, so the
 * subject is never stored in the clear (DEC-077).
 */
export function identityKey(issuer: string, subject: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(`${issuer}\n${subject}`)
		.digest()
		.toBase64({ alphabet: "base64url", omitPadding: true });
}

/** Verifies tab assertions (DEC-076) and remembers used `jti`s. */
export class TabAssertionVerifier {
	readonly #oidc: OidcConfig;
	readonly #keys: KeySource;
	/** (binding key, jti) → expiry; insertion order is roughly expiry order (all live ≤ 65 s). */
	/** (person, jti) → until when it counts as used. */
	readonly #seen = new Map<string, number>();
	/** Entries in `#seen` per person. */
	readonly #perPerson = new Map<string, number>();
	#sweptAt = Number.NEGATIVE_INFINITY;
	readonly #maxSeen: number;

	/** `maxSeen` replaces `MAX_SEEN_JTI` (tests only). */
	constructor(
		oidc: OidcConfig,
		keys?: KeySource,
		maxSeen: number = MAX_SEEN_JTI,
	) {
		this.#oidc = oidc;
		this.#keys = keys ?? new JwksCache(oidc.assertionJwksUrl);
		this.#maxSeen = maxSeen;
	}

	/**
	 * Check an assertion for an MCP address; returns the binding key. Throws
	 * `JwtError` with a short reason for the log.
	 */
	async verify(
		token: string,
		address: string,
		now: number = Date.now(),
	): Promise<string> {
		const { payload } = await verifyJwt(token, this.#keys, {
			typ: TAB_ASSERTION_TYP,
		});
		if (payload["iss"] !== this.#oidc.assertionIssuer) {
			throw new JwtError(
				"iss",
				"the assertion's issuer is not the configured one",
			);
		}
		const aud = audiences(payload);
		if (aud.length !== 1 || aud[0] !== address) {
			throw new JwtError("aud", "the assertion is not for this address");
		}
		const exp = numericDate(payload, "exp");
		if (exp === undefined)
			throw new JwtError("exp", "the assertion has no exp");
		if (exp <= now - CLOCK_LEEWAY_MS) {
			throw new JwtError("expired", "the assertion has expired");
		}
		if (exp > now + TAB_ASSERTION_MAX_LIFETIME_MS + CLOCK_LEEWAY_MS) {
			throw new JwtError(
				"lifetime",
				"the assertion lives longer than 60 seconds",
			);
		}
		const iat = numericDate(payload, "iat");
		if (iat !== undefined && iat > now + CLOCK_LEEWAY_MS) {
			throw new JwtError("iat", "the assertion was issued in the future");
		}
		const nbf = numericDate(payload, "nbf");
		if (nbf !== undefined && nbf > now + CLOCK_LEEWAY_MS) {
			throw new JwtError("nbf", "the assertion is not valid yet");
		}
		const sub = payload["sub"];
		if (typeof sub !== "string" || sub === "" || sub.length > MAX_SUBJECT) {
			throw new JwtError("sub", "the assertion needs a subject");
		}
		const jti = payload["jti"];
		if (typeof jti !== "string" || jti === "" || jti.length > MAX_JTI) {
			throw new JwtError("jti", "the assertion needs a jti");
		}
		this.#sweep(now);
		// Keyed by the person too, so one user's jti cannot block another's.
		const key = identityKey(this.#oidc.issuer, sub);
		const seenKey = `${key}\n${jti}`;
		if (this.#seen.has(seenKey)) {
			throw new JwtError("replayed", "the assertion was already used");
		}
		const mine = this.#perPerson.get(key) ?? 0;
		if (mine >= MAX_JTI_PER_PERSON) {
			throw new JwtError("busy", "too many assertions at once");
		}
		// Full for everyone: says nothing about this person (a transient refusal).
		if (this.#seen.size >= this.#maxSeen) {
			throw new JwtError(
				"relay_busy",
				"the relay is checking too many assertions; try again shortly",
			);
		}
		this.#seen.set(seenKey, exp + CLOCK_LEEWAY_MS);
		this.#perPerson.set(key, mine + 1);
		return key;
	}

	/**
	 * Forgets the expired entries. They are not in expiry order (each
	 * assertion has its own `exp`), so the whole map is checked, at most once a
	 * second, and always when it is full.
	 */
	#sweep(now: number): void {
		if (now - this.#sweptAt < 1000 && this.#seen.size < this.#maxSeen) return;
		this.#sweptAt = now;
		for (const [seenKey, until] of this.#seen) {
			if (until > now) continue;
			this.#seen.delete(seenKey);
			const person = seenKey.slice(0, seenKey.indexOf("\n"));
			const left = (this.#perPerson.get(person) ?? 1) - 1;
			if (left > 0) this.#perPerson.set(person, left);
			else this.#perPerson.delete(person);
		}
	}
}
