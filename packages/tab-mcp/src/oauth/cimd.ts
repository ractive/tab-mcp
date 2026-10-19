/**
 * Client ID Metadata Documents (CIMD, draft-ietf-oauth-client-id-metadata-document;
 * MCP 2026-07-28 client registration): the `client_id` is an HTTPS URL, and
 * the relay fetches it to learn the client's name and redirect URIs.
 *
 * The URL is chosen by an unauthenticated party, so the fetch is guarded
 * against SSRF (threat model A3): https only, default port, no credentials,
 * the host resolved first and every address checked to be public, no
 * redirects, 5 s, 64 KiB, `application/json`, results cached and fetches per
 * host rate-limited.
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

/** Collapse whitespace, drop control characters, cap the length. */
export function displayName(raw: string): string {
	let cleaned = "";
	for (const ch of raw.normalize("NFC")) {
		const c = ch.codePointAt(0) ?? 0;
		const control = c < 0x20 || (c >= 0x7f && c <= 0x9f);
		// Bidi controls could reorder the text around the name.
		const bidi = (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
		cleaned += control || bidi ? " " : ch;
	}
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

/** Fetches, validates and caches Client ID Metadata Documents. */
export class ClientMetadataFetcher {
	readonly #cache = new Map<string, { meta: ClientMetadata; until: number }>();
	readonly #perHost = new RateLimiter({ capacity: 5, refillPerSecond: 0.2 });
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
		if (cached !== undefined && cached.until > now) return cached.meta;
		if (!this.#perHost.take(url.host, now)) {
			throw new ClientMetadataError(
				"rate_limited",
				"Too many requests for this AI app's details. Try again in a minute.",
			);
		}
		await this.#checkAddresses(url);
		const { meta, ttlMs } = await this.#fetchDocument(url, clientId);
		if (this.#cache.size >= MAX_CACHE_ENTRIES) {
			const oldest = this.#cache.keys().next().value;
			if (oldest !== undefined) this.#cache.delete(oldest);
		}
		this.#cache.delete(clientId);
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
			throw new ClientMetadataError(
				"private_address",
				"The AI app's client_id points to a private network address.",
			);
		}
		return url;
	}

	#addressAllowed(address: string): boolean {
		if (isPublicIp(address)) return true;
		return this.#testMode !== undefined && isLoopbackHost(address);
	}

	/** Resolve the host and refuse it if any address is not public. */
	async #checkAddresses(url: URL): Promise<void> {
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		if (isIpLiteral(hostname)) return; // checked in #checkUrl
		if (this.#testMode !== undefined && isLoopbackHost(hostname)) return;
		let addresses: string[];
		try {
			addresses = await this.#lookup(hostname);
		} catch {
			throw new ClientMetadataError(
				"unresolvable",
				`The AI app's host ${url.host} could not be found.`,
			);
		}
		if (
			addresses.length === 0 ||
			!addresses.every((a) => this.#addressAllowed(a))
		) {
			throw new ClientMetadataError(
				"private_address",
				"The AI app's client_id points to a private network address.",
			);
		}
	}

	async #fetchDocument(
		url: URL,
		clientId: string,
	): Promise<{ meta: ClientMetadata; ttlMs: number }> {
		const unreachable = (message: string) =>
			new ClientMetadataError("fetch_failed", message);
		let response: Response;
		try {
			response = await this.#fetch(clientId, {
				method: "GET",
				redirect: "manual",
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(this.#timeoutMs),
				...(this.#testMode?.ca === undefined
					? {}
					: { tls: { ca: this.#testMode.ca } }),
			} as RequestInit);
		} catch (error) {
			this.#logger?.info("oauth.cimd_failed", {
				host: url.host,
				reason: error instanceof Error ? error.name : "unknown",
			});
			throw unreachable("The AI app's details could not be loaded.");
		}
		try {
			if (response.status >= 300 && response.status < 400) {
				throw unreachable(
					"The AI app's details are behind a redirect, which is not followed.",
				);
			}
			if (response.status !== 200) {
				throw unreachable(
					`The AI app's details could not be loaded (HTTP ${response.status}).`,
				);
			}
			const type = (response.headers.get("content-type") ?? "")
				.split(";")[0]
				?.trim()
				.toLowerCase();
			if (type !== "application/json") {
				throw unreachable("The AI app's details are not JSON.");
			}
			const text = await this.#readLimited(response);
			let doc: unknown;
			try {
				doc = JSON.parse(text);
			} catch {
				throw unreachable("The AI app's details are not valid JSON.");
			}
			const meta = validateDocument(doc, clientId, url);
			return { meta, ttlMs: cacheMs(response.headers.get("cache-control")) };
		} finally {
			if (!response.bodyUsed) response.body?.cancel().catch(() => {});
		}
	}

	async #readLimited(response: Response): Promise<string> {
		const tooLarge = () =>
			new ClientMetadataError(
				"too_large",
				"The AI app's details are too large.",
			);
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
			throw new ClientMetadataError(
				"fetch_failed",
				"The AI app's details are not valid UTF-8.",
			);
		}
	}
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

/** An absolute URI without a fragment (RFC 6749 §3.1.2). */
export function isRedirectUri(value: string): boolean {
	if (value.length > 2048) return false;
	try {
		const u = new URL(value);
		return (
			u.hash === "" &&
			!value.includes("#") &&
			u.protocol !== "javascript:" &&
			u.protocol !== "data:"
		);
	} catch {
		return false;
	}
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
