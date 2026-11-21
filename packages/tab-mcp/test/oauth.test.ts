/**
 * The authorization server against the specifications it implements, one
 * group per requirement (DEC-031). Section numbers name the rule each test
 * pins. The flow runs with a scripted tab showing pairing codes and a test
 * browser typing them on `/authorize`. The address names the tab's app
 * (`/s/test/mcp`, DEC-196); what is special about that is pinned in
 * fixed-address.test.ts.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { normalizeCode, type PairingMethod } from "../src/oauth/pairing.ts";
import type { CreateRelayOptions, RelayTestHooks } from "../src/relay.ts";
import {
	APP,
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

/** The link of the invalid-request page, as the URL it leads to. */
function errorLink(html: string): URL {
	return errorLinkNamed(html, "Go back to");
}

function errorLinkNamed(html: string, label: string): URL {
	const href = new RegExp(`href="([^"]+)">${label}`).exec(html)?.[1];
	if (href === undefined) throw new Error(`no link "${label}"`);
	return new URL(href.replaceAll("&amp;", "&").replaceAll("&#39;", "'"));
}

async function toolsList(address: string, token: string): Promise<number> {
	return (await mcpPost(address, rpc(1, "tools/list"), { token })).status;
}

/** A well-formed code that is not `code`. */
const wrongFor = (code: string) =>
	normalizeCode(code) === "BBBBBBBB" ? "CCCC-CCCC" : "BBBB-BBBB";

/** The one text for a wrong and for an expired code. */
const WRONG_TEXT = "That code is not right, or it has expired.";
const MALFORMED_TEXT = "Type the 8 letters of the code.";
const LIMITED_TEXT = "Too many wrong codes from your network.";

/** The elements of a page with their attributes as written (not decoded). */
function elements(
	html: string,
	selector = "*",
): { tag: string; attributes: Record<string, string> }[] {
	const out: { tag: string; attributes: Record<string, string> }[] = [];
	new HTMLRewriter()
		.on(selector, {
			element(el) {
				out.push({
					tag: el.tagName,
					attributes: Object.fromEntries(el.attributes),
				});
			},
		})
		.transform(html);
	return out;
}

describe("RFC 9728: protected resource metadata", () => {
	test("§5.1: the 401 names the metadata URL; the metadata names the address and the relay (§3.2)", async () => {
		const { r, address } = await setup();
		expect(address).toBe(`${r.url}/s/${APP}/mcp`);
		const res = await mcpPost(address, rpc(1, "tools/list"));
		expect(res.status).toBe(401);
		const challenge = res.headers.get("www-authenticate") ?? "";
		const url = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
		expect(url).toBe(
			`${r.url}/.well-known/oauth-protected-resource/s/${APP}/mcp`,
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

	test("an address that names no app has no metadata; nor has the address of one tab (/a/, gone)", async () => {
		const { r, tab } = await setup();
		for (const path of [
			"/s/-x/mcp",
			"/s/x-/mcp",
			"/s/Test/mcp",
			"/s/te_st/mcp",
			"/s/te%20st/mcp",
			`/s/${"a".repeat(33)}/mcp`,
			"/s/test",
			"/s/test/mcp/x",
			"/a/x/mcp",
			`/a/${tab.addressId}/mcp`,
		]) {
			const res = await fetch(
				`${r.url}/.well-known/oauth-protected-resource${path}`,
			);
			expect(res.status).toBe(404);
		}
	});

	test("an app's metadata is the same whether a page of it is connected or not", async () => {
		const { r } = await setup();
		const of = async (app: string) => {
			const res = await fetch(
				`${r.url}/.well-known/oauth-protected-resource/s/${app}/mcp`,
			);
			expect(res.status).toBe(200);
			return (await res.json()) as Record<string, unknown>;
		};
		const nobody = await of("nobody-here");
		expect(nobody).toEqual({
			...(await of(APP)),
			resource: `${r.url}/s/nobody-here/mcp`,
		});
		// The longest app id.
		const longest = "a".repeat(32);
		expect((await of(longest))["resource"]).toBe(`${r.url}/s/${longest}/mcp`);
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
		// claude.ai uses CIMD only with both of these (AI app support research);
		// private_key_jwt for ChatGPT, asymmetric algorithms only (DEC-106).
		expect(m["token_endpoint_auth_methods_supported"]).toEqual([
			"none",
			"private_key_jwt",
		]);
		const algs = m["token_endpoint_auth_signing_alg_values_supported"];
		expect(algs).toContain("RS256");
		expect(algs).not.toContain("none");
		expect(algs).not.toContain("HS256");
		expect(m["revocation_endpoint_auth_methods_supported"]).toEqual([
			"none",
			"private_key_jwt",
		]);
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
		// RFC 9700 §4.11.2 (review finding 5): no automatic redirect to a
		// self-published client; a page names the destination and links to it.
		expect(page.status).toBe(400);
		expect(page.location).toBeUndefined();
		expect(page.html).toContain("Go back to 127.0.0.1:4567");
		const location = errorLink(page.html);
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

	test("RFC 8707 §2: a missing resource or one that is not an app's address here → invalid_target", async () => {
		await redirected({ resource: undefined }, "invalid_target");
		const ctx = await setup();
		const { challenge } = pkce();
		for (const resource of [
			"https://other.example/s/test/mcp",
			ctx.r.url,
			`${ctx.r.url}/`,
			`${ctx.r.url}/s/test`,
			`${ctx.r.url}/s/test/mcp/`,
			`${ctx.r.url}/s/test/mcp?x=1`,
			`${ctx.r.url}/s/test/mcp#x`,
			`${ctx.r.url}/s//mcp`,
			`${ctx.r.url}/s/Test/mcp`,
			`${ctx.r.url}/s/-test/mcp`,
			`${ctx.r.url}/s/test-/mcp`,
			`${ctx.r.url}/s/te%73t/mcp`,
			`${ctx.r.url}/s/a/b/mcp`,
			`${ctx.r.url}/s/../s/test/mcp`,
			`${ctx.r.url}/s/${"a".repeat(33)}/mcp`,
			`${ctx.r.url.replace("127.0.0.1", "localhost")}/s/test/mcp`,
			// The address of one tab, as it was before DEC-196.
			`${ctx.r.url}/a/${ctx.tab.addressId}/mcp`,
			`${ctx.r.url}/s/${ctx.tab.addressId}/mcp`,
		]) {
			const page = await ctx.browser.open(
				authorizeUrl(ctx.r.url, {
					client_id: clientId,
					redirect_uri: REDIRECT,
					code_challenge: challenge,
					resource,
				}),
			);
			expect(page.status).toBe(400);
			expect(page.requestId).toBeUndefined();
			expect(errorLink(page.html).searchParams.get("error")).toBe(
				"invalid_target",
			);
		}
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
		expect(page.status).toBe(400);
		expect(errorLink(page.html).searchParams.get("error")).toBe(
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

describe("pairing with the code shown in the tab (DEC-028, DEC-196)", () => {
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

	test("the page names the client, its verified host and the app of the address; nothing the page says about itself", async () => {
		const ctx = await setup({}, {}, { app: "saturnus" });
		const page = await open(ctx);
		const host = new URL(clientId).host;
		expect(page.html).toContain(
			`<p>You're connecting <strong>Test AI</strong> (${host}) to <strong>${APP}</strong>: to the page or browser extension in this browser that shows the code.</p>`,
		);
		expect(page.html).toContain('autocomplete="off"');
		// The relay does not know which page is meant before the code: neither
		// the page's name for itself nor its origin is shown.
		expect(page.html).not.toContain("saturnus");
		expect(page.html).not.toContain("page.example");
	});

	test("a site's configured name and an extension's origin are not shown either", async () => {
		const ext = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
		const ctx = await setup(
			{ allowedOrigins: [], sites: [{ origin: ext, name: "Overmark" }] },
			{},
			{ origin: ext },
		);
		const page = await open(ctx);
		expect(page.status).toBe(200);
		expect(page.html).toContain(`to <strong>${APP}</strong>:`);
		expect(page.html).not.toContain("Overmark");
		expect(page.html).not.toContain("abcdefghijklmnop");
		// The page names "the page or browser extension" in general, never its origin.
		expect(page.html).not.toContain("chrome-extension");
	});

	test("the code is typed as shown, in lower case, without the dash or with spaces", async () => {
		const ctx = await setup();
		const typed: ((shown: string) => string)[] = [
			(shown) => shown,
			(shown) => shown.toLowerCase(),
			(shown) => shown.replace("-", ""),
			(shown) => ` ${shown.toLowerCase().replace("-", " ")} `,
		];
		for (const as of typed) {
			const page = await open(ctx);
			const code = await currentCode(ctx);
			expect(code).toMatch(
				/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
			);
			const done = await ctx.browser.submit(page, {
				action: "connect",
				code: as(code),
			});
			ctx.usedCodes.add(code);
			expect(done.status).toBe(303);
		}
	});

	test("a wrong code fails with one text and no count of tries; the right one still works", async () => {
		const ctx = await setup();
		const page = await open(ctx);
		const code = await currentCode(ctx);
		const res = await ctx.browser.submit(page, {
			action: "connect",
			code: wrongFor(code),
		});
		expect(res.status).toBe(400);
		expect(res.html).toContain(
			`<p class="error" role="alert" id="error">${WRONG_TEXT} Type the code that “Connect your AI app” shows now.</p>`,
		);
		expect(res.html).not.toMatch(/tr(y|ies) (is|are) left/);
		expect(ctx.r.logs.events("oauth.pairing_failed").at(-1)).toMatchObject({
			app: APP,
			reason: "wrong",
		});
		const ok = await ctx.browser.submit(res, { action: "connect", code });
		expect(ok.status).toBe(303);
	});

	test("the tab hears why each code comes: start, used after the right code; wrong codes send it nothing", async () => {
		const ctx = await setup();
		const reason = async () =>
			((await ctx.tab.next("pairing.code")) as { reason?: string }).reason;
		const code = await currentCode(ctx);
		// A second pairing.start repeats the current code, as "start".
		ctx.tab.send({ type: "pairing.start" });
		expect(await reason()).toBe("start");
		expect(ctx.tab.pairingCode).toBe(code);
		const ok = await ctx.browser.submit(await open(ctx), {
			action: "connect",
			code,
		});
		expect(ok.status).toBe(303);
		expect(await reason()).toBe("used");
		const next = await ctx.tab.nextCode(code);
		let page = await open(ctx);
		for (let i = 0; i < 5; i++) {
			page = await ctx.browser.submit(page, {
				action: "connect",
				code: wrongFor(next),
			});
			expect(page.status).toBe(400);
		}
		await Bun.sleep(30);
		expect(ctx.tab.received.some((m) => m.type === "pairing.code")).toBe(false);
		expect(ctx.tab.pairingCode).toBe(next);
	});

	test("wrong codes never replace the code a page shows: no tries are counted against it", async () => {
		const ctx = await setup();
		let page = await open(ctx);
		const code = await currentCode(ctx);
		for (let i = 0; i < 9; i++) {
			page = await ctx.browser.submit(page, {
				action: "connect",
				code: wrongFor(code),
			});
			expect(page.status).toBe(400);
			expect(page.html).toContain(WRONG_TEXT);
		}
		expect(ctx.tab.pairingCode).toBe(code);
		const ok = await ctx.browser.submit(page, { action: "connect", code });
		expect(ok.status).toBe(303);
	});

	test("an expired code fails like a wrong one; a fresh code arrives by itself, as expired", async () => {
		const ctx = await setup({}, { pairingCodeTtlMs: 150 });
		const page = await open(ctx);
		const code = await currentCode(ctx);
		const fresh = await ctx.tab.nextCode(code); // after 150 ms
		expect(
			((await ctx.tab.next("pairing.code")) as { reason?: string }).reason,
		).toBe("expired");
		const res = await ctx.browser.submit(page, { action: "connect", code });
		expect(res.status).toBe(400);
		expect(res.html).toContain(WRONG_TEXT);
		expect(ctx.r.logs.events("oauth.pairing_failed").at(-1)?.["reason"]).toBe(
			"wrong",
		);
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
		expect(again.html).toContain(WRONG_TEXT);
		const next = await ctx.tab.nextCode(code);
		expect(next).not.toBe(code);
		expect(
			(await ctx.browser.submit(again, { action: "connect", code: next }))
				.status,
		).toBe(303);
	});

	test("pairing.stop ends the code: it is wrong from then on, and the page says nothing else", async () => {
		const ctx = await setup();
		const code = await currentCode(ctx);
		const page = await open(ctx);
		ctx.tab.send({ type: "pairing.stop" });
		await Bun.sleep(20);
		const res = await ctx.browser.submit(page, { action: "connect", code });
		expect(res.status).toBe(400);
		expect(res.html).toContain(WRONG_TEXT);
		// A new request gets the form as ever (DEC-196): the relay does not
		// say that the dialog is closed.
		const closed = await open(ctx);
		expect(closed.status).toBe(200);
		expect(closed.requestId).toBeDefined();
		// The dialog opened again: a new code; the old one stays dead.
		ctx.tab.send({ type: "pairing.start" });
		const fresh = await ctx.tab.nextCode(code);
		const old = await ctx.browser.submit(closed, { action: "connect", code });
		expect(old.status).toBe(400);
		const ok = await ctx.browser.submit(old, {
			action: "connect",
			code: fresh,
		});
		expect(ok.status).toBe(303);
	});

	test("a page that goes away takes its code with it", async () => {
		const ctx = await setup();
		const code = await currentCode(ctx);
		const page = await open(ctx);
		ctx.tab.close();
		await waitFor(() => ctx.r.relay.sessionCount === 0, "the tab to close");
		const res = await ctx.browser.submit(page, { action: "connect", code });
		expect(res.status).toBe(400);
		expect(res.html).toContain(WRONG_TEXT);
	});

	test("malformed input is told apart and is no guess: the network keeps its 10", async () => {
		const ctx = await setup();
		let page = await open(ctx);
		const code = await currentCode(ctx);
		for (const typed of [
			"",
			"12ab",
			"12345678",
			code.slice(0, 8), // 7 letters
			`${code}B`,
			"AEIOUYAE",
		]) {
			page = await ctx.browser.submit(page, { action: "connect", code: typed });
			expect(page.status).toBe(400);
			expect(page.html).toContain(MALFORMED_TEXT);
			expect(page.html).not.toContain(WRONG_TEXT);
		}
		expect(
			ctx.r.logs.events("oauth.pairing_failed").map((e) => e["reason"]),
		).toEqual(new Array(6).fill("malformed"));
		// Ten real guesses are still judged; the eleventh is not.
		for (let i = 0; i < 10; i++) {
			page = await ctx.browser.submit(page, {
				action: "connect",
				code: wrongFor(code),
			});
			expect(page.status).toBe(400);
			expect(page.html).toContain(WRONG_TEXT);
		}
		page = await ctx.browser.submit(page, {
			action: "connect",
			code: wrongFor(code),
		});
		expect(page.status).toBe(429);
	});

	test("after 10 wrong codes a network's next one is refused without being judged, a right one too (threat model A1)", async () => {
		const ctx = await setup();
		let page = await open(ctx);
		const code = await currentCode(ctx);
		const statuses: number[] = [];
		for (let i = 0; i < 12; i++) {
			page = await ctx.browser.submit(page, {
				action: "connect",
				code: wrongFor(code),
			});
			statuses.push(page.status);
		}
		expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
		expect(statuses.slice(10)).toEqual([429, 429]);
		expect(page.html).toContain(
			`${LIMITED_TEXT} Wait a few minutes and try again.`,
		);
		// The right code is not looked at: it is refused, and not used up.
		const right = await ctx.browser.submit(page, { action: "connect", code });
		expect(right.status).toBe(429);
		expect(right.html).toContain(LIMITED_TEXT);
		await Bun.sleep(20);
		expect(ctx.tab.pairingCode).toBe(code);
		expect(
			ctx.r.logs.events("oauth.pairing_failed").map((e) => e["reason"]),
		).toEqual([
			...new Array(10).fill("wrong"),
			"rate_limited",
			"rate_limited",
			"rate_limited",
		]);
		expect(ctx.r.logs.events("oauth.paired")).toHaveLength(0);
		// One warning for the episode.
		expect(ctx.r.logs.events("oauth.rate_limited")).toEqual([
			expect.objectContaining({ limit: "code_guesses", ip: "127.0.0.0/24" }),
		]);
	});

	test("a right code costs nothing: after 5 of them the network still has its 10 guesses", async () => {
		const ctx = await setup();
		for (let i = 0; i < 5; i++) await authorize(ctx);
		let page = await open(ctx);
		const code = await currentCode(ctx);
		for (let i = 0; i < 10; i++) {
			page = await ctx.browser.submit(page, {
				action: "connect",
				code: wrongFor(code),
			});
			expect(page.status).toBe(400);
		}
		page = await ctx.browser.submit(page, {
			action: "connect",
			code: wrongFor(code),
		});
		expect(page.status).toBe(429);
	});

	test("codes are never logged, nor what was typed", async () => {
		const ctx = await setup();
		await tokens(ctx);
		const page = await open(ctx);
		const code = await currentCode(ctx);
		await ctx.browser.submit(page, { action: "connect", code: "XZXZ-XZXZ" });
		await ctx.browser.submit(page, { action: "connect", code: "not-a-code" });
		const all = ctx.r.logs.lines.join("\n");
		for (const shown of [...ctx.usedCodes, code]) {
			expect(shown).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
			expect(all).not.toContain(shown);
			expect(all).not.toContain(shown.replace("-", ""));
			expect(all.toUpperCase()).not.toContain(shown.replace("-", ""));
		}
		expect(all.toUpperCase()).not.toContain("XZXZ-XZXZ");
		expect(all.toUpperCase()).not.toContain("XZXZXZXZ");
		expect(all).not.toContain("not-a-code");
		expect(all).toContain('"event":"oauth.paired"');
		expect(all).toContain('"event":"oauth.pairing_failed"');
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
		const other = ctx.r.relay.addressFor("other");
		expect(other).toBe(`${ctx.r.url}/s/other/mcp`);
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

	test("RFC 8707: an access token works only at its own app's address (audience)", async () => {
		const ctx = await setup();
		const body = await tokens(ctx);
		const otherTab = new ScriptedTab(ctx.r.wsUrl, { appId: "other" });
		tabs.push(otherTab);
		const other = await otherTab.connect();
		expect(other.address).toBe(`${ctx.r.url}/s/other/mcp`);
		const refused = await mcpPost(other.address, rpc(1, "tools/list"), {
			token: body.access_token,
		});
		expect(refused.status).toBe(401);
		// The challenge is the address's own, whatever the token was for.
		expect(refused.headers.get("www-authenticate")).toBe(
			`Bearer resource_metadata="${ctx.r.url}/.well-known/oauth-protected-resource/s/other/mcp", scope="tools", error="invalid_token"`,
		);
		// Nor at the address of an app nobody serves.
		expect(
			await toolsList(ctx.r.relay.addressFor("nobody"), body.access_token),
		).toBe(401);
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

	test("another client, another app's address, a wider scope, an expired token: refused", async () => {
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
						resource: ctx.r.relay.addressFor("other"),
					}),
				)
			).error,
		).toBe("invalid_target");
		// The address of one tab, as it was before DEC-196, is no resource.
		expect(
			(
				await oauthError(
					await refresh(ctx, t.refresh_token, {
						resource: `${ctx.r.url}/a/${ctx.tab.addressId}/mcp`,
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
		// It names the message it answers (since 0.10.2), so that a page with
		// several revocations pending settles the right one.
		expect(error).toMatchObject({
			code: "unknown_id",
			for: "grant.revoke",
			grantId: added.grant.grantId,
		});
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
		// same-origin, not no-referrer: with no-referrer browsers post `Origin: null`.
		expect(page.headers.get("referrer-policy")).toBe("same-origin");
		expect(page.headers.get("cache-control")).toBe("no-store");
		expect(page.html).not.toContain("<script");
		expect(page.html).toContain('<html lang="en">');
		expect(page.html).toContain('<label for="code">');
		const css = await fetch(`${ctx.r.url}/authorize.css`);
		expect(css.headers.get("content-type")).toStartWith("text/css");
	});

	test("a hostile client name is escaped, in the text and in the form's attributes; a page's name for itself is not shown at all", async () => {
		const hostile = `<img src=x onerror=alert(1)>"'&`;
		const escaped = "&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;";
		const id = cimd.serve(
			"/hostile.json",
			cimd.document(`${cimd.origin}/hostile.json`, { client_name: hostile }),
		);
		const breakout = `x" onfocus="alert(1)" data-app="bank`;
		const breakoutId = cimd.serve(
			"/breakout.json",
			cimd.document(`${cimd.origin}/breakout.json`, { client_name: breakout }),
		);
		const ctx = await setup({}, {}, { app: "<b>app</b>" });
		const host = new URL(clientId).host;
		const page = await open(ctx, id);
		expect(page.status).toBe(200);
		expect(page.html).not.toContain("<img");
		expect(page.html).toContain(`<strong>${escaped}</strong> (${host})`);
		expect(page.html).toContain(`<h1>Connect ${escaped} from ${host}</h1>`);
		expect(page.html).toContain(
			`<title>Connect ${escaped} from ${host}</title>`,
		);
		// As a browser reads the tags: no element of the name's making, and the
		// form has its own attributes only.
		expect(elements(page.html, "img, script, b")).toEqual([]);
		expect(elements(page.html, "form")).toEqual([
			{
				tag: "form",
				attributes: {
					method: "post",
					action: "/authorize",
					"data-tab-mcp-pairing": "1",
					"data-app": APP,
					"data-client-name": escaped,
					"data-client-host": host,
				},
			},
		]);
		// The page's own name is nowhere, escaped or not.
		expect(page.html).not.toContain("<b>app</b>");
		expect(page.html).not.toContain("&lt;b&gt;app");

		// A name that tries to close the attribute and add its own.
		const second = await open(ctx, breakoutId);
		expect(second.status).toBe(200);
		expect(elements(second.html, "form")).toEqual([
			{
				tag: "form",
				attributes: {
					method: "post",
					action: "/authorize",
					"data-tab-mcp-pairing": "1",
					"data-app": APP,
					"data-client-name": breakout.replaceAll('"', "&quot;"),
					"data-client-host": host,
				},
			},
		]);
		expect(elements(second.html, "[onfocus]")).toEqual([]);
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

	test("a paired request's form sent again gets the expired-or-used page; the first code still works (DEC-178)", async () => {
		const ctx = await setup();
		const { verifier, challenge } = pkce();
		const page = await ctx.browser.open(
			authorizeUrl(ctx.r.url, {
				client_id: clientId,
				redirect_uri: REDIRECT,
				code_challenge: challenge,
				resource: ctx.address,
			}),
		);
		const code = await currentCode(ctx);
		const first = await ctx.browser.submit(page, { action: "connect", code });
		expect(first.status).toBe(303);
		// A double click, before and after the app took its code.
		const sent = await ctx.browser.submit(page, { action: "connect", code });
		expect(sent.status).toBe(400);
		expect(sent.html).toContain("expired or was already used");
		const location = new URL(first.location ?? "");
		const tokens = await exchange(ctx, {
			code: location.searchParams.get("code") ?? "",
			verifier,
			location,
		});
		expect(tokens.status).toBe(200);
		const again = await ctx.browser.submit(page, { action: "connect", code });
		expect(again.status).toBe(400);
		expect(again.html).toContain("expired or was already used");
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
		// The method names the page; this one knows it from outside the relay.
		let addressId = "";
		const stub: PairingMethod = {
			kind: "code",
			render: () =>
				'<p><label><input type="checkbox" name="approve" value="yes"> It is me</label></p>',
			check: (_pool, form) =>
				form.get("approve") === "yes"
					? { ok: true, addressId }
					: { ok: false, message: "Tick the box.", reason: "stub" },
		};
		const ctx = await setup({}, { pairingMethods: { code: stub } });
		addressId = ctx.tab.addressId;
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
		expect(page.html).not.toContain('name="code"');
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
		// The grant is for the page the method named.
		const body = (await res.json()) as TokenBody;
		expect(await toolsList(ctx.address, body.access_token)).toBe(200);
		expect(
			await ctx.r.store.listGrants(ctx.tab.addressId, Date.now()),
		).toHaveLength(1);
		// The method never asked for a guess: nothing was charged or logged as one.
		expect(ctx.r.logs.events("oauth.rate_limited")).toHaveLength(0);
	});
});
