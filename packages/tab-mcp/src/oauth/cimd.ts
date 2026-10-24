/**
 * Client ID Metadata Documents (CIMD, draft-ietf-oauth-client-id-metadata-document;
 * MCP 2026-07-28 client registration): the `client_id` is an HTTPS URL, and
 * the relay fetches it to learn the client's name and redirect URIs.
 *
 * The URL is chosen by an unauthenticated party, so the fetch is guarded
 * against SSRF (threat model A3): https only, default port, no credentials,
 * the host resolved first and every address checked to be public, no
 * redirects, 5 s, 64 KiB, `application/json`, results cached and fetches per
 * domain and in total rate-limited.
 */

import { isLoopbackHost, isPublicIp, parseIpv4, parseIpv6 } from "../ip.ts";
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

	/** The client's metadata, from the cache or freshly fetched. Throws `ClientMetadataError`. */
	async get(clientId: string): Promise<ClientMetadata> {
		const url = this.#checkUrl(clientId);
		const now = this.#now();
		const cached = this.#cache.get(clientId);
		if (cached !== undefined && cached.until > now) {
			// Least recently used first: a hit moves the entry to the end.
			this.#cache.delete(clientId);
			this.#cache.set(clientId, cached);
			return cached.meta;
		}
		// Per host and per domain, and only charged once the global limit
		// admits the fetch: refusals cost the others nothing (DEC-089).
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
		const address = await this.#vettedAddress(url);
		const { meta, ttlMs } = await this.#fetchDocument(url, clientId, address);
		this.#cache.delete(clientId);
		if (this.#cache.size >= MAX_CACHE_ENTRIES) {
			const oldest = this.#cache.keys().next().value;
			if (oldest !== undefined) this.#cache.delete(oldest);
		}
		this.#cache.set(clientId, { meta, until: now + ttlMs });
		return meta;
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

	async #fetchDocument(
		url: URL,
		clientId: string,
		address: string,
	): Promise<{ meta: ClientMetadata; ttlMs: number }> {
		const fail = (detail: string) =>
			this.#notLoaded("fetch_failed", url, detail);
		// Connect to the vetted address; Host and the TLS server name stay the
		// original host, so the certificate is checked against it.
		const pinned = new URL(clientId);
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
			if (type !== "application/json") throw fail("not_json");
			const text = await this.#readLimited(response, url);
			let doc: unknown;
			try {
				doc = JSON.parse(text);
			} catch {
				throw fail("bad_json");
			}
			const meta = validateDocument(doc, clientId, url);
			return { meta, ttlMs: cacheMs(response.headers.get("cache-control")) };
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
	const method = d["token_endpoint_auth_method"];
	if (method !== undefined && method !== "none") {
		throw invalid(
			'The AI app must use token_endpoint_auth_method "none" with this relay.',
		);
	}
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
	};
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
