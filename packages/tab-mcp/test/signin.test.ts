/**
 * A browser's sign-in and its account's group (DEC-231, iteration 53): the
 * scripted extension signs in at loopback fakes of Google, Microsoft and
 * GitHub through the relay, which binds its address to the account. Every
 * browser of one account is a member of one group.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { newSecret } from "../src/address.ts";
import {
	ConfigError,
	configFromEnv,
	resolveConfig,
	unknownEnvNames,
} from "../src/config.ts";
import type {
	GroupMessage,
	RelayMessage,
	SessionMessage,
	SignInDoneMessage,
	SignInFailedMessage,
} from "../src/protocol.ts";
import {
	type CreateRelayOptions,
	createRelay,
	createTestRelay,
	type Relay,
	type RelayTestHooks,
} from "../src/relay.ts";
import { redirectUrlFits } from "../src/signin/browser.ts";
import {
	accountKey,
	MICROSOFT_PERSONAL_TENANT,
} from "../src/signin/providers.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import type { TokenStore } from "../src/store/types.ts";
import { LogCapture, ORIGIN, ScriptedTab, waitFor } from "./helpers.ts";
import { type FakeProviders, startFakeProviders } from "./signin-fixture.ts";

const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";
const CHROME = `chrome-extension://${CHROME_ID}`;
const CHROME_REDIRECT = `https://${CHROME_ID}.chromiumapp.org/`;
const FIREFOX = "moz-extension://0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const FIREFOX_REDIRECT = `https://${"ab12".repeat(10)}.extensions.allizom.org/`;
const APP = "tab-mcp-extension";

let fakes: FakeProviders;
let current: Ctx | undefined;
const tabs: ScriptedTab[] = [];

beforeAll(async () => {
	fakes = await startFakeProviders();
});
afterAll(async () => {
	await fakes.stop();
});
afterEach(async () => {
	for (const t of tabs.splice(0)) if (t.ws.readyState <= 1) t.close();
	await current?.relay.stop();
	current = undefined;
	fakes.tamper = undefined;
	fakes.deny = undefined;
	fakes.githubTokenError = undefined;
	fakes.google = { sub: "g-alice", email: "alice@gmail.example" };
	fakes.microsoft = {
		tid: "72f988bf-86f1-41af-91ab-2d7cd011db47",
		oid: "00000000-0000-0000-1111-000000000001",
		preferred_username: "alice@contoso.example",
	};
	fakes.github = { id: 1001, login: "alice" };
});

interface Ctx {
	relay: Relay;
	store: TokenStore;
	logs: LogCapture;
	wsUrl: string;
}

function signInConfig() {
	return {
		apps: [APP, "tab-mcp-extension-firefox"],
		providers: {
			google: fakes.clients.google,
			microsoft: fakes.clients.microsoft,
			github: fakes.clients.github,
		},
	};
}

/** A relay with the three fakes; `withoutSignIn` for one as today's. */
function start(
	{
		withoutSignIn = false,
		...options
	}: CreateRelayOptions & { withoutSignIn?: boolean } = {},
	hooks: RelayTestHooks = {},
): Ctx {
	const store = new MemoryTokenStore();
	const logs = new LogCapture();
	const relay = createTestRelay(
		{
			development: true,
			port: 0,
			host: "127.0.0.1",
			allowedOrigins: [CHROME, ORIGIN, "moz-extension://*"],
			store,
			logger: logs.logger,
			...(withoutSignIn ? {} : { signIn: signInConfig() }),
			maxSessionsPerIp: 40,
			...options,
		},
		{ signInEndpoints: fakes.endpoints, ...hooks },
	);
	current = {
		relay,
		store,
		logs,
		wsUrl: `ws://127.0.0.1:${relay.port}/tab`,
	};
	return current;
}

interface ExtensionOptions {
	secret?: string;
	origin?: string;
	appId?: string;
	/** `null`: none sent, as by today's extensions; default `["signin.v1"]`. */
	capabilities?: unknown;
}

async function extension(
	ctx: Ctx,
	options: ExtensionOptions = {},
): Promise<ScriptedTab> {
	const tab = new ScriptedTab(ctx.wsUrl, {
		origin: options.origin ?? CHROME,
		appId: options.appId ?? APP,
		...(options.capabilities === null
			? {}
			: { capabilities: options.capabilities ?? ["signin.v1"] }),
		...(options.secret === undefined ? {} : { secret: options.secret }),
	});
	tabs.push(tab);
	await tab.connect();
	return tab;
}

/** A browser with a cookie jar that follows nothing by itself. */
class Browser {
	readonly cookies = new Map<string, string>();
	async get(
		url: string,
	): Promise<{ status: number; location: string; text: string }> {
		const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
		const res = await fetch(url, {
			redirect: "manual",
			headers: cookie === "" ? {} : { cookie },
		});
		for (const line of res.headers.getSetCookie()) {
			const [pair] = line.split(";");
			const [k, v] = (pair ?? "").split("=");
			if (k !== undefined && v !== undefined) this.cookies.set(k, v);
		}
		return {
			status: res.status,
			location: res.headers.get("location") ?? "",
			text: await res.text(),
		};
	}
}

/** The steps of one sign-in, each checked on the way. */
async function beginSignIn(
	tab: ScriptedTab,
	provider: string,
	options: { redirectUrl?: string; label?: string } = {},
): Promise<string> {
	tab.send({
		type: "signin.start",
		provider,
		redirectUrl: options.redirectUrl ?? CHROME_REDIRECT,
		...(options.label === undefined ? {} : { label: options.label }),
	});
	const m = (await tab.next("signin.url")) as { url: string; provider: string };
	expect(m.provider).toBe(provider);
	return m.url;
}

/** Relay URL → provider → callback; returns the callback's answer. */
async function throughProvider(url: string, browser = new Browser()) {
	const visit = await browser.get(url);
	expect(visit.status).toBe(302);
	const back = await browser.get(visit.location);
	expect(back.status).toBe(302);
	return {
		browser,
		callback: back.location,
		answer: await browser.get(back.location),
	};
}

/** The completion code in the redirect to the extension; fails on anything else. */
function completionCode(
	location: string,
	redirectUrl = CHROME_REDIRECT,
): string {
	const url = new URL(location);
	expect(`${url.origin}${url.pathname}`).toBe(redirectUrl);
	expect([...url.searchParams.keys()]).toEqual(["signin"]);
	const code = url.searchParams.get("signin") ?? "";
	expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
	return code;
}

/** Start, provider, callback: the completion code, before anything is bound. */
async function checkedCode(
	tab: ScriptedTab,
	provider: string,
	options: { redirectUrl?: string; label?: string } = {},
): Promise<string> {
	const url = await beginSignIn(tab, provider, options);
	const { answer } = await throughProvider(url);
	expect(answer.status).toBe(302);
	return completionCode(answer.location, options.redirectUrl);
}

async function signIn(
	tab: ScriptedTab,
	provider: string,
	options: { redirectUrl?: string; label?: string } = {},
): Promise<SignInDoneMessage> {
	const code = await checkedCode(tab, provider, options);
	tab.send({ type: "signin.complete", code });
	return (await tab.next("signin.done")) as SignInDoneMessage;
}

/** The redirect of a sign-in that failed before its completion code. */
const redirectError = (reason: string, redirectUrl = CHROME_REDIRECT) =>
	`${redirectUrl}?signin_error=${reason}`;

/** The next group message whose members match. */
async function groupWhere(
	tab: ScriptedTab,
	match: (g: GroupMessage) => boolean,
): Promise<GroupMessage> {
	return (await tab.next("group", (m) =>
		match(m as GroupMessage),
	)) as GroupMessage;
}

/** What a tab received after `session`, other than pings, within a short while. */
async function quietFor(tab: ScriptedTab, ms = 150): Promise<RelayMessage[]> {
	await Bun.sleep(ms);
	return tab.received.filter((m) => m.type !== "ping");
}

describe("configuration", () => {
	test("the environment variables, and every one is known", () => {
		const env = {
			TAB_MCP_SIGN_IN_APPS: "tab-mcp-extension, tab-mcp-extension-firefox",
			TAB_MCP_SIGN_IN_GOOGLE_CLIENT_ID: "g-id",
			TAB_MCP_SIGN_IN_GOOGLE_CLIENT_SECRET: "g-secret",
			TAB_MCP_SIGN_IN_MICROSOFT_CLIENT_ID:
				"aae32a2a-bef7-4fdb-9422-9d5df62b78e5",
			TAB_MCP_SIGN_IN_MICROSOFT_CLIENT_SECRET: "m-secret",
			TAB_MCP_SIGN_IN_GITHUB_CLIENT_ID: "Ov23litK0ROOKaHzH01W",
			TAB_MCP_SIGN_IN_GITHUB_CLIENT_SECRET: "gh-secret",
		};
		expect(unknownEnvNames(env)).toEqual([]);
		const config = resolveConfig({
			development: true,
			...configFromEnv(env),
		});
		expect(config.signIn).toEqual({
			apps: ["tab-mcp-extension", "tab-mcp-extension-firefox"],
			providers: {
				google: { clientId: "g-id", clientSecret: "g-secret" },
				microsoft: {
					clientId: "aae32a2a-bef7-4fdb-9422-9d5df62b78e5",
					clientSecret: "m-secret",
				},
				github: { clientId: "Ov23litK0ROOKaHzH01W", clientSecret: "gh-secret" },
			},
		});
		// Nothing set: no sign-in at all.
		expect(
			resolveConfig({ development: true, ...configFromEnv({}) }).signIn,
		).toBe(undefined);
	});

	test("half-set providers, apps without providers and providers without apps stop the relay", () => {
		const bad: [Record<string, string>, RegExp][] = [
			[
				{
					TAB_MCP_SIGN_IN_APPS: APP,
					TAB_MCP_SIGN_IN_GOOGLE_CLIENT_ID: "g-id",
				},
				/TAB_MCP_SIGN_IN_GOOGLE_CLIENT_SECRET is required/,
			],
			[
				{
					TAB_MCP_SIGN_IN_APPS: APP,
					TAB_MCP_SIGN_IN_GITHUB_CLIENT_SECRET: "s",
				},
				/TAB_MCP_SIGN_IN_GITHUB_CLIENT_ID is required/,
			],
			[{ TAB_MCP_SIGN_IN_APPS: APP }, /needs a sign-in provider/],
			[
				{
					TAB_MCP_SIGN_IN_GOOGLE_CLIENT_ID: "g",
					TAB_MCP_SIGN_IN_GOOGLE_CLIENT_SECRET: "s",
				},
				/names no app/,
			],
			[
				{
					TAB_MCP_SIGN_IN_APPS: "Not An App",
					TAB_MCP_SIGN_IN_GOOGLE_CLIENT_ID: "g",
					TAB_MCP_SIGN_IN_GOOGLE_CLIENT_SECRET: "s",
				},
				/must be app ids/,
			],
		];
		for (const [env, message] of bad) {
			let error: unknown;
			try {
				resolveConfig({ development: true, ...configFromEnv(env) });
			} catch (e) {
				error = e;
			}
			expect(error).toBeInstanceOf(ConfigError);
			expect((error as Error).message).toMatch(message);
			// The secret never appears in the error.
			expect((error as Error).message).not.toContain("g-secret");
		}
		expect(() =>
			resolveConfig({
				development: true,
				signIn: {
					apps: [APP],
					providers: {
						facebook: { clientId: "a", clientSecret: "b" },
					} as never,
				},
			}),
		).toThrow(/unknown sign-in provider facebook/);
	});

	test("a store without bindings cannot serve sign-in", () => {
		const bare: TokenStore = new MemoryTokenStore();
		const plain = {
			put: bare.put.bind(bare),
			get: bare.get.bind(bare),
			markUsed: bare.markUsed.bind(bare),
			revoke: bare.revoke.bind(bare),
			listGrants: bare.listGrants.bind(bare),
			deleteExpired: bare.deleteExpired.bind(bare),
		};
		expect(() =>
			createRelay({
				development: true,
				port: 0,
				host: "127.0.0.1",
				store: plain,
				logger: new LogCapture().logger,
				signIn: signInConfig(),
			}),
		).toThrow(/needs a token store with bindings/);
	});

	test("redirect URLs: the extension's own, root only", () => {
		expect(redirectUrlFits(CHROME_REDIRECT, CHROME)).toBe(true);
		expect(
			redirectUrlFits(`https://${"b".repeat(32)}.chromiumapp.org/`, CHROME),
		).toBe(false);
		expect(redirectUrlFits(`${CHROME_REDIRECT}cb`, CHROME)).toBe(false);
		expect(
			redirectUrlFits(CHROME_REDIRECT.replace("https", "http"), CHROME),
		).toBe(false);
		expect(redirectUrlFits(FIREFOX_REDIRECT, FIREFOX)).toBe(true);
		expect(redirectUrlFits(FIREFOX_REDIRECT, CHROME)).toBe(false);
		expect(
			redirectUrlFits("https://abc.extensions.allizom.org/", FIREFOX),
		).toBe(false);
		expect(redirectUrlFits(CHROME_REDIRECT, ORIGIN)).toBe(false);
		expect(redirectUrlFits("https://evil.example/", FIREFOX)).toBe(false);
	});
});

describe("backwards compatibility: only a tab that asks gets anything new", () => {
	/** The session message without what differs from one connection to the next. */
	const masked = (m: SessionMessage) => ({
		...m,
		sessionId: "",
		expiresAt: "",
		address: m.address.replace(/:\d+\//, ":0/"),
	});

	test("an old-style hello gets today's session message, byte for byte, and nothing after it", async () => {
		const secret = newSecret();
		// A relay without sign-in: what today's extensions get.
		const plain = start({ withoutSignIn: true });
		const before = await extension(plain, { secret, capabilities: null });
		const reference = masked(before.session as SessionMessage);
		before.close();
		await plain.relay.stop();

		const ctx = start();
		const old = await extension(ctx, { secret, capabilities: null });
		expect(masked(old.session as SessionMessage)).toEqual(reference);
		expect(Object.keys(old.session ?? {}).sort()).toEqual(
			Object.keys(before.session ?? {}).sort(),
		);
		expect(old.session).not.toHaveProperty("signIn");
		expect(await quietFor(old)).toEqual([]);
		// Its sign-in messages are unknown types, as on a relay without them.
		old.send({
			type: "signin.start",
			id: "x1",
			provider: "google",
			redirectUrl: CHROME_REDIRECT,
		});
		old.send({ type: "member.rename", member: "m_1", label: "x" });
		old.send({ type: "signin.out" });
		const error = (await old.next("error")) as { code: string; id?: string };
		expect(error).toEqual({
			type: "error",
			code: "unknown_type",
			message: "unknown type signin.start",
			id: "x1",
		} as never);
		expect(await quietFor(old)).toEqual([]);
		expect(ctx.logs.events("signin.started")).toEqual([]);
	});

	test("an old extension signed in before (its binding in the store) still gets nothing new", async () => {
		const ctx = start();
		const secret = newSecret();
		const fresh = await extension(ctx, { secret });
		await signIn(fresh, "google");
		fresh.close();
		await waitFor(
			() => current?.relay.sessionCount === 0,
			"the session to end",
		);
		const old = await extension(ctx, { secret, capabilities: null });
		expect(old.session).not.toHaveProperty("signIn");
		expect(await quietFor(old)).toEqual([]);
	});

	test("the capability from an app that may not sign in, or on a relay without sign-in, gets nothing new", async () => {
		const ctx = start();
		const page = await extension(ctx, { origin: ORIGIN, appId: "test" });
		expect(page.session).not.toHaveProperty("signIn");
		expect(await quietFor(page)).toEqual([]);
		await ctx.relay.stop();
		const none = start({ withoutSignIn: true });
		const tab = await extension(none);
		expect(tab.session).not.toHaveProperty("signIn");
		// The relay without sign-in has no sign-in URL either.
		const res = await fetch(`${none.relay.url}/signin?flow=x`);
		expect(res.status).toBe(404);
	});

	test("unknown capabilities are ignored; a malformed list is bad_message", async () => {
		const ctx = start();
		const tab = await extension(ctx, {
			capabilities: ["future.v9", "signin.v1"],
		});
		expect(tab.session?.signIn?.providers.map((p) => p.id)).toEqual([
			"google",
			"microsoft",
			"github",
		]);
		const other = await extension(ctx, { capabilities: ["future.v9"] });
		expect(other.session).not.toHaveProperty("signIn");
		const bad = new ScriptedTab(ctx.wsUrl, {
			origin: CHROME,
			appId: APP,
			capabilities: ["Sign In"],
		});
		tabs.push(bad);
		await bad.opened;
		bad.send({
			type: "hello",
			library: { name: "x", version: "0" },
			app: { id: APP },
			secret: bad.secret,
			capabilities: "signin.v1",
		});
		const error = (await bad.next("error")) as { code: string };
		expect(error.code).toBe("bad_message");
		expect((await bad.closed).code).toBe(1008);
	});
});

describe("signing in with Google", () => {
	test("the relay's URL, the provider, the callback: bound, told, and nothing secret in the redirect", async () => {
		const ctx = start();
		const tab = await extension(ctx, { secret: newSecret() });
		expect(tab.session?.signIn).toEqual({
			providers: [
				{ id: "google", name: "Google" },
				{ id: "microsoft", name: "Microsoft" },
				{ id: "github", name: "GitHub" },
			],
		});
		const url = await beginSignIn(tab, "google", { label: "Chrome on macOS" });
		expect(url.startsWith(`${ctx.relay.url}/signin?flow=`)).toBe(true);
		const browser = new Browser();
		const visit = await browser.get(url);
		expect(visit.status).toBe(302);
		const toProvider = new URL(visit.location);
		expect(toProvider.origin + toProvider.pathname).toBe(
			`${fakes.endpoints.googleIssuer}/authorize`,
		);
		const q = toProvider.searchParams;
		expect(q.get("client_id")).toBe(fakes.clients.google.clientId);
		expect(q.get("redirect_uri")).toBe(`${ctx.relay.url}/authorize/callback`);
		expect(q.get("scope")).toBe("openid email");
		expect(q.get("code_challenge_method")).toBe("S256");
		expect(q.get("state")?.startsWith("browser.google.")).toBe(true);
		expect(q.get("nonce")?.length).toBeGreaterThan(20);
		expect([...browser.cookies.keys()][0]).toMatch(/^tab-mcp-signin-/);
		const back = await browser.get(visit.location);
		const answer = await browser.get(back.location);
		expect(answer.status).toBe(302);
		const code = completionCode(answer.location);

		// Nothing is bound, and nothing reaches the session, before the
		// extension hands the code back.
		expect(await quietFor(tab)).toEqual([]);
		expect(await ctx.store.getBinding?.(tab.addressId, Date.now())).toBe(
			undefined,
		);
		tab.send({ type: "signin.complete", code });
		const done = (await tab.next("signin.done")) as SignInDoneMessage;
		expect(done.provider).toBe("google");
		expect(done.displayName).toBe("alice@gmail.example");
		expect(done).not.toHaveProperty("kind");
		expect(done.member).toMatch(/^m_/);
		const group = await groupWhere(tab, (g) => g.members.length === 1);
		expect(group).toMatchObject({
			type: "group",
			provider: "google",
			self: done.member,
			maxMembers: 16,
			members: [{ id: done.member, label: "Chrome on macOS", online: true }],
		});
		expect(Date.parse(group.expiresAt) - Date.now()).toBeGreaterThan(
			89 * 86_400_000,
		);

		// The store keeps a hash of the account, never the address or the e-mail.
		const binding = await ctx.store.getBinding?.(tab.addressId, Date.now());
		expect(binding?.group).toBe(
			accountKey("google", [fakes.endpoints.googleIssuer ?? "", "g-alice"]),
		);
		expect(JSON.stringify(binding)).not.toContain("alice");
		// Nor do the logs, and never a client secret.
		const all = ctx.logs.lines.join("\n");
		expect(all).not.toContain("alice@gmail.example");
		expect(all).not.toContain(fakes.clients.google.clientSecret);
		expect(ctx.logs.events("signin.bound")).toHaveLength(1);
	});

	test("an ID token for another client, with another nonce or expired binds nobody", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		for (const tamper of [
			(c: Record<string, unknown>) => ({ ...c, aud: "someone-else" }),
			(c: Record<string, unknown>) => ({ ...c, nonce: "other" }),
			(c: Record<string, unknown>) => ({ ...c, exp: 1 }),
			(c: Record<string, unknown>) => ({ ...c, iss: "https://evil.example" }),
		]) {
			fakes.tamper = tamper;
			const { answer } = await throughProvider(
				await beginSignIn(tab, "google"),
			);
			expect(answer.location).toBe(redirectError("unchecked"));
		}
		expect(await ctx.store.getBinding?.(tab.addressId, Date.now())).toBe(
			undefined,
		);
		expect(await quietFor(tab)).toEqual([]);
	});

	test("Google's issuer without the scheme is the same account", async () => {
		const ctx = start();
		const a = await extension(ctx);
		await signIn(a, "google");
		const b = await extension(ctx);
		fakes.tamper = (c) => ({
			...c,
			iss: String(c["iss"]).replace(/^http:\/\//, ""),
		});
		await signIn(b, "google");
		await groupWhere(b, (g) => g.members.length === 2);
	});

	test("the provider's refusal goes back to the extension in its redirect URL", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		fakes.deny = "access_denied";
		const { answer } = await throughProvider(await beginSignIn(tab, "google"));
		expect(answer.location).toBe(redirectError("provider_error"));
		expect(await quietFor(tab)).toEqual([]);
	});
});

describe("signing in with Microsoft", () => {
	test("a work account: tid and oid are the key, the issuer is the token's own tenant", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		const url = await beginSignIn(tab, "microsoft");
		const browser = new Browser();
		const visit = await browser.get(url);
		const q = new URL(visit.location).searchParams;
		expect(q.get("scope")).toBe("openid profile");
		expect(
			visit.location.startsWith(
				`${fakes.endpoints.microsoftAuthority}/common/`,
			),
		).toBe(true);
		const back = await browser.get(visit.location);
		const code = completionCode((await browser.get(back.location)).location);
		tab.send({ type: "signin.complete", code });
		const done = (await tab.next("signin.done")) as SignInDoneMessage;
		expect(done.displayName).toBe("alice@contoso.example");
		expect(done.kind).toBe("work");
		expect(
			(await ctx.store.getBinding?.(tab.addressId, Date.now()))?.group,
		).toBe(accountKey("microsoft", [fakes.microsoft.tid, fakes.microsoft.oid]));
	});

	test("a personal account (tenant 9188040d-…) is accepted and called personal", async () => {
		const ctx = start();
		fakes.microsoft = {
			tid: MICROSOFT_PERSONAL_TENANT,
			oid: "00000000-0000-0000-2222-000000000002",
			preferred_username: "alice@outlook.example",
		};
		const tab = await extension(ctx);
		const done = await signIn(tab, "microsoft");
		expect(done.displayName).toBe("alice@outlook.example");
		expect(done.kind).toBe("personal");
	});

	test("one address as a personal and as a work account: two groups, the same name, told apart by kind", async () => {
		const ctx = start();
		const name = "alice@contoso.example";
		fakes.microsoft = {
			tid: MICROSOFT_PERSONAL_TENANT,
			oid: "00000000-0000-0000-3333-000000000003",
			preferred_username: name,
		};
		const home = await extension(ctx);
		const personal = await signIn(home, "microsoft");
		fakes.microsoft = {
			tid: "72f988bf-86f1-41af-91ab-2d7cd011db47",
			oid: "00000000-0000-0000-4444-000000000004",
			preferred_username: name,
		};
		const office = await extension(ctx);
		const work = await signIn(office, "microsoft");
		expect(personal.displayName).toBe(work.displayName);
		expect([personal.kind, work.kind]).toEqual(["personal", "work"]);
		await groupWhere(home, (g) => g.members.length === 1);
		await groupWhere(office, (g) => g.members.length === 1);
		const a = await ctx.store.getBinding?.(home.addressId, Date.now());
		const b = await ctx.store.getBinding?.(office.addressId, Date.now());
		expect(a?.group).not.toBe(b?.group);
	});

	test("an issuer of another tenant than the token's tid is refused", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		const other = "11111111-2222-3333-4444-555555555555";
		for (const tamper of [
			(c: Record<string, unknown>) => ({
				...c,
				iss: String(c["iss"]).replace(String(c["tid"]), other),
			}),
			(c: Record<string, unknown>) => ({ ...c, tid: other }),
			(c: Record<string, unknown>) => ({
				...c,
				iss: String(c["iss"]).replace(String(c["tid"]), "{tenantid}"),
			}),
			(c: Record<string, unknown>) => ({ ...c, tid: "../evil" }),
		]) {
			fakes.tamper = tamper;
			const { answer } = await throughProvider(
				await beginSignIn(tab, "microsoft"),
			);
			expect(answer.location).toBe(redirectError("unchecked"));
		}
		expect(ctx.logs.events("signin.unchecked").map((e) => e["reason"])).toEqual(
			["id_token_iss", "id_token_iss", "id_token_iss", "id_token_iss"],
		);
	});

	test("the same oid with another sub (another app's) is the same member's group", async () => {
		const ctx = start();
		const a = await extension(ctx);
		await signIn(a, "microsoft");
		const b = await extension(ctx);
		fakes.tamper = (c) => ({ ...c, sub: "a-different-pairwise-sub" });
		await signIn(b, "microsoft");
		await groupWhere(b, (g) => g.members.length === 2);
	});
});

describe("signing in with GitHub", () => {
	test("PKCE and state, the numeric id is the key, the login the name; the token is used once", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		const url = await beginSignIn(tab, "github");
		const browser = new Browser();
		const visit = await browser.get(url);
		const q = new URL(visit.location).searchParams;
		expect(
			visit.location.startsWith(
				`${fakes.endpoints.githubOrigin}/login/oauth/authorize?`,
			),
		).toBe(true);
		expect(q.get("scope")).toBe(null);
		expect(q.get("code_challenge_method")).toBe("S256");
		expect(q.get("state")?.startsWith("browser.github.")).toBe(true);
		const back = await browser.get(visit.location);
		const code = completionCode((await browser.get(back.location)).location);
		tab.send({ type: "signin.complete", code });
		const done = (await tab.next("signin.done")) as SignInDoneMessage;
		expect(done.displayName).toBe("alice");
		expect(fakes.githubUserRequests).toHaveLength(1);
		const form = fakes.tokenRequests.at(-1)?.form;
		expect(form?.get("code_verifier")?.length).toBeGreaterThan(40);
		expect(
			(await ctx.store.getBinding?.(tab.addressId, Date.now()))?.group,
		).toBe(accountKey("github", ["1001"]));
	});

	test("a new login name is the same account; another id is another", async () => {
		const ctx = start();
		const a = await extension(ctx);
		await signIn(a, "github");
		fakes.github = { id: 1001, login: "alice-renamed" };
		const b = await extension(ctx);
		expect((await signIn(b, "github")).displayName).toBe("alice-renamed");
		await groupWhere(b, (g) => g.members.length === 2);
		fakes.github = { id: 2002, login: "alice" };
		const c = await extension(ctx);
		await signIn(c, "github");
		await groupWhere(c, (g) => g.members.length === 1);
	});

	test("GitHub's refusal of the code (HTTP 200 with error) binds nobody", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		fakes.githubTokenError = "bad_verification_code";
		const { answer } = await throughProvider(await beginSignIn(tab, "github"));
		expect(answer.location).toBe(redirectError("unchecked"));
		expect(ctx.logs.events("signin.unchecked")[0]?.["reason"]).toBe(
			"token_bad_verification_code",
		);
	});

	test("Firefox: the allizom redirect URL", async () => {
		const ctx = start();
		const tab = await extension(ctx, {
			origin: FIREFOX,
			appId: "tab-mcp-extension-firefox",
		});
		await signIn(tab, "github", { redirectUrl: FIREFOX_REDIRECT });
	});
});

describe("flows: single use, short-lived, bound to their session and browser", () => {
	test("the relay's URL works once; the callback works once", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		const url = await beginSignIn(tab, "google");
		const browser = new Browser();
		const visit = await browser.get(url);
		expect((await browser.get(url)).status).toBe(400);
		const back = await browser.get(visit.location);
		const code = completionCode((await browser.get(back.location)).location);
		const replay = await browser.get(back.location);
		expect(replay.status).toBe(400);
		expect(replay.text).toContain("expired or was already used");
		tab.send({ type: "signin.complete", code });
		await tab.next("signin.done");
	});

	test("the completion code: once, two minutes, only for the session whose flow made it", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		const stranger = await extension(ctx);
		const code = await checkedCode(tab, "google");
		// Another session with the code (it never sees it, but say it got it).
		stranger.send({ type: "signin.complete", code });
		const refused = (await stranger.next(
			"signin.failed",
		)) as SignInFailedMessage;
		expect(refused.reason).toBe("code_refused");
		expect(refused).not.toHaveProperty("displayName");
		expect(await ctx.store.getBinding?.(stranger.addressId, Date.now())).toBe(
			undefined,
		);
		// The code is spent by any use: the right session cannot use it after.
		tab.send({ type: "signin.complete", code });
		expect(
			((await tab.next("signin.failed")) as SignInFailedMessage).reason,
		).toBe("code_refused");
		expect(await ctx.store.getBinding?.(tab.addressId, Date.now())).toBe(
			undefined,
		);
		// A used one is refused.
		const second = await checkedCode(tab, "google");
		tab.send({ type: "signin.complete", code: second });
		await tab.next("signin.done");
		tab.send({ type: "signin.complete", code: second });
		expect(
			((await tab.next("signin.failed")) as SignInFailedMessage).reason,
		).toBe("code_refused");
		// A made-up code is refused.
		tab.send({ type: "signin.complete", code: "x".repeat(32) });
		expect(
			((await tab.next("signin.failed")) as SignInFailedMessage).reason,
		).toBe("code_refused");
		// An expired one is refused. Last: the clock only moves forward here
		// (a session's control budget does not take a clock going back).
		const late = await checkedCode(tab, "github");
		setSystemTime(Date.now() + 2 * 60_000 + 1);
		try {
			tab.send({ type: "signin.complete", code: late });
			expect(
				((await tab.next("signin.failed")) as SignInFailedMessage).reason,
			).toBe("code_refused");
			expect(
				(await ctx.store.getBinding?.(tab.addressId, Date.now()))?.provider,
			).toBe("google");
		} finally {
			setSystemTime();
		}
	});

	test("someone else's link finished in a victim's browser binds nothing and tells the stranger nothing", async () => {
		const ctx = start();
		const stranger = await extension(ctx);
		const url = await beginSignIn(stranger, "google");
		// The victim opens the link and signs in, in their own browser.
		const { answer } = await throughProvider(url, new Browser());
		// The code lands in the victim's address bar, not in the stranger's session.
		completionCode(answer.location);
		expect(await quietFor(stranger)).toEqual([]);
		expect(await ctx.store.getBinding?.(stranger.addressId, Date.now())).toBe(
			undefined,
		);
		expect(ctx.logs.lines.join("\n")).not.toContain("alice@gmail.example");
	});

	test("a callback in another browser (no cookie) is refused with an error page", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		const url = await beginSignIn(tab, "google");
		const attacker = new Browser();
		const visit = await attacker.get(url);
		const back = await attacker.get(visit.location);
		const victim = new Browser();
		const answer = await victim.get(back.location);
		expect(answer.status).toBe(403);
		expect(answer.location).toBe("");
		expect(await quietFor(tab)).toEqual([]);
		expect(await ctx.store.getBinding?.(tab.addressId, Date.now())).toBe(
			undefined,
		);
	});

	test("a new start replaces the session's open flow", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		const first = await beginSignIn(tab, "google");
		await beginSignIn(tab, "github");
		expect((await new Browser().get(first)).status).toBe(400);
	});

	test("a flow ends after ten minutes", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		const url = await beginSignIn(tab, "google");
		const real = Date.now;
		Date.now = () => real() + 10 * 60_000 + 1;
		try {
			expect((await new Browser().get(url)).status).toBe(400);
		} finally {
			Date.now = real;
		}
	});

	test("the session gone: the callback fails cleanly and binds nobody", async () => {
		const ctx = start();
		const tab = await extension(ctx, { secret: newSecret() });
		const url = await beginSignIn(tab, "google");
		const browser = new Browser();
		const visit = await browser.get(url);
		const back = await browser.get(visit.location);
		tab.close();
		await waitFor(() => ctx.relay.sessionCount === 0, "the session to end");
		const redeemed = fakes.tokenRequests.length;
		const answer = await browser.get(back.location);
		expect(answer.location).toBe(redirectError("session_gone"));
		expect(await ctx.store.getBinding?.(tab.addressId, Date.now())).toBe(
			undefined,
		);
		expect(
			ctx.logs
				.events("signin.failed")
				.some((e) => e["reason"] === "session_gone"),
		).toBe(true);
		// The code was never redeemed.
		expect(fakes.tokenRequests.length).toBe(redeemed);
	});

	test("a session replaced by a newer one of the same address cannot finish the old flow", async () => {
		const ctx = start();
		const secret = newSecret();
		const tab = await extension(ctx, { secret });
		const url = await beginSignIn(tab, "google");
		const browser = new Browser();
		const visit = await browser.get(url);
		const back = await browser.get(visit.location);
		const newer = await extension(ctx, { secret });
		expect((await browser.get(back.location)).location).toBe(
			redirectError("session_gone"),
		);
		expect(await quietFor(newer)).toEqual([]);
	});

	test("a session replaced after the callback cannot complete, and the newer one cannot use the code", async () => {
		const ctx = start();
		const secret = newSecret();
		const tab = await extension(ctx, { secret });
		const code = await checkedCode(tab, "google");
		const newer = await extension(ctx, { secret });
		newer.send({ type: "signin.complete", code });
		expect(
			((await newer.next("signin.failed")) as SignInFailedMessage).reason,
		).toBe("code_refused");
		expect(await ctx.store.getBinding?.(newer.addressId, Date.now())).toBe(
			undefined,
		);
	});

	test("refused starts: an unknown provider, another extension's redirect URL, a web page", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		const reasons: string[] = [];
		for (const [provider, redirectUrl] of [
			["facebook", CHROME_REDIRECT],
			["google", `https://${"b".repeat(32)}.chromiumapp.org/`],
			["google", "https://evil.example/"],
		]) {
			tab.send({ type: "signin.start", provider, redirectUrl });
			reasons.push(
				((await tab.next("signin.failed")) as SignInFailedMessage).reason,
			);
		}
		expect(reasons).toEqual(["not_offered", "bad_redirect", "bad_redirect"]);
		// A web page whose app may sign in is no extension: no redirect fits.
		const page = await extension(ctx, { origin: ORIGIN });
		page.send({
			type: "signin.start",
			provider: "google",
			redirectUrl: CHROME_REDIRECT,
		});
		expect(
			((await page.next("signin.failed")) as SignInFailedMessage).reason,
		).toBe("bad_redirect");
	});

	test("an unknown browser state gets the extension's text, other states go to identity binding", async () => {
		const ctx = start();
		const browser = await fetch(
			`${ctx.relay.url}/authorize/callback?state=browser.google.nope&code=x`,
		);
		expect(browser.status).toBe(400);
		expect(await browser.text()).toContain("browser extension");
		// Without identity binding the other callbacks are 404, as before.
		const other = await fetch(
			`${ctx.relay.url}/authorize/callback?state=abc&code=x`,
		);
		expect(other.status).toBe(404);
	});
});

describe("the binding: sign-out, reconnecting, 90 days", () => {
	test("sign-out ends the binding; the others hear of it", async () => {
		const ctx = start();
		const a = await extension(ctx);
		const b = await extension(ctx);
		await signIn(a, "google", { label: "A" });
		await signIn(b, "google", { label: "B" });
		await groupWhere(a, (g) => g.members.length === 2);
		b.send({ type: "signin.out" });
		expect(await b.next("signin.ended")).toEqual({
			type: "signin.ended",
			reason: "signed_out",
		});
		expect(await ctx.store.getBinding?.(b.addressId, Date.now())).toBe(
			undefined,
		);
		const after = await groupWhere(a, (g) => g.members.length === 1);
		expect(after.members[0]?.label).toBe("A");
	});

	test("the binding survives a reconnect: session names the member, the group follows, the others see it online", async () => {
		const ctx = start();
		const secret = newSecret();
		const a = await extension(ctx);
		const b = await extension(ctx, { secret });
		await signIn(a, "google");
		const done = await signIn(b, "google");
		await groupWhere(a, (g) => g.members.every((m) => m.online));
		b.close();
		await groupWhere(
			a,
			(g) => g.members.find((m) => m.id === done.member)?.online === false,
		);
		const again = await extension(ctx, { secret });
		expect(again.session?.signIn?.member).toBe(done.member);
		const state = await groupWhere(again, () => true);
		expect(state.self).toBe(done.member);
		await groupWhere(
			a,
			(g) => g.members.find((m) => m.id === done.member)?.online === true,
		);
	});

	test("signing in again with the same account keeps the member and its name, and renews the 90 days", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		const first = await signIn(tab, "google", { label: "Mine" });
		const before = await ctx.store.getBinding?.(tab.addressId, Date.now());
		await Bun.sleep(5);
		const second = await signIn(tab, "google", { label: "Ignored" });
		expect(second.member).toBe(first.member);
		const after = await ctx.store.getBinding?.(tab.addressId, Date.now());
		expect(after?.label).toBe("Mine");
		expect(after?.expiresAt).toBeGreaterThan(before?.expiresAt ?? 0);
	});

	test("signing in with another account moves the browser to that group", async () => {
		const ctx = start();
		const a = await extension(ctx);
		const b = await extension(ctx);
		await signIn(a, "google");
		await signIn(b, "google");
		await groupWhere(a, (g) => g.members.length === 2);
		await signIn(b, "github");
		await groupWhere(a, (g) => g.members.length === 1);
		const own = await groupWhere(b, (g) => g.provider === "github");
		expect(own.members).toHaveLength(1);
	});

	test("after 90 days (here shortened) the browser is signed out and told", async () => {
		const ctx = start({ sweepIntervalMs: 50 }, { bindingLifetimeMs: 400 });
		const secret = newSecret();
		const tab = await extension(ctx, { secret });
		await signIn(tab, "google");
		expect(await tab.next("signin.ended")).toEqual({
			type: "signin.ended",
			reason: "expired",
		});
		expect(await ctx.store.getBinding?.(tab.addressId, Date.now())).toBe(
			undefined,
		);
		tab.close();
		const again = await extension(ctx, { secret });
		expect(again.session?.signIn?.member).toBe(undefined);
	});

	test("the real lifetime is 90 days", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		await signIn(tab, "google");
		const b = await ctx.store.getBinding?.(tab.addressId, Date.now());
		expect((b?.expiresAt ?? 0) - (b?.createdAt ?? 0)).toBe(90 * 86_400_000);
	});

	test("a signed-in browser is not closed early as unpaired", async () => {
		const ctx = start({ unpairedIdleTimeoutMs: 300, heartbeatMs: 100 });
		const tab = await extension(ctx);
		await signIn(tab, "google");
		await Bun.sleep(600);
		expect(tab.ws.readyState).toBe(WebSocket.OPEN);
	});
});

describe("the group", () => {
	test("every member gets the state on a change and when a member connects; ids reveal no address", async () => {
		const ctx = start();
		const a = await extension(ctx);
		await signIn(a, "google", { label: "Chrome on macOS" });
		const b = await extension(ctx);
		await signIn(b, "google", { label: "Firefox on Windows" });
		const seenByA = await groupWhere(a, (g) => g.members.length === 2);
		const seenByB = await groupWhere(b, (g) => g.members.length === 2);
		expect(seenByA.members).toEqual(seenByB.members);
		expect(seenByA.self).not.toBe(seenByB.self);
		const text = JSON.stringify(seenByA);
		for (const t of [a, b]) {
			expect(text).not.toContain(t.addressId);
			expect(text).not.toContain(t.addressId.slice(0, 8));
		}
		expect(seenByA.members.map((m) => m.label)).toEqual([
			"Chrome on macOS",
			"Firefox on Windows",
		]);
	});

	test("any member renames any member; labels are cleaned", async () => {
		const ctx = start();
		const a = await extension(ctx);
		const b = await extension(ctx);
		const da = await signIn(a, "google");
		const db = await signIn(b, "google");
		expect(
			(await groupWhere(a, (g) => g.members.length === 2)).members[0]?.label,
		).toBe("Browser");
		a.send({ type: "member.rename", member: db.member, label: "work​ Chrome" });
		for (const t of [a, b]) {
			await groupWhere(
				t,
				(g) =>
					g.members.find((m) => m.id === db.member)?.label === "work Chrome",
			);
		}
		b.send({ type: "member.rename", member: da.member, label: "home" });
		await groupWhere(
			a,
			(g) => g.members.find((m) => m.id === da.member)?.label === "home",
		);
		// A member of another group is unknown here.
		const c = await extension(ctx);
		await signIn(c, "github");
		c.send({ type: "member.rename", member: da.member, label: "mine" });
		expect(await c.next("error")).toMatchObject({
			code: "unknown_id",
			for: "member.rename",
			member: da.member,
		});
	});

	test("any member removes any member: its binding ends and it is told", async () => {
		const ctx = start();
		const a = await extension(ctx);
		const b = await extension(ctx);
		await signIn(a, "google");
		const db = await signIn(b, "google");
		await groupWhere(a, (g) => g.members.length === 2);
		a.send({ type: "member.remove", member: db.member });
		expect(await b.next("signin.ended")).toEqual({
			type: "signin.ended",
			reason: "removed",
		});
		expect(await ctx.store.getBinding?.(b.addressId, Date.now())).toBe(
			undefined,
		);
		await groupWhere(a, (g) => g.members.length === 1);
		// The removed browser may sign in again.
		await signIn(b, "google");
		await groupWhere(a, (g) => g.members.length === 2);
		// Removing an offline member: it finds itself signed out when it connects.
		a.send({ type: "member.remove", member: "m_nobody" });
		expect(await a.next("error")).toMatchObject({
			code: "unknown_id",
			for: "member.remove",
		});
	});

	test("a browser that is not signed in cannot rename or remove", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		tab.send({ type: "member.remove", member: "m_x" });
		expect(await tab.next("error")).toMatchObject({
			code: "unknown_id",
			for: "member.remove",
			member: "m_x",
		});
	});

	test("16 members; the 17th sign-in is refused with the reason", async () => {
		const ctx = start({ maxSessionsPerIp: 40, maxSessions: 40 });
		const members: ScriptedTab[] = [];
		for (let i = 0; i < 16; i++) {
			const t = await extension(ctx);
			await signIn(t, "github", { label: `browser ${i}` });
			members.push(t);
		}
		const extra = await extension(ctx);
		extra.send({
			type: "signin.complete",
			code: await checkedCode(extra, "github"),
		});
		const failed = (await extra.next("signin.failed")) as SignInFailedMessage;
		expect(failed.reason).toBe("group_full");
		expect(failed.message).toContain("16 browsers");
		expect(
			await ctx.store.listBindings?.(
				accountKey("github", ["1001"]),
				Date.now(),
			),
		).toHaveLength(16);
		// A member signing in again takes no new place.
		await signIn(members[0] as ScriptedTab, "github");
	});
});

describe("a failing store", () => {
	test("a sign-in that cannot be saved fails with the reason; a sign-out that cannot be saved is refused and kept", async () => {
		const store = new MemoryTokenStore();
		let failing = false;
		const flaky = new Proxy(store, {
			get(target, name, receiver) {
				const value = Reflect.get(target, name, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					if (failing && typeof name === "string" && name.endsWith("Binding")) {
						return Promise.reject(new Error("disk full"));
					}
					return value.apply(target, args);
				};
			},
		});
		const ctx = start({ store: flaky });
		const tab = await extension(ctx);
		failing = true;
		tab.send({
			type: "signin.complete",
			code: await checkedCode(tab, "google"),
		});
		expect(
			((await tab.next("signin.failed")) as SignInFailedMessage).reason,
		).toBe("store_unavailable");
		failing = false;
		await signIn(tab, "google");
		failing = true;
		tab.send({ type: "signin.out" });
		expect(await tab.next("error")).toMatchObject({
			code: "store_unavailable",
			for: "signin.out",
		});
		failing = false;
		expect(await store.getBinding(tab.addressId, Date.now())).toBeDefined();
		expect(ctx.logs.events("store.error").map((e) => e["op"])).toEqual([
			"putBinding",
			"deleteBinding",
		]);
	});
});

describe("limits", () => {
	test("sign-in starts per session: 5, then rate_limited", async () => {
		const ctx = start();
		const tab = await extension(ctx);
		for (let i = 0; i < 5; i++) await beginSignIn(tab, "google");
		tab.send({
			type: "signin.start",
			provider: "google",
			redirectUrl: CHROME_REDIRECT,
		});
		expect(
			((await tab.next("signin.failed")) as SignInFailedMessage).reason,
		).toBe("rate_limited");
	});

	test("sign-in starts per network: 20 across sessions, then rate_limited", async () => {
		const ctx = start();
		// Four sessions of five each: within every session's own limit.
		for (let s = 0; s < 4; s++) {
			const tab = await extension(ctx);
			for (let i = 0; i < 5; i++) await beginSignIn(tab, "google");
		}
		const last = await extension(ctx);
		last.send({
			type: "signin.start",
			provider: "google",
			redirectUrl: CHROME_REDIRECT,
		});
		expect(
			((await last.next("signin.failed")) as SignInFailedMessage).reason,
		).toBe("rate_limited");
		expect(ctx.logs.events("signin.rate_limited")[0]?.["limit"]).toBe(
			"signin_starts",
		);
	});
});
