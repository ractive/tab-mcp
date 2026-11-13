/**
 * Iteration 30: what the pairing page and the logs show (review of
 * 2026-11-13, iteration B; kb/research/review-2026-11-13.md), one block per
 * finding id. RS 11 and RS 12 are in identity.test.ts, next to the OIDC
 * fixture.
 */
import { Database } from "bun:sqlite";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { join } from "node:path";
import {
	ConfigError,
	configFromEnv,
	describeConfigError,
	resolveConfig,
	unknownEnvNames,
} from "../src/config.ts";
import { errorFields, truncateKey } from "../src/log.ts";
import { AUTHORIZE_CSS } from "../src/oauth/html.ts";
import { ProviderDiscovery } from "../src/oauth/oidc.ts";
import type { SessionMessage } from "../src/protocol.ts";
import { RateLimiter } from "../src/ratelimit.ts";
import type { CreateRelayOptions, RelayTestHooks } from "../src/relay.ts";
import { guardStore, StoreFailure } from "../src/store/guard.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import type {
	RevokeOptions,
	RevokeSelector,
	TokenRecord,
} from "../src/store/types.ts";
import {
	mcpPost,
	ORIGIN,
	rpc,
	ScriptedTab,
	startRelay,
	type TestRelay,
	tokenFor,
	waitFor,
} from "./helpers.ts";
import {
	type AuthorizePage,
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
let v6ClientId: string;
const REDIRECT = "http://127.0.0.1:4567/callback";
const relays: (TestRelay | OAuthTestRelay)[] = [];
const tabs: ScriptedTab[] = [];

beforeAll(async () => {
	cimd = await startCimdServer();
	clientId = cimd.serve(
		"/client.json",
		cimd.document(`${cimd.origin}/client.json`),
	);
	v6ClientId = cimd.serve(
		"/v6.json",
		cimd.document(`${cimd.origin}/v6.json`, {
			redirect_uris: ["http://[::1]/callback"],
		}),
	);
});
afterAll(() => cimd.stop());
afterEach(async () => {
	for (const t of tabs.splice(0)) if (t.ws.readyState <= 1) t.close();
	for (const r of relays.splice(0)) await r.stop();
});

function relay(options: CreateRelayOptions = {}): TestRelay {
	const r = startRelay(options);
	relays.push(r);
	return r;
}

function oauthRelay(
	options: CreateRelayOptions = {},
	hooks: RelayTestHooks = {},
): OAuthTestRelay {
	const r = startOAuthRelay(cimd, options, hooks);
	relays.push(r);
	return r;
}

function tab(
	r: { wsUrl: string },
	options: ConstructorParameters<typeof ScriptedTab>[1] = {},
): ScriptedTab {
	const t = new ScriptedTab(r.wsUrl, options);
	tabs.push(t);
	return t;
}

function open(
	r: OAuthTestRelay,
	address: string,
	browser = new TestBrowser(r.url),
	params: Record<string, string> = {},
): Promise<AuthorizePage & { location?: string }> {
	return browser.open(
		authorizeUrl(r.url, {
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_challenge: pkce().challenge,
			resource: address,
			...params,
		}),
	);
}

/** Pair with the tab's code; the code's tokens. */
async function pair(
	r: OAuthTestRelay,
	t: ScriptedTab,
): Promise<{ access_token: string; refresh_token: string }> {
	const { verifier, challenge } = pkce();
	const browser = new TestBrowser(r.url);
	const page = await open(r, t.session?.address ?? "", browser, {
		code_challenge: challenge,
	});
	const done = await browser.submit(page, {
		action: "connect",
		code: t.pairingCode ?? "",
	});
	expect(done.status).toBe(303);
	const code = new URL(done.location ?? "").searchParams.get("code") ?? "";
	const res = await postForm(`${r.url}/token`, {
		grant_type: "authorization_code",
		code,
		redirect_uri: REDIRECT,
		code_verifier: verifier,
		client_id: clientId,
		resource: t.session?.address ?? "",
	});
	expect(res.status).toBe(200);
	return (await res.json()) as { access_token: string; refresh_token: string };
}

describe("RS 6: on an open relay the page origin is a serialised origin or nothing", () => {
	const cases: [string, string][] = [
		["https://ractive.ch (verified by the relay)", ""],
		[`https://${"a".repeat(300)}.example`, ""],
		["https://RACTIVE.ch", ""],
		["https://ractive.ch/", ""],
		["null", ""],
		["https://ok.example", "https://ok.example"],
		["http://localhost:5173", "http://localhost:5173"],
		[
			`chrome-extension://${"a".repeat(32)}`,
			`chrome-extension://${"a".repeat(32)}`,
		],
	];
	for (const [sent, kept] of cases) {
		test(`${sent.slice(0, 50)} -> ${kept === "" ? "no origin" : "kept"}`, async () => {
			const r = relay({ allowedOrigins: "*" });
			const t = tab(r, { origin: sent });
			const session = await t.connect();
			expect(session.origin).toBe(kept);
			expect(r.logs.events("tab.session").at(-1)?.["origin"]).toBe(kept);
		});
	}

	test("a listed origin is kept as listed", async () => {
		const r = relay();
		const session = await tab(r).connect();
		expect(session.origin).toBe(ORIGIN);
	});

	test("the pairing page names no origin for free text", async () => {
		const r = oauthRelay({ allowedOrigins: "*" });
		const t = tab(r, { origin: "https://ractive.ch (verified by the relay)" });
		await t.connect();
		await t.startPairing();
		const page = await open(r, t.session?.address ?? "");
		expect(page.status).toBe(200);
		expect(page.html).not.toContain("verified by the relay");
		expect(page.html).toContain("a page that did not say where it runs");
	});
});

describe("RS 7: the page's app name is cleaned and may not name another domain", () => {
	test("bidi and invisible characters are removed", async () => {
		const r = relay();
		const session = await tab(r, {
			app: "My​ App‮",
		}).connect();
		expect(session.appName).toBe("My App");
	});

	test("a name with a foreign domain is dropped and logged", async () => {
		const r = oauthRelay();
		const t = tab(r, { app: "saturnus on https://ractive.ch‮" });
		const session = (await t.connect()) as SessionMessage;
		expect(session.appName).toBeUndefined();
		expect(r.logs.events("tab.session").at(-1)?.["appNameDropped"]).toBe(true);
		await t.startPairing();
		const page = await open(r, t.session?.address ?? "");
		expect(page.html).not.toContain("saturnus");
		expect(page.html).toContain(`tools from <span class="origin">${ORIGIN}`);
	});

	test("the page's own host in its name is kept", async () => {
		const r = relay();
		const session = await tab(r, { app: "Tools of page.example" }).connect();
		expect(session.appName).toBe("Tools of page.example");
	});

	test("a name that is only invisible characters is no name", async () => {
		const r = relay();
		const session = await tab(r, { app: "​⠀" }).connect();
		expect(session.appName).toBeUndefined();
	});

	test("names and origins are isolated from the text around them", () => {
		expect(AUTHORIZE_CSS).toContain(
			"strong, .origin { unicode-bidi: isolate; }",
		);
	});
});

describe("RS 9: a network's share of an address's code guesses counts an IPv6 /56", () => {
	test("a second /64 of the same /56 gets no new share", async () => {
		const r = oauthRelay({ trustProxy: "x-real-ip" });
		const t = tab(r);
		await t.connect();
		await t.startPairing();
		const address = t.session?.address ?? "";
		const guess = async (ip: string) => {
			const browser = new TestBrowser(r.url, { "x-real-ip": ip });
			const page = await open(r, address, browser);
			const wrong = t.pairingCode === "000000" ? "000001" : "000000";
			return browser.submit(page, { action: "connect", code: wrong });
		};
		for (let i = 0; i < 10; i++) {
			const res = await guess("2001:db8:1:100::1");
			expect(res.status).toBe(400);
		}
		const other = await guess("2001:db8:1:1ff::1");
		expect(other.status).toBe(429);
		expect(other.html).toContain("Too many attempts for this page");
		// Another /56 still has its own share.
		const elsewhere = await guess("2001:db8:1:200::1");
		expect(elsewhere.status).toBe(400);
	});
});

describe("RS 10: one page for a closed page and a closed dialog", () => {
	test("both answer the same text", async () => {
		const r = oauthRelay();
		const t = tab(r);
		await t.connect();
		const dialogClosed = await open(r, t.session?.address ?? "");
		const gone = tab(r);
		await gone.connect();
		const address = gone.session?.address ?? "";
		gone.close();
		await waitFor(() => r.relay.sessionCount === 1, "the tab to close");
		const notOpen = await open(r, address);
		const text = (html: string) =>
			[...html.matchAll(/<(h1|p)>([\s\S]*?)<\/\1>/g)].map((m) => m[2]);
		expect(dialogClosed.status).toBe(notOpen.status);
		expect(text(dialogClosed.html)).toEqual(text(notOpen.html));
		expect(dialogClosed.html).not.toContain("Open “Connect your AI app” first");
	});
});

describe("RS 17: the visit cookie is renewed with every pairing page", () => {
	test("a second request in the same visit sends the same id with a fresh Max-Age", async () => {
		const r = oauthRelay();
		const t = tab(r);
		await t.connect();
		await t.startPairing();
		const browser = new TestBrowser(r.url);
		const first = await open(r, t.session?.address ?? "", browser);
		const cookie = first.headers.getSetCookie()[0] ?? "";
		const id = /=([^;]+);/.exec(cookie)?.[1];
		expect(id).toBeDefined();
		const second = await open(r, t.session?.address ?? "", browser);
		const renewed = second.headers.getSetCookie()[0] ?? "";
		expect(renewed).toContain(`=${id};`);
		expect(renewed).toContain("Max-Age=600");
		// A page sent again after a post renews it too.
		const retry = await browser.submit(second, { action: "retry" });
		expect(retry.headers.getSetCookie()[0]).toContain(`=${id};`);
	});
});

describe("RS 18: a redirect to [::1] is allowed by form-action as a scheme source", () => {
	test("form-action gets http: instead of an IPv6 literal Chrome drops", async () => {
		const r = oauthRelay();
		const t = tab(r);
		await t.connect();
		await t.startPairing();
		const page = await open(r, t.session?.address ?? "", undefined, {
			client_id: v6ClientId,
			redirect_uri: "http://[::1]:4567/callback",
		});
		expect(page.status).toBe(200);
		const csp = page.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("form-action 'self' http:");
		expect(csp).not.toContain("[::1]");
	});

	test("other loopback redirects keep their origin", async () => {
		const r = oauthRelay();
		const t = tab(r);
		await t.connect();
		await t.startPairing();
		const page = await open(r, t.session?.address ?? "");
		expect(page.headers.get("content-security-policy")).toContain(
			"form-action 'self' http://127.0.0.1:4567",
		);
	});
});

describe("RQ 4: errors are logged with their code; a failed start says why", () => {
	test("errorFields adds a code of the usual shape and nothing else", () => {
		let sqlite: unknown;
		try {
			new Database("/nonexistent-dir-for-test/x.db");
		} catch (error) {
			sqlite = error;
		}
		expect(errorFields(sqlite)).toEqual({
			error: "SQLiteError",
			errorCode: "SQLITE_CANTOPEN",
		});
		const odd = Object.assign(new Error("x"), { code: "not a code; drop" });
		expect(errorFields(odd)).toEqual({ error: "Error" });
		expect(errorFields("text")).toEqual({ error: "string" });
		const wrapped = new StoreFailure(
			"put",
			Object.assign(new Error("disk"), { code: "SQLITE_FULL" }),
		);
		expect(errorFields(wrapped)).toEqual({
			error: "Error",
			errorCode: "SQLITE_FULL",
		});
	});

	test("the command prints the message of an error at start and exits 1", async () => {
		const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts")], {
			env: {
				PATH: process.env["PATH"] ?? "",
				NODE_ENV: "development",
				TAB_MCP_PORT: "0",
				TAB_MCP_HOST: "127.0.0.1",
				TAB_MCP_SQLITE_PATH: "/nonexistent-dir-for-test/tab-mcp.db",
				TAB_MCP_MAX_SESION: "5",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, out, err] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(code).toBe(1);
		expect(err).toContain("tab-mcp: could not start:");
		expect(err).toContain("SQLITE_CANTOPEN");
		const lines = out
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		expect(
			lines.find((l) => l["event"] === "relay.start_failed"),
		).toMatchObject({ error: "SQLiteError", errorCode: "SQLITE_CANTOPEN" });
		// RQ 11: a misspelled setting is named at start.
		expect(
			lines.find((l) => l["event"] === "relay.unknown_setting"),
		).toMatchObject({ name: "TAB_MCP_MAX_SESION" });
		expect(lines.some((l) => l["event"] === "process.uncaught_exception")).toBe(
			false,
		);
	});

	test("a configuration error names the variable", async () => {
		const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts")], {
			env: {
				PATH: process.env["PATH"] ?? "",
				NODE_ENV: "development",
				TAB_MCP_MAX_SESSIONS: "0",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, err] = await Promise.all([
			proc.exited,
			new Response(proc.stderr).text(),
		]);
		expect(code).toBe(2);
		expect(err).toContain(
			"configuration error: TAB_MCP_MAX_SESSIONS: maxSessions must be a positive number",
		);
	});
});

/** A memory store whose methods throw while `failing` names them. */
class BrokenStore extends MemoryTokenStore {
	failing = new Set<string>();
	#fail(method: string): void {
		if (this.failing.has(method)) {
			throw Object.assign(new Error("I/O error"), { code: "SQLITE_IOERR" });
		}
	}
	override async get(hash: string): Promise<TokenRecord | undefined> {
		this.#fail("get");
		return super.get(hash);
	}
	override async revoke(
		selector: RevokeSelector,
		options: RevokeOptions,
	): Promise<number> {
		this.#fail("revoke");
		return super.revoke(selector, options);
	}
}

describe("RQ 5: a store failure is store.error wherever it happens", () => {
	test("at /token: store.error with op and code, 503, no oauth.error", async () => {
		const store = new BrokenStore();
		const r = oauthRelay({ store });
		const t = tab(r);
		await t.connect();
		await t.startPairing();
		const tokens = await pair(r, t);
		store.failing.add("get");
		const res = await postForm(`${r.url}/token`, {
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
			client_id: clientId,
		});
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).toBe("10");
		expect(r.logs.events("store.error").at(-1)).toMatchObject({
			op: "token",
			error: "Error",
			errorCode: "SQLITE_IOERR",
		});
		expect(r.logs.events("oauth.error")).toHaveLength(0);
	});

	test("at /revoke too", async () => {
		const store = new BrokenStore();
		const r = oauthRelay({ store });
		store.failing.add("get");
		const res = await postForm(`${r.url}/revoke`, {
			token: "x".repeat(43),
			client_id: clientId,
		});
		expect(res.status).toBe(503);
		expect(r.logs.events("store.error").at(-1)?.["op"]).toBe("revoke");
	});

	test("a tab's Disconnect: store_unavailable, not bad_message; store.error, not tab.handler_error", async () => {
		const store = new BrokenStore();
		const r = oauthRelay({ store });
		const t = tab(r);
		await t.connect();
		await t.startPairing();
		await pair(r, t);
		const added = (await t.next("grant.added")) as {
			grant: { grantId: string };
		};
		store.failing.add("revoke");
		t.send({ type: "grant.revoke", grantId: added.grant.grantId });
		const error = (await t.next("error")) as { code: string };
		expect(error.code).toBe("store_unavailable");
		t.send({ type: "grants.revokeAll" });
		expect(((await t.next("error")) as { code: string }).code).toBe(
			"store_unavailable",
		);
		expect(r.logs.events("store.error").map((e) => e["op"])).toEqual([
			"revokeGrant",
			"revokeAll",
		]);
		expect(r.logs.events("tab.handler_error")).toHaveLength(0);
		expect(t.ws.readyState).toBe(WebSocket.OPEN);
	});

	test("guardStore turns synchronous throws into StoreFailure rejections and keeps results", async () => {
		class SyncThrowing extends MemoryTokenStore {
			override deleteExpired(): Promise<number> {
				throw new Error("sync");
			}
		}
		const guarded = guardStore(new SyncThrowing());
		expect(await guarded.get("nope")).toBeUndefined();
		expect(guarded.claimNonce).toBeDefined();
		const failure = await guarded.deleteExpired(0).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(StoreFailure);
		expect((failure as StoreFailure).method).toBe("deleteExpired");
	});
});

describe("RQ 6: refusals, limits and session figures in the log", () => {
	test("a refused refresh is oauth.token_refused with grant type, error, reason and client host", async () => {
		const r = oauthRelay();
		const res = await postForm(`${r.url}/token`, {
			grant_type: "refresh_token",
			refresh_token: "y".repeat(43),
			client_id: clientId,
		});
		expect(res.status).toBe(400);
		expect(r.logs.events("oauth.token_refused").at(-1)).toMatchObject({
			endpoint: "token",
			grant: "refresh_token",
			status: 400,
			error: "invalid_grant",
			client: new URL(clientId).host,
		});
		const line = JSON.stringify(r.logs.events("oauth.token_refused").at(-1));
		expect(line).not.toContain("y".repeat(43));
	});

	test("an unknown grant type is logged as other", async () => {
		const r = oauthRelay();
		await postForm(`${r.url}/token`, {
			grant_type: "<script>",
			client_id: clientId,
		});
		expect(r.logs.events("oauth.token_refused").at(-1)?.["grant"]).toBe(
			"other",
		);
	});

	test("a network that hits a limit is warned about once", async () => {
		const r = oauthRelay(
			{},
			{ tokenRequestsPerIp: { capacity: 2, refillPerSecond: 0.001 } },
		);
		const statuses: number[] = [];
		for (let i = 0; i < 6; i++) {
			const res = await postForm(`${r.url}/token`, {
				grant_type: "refresh_token",
				refresh_token: "z".repeat(43),
				client_id: clientId,
			});
			statuses.push(res.status);
		}
		expect(statuses.filter((s) => s === 429)).toHaveLength(4);
		const warnings = r.logs.events("oauth.rate_limited");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({
			limit: "token_requests",
			ip: "127.0.0.0/24",
		});
		// The 429s of the limit are not refusals of the request itself.
		expect(r.logs.events("oauth.token_refused")).toHaveLength(2);
	});

	test("RateLimiter.onLimited fires again only after the bucket was full", () => {
		const seen: string[] = [];
		const limiter = new RateLimiter({
			capacity: 2,
			refillPerSecond: 1,
			onLimited: (key) => seen.push(key),
		});
		const t0 = 1_000_000;
		limiter.take("a", t0);
		limiter.take("a", t0);
		expect(limiter.take("a", t0)).toBe(false);
		expect(limiter.take("a", t0)).toBe(false);
		// One token back, taken, refused again: still the same episode.
		expect(limiter.take("a", t0 + 1000)).toBe(true);
		expect(limiter.take("a", t0 + 1000)).toBe(false);
		expect(seen).toEqual(["a"]);
		// Full again, then drained: a new episode.
		limiter.take("a", t0 + 5000);
		limiter.take("a", t0 + 5000);
		limiter.take("a", t0 + 5000);
		expect(seen).toEqual(["a", "a"]);
	});

	test("truncateKey shortens network keys like IPs", () => {
		expect(truncateKey("203.0.113.7")).toBe("203.0.113.0/24");
		expect(truncateKey("2001:db8:1:100::/64")).toBe("2001:db8:1::/48");
		expect(truncateKey("2001:db8:1:100::/56")).toBe("2001:db8:1::/48");
		expect(truncateKey(`${"a".repeat(52)}|203.0.113.7`)).toBe("203.0.113.0/24");
	});

	test("relay.stats from the sweep: sessions, waiting requests, open authorizations", async () => {
		const r = relay({ sweepIntervalMs: 30 });
		await tab(r).connect();
		await waitFor(
			() => r.logs.events("relay.stats").some((e) => e["sessions"] === 1),
			"relay.stats",
		);
		expect(r.logs.events("relay.stats").at(-1)).toMatchObject({
			sessions: 1,
			maxSessions: 500,
			waitingRequests: 0,
			pendingAuthorizations: 0,
		});
	});
});

describe("RQ 11: enums are checked, errors name the variable, unknown variables are found", () => {
	test("store, trustProxy, logLevel and cors outside their values are refused", () => {
		const bad: Record<string, unknown>[] = [
			{ store: "sqlLite" },
			{ trustProxy: "X-Real-IP" },
			{ logLevel: "verbose" },
			{ cors: "on" },
		];
		for (const input of bad) {
			let error: unknown;
			try {
				resolveConfig({ development: true, ...input });
			} catch (e) {
				error = e;
			}
			expect(error).toBeInstanceOf(ConfigError);
			expect((error as ConfigError).key).toBe(
				Object.keys(input)[0] as ConfigError["key"],
			);
		}
	});

	test("describeConfigError puts the variable in front", () => {
		const message = (input: Record<string, unknown>) => {
			try {
				resolveConfig({ development: true, ...input });
			} catch (e) {
				return describeConfigError(e as ConfigError);
			}
			return "";
		};
		expect(message({ maxSessions: 0 })).toBe(
			"TAB_MCP_MAX_SESSIONS: maxSessions must be a positive number",
		);
		expect(message({ allowedOrigins: ["x"] })).toBe(
			"TAB_MCP_ALLOWED_ORIGINS: not an origin: x",
		);
		expect(message({ sites: [{ origin: "nope" }] })).toBe(
			"TAB_MCP_SITES: not an origin: nope",
		);
		expect(message({ sessionLifetimeMs: 2 ** 32 })).toStartWith(
			"TAB_MCP_SESSION_LIFETIME_S: sessionLifetimeMs must be at most",
		);
		// Already named: not twice.
		expect(message({ development: false })).toBe(
			"TAB_MCP_PUBLIC_URL is required",
		);
	});

	test("a seconds variable is checked in seconds (review of PR 122)", () => {
		expect(() =>
			configFromEnv({ TAB_MCP_REQUEST_TIMEOUT_S: "3000000" }),
		).toThrow(
			"TAB_MCP_REQUEST_TIMEOUT_S must be at most 2147483 seconds (about 24.8 days)",
		);
		expect(() => configFromEnv({ TAB_MCP_KEEPALIVE_S: "0.0001" })).toThrow(
			"TAB_MCP_KEEPALIVE_S must be a positive number of seconds",
		);
		// Not a timer: compared with timestamps, so no upper bound.
		expect(
			configFromEnv({ TAB_MCP_IDLE_TIMEOUT_S: "3000000" }).idleTimeoutMs,
		).toBe(3_000_000_000);
	});

	test("unknownEnvNames lists TAB_MCP_ variables the relay does not read", () => {
		expect(
			unknownEnvNames({
				TAB_MCP_PORT: "1",
				TAB_MCP_OIDC_ISSUER: "x",
				TAB_MCP_MAX_SESION: "5",
				TAB_MCP_ALLOWED_ORIGIN: "x",
				HOME: "/",
			}),
		).toEqual(["TAB_MCP_ALLOWED_ORIGIN", "TAB_MCP_MAX_SESION"]);
	});
});

describe("RQ 12: a large request while the page is away is told the page is not open", () => {
	test("the site's raised limit applies from the last session", async () => {
		const r = relay({
			allowedOrigins: [],
			sites: [{ origin: ORIGIN, limits: { maxMessageBytes: 4 * 1024 * 1024 } }],
		});
		const t = tab(r);
		await t.connect();
		const address = t.session?.address ?? "";
		const token = await tokenFor(r.store, t.addressId);
		t.close();
		await waitFor(() => r.relay.sessionCount === 0, "the tab to close");
		const big = rpc(1, "tools/call", {
			name: "echo",
			arguments: { text: "x".repeat(2 * 1024 * 1024) },
		});
		const res = await mcpPost(address, big, { token });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result?: { isError?: boolean; content: { text: string }[] };
		};
		expect(body.result?.isError).toBe(true);
		expect(body.result?.content[0]?.text).toContain("not open");
	});
});

describe("RQ 13: provider discovery serves its last metadata through an outage", () => {
	test("a failed refresh keeps the cached metadata for the grace period and pauses 30 s", async () => {
		let failing = false;
		let hits = 0;
		let issuer = "";
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (): Response => {
				hits++;
				if (failing) return new Response("down", { status: 500 });
				return Response.json({
					issuer,
					authorization_endpoint: `${issuer}/auth`,
					token_endpoint: `${issuer}/token`,
					jwks_uri: `${issuer}/jwks`,
				});
			},
		});
		issuer = `http://127.0.0.1:${server.port}`;
		try {
			let now = 1_000_000;
			const discovery = new ProviderDiscovery(issuer, true, () => now);
			const first = await discovery.get();
			expect(hits).toBe(1);
			failing = true;
			const hour = 60 * 60_000;
			now += hour + 1;
			expect(await discovery.get()).toEqual(first); // fetched, failed, cached
			expect(hits).toBe(2);
			now += 10_000;
			expect(await discovery.get()).toEqual(first); // paused: no fetch
			expect(hits).toBe(2);
			now += 30_000;
			expect(await discovery.get()).toEqual(first);
			expect(hits).toBe(3);
			now += hour;
			await expect(discovery.get()).rejects.toThrow();
			failing = false;
			now += 30_000;
			expect(await discovery.get()).toEqual(first);
		} finally {
			await server.stop(true);
		}
	});
});
