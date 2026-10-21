/**
 * A local OpenID Connect provider and a web app backend that signs tab
 * assertions, in process on loopback (no network). Keys are generated per
 * process; nothing here is a real secret.
 */

import type { OidcConfig } from "../src/config.ts";
import { TAB_ASSERTION_TYP } from "../src/identity.ts";

type Json = Record<string, unknown>;

function b64url(bytes: Uint8Array | string): string {
	const data =
		typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
	return data.toBase64({ alphabet: "base64url", omitPadding: true });
}

export interface SigningKey {
	kid: string;
	alg: string;
	privateKey: CryptoKey;
	publicJwk: Json;
}

const SIGN_PARAMS: Record<string, Parameters<typeof crypto.subtle.sign>[0]> = {
	RS256: { name: "RSASSA-PKCS1-v1_5" },
	PS256: { name: "RSA-PSS", saltLength: 32 } as Parameters<
		typeof crypto.subtle.sign
	>[0],
	ES256: { name: "ECDSA", hash: "SHA-256" } as Parameters<
		typeof crypto.subtle.sign
	>[0],
	EdDSA: { name: "Ed25519" },
};

/** A fresh key pair for an algorithm. */
export async function signingKey(
	alg: string,
	kid: string,
): Promise<SigningKey> {
	const params =
		alg === "RS256"
			? {
					name: "RSASSA-PKCS1-v1_5",
					modulusLength: 2048,
					publicExponent: new Uint8Array([1, 0, 1]),
					hash: "SHA-256",
				}
			: alg === "PS256"
				? {
						name: "RSA-PSS",
						modulusLength: 2048,
						publicExponent: new Uint8Array([1, 0, 1]),
						hash: "SHA-256",
					}
				: alg === "ES256"
					? { name: "ECDSA", namedCurve: "P-256" }
					: { name: "Ed25519" };
	const pair = (await crypto.subtle.generateKey(params, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Json;
	delete jwk["key_ops"];
	delete jwk["ext"];
	return {
		kid,
		alg,
		privateKey: pair.privateKey,
		publicJwk: { ...jwk, kid, use: "sig", alg },
	};
}

/** Sign a JWT (header fields may be overridden, e.g. a wrong `typ`). */
export async function signJwt(
	key: SigningKey,
	payload: Json,
	header: Json = {},
): Promise<string> {
	const h = b64url(JSON.stringify({ alg: key.alg, kid: key.kid, ...header }));
	const p = b64url(JSON.stringify(payload));
	const params = SIGN_PARAMS[key.alg];
	if (params === undefined) throw new Error(`no signer for ${key.alg}`);
	const sig = new Uint8Array(
		await crypto.subtle.sign(
			params,
			key.privateKey,
			new TextEncoder().encode(`${h}.${p}`),
		),
	);
	return `${h}.${p}.${b64url(sig)}`;
}

interface IssuedCode {
	clientId: string;
	redirectUri: string;
	nonce: string | null;
	challenge: string;
	sub: string;
}

export interface OidcProvider {
	readonly issuer: string;
	readonly clientId: string;
	readonly clientSecret: string;
	/** Who is signed in at the provider (in "this browser"); undefined = nobody. */
	signedInAs: string | undefined;
	/** Authorization requests seen (their query parameters). */
	readonly authorizeRequests: URLSearchParams[];
	/** Change the ID token's claims before signing (tests of bad tokens). */
	tamper: ((claims: Json) => Json) | undefined;
	/** Relay settings for this provider and its app backend. */
	relayConfig(extra?: Partial<OidcConfig>): OidcConfig;
	/** A tab assertion from the web app backend for a user and address. */
	assertion(
		sub: string,
		address: string,
		extra?: Json,
		header?: Json,
	): Promise<string>;
	/**
	 * The browser at the provider: follow the relay's redirect, return the
	 * provider's redirect back to the relay's callback.
	 */
	signIn(authorizeUrl: string): Promise<string>;
	stop(): Promise<void>;
}

export const APP_ISSUER = "https://app.example";

export async function startOidcProvider(): Promise<OidcProvider> {
	const providerKey = await signingKey("RS256", "provider-1");
	const appKey = await signingKey("ES256", "app-1");
	const clientId = "tab-mcp-relay";
	// Made at test time; never a real credential.
	const clientSecret = crypto.randomUUID();
	const codes = new Map<string, IssuedCode>();
	const authorizeRequests: URLSearchParams[] = [];
	let issuer = "";

	const state: {
		signedInAs: string | undefined;
		tamper: ((claims: Json) => Json) | undefined;
	} = { signedInAs: undefined, tamper: undefined };

	const tokenError = (error: string, status = 400) =>
		Response.json({ error }, { status });

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			const url = new URL(req.url);
			switch (url.pathname) {
				case "/.well-known/openid-configuration":
					return Response.json({
						issuer,
						authorization_endpoint: `${issuer}/authorize`,
						token_endpoint: `${issuer}/token`,
						jwks_uri: `${issuer}/jwks`,
						response_types_supported: ["code"],
						subject_types_supported: ["public"],
						id_token_signing_alg_values_supported: ["RS256"],
						token_endpoint_auth_methods_supported: ["client_secret_basic"],
						code_challenge_methods_supported: ["S256"],
					});
				case "/jwks":
					return Response.json({ keys: [providerKey.publicJwk] });
				case "/app/jwks":
					return Response.json({ keys: [appKey.publicJwk] });
				case "/authorize": {
					const q = url.searchParams;
					authorizeRequests.push(q);
					const redirect = new URL(q.get("redirect_uri") ?? "");
					const back = (params: Record<string, string>) => {
						for (const [k, v] of Object.entries(params)) {
							redirect.searchParams.set(k, v);
						}
						return new Response(null, {
							status: 302,
							headers: { location: redirect.href },
						});
					};
					const st = q.get("state") ?? "";
					if (state.signedInAs === undefined) {
						return back({ error: "login_required", state: st, iss: issuer });
					}
					const code = crypto.randomUUID();
					codes.set(code, {
						clientId: q.get("client_id") ?? "",
						redirectUri: q.get("redirect_uri") ?? "",
						nonce: q.get("nonce"),
						challenge: q.get("code_challenge") ?? "",
						sub: state.signedInAs,
					});
					return back({ code, state: st, iss: issuer });
				}
				case "/token": {
					if (req.method !== "POST") return new Response(null, { status: 405 });
					const expected = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
					if (req.headers.get("authorization") !== expected) {
						return tokenError("invalid_client", 401);
					}
					const form = new URLSearchParams(await req.text());
					const issued = codes.get(form.get("code") ?? "");
					codes.delete(form.get("code") ?? "");
					if (issued === undefined) return tokenError("invalid_grant");
					const verifier = form.get("code_verifier") ?? "";
					const challenge = b64url(
						new Uint8Array(
							await crypto.subtle.digest(
								"SHA-256",
								new TextEncoder().encode(verifier),
							),
						),
					);
					if (
						challenge !== issued.challenge ||
						form.get("redirect_uri") !== issued.redirectUri ||
						issued.clientId !== clientId
					) {
						return tokenError("invalid_grant");
					}
					const now = Math.floor(Date.now() / 1000);
					let claims: Json = {
						iss: issuer,
						sub: issued.sub,
						aud: clientId,
						exp: now + 300,
						iat: now,
						...(issued.nonce === null ? {} : { nonce: issued.nonce }),
					};
					if (state.tamper !== undefined) claims = state.tamper(claims);
					return Response.json({
						access_token: crypto.randomUUID(),
						token_type: "Bearer",
						expires_in: 300,
						id_token: await signJwt(providerKey, claims),
					});
				}
				default:
					return new Response("Not found", { status: 404 });
			}
		},
	});
	issuer = `http://127.0.0.1:${server.port}`;

	return {
		issuer,
		clientId,
		clientSecret,
		authorizeRequests,
		get signedInAs() {
			return state.signedInAs;
		},
		set signedInAs(v) {
			state.signedInAs = v;
		},
		get tamper() {
			return state.tamper;
		},
		set tamper(v) {
			state.tamper = v;
		},
		relayConfig(extra = {}) {
			return {
				issuer,
				clientId,
				clientSecret,
				assertionIssuer: APP_ISSUER,
				assertionJwksUrl: `${issuer}/app/jwks`,
				...extra,
			};
		},
		assertion(sub, address, extra = {}, header = {}) {
			const now = Math.floor(Date.now() / 1000);
			return signJwt(
				appKey,
				{
					iss: APP_ISSUER,
					sub,
					aud: address,
					iat: now,
					exp: now + 60,
					jti: crypto.randomUUID(),
					...extra,
				},
				{ typ: TAB_ASSERTION_TYP, ...header },
			);
		},
		async signIn(authorizeUrl) {
			const res = await fetch(authorizeUrl, { redirect: "manual" });
			const location = res.headers.get("location");
			if (res.status !== 302 || location === null) {
				throw new Error(`provider answered ${res.status}`);
			}
			return location;
		},
		stop: () => server.stop(true),
	};
}
