/**
 * Fakes of the three sign-in providers (DEC-231) in one loopback server: a
 * Google-like OpenID Connect provider, Microsoft's multi-tenant endpoint
 * with a per-tenant issuer, and GitHub's OAuth App flow with its user API.
 * Keys and secrets are made per process; nothing here is a real credential.
 */

import type { SignInEndpoints } from "../src/signin/providers.ts";
import { type SigningKey, signingKey, signJwt } from "./oidc-fixture.ts";

type Json = Record<string, unknown>;

function b64url(bytes: Uint8Array): string {
	return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
}

async function s256(verifier: string): Promise<string> {
	return b64url(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
		),
	);
}

export interface GoogleAccount {
	sub: string;
	email?: string;
}
export interface MicrosoftAccount {
	tid: string;
	oid: string;
	preferred_username?: string;
}
export interface GitHubAccount {
	id: number;
	login: string;
}

interface Issued {
	provider: "google" | "microsoft" | "github";
	clientId: string;
	redirectUri: string;
	nonce: string | null;
	challenge: string;
	account: Json;
}

export interface FakeProviders {
	readonly endpoints: SignInEndpoints;
	/** The relay's clients at the fakes (secrets made per process). */
	readonly clients: {
		google: { clientId: string; clientSecret: string };
		microsoft: { clientId: string; clientSecret: string };
		github: { clientId: string; clientSecret: string };
	};
	/** Who is signed in at each provider, in "this browser". */
	google: GoogleAccount;
	microsoft: MicrosoftAccount;
	github: GitHubAccount;
	/** Every authorization request (provider, query), in order. */
	readonly authorizeRequests: { provider: string; query: URLSearchParams }[];
	/** Every token request's form, in order. */
	readonly tokenRequests: { provider: string; form: URLSearchParams }[];
	/** Change an ID token's claims before signing. */
	tamper: ((claims: Json) => Json) | undefined;
	/** The provider sends the browser back with this `error` instead of a code. */
	deny: string | undefined;
	/** GitHub answers the code exchange with this `error` (HTTP 200, as GitHub does). */
	githubTokenError: string | undefined;
	/** Requests to GitHub's user API (with the token each carried). */
	readonly githubUserRequests: string[];
	stop(): Promise<void>;
}

export async function startFakeProviders(): Promise<FakeProviders> {
	const keys: Record<"google" | "microsoft", SigningKey> = {
		google: await signingKey("RS256", "google-1"),
		microsoft: await signingKey("RS256", "microsoft-1"),
	};
	const clients = {
		google: { clientId: "google-client", clientSecret: crypto.randomUUID() },
		microsoft: {
			clientId: "aae32a2a-bef7-4fdb-9422-9d5df62b78e5",
			clientSecret: crypto.randomUUID(),
		},
		github: {
			clientId: "Ov23litK0ROOKaHzH01W",
			clientSecret: crypto.randomUUID(),
		},
	};
	const codes = new Map<string, Issued>();
	const ghTokens = new Map<string, GitHubAccount>();
	let base = "";
	const state: Omit<
		FakeProviders,
		| "endpoints"
		| "clients"
		| "stop"
		| "authorizeRequests"
		| "tokenRequests"
		| "githubUserRequests"
	> = {
		google: { sub: "g-alice", email: "alice@gmail.example" },
		microsoft: {
			tid: "72f988bf-86f1-41af-91ab-2d7cd011db47",
			oid: "00000000-0000-0000-1111-000000000001",
			preferred_username: "alice@contoso.example",
		},
		github: { id: 1001, login: "alice" },
		tamper: undefined,
		deny: undefined,
		githubTokenError: undefined,
	};
	const authorizeRequests: FakeProviders["authorizeRequests"] = [];
	const tokenRequests: FakeProviders["tokenRequests"] = [];
	const githubUserRequests: string[] = [];

	const issuerOf = (provider: "google" | "microsoft", account: Json) =>
		provider === "google"
			? `${base}/google`
			: `${base}/ms/${String(account["tid"])}/v2.0`;

	const authorize = (
		provider: Issued["provider"],
		q: URLSearchParams,
		account: Json,
	) => {
		authorizeRequests.push({ provider, query: q });
		const redirect = new URL(q.get("redirect_uri") ?? "");
		const st = q.get("state") ?? "";
		const params: Record<string, string> =
			state.deny !== undefined
				? { error: state.deny, state: st }
				: (() => {
						const code = crypto.randomUUID();
						codes.set(code, {
							provider,
							clientId: q.get("client_id") ?? "",
							redirectUri: q.get("redirect_uri") ?? "",
							nonce: q.get("nonce"),
							challenge: q.get("code_challenge") ?? "",
							account: { ...account },
						});
						return { code, state: st };
					})();
		for (const [k, v] of Object.entries(params)) {
			redirect.searchParams.set(k, v);
		}
		return new Response(null, {
			status: 302,
			headers: { location: redirect.href },
		});
	};

	/** The code, checked against PKCE, the redirect URI and the client. */
	const redeem = async (
		provider: Issued["provider"],
		form: URLSearchParams,
		clientId: string,
	): Promise<Issued | undefined> => {
		tokenRequests.push({ provider, form });
		const issued = codes.get(form.get("code") ?? "");
		codes.delete(form.get("code") ?? "");
		if (
			issued === undefined ||
			issued.provider !== provider ||
			issued.clientId !== clientId ||
			issued.redirectUri !== form.get("redirect_uri") ||
			issued.challenge !== (await s256(form.get("code_verifier") ?? ""))
		) {
			return undefined;
		}
		return issued;
	};

	const oidcToken = async (
		provider: "google" | "microsoft",
		req: Request,
	): Promise<Response> => {
		const client = clients[provider];
		if (
			req.headers.get("authorization") !==
			`Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`
		) {
			return Response.json({ error: "invalid_client" }, { status: 401 });
		}
		const form = new URLSearchParams(await req.text());
		const issued = await redeem(provider, form, client.clientId);
		if (issued === undefined) {
			return Response.json({ error: "invalid_grant" }, { status: 400 });
		}
		const now = Math.floor(Date.now() / 1000);
		let claims: Json = {
			iss: issuerOf(provider, issued.account),
			aud: client.clientId,
			exp: now + 300,
			iat: now,
			...(issued.nonce === null ? {} : { nonce: issued.nonce }),
			...(provider === "microsoft"
				? {
						sub: `pairwise-${String(issued.account["oid"])}`,
						...issued.account,
					}
				: issued.account),
		};
		if (state.tamper !== undefined) claims = state.tamper(claims);
		return Response.json({
			access_token: crypto.randomUUID(),
			token_type: "Bearer",
			expires_in: 300,
			id_token: await signJwt(keys[provider], claims),
		});
	};

	const discovery = (issuer: string, prefix: string) =>
		Response.json({
			issuer,
			authorization_endpoint: `${prefix}/authorize`,
			token_endpoint: `${prefix}/token`,
			jwks_uri: `${prefix}/jwks`,
			response_types_supported: ["code"],
			token_endpoint_auth_methods_supported: [
				"client_secret_post",
				"client_secret_basic",
			],
		});

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			const url = new URL(req.url);
			const q = url.searchParams;
			switch (url.pathname) {
				case "/google/.well-known/openid-configuration":
					return discovery(`${base}/google`, `${base}/google`);
				case "/google/jwks":
					return Response.json({ keys: [keys.google.publicJwk] });
				case "/google/authorize":
					return authorize("google", q, state.google as unknown as Json);
				case "/google/token":
					return oidcToken("google", req);
				case "/ms/common/v2.0/.well-known/openid-configuration":
					return discovery(
						`${base}/ms/{tenantid}/v2.0`,
						`${base}/ms/common/oauth2/v2.0`,
					);
				case "/ms/common/oauth2/v2.0/jwks":
					return Response.json({ keys: [keys.microsoft.publicJwk] });
				case "/ms/common/oauth2/v2.0/authorize":
					return authorize("microsoft", q, state.microsoft as unknown as Json);
				case "/ms/common/oauth2/v2.0/token":
					return oidcToken("microsoft", req);
				case "/gh/login/oauth/authorize":
					return authorize("github", q, state.github as unknown as Json);
				case "/gh/login/oauth/access_token": {
					if (req.headers.get("accept") !== "application/json") {
						return new Response("access_token=x", { status: 200 });
					}
					const form = new URLSearchParams(await req.text());
					if (
						form.get("client_secret") !== clients.github.clientSecret ||
						state.githubTokenError !== undefined
					) {
						return Response.json({
							error: state.githubTokenError ?? "incorrect_client_credentials",
						});
					}
					const issued = await redeem("github", form, clients.github.clientId);
					if (issued === undefined) {
						return Response.json({ error: "bad_verification_code" });
					}
					const token = `gho_${crypto.randomUUID()}`;
					ghTokens.set(token, issued.account as unknown as GitHubAccount);
					return Response.json({
						access_token: token,
						token_type: "bearer",
						scope: "",
					});
				}
				case "/ghapi/user": {
					const token = (req.headers.get("authorization") ?? "").replace(
						/^Bearer /,
						"",
					);
					githubUserRequests.push(token);
					const account = ghTokens.get(token);
					if (account === undefined || req.headers.get("user-agent") === null) {
						return Response.json(
							{ message: "Bad credentials" },
							{ status: 401 },
						);
					}
					return Response.json({
						login: account.login,
						id: account.id,
						type: "User",
					});
				}
				default:
					return new Response("Not found", { status: 404 });
			}
		},
	});
	base = `http://127.0.0.1:${server.port}`;

	const out = {
		endpoints: {
			googleIssuer: `${base}/google`,
			microsoftAuthority: `${base}/ms`,
			githubOrigin: `${base}/gh`,
			githubApi: `${base}/ghapi`,
		},
		clients,
		authorizeRequests,
		tokenRequests,
		githubUserRequests,
		stop: () => server.stop(true),
	} as FakeProviders;
	for (const key of Object.keys(state) as (keyof typeof state)[]) {
		Object.defineProperty(out, key, {
			get: () => state[key],
			set: (v) => {
				(state as Record<string, unknown>)[key] = v;
			},
			enumerable: true,
		});
	}
	return out;
}
