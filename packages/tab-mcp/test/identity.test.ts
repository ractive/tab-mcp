/**
 * Identity binding end to end in the relay (iteration 7, DEC-075 to DEC-079):
 * a scripted tab proves its user with a tab assertion, the AI app's browser
 * signs in at a local OIDC provider, and the relay pairs only the same person.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { resolveConfig } from "../src/config.ts";
import { identityKey, MISMATCH_TEXT } from "../src/identity.ts";
import { JwksCache, type KeySource } from "../src/jwt.ts";
import type { CreateRelayOptions, RelayTestHooks } from "../src/relay.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import type { RevokeOptions, RevokeSelector } from "../src/store/types.ts";
import { issueAccessToken } from "../src/tokens.ts";
import { mcpPost, rpc, ScriptedTab, waitFor } from "./helpers.ts";
import {
	type CimdServer,
	type OAuthTestRelay,
	pkce,
	postForm,
	startCimdServer,
	startOAuthRelay,
	TestBrowser,
} from "./oauth-helpers.ts";
import { type OidcProvider, startOidcProvider } from "./oidc-fixture.ts";

let cimd: CimdServer;
let clientId: string;
let provider: OidcProvider;
let current: OAuthTestRelay | undefined;
const tabs: ScriptedTab[] = [];
const REDIRECT = "http://127.0.0.1:4567/callback";

beforeAll(async () => {
	cimd = await startCimdServer();
	clientId = cimd.serve(
		"/client.json",
		cimd.document(`${cimd.origin}/client.json`),
	);
	provider = await startOidcProvider();
});
afterAll(async () => {
	await cimd.stop();
	await provider.stop();
});
afterEach(async () => {
	for (const t of tabs.splice(0)) if (t.ws.readyState <= 1) t.close();
	await current?.stop();
	current = undefined;
	provider.signedInAs = undefined;
	provider.tamper = undefined;
});

interface Ctx {
	r: OAuthTestRelay;
	tab: ScriptedTab;
	address: string;
	browser: TestBrowser;
}

async function relay(
	options: CreateRelayOptions = {},
	hooks: RelayTestHooks = {},
): Promise<OAuthTestRelay> {
	const r = startOAuthRelay(
		cimd,
		{
			identity: "oidc",
			oidc: provider.relayConfig(),
			...options,
		},
		hooks,
	);
	current = r;
	return r;
}

async function newTab(
	r: OAuthTestRelay,
	secret?: string,
): Promise<ScriptedTab> {
	const tab = new ScriptedTab(r.wsUrl, secret === undefined ? {} : { secret });
	tabs.push(tab);
	await tab.connect();
	return tab;
}

/** The page proves who its user is. */
async function signInTab(tab: ScriptedTab, sub: string): Promise<void> {
	tab.send({
		type: "identity",
		assertion: await provider.assertion(sub, tab.session?.address ?? ""),
	});
	await tab.next("identity.bound");
}

async function setup(
	options: CreateRelayOptions = {},
	user: string | null = "alice",
	hooks: RelayTestHooks = {},
): Promise<Ctx> {
	const r = await relay(options, hooks);
	const tab = await newTab(r);
	if (user !== null) await signInTab(tab, user);
	tab.send({ type: "pairing.start" });
	return {
		r,
		tab,
		address: tab.session?.address ?? "",
		browser: new TestBrowser(r.url),
	};
}

interface Flow {
	verifier: string;
	page: Awaited<ReturnType<TestBrowser["open"]>>;
}

async function openAuthorize(ctx: Ctx): Promise<Flow> {
	const { verifier, challenge } = pkce();
	const url = new URL(`${ctx.r.url}/authorize`);
	for (const [k, v] of Object.entries({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: "st-1",
		resource: ctx.address,
		scope: "tools",
	})) {
		url.searchParams.set(k, v);
	}
	const page = await ctx.browser.open(url.href);
	return { verifier, page };
}

/** Connect → provider → callback; returns the callback's answer. */
async function connectThroughProvider(ctx: Ctx, flow: Flow) {
	const posted = await ctx.browser.submit(flow.page, { action: "connect" });
	expect(posted.status).toBe(303);
	const toProvider = posted.location ?? "";
	expect(toProvider.startsWith(provider.issuer)).toBe(true);
	const back = await provider.signIn(toProvider);
	expect(back.startsWith(`${ctx.r.url}/authorize/callback`)).toBe(true);
	return ctx.browser.open(back);
}

async function tokenFrom(ctx: Ctx, location: string, verifier: string) {
	const code = new URL(location).searchParams.get("code") ?? "";
	const res = await postForm(`${ctx.r.url}/token`, {
		grant_type: "authorization_code",
		code,
		redirect_uri: REDIRECT,
		code_verifier: verifier,
		client_id: clientId,
		resource: ctx.address,
	});
	expect(res.status).toBe(200);
	return (await res.json()) as { access_token: string; refresh_token: string };
}

async function pairedToken(ctx: Ctx): Promise<string> {
	provider.signedInAs = "alice";
	const flow = await openAuthorize(ctx);
	const done = await connectThroughProvider(ctx, flow);
	expect(done.status).toBe(303);
	return (await tokenFrom(ctx, done.location ?? "", flow.verifier))
		.access_token;
}

const add = () =>
	rpc(1, "tools/call", { name: "add", arguments: { a: 1, b: 2 } });

describe("identity binding: the same person connects without a code", () => {
	test("session says oidc; the page shows no code; a match pairs; the grant carries the subject; tools work", async () => {
		const ctx = await setup();
		expect(ctx.tab.session?.pairing).toBe("oidc");
		expect(ctx.tab.pairingCode).toBeUndefined();
		provider.signedInAs = "alice";
		const flow = await openAuthorize(ctx);
		expect(flow.page.status).toBe(200);
		expect(flow.page.html).toContain("No code is needed");
		expect(flow.page.html).not.toContain("one-time-code");
		// The redirect after the post goes to the provider: CSP allows it.
		expect(flow.page.headers.get("content-security-policy")).toContain(
			provider.issuer,
		);

		const done = await connectThroughProvider(ctx, flow);
		expect(done.status).toBe(303);
		const back = new URL(done.location ?? "");
		expect(back.origin + back.pathname).toBe(REDIRECT);
		expect(back.searchParams.get("state")).toBe("st-1");
		expect(back.searchParams.get("iss")).toBe(ctx.r.url);

		const tokens = await tokenFrom(ctx, done.location ?? "", flow.verifier);
		const grants = await ctx.r.store.listGrants(ctx.tab.addressId, Date.now());
		expect(grants).toHaveLength(1);
		expect(grants[0]?.subject).toBe(identityKey(provider.issuer, "alice"));
		const res = await mcpPost(ctx.address, add(), {
			token: tokens.access_token,
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('"text":"3"');

		// The provider got a proper OIDC request.
		const q = provider.authorizeRequests.at(-1);
		expect(q?.get("scope")).toBe("openid");
		expect(q?.get("code_challenge_method")).toBe("S256");
		expect(q?.get("nonce")?.length).toBeGreaterThan(20);
		expect(q?.get("redirect_uri")).toBe(`${ctx.r.url}/authorize/callback`);
		expect(q?.has("prompt")).toBe(false);
		// Refreshes keep the subject.
		const refreshed = await postForm(`${ctx.r.url}/token`, {
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
			client_id: clientId,
		});
		const body = (await refreshed.json()) as { access_token: string };
		const again = await mcpPost(ctx.address, add(), {
			token: body.access_token,
		});
		expect(await again.text()).toContain('"text":"3"');
	});
});

describe("identity binding: someone else gets the mismatch error", () => {
	test("another person at the provider is refused at /authorize; Try again asks for the account", async () => {
		const ctx = await setup();
		provider.signedInAs = "bob";
		const flow = await openAuthorize(ctx);
		const done = await connectThroughProvider(ctx, flow);
		expect(done.status).toBe(403);
		expect(done.location).toBeUndefined();
		expect(done.html).toContain(MISMATCH_TEXT);
		expect(await ctx.r.store.listGrants(ctx.tab.addressId, Date.now())).toEqual(
			[],
		);
		expect(ctx.r.logs.events("oauth.pairing_failed").at(-1)?.["reason"]).toBe(
			"mismatch",
		);
		// The page still offers Connect; this time the provider is asked to log in again.
		const retried = await ctx.browser.submit(done, { action: "connect" });
		expect(retried.status).toBe(303);
		expect(new URL(retried.location ?? "").searchParams.get("prompt")).toBe(
			"login",
		);
		provider.signedInAs = "alice";
		const back = await provider.signIn(retried.location ?? "");
		const ok = await ctx.browser.open(back);
		expect(ok.status).toBe(303);
		expect(new URL(ok.location ?? "").searchParams.get("code")).not.toBeNull();
	});

	test("the MCP endpoint refuses a grant of another person with the mismatch text", async () => {
		const ctx = await setup();
		const { token } = await issueAccessToken(
			ctx.r.store,
			{
				addressId: ctx.tab.addressId,
				clientId,
				clientName: "Test AI",
				subject: identityKey(provider.issuer, "bob"),
			},
			{ ttlMs: 60_000 },
		);
		const res = await mcpPost(ctx.address, add(), { token });
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain(
			'error="invalid_token"',
		);
		const body = (await res.json()) as { error_description: string };
		expect(body.error_description).toBe(MISMATCH_TEXT);
	});

	test("a code-made grant (no subject) does not work on an oidc site", async () => {
		const ctx = await setup();
		const { token } = await issueAccessToken(
			ctx.r.store,
			{ addressId: ctx.tab.addressId, clientId, clientName: "Test AI" },
			{ ttlMs: 60_000 },
		);
		const res = await mcpPost(ctx.address, add(), { token });
		expect(res.status).toBe(401);
	});

	test("a page that proves another user revokes the old user's grants at once", async () => {
		const ctx = await setup();
		const token = await pairedToken(ctx);
		await signInTab(ctx.tab, "bob");
		const removed = await ctx.tab.next("grant.removed");
		expect(removed.type).toBe("grant.removed");
		const res = await mcpPost(ctx.address, add(), { token });
		expect(res.status).toBe(401);
		expect(ctx.r.logs.events("identity.bound").at(-1)?.["revoked"]).toBe(1);
	});

	test("the ID token is checked: wrong nonce, audience, issuer or an expired token pair nobody", async () => {
		const ctx = await setup();
		const tampers: [
			string,
			(c: Record<string, unknown>) => Record<string, unknown>,
		][] = [
			["id_token_nonce", (c) => ({ ...c, nonce: "other" })],
			["id_token_aud", (c) => ({ ...c, aud: "someone-else" })],
			["id_token_iss", (c) => ({ ...c, iss: "https://evil.example" })],
			[
				"id_token_exp",
				(c) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 60 }),
			],
			[
				"id_token_azp",
				(c) => ({ ...c, aud: [provider.clientId, "x"], azp: "x" }),
			],
		];
		provider.signedInAs = "alice";
		for (const [reason, tamper] of tampers) {
			provider.tamper = tamper;
			const flow = await openAuthorize(ctx);
			const done = await connectThroughProvider(ctx, flow);
			expect(done.status).toBe(400);
			expect(done.location).toBeUndefined();
			expect(ctx.r.logs.events("oidc.sign_in_failed").at(-1)?.["reason"]).toBe(
				reason,
			);
		}
	});

	test("a callback from another browser, a replayed state or a provider error issue nothing", async () => {
		const ctx = await setup();
		provider.signedInAs = "alice";
		const flow = await openAuthorize(ctx);
		const posted = await ctx.browser.submit(flow.page, { action: "connect" });
		const back = await provider.signIn(posted.location ?? "");
		// Another browser (an attacker who sends the link to a victim).
		const other = new TestBrowser(ctx.r.url);
		const foreign = await other.open(back);
		expect(foreign.status).toBe(403);
		// The state was not burnt by the foreign browser (no cookie): the owner can still finish.
		const ok = await ctx.browser.open(back);
		expect(ok.status).toBe(303);
		const replay = await ctx.browser.open(back);
		expect(replay.status).toBe(400);
		expect(replay.html).toContain("expired or was already used");

		provider.signedInAs = undefined; // the provider answers login_required
		const flow2 = await openAuthorize(ctx);
		const posted2 = await ctx.browser.submit(flow2.page, { action: "connect" });
		const error = await ctx.browser.open(
			await provider.signIn(posted2.location ?? ""),
		);
		expect(error.status).toBe(400);
		expect(error.location).toBeUndefined();
	});
});

describe("identity binding: the page's state", () => {
	test("Connect needs the dialog open and a signed-in page", async () => {
		const ctx = await setup({}, null);
		const flow = await openAuthorize(ctx);
		expect(flow.page.html).toContain("Nobody is signed in to the page");
		const refused = await ctx.browser.submit(flow.page, { action: "connect" });
		expect(refused.status).toBe(400);
		expect(refused.location).toBeUndefined();
		await signInTab(ctx.tab, "alice");
		ctx.tab.send({ type: "pairing.stop" });
		await Bun.sleep(20);
		const closed = await ctx.browser.submit(refused, { action: "connect" });
		expect(closed.status).toBe(400);
		expect(closed.html).toContain("Connect your AI app");
	});

	test("a page that signs out between Connect and the callback pairs nobody", async () => {
		const ctx = await setup();
		provider.signedInAs = "alice";
		const flow = await openAuthorize(ctx);
		const posted = await ctx.browser.submit(flow.page, { action: "connect" });
		const back = await provider.signIn(posted.location ?? "");
		ctx.tab.send({ type: "identity.logout" });
		await waitFor(
			() => ctx.r.logs.events("identity.signed_out").length > 0,
			"the sign-out",
		);
		const done = await ctx.browser.open(back);
		expect(done.status).toBe(400);
		expect(done.html).toContain("Nobody is signed in to the page any more");
	});

	test("an open page without a signed-in user: requests wait for it, then get the signed-out answer", async () => {
		const ctx = await setup({ pageWaitMs: 300 });
		const token = await pairedToken(ctx);
		ctx.tab.close();
		await ctx.tab.closed;
		const tab = await newTab(ctx.r, ctx.tab.secret);
		const res = await mcpPost(ctx.address, add(), { token });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { isError: boolean; content: { text: string }[] };
		};
		expect(body.result.isError).toBe(true);
		expect(body.result.content[0]?.text).toContain("nobody is signed in to it");
		// A request that arrives first is forwarded once the page proves its user.
		const waiting = mcpPost(ctx.address, add(), { token });
		await Bun.sleep(50);
		await signInTab(tab, "alice");
		const later = await waiting;
		expect(later.status).toBe(200);
		expect(await later.text()).toContain('"text":"3"');
	});

	test("refused assertions: expired, replayed, wrong audience; the session stays and binds nobody", async () => {
		const ctx = await setup({}, null);
		const now = Math.floor(Date.now() / 1000);
		const address = ctx.address;
		const cases: [string, string][] = [
			[
				"expired",
				await provider.assertion("alice", address, { exp: now - 30 }),
			],
			[
				"aud",
				await provider.assertion(
					"alice",
					`${ctx.r.url}/a/${"b".repeat(52)}/mcp`,
				),
			],
			["typ", await provider.assertion("alice", address, {}, { typ: "JWT" })],
		];
		for (const [reason, assertion] of cases) {
			ctx.tab.send({ type: "identity", assertion });
			const err = (await ctx.tab.next("error")) as { code: string };
			expect(err.code).toBe("identity_refused");
			expect(ctx.r.logs.events("identity.refused").at(-1)?.["reason"]).toBe(
				reason,
			);
		}
		const once = await provider.assertion("alice", address);
		ctx.tab.send({ type: "identity", assertion: once, round: 41 });
		// Every answer echoes the round it answers (review of PR #13).
		const bound = (await ctx.tab.next("identity.bound")) as { round?: number };
		expect(bound.round).toBe(41);
		ctx.tab.send({ type: "identity", assertion: once, round: 42 });
		const replay = (await ctx.tab.next("error")) as {
			code: string;
			round?: number;
		};
		expect(replay.code).toBe("identity_refused");
		expect(replay.round).toBe(42);
		expect(ctx.r.logs.events("identity.refused").at(-1)?.["reason"]).toBe(
			"replayed",
		);
		// Fail closed: the refused (replayed) assertion ended the binding.
		const flow = await openAuthorize(ctx);
		expect(flow.page.html).toContain("Nobody is signed in to the page");
		expect(ctx.tab.ws.readyState).toBe(WebSocket.OPEN);
	});
});

describe("identity binding: logout", () => {
	test("logout in the page cuts the AI connection at once, also mid-call", async () => {
		const ctx = await setup();
		const token = await pairedToken(ctx);
		const slow = mcpPost(
			ctx.address,
			rpc(2, "tools/call", {
				name: "echo",
				arguments: { text: "x", delayMs: 3000 },
			}),
			{ token },
		);
		await Bun.sleep(100);
		const started = Date.now();
		ctx.tab.send({ type: "identity.logout" });
		const removed = await ctx.tab.next("grant.removed");
		expect(removed.type).toBe("grant.removed");
		const cut = await slow;
		await cut.text();
		expect(Date.now() - started).toBeLessThan(1000);
		const after = await mcpPost(ctx.address, add(), { token });
		expect(after.status).toBe(401);
		expect(await ctx.r.store.listGrants(ctx.tab.addressId, Date.now())).toEqual(
			[],
		);
	});
});

describe("identity binding: configuration (DEC-079)", () => {
	const base = {
		publicUrl: "https://relay.example",
		allowedOrigins: ["https://app.example"],
	};
	const oidc = {
		issuer: "https://login.example",
		clientId: "relay",
		assertionIssuer: "https://app.example",
		assertionJwksUrl: "https://app.example/jwks",
	};

	test("code stays the default; oidc applies to sites without their own pairing", () => {
		expect(resolveConfig(base).identity).toBe("code");
		const c = resolveConfig({
			...base,
			identity: "oidc",
			oidc,
			sites: [{ origin: "https://other.example", pairing: "code" }],
		});
		expect(c.oidc?.subjectClaim).toBe("sub");
	});

	test("missing or bad provider settings stop the relay at start", () => {
		expect(() => resolveConfig({ ...base, identity: "oidc" })).toThrow(
			/TAB_MCP_OIDC_ISSUER/,
		);
		expect(() =>
			resolveConfig({
				...base,
				identity: "oidc",
				oidc: { ...oidc, issuer: "http://login.example" },
			}),
		).toThrow(/https/);
		expect(() =>
			resolveConfig({
				...base,
				identity: "oidc",
				oidc: { ...oidc, clientId: "" },
			}),
		).toThrow(/CLIENT_ID/);
		expect(() =>
			resolveConfig({
				...base,
				identity: "oidc",
				oidc: { ...oidc, subjectClaim: "email" as "sub" },
			}),
		).toThrow(/never email/);
		expect(() =>
			resolveConfig({ ...base, allowedOrigins: "*", identity: "oidc", oidc }),
		).toThrow(/cannot be used with/);
	});

	test("the environment variables", async () => {
		const { configFromEnv } = await import("../src/config.ts");
		const c = configFromEnv({
			TAB_MCP_IDENTITY: "oidc",
			TAB_MCP_OIDC_ISSUER: oidc.issuer,
			TAB_MCP_OIDC_CLIENT_ID: "relay",
			TAB_MCP_OIDC_CLIENT_SECRET: "from-the-environment",
			TAB_MCP_OIDC_SUBJECT_CLAIM: "oid",
			TAB_MCP_TAB_ASSERTION_ISSUER: oidc.assertionIssuer,
			TAB_MCP_TAB_ASSERTION_JWKS_URL: oidc.assertionJwksUrl,
		});
		expect(c.identity).toBe("oidc");
		expect(c.oidc).toEqual({
			...oidc,
			clientSecret: "from-the-environment",
			subjectClaim: "oid",
		});
		expect(() => configFromEnv({ TAB_MCP_IDENTITY: "saml" })).toThrow();
	});

	test("an assertion on a code site is refused", async () => {
		const r = startOAuthRelay(cimd, { oidc: provider.relayConfig() });
		current = r;
		const tab = await newTab(r);
		expect(tab.session?.pairing).toBe("code");
		tab.send({
			type: "identity",
			assertion: await provider.assertion("alice", tab.session?.address ?? ""),
		});
		const err = (await tab.next("error")) as { code: string };
		expect(err.code).toBe("identity_refused");
	});
});

/** The app's keys, answered slowly: an assertion check that takes a while. */
function slowKeys(ms: number): KeySource {
	const cache = new JwksCache(provider.relayConfig().assertionJwksUrl);
	return {
		keys: async (kid) => {
			await Bun.sleep(ms);
			return cache.keys(kid);
		},
	};
}

/** A memory store that can be made to fail. */
class FlakyStore extends MemoryTokenStore {
	failing = false;
	override async listGrants(addressId: string, now: number) {
		if (this.failing) throw new Error("store down");
		return super.listGrants(addressId, now);
	}
	override async revoke(selector: RevokeSelector, options: RevokeOptions) {
		if (this.failing) throw new Error("store down");
		return super.revoke(selector, options);
	}
}

const slowCall = (token: string, address: string) =>
	mcpPost(
		address,
		rpc(2, "tools/call", {
			name: "echo",
			arguments: { text: "x", delayMs: 3000 },
		}),
		{ token },
	);

describe("identity binding: review of PR #13", () => {
	test("an identity still being checked never lands after a later sign-out (identity messages run in order)", async () => {
		const ctx = await setup({}, null, { assertionKeys: slowKeys(150) });
		ctx.tab.send({
			type: "identity",
			assertion: await provider.assertion("alice", ctx.address),
		});
		ctx.tab.send({ type: "identity.logout" });
		await ctx.tab.next("identity.bound");
		await waitFor(
			() => ctx.r.logs.events("identity.signed_out").length > 0,
			"the sign-out",
		);
		const flow = await openAuthorize(ctx);
		expect(flow.page.html).toContain("Nobody is signed in to the page");
	});

	test("an authorization code issued before a sign-out is refused at the token endpoint", async () => {
		const ctx = await setup();
		provider.signedInAs = "alice";
		const flow = await openAuthorize(ctx);
		const done = await connectThroughProvider(ctx, flow);
		expect(done.status).toBe(303);
		ctx.tab.send({ type: "identity.logout" });
		await waitFor(
			() => ctx.r.logs.events("identity.signed_out").length > 0,
			"the sign-out",
		);
		const res = await postForm(`${ctx.r.url}/token`, {
			grant_type: "authorization_code",
			code: new URL(done.location ?? "").searchParams.get("code") ?? "",
			redirect_uri: REDIRECT,
			code_verifier: flow.verifier,
			client_id: clientId,
			resource: ctx.address,
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(
			"invalid_grant",
		);
	});

	test("a refused assertion ends the bound user's requests in flight", async () => {
		const ctx = await setup();
		const token = await pairedToken(ctx);
		const slow = slowCall(token, ctx.address);
		await Bun.sleep(100);
		const started = Date.now();
		const now = Math.floor(Date.now() / 1000);
		ctx.tab.send({
			type: "identity",
			assertion: await provider.assertion("alice", ctx.address, {
				exp: now - 30,
			}),
		});
		await ctx.tab.next("error");
		await (await slow).text();
		expect(Date.now() - started).toBeLessThan(1000);
		// The next person binds with nothing of the previous one still running.
		await signInTab(ctx.tab, "bob");
	});

	test("sign-out ends requests in flight even when the store fails", async () => {
		const store = new FlakyStore();
		const ctx = await setup({ store, pageWaitMs: 0 });
		const token = await pairedToken(ctx);
		const slow = slowCall(token, ctx.address);
		await Bun.sleep(100);
		const started = Date.now();
		store.failing = true;
		ctx.tab.send({ type: "identity.logout" });
		await (await slow).text();
		expect(Date.now() - started).toBeLessThan(1000);
		await waitFor(
			() => ctx.r.logs.events("store.error").some((e) => e["op"] === "signOut"),
			"the logged store error",
		);
		// The grant survived the failed revoke, but the page is bound to nobody.
		store.failing = false;
		const after = await mcpPost(ctx.address, add(), { token });
		expect(after.status).toBe(200);
		expect(await after.text()).toContain("nobody is signed in");
	});

	test("a store failure while binding answers identity_refused, never silence", async () => {
		const store = new FlakyStore();
		const ctx = await setup({ store }, null);
		store.failing = true;
		ctx.tab.send({
			type: "identity",
			assertion: await provider.assertion("alice", ctx.address),
		});
		const err = (await ctx.tab.next("error")) as { code: string };
		expect(err.code).toBe("identity_refused");
		expect(ctx.r.logs.events("identity.refused").at(-1)?.["reason"]).toBe(
			"store_unavailable",
		);
	});

	test("URLs with a password are refused like those with a user name", () => {
		expect(() =>
			resolveConfig({
				publicUrl: "https://relay.example",
				allowedOrigins: ["https://app.example"],
				identity: "oidc",
				oidc: {
					issuer: "https://:secret@login.example",
					clientId: "relay",
					assertionIssuer: "https://app.example",
					assertionJwksUrl: "https://app.example/jwks",
				},
			}),
		).toThrow(/credentials/);
	});
});

describe("identity binding: -31009 (iteration 11, finding 3)", () => {
	/** A signed-in page that never answers, so a request stays waiting. */
	async function silentSetup(
		options: CreateRelayOptions = {},
		hooks: RelayTestHooks = {},
	): Promise<Ctx> {
		const r = await relay(options, hooks);
		const tab = new ScriptedTab(r.wsUrl, { onRequest: () => {} });
		tabs.push(tab);
		await tab.connect();
		await signInTab(tab, "alice");
		tab.send({ type: "pairing.start" });
		return {
			r,
			tab,
			address: tab.session?.address ?? "",
			browser: new TestBrowser(r.url),
		};
	}

	test("a refused assertion answers 401 with WWW-Authenticate", async () => {
		const ctx = await silentSetup();
		const token = await pairedToken(ctx);
		const pending = mcpPost(ctx.address, add(), { token });
		await ctx.tab.next("http.request");
		const now = Math.floor(Date.now() / 1000);
		ctx.tab.send({
			type: "identity",
			assertion: await provider.assertion("alice", ctx.address, {
				exp: now - 30,
			}),
		});
		const res = await pending;
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain(
			'error="invalid_token"',
		);
		expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
		expect(((await res.json()) as { error: { code: number } }).error.code).toBe(
			-31009,
		);
	});

	test("a store outage while binding answers 503 with Retry-After, not 401", async () => {
		const store = new FlakyStore();
		const ctx = await silentSetup({ store });
		const token = await pairedToken(ctx);
		const pending = mcpPost(ctx.address, add(), { token });
		await ctx.tab.next("http.request");
		store.failing = true;
		ctx.tab.send({
			type: "identity",
			assertion: await provider.assertion("alice", ctx.address),
		});
		const res = await pending;
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).not.toBeNull();
		expect(res.headers.get("www-authenticate")).toBeNull();
		expect(((await res.json()) as { error: { code: number } }).error.code).toBe(
			-31009,
		);
	});

	test("keys that cannot be fetched answer 503 with Retry-After, not 401", async () => {
		const cache = new JwksCache(provider.relayConfig().assertionJwksUrl);
		let failing = false;
		const keys: KeySource = {
			keys: async (kid) => {
				if (failing) throw new Error("JWKS unreachable");
				return cache.keys(kid);
			},
		};
		const ctx = await silentSetup({}, { assertionKeys: keys });
		const token = await pairedToken(ctx);
		const pending = mcpPost(ctx.address, add(), { token });
		await ctx.tab.next("http.request");
		failing = true;
		ctx.tab.send({
			type: "identity",
			assertion: await provider.assertion("alice", ctx.address),
		});
		const res = await pending;
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).not.toBeNull();
		expect(ctx.r.logs.events("identity.refused").at(-1)?.["reason"]).toBe(
			"jwks_unavailable",
		);
	});

	test("after a transient refusal a retry is told to try again, not to sign in (review of PR #30)", async () => {
		const cache = new JwksCache(provider.relayConfig().assertionJwksUrl);
		let failing = false;
		const keys: KeySource = {
			keys: async (kid) => {
				if (failing) throw new Error("JWKS unreachable");
				return cache.keys(kid);
			},
		};
		const ctx = await silentSetup({ pageWaitMs: 200 }, { assertionKeys: keys });
		const token = await pairedToken(ctx);
		failing = true;
		ctx.tab.send({
			type: "identity",
			assertion: await provider.assertion("alice", ctx.address),
		});
		await ctx.tab.next("error");
		const res = await mcpPost(ctx.address, add(), { token });
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).not.toBeNull();
		const text = await res.text();
		expect(text).toContain('"code":-31009');
		expect(text).not.toContain("sign in");
		// Fail closed: nothing reached the page for the unverified user.
		expect(ctx.tab.received.some((m) => m.type === "http.request")).toBe(false);
		// Once the keys are back, the page binds again and requests go through.
		failing = false;
		await signInTab(ctx.tab, "alice");
		void mcpPost(ctx.address, add(), { token });
		await ctx.tab.next("http.request");
	});

	test("a full relay-wide replay cache is transient: 503, not 401 (review of PR #30)", async () => {
		const ctx = await silentSetup({}, { maxSeenAssertions: 1 });
		const token = await pairedToken(ctx);
		const pending = mcpPost(ctx.address, add(), { token });
		await ctx.tab.next("http.request");
		ctx.tab.send({
			type: "identity",
			assertion: await provider.assertion("alice", ctx.address),
		});
		const res = await pending;
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).not.toBeNull();
		expect(ctx.r.logs.events("identity.refused").at(-1)?.["reason"]).toBe(
			"relay_busy",
		);
	});
});

describe("identity binding: audit of 2026-10-24, finding 3", () => {
	test("one sign-in per connection request: a new Connect replaces the earlier one", async () => {
		const ctx = await setup();
		provider.signedInAs = "alice";
		const flow = await openAuthorize(ctx);
		const first = await ctx.browser.submit(flow.page, { action: "connect" });
		const second = await ctx.browser.submit(flow.page, { action: "connect" });
		expect(first.status).toBe(303);
		expect(second.status).toBe(303);
		const stale = await ctx.browser.open(
			await provider.signIn(first.location ?? ""),
		);
		expect(stale.status).toBe(400);
		expect(stale.html).toContain("expired or was already used");
		const done = await ctx.browser.open(
			await provider.signIn(second.location ?? ""),
		);
		expect(done.status).toBe(303);
		expect(new URL(done.location ?? "").searchParams.get("code")).not.toBe(
			null,
		);
	});

	test("review of PR 32: a busy refusal is 429 and charges no guess", async () => {
		const ctx = await setup({}, "alice", { oidcMaxFlows: 1 });
		provider.signedInAs = "alice";
		const first = await openAuthorize(ctx);
		expect(
			(await ctx.browser.submit(first.page, { action: "connect" })).status,
		).toBe(303);
		const other = { ...ctx, browser: new TestBrowser(ctx.r.url) };
		const second = await openAuthorize(other);
		for (let i = 0; i < 11; i++) {
			const res = await other.browser.submit(second.page, {
				action: "connect",
			});
			expect(res.status).toBe(429);
			expect(res.html).toContain("Too many sign-ins are open");
		}
	});

	test("Connect clicks are charged like guesses: one network is stopped after 10", async () => {
		const ctx = await setup();
		provider.signedInAs = "alice";
		const flow = await openAuthorize(ctx);
		const statuses: number[] = [];
		for (let i = 0; i < 11; i++) {
			const res = await ctx.browser.submit(flow.page, { action: "connect" });
			statuses.push(res.status);
		}
		expect(statuses.slice(0, 10).every((s) => s === 303)).toBe(true);
		expect(statuses[10]).toBe(429);
	});
});

describe("several instances: the address id on every pairing request (DEC-098)", () => {
	test("the form posts to /authorize?a=<id>, the provider's state and the code start with the id", async () => {
		const ctx = await setup();
		const id = ctx.tab.addressId;
		provider.signedInAs = "alice";
		const flow = await openAuthorize(ctx);
		expect(flow.page.html).toContain(
			`<form method="post" action="/authorize?a=${id}">`,
		);
		expect(flow.page.html).not.toContain('action="/authorize"');
		const done = await connectThroughProvider(ctx, flow);
		const state = provider.authorizeRequests.at(-1)?.get("state") ?? "";
		expect(state.startsWith(`${id}.`)).toBe(true);
		expect(state.length).toBeGreaterThan(id.length + 20);
		expect(done.status).toBe(303);
		const code = new URL(done.location ?? "").searchParams.get("code") ?? "";
		expect(code.startsWith(`${id}.`)).toBe(true);
		expect(code.length).toBeGreaterThan(id.length + 40);
		await tokenFrom(ctx, done.location ?? "", flow.verifier);
	});

	test("the 'Open the page first' form carries the id too", async () => {
		const ctx = await setup();
		const id = ctx.tab.addressId;
		const flow = await openAuthorize(ctx);
		ctx.tab.close();
		await ctx.tab.closed;
		await waitFor(() => ctx.r.relay.sessionCount === 0, "the tab to go");
		const page = await ctx.browser.submit(flow.page, { action: "retry" });
		expect(page.html).toContain("Open the page first");
		expect(page.html).toContain(
			`<form method="post" action="/authorize?a=${id}">`,
		);
	});
});
