/**
 * JWT signature checks on WebCrypto, without a JOSE library (DEC-076): the tab
 * assertion and the provider's ID token. Only asymmetric algorithms, each tied
 * to its key type; keys come only from a configured JWKS URL, never from the
 * token's header (`jwk`, `jku`, `x5u` are ignored).
 */

/** The accepted algorithms; never `none` or HMAC. */
export const JWT_ALGORITHMS = [
	"RS256",
	"RS384",
	"RS512",
	"PS256",
	"PS384",
	"PS512",
	"ES256",
	"ES384",
	"ES512",
	"EdDSA",
] as const;
export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];

/** Longest JWT the relay reads. */
export const MAX_JWT_BYTES = 8192;
const MAX_JWKS_BYTES = 65_536;
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_REFETCH_MS = 30_000;
/** An unknown kid after a good fetch: a rotation is looked for this soon. */
const UNKNOWN_KID_REFETCH_MS = 5_000;
/** How long the last good keys are served while the JWKS cannot be fetched. */
const JWKS_GRACE_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;

export class JwtError extends Error {
	override name = "JwtError";
	/** A short reason for the log. */
	readonly reason: string;
	constructor(reason: string, message: string) {
		super(message);
		this.reason = reason;
	}
}

export interface Jwk {
	kty?: string;
	kid?: string;
	use?: string;
	alg?: string;
	crv?: string;
	n?: string;
	e?: string;
	x?: string;
	y?: string;
	[key: string]: unknown;
}

export interface DecodedJwt {
	header: Record<string, unknown>;
	payload: Record<string, unknown>;
	signingInput: Uint8Array<ArrayBuffer>;
	signature: Uint8Array<ArrayBuffer>;
}

function fromBase64Url(part: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]*$/.test(part)) {
		throw new JwtError("malformed", "the token is not base64url");
	}
	return Uint8Array.fromBase64(part, { alphabet: "base64url" });
}

function jsonPart(part: string, what: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(part)),
		);
	} catch {
		throw new JwtError("malformed", `the token's ${what} is not JSON`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new JwtError("malformed", `the token's ${what} is not a JSON object`);
	}
	return value as Record<string, unknown>;
}

/** Split and decode a compact JWS (no signature check). */
export function decodeJwt(token: string): DecodedJwt {
	if (typeof token !== "string" || token.length > MAX_JWT_BYTES) {
		throw new JwtError("too_large", "the token is too large");
	}
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new JwtError("malformed", "the token is not a signed JWT");
	}
	const [h = "", p = "", s = ""] = parts;
	return {
		header: jsonPart(h, "header"),
		payload: jsonPart(p, "payload"),
		signingInput: new TextEncoder().encode(`${h}.${p}`),
		signature: fromBase64Url(s),
	};
}

type ImportParams = Parameters<typeof crypto.subtle.importKey>[2];
type VerifyParams = Parameters<typeof crypto.subtle.verify>[0];

interface AlgorithmSpec {
	kty: "RSA" | "EC" | "OKP";
	crv?: string;
	importParams: ImportParams;
	verifyParams: VerifyParams;
}

function spec(alg: JwtAlgorithm): AlgorithmSpec {
	const bits = alg.slice(2);
	const hash = `SHA-${bits}`;
	switch (alg.slice(0, 2)) {
		case "RS":
			return {
				kty: "RSA",
				importParams: { name: "RSASSA-PKCS1-v1_5", hash },
				verifyParams: { name: "RSASSA-PKCS1-v1_5" },
			};
		case "PS":
			return {
				kty: "RSA",
				importParams: { name: "RSA-PSS", hash },
				verifyParams: {
					name: "RSA-PSS",
					saltLength: Number(bits) / 8,
				} as VerifyParams,
			};
		case "ES": {
			const crv = bits === "512" ? "P-521" : `P-${bits}`;
			return {
				kty: "EC",
				crv,
				importParams: { name: "ECDSA", namedCurve: crv },
				verifyParams: { name: "ECDSA", hash } as VerifyParams,
			};
		}
		default:
			return {
				kty: "OKP",
				crv: "Ed25519",
				importParams: { name: "Ed25519" },
				verifyParams: { name: "Ed25519" },
			};
	}
}

export function isAlgorithm(v: unknown): v is JwtAlgorithm {
	return (JWT_ALGORITHMS as readonly unknown[]).includes(v);
}

/** Whether a key may verify `alg` (type, curve, use and its own `alg`). */
function keyFits(jwk: Jwk, alg: JwtAlgorithm): boolean {
	const s = spec(alg);
	if (jwk.kty !== s.kty) return false;
	if (s.crv !== undefined && jwk.crv !== s.crv) return false;
	if (jwk.use !== undefined && jwk.use !== "sig") return false;
	if (jwk.alg !== undefined && jwk.alg !== alg) return false;
	return true;
}

/** Only the public members: a private key in a JWKS must not become a verify key. */
function publicJwk(jwk: Jwk): Record<string, string> {
	const out: Record<string, string> = { kty: jwk.kty as string };
	for (const k of ["n", "e", "crv", "x", "y"] as const) {
		const v = jwk[k];
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

/** A source of verification keys (a JWKS URL in production). */
export interface KeySource {
	/** Keys for `kid`; may fetch again when the kid is unknown. */
	keys(kid: string | undefined): Promise<Jwk[]>;
}

/** Fetch JSON from an operator-configured URL with a timeout and a size limit. */
export async function fetchJson(
	url: string,
	init: RequestInit = {},
	maxBytes: number = MAX_JWKS_BYTES,
): Promise<unknown> {
	const res = await fetch(url, {
		...init,
		redirect: "error",
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		headers: { accept: "application/json", ...(init.headers ?? {}) },
	});
	const length = Number(res.headers.get("content-length") ?? "0");
	if (length > maxBytes) throw new Error(`response too large (${url})`);
	// Counted while it arrives: a body without Content-Length (chunked) is cut
	// off at the limit instead of being buffered whole first.
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = res.body?.getReader();
	while (reader !== undefined) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			throw new Error(`response too large (${url})`);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(bytes);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`not JSON (${url}, HTTP ${res.status})`);
	}
	if (!res.ok) {
		const error = (value as Record<string, unknown> | null)?.["error"];
		throw new HttpJsonError(
			res.status,
			typeof error === "string" ? error : "",
			url,
		);
	}
	return value;
}

export class HttpJsonError extends Error {
	override name = "HttpJsonError";
	readonly status: number;
	readonly error: string;
	constructor(status: number, error: string, url: string) {
		super(`HTTP ${status}${error === "" ? "" : ` ${error}`} (${url})`);
		this.status = status;
		this.error = error;
	}
}

/**
 * A JWKS URL, cached 10 minutes, fetched again for an unknown kid at most every
 * 5 s. After a failed fetch the last good keys are served for up to an hour
 * (an outage must not refuse every token at once), and the next attempt waits
 * 30 s, so a dead endpoint is not hit (and waited for) on every check. An
 * unknown kid that could not be looked for again throws (the keys are
 * unavailable) rather than answering "no such key".
 */
export class JwksCache implements KeySource {
	readonly #url: () => Promise<string>;
	readonly #now: () => number;
	readonly #load: (url: string) => Promise<unknown>;
	#keys: Jwk[] = [];
	#fetchedAt = 0;
	#attemptedAt = Number.NEGATIVE_INFINITY;
	#lastError: Error | undefined;
	#inflight: Promise<void> | undefined;

	/**
	 * `load` fetches the document; the default suits an operator-configured
	 * URL. A URL a client chose needs the SSRF-guarded fetch (DEC-106).
	 */
	constructor(
		url: string | (() => Promise<string>),
		options: {
			now?: () => number;
			load?: (url: string) => Promise<unknown>;
		} = {},
	) {
		this.#url = typeof url === "string" ? () => Promise.resolve(url) : url;
		this.#now = options.now ?? Date.now;
		this.#load = options.load ?? ((u) => fetchJson(u));
	}

	async keys(kid: string | undefined): Promise<Jwk[]> {
		const entered = this.#now();
		// A fetch already running answers everyone who asks meanwhile (many tabs
		// after a relay restart, a new kid during a rotation): without waiting,
		// they would find the throttle set and read the old (or no) keys.
		if (this.#inflight !== undefined) await this.#inflight.catch(() => {});
		const now = this.#now();
		const stale = now - this.#fetchedAt >= JWKS_TTL_MS;
		const unknown = kid !== undefined && !this.#has(kid);
		// An unknown kid may be a rotation: after a good fetch it may look again
		// soon; after a failed one it waits the full 30 s.
		const floor =
			unknown && this.#lastError === undefined
				? UNKNOWN_KID_REFETCH_MS
				: JWKS_REFETCH_MS;
		if ((stale || unknown) && now - this.#attemptedAt >= floor) {
			try {
				await this.#refresh();
			} catch (error) {
				this.#lastError = error instanceof Error ? error : new Error("JWKS");
			}
		}
		if (this.#now() - this.#fetchedAt >= JWKS_TTL_MS + JWKS_GRACE_MS) {
			// Nothing usable: no keys yet, or keys past their grace period.
			throw this.#lastError ?? new Error("the JWKS could not be loaded");
		}
		if (kid === undefined) return this.#keys;
		// Unknown, and the keys were not fetched again for this call (throttled
		// or failed): the key may exist and not be loaded yet, so this is "the
		// keys could not be loaded", not "no such key" (review of PR 65).
		if (!this.#has(kid) && this.#fetchedAt < entered) {
			throw (
				this.#lastError ??
				new Error("an unknown key id; the JWKS was fetched too recently")
			);
		}
		return this.#keys.filter((k) => k.kid === kid);
	}

	#has(kid: string): boolean {
		return this.#keys.some((k) => k.kid === kid);
	}

	#refresh(): Promise<void> {
		this.#inflight ??= (async () => {
			this.#attemptedAt = this.#now();
			try {
				const doc = await this.#load(await this.#url());
				const keys = (doc as { keys?: unknown } | null)?.keys;
				if (!Array.isArray(keys)) throw new Error("a JWKS needs keys");
				this.#keys = keys.filter(
					(k): k is Jwk => typeof k === "object" && k !== null,
				);
				this.#fetchedAt = this.#now();
				this.#lastError = undefined;
			} finally {
				this.#inflight = undefined;
			}
		})();
		return this.#inflight;
	}
}

export interface VerifyOptions {
	/** Required header `typ` (compared exactly), if any. */
	typ?: string;
	/** Allowed algorithms; default all of `JWT_ALGORITHMS`. */
	algorithms?: readonly JwtAlgorithm[];
}

/** Check the signature of a compact JWS; returns the decoded token. */
export async function verifyJwt(
	token: string,
	source: KeySource,
	options: VerifyOptions = {},
): Promise<DecodedJwt> {
	const jwt = decodeJwt(token);
	const { header } = jwt;
	const alg = header["alg"];
	const allowed = options.algorithms ?? JWT_ALGORITHMS;
	if (!isAlgorithm(alg) || !allowed.includes(alg)) {
		throw new JwtError(
			"alg",
			`the token's algorithm is not accepted (${String(alg).slice(0, 20)})`,
		);
	}
	if (header["crit"] !== undefined) {
		throw new JwtError("crit", "the token has critical header parameters");
	}
	if (options.typ !== undefined && header["typ"] !== options.typ) {
		throw new JwtError("typ", `the token's type must be ${options.typ}`);
	}
	const kid = header["kid"];
	if (kid !== undefined && typeof kid !== "string") {
		throw new JwtError("malformed", "the token's kid is not a string");
	}
	let candidates: Jwk[];
	try {
		candidates = (await source.keys(kid)).filter((k) => keyFits(k, alg));
	} catch (error) {
		throw new JwtError(
			"jwks_unavailable",
			`the signing keys could not be loaded: ${error instanceof Error ? error.message : "unknown"}`,
		);
	}
	// Without a kid, only an unambiguous key is used.
	if (candidates.length === 0 || (kid === undefined && candidates.length > 1)) {
		throw new JwtError("key", "no matching signing key");
	}
	const s = spec(alg);
	for (const jwk of candidates) {
		let key: CryptoKey;
		try {
			key = await crypto.subtle.importKey(
				"jwk",
				publicJwk(jwk),
				s.importParams,
				false,
				["verify"],
			);
		} catch {
			continue; // a broken key in the set: try the others
		}
		const ok = await crypto.subtle
			.verify(s.verifyParams, key, jwt.signature, jwt.signingInput)
			.catch(() => false);
		if (ok) return jwt;
	}
	throw new JwtError("signature", "the token's signature is not valid");
}

/** Claim helpers shared by the assertion and ID token checks. */
export function numericDate(
	payload: Record<string, unknown>,
	name: string,
): number | undefined {
	const v = payload[name];
	if (v === undefined) return undefined;
	if (typeof v !== "number" || !Number.isFinite(v)) {
		throw new JwtError("claims", `${name} must be a number`);
	}
	return v * 1000;
}

/** `aud` as a list (a string or an array of strings). */
export function audiences(payload: Record<string, unknown>): string[] {
	const aud = payload["aud"];
	if (typeof aud === "string") return [aud];
	if (Array.isArray(aud) && aud.every((a) => typeof a === "string")) {
		return aud as string[];
	}
	throw new JwtError("claims", "aud is missing");
}
