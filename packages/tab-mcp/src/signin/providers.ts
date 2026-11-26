/**
 * The providers a browser signs in with (DEC-231), each reduced to two
 * steps: the URL that sends the browser there, and the account behind the
 * code that comes back. Google and Microsoft are OpenID Connect providers
 * (the ID token is checked as for identity binding, `redeemIdToken`);
 * GitHub has no OpenID Connect for OAuth Apps: the code is exchanged for an
 * access token, which reads the numeric user id once and is dropped.
 *
 * The relay keeps a hash of each account's stable id (`key`), never the id
 * itself; the name shown ("Signed in as …") goes to the browser only.
 */

import type { SignInClient, SignInProviderId } from "../config.ts";
import { sha256Base64url } from "../crypto.ts";
import { fetchJson, HttpJsonError, JwksCache } from "../jwt.ts";
import { displayName } from "../oauth/cimd.ts";
import { OidcError, ProviderDiscovery, redeemIdToken } from "../oauth/oidc.ts";

/** Where the providers live; only tests point them elsewhere (loopback fakes). */
export interface SignInEndpoints {
	/** Google's issuer, `https://accounts.google.com`. */
	googleIssuer?: string;
	/** Microsoft's authority, `https://login.microsoftonline.com`. */
	microsoftAuthority?: string;
	/** GitHub's web origin, `https://github.com`. */
	githubOrigin?: string;
	/** GitHub's API, `https://api.github.com`. */
	githubApi?: string;
}

/** The account behind a finished sign-in. */
export interface SignInAccount {
	/** The group's key: a hash of the provider and the account's stable id. */
	key: string;
	/** What the browser shows as "Signed in as …"; never stored. */
	displayName: string;
}

/** One flow's secrets, made by the relay when the browser starts. */
export interface FlowSecrets {
	state: string;
	nonce: string;
	verifier: string;
	redirectUri: string;
}

export interface SignInProvider {
	readonly id: SignInProviderId;
	/** The name on the button: "Google", "Microsoft", "GitHub". */
	readonly name: string;
	/** The provider's authorization URL for this flow (PKCE S256, state, nonce). */
	authorizationUrl(flow: FlowSecrets): Promise<string>;
	/** The account behind the callback's code; throws `OidcError` with a reason. */
	complete(code: string, flow: FlowSecrets): Promise<SignInAccount>;
}

/** Microsoft's tenant of personal accounts (`tid` of every consumer account). */
export const MICROSOFT_PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ID = 255;
const MAX_API_RESPONSE_BYTES = 65_536;

/**
 * The group's key (DEC-231): SHA-256 over a fixed prefix, the provider and
 * the parts of the account's stable id, one per line, so the same account is
 * the same group on every sign-in and no key equals an identity binding's
 * (`identityKey`, DEC-077).
 */
export function accountKey(
	provider: SignInProviderId,
	parts: string[],
): string {
	return sha256Base64url(["tab-mcp sign-in", provider, ...parts].join("\n"));
}

function claim(payload: Record<string, unknown>, name: string): string {
	const v = payload[name];
	if (typeof v !== "string" || v === "" || v.length > MAX_ID) {
		throw new OidcError(`id_token_${name}`, `the ID token has no ${name}`);
	}
	return v;
}

/** A name to show, cleaned like an AI app's (no invisible characters), or the fallback. */
function shown(value: unknown, fallback: string): string {
	const cleaned = typeof value === "string" ? displayName(value) : "";
	return cleaned === "" ? fallback : cleaned;
}

function authorizeUrl(
	endpoint: string,
	params: Record<string, string>,
): string {
	const url = new URL(endpoint);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url.href;
}

/** An OpenID Connect provider through discovery: Google and Microsoft. */
class OidcSignIn implements SignInProvider {
	readonly id: SignInProviderId;
	readonly name: string;
	readonly #client: SignInClient;
	readonly #scope: string;
	readonly #discovery: ProviderDiscovery;
	readonly #jwks: JwksCache;
	readonly #issuerMatches: (payload: Record<string, unknown>) => boolean;
	readonly #account: (payload: Record<string, unknown>) => SignInAccount;

	constructor(options: {
		id: SignInProviderId;
		name: string;
		client: SignInClient;
		scope: string;
		discoveryAt: string;
		expectedIssuer: string;
		development: boolean;
		issuerMatches: (payload: Record<string, unknown>) => boolean;
		account: (payload: Record<string, unknown>) => SignInAccount;
	}) {
		this.id = options.id;
		this.name = options.name;
		this.#client = options.client;
		this.#scope = options.scope;
		this.#discovery = new ProviderDiscovery(
			options.discoveryAt,
			options.development,
			Date.now,
			options.expectedIssuer,
		);
		this.#jwks = new JwksCache(
			async () => (await this.#discovery.get()).jwksUri,
		);
		this.#issuerMatches = options.issuerMatches;
		this.#account = options.account;
	}

	async authorizationUrl(flow: FlowSecrets): Promise<string> {
		const metadata = await this.#discovery.get();
		return authorizeUrl(metadata.authorizationEndpoint, {
			response_type: "code",
			client_id: this.#client.clientId,
			redirect_uri: flow.redirectUri,
			scope: this.#scope,
			state: flow.state,
			nonce: flow.nonce,
			code_challenge: sha256Base64url(flow.verifier),
			code_challenge_method: "S256",
			// The account chooser, so a browser can sign in with another account.
			prompt: "select_account",
		});
	}

	async complete(code: string, flow: FlowSecrets): Promise<SignInAccount> {
		const payload = await redeemIdToken({
			metadata: await this.#discovery.get(),
			jwks: this.#jwks,
			client: this.#client,
			code,
			redirectUri: flow.redirectUri,
			verifier: flow.verifier,
			nonce: flow.nonce,
			issuerMatches: this.#issuerMatches,
		});
		return this.#account(payload);
	}
}

/** Google: `iss` and `sub`; the e-mail address is the name shown. */
function google(
	client: SignInClient,
	development: boolean,
	endpoints: SignInEndpoints,
): SignInProvider {
	const issuer = endpoints.googleIssuer ?? "https://accounts.google.com";
	// Google's ID tokens name the issuer with or without the scheme.
	const bare = issuer.replace(/^https?:\/\//, "");
	return new OidcSignIn({
		id: "google",
		name: "Google",
		client,
		scope: "openid email",
		discoveryAt: issuer,
		expectedIssuer: issuer,
		development,
		issuerMatches: (p) => p["iss"] === issuer || p["iss"] === bare,
		account: (p) => ({
			key: accountKey("google", [issuer, claim(p, "sub")]),
			displayName: shown(p["email"], "Google account"),
		}),
	});
}

/**
 * Microsoft, multi-tenant (`/common`: personal and work accounts): `tid`
 * and `oid` (`sub` differs per app, `oid` does not). The issuer names the
 * token's own tenant, so it is checked against the `tid` inside it; an
 * issuer of another tenant is refused.
 */
function microsoft(
	client: SignInClient,
	development: boolean,
	endpoints: SignInEndpoints,
): SignInProvider {
	const authority =
		endpoints.microsoftAuthority ?? "https://login.microsoftonline.com";
	return new OidcSignIn({
		id: "microsoft",
		name: "Microsoft",
		client,
		scope: "openid profile",
		discoveryAt: `${authority}/common/v2.0`,
		expectedIssuer: `${authority}/{tenantid}/v2.0`,
		development,
		issuerMatches: (p) => {
			const tid = p["tid"];
			return (
				typeof tid === "string" &&
				GUID.test(tid) &&
				p["iss"] === `${authority}/${tid}/v2.0`
			);
		},
		account: (p) => {
			const oid = claim(p, "oid");
			if (!GUID.test(oid)) {
				throw new OidcError("id_token_oid", "the ID token's oid is no GUID");
			}
			return {
				key: accountKey("microsoft", [claim(p, "tid"), oid]),
				displayName: shown(p["preferred_username"], "Microsoft account"),
			};
		},
	});
}

/**
 * GitHub, an OAuth App without scopes: the code (with PKCE, which GitHub
 * supports with S256) for an access token, then one `GET /user` for the
 * numeric `id` (the key: the login name can change) and the `login` (the
 * name shown). The token is not kept.
 */
class GitHubSignIn implements SignInProvider {
	readonly id = "github" as const;
	readonly name = "GitHub";
	readonly #client: SignInClient;
	readonly #origin: string;
	readonly #api: string;

	constructor(client: SignInClient, endpoints: SignInEndpoints) {
		this.#client = client;
		this.#origin = endpoints.githubOrigin ?? "https://github.com";
		this.#api = endpoints.githubApi ?? "https://api.github.com";
	}

	async authorizationUrl(flow: FlowSecrets): Promise<string> {
		return authorizeUrl(`${this.#origin}/login/oauth/authorize`, {
			client_id: this.#client.clientId,
			redirect_uri: flow.redirectUri,
			state: flow.state,
			code_challenge: sha256Base64url(flow.verifier),
			code_challenge_method: "S256",
			allow_signup: "false",
			prompt: "select_account",
		});
	}

	async complete(code: string, flow: FlowSecrets): Promise<SignInAccount> {
		let response: unknown;
		try {
			response = await fetchJson(
				`${this.#origin}/login/oauth/access_token`,
				{
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						client_id: this.#client.clientId,
						client_secret: this.#client.clientSecret,
						code,
						redirect_uri: flow.redirectUri,
						code_verifier: flow.verifier,
					}),
				},
				MAX_API_RESPONSE_BYTES,
			);
		} catch (e) {
			if (e instanceof HttpJsonError) {
				throw new OidcError(`token_${e.error || e.status}`, e.message);
			}
			throw e;
		}
		const answer = (response ?? {}) as Record<string, unknown>;
		// GitHub answers a refused code with HTTP 200 and an `error`.
		if (typeof answer["error"] === "string") {
			throw new OidcError(
				`token_${answer["error"].slice(0, 32)}`,
				"GitHub refused the code",
			);
		}
		const token = answer["access_token"];
		if (typeof token !== "string" || token === "" || token.length > 4096) {
			throw new OidcError("no_access_token", "GitHub sent no access token");
		}
		let user: unknown;
		try {
			user = await fetchJson(
				`${this.#api}/user`,
				{
					headers: {
						accept: "application/vnd.github+json",
						authorization: `Bearer ${token}`,
						"user-agent": "tab-mcp-relay",
						"x-github-api-version": "2022-11-28",
					},
				},
				MAX_API_RESPONSE_BYTES,
			);
		} catch (e) {
			if (e instanceof HttpJsonError) {
				throw new OidcError(`user_${e.status}`, e.message);
			}
			throw e;
		}
		const u = (user ?? {}) as Record<string, unknown>;
		const id = u["id"];
		if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
			throw new OidcError("user_id", "GitHub's user has no numeric id");
		}
		return {
			key: accountKey("github", [String(id)]),
			displayName: shown(u["login"], "GitHub account"),
		};
	}
}

/** The providers the configuration offers, in the order of the buttons. */
export function signInProviders(
	providers: Partial<Record<SignInProviderId, SignInClient>>,
	development: boolean,
	endpoints: SignInEndpoints = {},
): Map<SignInProviderId, SignInProvider> {
	const out = new Map<SignInProviderId, SignInProvider>();
	if (providers.google !== undefined) {
		out.set("google", google(providers.google, development, endpoints));
	}
	if (providers.microsoft !== undefined) {
		out.set(
			"microsoft",
			microsoft(providers.microsoft, development, endpoints),
		);
	}
	if (providers.github !== undefined) {
		out.set("github", new GitHubSignIn(providers.github, endpoints));
	}
	return out;
}
