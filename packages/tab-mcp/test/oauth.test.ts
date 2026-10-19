/**
 * The authorization server against the specifications it implements, one
 * group per requirement (DEC-031). Section numbers name the rule each test
 * pins. The flow runs with a scripted tab showing pairing codes and a test
 * browser typing them on `/authorize`.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { newSecret } from "../src/address.ts";
import type { PairingMethod } from "../src/oauth/pairing.ts";
import type { CreateRelayOptions, RelayTestHooks } from "../src/relay.ts";
import {
	mcpPost,
	rpc,
	ScriptedTab,
	type TabOptions,
	waitFor,
} from "./helpers.ts";
import {
	authorizeUrl,
	type CimdServer,
	type OAuthTestRelay,
	pkce,
	postForm,
	startCimdServer,
	startOAuthRelay,
	TestBrowser,
} from "./oauth-helpers.ts";

let cimd: CimdServer;
let clientId: string;
let current: OAuthTestRelay | undefined;
const tabs: ScriptedTab[] = [];

const REDIRECT = "http://127.0.0.1:4567/callback";

beforeAll(async () => {
	cimd = await startCimdServer();
	clientId = cimd.serve(
		"/client.json",
		cimd.document(`${cimd.origin}/client.json`),
	);
});
afterAll(() => cimd.stop());
afterEach(async () => {
	for (const t of tabs.splice(0)) if (t.ws.readyState <= 1) t.close();
	await current?.stop();
	current = undefined;
});

interface Ctx {
	r: OAuthTestRelay;
	tab: ScriptedTab;
	address: string;
	browser: TestBrowser;
	usedCodes: Set<string>;
}

async function setup(
	options: CreateRelayOptions = {},
	hooks: RelayTestHooks = {},
	tabOptions: TabOptions = {},
): Promise<Ctx> {
	const r = startOAuthRelay(cimd, options, hooks);
	current = r;
	const tab = new ScriptedTab(r.wsUrl, tabOptions);
	tabs.push(tab);
	const session = await tab.connect();
	await tab.startPairing();
	return {
		r,
		tab,
		address: session.address,
		browser: new TestBrowser(r.url),
		usedCodes: new Set(),
	};
}

/** The pairing code the tab shows now (not one used before). */
async function currentCode(ctx: Ctx): Promise<string> {
	await waitFor(
		() =>
			ctx.tab.pairingCode !== undefined &&
			!ctx.usedCodes.has(ctx.tab.pairingCode),
		"a fresh code",
	);
	return ctx.tab.pairingCode ?? "";
}

interface Authorized {
	code: string;
	verifier: string;
	location: URL;
}

/** Open /authorize, type the tab's code, return the redirect's code. */
async function authorize(
	ctx: Ctx,
	params: Record<string, string | undefined> = {},
): Promise<Authorized> {
	const { verifier, challenge } = pkce();
	const page = await ctx.browser.open(
		authorizeUrl(ctx.r.url, {
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_challenge: challenge,
			resource: ctx.address,
			...params,
		}),
	);
	expect(page.status).toBe(200);
	const code = await currentCode(ctx);
	const result = await ctx.browser.submit(page, { action: "connect", code });
	ctx.usedCodes.add(code);
	expect(result.status).toBe(303);
	const location = new URL(result.location ?? "");
	return { code: location.searchParams.get("code") ?? "", verifier, location };
}

async function exchange(
	ctx: Ctx,
	a: Authorized,
	extra: Record<string, string | undefined> = {},
): Promise<Response> {
	return postForm(`${ctx.r.url}/token`, {
		grant_type: "authorization_code",
		code: a.code,
		redirect_uri: REDIRECT,
		code_verifier: a.verifier,
		client_id: clientId,
		resource: ctx.address,
		...extra,
	});
}

interface TokenBody {
	access_token: string;
	refresh_token: string;
	token_type: string;
	expires_in: number;
	scope: string;
}

async function tokens(ctx: Ctx): Promise<TokenBody> {
	const res = await exchange(ctx, await authorize(ctx));
	expect(res.status).toBe(200);
	return (await res.json()) as TokenBody;
}

async function oauthError(
	res: Response,
): Promise<{ status: number; error: string }> {
	const body = (await res.json()) as {
		error: string;
		error_description?: string;
	};
	expect(typeof body.error_description).toBe("string");
	return { status: res.status, error: body.error };
}

function refresh(
	ctx: Ctx,
	refreshToken: string,
	extra: Record<string, string> = {},
) {
	return postForm(`${ctx.r.url}/token`, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: clientId,
		resource: ctx.address,
		...extra,
	});
}

async function toolsList(address: string, token: string): Promise<number> {
	return (await mcpPost(address, rpc(1, "tools/list"), { token })).status;
}

describe("RFC 9728: protected resource metadata", () => {
	test("§5.1: the 401 names the metadata URL; the metadata names the address and the relay (§3.2)", async () => {
		const { r, address } = await setup();
		const res = await mcpPost(address, rpc(1, "tools/list"));
		expect(res.status).toBe(401);
		const challenge = res.headers.get("www-authenticate") ?? "";
		const url = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
		expect(url).toBe(
			`${r.url}/.well-known/oauth-protected-resource${new URL(address).pathname}`,
		);
		expect(challenge).toContain('scope="tools"');
		const meta = await fetch(url);
		expect(meta.status).toBe(200);
		expect(meta.headers.get("access-control-allow-origin")).toBe("*");
		expect(await meta.json()).toEqual({
			resource: address,
			authorization_servers: [r.url],
			scopes_supported: ["tools"],
			bearer_methods_supported: ["header"],
			resource_name: "Tools of a web page (tab-mcp)",
		});
	});

	test("a malformed address id has no metadata", async () => {
		const { r } = await setup();
		const res = await fetch(
			`${r.url}/.well-known/oauth-protected-resource/a/x/mcp`,
		);
		expect(res.status).toBe(404);
	});
});

describe("RFC 8414: authorization server metadata", () => {
	test("§2/§3.2: issuer, endpoints, PKCE S256, auth method none, CIMD, iss; no registration endpoint", async () => {
		const { r } = await setup();
		const res = await fetch(`${r.url}/.well-known/oauth-authorization-server`);
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		const m = (await res.json()) as Record<string, unknown>;
		expect(m["issuer"]).toBe(r.url); // §3.3: equals the URL it was fetched for
		expect(m["authorization_endpoint"]).toBe(`${r.url}/authorize`);
		expect(m["token_endpoint"]).toBe(`${r.url}/token`);
		expect(m["revocation_endpoint"]).toBe(`${r.url}/revoke`);
		expect(m["response_types_supported"]).toEqual(["code"]);
		expect(m["grant_types_supported"]).toEqual([
			"authorization_code",
			"refresh_token",
		]);
		expect(m["code_challenge_methods_supported"]).toEqual(["S256"]);
		// claude.ai uses CIMD only with both of these (AI app support research).
		expect(m["token_endpoint_auth_methods_supported"]).toEqual(["none"]);
		expect(m["client_id_metadata_document_supported"]).toBe(true);
		expect(m["authorization_response_iss_parameter_supported"]).toBe(true);
		expect(m["scopes_supported"]).toEqual(["tools"]);
		expect(m["registration_endpoint"]).toBeUndefined();
	});

	test("CORS preflight for metadata, token and revoke (DEC-036)", async () => {
		const { r } = await setup();
		for (const path of [
			"/.well-known/oauth-authorization-server",
			"/token",
			"/revoke",
		]) {
			const res = await fetch(`${r.url}${path}`, { method: "OPTIONS" });
			expect(res.status).toBe(204);
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
			expect(res.headers.get("access-control-allow-credentials")).toBeNull();
		}
	});
});

describe("RFC 6749 §4.1.1/§4.1.2: authorization request and response", () => {
	test("success: code, state and iss (RFC 9207 §2) on the registered redirect URI", async () => {
		const ctx = await setup();
		const a = await authorize(ctx);
		expect(`${a.location.origin}${a.location.pathname}`).toBe(REDIRECT);
		expect(a.location.searchParams.get("state")).toBe("st-1");
		expect(a.location.searchParams.get("iss")).toBe(ctx.r.url);
		expect(a.code.length).toBeGreaterThanOrEqual(43);
	});

	test("§4.1.2.1: a missing or bad client_id is shown on the page, never redirected", async () => {
		const ctx = await setup();
		const { challenge } = pkce();
		for (const id of [
			undefined,
			"not a url",
			"https://localhost/",
			`${cimd.origin}/missing.json`,
		]) {
			const page = await ctx.browser.open(
				authorizeUrl(ctx.r.url, {
					client_id: id,
					redirect_uri: REDIRECT,
					code_challenge: challenge,
					resource: ctx.address,
				}),
			);
			expect(page.status).toBe(400);
			expect(page.location).toBeUndefined();
			expect(page.html).toContain("This connection cannot be made");
		}
	});

	test("§4.1.2.1 / §3.1.2: an unregistered redirect_uri is shown on the page, not redirected", async () => {
		const ctx = await setup();
		const { challenge } = pkce();
		for (const redirect of [
			"https://evil.example/cb",
			"https://app.example/cb/extra",
			"https://app.example/cb?x=1",
			"http://localhost:4567/callback", // registered as 127.0.0.1, not localhost
			"http://127.0.0.1:4567/callback/../callback",
			undefined,
		]) {
			const page = await ctx.browser.open(
				authorizeUrl(ctx.r.url, {
					client_id: clientId,
					redirect_uri: redirect,
					code_challenge: challenge,
					resource: ctx.address,
				}),
			);
			expect(page.status).toBe(400);
			expect(page.location).toBeUndefined();
		}
	});

	test("RFC 8252 §7.3: a loopback redirect matches with any port; other URIs only exactly", async () => {
		const ctx = await setup();
		const { challenge } = pkce();
		for (const redirect of [
			"http://127.0.0.1:1/callback",
			"http://127.0.0.1:65000/callback",
			"http://127.0.0.1/callback",
			"https://app.example/cb",
		]) {
			const page = await ctx.browser.open(
				authorizeUrl(ctx.r.url, {
					client_id: clientId,
					redirect_uri: redirect,
					code_challenge: challenge,
					resource: ctx.address,
				}),
			);
			expect(page.status).toBe(200);
		}
	});

	const redirected = async (
		params: Record<string, string | undefined>,
		error: string,
	) => {
		const ctx = await setup();
		const { challenge } = pkce();
		const page = await ctx.browser.open(
			authorizeUrl(ctx.r.url, {
				client_id: clientId,
				redirect_uri: REDIRECT,
				code_challenge: challenge,
				resource: ctx.address,
				...params,
			}),
		);
		expect(page.status).toBe(303);
		const location = new URL(page.location ?? "");
		expect(location.searchParams.get("error")).toBe(error);
		expect(location.searchParams.get("iss")).toBe(ctx.r.url);
		expect(location.searchParams.get("code")).toBeNull();
		return location;
	};

	test("§4.1.2.1: response_type other than code → unsupported_response_type, with state", async () => {
		const location = await redirected(
			{ response_type: "token" },
			"unsupported_response_type",
		);
		expect(location.searchParams.get("state")).toBe("st-1");
	});

	test("RFC 7636 §4.4.1: no code_challenge → invalid_request (PKCE is required)", async () => {
		await redirected({ code_challenge: undefined }, "invalid_request");
	});

	test("RFC 7636 §4.3: plain or missing method → invalid_request (S256 only)", async () => {
		await redirected({ code_challenge_method: "plain" }, "invalid_request");
		await redirected({ code_challenge_method: undefined }, "invalid_request");
	});

	test("RFC 7636 §4.2: a malformed code_challenge → invalid_request", async () => {
		await redirected({ code_challenge: "short" }, "invalid_request");
	});

	test("RFC 8707 §2: a missing resource or one that is not an address here → invalid_target", async () => {
		await redirected({ resource: undefined }, "invalid_target");
		await redirected(
			{ resource: "https://other.example/a/x/mcp" },
			"invalid_target",
		);
	});

	test("§3.3: an unknown scope → invalid_scope; tools alone or with extras is granted as tools", async () => {
		await redirected({ scope: "admin" }, "invalid_scope");
		const ctx = await setup();
		const a = await authorize(ctx, { scope: "tools offline_access" });
		const body = (await (await exchange(ctx, a)).json()) as TokenBody;
		expect(body.scope).toBe("tools");
	});

	test("§3.1: a repeated parameter → invalid_request", async () => {
		const ctx = await setup();
		const { challenge } = pkce();
		const url = `${authorizeUrl(ctx.r.url, {
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_challenge: challenge,
			resource: ctx.address,
		})}&state=again`;
		const page = await ctx.browser.open(url);
		expect(page.status).toBe(303);
		expect(new URL(page.location ?? "").searchParams.get("error")).toBe(
			"invalid_request",
		);
	});

	test("§4.1.2.1: Cancel → access_denied with state and iss", async () => {
		const ctx = await setup();
		const { challenge } = pkce();
		const page = await ctx.browser.open(
			authorizeUrl(ctx.r.url, {
				client_id: clientId,
				redirect_uri: REDIRECT,
				code_challenge: challenge,
				resource: ctx.address,
			}),
		);
		const result = await ctx.browser.submit(page, { action: "cancel" });
		expect(result.status).toBe(303);
		const location = new URL(result.location ?? "");
		expect(location.searchParams.get("error")).toBe("access_denied");
		expect(location.searchParams.get("state")).toBe("st-1");
		expect(location.searchParams.get("iss")).toBe(ctx.r.url);
		// The request is used up.
		expect((await ctx.browser.submit(page, { action: "cancel" })).status).toBe(
			400,
		);
	});
});

describe("pairing with the code shown in the tab (DEC-028)", () => {
	const open = async (ctx: Ctx) => {
		const { challenge } = pkce();
		return ctx.browser.open(
			authorizeUrl(ctx.r.url, {
				client_id: clientId,
				redirect_uri: REDIRECT,
				code_challenge: challenge,
				resource: ctx.address,
			}),
		);
	};

	test("the page names the client, its verified host, the app name and the page origin", async () => {
		const ctx = await setup({}, {}, { app: "saturnus" });
		const page = await open(ctx);
		const host = new URL(clientId).host;
		expect(page.html).toContain(
			`You're connecting <strong>Test AI</strong> (${host}) to <strong>saturnus</strong> on <span class="origin">https://page.example</span>.`,
		);
		expect(page.html).toContain('autocomplete="one-time-code"');
	});

	test("without an app name the page says 'tools from <origin>'", async () => {
		const ctx = await setup();
		const page = await open(ctx);
		expect(page.html).toContain(
			'to tools from <span class="origin">https://page.example</span>',
		);
	});

	test("the tab offline: 'Open the page first' with Try again; it works once the tab is back", async () => {
		const r = startOAuthRelay(cimd);
		current = r;
		const secret = newSecret();
		const address = r.relay.addressFor(secret);
		const browser = new TestBrowser(r.url);
		const { challenge } = pkce();
		const page = await browser.open(
			authorizeUrl(r.url, {
				client_id: clientId,
				redirect_uri: REDIRECT,
				code_challenge: challenge,
				resource: address,
			}),
		);
		expect(page.status).toBe(200);
		expect(page.html).toContain("Open the page first");
		expect(page.html).toContain('value="retry"');
		const stillOffline = await browser.submit(page, {
			action: "connect",
			code: "123456",
		});
		expect(stillOffline.html).toContain("The page is still not open.");

		const tab = new ScriptedTab(r.wsUrl, { secret });
		tabs.push(tab);
		await tab.connect();
		const code = await tab.startPairing();
		const retry = await browser.submit(page, { action: "retry" });
		expect(retry.html).toContain("You're connecting");
		const done = await browser.submit(retry, { action: "connect", code });
		expect(done.status).toBe(303);
		expect(
			new URL(done.location ?? "").searchParams.get("code"),
		).not.toBeNull();
	});

	test("a wrong code fails and says how many tries are left; the right one still works", async () => {
		const ctx = await setup();
		const page = await open(ctx);
		const code = await currentCode(ctx);
		const wrong = code === "000000" ? "000001" : "000000";
		const res = await ctx.browser.submit(page, {
			action: "connect",
			code: wrong,
		});
		expect(res.status).toBe(400);
		expect(res.html).toContain("That code is not right.");
		expect(res.html).toContain("4 tries are left");
		expect(res.html).toContain('role="alert"');
		const ok = await ctx.browser.submit(res, { action: "connect", code });
		expect(ok.status).toBe(303);
	});

	test("5 wrong codes: the code is replaced and the old one no longer works", async () => {
		const ctx = await setup();
		let page = await open(ctx);
		const code = await currentCode(ctx);
		const wrong = code === "000000" ? "000001" : "000000";
		for (let i = 0; i < 4; i++) {
			page = await ctx.browser.submit(page, { action: "connect", code: wrong });
			expect(page.status).toBe(400);
		}
		page = await ctx.browser.submit(page, { action: "connect", code: wrong });
		expect(page.html).toContain("Too many wrong codes.");
		const fresh = await ctx.tab.nextCode(code);
		expect(fresh).not.toBe(code);
		const old = await ctx.browser.submit(page, { action: "connect", code });
		expect(old.status).toBe(400);
		const ok = await ctx.browser.submit(old, {
			action: "connect",
			code: fresh,
		});
		expect(ok.status).toBe(303);
	});

	test("an expired code fails; a fresh code arrives by itself", async () => {
		const ctx = await setup({}, { pairingCodeTtlMs: 150 });
		const page = await open(ctx);
		const code = await currentCode(ctx);
		const fresh = await ctx.tab.nextCode(code); // after 150 ms
		const res = await ctx.browser.submit(page, { action: "connect", code });
		expect(res.status).toBe(400);
		expect(res.html).toContain("That code has expired.");
		await Bun.sleep(1); // the fresh code is valid
		const ok = await ctx.browser.submit(res, {
			action: "connect",
			code: ctx.tab.pairingCode ?? fresh,
		});
		expect(ok.status).toBe(303);
	});

	test("a code is single-use: after a success the tab shows a new one", async () => {
		const ctx = await setup();
		const first = await open(ctx);
		const code = await currentCode(ctx);
		expect(
			(await ctx.browser.submit(first, { action: "connect", code })).status,
		).toBe(303);
		const second = await open(ctx);
		const again = await ctx.browser.submit(second, { action: "connect", code });
		expect(again.status).toBe(400);
		expect(await ctx.tab.nextCode(code)).not.toBe(code);
	});

	test("no code while the tab's dialog is closed; pairing.stop ends the code", async () => {
		const ctx = await setup();
		const code = await currentCode(ctx);
		ctx.tab.send({ type: "pairing.stop" });
		await Bun.sleep(20);
		const page = await open(ctx);
		const res = await ctx.browser.submit(page, { action: "connect", code });
		expect(res.status).toBe(400);
		expect(res.html).toContain("The page is not showing a code right now.");
	});

	test("malformed input is not counted as a try", async () => {
		const ctx = await setup();
		let page = await open(ctx);
		for (let i = 0; i < 6; i++) {
			page = await ctx.browser.submit(page, {
				action: "connect",
				code: "12ab",
			});
			expect(page.html).toContain("Enter the 6 digits");
		}
		const ok = await ctx.browser.submit(page, {
			action: "connect",
			code: await currentCode(ctx),
		});
		expect(ok.status).toBe(303);
	});

	test("attempts per address are rate-limited (threat model A1)", async () => {
		const ctx = await setup();
		let page = await open(ctx);
		const code = await currentCode(ctx);
		const wrong = code === "000000" ? "000001" : "000000";
		const statuses: number[] = [];
		for (let i = 0; i < 12; i++) {
			page = await ctx.browser.submit(page, { action: "connect", code: wrong });
			statuses.push(page.status);
		}
		expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
		expect(statuses.slice(10)).toEqual([429, 429]);
	});

	test("codes are never logged", async () => {
		const ctx = await setup();
		await tokens(ctx);
		const all = ctx.r.logs.lines.join("\n");
		for (const code of ctx.usedCodes) expect(all).not.toContain(code);
		expect(all).toContain('"event":"oauth.paired"');
	});
});

describe("RFC 6749 §4.1.3/§5.1/§5.2: token endpoint, authorization code", () => {
	test("§5.1: tokens with no-store; the tab hears grant.added; the token calls tools", async () => {
		const ctx = await setup();
		const res = await exchange(ctx, await authorize(ctx));
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("pragma")).toBe("no-cache");
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		const body = (await res.json()) as TokenBody;
		expect(body.token_type).toBe("Bearer");
		expect(body.expires_in).toBe(3600);
		expect(body.scope).toBe("tools");
		expect(body.access_token).toStartWith("tmcp_at_");
		expect(body.refresh_token).toStartWith("tmcp_rt_");
		const added = (await ctx.tab.next("grant.added")) as unknown as {
			grant: { grantId: string; client: Record<string, string> };
		};
		expect(added.grant.client).toEqual({
			id: clientId,
			name: "Test AI",
			host: new URL(clientId).host,
		});
		expect(await toolsList(ctx.address, body.access_token)).toBe(200);
		// Only hashes are stored.
		const record = await ctx.r.store.get(body.access_token);
		expect(record).toBeUndefined();
	});

	test("§4.1.2: a code used twice fails and revokes the tokens issued for it", async () => {
		const ctx = await setup();
		const a = await authorize(ctx);
		const first = (await (await exchange(ctx, a)).json()) as TokenBody;
		expect(await toolsList(ctx.address, first.access_token)).toBe(200);
		expect(await oauthError(await exchange(ctx, a))).toEqual({
			status: 400,
			error: "invalid_grant",
		});
		expect(await toolsList(ctx.address, first.access_token)).toBe(401);
		const removed = await ctx.tab.next("grant.removed");
		expect((removed as unknown as { reason: string }).reason).toBe(
			"reuse_detected",
		);
	});

	test("§4.1.2: an expired code fails (60 s lifetime, shortened here)", async () => {
		const ctx = await setup({}, { authCodeTtlMs: 50 });
		const a = await authorize(ctx);
		await Bun.sleep(80);
		expect((await oauthError(await exchange(ctx, a))).error).toBe(
			"invalid_grant",
		);
	});

	test("§4.1.3: redirect_uri and client_id must match the authorization request", async () => {
		const ctx = await setup();
		expect(
			(
				await oauthError(
					await exchange(ctx, await authorize(ctx), {
						redirect_uri: "http://127.0.0.1:9/callback",
					}),
				)
			).error,
		).toBe("invalid_grant");
		expect(
			(
				await oauthError(
					await exchange(ctx, await authorize(ctx), {
						client_id: `${cimd.origin}/other.json`,
					}),
				)
			).error,
		).toBe("invalid_grant");
	});

	test("RFC 7636 §4.6: a wrong code_verifier → invalid_grant (and the code is burnt)", async () => {
		const ctx = await setup();
		const a = await authorize(ctx);
		expect(
			(
				await oauthError(
					await exchange(ctx, a, { code_verifier: pkce().verifier }),
				)
			).error,
		).toBe("invalid_grant");
		expect((await oauthError(await exchange(ctx, a))).error).toBe(
			"invalid_grant",
		);
	});

	test("RFC 7636 §4.5: no code_verifier → invalid_request", async () => {
		const ctx = await setup();
		expect(
			(
				await oauthError(
					await exchange(ctx, await authorize(ctx), {
						code_verifier: undefined,
					}),
				)
			).error,
		).toBe("invalid_request");
	});

	test("RFC 8707 §2.2: a resource other than the authorized one → invalid_target", async () => {
		const ctx = await setup();
		const other = ctx.r.relay.addressFor(newSecret());
		expect(
			(
				await oauthError(
					await exchange(ctx, await authorize(ctx), { resource: other }),
				)
			).error,
		).toBe("invalid_target");
	});

	test("§5.2: grant_type missing → invalid_request, unknown → unsupported_grant_type", async () => {
		const ctx = await setup();
		const url = `${ctx.r.url}/token`;
		expect(
			(await oauthError(await postForm(url, { client_id: clientId }))).error,
		).toBe("invalid_request");
		expect(
			(
				await oauthError(
					await postForm(url, { client_id: clientId, grant_type: "password" }),
				)
			).error,
		).toBe("unsupported_grant_type");
		expect(
			(
				await oauthError(
					await postForm(url, {
						client_id: clientId,
						grant_type: "client_credentials",
					}),
				)
			).error,
		).toBe("unsupported_grant_type");
	});

	test("§5.2: client authentication is refused (auth method none): secret → 400, Authorization header → 401", async () => {
		const ctx = await setup();
		const url = `${ctx.r.url}/token`;
		const secret = await postForm(url, {
			grant_type: "authorization_code",
			client_id: clientId,
			client_secret: "x",
		});
		expect(await oauthError(secret)).toEqual({
			status: 400,
			error: "invalid_client",
		});
		const basic = await postForm(
			url,
			{ grant_type: "authorization_code", client_id: clientId },
			{ authorization: `Basic ${btoa("a:b")}` },
		);
		expect(basic.headers.get("www-authenticate")).toContain("Basic");
		expect(await oauthError(basic)).toEqual({
			status: 401,
			error: "invalid_client",
		});
	});

	test("§3.2: the body must be form-encoded; repeated parameters are refused", async () => {
		const ctx = await setup();
		const json = await fetch(`${ctx.r.url}/token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ grant_type: "authorization_code" }),
		});
		expect((await oauthError(json)).error).toBe("invalid_request");
		const twice = await fetch(`${ctx.r.url}/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: `grant_type=refresh_token&client_id=${encodeURIComponent(clientId)}&refresh_token=a&refresh_token=b`,
		});
		expect((await oauthError(twice)).error).toBe("invalid_request");
		expect((await fetch(`${ctx.r.url}/token`)).status).toBe(405);
	});

	test("RFC 8707: an access token works only at its own address (audience)", async () => {
		const ctx = await setup();
		const body = await tokens(ctx);
		const otherTab = new ScriptedTab(ctx.r.wsUrl);
		tabs.push(otherTab);
		const other = await otherTab.connect();
		expect(await toolsList(other.address, body.access_token)).toBe(401);
		expect(await toolsList(ctx.address, body.access_token)).toBe(200);
	});
});

describe("RFC 6749 §6 and RFC 9700 §4.14: refresh token rotation (DEC-029)", () => {
	test("a refresh gives new tokens; the old refresh token then revokes the grant", async () => {
		const ctx = await setup();
		const first = await tokens(ctx);
		const res = await refresh(ctx, first.refresh_token);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const second = (await res.json()) as TokenBody;
		expect(second.refresh_token).not.toBe(first.refresh_token);
		expect(second.access_token).not.toBe(first.access_token);
		expect(await toolsList(ctx.address, second.access_token)).toBe(200);

		const reuse = await refresh(ctx, first.refresh_token);
		expect(await oauthError(reuse)).toEqual({
			status: 400,
			error: "invalid_grant",
		});
		const removed = (await ctx.tab.next("grant.removed")) as unknown as {
			reason: string;
		};
		expect(removed.reason).toBe("reuse_detected");
		expect(await toolsList(ctx.address, second.access_token)).toBe(401);
		expect(
			(await oauthError(await refresh(ctx, second.refresh_token))).error,
		).toBe("invalid_grant");
		expect(ctx.r.logs.events("oauth.refresh_reuse")).toHaveLength(1);
	});

	test("two concurrent refreshes with one token: exactly one wins (markUsed is atomic)", async () => {
		const ctx = await setup();
		const first = await tokens(ctx);
		const results = await Promise.all([
			refresh(ctx, first.refresh_token),
			refresh(ctx, first.refresh_token),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
	});

	test("another client, another address, a wider scope, an expired token: refused", async () => {
		const ctx = await setup({ refreshTokenTtlMs: 300 });
		const t = await tokens(ctx);
		expect(
			(
				await oauthError(
					await refresh(ctx, t.refresh_token, {
						client_id: `${cimd.origin}/other.json`,
					}),
				)
			).error,
		).toBe("invalid_grant");
		expect(
			(
				await oauthError(
					await refresh(ctx, t.refresh_token, {
						resource: ctx.r.relay.addressFor(newSecret()),
					}),
				)
			).error,
		).toBe("invalid_target");
		expect(
			(
				await oauthError(
					await refresh(ctx, t.refresh_token, { scope: "tools admin" }),
				)
			).error,
		).toBe("invalid_scope");
		await Bun.sleep(350);
		expect((await oauthError(await refresh(ctx, t.refresh_token))).error).toBe(
			"invalid_grant",
		);
	});

	test("an access token presented as a refresh token is refused", async () => {
		const ctx = await setup();
		const t = await tokens(ctx);
		expect((await oauthError(await refresh(ctx, t.access_token))).error).toBe(
			"invalid_grant",
		);
	});
});

describe("RFC 7009: token revocation", () => {
	test("§2.1: revoking the refresh token ends the grant; the tab hears grant.removed", async () => {
		const ctx = await setup();
		const t = await tokens(ctx);
		const res = await postForm(`${ctx.r.url}/revoke`, {
			token: t.refresh_token,
			token_type_hint: "refresh_token",
			client_id: clientId,
		});
		expect(res.status).toBe(200);
		expect(await toolsList(ctx.address, t.access_token)).toBe(401);
		const removed = (await ctx.tab.next("grant.removed")) as unknown as {
			reason: string;
		};
		expect(removed.reason).toBe("revoked");
	});

	test("§2.1: revoking the access token ends the grant too", async () => {
		const ctx = await setup();
		const t = await tokens(ctx);
		const res = await postForm(`${ctx.r.url}/revoke`, {
			token: t.access_token,
			client_id: clientId,
		});
		expect(res.status).toBe(200);
		expect((await oauthError(await refresh(ctx, t.refresh_token))).error).toBe(
			"invalid_grant",
		);
	});

	test("§2.2: an unknown token is not an error; another client's token is refused", async () => {
		const ctx = await setup();
		const t = await tokens(ctx);
		expect(
			(
				await postForm(`${ctx.r.url}/revoke`, {
					token: "nope",
					client_id: clientId,
				})
			).status,
		).toBe(200);
		const other = await postForm(`${ctx.r.url}/revoke`, {
			token: t.refresh_token,
			client_id: `${cimd.origin}/other.json`,
		});
		expect((await oauthError(other)).error).toBe("invalid_client");
		expect(await toolsList(ctx.address, t.access_token)).toBe(200);
		expect(
			(
				await oauthError(
					await postForm(`${ctx.r.url}/revoke`, { client_id: clientId }),
				)
			).error,
		).toBe("invalid_request");
	});
});

describe("grants in the tab (protocol: pairing and grants)", () => {
	test("session.grants lists the connected app after a reconnect", async () => {
		const ctx = await setup();
		await tokens(ctx);
		ctx.tab.close();
		await ctx.tab.closed;
		const again = new ScriptedTab(ctx.r.wsUrl, { secret: ctx.tab.secret });
		tabs.push(again);
		const session = await again.connect();
		expect(session.grants).toHaveLength(1);
		expect(session.grants[0]?.client).toEqual({
			id: clientId,
			name: "Test AI",
			host: new URL(clientId).host,
		});
	});

	test("grant.revoke from the tab (Disconnect) stops the tokens at once", async () => {
		const ctx = await setup();
		const t = await tokens(ctx);
		const added = (await ctx.tab.next("grant.added")) as unknown as {
			grant: { grantId: string };
		};
		ctx.tab.send({ type: "grant.revoke", grantId: added.grant.grantId });
		const removed = (await ctx.tab.next("grant.removed")) as unknown as {
			grantId: string;
			reason: string;
		};
		expect(removed).toMatchObject({
			grantId: added.grant.grantId,
			reason: "revoked",
		});
		expect(await toolsList(ctx.address, t.access_token)).toBe(401);
		expect((await oauthError(await refresh(ctx, t.refresh_token))).error).toBe(
			"invalid_grant",
		);
	});

	test("grant.revoke of a grant of another address is refused", async () => {
		const ctx = await setup();
		await tokens(ctx);
		const added = (await ctx.tab.next("grant.added")) as unknown as {
			grant: { grantId: string };
		};
		const other = new ScriptedTab(ctx.r.wsUrl);
		tabs.push(other);
		await other.connect();
		other.send({ type: "grant.revoke", grantId: added.grant.grantId });
		const error = (await other.next("error")) as unknown as { code: string };
		expect(error.code).toBe("unknown_id");
		expect(
			ctx.r.store.listGrants(ctx.tab.addressId, Date.now()),
		).resolves.toHaveLength(1);
	});

	test("grants.revokeAll ends every grant of the address", async () => {
		const ctx = await setup();
		const a = await tokens(ctx);
		const b = await tokens(ctx);
		ctx.tab.send({ type: "grants.revokeAll" });
		await ctx.tab.next("grant.removed");
		await ctx.tab.next("grant.removed");
		expect(await toolsList(ctx.address, a.access_token)).toBe(401);
		expect(await toolsList(ctx.address, b.access_token)).toBe(401);
	});
});

describe("threat model A7: the /authorize page", () => {
	const open = async (ctx: Ctx, id = clientId, redirect = REDIRECT) => {
		const { challenge } = pkce();
		return ctx.browser.open(
			authorizeUrl(ctx.r.url, {
				client_id: id,
				redirect_uri: redirect,
				code_challenge: challenge,
				resource: ctx.address,
			}),
		);
	};

	test("CSP without scripts, no framing, no referrer, form-action limited to the redirect origin", async () => {
		const ctx = await setup();
		const page = await open(ctx, clientId, "https://app.example/cb");
		const csp = page.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("form-action 'self' https://app.example");
		expect(csp).not.toContain("script-src");
		expect(page.headers.get("x-frame-options")).toBe("DENY");
		expect(page.headers.get("referrer-policy")).toBe("no-referrer");
		expect(page.headers.get("cache-control")).toBe("no-store");
		expect(page.html).not.toContain("<script");
		expect(page.html).toContain('<html lang="en">');
		expect(page.html).toContain('<label for="code">');
		const css = await fetch(`${ctx.r.url}/authorize.css`);
		expect(css.headers.get("content-type")).toStartWith("text/css");
	});

	test("hostile client and app names are escaped", async () => {
		const hostile = `<img src=x onerror=alert(1)>"'&`;
		const id = cimd.serve(
			"/hostile.json",
			cimd.document(`${cimd.origin}/hostile.json`, { client_name: hostile }),
		);
		const ctx = await setup({}, {}, { app: "<b>app</b>" });
		const page = await open(ctx, id);
		expect(page.html).not.toContain("<img");
		expect(page.html).not.toContain("<b>app</b>");
		expect(page.html).toContain(
			"&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;",
		);
		expect(page.html).toContain("&lt;b&gt;app&lt;/b&gt;");
	});

	test("CSRF: a post without our cookie, with a bad token, or from another site is refused", async () => {
		const ctx = await setup();
		const page = await open(ctx);
		const code = await currentCode(ctx);
		const stranger = new TestBrowser(ctx.r.url); // no cookie
		expect(
			(await stranger.submit(page, { action: "connect", code })).status,
		).toBe(403);
		expect(
			(
				await ctx.browser.submit(
					{ ...page, csrf: "x" },
					{ action: "connect", code },
				)
			).status,
		).toBe(403);
		expect(
			(
				await ctx.browser.submit(
					page,
					{ action: "connect", code },
					{ origin: "https://evil.example" },
				)
			).status,
		).toBe(403);
		expect(
			(
				await ctx.browser.submit(
					page,
					{ action: "connect", code },
					{ "sec-fetch-site": "cross-site" },
				)
			).status,
		).toBe(403);
		// The real form still works.
		expect(
			(await ctx.browser.submit(page, { action: "connect", code })).status,
		).toBe(303);
	});

	test("an unknown or used request id is refused", async () => {
		const ctx = await setup();
		const page = await open(ctx);
		const res = await ctx.browser.submit(
			{ ...page, requestId: "nope" },
			{ action: "connect" },
		);
		expect(res.status).toBe(400);
		expect(res.html).toContain("expired or was already used");
	});
});

describe("the pairing method is replaceable (DEC-042)", () => {
	test("the full flow with a stub method that knows no codes", async () => {
		const stub: PairingMethod = {
			kind: "code",
			render: () =>
				'<p><label><input type="checkbox" name="approve" value="yes"> It is me</label></p>',
			check: (_target, form) =>
				form.get("approve") === "yes"
					? { ok: true }
					: { ok: false, message: "Tick the box.", reason: "stub" },
		};
		const ctx = await setup({}, { pairingMethods: { code: stub } });
		const { verifier, challenge } = pkce();
		const page = await ctx.browser.open(
			authorizeUrl(ctx.r.url, {
				client_id: clientId,
				redirect_uri: REDIRECT,
				code_challenge: challenge,
				resource: ctx.address,
			}),
		);
		expect(page.html).toContain("It is me");
		expect(page.html).not.toContain("one-time-code");
		const refused = await ctx.browser.submit(page, { action: "connect" });
		expect(refused.html).toContain("Tick the box.");
		const ok = await ctx.browser.submit(refused, {
			action: "connect",
			approve: "yes",
		});
		const code = new URL(ok.location ?? "").searchParams.get("code") ?? "";
		const res = await exchange(ctx, {
			code,
			verifier,
			location: new URL(REDIRECT),
		});
		expect(res.status).toBe(200);
	});
});
