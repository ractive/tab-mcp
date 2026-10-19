/**
 * The relay's OAuth 2.1 authorization server (DEC-006, DEC-015, DEC-031),
 * written without an OAuth library:
 *
 * - RFC 9728 protected-resource metadata per address, RFC 8414 server metadata;
 * - clients only through Client ID Metadata Documents (`cimd.ts`);
 * - `/authorize` with PKCE S256 only, exact redirect URIs (loopback port
 *   relaxed), `resource` bound to one address (RFC 8707), `iss` in every
 *   response (RFC 9207), and the pairing step of the address's site (DEC-042);
 * - `/token` for the authorization code and rotating refresh tokens (DEC-029);
 * - `/revoke` (RFC 7009).
 */

import { timingSafeEqual } from "node:crypto";
import { isAddressId, shortAddress } from "../address.ts";
import type { PairingKind, RelayConfig, Site } from "../config.ts";
import type { Logger } from "../log.ts";
import type { GrantInfo } from "../protocol.ts";
import { RateLimiter } from "../ratelimit.ts";
import type { TokenRecord, TokenStore } from "../store/types.ts";
import { hashToken, issueTokenPair, newId } from "../tokens.ts";
import {
	type CimdTestMode,
	type ClientMetadata,
	ClientMetadataError,
	ClientMetadataFetcher,
	redirectUriMatches,
} from "./cimd.ts";
import { AUTHORIZE_CSS, escapeHtml, pageHeaders, renderPage } from "./html.ts";
import {
	PAIRING_METHODS,
	type PairingMethod,
	type PairingTarget,
} from "./pairing.ts";

/** The only scope: calling the page's tools. */
export const SCOPE = "tools";

/** How long a user has to finish the `/authorize` page. */
const PENDING_TTL_MS = 10 * 60_000;
/** Authorization codes are single-use and short-lived (RFC 6749 §4.1.2). */
const AUTH_CODE_TTL_MS = 60_000;
const MAX_PENDING = 10_000;
const MAX_CODES = 10_000;
const MAX_FORM_BYTES = 8192;
const MAX_STATE_LENGTH = 1024;

/** A tab session as the authorization server sees it. */
export interface AuthorizeSession extends PairingTarget {
	readonly origin: string;
	readonly appName: string | undefined;
	readonly site: Site;
}

export interface AuthorizationHost {
	readonly config: RelayConfig;
	readonly logger: Logger;
	readonly store: TokenStore;
	publicUrl(): string;
	/** The connected (ready) tab session of an address. */
	session(addressId: string): AuthorizeSession | undefined;
	/** Tell the address's tab, if connected. */
	grantAdded(addressId: string, grant: GrantInfo): void;
	grantRemoved(addressId: string, grantId: string, reason: string): void;
}

/** Test-only settings; never reachable from configuration. */
export interface AuthorizationTestMode {
	cimd?: CimdTestMode;
	authCodeTtlMs?: number;
	/** Replace the pairing methods (a stub method proves the server needs no codes). */
	pairingMethods?: Partial<Record<PairingKind, PairingMethod>>;
}

interface AuthorizationRequest {
	client: ClientMetadata;
	redirectUri: string;
	state: string | undefined;
	codeChallenge: string;
	addressId: string;
	resource: string;
	scopes: string[];
}

interface Pending extends AuthorizationRequest {
	id: string;
	expiresAt: number;
}

interface IssuedCode extends AuthorizationRequest {
	expiresAt: number;
	used: boolean;
	grantId?: string;
}

class OAuthError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, description: string) {
		super(description);
		this.status = status;
		this.code = code;
	}
}

function constantTimeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/** BASE64URL(SHA256(verifier)) (RFC 7636 §4.6). */
export function s256(verifier: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(verifier)
		.digest()
		.toBase64({ alphabet: "base64url", omitPadding: true });
}

/** RFC 7636 §4.1: 43-128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Parameters, refusing duplicates (RFC 6749 §3.1, §3.2). */
function single(
	params: URLSearchParams,
	names: readonly string[],
): Record<string, string | undefined> | { duplicate: string } {
	const out: Record<string, string | undefined> = {};
	for (const name of names) {
		const values = params.getAll(name);
		if (values.length > 1) return { duplicate: name };
		const value = values[0];
		out[name] = value === undefined || value === "" ? undefined : value;
	}
	return out;
}

function random(bytes: number): string {
	return crypto
		.getRandomValues(new Uint8Array(bytes))
		.toBase64({ alphabet: "base64url", omitPadding: true });
}

/** The origin a redirect URI sends the browser to, for CSP `form-action`. */
function formTarget(redirectUri: string): string {
	try {
		const u = new URL(redirectUri);
		return u.protocol === "http:" || u.protocol === "https:"
			? u.origin
			: u.protocol;
	} catch {
		return "'none'";
	}
}

function hostOf(url: string): string {
	try {
		const u = new URL(url);
		return u.host || u.protocol;
	} catch {
		return url;
	}
}

/** The OAuth endpoints and pages, mounted by the relay. */
export class AuthorizationServer {
	readonly #host: AuthorizationHost;
	readonly #cimd: ClientMetadataFetcher;
	readonly #pending = new Map<string, Pending>();
	readonly #codes = new Map<string, IssuedCode>();
	readonly #authCodeTtlMs: number;
	readonly #methods: Partial<Record<PairingKind, PairingMethod>>;
	readonly #csrfSecret = random(32);
	/** `/authorize` page loads per IP. */
	readonly #viewsPerIp = new RateLimiter({
		capacity: 30,
		refillPerSecond: 0.5,
	});
	/** Pairing attempts per IP and per address (threat model A1). */
	readonly #attemptsPerIp = new RateLimiter({
		capacity: 20,
		refillPerSecond: 0.1,
	});
	readonly #attemptsPerAddress = new RateLimiter({
		capacity: 10,
		refillPerSecond: 1 / 30,
	});
	readonly #tokenPerIp = new RateLimiter({ capacity: 30, refillPerSecond: 1 });

	constructor(host: AuthorizationHost, testMode?: AuthorizationTestMode) {
		this.#host = host;
		this.#authCodeTtlMs = testMode?.authCodeTtlMs ?? AUTH_CODE_TTL_MS;
		this.#methods = testMode?.pairingMethods ?? PAIRING_METHODS;
		this.#cimd = new ClientMetadataFetcher({
			allowedHosts: host.config.clientIdHosts,
			logger: host.logger,
			...(testMode?.cimd === undefined ? {} : { testMode: testMode.cimd }),
		});
	}

	get #issuer(): string {
		return this.#host.publicUrl();
	}

	#cors(): Record<string, string> {
		return this.#host.config.cors ? { "access-control-allow-origin": "*" } : {};
	}

	#json(
		status: number,
		value: unknown,
		headers: Record<string, string> = {},
	): Response {
		return new Response(JSON.stringify(value), {
			status,
			headers: {
				"content-type": "application/json",
				...this.#cors(),
				...headers,
			},
		});
	}

	/** CORS preflight for the metadata, token and revoke endpoints. */
	preflight(methods: string): Response {
		if (!this.#host.config.cors) {
			return new Response(null, { status: 405, headers: { allow: methods } });
		}
		return new Response(null, {
			status: 204,
			headers: {
				...this.#cors(),
				"access-control-allow-methods": `${methods}, OPTIONS`,
				"access-control-allow-headers":
					"authorization, content-type, mcp-protocol-version",
				"access-control-max-age": "600",
			},
		});
	}

	// RFC 9728 and RFC 8414

	/** `/.well-known/oauth-protected-resource/a/{id}/mcp`. */
	protectedResource(addressId: string): Response {
		if (!isAddressId(addressId))
			return new Response("Not found", { status: 404 });
		return this.#json(
			200,
			{
				resource: `${this.#issuer}/a/${addressId}/mcp`,
				authorization_servers: [this.#issuer],
				scopes_supported: [SCOPE],
				bearer_methods_supported: ["header"],
				resource_name: "Tools of a web page (tab-mcp)",
			},
			{ "cache-control": "public, max-age=3600" },
		);
	}

	/** `/.well-known/oauth-authorization-server`. */
	metadata(): Response {
		const issuer = this.#issuer;
		return this.#json(
			200,
			{
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				revocation_endpoint: `${issuer}/revoke`,
				response_types_supported: ["code"],
				response_modes_supported: ["query"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
				revocation_endpoint_auth_methods_supported: ["none"],
				scopes_supported: [SCOPE],
				client_id_metadata_document_supported: true,
				authorization_response_iss_parameter_supported: true,
				service_documentation: "https://github.com/ractive/tab-mcp",
			},
			{ "cache-control": "public, max-age=3600" },
		);
	}

	stylesheet(): Response {
		return new Response(AUTHORIZE_CSS, {
			headers: {
				"content-type": "text/css; charset=utf-8",
				"cache-control": "public, max-age=3600",
				"x-content-type-options": "nosniff",
			},
		});
	}

	// /authorize

	#page(
		status: number,
		title: string,
		body: string,
		formTargets: readonly string[] = [],
		extraHeaders: Record<string, string> = {},
	): Response {
		const headers = pageHeaders(formTargets);
		for (const [k, v] of Object.entries(extraHeaders)) headers.append(k, v);
		return new Response(renderPage(title, body), { status, headers });
	}

	/** An error shown on the page: the redirect URI is not trusted (yet). */
	#errorPage(status: number, message: string): Response {
		return this.#page(
			status,
			"This connection cannot be made",
			`<h1>This connection cannot be made</h1>
<p role="alert">${escapeHtml(message)}</p>
<p>Go back to your AI tool and try again. If it keeps happening, the AI tool may not work with this relay.</p>`,
		);
	}

	/** Back to the client with `error` (RFC 6749 §4.1.2.1) and `iss`. */
	#redirectError(
		redirectUri: string,
		state: string | undefined,
		error: string,
		description: string,
	): Response {
		return this.#redirect(redirectUri, {
			error,
			error_description: description,
			...(state === undefined ? {} : { state }),
			iss: this.#issuer,
		});
	}

	#redirect(redirectUri: string, params: Record<string, string>): Response {
		const url = new URL(redirectUri);
		for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);
		return new Response(null, {
			status: 303,
			headers: {
				location: url.href,
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			},
		});
	}

	/** GET `/authorize`: check the request, then show the pairing page. */
	async authorize(req: Request, ip: string): Promise<Response> {
		if (!this.#viewsPerIp.take(ip)) {
			return this.#errorPage(
				429,
				"Too many requests from your network. Wait a minute and try again.",
			);
		}
		const query = new URL(req.url).searchParams;
		const p = single(query, [
			"response_type",
			"client_id",
			"redirect_uri",
			"code_challenge",
			"code_challenge_method",
			"state",
			"resource",
			"scope",
		]);
		if ("duplicate" in p) {
			if (p.duplicate === "client_id" || p.duplicate === "redirect_uri") {
				return this.#errorPage(400, `The request names ${p.duplicate} twice.`);
			}
		}
		const clientId = "duplicate" in p ? query.get("client_id") : p["client_id"];
		const redirectUri =
			"duplicate" in p ? query.get("redirect_uri") : p["redirect_uri"];
		if (clientId === undefined || clientId === null) {
			return this.#errorPage(400, "The request has no client_id.");
		}
		let client: ClientMetadata;
		try {
			client = await this.#cimd.get(clientId);
		} catch (error) {
			if (error instanceof ClientMetadataError) {
				this.#host.logger.info("oauth.client_refused", {
					reason: error.reason,
					host: hostOf(clientId).slice(0, 100),
				});
				return this.#errorPage(400, error.message);
			}
			throw error;
		}
		if (redirectUri === undefined || redirectUri === null) {
			return this.#errorPage(400, "The request has no redirect_uri.");
		}
		if (!client.redirectUris.some((r) => redirectUriMatches(redirectUri, r))) {
			this.#host.logger.info("oauth.client_refused", {
				reason: "redirect_uri",
				host: client.host,
			});
			return this.#errorPage(
				400,
				`${client.name} asked to return to an address it has not registered (${hostOf(redirectUri)}).`,
			);
		}
		// From here on errors go back to the (now trusted) redirect URI.
		const state = "duplicate" in p ? undefined : p["state"];
		const fail = (error: string, description: string) =>
			this.#redirectError(redirectUri, state, error, description);
		if ("duplicate" in p) {
			return fail("invalid_request", `${p.duplicate} was sent more than once`);
		}
		if (state !== undefined && state.length > MAX_STATE_LENGTH) {
			return fail("invalid_request", "state is too long");
		}
		if (p["response_type"] !== "code") {
			return fail(
				"unsupported_response_type",
				"only response_type=code is supported",
			);
		}
		const challenge = p["code_challenge"];
		if (challenge === undefined) {
			return fail("invalid_request", "code_challenge is required (PKCE)");
		}
		if (p["code_challenge_method"] !== "S256") {
			return fail("invalid_request", "code_challenge_method must be S256");
		}
		if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(challenge)) {
			return fail("invalid_request", "code_challenge is malformed");
		}
		const resource = p["resource"];
		const addressId = this.#addressOf(resource);
		if (resource === undefined || addressId === undefined) {
			return fail(
				"invalid_target",
				"resource must be the MCP address of a page on this relay",
			);
		}
		const scopes = this.#grantedScopes(p["scope"]);
		if (scopes === undefined) {
			return fail("invalid_scope", `the only scope is "${SCOPE}"`);
		}

		const pending: Pending = {
			id: random(24),
			expiresAt: Date.now() + PENDING_TTL_MS,
			client,
			redirectUri,
			state,
			codeChallenge: challenge,
			addressId,
			resource,
			scopes,
		};
		if (this.#pending.size >= MAX_PENDING) this.#sweepPending(true);
		this.#pending.set(pending.id, pending);
		const browser = this.#browserId(req);
		return this.#pairingPage(
			pending,
			browser.id,
			undefined,
			200,
			browser.cookie,
		);
	}

	/** POST `/authorize`: the pairing form (connect, cancel, try again). */
	async authorizeSubmit(req: Request, ip: string): Promise<Response> {
		// Only our own form may post here (defence in depth beside the token).
		const origin = req.headers.get("origin");
		const site = req.headers.get("sec-fetch-site");
		if (
			(origin !== null && origin !== this.#issuer) ||
			(site !== null && site !== "same-origin")
		) {
			return this.#errorPage(403, "This form can only be sent from this page.");
		}
		if (!this.#attemptsPerIp.take(ip)) {
			return this.#errorPage(
				429,
				"Too many attempts from your network. Wait a few minutes, then start again from your AI tool.",
			);
		}
		const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim();
		if (type !== "application/x-www-form-urlencoded") {
			return this.#errorPage(400, "The form was not sent correctly.");
		}
		const text = await this.#readForm(req);
		if (text === undefined) {
			return this.#errorPage(413, "The form was too large.");
		}
		const form = new URLSearchParams(text);
		const pending = this.#pending.get(form.get("request_id") ?? "");
		if (pending === undefined || pending.expiresAt <= Date.now()) {
			return this.#errorPage(
				400,
				"This connection request has expired or was already used.",
			);
		}
		const browser = this.#browserId(req);
		const csrf = form.get("csrf") ?? "";
		if (
			browser.cookie !== undefined ||
			!Bun.CSRF.verify(csrf, {
				secret: this.#csrfSecret,
				sessionId: `${pending.id}.${browser.id}`,
				maxAge: PENDING_TTL_MS,
			})
		) {
			// A new cookie means the browser did not send ours: not the same visit.
			return this.#errorPage(
				403,
				"The form could not be checked. Your browser may block cookies for this site.",
			);
		}

		const action = form.get("action");
		if (action === "cancel") {
			this.#pending.delete(pending.id);
			this.#host.logger.info("oauth.cancelled", {
				address: shortAddress(pending.addressId),
				client: pending.client.host,
			});
			return this.#redirectError(
				pending.redirectUri,
				pending.state,
				"access_denied",
				"the user cancelled the connection",
			);
		}
		if (action !== "connect") {
			return this.#pairingPage(pending, browser.id);
		}

		const session = this.#host.session(pending.addressId);
		if (session === undefined) {
			return this.#pairingPage(
				pending,
				browser.id,
				"The page is still not open.",
			);
		}
		if (!this.#attemptsPerAddress.take(pending.addressId)) {
			return this.#pairingPage(
				pending,
				browser.id,
				"Too many attempts for this page. Wait a few minutes and try again.",
				429,
			);
		}
		const method = this.#methods[session.site.pairing];
		if (method === undefined) {
			return this.#errorPage(
				500,
				"This page's pairing method is not available.",
			);
		}
		const result = await method.check(session, form);
		if (!result.ok) {
			this.#host.logger.info("oauth.pairing_failed", {
				address: shortAddress(pending.addressId),
				client: pending.client.host,
				reason: result.reason,
			});
			return this.#pairingPage(pending, browser.id, result.message, 400);
		}

		this.#pending.delete(pending.id);
		const code = random(32);
		if (this.#codes.size >= MAX_CODES) this.#sweepCodes(true);
		const { id: _id, expiresAt: _expires, ...request } = pending;
		this.#codes.set(hashToken(code), {
			...request,
			expiresAt: Date.now() + this.#authCodeTtlMs,
			used: false,
		});
		this.#host.logger.info("oauth.paired", {
			address: shortAddress(pending.addressId),
			client: pending.client.host,
			method: method.kind,
		});
		return this.#redirect(pending.redirectUri, {
			code,
			...(pending.state === undefined ? {} : { state: pending.state }),
			iss: this.#issuer,
		});
	}

	#addressOf(resource: string | undefined): string | undefined {
		if (resource === undefined) return undefined;
		const prefix = `${this.#issuer}/a/`;
		if (!resource.startsWith(prefix) || !resource.endsWith("/mcp")) {
			return undefined;
		}
		const id = resource.slice(prefix.length, -"/mcp".length);
		return isAddressId(id) ? id : undefined;
	}

	/** Requested scopes reduced to what exists; `undefined` = none of them. */
	#grantedScopes(scope: string | undefined): string[] | undefined {
		if (scope === undefined) return [SCOPE];
		const requested = scope.split(" ").filter((s) => s !== "");
		if (requested.length === 0) return [SCOPE];
		return requested.includes(SCOPE) ? [SCOPE] : undefined;
	}

	/** The browser's visit id from our cookie, or a new one with its cookie. */
	#browserId(req: Request): { id: string; cookie?: string } {
		const name = this.#cookieName();
		const header = req.headers.get("cookie") ?? "";
		for (const part of header.split(";")) {
			const [k, v] = part.trim().split("=");
			if (k === name && v !== undefined && /^[A-Za-z0-9_-]{22}$/.test(v)) {
				return { id: v };
			}
		}
		const id = random(16);
		const secure = this.#issuer.startsWith("https:") ? "; Secure" : "";
		return {
			id,
			cookie: `${name}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PENDING_TTL_MS / 1000}${secure}`,
		};
	}

	#cookieName(): string {
		return this.#issuer.startsWith("https:")
			? "__Host-tab-mcp-authorize"
			: "tab-mcp-authorize";
	}

	async #readForm(req: Request): Promise<string | undefined> {
		const length = Number(req.headers.get("content-length") ?? "0");
		if (length > MAX_FORM_BYTES) return undefined;
		const bytes = await req.arrayBuffer().catch(() => new ArrayBuffer(0));
		if (bytes.byteLength > MAX_FORM_BYTES) return undefined;
		return new TextDecoder().decode(bytes);
	}

	#pairingPage(
		pending: Pending,
		browserId: string,
		error?: string,
		status = 200,
		cookie?: string,
	): Response {
		const csrf = Bun.CSRF.generate(this.#csrfSecret, {
			sessionId: `${pending.id}.${browserId}`,
			expiresIn: PENDING_TTL_MS,
		});
		const client = pending.client;
		const clientLabel = `<strong>${escapeHtml(client.name)}</strong> (${escapeHtml(client.host)})`;
		const hidden = `<input type="hidden" name="request_id" value="${escapeHtml(pending.id)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
		const errorHtml =
			error === undefined
				? ""
				: `<p class="error" role="alert" id="error">${escapeHtml(error)}</p>`;
		const extra = cookie === undefined ? {} : { "set-cookie": cookie };
		const targets = [formTarget(pending.redirectUri)];
		const cancel = `<button type="submit" class="secondary" name="action" value="cancel" formnovalidate>Cancel</button>`;

		const session = this.#host.session(pending.addressId);
		if (session === undefined) {
			const body = `<h1>Open the page first</h1>
${errorHtml}
<p>${clientLabel} wants to use the tools of a web page, but that page is not open right now.</p>
<p>Open the page, click “Connect your AI tool”, then try again here.</p>
<form method="post" action="/authorize">
${hidden}
<div class="actions">
<button type="submit" class="primary" name="action" value="retry">Try again</button>
${cancel}
</div>
</form>`;
			return this.#page(status, "Open the page first", body, targets, extra);
		}

		const method = this.#methods[session.site.pairing];
		if (method === undefined) {
			return this.#errorPage(
				500,
				"This page's pairing method is not available.",
			);
		}
		// A browser always sends an Origin; only a non-browser tab on an open
		// relay has none.
		const page =
			session.origin === ""
				? "a page that did not say where it runs"
				: `<span class="origin">${escapeHtml(session.origin)}</span>`;
		const target =
			session.appName === undefined
				? `tools from ${page}`
				: `<strong>${escapeHtml(session.appName)}</strong> on ${page}`;
		const body = `<h1>Connect ${escapeHtml(client.name)}</h1>
<p>You're connecting ${clientLabel} to ${target}.</p>
<p>${escapeHtml(client.name)} can then use this page's tools while the page is open. You can disconnect it in the page at any time.</p>
${errorHtml}
<form method="post" action="/authorize">
${hidden}
${method.render(session)}
<div class="actions">
<button type="submit" class="primary" name="action" value="connect">Connect</button>
${cancel}
</div>
</form>
<p class="help">After you connect, your browser goes back to ${escapeHtml(hostOf(pending.redirectUri))}. Only connect AI tools you started yourself.</p>`;
		return this.#page(status, `Connect ${client.name}`, body, targets, extra);
	}

	// /token

	/** POST `/token`. */
	async token(req: Request, ip: string): Promise<Response> {
		const noStore = { "cache-control": "no-store", pragma: "no-cache" };
		try {
			if (!this.#tokenPerIp.take(ip)) {
				throw new OAuthError(
					429,
					"temporarily_unavailable",
					"too many requests; try again shortly",
				);
			}
			const params = await this.#formParams(req);
			const p = single(params, [
				"grant_type",
				"client_id",
				"code",
				"redirect_uri",
				"code_verifier",
				"refresh_token",
				"resource",
				"scope",
			]);
			if ("duplicate" in p) {
				throw new OAuthError(
					400,
					"invalid_request",
					`${p.duplicate} was sent more than once`,
				);
			}
			const clientId = p["client_id"];
			if (clientId === undefined) {
				throw new OAuthError(400, "invalid_request", "client_id is required");
			}
			let body: Record<string, unknown>;
			if (p["grant_type"] === "authorization_code") {
				body = await this.#codeGrant(p, clientId);
			} else if (p["grant_type"] === "refresh_token") {
				body = await this.#refreshGrant(p, clientId);
			} else if (p["grant_type"] === undefined) {
				throw new OAuthError(400, "invalid_request", "grant_type is required");
			} else {
				throw new OAuthError(
					400,
					"unsupported_grant_type",
					"only authorization_code and refresh_token are supported",
				);
			}
			return this.#json(200, body, noStore);
		} catch (error) {
			return this.#oauthErrorResponse(error, noStore);
		}
	}

	#oauthErrorResponse(
		error: unknown,
		headers: Record<string, string>,
	): Response {
		if (error instanceof OAuthError) {
			const extra: Record<string, string> = { ...headers };
			if (error.status === 401)
				extra["www-authenticate"] = 'Basic realm="tab-mcp"';
			if (error.status === 429 || error.status === 503)
				extra["retry-after"] = "10";
			return this.#json(
				error.status,
				{ error: error.code, error_description: error.message },
				extra,
			);
		}
		this.#host.logger.error("oauth.error", {
			message: error instanceof Error ? error.name : "unknown",
		});
		return this.#json(
			503,
			{
				error: "temporarily_unavailable",
				error_description: "the relay cannot issue tokens right now",
			},
			{ ...headers, "retry-after": "10" },
		);
	}

	/** Form parameters of a token or revocation request (client auth `none` only). */
	async #formParams(req: Request): Promise<URLSearchParams> {
		const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim();
		if (type !== "application/x-www-form-urlencoded") {
			throw new OAuthError(
				400,
				"invalid_request",
				"the body must be application/x-www-form-urlencoded",
			);
		}
		if (req.headers.get("authorization") !== null) {
			// RFC 6749 §5.2: a client that tried to authenticate gets 401.
			throw new OAuthError(
				401,
				"invalid_client",
				"client authentication is not supported (token_endpoint_auth_method none)",
			);
		}
		const text = await this.#readForm(req);
		if (text === undefined) {
			throw new OAuthError(413, "invalid_request", "the request is too large");
		}
		const params = new URLSearchParams(text);
		if (params.has("client_secret") || params.has("client_assertion")) {
			throw new OAuthError(
				400,
				"invalid_client",
				"client authentication is not supported (token_endpoint_auth_method none)",
			);
		}
		return params;
	}

	async #codeGrant(
		p: Record<string, string | undefined>,
		clientId: string,
	): Promise<Record<string, unknown>> {
		const code = p["code"];
		const redirectUri = p["redirect_uri"];
		const verifier = p["code_verifier"];
		if (
			code === undefined ||
			redirectUri === undefined ||
			verifier === undefined
		) {
			throw new OAuthError(
				400,
				"invalid_request",
				"code, redirect_uri and code_verifier are required",
			);
		}
		const key = hashToken(code);
		const issued = this.#codes.get(key);
		const invalid = (why: string) => new OAuthError(400, "invalid_grant", why);
		if (issued === undefined) throw invalid("the code is not valid");
		if (issued.used) {
			// RFC 6749 §4.1.2: a code used twice revokes what it produced.
			if (issued.grantId !== undefined) {
				await this.#revokeGrant(
					issued.addressId,
					issued.grantId,
					"reuse_detected",
				);
			}
			throw invalid("the code was already used");
		}
		issued.used = true; // a failed check below burns the code too
		if (issued.expiresAt <= Date.now()) throw invalid("the code has expired");
		if (!constantTimeEqual(clientId, issued.client.clientId)) {
			throw invalid("the code was issued to another client");
		}
		if (redirectUri !== issued.redirectUri) {
			throw invalid("redirect_uri does not match the authorization request");
		}
		if (p["resource"] !== undefined && p["resource"] !== issued.resource) {
			throw new OAuthError(
				400,
				"invalid_target",
				"resource does not match the authorization request",
			);
		}
		if (
			!VERIFIER.test(verifier) ||
			!constantTimeEqual(s256(verifier), issued.codeChallenge)
		) {
			throw invalid("code_verifier does not match the code_challenge");
		}

		const now = Date.now();
		const grantId = newId("g");
		issued.grantId = grantId;
		const config = this.#host.config;
		const tokens = await issueTokenPair(
			this.#host.store,
			{
				grantId,
				addressId: issued.addressId,
				clientId: issued.client.clientId,
				clientName: issued.client.name,
				scopes: issued.scopes,
				grantCreatedAt: now,
			},
			{
				accessTtlMs: config.accessTokenTtlMs,
				refreshTtlMs: config.refreshTokenTtlMs,
				now,
			},
		);
		this.#host.logger.info("oauth.grant_created", {
			address: shortAddress(issued.addressId),
			client: issued.client.host,
		});
		this.#host.grantAdded(issued.addressId, {
			grantId,
			client: {
				id: issued.client.clientId,
				name: issued.client.name,
				host: issued.client.host,
			},
			createdAt: new Date(now).toISOString(),
		});
		return this.#tokenBody(tokens, issued.scopes);
	}

	#tokenBody(
		tokens: { accessToken: string; refreshToken: string },
		scopes: string[],
	): Record<string, unknown> {
		return {
			access_token: tokens.accessToken,
			token_type: "Bearer",
			expires_in: Math.floor(this.#host.config.accessTokenTtlMs / 1000),
			refresh_token: tokens.refreshToken,
			scope: scopes.join(" "),
		};
	}

	async #refreshGrant(
		p: Record<string, string | undefined>,
		clientId: string,
	): Promise<Record<string, unknown>> {
		const token = p["refresh_token"];
		if (token === undefined) {
			throw new OAuthError(400, "invalid_request", "refresh_token is required");
		}
		const invalid = (why: string) => new OAuthError(400, "invalid_grant", why);
		const hash = hashToken(token);
		const record = await this.#host.store.get(hash);
		if (record === undefined || record.kind !== "refresh") {
			throw invalid("the refresh token is not valid");
		}
		if (!constantTimeEqual(clientId, record.clientId)) {
			throw invalid("the refresh token was issued to another client");
		}
		const now = Date.now();
		if (record.expiresAt <= now) throw invalid("the refresh token has expired");
		if (record.usedAt !== undefined) {
			await this.#reuseDetected(record);
			throw invalid(
				"the refresh token was already used; the connection was revoked",
			);
		}
		if (
			p["resource"] !== undefined &&
			p["resource"] !== `${this.#issuer}/a/${record.addressId}/mcp`
		) {
			throw new OAuthError(
				400,
				"invalid_target",
				"resource is not the address this token belongs to",
			);
		}
		const scope = p["scope"];
		if (scope !== undefined) {
			const wanted = scope.split(" ").filter((s) => s !== "");
			if (!wanted.every((s) => record.scopes.includes(s))) {
				throw new OAuthError(400, "invalid_scope", "scope exceeds the grant");
			}
		}
		// Atomic: of two refreshes with the same token only one gets here.
		if (!(await this.#host.store.markUsed(hash, now))) {
			await this.#reuseDetected(record);
			throw invalid(
				"the refresh token was already used; the connection was revoked",
			);
		}
		const tokens = await issueTokenPair(
			this.#host.store,
			{
				grantId: record.grantId,
				addressId: record.addressId,
				clientId: record.clientId,
				clientName: record.clientName,
				scopes: record.scopes,
				grantCreatedAt: record.grantCreatedAt,
			},
			{
				accessTtlMs: this.#host.config.accessTokenTtlMs,
				refreshTtlMs: this.#host.config.refreshTokenTtlMs,
				now,
			},
		);
		this.#host.logger.debug("oauth.refreshed", {
			address: shortAddress(record.addressId),
			client: hostOf(record.clientId),
		});
		return this.#tokenBody(tokens, record.scopes);
	}

	async #reuseDetected(record: TokenRecord): Promise<void> {
		this.#host.logger.warn("oauth.refresh_reuse", {
			address: shortAddress(record.addressId),
			client: hostOf(record.clientId),
		});
		await this.#revokeGrant(record.addressId, record.grantId, "reuse_detected");
	}

	async #revokeGrant(
		addressId: string,
		grantId: string,
		reason: string,
	): Promise<void> {
		const n = await this.#host.store.revoke({ grantId });
		if (n > 0) this.#host.grantRemoved(addressId, grantId, reason);
	}

	// /revoke

	/** POST `/revoke` (RFC 7009). */
	async revoke(req: Request, ip: string): Promise<Response> {
		const noStore = { "cache-control": "no-store" };
		try {
			if (!this.#tokenPerIp.take(ip)) {
				throw new OAuthError(
					429,
					"temporarily_unavailable",
					"too many requests; try again shortly",
				);
			}
			const params = await this.#formParams(req);
			const p = single(params, ["token", "client_id", "token_type_hint"]);
			if ("duplicate" in p) {
				throw new OAuthError(
					400,
					"invalid_request",
					`${p.duplicate} was sent more than once`,
				);
			}
			const token = p["token"];
			const clientId = p["client_id"];
			if (token === undefined || clientId === undefined) {
				throw new OAuthError(
					400,
					"invalid_request",
					"token and client_id are required",
				);
			}
			const record = await this.#host.store.get(hashToken(token));
			// RFC 7009 §2.2: an unknown token is not an error.
			if (record === undefined)
				return new Response(null, {
					status: 200,
					headers: { ...this.#cors(), ...noStore },
				});
			if (!constantTimeEqual(clientId, record.clientId)) {
				throw new OAuthError(
					400,
					"invalid_client",
					"the token was issued to another client",
				);
			}
			// The grant is the connection: revoking either token ends it.
			await this.#revokeGrant(record.addressId, record.grantId, "revoked");
			this.#host.logger.info("oauth.revoked", {
				address: shortAddress(record.addressId),
				client: hostOf(record.clientId),
				by: "client",
			});
			return new Response(null, {
				status: 200,
				headers: { ...this.#cors(), ...noStore },
			});
		} catch (error) {
			return this.#oauthErrorResponse(error, noStore);
		}
	}

	// Housekeeping

	#sweepPending(force = false): void {
		const now = Date.now();
		for (const [id, p] of this.#pending) {
			if (p.expiresAt <= now) this.#pending.delete(id);
		}
		if (force && this.#pending.size >= MAX_PENDING) {
			// Still full: drop the oldest (Map keeps insertion order).
			const drop = this.#pending.size - MAX_PENDING + 1;
			for (const id of [...this.#pending.keys()].slice(0, drop)) {
				this.#pending.delete(id);
			}
		}
	}

	#sweepCodes(force = false): void {
		const now = Date.now();
		// Keep used codes until they expire, to detect reuse.
		for (const [key, c] of this.#codes) {
			if (c.expiresAt <= now) this.#codes.delete(key);
		}
		if (force && this.#codes.size >= MAX_CODES) {
			const drop = this.#codes.size - MAX_CODES + 1;
			for (const key of [...this.#codes.keys()].slice(0, drop)) {
				this.#codes.delete(key);
			}
		}
	}

	/** Drop expired state; the relay calls it periodically. */
	sweep(): void {
		this.#sweepPending();
		this.#sweepCodes();
		const now = Date.now();
		this.#viewsPerIp.sweep(now);
		this.#attemptsPerIp.sweep(now);
		this.#attemptsPerAddress.sweep(now);
		this.#tokenPerIp.sweep(now);
	}
}
