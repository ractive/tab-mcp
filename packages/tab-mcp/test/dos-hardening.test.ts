/**
 * Iteration 29: the relay's denial-of-service findings and the refresh bug of
 * the review of 2026-11-13 (kb/research/review-2026-11-13.md), one block per
 * finding id. Each test fails on the code before its fix.
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
import { ConfigError, resolveConfig } from "../src/config.ts";
import * as entry from "../src/index.ts";
import { forwardedIp, networkKey } from "../src/ip.ts";
import { type Jwk, JwksCache, verifyJwt } from "../src/jwt.ts";
import {
	ClientMetadataError,
	ClientMetadataFetcher,
} from "../src/oauth/cimd.ts";
import type { PairingMethod } from "../src/oauth/pairing.ts";
import type { HttpRequestMessage } from "../src/protocol.ts";
import type { CreateRelayOptions, RelayTestHooks } from "../src/relay.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import type {
	RevokeOptions,
	RevokeSelector,
	TokenRecord,
} from "../src/store/types.ts";
import {
	mcpPost,
	type RequestHandler,
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
const REDIRECT = "http://127.0.0.1:4567/callback";
const relays: (TestRelay | OAuthTestRelay)[] = [];
const tabs: ScriptedTab[] = [];

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

function tab(r: { wsUrl: string }, onRequest?: RequestHandler): ScriptedTab {
	const t = new ScriptedTab(
		r.wsUrl,
		onRequest === undefined ? {} : { onRequest },
	);
	tabs.push(t);
	return t;
}

/** A tab with its dialog open, on an OAuth relay. */
async function pairingTab(r: OAuthTestRelay): Promise<ScriptedTab> {
	const t = tab(r);
	await t.connect();
	await t.startPairing();
	return t;
}

/** Open `/authorize` for `address` from a browser on `ip` (behind the trusted proxy). */
async function openFrom(
	r: OAuthTestRelay,
	ip: string,
	address: string,
): Promise<{ browser: TestBrowser; page: AuthorizePage }> {
	const browser = new TestBrowser(r.url, { "x-real-ip": ip });
	const page = await browser.open(
		authorizeUrl(r.url, {
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_challenge: pkce().challenge,
			resource: address,
		}),
	);
	return { browser, page };
}

/** Pair with the tab's code and return the code's redirect and verifier. */
async function authorizeCode(
	r: OAuthTestRelay,
	t: ScriptedTab,
): Promise<{ code: string; verifier: string }> {
	const { verifier, challenge } = pkce();
	const browser = new TestBrowser(r.url);
	const page = await browser.open(
		authorizeUrl(r.url, {
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_challenge: challenge,
			resource: t.session?.address ?? "",
		}),
	);
	expect(page.status).toBe(200);
	const result = await browser.submit(page, {
		action: "connect",
		code: t.pairingCode ?? "",
	});
	expect(result.status).toBe(303);
	const code = new URL(result.location ?? "").searchParams.get("code") ?? "";
	return { code, verifier };
}

function exchange(
	r: OAuthTestRelay,
	t: ScriptedTab,
	a: { code: string; verifier: string },
): Promise<Response> {
	return postForm(`${r.url}/token`, {
		grant_type: "authorization_code",
		code: a.code,
		redirect_uri: REDIRECT,
		code_verifier: a.verifier,
		client_id: clientId,
		resource: t.session?.address ?? "",
	});
}

function refresh(
	r: OAuthTestRelay,
	t: ScriptedTab,
	refreshToken: string,
): Promise<Response> {
	return postForm(`${r.url}/token`, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: clientId,
		resource: t.session?.address ?? "",
	});
}

/** A memory store whose next `put`s throw, as a full disk would. */
class FailingStore extends MemoryTokenStore {
	#failures = 0;
	#skip = 0;
	/** Fail `count` puts after letting `skip` succeed. */
	failPuts(count: number, skip = 0): void {
		this.#failures = count;
		this.#skip = skip;
	}
	override async put(record: TokenRecord): Promise<boolean> {
		if (this.#failures > 0) {
			if (this.#skip > 0) this.#skip--;
			else {
				this.#failures--;
				throw new Error("disk full");
			}
		}
		return super.put(record);
	}
}

describe("RQ 1: a store failure during a refresh or a code exchange leaves the grant usable", () => {
	for (const skip of [0, 1]) {
		test(`a refresh whose ${skip === 0 ? "first" : "second"} put fails answers 503, and the retry with the same token succeeds`, async () => {
			const store = new FailingStore();
			const r = oauthRelay({ store });
			const t = await pairingTab(r);
			const first = await exchange(r, t, await authorizeCode(r, t));
			expect(first.status).toBe(200);
			const tokens = (await first.json()) as { refresh_token: string };

			store.failPuts(1, skip);
			const failed = await refresh(r, t, tokens.refresh_token);
			expect(failed.status).toBe(503);
			expect(failed.headers.get("retry-after")).toBe("10");

			// The retry the 503 asks for: before the fix the token was marked
			// used, so this revoked the grant.
			const retry = await refresh(r, t, tokens.refresh_token);
			expect(retry.status).toBe(200);
			const renewed = (await retry.json()) as { access_token: string };
			const address = t.session?.address ?? "";
			expect(
				(
					await mcpPost(address, rpc(1, "tools/list"), {
						token: renewed.access_token,
					})
				).status,
			).toBe(200);
			expect(r.logs.events("oauth.refresh_reuse")).toHaveLength(0);
			expect(t.received.some((m) => m.type === "grant.removed")).toBe(false);
		});
	}

	test("a reuse after a successful refresh still revokes the grant", async () => {
		const r = oauthRelay();
		const t = await pairingTab(r);
		const tokens = (await (
			await exchange(r, t, await authorizeCode(r, t))
		).json()) as { refresh_token: string };
		expect((await refresh(r, t, tokens.refresh_token)).status).toBe(200);
		const reused = await refresh(r, t, tokens.refresh_token);
		expect(reused.status).toBe(400);
		await t.next("grant.removed");
	});

	test("a code exchange whose store write fails answers 503, and the retry with the same code succeeds", async () => {
		const store = new FailingStore();
		const r = oauthRelay({ store });
		const t = await pairingTab(r);
		const code = await authorizeCode(r, t);
		store.failPuts(1, 1); // the refresh token is stored, the access token not
		const failed = await exchange(r, t, code);
		expect(failed.status).toBe(503);
		const retry = await exchange(r, t, code);
		expect(retry.status).toBe(200);
		// One grant: the retry kept the grant id of the failed attempt.
		const grants = await store.listGrants(t.addressId, Date.now());
		expect(grants).toHaveLength(1);
	});
});

describe("RS 1: a full instance evicts open authorization requests instead of refusing everyone", () => {
	test("requests of a page whose dialog closed go first", async () => {
		const r = oauthRelay({ trustProxy: "x-real-ip" }, { maxPending: 3 });
		const a = await pairingTab(r);
		const b = await pairingTab(r);
		const opened: { browser: TestBrowser; page: AuthorizePage }[] = [];
		for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
			const o = await openFrom(r, ip, a.session?.address ?? "");
			expect(o.page.status).toBe(200);
			opened.push(o);
		}
		a.send({ type: "pairing.stop" });
		await Bun.sleep(50);
		// Full: before the fix, 429 for everyone.
		const fourth = await openFrom(r, "198.51.100.4", b.session?.address ?? "");
		expect(fourth.page.status).toBe(200);
		// The oldest request of the closed dialog was the one evicted.
		const evicted = opened[0];
		if (evicted === undefined) throw new Error("no request");
		const gone = await evicted.browser.submit(evicted.page, {
			action: "cancel",
		});
		expect(gone.status).toBe(400);
		const kept = opened[1];
		if (kept === undefined) throw new Error("no request");
		const cancelled = await kept.browser.submit(kept.page, {
			action: "cancel",
		});
		expect(cancelled.status).toBe(303);
	});

	test("with every dialog open, the network holding the most loses its oldest", async () => {
		const r = oauthRelay({ trustProxy: "x-real-ip" }, { maxPending: 3 });
		const a = await pairingTab(r);
		const address = a.session?.address ?? "";
		const flood1 = await openFrom(r, "2001:db8:f:100::1", address);
		const owner = await openFrom(r, "198.51.100.9", address);
		// Another /64 of the flood's /56: the same network.
		const flood2 = await openFrom(r, "2001:db8:f:101::1", address);
		for (const o of [flood1, owner, flood2]) expect(o.page.status).toBe(200);
		const next = await openFrom(r, "198.51.100.10", address);
		expect(next.page.status).toBe(200);
		expect(
			(await flood1.browser.submit(flood1.page, { action: "cancel" })).status,
		).toBe(400);
		expect(
			(await owner.browser.submit(owner.page, { action: "cancel" })).status,
		).toBe(303);
	});

	test("networkKey: an IPv6 /64 key widens to its /56, anything else stays", () => {
		expect(networkKey("2001:db8:1:2::/64")).toBe("2001:db8:1:0::/56");
		expect(networkKey("2001:db8:1:2ff::/64")).toBe("2001:db8:1:200::/56");
		expect(networkKey("203.0.113.5")).toBe("203.0.113.5");
	});
});

describe("RS 2: uncached client ids are charged to the requesting network first", () => {
	const doc = (id: string) => ({
		client_id: id,
		client_name: "Example AI",
		redirect_uris: ["https://ai.example/callback"],
		token_endpoint_auth_method: "none",
	});
	function fetcher() {
		return new ClientMetadataFetcher({
			lookup: async () => ["93.184.216.34"],
			fetch: (async (url: string, init?: RequestInit) => {
				const headers = (init?.headers ?? {}) as Record<string, string>;
				const host = headers["host"];
				const id = `https://${host}${new URL(url).pathname}`;
				return Response.json(doc(id));
			}) as unknown as typeof fetch,
		});
	}
	async function reason(p: Promise<unknown>): Promise<string> {
		try {
			await p;
			return "accepted";
		} catch (error) {
			if (error instanceof ClientMetadataError) return error.reason;
			throw error;
		}
	}

	test("five new client ids per network, then one a minute; another network is not affected", async () => {
		const f = fetcher();
		const results: string[] = [];
		// Hosts on six different domains: neither the per-host nor the
		// per-domain budget is what refuses the sixth.
		for (let i = 1; i <= 6; i++) {
			results.push(
				await reason(
					f.get(`https://app${i}.example${i}/client.json`, {
						requester: "net-a",
					}),
				),
			);
		}
		expect(results.slice(0, 5)).toEqual(Array(5).fill("accepted"));
		expect(results[5]).toBe("requester_limited");
		expect(
			await reason(
				f.get("https://app7.example7/client.json", { requester: "net-b" }),
			),
		).toBe("accepted");
		// A cached document costs the network nothing.
		expect(
			await reason(
				f.get("https://app1.example1/client.json", { requester: "net-a" }),
			),
		).toBe("accepted");
	});

	test("/authorize answers a drained network with 429", async () => {
		const r = oauthRelay({ trustProxy: "x-real-ip" });
		const t = await pairingTab(r);
		const statuses: number[] = [];
		for (let i = 1; i <= 6; i++) {
			const id = cimd.serve(
				`/rs2-${i}.json`,
				cimd.document(`${cimd.origin}/rs2-${i}.json`),
			);
			const browser = new TestBrowser(r.url, { "x-real-ip": "198.51.100.77" });
			const page = await browser.open(
				authorizeUrl(r.url, {
					client_id: id,
					redirect_uri: REDIRECT,
					code_challenge: pkce().challenge,
					resource: t.session?.address ?? "",
				}),
			);
			statuses.push(page.status);
		}
		// The per-host budget (5) also ends here on the one test host; the
		// unit test above separates the two.
		expect(statuses.slice(0, 5)).toEqual(Array(5).fill(200));
		expect(statuses[5]).toBe(429);
	});
});

describe("RS 3: control messages from a tab are rate-limited", () => {
	test("a flood of grants.revokeAll ends the session with rate_limited and 4008", async () => {
		const r = relay();
		const t = tab(r);
		await t.connect();
		for (let i = 0; i < 60; i++) t.send({ type: "grants.revokeAll" });
		const closed = await t.closed;
		expect(closed.code).toBe(4008);
		expect(
			t.received.some(
				(m) =>
					m.type === "error" && (m as { code: string }).code === "rate_limited",
			),
		).toBe(true);
		expect(r.logs.events("tab.rate_limited")).toHaveLength(1);
	});

	test("pongs and responses are not counted", async () => {
		const r = relay();
		const t = tab(r);
		await t.connect();
		for (let i = 0; i < 200; i++) t.send({ type: "pong", t: Date.now() });
		for (let i = 0; i < 100; i++) {
			t.send({
				type: "http.response",
				id: `late-${i}`,
				status: 200,
				headers: {},
				body: "",
			});
		}
		await Bun.sleep(100);
		expect(t.ws.readyState).toBe(WebSocket.OPEN);
	});

	test("a second revokeAll within a second does not write to the store again", async () => {
		let revokes = 0;
		class CountingStore extends MemoryTokenStore {
			override async revoke(
				selector: RevokeSelector,
				options: RevokeOptions,
			): Promise<number> {
				revokes++;
				return super.revoke(selector, options);
			}
		}
		const r = relay({ store: new CountingStore() });
		const t = tab(r);
		await t.connect();
		t.send({ type: "grants.revokeAll" });
		t.send({ type: "grants.revokeAll" });
		t.send({ type: "grants.revokeAll" });
		await waitFor(() => revokes > 0, "a revocation");
		await Bun.sleep(50);
		expect(revokes).toBe(1);
	});

	test("a repeat waits for a revocation under way; a hello with revokeAll always revokes (DEC-095)", async () => {
		let release: () => void = () => {};
		let revokes = 0;
		class GatedStore extends MemoryTokenStore {
			gate: Promise<void> | undefined;
			override async revoke(
				selector: RevokeSelector,
				options: RevokeOptions,
			): Promise<number> {
				revokes++;
				if (this.gate !== undefined) await this.gate;
				return super.revoke(selector, options);
			}
		}
		const store = new GatedStore();
		const r = relay({ store });
		const t = tab(r);
		await t.connect();
		store.gate = new Promise((resolve) => {
			release = resolve;
		});
		t.send({ type: "grants.revokeAll" });
		await waitFor(() => revokes === 1, "the first revocation");
		t.send({ type: "grants.revokeAll" });
		await Bun.sleep(30);
		release();
		store.gate = undefined;
		await Bun.sleep(30);
		expect(revokes).toBe(1);
		// Within the second after it, a grant paired meanwhile and a take-back:
		// the hello revokes again, and its session lists nothing.
		await tokenFor(r.store, t.addressId);
		const back = new ScriptedTab(r.wsUrl, {
			secret: t.secret,
			revokeAll: true,
		});
		tabs.push(back);
		const session = await back.connect();
		expect(revokes).toBe(2);
		expect(session.grants).toHaveLength(0);
		expect(await store.listGrants(t.addressId, Date.now())).toHaveLength(0);
	});
});

/** Open a raw TCP connection, send `data`, and collect the answer until the server closes. */
async function stalled(port: number, data: string): Promise<() => string> {
	let received = "";
	const socket = await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			data: (_s, chunk) => {
				received += new TextDecoder().decode(chunk);
			},
		},
	});
	socket.write(data);
	return () => received;
}

describe("RS 4 / RQ 2: /token, /revoke and POST /authorize read their body with a deadline", () => {
	for (const path of ["/token", "/revoke", "/authorize"]) {
		test(`a stalled body at ${path} gets 408 and Connection: close`, async () => {
			const r = oauthRelay({ bodyTimeoutMs: 300 });
			const received = await stalled(
				r.relay.port,
				`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 100\r\n\r\ngrant_type=`,
			);
			await waitFor(() => received() !== "", "an answer", 3000);
			expect(received()).toStartWith("HTTP/1.1 408");
			expect(received().toLowerCase()).toContain("connection: close");
		});
	}
});

describe("RQ 3: timer-backed settings are bounded", () => {
	const base = { development: true };
	for (const key of [
		"sessionLifetimeMs",
		"heartbeatMs",
		"requestTimeoutMs",
		"keepAliveMs",
		"helloTimeoutMs",
		"bodyTimeoutMs",
		"sweepIntervalMs",
	] as const) {
		test(`${key} above 2^31-1 ms is refused`, () => {
			expect(() => resolveConfig({ ...base, [key]: 2_592_000_000 })).toThrow(
				ConfigError,
			);
			expect(() =>
				resolveConfig({ ...base, [key]: 2_147_483_647 }),
			).not.toThrow();
		});
	}

	test("a site's timer limits are bounded the same way", () => {
		expect(() =>
			resolveConfig({
				...base,
				sites: [
					{
						origin: "https://a.example",
						limits: { sessionLifetimeMs: 2_592_000_000 },
					},
				],
			}),
		).toThrow(/at most 2147483647/);
	});

	test("a 30-day TAB_MCP_SESSION_LIFETIME_S is refused at start", () => {
		expect(() =>
			resolveConfig({
				...base,
				...entry.configFromEnv({
					NODE_ENV: "development",
					TAB_MCP_SESSION_LIFETIME_S: "2592000",
				}),
			}),
		).toThrow(ConfigError);
	});
});

describe("RS 5: a JWKS with many keys under one kid costs a bounded number of checks", () => {
	async function keyPair() {
		const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
			"sign",
			"verify",
		])) as unknown as CryptoKeyPair;
		const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
		const jwk: Jwk = { kty: "OKP", crv: "Ed25519", x: exported.x ?? "" };
		return { pair, jwk };
	}
	async function sign(privateKey: CryptoKey): Promise<string> {
		const b64 = (v: unknown) =>
			Buffer.from(JSON.stringify(v)).toString("base64url");
		const input = `${b64({ alg: "EdDSA", kid: "k" })}.${b64({ sub: "x" })}`;
		const sig = await crypto.subtle.sign(
			{ name: "Ed25519" },
			privateKey,
			new TextEncoder().encode(input),
		);
		return `${input}.${Buffer.from(sig).toString("base64url")}`;
	}

	test("JwksCache keeps at most 20 keys of a set", async () => {
		const keys = Array.from({ length: 50 }, (_, i) => ({
			kty: "OKP",
			crv: "Ed25519",
			kid: "k",
			x: `x${i}`,
		}));
		const cache = new JwksCache("https://keys.example/jwks", {
			load: async () => ({ keys }),
		});
		expect(await cache.keys(undefined)).toHaveLength(20);
	});

	test("verifyJwt tries at most three keys of a kid", async () => {
		const decoys = await Promise.all([1, 2, 3].map(() => keyPair()));
		const real = await keyPair();
		const token = await sign(real.pair.privateKey);
		const set = [...decoys.map((d) => d.jwk), real.jwk].map((k) => ({
			...k,
			kid: "k",
		}));
		const source = { keys: async () => set };
		await expect(verifyJwt(token, source)).rejects.toThrow(/signature/);
		// The same key among the first three is found.
		const first = { keys: async () => [set[3], ...set.slice(0, 3)] as Jwk[] };
		expect((await verifyJwt(token, first)).payload["sub"]).toBe("x");
	});
});

describe("RS 8: the MCP endpoint reads a large body only for a valid token", () => {
	const big = (n: number) =>
		rpc(1, "tools/call", { name: "echo", arguments: { text: "x".repeat(n) } });

	test("a 20 KiB body without a valid token is not parsed: 401, not a parse error", async () => {
		const r = relay();
		const address = r.relay.addressFor(newSecret());
		// Not JSON: before the fix it was read and parsed (400 -32700).
		const garbage = `{${"x".repeat(20_000)}`;
		const res = await mcpPost(address, garbage);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
		const junk = await mcpPost(address, garbage, { token: "tmcp_at_nope" });
		expect(junk.status).toBe(401);
		// A small malformed body is still parsed first (DEC-040's order).
		expect((await mcpPost(address, "{")).status).toBe(400);
	});

	test("a version probe without a token still gets the version error first (DEC-040)", async () => {
		const r = relay();
		const address = r.relay.addressFor(newSecret());
		const res = await mcpPost(address, rpc(1, "tools/list"), {
			headers: { "mcp-protocol-version": "2025-06-18" },
		});
		expect(res.status).toBe(400);
	});

	test("an authenticated 20 KiB request is forwarded", async () => {
		const r = relay();
		const t = tab(r);
		const session = await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const res = await mcpPost(session.address, big(20_000), { token });
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("x".repeat(100));
	});

	test("a chunked body without a token is refused once it passes 16 KiB, not read to its end", async () => {
		const r = relay({ bodyTimeoutMs: 5000 });
		const address = new URL(r.relay.addressFor(newSecret()));
		const chunk = "x".repeat(20_000);
		const received = await stalled(
			r.relay.port,
			`POST ${address.pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nMCP-Protocol-Version: 2026-07-28\r\nTransfer-Encoding: chunked\r\n\r\n${chunk.length.toString(16)}\r\n${chunk}\r\n`,
		);
		// The body never ends; before the fix the answer came at the deadline (408).
		const started = Date.now();
		await waitFor(() => received() !== "", "an answer", 3000);
		expect(received()).toStartWith("HTTP/1.1 401");
		expect(Date.now() - started).toBeLessThan(3000);
	});
});

describe("RS 13: the metadata fetch's deadline covers the DNS lookup", () => {
	test("a name server that never answers fails as unresolvable within the timeout", async () => {
		const f = new ClientMetadataFetcher({
			lookup: () => new Promise<string[]>(() => {}),
			timeoutMs: 100,
		});
		const started = Date.now();
		let reason = "";
		try {
			await f.get("https://slow-dns.example/client.json");
		} catch (error) {
			if (error instanceof ClientMetadataError) reason = error.reason;
		}
		expect(reason).toBe("unresolvable");
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe("RS 15: proxy header values with a port are read as the address", () => {
	test("forwardedIp strips a port and refuses what is not an address", () => {
		expect(forwardedIp("203.0.113.7")).toBe("203.0.113.7");
		expect(forwardedIp("203.0.113.7:51234")).toBe("203.0.113.7");
		expect(forwardedIp("[2001:db8::1]:443")).toBe("2001:db8::1");
		expect(forwardedIp("[2001:db8::1]")).toBe("2001:db8::1");
		expect(forwardedIp("2001:db8::1")).toBe("2001:db8::1");
		expect(forwardedIp("unknown")).toBeUndefined();
		expect(forwardedIp("203.0.113.7:x")).toBeUndefined();
	});

	test("one address with changing ports shares one session limit", async () => {
		const r = relay({ trustProxy: "x-real-ip", maxSessionsPerIp: 1 });
		const upgrade = (ip: string) =>
			fetch(`http://127.0.0.1:${r.relay.port}/tab`, {
				headers: {
					origin: "https://page.example",
					"sec-websocket-protocol": "tab-mcp.v1",
					"x-real-ip": ip,
				},
			});
		const first = new WebSocket(r.wsUrl, {
			headers: {
				Origin: "https://page.example",
				"X-Real-IP": "203.0.113.7:1000",
			},
			protocols: ["tab-mcp.v1"],
		} as unknown as string[]);
		await new Promise((resolve) => first.addEventListener("open", resolve));
		const second = await upgrade("203.0.113.7:2000");
		expect(second.status).toBe(429);
		first.close();
	});

	test("a header that holds no address falls back to the socket and warns once", async () => {
		const r = relay({ trustProxy: "x-real-ip" });
		for (let i = 0; i < 2; i++) {
			await fetch(`http://127.0.0.1:${r.relay.port}/authorize`, {
				headers: { "x-real-ip": `garbage-${i}` },
			});
		}
		expect(r.logs.events("relay.bad_forwarded_ip")).toHaveLength(1);
	});
});

describe("RS 16 / RQ 9: keep-alives and error events go only into event streams", () => {
	test("a streamed JSON body whose first chunk is late arrives unchanged", async () => {
		const body = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: { tools: [] },
		});
		const r = relay({ keepAliveMs: 100 });
		const t = tab(r, async (msg: HttpRequestMessage, page) => {
			page.send({
				type: "http.response.start",
				id: msg.id,
				status: 200,
				headers: { "content-type": "application/json" },
			});
			await Bun.sleep(350);
			page.send({ type: "http.response.chunk", id: msg.id, data: body });
			page.send({ type: "http.response.end", id: msg.id });
		});
		const session = await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const res = await mcpPost(session.address, rpc(1, "tools/list"), { token });
		expect(res.headers.get("content-type")).toBe("application/json");
		expect(await res.text()).toBe(body);
	});

	test("a page that goes away mid-JSON-stream breaks the body off, with no event in it", async () => {
		const r = relay({ keepAliveMs: 100 });
		const t = tab(r, (msg: HttpRequestMessage, page) => {
			page.send({
				type: "http.response.start",
				id: msg.id,
				status: 200,
				headers: { "content-type": "application/json" },
			});
			setTimeout(() => page.close(), 250);
		});
		const session = await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		// Broken off, not ended: the AI app cannot take it for a whole body
		// (Bun resets the connection; with no byte sent yet, fetch rejects).
		const text = await mcpPost(session.address, rpc(1, "tools/list"), {
			token,
		})
			.then((res) => res.text())
			.then(
				(body) => `ended: ${body}`,
				() => "broken off",
			);
		expect(text).toBe("broken off");
	});
});

describe("RQ 10: the sweep survives a store that throws synchronously", () => {
	test("logged as store.error, no uncaught exception", async () => {
		class ThrowingStore extends MemoryTokenStore {
			override deleteExpired(): Promise<number> {
				throw new Error("down");
			}
		}
		const r = relay({ store: new ThrowingStore(), sweepIntervalMs: 30 });
		await waitFor(
			() => r.logs.events("store.error").length > 0,
			"a store.error line",
		);
		expect(r.logs.events("store.error")[0]?.["op"]).toBe("deleteExpired");
	});

	test("installCrashLogging is exported for embedders", () => {
		expect(typeof entry.installCrashLogging).toBe("function");
	});
});

describe("RQ 20: a handler that throws gets one JSON log line and a plain 500", () => {
	test("an exception in /authorize", async () => {
		const throwing: PairingMethod = {
			kind: "code",
			render: () => {
				throw new Error("secret detail");
			},
			check: () => ({ ok: false, reason: "wrong" }) as never,
		};
		const r = oauthRelay({}, { pairingMethods: { code: throwing } });
		const t = await pairingTab(r);
		const { page } = await openFrom(
			r,
			"198.51.100.1",
			t.session?.address ?? "",
		);
		expect(page.status).toBe(500);
		expect(page.html).not.toContain("secret detail");
		const lines = r.logs.events("http.handler_error");
		expect(lines).toHaveLength(1);
		expect(lines[0]?.["error"]).toBe("Error");
	});
});
