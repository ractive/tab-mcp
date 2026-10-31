/**
 * Client ID Metadata Documents (CIMD, draft-ietf-oauth-client-id-metadata-document;
 * MCP 2026-07-28 client registration): the `client_id` is an HTTPS URL, and
 * the relay fetches it to learn the client's name and redirect URIs.
 *
 * The URL is chosen by an unauthenticated party, so the fetch is guarded
 * against SSRF (threat model A3): https only, default port, no credentials,
 * the host resolved first and every address checked to be public, no
 * redirects, 5 s, 64 KiB, `application/json`, results cached and fetches per
 * domain and in total rate-limited. A `private_key_jwt` client's `jwks_uri`
 * is fetched under the same rules (DEC-106).
 */

import { isLoopbackHost, isPublicIp, parseIpv4, parseIpv6 } from "../ip.ts";
import { isAlgorithm, JWT_ALGORITHMS, type JwtAlgorithm } from "../jwt.ts";
import type { Logger } from "../log.ts";
import { RateLimiter } from "../ratelimit.ts";

/** What the relay needs to know about a client. */
export interface ClientMetadata {
	/** The client id: the document's URL. */
	clientId: string;
	/** Self-declared, cleaned and shortened for display. */
	name: string;
	/** Host of the client id URL: the verified part. */
	host: string;
	redirectUris: string[];
	/** How the client authenticates at `/token` (DEC-104, DEC-106). */
	auth: ClientAuth;
}

/**
 * `none`: a public client. `private_key_jwt`: it signs a client assertion
 * with a key from `jwksUri`; `publicAllowed` when its document also lists
 * `none` (DEC-104), so a grant may start without one (DEC-106).
 */
export type ClientAuth = { method: "none" } | PrivateKeyJwtAuth;

export interface PrivateKeyJwtAuth {
	method: "private_key_jwt";
	jwksUri: string;
	/** `token_endpoint_auth_signing_alg` if the document names one, else all. */
	algorithms: readonly JwtAlgorithm[];
	publicAllowed: boolean;
}

/** Why a client id was refused; `message` is plain English for the page. */
export class ClientMetadataError extends Error {
	override name = "ClientMetadataError";
	readonly reason: string;
	constructor(reason: string, message: string) {
		super(message);
		this.reason = reason;
	}
}

/**
 * Test-only relaxations (never from configuration): loopback hosts, any port,
 * `http:`, and an extra CA for a self-signed test server.
 */
export interface CimdTestMode {
	ca?: string;
}

export interface ClientMetadataFetcherOptions {
	/** Accepted client id hosts; empty = any. */
	allowedHosts?: readonly string[];
	logger?: Logger;
	timeoutMs?: number;
	maxBytes?: number;
	/** Resolve a host name to its addresses (tests replace it). */
	lookup?: (hostname: string) => Promise<string[]>;
	fetch?: typeof fetch;
	testMode?: CimdTestMode;
	now?: () => number;
}

/** How `validateDocument` reads a document. */
export interface DocumentOptions {
	/** Test mode: a `jwks_uri` may use `http:` and any port, like the client id. */
	test?: boolean;
	/** A `private_key_jwt` document fell back to `none` (DEC-104), and why. */
	onFallback?: (reason: string) => void;
}

/**
 * Failures that say nothing about the client, only that its document could
 * not be had right now: worth a retry, and a reason to serve a recent copy.
 */
const TRANSIENT_REASONS = new Set([
	"rate_limited",
	"fetch_failed",
	"unresolvable",
	"too_large",
]);

export function isTransient(error: ClientMetadataError): boolean {
	return TRANSIENT_REASONS.has(error.reason);
}

/**
 * How long past its cache lifetime a document is still served to the token
 * and revocation endpoints when a fresh fetch fails transiently (DEC-106):
 * the hour `JwksCache` gives keys.
 */
const STALE_GRACE_MS = 60 * 60_000;

const MAX_CLIENT_ID_LENGTH = 2048;
const MAX_NAME_LENGTH = 64;
const MAX_REDIRECT_URIS = 20;
const MIN_CACHE_MS = 5 * 60_000;
const DEFAULT_CACHE_MS = 60 * 60_000;
const MAX_CACHE_MS = 24 * 60 * 60_000;
const MAX_CACHE_ENTRIES = 1000;

async function defaultLookup(hostname: string): Promise<string[]> {
	const records = await Bun.dns.lookup(hostname, {});
	return records.map((r) => r.address);
}

/**
 * Invisible characters that are not format characters (`Cf`): Hangul and
 * other fillers, the braille blank, combining grapheme joiner, variation
 * selectors.
 */
const INVISIBLE =
	/[\u034F\u115F\u1160\u17B4\u17B5\u2800\u3164\uFFA0]|\p{Variation_Selector}/gu;

/**
 * Clean a self-declared name for display: control and line/paragraph
 * separators become spaces; format characters (`Cf`: zero-width, bidi,
 * word joiner, BOM, soft hyphen, …) and other invisible characters are
 * removed; whitespace collapses; at most 64 characters (DEC-065).
 */
export function displayName(raw: string): string {
	let cleaned = raw
		.normalize("NFC")
		.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/\p{Cf}/gu, "")
		.replace(INVISIBLE, "");
	cleaned = cleaned.replace(/\s+/g, " ").trim();
	const chars = [...cleaned];
	return chars.length > MAX_NAME_LENGTH
		? `${chars.slice(0, MAX_NAME_LENGTH - 1).join("")}…`
		: cleaned;
}

/** Seconds of `max-age` in a Cache-Control header, or a marker. */
function cacheMs(header: string | null): number {
	if (header === null) return DEFAULT_CACHE_MS;
	const directives = header
		.toLowerCase()
		.split(",")
		.map((d) => d.trim());
	if (directives.includes("no-store") || directives.includes("no-cache")) {
		return MIN_CACHE_MS;
	}
	const maxAge = directives
		.map((d) => /^max-age=(\d+)$/.exec(d)?.[1])
		.find((v) => v !== undefined);
	if (maxAge === undefined) return DEFAULT_CACHE_MS;
	return Math.min(MAX_CACHE_MS, Math.max(MIN_CACHE_MS, Number(maxAge) * 1000));
}

function isIpLiteral(hostname: string): boolean {
	const h = hostname.replace(/^\[|\]$/g, "");
	return parseIpv4(h) !== undefined || parseIpv6(h) !== undefined;
}

/**
 * The key fetches are limited under (DEC-089): the last two labels of a host
 * name, so `*.evil.example` is one key however many subdomains it has; an IP
 * literal as is. Without the Public Suffix List, clients under a multi-label
 * suffix (`co.uk`, `pages.dev`) share one key, so many hosts there can slow
 * the others' uncached fetches; one host alone cannot (its own limit is lower).
 */
export function limitKey(hostname: string): string {
	const h = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (isIpLiteral(h)) return h;
	return h.split(".").slice(-2).join(".");
}

/** Fetches, validates and caches Client ID Metadata Documents. */
export class ClientMetadataFetcher {
	readonly #cache = new Map<string, { meta: ClientMetadata; until: number }>();
	readonly #perHost = new RateLimiter({ capacity: 5, refillPerSecond: 0.2 });
	/** Three hosts' worth: one host alone cannot use up its domain (DEC-089). */
	readonly #perDomain = new RateLimiter({ capacity: 15, refillPerSecond: 0.6 });
	/** All fetches together: many attacker-owned hosts cannot add up (DEC-061). */
	readonly #global = new RateLimiter({ capacity: 30, refillPerSecond: 1 });
	readonly #allowedHosts: readonly string[];
	readonly #logger: Logger | undefined;
	readonly #timeoutMs: number;
	readonly #maxBytes: number;
	readonly #lookup: (hostname: string) => Promise<string[]>;
	readonly #fetch: typeof fetch;
	readonly #testMode: CimdTestMode | undefined;
	readonly #now: () => number;

	constructor(options: ClientMetadataFetcherOptions = {}) {
		this.#allowedHosts = options.allowedHosts ?? [];
		this.#logger = options.logger;
		this.#timeoutMs = options.timeoutMs ?? 5000;
		this.#maxBytes = options.maxBytes ?? 65_536;
		this.#lookup = options.lookup ?? defaultLookup;
		this.#fetch = options.fetch ?? fetch;
		this.#testMode = options.testMode;
		this.#now = options.now ?? Date.now;
	}

	/**
	 * The client's metadata, from the cache or freshly fetched. Throws
	 * `ClientMetadataError`. With `allowStale` (the token and revocation
	 * endpoints, DEC-106) a document up to an hour past its cache lifetime is
	 * served when the fresh fetch fails transiently or is rate-limited, so a
	 * busy or briefly unreachable host does not cut off apps that already
	 * have grants. `/authorize` always wants a current document.
	 */
	async get(
		clientId: string,
		options: { allowStale?: boolean } = {},
	): Promise<ClientMetadata> {
		const url = this.#checkUrl(clientId);
		const now = this.#now();
		const cached = this.#cache.get(clientId);
		if (cached !== undefined) {
			// Least recently used first: a hit moves the entry to the end.
			this.#cache.delete(clientId);
			this.#cache.set(clientId, cached);
			if (cached.until > now) return cached.meta;
		}
		const stale =
			options.allowStale === true &&
			cached !== undefined &&
			now < cached.until + STALE_GRACE_MS
				? cached.meta
				: undefined;
		try {
			return await this.#refresh(clientId, url, now);
		} catch (error) {
			const transient =
				error instanceof ClientMetadataError && isTransient(error);
			// A document the host now answers with something unacceptable is
			// not kept as a fallback either.
			if (!transient) this.#cache.delete(clientId);
			if (stale === undefined || !transient) throw error;
			this.#logger?.info("oauth.cimd_stale", {
				host: url.host,
				reason: error.reason,
			});
			return stale;
		}
	}

	async #refresh(
		clientId: string,
		url: URL,
		now: number,
	): Promise<ClientMetadata> {
		this.#admit(url, now);
		const address = await this.#vettedAddress(url);
		const response = await this.#fetchJson(url, address, ["application/json"]);
		const meta = validateDocument(response.doc, clientId, url, {
			test: this.#testMode !== undefined,
			onFallback: (reason) =>
				this.#logger?.info("oauth.cimd_auth_fallback", {
					host: url.host,
					reason,
				}),
		});
		const ttlMs = cacheMs(response.cacheControl);
		this.#cache.delete(clientId);
		if (this.#cache.size >= MAX_CACHE_ENTRIES) {
			const oldest = this.#cache.keys().next().value;
			if (oldest !== undefined) this.#cache.delete(oldest);
		}
		this.#cache.set(clientId, { meta, until: now + ttlMs });
		return meta;
	}

	/**
	 * A client's JWKS document, under the CIMD fetch's SSRF rules and rate
	 * limits (DEC-106). `validateDocument` checked `jwksUri` (https, the
	 * client id's host); this checks it again before any network use. Not
	 * cached here: `JwksCache` does that. Throws `ClientMetadataError`.
	 */
	async fetchJwks(jwksUri: string): Promise<unknown> {
		const url = this.#checkJwksUri(jwksUri);
		this.#admit(url, this.#now());
		const address = await this.#vettedAddress(url);
		const response = await this.#fetchJson(url, address, [
			"application/json",
			"application/jwk-set+json",
		]);
		return response.doc;
	}

	/**
	 * Charge a fetch to its host, its domain and the global limit; per host
	 * and per domain only once the global limit admits it, so refusals cost
	 * the others nothing (DEC-089).
	 */
	#admit(url: URL, now: number): void {
		const key = limitKey(url.hostname);
		if (
			!this.#perHost.available(url.host, now) ||
			!this.#perDomain.available(key, now)
		) {
			throw new ClientMetadataError(
				"rate_limited",
				"Too many requests for this AI app's details. Try again in a minute.",
			);
		}
		if (!this.#global.take("all", now)) {
			throw new ClientMetadataError(
				"rate_limited",
				"The relay is busy. Try again in a minute.",
			);
		}
		this.#perHost.take(url.host, now);
		this.#perDomain.take(key, now);
	}

	#checkJwksUri(jwksUri: string): URL {
		const url = parseJwksUri(jwksUri, this.#testMode !== undefined);
		if (url === undefined) {
			throw new ClientMetadataError(
				"invalid_jwks_uri",
				"The AI app's jwks_uri is not accepted.",
			);
		}
		if (
			this.#allowedHosts.length > 0 &&
			!this.#allowedHosts.includes(url.host)
		) {
			throw new ClientMetadataError(
				"host_not_allowed",
				`This relay does not accept AI apps from ${url.host}.`,
			);
		}
		if (isIpLiteral(url.hostname) && !this.#addressAllowed(url.hostname)) {
			throw this.#notLoaded("private_address", url);
		}
		return url;
	}

	/** The URL rules of the CIMD draft plus our SSRF rules, before any network use. */
	#checkUrl(clientId: string): URL {
		const refuse = (message: string) =>
			new ClientMetadataError("invalid_client_id", message);
		if (clientId.length === 0 || clientId.length > MAX_CLIENT_ID_LENGTH) {
			throw refuse("The AI app's client_id is missing or too long.");
		}
		let url: URL;
		try {
			url = new URL(clientId);
		} catch {
			throw refuse("The AI app's client_id is not a URL.");
		}
		const test = this.#testMode !== undefined;
		const scheme =
			url.protocol === "https:" || (test && url.protocol === "http:");
		if (!scheme) {
			throw refuse("The AI app's client_id must be an https:// URL.");
		}
		// Canonical form only: this rejects dot segments, fragments' oddities,
		// an explicit default port, upper-case hosts and other aliases.
		if (url.href !== clientId) {
			throw refuse("The AI app's client_id is not a canonical URL.");
		}
		if (url.username !== "" || url.password !== "" || url.hash !== "") {
			throw refuse(
				"The AI app's client_id must not contain credentials or a fragment.",
			);
		}
		if (url.pathname === "/" || url.pathname === "") {
			throw refuse("The AI app's client_id must have a path.");
		}
		if (url.port !== "" && !test) {
			throw refuse("The AI app's client_id must use the default port.");
		}
		if (
			this.#allowedHosts.length > 0 &&
			!this.#allowedHosts.includes(url.host)
		) {
			throw new ClientMetadataError(
				"host_not_allowed",
				`This relay does not accept AI apps from ${url.host}.`,
			);
		}
		if (isIpLiteral(url.hostname) && !this.#addressAllowed(url.hostname)) {
			throw this.#notLoaded("private_address", url);
		}
		return url;
	}

	#addressAllowed(address: string): boolean {
		if (isPublicIp(address)) return true;
		return this.#testMode !== undefined && isLoopbackHost(address);
	}

	/**
	 * One fixed message for every failure from resolving to parsing, so the
	 * page tells nothing about what answered (threat model A3, DEC-066). The
	 * reason goes to the log.
	 */
	#notLoaded(reason: string, url: URL, detail = reason): ClientMetadataError {
		this.#logger?.info("oauth.cimd_failed", { host: url.host, reason: detail });
		return new ClientMetadataError(
			reason,
			`The AI app's details could not be loaded from ${url.host}.`,
		);
	}

	/**
	 * Resolve the host, refuse it if any address is not public, and return the
	 * address to connect to (IPv4 first). The fetch is pinned to it, so a DNS
	 * answer that changes between check and connect is never used.
	 */
	async #vettedAddress(url: URL): Promise<string> {
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		if (isIpLiteral(hostname)) return hostname; // checked in #checkUrl
		let addresses: string[];
		try {
			addresses = await this.#lookup(hostname);
		} catch {
			throw this.#notLoaded("unresolvable", url);
		}
		if (
			addresses.length === 0 ||
			!addresses.every((a) => this.#addressAllowed(a))
		) {
			throw this.#notLoaded("private_address", url);
		}
		return (
			addresses.find((a) => parseIpv4(a) !== undefined) ?? addresses[0] ?? ""
		);
	}

	/** GET a JSON document from the vetted address; one of `types` only. */
	async #fetchJson(
		url: URL,
		address: string,
		types: readonly string[],
	): Promise<{ doc: unknown; cacheControl: string | null }> {
		const fail = (detail: string) =>
			this.#notLoaded("fetch_failed", url, detail);
		// Connect to the vetted address; Host and the TLS server name stay the
		// original host, so the certificate is checked against it.
		const pinned = new URL(url.href);
		pinned.hostname = address.includes(":") ? `[${address}]` : address;
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		const tls =
			url.protocol === "https:"
				? {
						tls: {
							...(isIpLiteral(hostname) ? {} : { serverName: hostname }),
							...(this.#testMode?.ca === undefined
								? {}
								: { ca: this.#testMode.ca }),
						},
					}
				: {};
		let response: Response;
		try {
			response = await this.#fetch(pinned.href, {
				method: "GET",
				redirect: "manual",
				headers: { accept: "application/json", host: url.host },
				signal: AbortSignal.timeout(this.#timeoutMs),
				...tls,
			} as RequestInit);
		} catch (error) {
			throw fail(
				`fetch_failed:${error instanceof Error ? error.name : "unknown"}`,
			);
		}
		try {
			if (response.status !== 200) throw fail(`status_${response.status}`);
			const type = (response.headers.get("content-type") ?? "")
				.split(";")[0]
				?.trim()
				.toLowerCase();
			if (type === undefined || !types.includes(type)) {
				throw fail("not_json");
			}
			const text = await this.#readLimited(response, url);
			let doc: unknown;
			try {
				doc = JSON.parse(text);
			} catch {
				throw fail("bad_json");
			}
			return { doc, cacheControl: response.headers.get("cache-control") };
		} finally {
			if (!response.bodyUsed) response.body?.cancel().catch(() => {});
		}
	}

	async #readLimited(response: Response, url: URL): Promise<string> {
		const tooLarge = () => this.#notLoaded("too_large", url);
		const length = Number(response.headers.get("content-length") ?? "0");
		if (length > this.#maxBytes) throw tooLarge();
		const reader = response.body?.getReader();
		if (reader === undefined) return "";
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > this.#maxBytes) {
				await reader.cancel().catch(() => {});
				throw tooLarge();
			}
			chunks.push(value);
		}
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(
				Buffer.concat(chunks),
			);
		} catch {
			throw this.#notLoaded("fetch_failed", url, "bad_utf8");
		}
	}
}

/** Labels separated by dots, ending in a label of 2-63 letters: `claude.ai`, `x.co.uk`. */
const DOMAIN_SHAPED =
	/(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,63}(?![\p{L}\p{N}])/gu;

/**
 * A name as the address checks read it: compatibility forms folded (NFKC),
 * combining marks removed, so "claude.a̲i" reads "claude.ai", the
 * ideographic full stops browsers read as dots made dots, lower case.
 */
function comparable(name: string): string {
	return name
		.normalize("NFKC")
		.replace(/\p{M}/gu, "")
		.replace(/[。．｡]/g, ".")
		.toLowerCase();
}

/** A host name in its ASCII (punycode) form, as `URL` gives it. */
function asciiHost(token: string): string {
	try {
		return new URL(`https://${token}/`).hostname;
	} catch {
		return token;
	}
}

/**
 * Whether a name contains a domain-shaped token that is not the verified
 * host, a subdomain of it or a parent of it (DEC-092). Internationalised
 * names are compared in their ASCII form, as the host is.
 */
export function foreignDomain(name: string, hostname: string): boolean {
	const host = hostname.toLowerCase();
	for (const [match] of comparable(name).matchAll(DOMAIN_SHAPED)) {
		const token = asciiHost(match);
		const own =
			token === host ||
			host.endsWith(`.${token}`) ||
			token.endsWith(`.${host}`);
		if (!own) return true;
	}
	return false;
}

/** Check a fetched document against the CIMD rules and what the relay supports. */
export function validateDocument(
	doc: unknown,
	clientId: string,
	url: URL,
	options: DocumentOptions = {},
): ClientMetadata {
	const invalid = (message: string) =>
		new ClientMetadataError("invalid_metadata", message);
	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
		throw invalid("The AI app's details are not a JSON object.");
	}
	const d = doc as Record<string, unknown>;
	if (d["client_id"] !== clientId) {
		throw invalid("The AI app's details name a different client_id.");
	}
	if (
		d["client_secret"] !== undefined ||
		d["client_secret_expires_at"] !== undefined
	) {
		throw invalid("The AI app's details must not contain a client secret.");
	}
	const name = d["client_name"];
	if (typeof name !== "string" || displayName(name) === "") {
		throw invalid("The AI app's details have no client_name.");
	}
	// "Claude (claude.ai)" from evil.example would read like a verified host.
	if (
		/\(\s*[^()\s]*[a-z0-9-]\.[a-z]{2,}[^()]*\)/i.test(
			comparable(displayName(name)),
		)
	) {
		throw invalid(
			"The AI app's name contains a web address in parentheses, which this relay does not show.",
		);
	}
	// "Claude · claude.ai" from evil.example reads the same way (DEC-092).
	if (foreignDomain(displayName(name), url.hostname)) {
		throw invalid(
			"The AI app's name contains a web address other than its own, which this relay does not show.",
		);
	}
	const uris = d["redirect_uris"];
	if (
		!Array.isArray(uris) ||
		uris.length === 0 ||
		uris.length > MAX_REDIRECT_URIS ||
		!uris.every((u) => typeof u === "string" && isRedirectUri(u))
	) {
		throw invalid("The AI app's details have no valid redirect_uris.");
	}
	const auth = clientAuth(d, url, options, invalid);
	const grants = d["grant_types"];
	if (
		grants !== undefined &&
		(!Array.isArray(grants) || !grants.includes("authorization_code"))
	) {
		throw invalid(
			"The AI app's details do not allow the authorization code grant.",
		);
	}
	const responses = d["response_types"];
	if (
		responses !== undefined &&
		(!Array.isArray(responses) || !responses.includes("code"))
	) {
		throw invalid('The AI app\'s details do not allow response type "code".');
	}
	return {
		clientId,
		name: displayName(name),
		host: url.host,
		redirectUris: uris as string[],
		auth,
	};
}

/**
 * How the client authenticates at `/token` (DEC-104, DEC-106):
 *
 * - `none` or no method: a public client;
 * - `private_key_jwt` with a `jwks_uri` on the client id's own host; an
 *   inline `jwks` is not accepted (one key path, rotated through the JWKS
 *   cache); `token_endpoint_auth_signing_alg`, if given, must be one the
 *   relay verifies and is then the only one accepted;
 * - any other method, or `private_key_jwt` whose keys the relay cannot use
 *   (no `jwks_uri`, one elsewhere or not canonical, `jwks` beside it, an
 *   algorithm it does not verify): accepted as a public client only when
 *   `token_endpoint_auth_methods_supported` lists `none` (DEC-104), else
 *   refused. `client_secret_*` never authenticates.
 */
function clientAuth(
	d: Record<string, unknown>,
	url: URL,
	options: DocumentOptions,
	invalid: (message: string) => ClientMetadataError,
): ClientAuth {
	const method = d["token_endpoint_auth_method"];
	const supported = d["token_endpoint_auth_methods_supported"];
	const listsNone = Array.isArray(supported) && supported.includes("none");
	if (method === undefined || method === "none") return { method: "none" };
	const checked: KeysOrProblem =
		method === "private_key_jwt"
			? privateKeyJwt(d, url, options.test === true)
			: {
					problem: "unsupported_method",
					message:
						'The AI app must use token_endpoint_auth_method "none" or "private_key_jwt" with this relay, or list "none" in token_endpoint_auth_methods_supported.',
				};
	if ("jwksUri" in checked) {
		return { method: "private_key_jwt", ...checked, publicAllowed: listsNone };
	}
	// Any problem with the method falls back to "none" when it is listed,
	// as in relay 0.5.1 (DEC-104); the caller logs why.
	if (listsNone) {
		options.onFallback?.(checked.problem);
		return { method: "none" };
	}
	throw invalid(checked.message);
}

type KeysOrProblem =
	| { jwksUri: string; algorithms: readonly JwtAlgorithm[] }
	| { problem: string; message: string };

/**
 * A `private_key_jwt` document's keys: a `jwks_uri` with the client id's
 * scheme and host (port included), in the form the relay fetches it, and
 * the algorithms. Or what is wrong with them.
 */
function privateKeyJwt(
	d: Record<string, unknown>,
	url: URL,
	test: boolean,
): KeysOrProblem {
	const jwksUri = d["jwks_uri"];
	if (jwksUri === undefined) {
		return {
			problem: "no_jwks_uri",
			message:
				"The AI app uses private_key_jwt but publishes no jwks_uri (an inline jwks is not accepted).",
		};
	}
	if (d["jwks"] !== undefined) {
		// RFC 7591 §2: the two must not both be present.
		return {
			problem: "jwks_and_jwks_uri",
			message: "The AI app's details have both jwks and jwks_uri.",
		};
	}
	// The scheme and host of the client id, which passed the client id rules:
	// the keys are the verified host's own.
	const parsed =
		typeof jwksUri === "string" ? parseJwksUri(jwksUri, test) : undefined;
	if (
		parsed === undefined ||
		parsed.protocol !== url.protocol ||
		parsed.host !== url.host
	) {
		return {
			problem: "bad_jwks_uri",
			message:
				"The AI app's jwks_uri must be an https:// URL on the host of its client_id.",
		};
	}
	const alg = d["token_endpoint_auth_signing_alg"];
	if (alg !== undefined && !isAlgorithm(alg)) {
		return {
			problem: "signing_alg",
			message:
				"The AI app's token_endpoint_auth_signing_alg is not one this relay accepts.",
		};
	}
	// Only the one it names, or all the relay verifies.
	return {
		jwksUri: parsed.href,
		algorithms: alg === undefined ? JWT_ALGORITHMS : [alg],
	};
}

/**
 * A `jwks_uri` as the relay accepts it: an absolute `https:` URL (`http:`
 * only in test mode) of at most 2048 characters, in canonical form, without
 * credentials or fragment, on the default port (any port in test mode).
 */
function parseJwksUri(value: string, test: boolean): URL | undefined {
	if (value.length > MAX_CLIENT_ID_LENGTH) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	const scheme =
		url.protocol === "https:" || (test && url.protocol === "http:");
	if (!scheme || url.href !== value) return undefined;
	if (url.username !== "" || url.password !== "" || url.hash !== "") {
		return undefined;
	}
	if (url.port !== "" && !test) return undefined;
	return url;
}

/** A private-use URI scheme in reverse-domain form (RFC 8252 §7.1), e.g. `com.example.app:`. */
const PRIVATE_USE_SCHEME = /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/;

/**
 * A redirect URI the relay accepts (DEC-067): absolute, no fragment or
 * credentials, and `https:`; `http:` only for loopback hosts (RFC 8252 §7.3);
 * or a reverse-domain private-use scheme for native apps (RFC 8252 §7.1).
 * Everything else (`file:`, `blob:`, `data:`, `javascript:`, plain `http:`,
 * one-word custom schemes) is refused.
 */
export function isRedirectUri(value: string): boolean {
	if (value.length > 2048 || value.includes("#")) return false;
	let u: URL;
	try {
		u = new URL(value);
	} catch {
		return false;
	}
	if (u.username !== "" || u.password !== "") return false;
	if (u.protocol === "https:") return u.hostname !== "";
	if (u.protocol === "http:") return LOOPBACK_REDIRECT_HOSTS.has(u.hostname);
	return PRIVATE_USE_SCHEME.test(u.protocol);
}

const LOOPBACK_REDIRECT_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a requested redirect URI matches a registered one: exact string
 * equality, except that for an `http:` loopback redirect the port is ignored
 * (RFC 8252 §7.3; OAuth 2.1 §8.4.2). Host, path and query must still match.
 */
export function redirectUriMatches(
	requested: string,
	registered: string,
): boolean {
	if (requested === registered) return true;
	let a: URL;
	let b: URL;
	try {
		a = new URL(requested);
		b = new URL(registered);
	} catch {
		return false;
	}
	if (a.protocol !== "http:" || b.protocol !== "http:") return false;
	if (!LOOPBACK_REDIRECT_HOSTS.has(b.hostname) || a.hostname !== b.hostname) {
		return false;
	}
	// The requested URI must be in canonical form, so the parser cannot
	// have changed what the comparison sees (dot segments, case, …).
	if (
		a.href !== requested ||
		a.username !== "" ||
		a.password !== "" ||
		a.hash !== ""
	) {
		return false;
	}
	a.port = "";
	b.port = "";
	return a.href === b.href;
}
