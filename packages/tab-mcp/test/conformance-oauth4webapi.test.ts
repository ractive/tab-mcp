/**
 * Conformance run with panva's oauth4webapi (DEC-031): an independent, strict
 * OAuth 2 client library drives discovery (RFC 9728, RFC 8414), the
 * authorization code flow with PKCE and `iss` (RFC 9207), refresh rotation and
 * revocation (RFC 7009) against the relay, with a CIMD client id.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import * as oauth from "oauth4webapi";
import { mcpPost, rpc, ScriptedTab } from "./helpers.ts";
import {
	type CimdServer,
	type OAuthTestRelay,
	startCimdServer,
	startOAuthRelay,
	TestBrowser,
} from "./oauth-helpers.ts";
import { signingKey } from "./oidc-fixture.ts";

let cimd: CimdServer;
let clientId: string;
let r: OAuthTestRelay;
const tabs: ScriptedTab[] = [];
const REDIRECT = "http://127.0.0.1:53682/callback";
const insecure = { [oauth.allowInsecureRequests]: true } as const;

beforeAll(async () => {
	cimd = await startCimdServer();
	clientId = cimd.serve(
		"/oauth4webapi.json",
		cimd.document(`${cimd.origin}/oauth4webapi.json`, {
			client_name: "oauth4webapi conformance",
			redirect_uris: ["http://127.0.0.1/callback"],
		}),
	);
});
afterAll(() => cimd.stop());
afterEach(async () => {
	for (const t of tabs.splice(0)) if (t.ws.readyState <= 1) t.close();
	await r?.stop();
});

test("discovery, authorization code + PKCE + iss, refresh rotation, reuse detection, revocation", async () => {
	r = startOAuthRelay(cimd);
	const tab = new ScriptedTab(r.wsUrl, { app: "conformance" });
	tabs.push(tab);
	const session = await tab.connect();
	const pairingCode = await tab.startPairing();
	const resource = new URL(session.address);

	// RFC 9728: the resource's metadata names the authorization server.
	const unauthorized = await mcpPost(session.address, rpc(1, "tools/list"));
	expect(unauthorized.status).toBe(401);
	const rs = await oauth.processResourceDiscoveryResponse(
		resource,
		await oauth.resourceDiscoveryRequest(resource, insecure),
	);
	expect(rs.authorization_servers).toEqual([r.url]);

	// RFC 8414 discovery; oauth4webapi checks that issuer matches.
	const issuer = new URL(rs.authorization_servers?.[0] ?? "");
	const as = await oauth.processDiscoveryResponse(
		issuer,
		await oauth.discoveryRequest(issuer, { algorithm: "oauth2", ...insecure }),
	);
	expect(as["client_id_metadata_document_supported"]).toBe(true);

	const client: oauth.Client = { client_id: clientId };
	const clientAuth = oauth.None();
	const verifier = oauth.generateRandomCodeVerifier();
	const challenge = await oauth.calculatePKCECodeChallenge(verifier);
	const state = oauth.generateRandomState();

	const authorizationUrl = new URL(as.authorization_endpoint ?? "");
	for (const [k, v] of Object.entries({
		client_id: clientId,
		redirect_uri: REDIRECT,
		response_type: "code",
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		scope: "tools",
		resource: resource.href,
	})) {
		authorizationUrl.searchParams.set(k, v);
	}

	// The user's browser: open the page, type the code from the tab.
	const browser = new TestBrowser(r.url);
	const page = await browser.open(authorizationUrl.href);
	expect(page.html).toContain("conformance");
	const done = await browser.submit(page, {
		action: "connect",
		code: pairingCode,
	});
	const callback = new URL(done.location ?? "");

	// RFC 9207: oauth4webapi requires iss to equal the issuer.
	const params = oauth.validateAuthResponse(as, client, callback, state);
	const codeResponse = await oauth.authorizationCodeGrantRequest(
		as,
		client,
		clientAuth,
		params,
		REDIRECT,
		verifier,
		{ additionalParameters: { resource: resource.href }, ...insecure },
	);
	const first = await oauth.processAuthorizationCodeResponse(
		as,
		client,
		codeResponse,
	);
	expect(first.token_type).toBe("bearer"); // normalised by the library
	expect(first.expires_in).toBe(3600);
	expect(first.scope).toBe("tools");
	expect(typeof first.refresh_token).toBe("string");
	expect(
		(
			await mcpPost(session.address, rpc(2, "tools/list"), {
				token: first.access_token,
			})
		).status,
	).toBe(200);

	// RFC 6749 §6 with rotation.
	const refreshed = await oauth.processRefreshTokenResponse(
		as,
		client,
		await oauth.refreshTokenGrantRequest(
			as,
			client,
			clientAuth,
			first.refresh_token ?? "",
			{
				additionalParameters: { resource: resource.href },
				...insecure,
			},
		),
	);
	expect(refreshed.refresh_token).not.toBe(first.refresh_token);
	expect(
		(
			await mcpPost(session.address, rpc(3, "tools/list"), {
				token: refreshed.access_token,
			})
		).status,
	).toBe(200);

	// Reusing the old refresh token is refused (and revokes the grant).
	const reuse = oauth.processRefreshTokenResponse(
		as,
		client,
		await oauth.refreshTokenGrantRequest(
			as,
			client,
			clientAuth,
			first.refresh_token ?? "",
			insecure,
		),
	);
	await expect(reuse).rejects.toMatchObject({ error: "invalid_grant" });
	expect(
		(
			await mcpPost(session.address, rpc(4, "tools/list"), {
				token: refreshed.access_token,
			})
		).status,
	).toBe(401);

	// A fresh grant, then RFC 7009 revocation.
	const code2 = await tab.nextCode(pairingCode);
	const verifier2 = oauth.generateRandomCodeVerifier();
	authorizationUrl.searchParams.set(
		"code_challenge",
		await oauth.calculatePKCECodeChallenge(verifier2),
	);
	const page2 = await browser.open(authorizationUrl.href);
	const done2 = await browser.submit(page2, { action: "connect", code: code2 });
	const second = await oauth.processAuthorizationCodeResponse(
		as,
		client,
		await oauth.authorizationCodeGrantRequest(
			as,
			client,
			clientAuth,
			oauth.validateAuthResponse(
				as,
				client,
				new URL(done2.location ?? ""),
				state,
			),
			REDIRECT,
			verifier2,
			insecure,
		),
	);
	await oauth.processRevocationResponse(
		await oauth.revocationRequest(
			as,
			client,
			clientAuth,
			second.refresh_token ?? "",
			insecure,
		),
	);
	expect(
		(
			await mcpPost(session.address, rpc(5, "tools/list"), {
				token: second.access_token,
			})
		).status,
	).toBe(401);
}, 20_000);

test("private_key_jwt (DEC-106): oauth4webapi's client assertions at /token and /revoke", async () => {
	const key = await signingKey("ES256", "conf-1");
	const pkjwtId = cimd.serve(
		"/oauth4webapi-pkjwt.json",
		cimd.document(`${cimd.origin}/oauth4webapi-pkjwt.json`, {
			client_name: "oauth4webapi private_key_jwt",
			redirect_uris: ["http://127.0.0.1/callback"],
			token_endpoint_auth_method: "private_key_jwt",
			token_endpoint_auth_signing_alg: "ES256",
			jwks_uri: cimd.serve("/oauth4webapi-jwks.json", {
				keys: [key.publicJwk],
			}),
		}),
	);
	r = startOAuthRelay(cimd);
	const tab = new ScriptedTab(r.wsUrl, { app: "conformance" });
	tabs.push(tab);
	const session = await tab.connect();
	const pairingCode = await tab.startPairing();
	const issuer = new URL(r.url);
	const as = await oauth.processDiscoveryResponse(
		issuer,
		await oauth.discoveryRequest(issuer, { algorithm: "oauth2", ...insecure }),
	);
	expect(as.token_endpoint_auth_methods_supported).toContain("private_key_jwt");
	const client: oauth.Client = { client_id: pkjwtId };
	const clientAuth = oauth.PrivateKeyJwt({ key: key.privateKey, kid: key.kid });
	const verifier = oauth.generateRandomCodeVerifier();
	const state = oauth.generateRandomState();
	const authorizationUrl = new URL(as.authorization_endpoint ?? "");
	for (const [k, v] of Object.entries({
		client_id: pkjwtId,
		redirect_uri: REDIRECT,
		response_type: "code",
		code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
		code_challenge_method: "S256",
		state,
		scope: "tools",
		resource: session.address,
	})) {
		authorizationUrl.searchParams.set(k, v);
	}
	const browser = new TestBrowser(r.url);
	const page = await browser.open(authorizationUrl.href);
	const done = await browser.submit(page, {
		action: "connect",
		code: pairingCode,
	});
	const tokens = await oauth.processAuthorizationCodeResponse(
		as,
		client,
		await oauth.authorizationCodeGrantRequest(
			as,
			client,
			clientAuth,
			oauth.validateAuthResponse(
				as,
				client,
				new URL(done.location ?? ""),
				state,
			),
			REDIRECT,
			verifier,
			insecure,
		),
	);
	// The grant is bound: a refresh as a public client is refused (401
	// invalid_client, which oauth4webapi reports as a challenge).
	const unauthenticated = await oauth.refreshTokenGrantRequest(
		as,
		client,
		oauth.None(),
		tokens.refresh_token ?? "",
		insecure,
	);
	expect(unauthenticated.status).toBe(401);
	expect(await unauthenticated.clone().json()).toMatchObject({
		error: "invalid_client",
	});
	await expect(
		oauth.processRefreshTokenResponse(as, client, unauthenticated),
	).rejects.toBeInstanceOf(oauth.WWWAuthenticateChallengeError);
	const refreshed = await oauth.processRefreshTokenResponse(
		as,
		client,
		await oauth.refreshTokenGrantRequest(
			as,
			client,
			clientAuth,
			tokens.refresh_token ?? "",
			insecure,
		),
	);
	expect(
		(
			await mcpPost(session.address, rpc(1, "tools/list"), {
				token: refreshed.access_token,
			})
		).status,
	).toBe(200);
	await oauth.processRevocationResponse(
		await oauth.revocationRequest(
			as,
			client,
			clientAuth,
			refreshed.refresh_token ?? "",
			insecure,
		),
	);
	expect(
		(
			await mcpPost(session.address, rpc(2, "tools/list"), {
				token: refreshed.access_token,
			})
		).status,
	).toBe(401);
}, 20_000);

test("oauth4webapi refuses a response without the right iss (mix-up defence works end to end)", async () => {
	r = startOAuthRelay(cimd);
	const issuer = new URL(r.url);
	const as = await oauth.processDiscoveryResponse(
		issuer,
		await oauth.discoveryRequest(issuer, { algorithm: "oauth2", ...insecure }),
	);
	const forged = new URL(
		`${REDIRECT}?code=x&state=s&iss=${encodeURIComponent("https://evil.example")}`,
	);
	expect(() =>
		oauth.validateAuthResponse(as, { client_id: clientId }, forged, "s"),
	).toThrow();
});
