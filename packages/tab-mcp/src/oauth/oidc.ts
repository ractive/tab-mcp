/**
 * The OIDC pairing method (DEC-075, DEC-079): at `/authorize` the user signs in
 * at the configured OpenID Connect provider, and the relay pairs the AI app if
 * that person is the page's user. The relay is an ordinary OIDC client there
 * (authorization code flow, PKCE S256, `state`, `nonce`).
 */

import type { OidcConfig } from "../config.ts";
import { CLOCK_LEEWAY_MS, identityKey, MISMATCH_TEXT } from "../identity.ts";
import {
	audiences,
	fetchJson,
	HttpJsonError,
	JwksCache,
	JwtError,
	numericDate,
	verifyJwt,
} from "../jwt.ts";
import type { Logger } from "../log.ts";
import { escapeHtml } from "./html.ts";
import type {
	PairingContext,
	PairingMethod,
	PairingResult,
	PairingTarget,
} from "./pairing.ts";

/** How long a sign-in at the provider may take (the pending request lives 10 minutes). */
const FLOW_TTL_MS = 10 * 60_000;
const MAX_FLOWS = 10_000;
const METADATA_TTL_MS = 60 * 60_000;
const MAX_TOKEN_RESPONSE_BYTES = 65_536;

/** The provider's metadata the relay uses (OIDC Discovery §3). */
export interface ProviderMetadata {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	jwksUri: string;
	/** `client_secret_basic` (default) or `client_secret_post`. */
	tokenAuth: "client_secret_basic" | "client_secret_post";
}

interface Flow {
	requestId: string;
	browserId: string;
	nonce: string;
	verifier: string;
	expiresAt: number;
}

export class OidcError extends Error {
	override name = "OidcError";
	readonly reason: string;
	constructor(reason: string, message: string) {
		super(message);
		this.reason = reason;
	}
}

function random(bytes: number): string {
	return crypto
		.getRandomValues(new Uint8Array(bytes))
		.toBase64({ alphabet: "base64url", omitPadding: true });
}

function s256(verifier: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(verifier)
		.digest()
		.toBase64({ alphabet: "base64url", omitPadding: true });
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}

function originOf(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

/** Discovery for the configured issuer, cached an hour (OIDC Discovery §4). */
export class ProviderDiscovery {
	readonly #issuer: string;
	readonly #development: boolean;
	#metadata: ProviderMetadata | undefined;
	#fetchedAt = 0;
	#inflight: Promise<ProviderMetadata> | undefined;

	constructor(issuer: string, development: boolean) {
		this.#issuer = issuer;
		this.#development = development;
	}

	/** The cached metadata, if loaded. */
	get cached(): ProviderMetadata | undefined {
		return this.#metadata;
	}

	async get(): Promise<ProviderMetadata> {
		if (
			this.#metadata !== undefined &&
			Date.now() - this.#fetchedAt < METADATA_TTL_MS
		) {
			return this.#metadata;
		}
		this.#inflight ??= this.#load().finally(() => {
			this.#inflight = undefined;
		});
		return this.#inflight;
	}

	async #load(): Promise<ProviderMetadata> {
		const url = `${this.#issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
		const doc = (await fetchJson(url)) as Record<string, unknown> | null;
		if (typeof doc !== "object" || doc === null) {
			throw new OidcError(
				"discovery",
				"the provider's metadata is not an object",
			);
		}
		// OIDC Discovery §4.3: the issuer must be exactly the configured one.
		if (doc["issuer"] !== this.#issuer) {
			throw new OidcError(
				"discovery_issuer",
				"the provider's metadata names another issuer",
			);
		}
		const endpoint = (name: string): string => {
			const v = str(doc[name]);
			const ok =
				v !== undefined &&
				(v.startsWith("https://") ||
					(this.#development && v.startsWith("http://")));
			if (!ok) {
				throw new OidcError(
					"discovery",
					`the provider's metadata lacks ${name}`,
				);
			}
			return v;
		};
		const methods = doc["token_endpoint_auth_methods_supported"];
		const tokenAuth =
			Array.isArray(methods) &&
			!methods.includes("client_secret_basic") &&
			methods.includes("client_secret_post")
				? "client_secret_post"
				: "client_secret_basic";
		const metadata: ProviderMetadata = {
			issuer: this.#issuer,
			authorizationEndpoint: endpoint("authorization_endpoint"),
			tokenEndpoint: endpoint("token_endpoint"),
			jwksUri: endpoint("jwks_uri"),
			tokenAuth,
		};
		this.#metadata = metadata;
		this.#fetchedAt = Date.now();
		return metadata;
	}
}

export interface OidcPairingOptions {
	config: OidcConfig;
	/** The relay's public URL (the callback is `<url>/authorize/callback`). */
	publicUrl: () => string;
	logger: Logger;
	development: boolean;
}

/** The identity-binding pairing method. */
export class OidcPairing implements PairingMethod {
	readonly kind = "oidc" as const;
	readonly #config: OidcConfig;
	readonly #publicUrl: () => string;
	readonly #logger: Logger;
	readonly #discovery: ProviderDiscovery;
	readonly #jwks: JwksCache;
	/** state → flow; insertion order is expiry order. */
	readonly #flows = new Map<string, Flow>();
	/**
	 * Pending request → its one flow's state (DEC-090): a new Connect
	 * replaces the earlier sign-in, so flows are bounded by the pending
	 * requests, which are capped per network and per address.
	 */
	readonly #flowOf = new Map<string, string>();
	/** Requests that met a mismatch: the next sign-in asks for the account again. */
	readonly #mismatched = new Set<string>();

	constructor(options: OidcPairingOptions) {
		this.#config = options.config;
		this.#publicUrl = options.publicUrl;
		this.#logger = options.logger;
		this.#discovery = new ProviderDiscovery(
			options.config.issuer,
			options.development,
		);
		this.#jwks = new JwksCache(
			async () => (await this.#discovery.get()).jwksUri,
		);
	}

	get #providerHost(): string {
		try {
			return new URL(this.#config.issuer).host;
		} catch {
			return this.#config.issuer;
		}
	}

	get callbackUrl(): string {
		return `${this.#publicUrl()}/authorize/callback`;
	}

	/** Load the provider's metadata before the page is shown. */
	async prepare(): Promise<void> {
		await this.#discovery.get();
	}

	/** The provider's origins, for the page's CSP `form-action` (the redirect after the post). */
	formTargets(): string[] {
		const out = new Set<string>();
		const issuer = originOf(this.#config.issuer);
		if (issuer !== undefined) out.add(issuer);
		const auth = this.#discovery.cached?.authorizationEndpoint;
		const origin = auth === undefined ? undefined : originOf(auth);
		if (origin !== undefined) out.add(origin);
		return [...out];
	}

	render(target: PairingTarget): string {
		const host = escapeHtml(this.#providerHost);
		if (target.identity === undefined) {
			return `<p class="help">Nobody is signed in to the page. Sign in there first, then click Connect.</p>`;
		}
		return `<p>When you click Connect, sign in at <strong>${host}</strong> with the account you use in the page. No code is needed.</p>`;
	}

	async check(
		target: PairingTarget,
		_form: URLSearchParams,
		admit: () => boolean,
		context?: PairingContext,
	): Promise<PairingResult> {
		if (!target.pairingOpen) {
			return {
				ok: false,
				message:
					"The page is not connecting right now. In the page, open “Connect your AI app”, then click Connect here again.",
				reason: "inactive",
			};
		}
		if (target.identity === undefined) {
			return {
				ok: false,
				message:
					"Nobody is signed in to the page. Sign in there first, then click Connect here again.",
				reason: "signed_out",
			};
		}
		if (context === undefined) {
			return { ok: false, message: "Something went wrong.", reason: "context" };
		}
		let metadata: ProviderMetadata;
		try {
			metadata = await this.#discovery.get();
		} catch (error) {
			return this.#unavailable(error);
		}
		// A sign-in could pair: charged like a code guess (DEC-061, DEC-090).
		if (!admit()) {
			return {
				ok: false,
				message:
					"Too many attempts for this page. Wait a few minutes and try again.",
				reason: "rate_limited",
			};
		}
		this.#sweep();
		this.#dropFlow(context.requestId);
		if (this.#flows.size >= MAX_FLOWS) {
			return {
				ok: false,
				message:
					"Too many sign-ins are open right now. Wait a few minutes and try again.",
				reason: "busy",
			};
		}
		const state = random(24);
		const nonce = random(24);
		const verifier = random(32);
		this.#flowOf.set(context.requestId, state);
		this.#flows.set(state, {
			requestId: context.requestId,
			browserId: context.browserId,
			nonce,
			verifier,
			expiresAt: Date.now() + FLOW_TTL_MS,
		});
		const url = new URL(metadata.authorizationEndpoint);
		const params: Record<string, string> = {
			response_type: "code",
			client_id: this.#config.clientId,
			redirect_uri: this.callbackUrl,
			scope: "openid",
			state,
			nonce,
			code_challenge: s256(verifier),
			code_challenge_method: "S256",
		};
		if (this.#mismatched.has(context.requestId)) params["prompt"] = "login";
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
		return { ok: "redirect", location: url.href };
	}

	/**
	 * The provider sent the browser back. Returns the pending request the
	 * sign-in belongs to (if the state is known) and the result.
	 */
	async callback(
		params: URLSearchParams,
		browserId: string,
		targetFor: (requestId: string) => PairingTarget | undefined,
	): Promise<{ requestId?: string; result: PairingResult }> {
		this.#sweep();
		const state = params.get("state") ?? "";
		const flow = this.#flows.get(state);
		if (flow === undefined || flow.expiresAt <= Date.now()) {
			return {
				result: {
					ok: false,
					message:
						"This sign-in has expired or was already used. Start again from your AI app.",
					reason: "unknown_state",
				},
			};
		}
		this.#flows.delete(state); // single use
		const requestId = flow.requestId;
		this.#flowOf.delete(requestId);
		const fail = (reason: string, message: string) => ({
			requestId,
			result: { ok: false as const, message, reason },
		});
		if (flow.browserId !== browserId) {
			return fail(
				"browser",
				"This sign-in was started in another browser. Start again from your AI app.",
			);
		}
		// RFC 9207: a provider that names itself must be the configured one.
		const iss = params.get("iss");
		if (iss !== null && iss !== this.#config.issuer) {
			return fail("iss", "The sign-in came back from an unexpected provider.");
		}
		const error = params.get("error");
		if (error !== null) {
			this.#logger.info("oidc.provider_error", { error: error.slice(0, 64) });
			return fail(
				`provider_${error.slice(0, 32)}`,
				`The sign-in at ${this.#providerHost} did not finish. Click Connect to try again.`,
			);
		}
		const code = params.get("code");
		if (code === null || code === "") {
			return fail(
				"no_code",
				"The provider sent no sign-in result. Click Connect to try again.",
			);
		}
		let subject: string;
		try {
			subject = await this.#signIn(code, flow);
		} catch (e) {
			const reason =
				e instanceof OidcError || e instanceof JwtError ? e.reason : "exchange";
			this.#logger.warn("oidc.sign_in_failed", {
				reason,
				message: e instanceof Error ? e.message.slice(0, 200) : "unknown",
			});
			return fail(
				reason,
				`The sign-in at ${this.#providerHost} could not be checked. Click Connect to try again.`,
			);
		}
		// Compared now, so a page that signed out meanwhile pairs nobody.
		const target = targetFor(requestId);
		if (target === undefined) {
			return fail(
				"page_closed",
				"The page is not open any more. Open it and try again.",
			);
		}
		if (target.identity === undefined) {
			return fail(
				"signed_out",
				"Nobody is signed in to the page any more. Sign in there first, then click Connect here again.",
			);
		}
		const key = identityKey(this.#config.issuer, subject);
		if (key !== target.identity) {
			this.#mismatched.add(requestId);
			if (this.#mismatched.size > MAX_FLOWS) {
				const oldest = this.#mismatched.values().next().value;
				if (oldest !== undefined) this.#mismatched.delete(oldest);
			}
			return fail(
				"mismatch",
				`${MISMATCH_TEXT} Click Connect to sign in with the page's account, or Cancel.`,
			);
		}
		this.#mismatched.delete(requestId);
		return { requestId, result: { ok: true, subject: key } };
	}

	/** Exchange the code and validate the ID token (OIDC Core §3.1.3.7); returns the subject. */
	async #signIn(code: string, flow: Flow): Promise<string> {
		const metadata = await this.#discovery.get();
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: this.callbackUrl,
			code_verifier: flow.verifier,
		});
		const headers: Record<string, string> = {
			"content-type": "application/x-www-form-urlencoded",
		};
		const secret = this.#config.clientSecret;
		if (secret !== undefined && metadata.tokenAuth === "client_secret_basic") {
			// RFC 6749 §2.3.1: both parts form-encoded before Base64.
			const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, "+");
			headers["authorization"] =
				`Basic ${btoa(`${enc(this.#config.clientId)}:${enc(secret)}`)}`;
		} else {
			body.set("client_id", this.#config.clientId);
			if (secret !== undefined) body.set("client_secret", secret);
		}
		let response: unknown;
		try {
			response = await fetchJson(
				metadata.tokenEndpoint,
				{ method: "POST", headers, body },
				MAX_TOKEN_RESPONSE_BYTES,
			);
		} catch (e) {
			if (e instanceof HttpJsonError) {
				throw new OidcError(`token_${e.error || e.status}`, e.message);
			}
			throw e;
		}
		const idToken = str(
			(response as Record<string, unknown> | null)?.["id_token"],
		);
		if (idToken === undefined) {
			throw new OidcError("no_id_token", "the token response has no id_token");
		}
		const { payload } = await verifyJwt(idToken, this.#jwks);
		const now = Date.now();
		if (payload["iss"] !== metadata.issuer) {
			throw new OidcError("id_token_iss", "the ID token's issuer is wrong");
		}
		const aud = audiences(payload);
		if (!aud.includes(this.#config.clientId)) {
			throw new OidcError("id_token_aud", "the ID token is not for this relay");
		}
		const azp = payload["azp"];
		if (
			(aud.length > 1 || azp !== undefined) &&
			azp !== this.#config.clientId
		) {
			throw new OidcError(
				"id_token_azp",
				"the ID token's azp is not this relay",
			);
		}
		const exp = numericDate(payload, "exp");
		if (exp === undefined || exp <= now - CLOCK_LEEWAY_MS) {
			throw new OidcError("id_token_exp", "the ID token has expired");
		}
		const iat = numericDate(payload, "iat");
		if (iat === undefined || iat > now + CLOCK_LEEWAY_MS) {
			throw new OidcError(
				"id_token_iat",
				"the ID token's iat is missing or in the future",
			);
		}
		if (payload["nonce"] !== flow.nonce) {
			throw new OidcError(
				"id_token_nonce",
				"the ID token's nonce does not match",
			);
		}
		const claim = this.#config.subjectClaim ?? "sub";
		const subject = payload[claim];
		if (typeof subject !== "string" || subject === "" || subject.length > 255) {
			throw new OidcError("id_token_subject", `the ID token has no ${claim}`);
		}
		return subject;
	}

	#unavailable(error: unknown): PairingResult {
		this.#logger.warn("oidc.discovery_failed", {
			reason: error instanceof OidcError ? error.reason : "fetch",
			message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
		});
		return {
			ok: false,
			message: `The sign-in provider ${this.#providerHost} cannot be reached right now. Try again in a minute.`,
			reason: "provider_unavailable",
		};
	}

	/** The pending request ended: drop its sign-in and its mismatch mark. */
	forget(requestId: string): void {
		this.#dropFlow(requestId);
		this.#mismatched.delete(requestId);
	}

	#dropFlow(requestId: string): void {
		const state = this.#flowOf.get(requestId);
		if (state !== undefined) this.#flows.delete(state);
		this.#flowOf.delete(requestId);
	}

	#sweep(): void {
		const now = Date.now();
		for (const [state, flow] of this.#flows) {
			if (flow.expiresAt > now) break;
			this.#flows.delete(state);
			if (this.#flowOf.get(flow.requestId) === state) {
				this.#flowOf.delete(flow.requestId);
			}
		}
	}
}
