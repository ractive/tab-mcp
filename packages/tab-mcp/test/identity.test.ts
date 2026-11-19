/**
 * Identity binding end to end in the relay (iteration 7, DEC-075 to DEC-079):
 * a scripted tab proves its user with a tab assertion, the AI app's browser
 * signs in at a local OIDC provider, and the relay pairs only the same person.
 * Since the fixed address (iteration 45, DEC-196) the sign-in comes first and
 * finds the page: the app's page whose user is the signed-in person and whose
 * dialog is open.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { shortAddress } from "../src/address.ts";
import { resolveConfig } from "../src/config.ts";
import { identityKey, MISMATCH_TEXT } from "../src/identity.ts";
import { JwksCache, type KeySource } from "../src/jwt.ts";
import { NO_PAGE_TEXT } from "../src/oauth/oidc.ts";
import type { CreateRelayOptions, RelayTestHooks } from "../src/relay.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import type { RevokeOptions, RevokeSelector } from "../src/store/types.ts";
import {
	APP,
	issueAccessToken,
	mcpPost,
	rpc,
	ScriptedTab,
	type TabOptions,
	waitFor,
} from "./helpers.ts";
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

/** A browser at `/authorize` for an app's address. */
interface Visit {
	r: OAuthTestRelay;
	address: string;
	browser: TestBrowser;
}

/** A visit with the one page the test connected. */
interface Ctx extends Visit {
	tab: ScriptedTab;
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
	options: TabOptions = {},
): Promise<ScriptedTab> {
	const tab = new ScriptedTab(r.wsUrl, options);
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

/**
 * The relay has handled what the tab sent so far (it handles a tab's
 * messages in order; an `error` from the tab is only logged).
 */
async function settled(r: OAuthTestRelay, tab: ScriptedTab): Promise<void> {
	const before = r.logs.events("tab.error").length;
	tab.send({ type: "error", code: "test_sync", message: "" });
	await waitFor(
		() => r.logs.events("tab.error").length > before,
		"the relay to catch up with the tab",
	);
}

/** One page of `APP`, signed in as `user` unless `null`, its dialog open. */
async function setup(
	options: CreateRelayOptions = {},
	user: string | null = "alice",
	hooks: RelayTestHooks = {},
): Promise<Ctx> {
	const r = await relay(options, hooks);
	const tab = await newTab(r);
	if (user !== null) await signInTab(tab, user);
	tab.send({ type: "pairing.start" });
	await settled(r, tab);
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

async function openAuthorize(ctx: Visit): Promise<Flow> {
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

/** Connect: the relay's redirect to the provider. */
async function connect(ctx: Visit, page: Flow["page"]): Promise<string> {
	const posted = await ctx.browser.submit(page, { action: "connect" });
	expect(posted.status).toBe(303);
	const toProvider = posted.location ?? "";
	expect(toProvider.startsWith(provider.issuer)).toBe(true);
	return toProvider;
}

/** Connect → provider → callback; returns the callback's answer. */
async function connectThroughProvider(ctx: Visit, flow: Flow) {
	const back = await provider.signIn(await connect(ctx, flow.page));
	expect(back.startsWith(`${ctx.r.url}/authorize/callback`)).toBe(true);
	return ctx.browser.open(back);
}

async function tokenFrom(ctx: Visit, location: string, verifier: string) {
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

async function pairedToken(ctx: Visit): Promise<string> {
	provider.signedInAs = "alice";
	const flow = await openAuthorize(ctx);
	const done = await connectThroughProvider(ctx, flow);
	expect(done.status).toBe(303);
	return (await tokenFrom(ctx, done.location ?? "", flow.verifier))
		.access_token;
}

const add = () =>
	rpc(1, "tools/call", { name: "add", arguments: { a: 1, b: 2 } });

/** A pairing page without what differs from one request to the next. */
const masked = (html: string) =>
	html.replace(/name="(request_id|csrf)" value="[^"]+"/g, 'name="$1"');

describe("identity binding: the same person connects without a code", () => {
	test("session says oidc; the page shows no code; a match pairs; the grant carries the subject; tools work", async () => {
		const ctx = await setup();
		expect(ctx.tab.session?.pairing).toBe("oidc");
		expect(ctx.address).toBe(`${ctx.r.url}/s/${APP}/mcp`);
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
		// The page the sign-in found, and how.
		expect(ctx.r.logs.events("oauth.paired")).toEqual([
			expect.objectContaining({
				address: shortAddress(ctx.tab.addressId),
				app: APP,
				method: "oidc",
			}),
		]);

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

	test("Connect asks no page: with none open, one signed out or one with its dialog closed, the form and the redirect are the same", async () => {
		const r = await relay();
		const visit: Visit = {
			r,
			address: r.relay.addressFor(APP),
			browser: new TestBrowser(r.url),
		};
		const pages: string[] = [];
		const look = async () => {
			const flow = await openAuthorize(visit);
			expect(flow.page.status).toBe(200);
			pages.push(masked(flow.page.html));
			// To the provider, with no question about the account.
			const toProvider = new URL(await connect(visit, flow.page));
			expect(toProvider.searchParams.has("prompt")).toBe(false);
		};
		// No page of the app is open.
		await look();
		// One is, signed out, its dialog closed.
		const tab = await newTab(r);
		await look();
		// Signed in, the dialog still closed.
		await signInTab(tab, "alice");
		await look();
		// Ready to be paired.
		tab.send({ type: "pairing.start" });
		await settled(r, tab);
		await look();
		// What the browser is shown says nothing about the app's pages (RS 10).
		expect(new Set(pages).size).toBe(1);
		expect(pages[0]).not.toContain("Nobody is signed in");
		expect(pages[0]).not.toContain("Open the page first");
	});
});

/** What makes the sign-in find no page; `meanwhile` runs between Connect and the provider's answer. */
interface NoPage {
	name: string;
	/** Who is signed in to the page (`null`: nobody). */
	pageUser: string | null;
	/** Who signs in at the provider. */
	providerUser: string;
	meanwhile?: (ctx: Ctx) => Promise<void>;
}

const NO_PAGE: NoPage[] = [
	{
		name: "another person signs in at the provider",
		pageUser: "alice",
		providerUser: "bob",
	},
	{
		name: "nobody is signed in to the page",
		pageUser: null,
		providerUser: "alice",
	},
	{
		name: "the page signs out between Connect and the callback",
		pageUser: "alice",
		providerUser: "alice",
		meanwhile: async (ctx) => {
			ctx.tab.send({ type: "identity.logout" });
			await waitFor(
				() => ctx.r.logs.events("identity.signed_out").length > 0,
				"the sign-out",
			);
		},
	},
	{
		// The dialog must still be open when the sign-in comes back, as a
		// code is void once it closes.
		name: "RS 11: the dialog closes between Connect and the callback",
		pageUser: "alice",
		providerUser: "alice",
		meanwhile: async (ctx) => {
			ctx.tab.send({ type: "pairing.stop" });
			await settled(ctx.r, ctx.tab);
		},
	},
	{
		name: "the page closes between Connect and the callback",
		pageUser: "alice",
		providerUser: "alice",
		meanwhile: async (ctx) => {
			ctx.tab.close();
			await ctx.tab.closed;
			await waitFor(() => ctx.r.relay.sessionCount === 0, "the tab to go");
		},
	},
];

describe("identity binding: no page of the signed-in person is connecting", () => {
	/** Each case's page, to compare them. */
	const answers: string[] = [];

	/** Up to the provider's answer, which the caller opens. */
	async function untilCallback(c: NoPage) {
		const ctx = await setup({}, c.pageUser);
		provider.signedInAs = c.providerUser;
		const flow = await openAuthorize(ctx);
		// Connect goes to the provider whatever the page's state.
		const back = await provider.signIn(await connect(ctx, flow.page));
		await c.meanwhile?.(ctx);
		return { ctx, flow, back };
	}

	for (const c of NO_PAGE) {
		test(`${c.name}: 403 with the one text, nobody paired, and the next Connect asks for the account`, async () => {
			const { ctx, back } = await untilCallback(c);
			const done = await ctx.browser.open(back);
			expect(done.status).toBe(403);
			expect(done.location).toBeUndefined();
			expect(done.html).toContain(NO_PAGE_TEXT);
			answers.push(masked(done.html));
			// The log does not tell the cases apart either, and names no page.
			const failed = ctx.r.logs.events("oauth.pairing_failed");
			expect(failed).toHaveLength(1);
			expect(failed[0]).toMatchObject({ app: APP, reason: "mismatch" });
			expect(failed[0]).not.toHaveProperty("address");
			expect(ctx.r.logs.events("oauth.paired")).toHaveLength(0);
			expect(
				await ctx.r.store.listGrants(ctx.tab.addressId, Date.now()),
			).toEqual([]);
			// The page still offers Connect; this time the provider is asked
			// to log in again, so another account can be chosen.
			const again = new URL(await connect(ctx, done));
			expect(again.searchParams.get("prompt")).toBe("login");
		});
	}

	test("the cases cannot be told apart by the page", () => {
		// Filled by the tests above; empty when this one runs alone.
		expect(new Set(answers).size).toBeLessThanOrEqual(1);
	});

	test("after another person's sign-in, the same request pairs once the page's user signs in", async () => {
		const [another] = NO_PAGE;
		if (another === undefined) throw new Error("no case");
		const { ctx, flow, back } = await untilCallback(another);
		const refused = await ctx.browser.open(back);
		expect(refused.status).toBe(403);
		const toProvider = await connect(ctx, refused);
		provider.signedInAs = "alice";
		const done = await ctx.browser.open(await provider.signIn(toProvider));
		expect(done.status).toBe(303);
		const tokens = await tokenFrom(ctx, done.location ?? "", flow.verifier);
		const res = await mcpPost(ctx.address, add(), {
			token: tokens.access_token,
		});
		expect(await res.text()).toContain('"text":"3"');
		expect(ctx.r.logs.events("oauth.paired")).toHaveLength(1);
	});

	test("RS 11: after a closed dialog, the same request pairs once the dialog is open again", async () => {
		const closing = NO_PAGE.find((c) => c.name.startsWith("RS 11"));
		if (closing === undefined) throw new Error("no case");
		const { ctx, back } = await untilCallback(closing);
		const refused = await ctx.browser.open(back);
		expect(refused.status).toBe(403);
		ctx.tab.send({ type: "pairing.start" });
		await settled(ctx.r, ctx.tab);
		const done = await ctx.browser.open(
			await provider.signIn(await connect(ctx, refused)),
		);
		expect(done.status).toBe(303);
		expect(
			new URL(done.location ?? "").searchParams.get("code"),
		).not.toBeNull();
	});
});

describe("identity binding: someone else gets the mismatch error", () => {
	test("the MCP endpoint refuses a grant of another person with the mismatch text, and names the app's metadata", async () => {
		const ctx = await setup();
		const { token } = await issueAccessToken(
			ctx.r.store,
			{
				addressId: ctx.tab.addressId,
				app: APP,
				clientId,
				clientName: "Test AI",
				subject: identityKey(provider.issuer, "bob"),
			},
			{ ttlMs: 60_000 },
		);
		const res = await mcpPost(ctx.address, add(), { token });
		expect(res.status).toBe(401);
		// Where an AI app starts over: the app's address, not a page's.
		expect(res.headers.get("www-authenticate")).toBe(
			`Bearer resource_metadata="${ctx.r.url}/.well-known/oauth-protected-resource/s/${APP}/mcp", scope="tools", error="invalid_token", error_description="${MISMATCH_TEXT}"`,
		);
		const body = (await res.json()) as { error_description: string };
		expect(body.error_description).toBe(MISMATCH_TEXT);
		expect(ctx.r.logs.events("mcp.request").at(-1)).toMatchObject({
			app: APP,
			address: shortAddress(ctx.tab.addressId),
			status: 401,
			reason: "identity_mismatch",
		});
		expect(ctx.tab.received.some((m) => m.type === "http.request")).toBe(false);
	});

	test("a code-made grant (no subject) does not work on an oidc site", async () => {
		const ctx = await setup();
		const { token } = await issueAccessToken(
			ctx.r.store,
			{
				addressId: ctx.tab.addressId,
				app: APP,
				clientId,
				clientName: "Test AI",
			},
			{ ttlMs: 60_000 },
		);
		const res = await mcpPost(ctx.address, add(), { token });
		expect(res.status).toBe(401);
		// Refused for the person, not for the token: the token is the app's.
		expect(
			((await res.json()) as { error_description: string }).error_description,
		).toBe(MISMATCH_TEXT);
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
		// The page was there all along: none of these is "no page".
		expect(ctx.r.logs.events("oauth.paired")).toHaveLength(0);
		expect(
			ctx.r.logs
				.events("oauth.pairing_failed")
				.some((e) => e["reason"] === "mismatch"),
		).toBe(false);
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
	test("an open page without a signed-in user: requests wait for it, then get the signed-out answer", async () => {
		const ctx = await setup({ pageWaitMs: 300 });
		const token = await pairedToken(ctx);
		ctx.tab.close();
		await ctx.tab.closed;
		const tab = await newTab(ctx.r, { secret: ctx.tab.secret });
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

	test("refused assertions: expired, wrong audience, wrong type, replayed; the session stays and binds nobody", async () => {
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
				await provider.assertion("alice", `${ctx.r.url}/s/another-app/mcp`),
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
		// Fail closed: the refused (replayed) assertion ended the binding, so
		// Alice's sign-in finds no page of hers, though its dialog is open.
		provider.signedInAs = "alice";
		const done = await connectThroughProvider(ctx, await openAuthorize(ctx));
		expect(done.status).toBe(403);
		expect(done.html).toContain(NO_PAGE_TEXT);
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
		// Nobody is bound: Alice's sign-in finds no page of hers.
		provider.signedInAs = "alice";
		const done = await connectThroughProvider(ctx, await openAuthorize(ctx));
		expect(done.status).toBe(403);
		expect(done.html).toContain(NO_PAGE_TEXT);
		expect(ctx.r.logs.events("oauth.paired")).toHaveLength(0);
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
		// The page is told that the grants could not be revoked.
		const told = (await ctx.tab.next("error")) as { code: string };
		expect(told).toMatchObject({
			code: "store_unavailable",
			for: "identity.logout",
		});
		expect(told).not.toHaveProperty("grantId");
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

	test("RS 12: identity_refused carries a fixed text, not the inner error's", async () => {
		const keys: KeySource = {
			keys: async () => {
				throw new Error("HTTP 500 from https://keys.internal.example/jwks");
			},
		};
		const r = await relay({}, { assertionKeys: keys });
		const tab = await newTab(r);
		tab.send({
			type: "identity",
			assertion: await provider.assertion("alice", tab.session?.address ?? ""),
		});
		const ctx = { r };
		const refused = (await tab.next("error")) as {
			code: string;
			message: string;
		};
		expect(refused.code).toBe("identity_refused");
		expect(refused.message).toBe(
			"the identity assertion was refused: the signing keys could not be loaded",
		);
		expect(refused.message).not.toContain("internal");
		const line = ctx.r.logs.events("identity.refused").at(-1);
		expect(line?.["reason"]).toBe("jwks_unavailable");
		expect(line?.["error"]).toBe("Error");
		expect(JSON.stringify(line)).not.toContain("internal");
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

describe("identity binding at the fixed address (DEC-196): the sign-in finds the page", () => {
	/** A page of `app`, signed in as `sub`, its dialog open. */
	async function page(
		r: OAuthTestRelay,
		sub: string,
		options: TabOptions = {},
	): Promise<ScriptedTab> {
		const tab = await newTab(r, options);
		await signInTab(tab, sub);
		tab.send({ type: "pairing.start" });
		await settled(r, tab);
		// Sessions are told apart by when they connected, to the millisecond.
		await Bun.sleep(3);
		return tab;
	}

	/** `sub` signs in at `address` in a browser of their own; the callback's answer and the verifier. */
	async function signInAt(r: OAuthTestRelay, address: string, sub: string) {
		const ctx = { r, address, browser: new TestBrowser(r.url) };
		provider.signedInAs = sub;
		const flow = await openAuthorize(ctx);
		const done = await connectThroughProvider(ctx, flow);
		return { ctx, flow, done };
	}

	/** The address ids the relay paired, oldest first (as the log shortens them). */
	const paired = (r: OAuthTestRelay) =>
		r.logs.events("oauth.paired").map((e) => e["address"]);

	async function subjects(r: OAuthTestRelay, tab: ScriptedTab) {
		const grants = await r.store.listGrants(tab.addressId, Date.now());
		return grants.map((g) => g.subject);
	}

	test("two pages of one app, two people: each sign-in pairs that person's page, never the other's", async () => {
		const r = await relay();
		const alices = await page(r, "alice");
		const bobs = await page(r, "bob");
		// Alice's page is not the one that connected last ...
		const a = await signInAt(r, alices.session?.address ?? "", "alice");
		expect(a.done.status).toBe(303);
		expect(paired(r)).toEqual([shortAddress(alices.addressId)]);
		// ... and Bob's is neither the first nor the last.
		const carols = await page(r, "carol");
		const b = await signInAt(r, bobs.session?.address ?? "", "bob");
		expect(b.done.status).toBe(303);
		expect(paired(r)).toEqual([
			shortAddress(alices.addressId),
			shortAddress(bobs.addressId),
		]);

		// Each grant is its page's, for its person; each token reaches its
		// own page only, at the address all three share.
		const alicesToken = await tokenFrom(
			a.ctx,
			a.done.location ?? "",
			a.flow.verifier,
		);
		const bobsToken = await tokenFrom(
			b.ctx,
			b.done.location ?? "",
			b.flow.verifier,
		);
		expect(await subjects(r, alices)).toEqual([
			identityKey(provider.issuer, "alice"),
		]);
		expect(await subjects(r, bobs)).toEqual([
			identityKey(provider.issuer, "bob"),
		]);
		expect(await subjects(r, carols)).toEqual([]);
		const requests = (t: ScriptedTab) =>
			t.received.filter((m) => m.type === "http.request").length;
		const call = async (token: string) => {
			const res = await mcpPost(a.ctx.address, add(), { token });
			expect(await res.text()).toContain('"text":"3"');
			return [alices, bobs, carols].map(requests);
		};
		expect(await call(alicesToken.access_token)).toEqual([1, 0, 0]);
		expect(await call(bobsToken.access_token)).toEqual([1, 1, 0]);
	});

	test("two pages of one app, one person, both dialogs open: the one that connected last is paired", async () => {
		const r = await relay();
		const first = await page(r, "alice");
		const second = await page(r, "alice");
		const address = first.session?.address ?? "";
		expect((await signInAt(r, address, "alice")).done.status).toBe(303);
		expect(paired(r)).toEqual([shortAddress(second.addressId)]);

		// "Last" is by when the page connected, not by its place among the
		// relay's sessions: the first page connects again and is the last now.
		first.close();
		await first.closed;
		const again = await page(r, "alice", { secret: first.secret });
		expect((await signInAt(r, address, "alice")).done.status).toBe(303);
		expect(paired(r).at(-1)).toBe(shortAddress(again.addressId));

		// Only pages whose dialog is open count: with the last one's closed,
		// the other is paired.
		again.send({ type: "pairing.stop" });
		await settled(r, again);
		expect((await signInAt(r, address, "alice")).done.status).toBe(303);
		expect(paired(r).at(-1)).toBe(shortAddress(second.addressId));
	});

	test("a page of another app, signed in as the same person, is not paired by a sign-in at this app's address", async () => {
		const r = await relay();
		const other = await page(r, "alice", { appId: "other-app" });
		expect(other.session?.address).toBe(`${r.url}/s/other-app/mcp`);
		const address = r.relay.addressFor(APP);
		// No page of this app: the other app's page is not taken instead.
		const none = await signInAt(r, address, "alice");
		expect(none.done.status).toBe(403);
		expect(none.done.html).toContain(NO_PAGE_TEXT);
		expect(await subjects(r, other)).toEqual([]);
		// With one of this app, older than the other app's page: it is paired.
		const mine = await page(r, "alice");
		other.close();
		await other.closed;
		const others = await page(r, "alice", {
			appId: "other-app",
			secret: other.secret,
		});
		const here = await signInAt(r, address, "alice");
		expect(here.done.status).toBe(303);
		expect(paired(r)).toEqual([shortAddress(mine.addressId)]);
		// The other app's address pairs the other app's page; its token is
		// refused at this app's address.
		const there = await signInAt(r, others.session?.address ?? "", "alice");
		expect(there.done.status).toBe(303);
		expect(paired(r).at(-1)).toBe(shortAddress(others.addressId));
		const tokens = await tokenFrom(
			there.ctx,
			there.done.location ?? "",
			there.flow.verifier,
		);
		const wrongApp = await mcpPost(address, add(), {
			token: tokens.access_token,
		});
		expect(wrongApp.status).toBe(401);
		const rightApp = await mcpPost(there.ctx.address, add(), {
			token: tokens.access_token,
		});
		expect(await rightApp.text()).toContain('"text":"3"');
	});

	test("a tab assertion's aud is the app's address: one made for another app's address is refused", async () => {
		const r = await relay();
		const mine = await newTab(r);
		const others = await newTab(r, { appId: "other-app" });
		const forOther = await provider.assertion(
			"alice",
			others.session?.address ?? "",
		);
		mine.send({ type: "identity", assertion: forOther });
		expect(((await mine.next("error")) as { code: string }).code).toBe(
			"identity_refused",
		);
		expect(r.logs.events("identity.refused").at(-1)?.["reason"]).toBe("aud");
		// Nothing was wrong with it but the audience: the other app's page
		// binds with it (the refusal above did not use up its jti).
		others.send({ type: "identity", assertion: forOther });
		await others.next("identity.bound");
		// The relay's own URL, the address without `/mcp` and the address
		// form of before DEC-196 are no audience either.
		for (const aud of [
			r.url,
			`${r.url}/s/${APP}`,
			`${r.url}/s/${APP}/mcp/`,
			`${r.url}/a/${mine.addressId}/mcp`,
		]) {
			mine.send({
				type: "identity",
				assertion: await provider.assertion("alice", aud),
			});
			await mine.next("error");
			expect(r.logs.events("identity.refused").at(-1)?.["reason"]).toBe("aud");
		}
	});

	test("an assertion is for the app, not for one page: only its jti keeps a second page from using it", async () => {
		const r = await relay();
		const first = await newTab(r);
		const second = await newTab(r);
		// Before DEC-196 the audience named one page's address; now all pages
		// of an app share it, so the same assertion is well-formed for both.
		// Whichever sends it first is bound; the other is refused as a replay.
		const assertion = await provider.assertion(
			"alice",
			first.session?.address ?? "",
		);
		second.send({ type: "identity", assertion });
		await second.next("identity.bound");
		first.send({ type: "identity", assertion });
		expect(((await first.next("error")) as { code: string }).code).toBe(
			"identity_refused",
		);
		expect(r.logs.events("identity.refused").at(-1)?.["reason"]).toBe(
			"replayed",
		);
	});

	test("neither the provider's state nor the authorization code names the page; the form posts to /authorize", async () => {
		const ctx = await setup();
		const id = ctx.tab.addressId;
		provider.signedInAs = "alice";
		const flow = await openAuthorize(ctx);
		expect(flow.page.html).toContain('<form method="post" action="/authorize"');
		expect(flow.page.html).not.toContain(id);
		const done = await connectThroughProvider(ctx, flow);
		expect(done.status).toBe(303);
		// The provider is a third party: what it sees says nothing of the page.
		const sent = provider.authorizeRequests.at(-1)?.toString() ?? "";
		expect(sent).not.toContain(id);
		const code = new URL(done.location ?? "").searchParams.get("code") ?? "";
		expect(code).not.toContain(id);
		expect(code).not.toContain(".");
		await tokenFrom(ctx, done.location ?? "", flow.verifier);
	});

	// A Connect that goes to the provider is charged as a guess, per
	// network, and given back when the sign-in pairs. The members of one
	// organisation (one IPv4 address, or one IPv6 /56) each signing in to
	// the organisation's connector is the case iteration 45 is for.
	test("a sign-in that pairs is not charged: one network pairs more than 10 times by sign-in", async () => {
		const r = await relay();
		const tab = await page(r, "alice");
		const address = tab.session?.address ?? "";
		const statuses: number[] = [];
		for (let i = 0; i < 12; i++) {
			const ctx = { r, address, browser: new TestBrowser(r.url) };
			provider.signedInAs = "alice";
			const flow = await openAuthorize(ctx);
			const posted = await ctx.browser.submit(flow.page, { action: "connect" });
			statuses.push(posted.status);
			if (posted.status !== 303) break;
			const back = await provider.signIn(posted.location ?? "");
			expect((await ctx.browser.open(back)).status).toBe(303);
		}
		expect(statuses).toEqual(Array(12).fill(303));
	});
});
