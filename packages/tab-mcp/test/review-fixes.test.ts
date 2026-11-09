/**
 * Findings of the pre-release review of the relay (branch relay/review-fixes),
 * one block per finding. Each test fails on the code before its fix.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { addressIdFromSecret, newSecret } from "../src/address.ts";
import { ipSessionKeys } from "../src/ip.ts";
import type { HttpRequestMessage } from "../src/protocol.ts";
import { RateLimiter } from "../src/ratelimit.ts";
import type { CreateRelayOptions } from "../src/relay.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import { issueAccessToken, issueTokenPair, newId } from "../src/tokens.ts";
import {
	mcpPost,
	rpc,
	ScriptedTab,
	startRelay,
	type TestRelay,
	tokenFor,
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

function oauthRelay(options: CreateRelayOptions = {}): OAuthTestRelay {
	const r = startOAuthRelay(cimd, options);
	relays.push(r);
	return r;
}

function tab(r: { wsUrl: string }, options = {}): ScriptedTab {
	const t = new ScriptedTab(r.wsUrl, options);
	tabs.push(t);
	return t;
}

/** A grant with an access token, as the token endpoint would make it. */
async function grant(r: TestRelay, addressId: string) {
	const { token, record } = await issueAccessToken(
		r.store,
		{
			addressId,
			clientId: "https://client.example/cimd.json",
			clientName: "Test client",
		},
		{ ttlMs: 3_600_000 },
	);
	return { token, grantId: record.grantId };
}

/** Pair an AI app with the tab and return the authorization code. */
async function pairedCode(
	r: OAuthTestRelay,
	t: ScriptedTab,
	address: string,
): Promise<{ code: string; verifier: string }> {
	const browser = new TestBrowser(r.url);
	const { verifier, challenge } = pkce();
	const page = await browser.open(
		authorizeUrl(r.url, {
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_challenge: challenge,
			resource: address,
		}),
	);
	await waitFor(() => t.pairingCode !== undefined, "a pairing code");
	const res = await browser.submit(page, {
		action: "connect",
		code: t.pairingCode ?? "",
	});
	expect(res.status).toBe(303);
	const code = new URL(res.location ?? "").searchParams.get("code") ?? "";
	return { code, verifier };
}

function exchange(
	r: OAuthTestRelay,
	code: string,
	verifier: string,
	address: string,
): Promise<Response> {
	return postForm(`${r.url}/token`, {
		grant_type: "authorization_code",
		code,
		redirect_uri: REDIRECT,
		code_verifier: verifier,
		client_id: clientId,
		resource: address,
	});
}

describe("1: a revoked grant's requests do not reach the page", () => {
	test("a request waiting for its page is refused when the page takes its address back (New address)", async () => {
		const r = relay();
		const secret = newSecret();
		const owner = tab(r, {
			secret,
			revokeAll: true,
			onRequest: () => {
				forwarded++;
			},
		});
		let forwarded = 0;
		const { token } = await grant(r, owner.addressId);
		const address = r.relay.addressFor(secret);
		// The page is not open: the request waits for it (pageWaitMs).
		const pending = mcpPost(address, rpc(1, "tools/list"), { token });
		await Bun.sleep(100);
		const s = await owner.connect();
		expect(s.grants).toEqual([]);
		const res = await pending;
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("invalid_token");
		expect(forwarded).toBe(0);
	});

	test("a request waiting for its page is refused when its grant was revoked elsewhere meanwhile", async () => {
		const r = relay();
		const page = tab(r, { onRequest: () => forwarded++ });
		let forwarded = 0;
		const { token, grantId } = await grant(r, page.addressId);
		const address = r.relay.addressFor(page.secret);
		const pending = mcpPost(address, rpc(1, "tools/list"), { token });
		await Bun.sleep(100);
		// Another instance (or the store directly): only the store knows.
		const now = Date.now();
		await r.store.revoke({ grantId }, { now, keepUntil: now + 60_000 });
		await page.connect();
		expect((await pending).status).toBe(401);
		expect(forwarded).toBe(0);
	});

	test("a request in flight ends when the page disconnects its AI app", async () => {
		const r = relay();
		const requests: HttpRequestMessage[] = [];
		const page = tab(r, {
			onRequest: (m: HttpRequestMessage) => requests.push(m),
		});
		const { token, grantId } = await grant(r, page.addressId);
		await page.connect();
		const pending = mcpPost(
			page.session?.address ?? "",
			rpc(1, "tools/call", { name: "echo", arguments: { text: "x" } }),
			{ token },
		);
		await waitFor(() => requests.length === 1, "the request at the page");
		expect(requests[0]?.grant.grantId).toBe(grantId);
		page.send({ type: "grant.revoke", grantId });
		const res = await pending;
		expect(res.status).toBe(401);
		expect(await res.text()).toContain("-31009");
		const cancel = await page.next("http.cancel");
		expect(cancel).toMatchObject({ id: requests[0]?.id });
	});

	test("an open listen stream ends when its grant is revoked; another grant's stays", async () => {
		const r = relay();
		const page = tab(r, {
			onRequest: (m: HttpRequestMessage, t: ScriptedTab) => {
				t.send({
					type: "http.response.start",
					id: m.id,
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
				// Bun sends the headers with the first bytes.
				t.send({ type: "http.response.chunk", id: m.id, data: ": open\n\n" });
			},
		});
		const revoked = await grant(r, page.addressId);
		const kept = await grant(r, page.addressId);
		await page.connect();
		const address = page.session?.address ?? "";
		const listen = async (token: string) => {
			const res = await mcpPost(address, rpc(1, "subscriptions/listen"), {
				token,
			});
			expect(res.status).toBe(200);
			return res;
		};
		const gone = await listen(revoked.token);
		const stays = await listen(kept.token);
		page.send({ type: "grant.revoke", grantId: revoked.grantId });
		// The revoked stream ends (read to its end); the other one does not.
		const text = await gone.text();
		expect(text).toContain("-31009");
		const reader = stays.body?.getReader();
		await reader?.read(); // ": open"
		const next = await Promise.race([
			reader?.read().then((chunk) => (chunk.done ? "ended" : "data")),
			Bun.sleep(200).then(() => "open"),
		]);
		expect(next).toBe("open");
		await reader?.cancel();
	});

	test("a request whose token check ends after a revocation on this instance is refused before the page", async () => {
		/** A store whose token reads wait until released. */
		class GatedStore extends MemoryTokenStore {
			gate: Promise<void> | undefined;
			reached: (() => void) | undefined;
			override async get(hash: string) {
				const record = await super.get(hash);
				if (this.gate !== undefined && record?.kind === "access") {
					this.reached?.();
					await this.gate;
				}
				return record;
			}
		}
		const store = new GatedStore();
		const r = relay({ store });
		let forwarded = 0;
		const page = tab(r, { onRequest: () => forwarded++ });
		const { token, grantId } = await issueAccessToken(
			store,
			{
				addressId: page.addressId,
				clientId: "https://client.example/cimd.json",
				clientName: "Test client",
			},
			{ ttlMs: 3_600_000 },
		).then((g) => ({ token: g.token, grantId: g.record.grantId }));
		await page.connect();
		let release = () => {};
		store.gate = new Promise((resolve) => {
			release = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			store.reached = resolve;
		});
		const pending = mcpPost(page.session?.address ?? "", rpc(1, "tools/list"), {
			token,
		});
		await reached; // read the record, before the revocation
		store.gate = undefined;
		page.send({ type: "grant.revoke", grantId });
		await page.next("grant.removed");
		release();
		expect((await pending).status).toBe(401);
		expect(forwarded).toBe(0);
	});
});

describe("2: a code issued before an address-wide revocation makes no grant", () => {
	test("New address (hello.revokeAll) after the code was issued", async () => {
		const r = oauthRelay();
		const attacker = tab(r);
		const s = await attacker.connect();
		await attacker.startPairing();
		const { code, verifier } = await pairedCode(r, attacker, s.address);
		// The owner takes the address back, revoking everything.
		const owner = tab(r, { secret: attacker.secret, revokeAll: true });
		expect((await owner.connect()).grants).toEqual([]);
		const res = await exchange(r, code, verifier, s.address);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(
			"invalid_grant",
		);
		expect(await r.store.listGrants(attacker.addressId, Date.now())).toEqual(
			[],
		);
	});

	test("revoke all (grants.revokeAll) after the code was issued", async () => {
		const r = oauthRelay();
		const t = tab(r);
		const s = await t.connect();
		await t.startPairing();
		const { code, verifier } = await pairedCode(r, t, s.address);
		t.send({ type: "grants.revokeAll" });
		await waitFor(
			() => r.logs.events("oauth.revoked_all").length > 0,
			"the revocation",
		);
		const res = await exchange(r, code, verifier, s.address);
		expect(res.status).toBe(400);
	});

	test("the store's tombstone refuses a code issued before an address-wide revocation elsewhere", async () => {
		const r = oauthRelay();
		const t = tab(r);
		const s = await t.connect();
		await t.startPairing();
		const { code, verifier } = await pairedCode(r, t, s.address);
		// Revoked in the shared store only (another instance): the code stays
		// in this instance's memory, and its issue time decides.
		await Bun.sleep(5);
		const now = Date.now();
		await r.store.revoke(
			{ addressId: t.addressId },
			{ now, keepUntil: now + 60_000 },
		);
		const res = await exchange(r, code, verifier, s.address);
		expect(res.status).toBe(400);
		expect(
			((await res.json()) as { error_description: string }).error_description,
		).toBe("the connection was revoked");
	});

	test("a code issued after a revocation still works", async () => {
		const r = oauthRelay();
		const t = tab(r, { revokeAll: true });
		const s = await t.connect();
		await t.startPairing();
		await Bun.sleep(5);
		const { code, verifier } = await pairedCode(r, t, s.address);
		const res = await exchange(r, code, verifier, s.address);
		expect(res.status).toBe(200);
	});
});

describe("4: session slots", () => {
	test("ipSessionKeys: IPv4 once, IPv6 by /64 and by /56", () => {
		expect(ipSessionKeys("203.0.113.5")).toEqual(["203.0.113.5"]);
		expect(ipSessionKeys("::ffff:203.0.113.5")).toEqual(["203.0.113.5"]);
		expect(ipSessionKeys("2001:db8:1:2ff::9")).toEqual([
			"2001:db8:1:2ff::/64",
			"2001:db8:1:200::/56",
		]);
		expect(ipSessionKeys("2001:db8:1:200::1")[1]).toBe(
			ipSessionKeys("2001:db8:1:2ff:1:2:3:4")[1],
		);
		expect(ipSessionKeys("2001:db8:1:300::1")[1]).not.toBe(
			ipSessionKeys("2001:db8:1:2ff::1")[1],
		);
	});

	test("tab sessions per IP count a /56 as one too", async () => {
		const r = relay({ trustProxy: "x-real-ip", maxSessionsPerIp: 1 });
		const upgrade = (ip: string) =>
			fetch(`http://127.0.0.1:${r.relay.port}/tab`, {
				headers: {
					origin: "https://page.example",
					"sec-websocket-protocol": "tab-mcp.v1",
					"x-real-ip": ip,
				},
			});
		const ws = new WebSocket(r.wsUrl, {
			headers: {
				Origin: "https://page.example",
				"x-real-ip": "2001:db8:7:700::1",
			},
			protocols: ["tab-mcp.v1"],
		} as unknown as string[]);
		await new Promise((resolve) =>
			ws.addEventListener("open", resolve, { once: true }),
		);
		// Another /64 of the same /56: refused.
		expect((await upgrade("2001:db8:7:7ff::1")).status).toBe(429);
		// Another /56: admitted (a plain fetch is no upgrade, hence 400).
		expect((await upgrade("2001:db8:7:800::1")).status).toBe(400);
		ws.close();
		await waitFor(() => r.relay.sessionCount === 0, "the session to end");
		// Released with the session: the /56 is free again.
		expect((await upgrade("2001:db8:7:7ff::1")).status).toBe(400);
	});

	test("a session that never paired, signed in or got a request is closed after unpairedIdleTimeoutMs", async () => {
		const r = relay({ heartbeatMs: 20, unpairedIdleTimeoutMs: 100 });
		const t = tab(r);
		await t.connect();
		expect(await t.next("bye")).toEqual({ type: "bye", reason: "idle" });
		expect((await t.closed).code).toBe(4002);
	});

	test("a session that started pairing, has a grant or got a request stays", async () => {
		const r = relay({ heartbeatMs: 20, unpairedIdleTimeoutMs: 100 });
		const pairing = tab(r);
		await pairing.connect();
		await pairing.startPairing();
		pairing.send({ type: "pairing.stop" });
		const granted = tab(r);
		await tokenFor(r.store, granted.addressId);
		expect((await granted.connect()).grants.length).toBe(1);
		const used = tab(r);
		const { token } = await grant(r, used.addressId);
		await used.connect();
		// Revoked again: no grant, but it got a request.
		const res = await mcpPost(
			used.session?.address ?? "",
			rpc(1, "tools/list"),
			{
				token,
			},
		);
		expect(res.status).toBe(200);
		used.send({ type: "grants.revokeAll" });
		await used.next("grant.removed");
		await Bun.sleep(300);
		for (const t of [pairing, granted, used]) {
			expect(t.ws.readyState).toBe(WebSocket.OPEN);
		}
	});
});

describe("6: a pairing-guess limit cannot be reset by churning keys", () => {
	test("fail-closed: a drained bucket is never dropped to make room; new keys wait", () => {
		const limiter = new RateLimiter({
			capacity: 2,
			refillPerSecond: 1,
			maxKeys: 3,
			whenFull: "fail-closed",
		});
		const t0 = 1_000_000;
		expect(limiter.take("target", t0)).toBe(true);
		expect(limiter.take("target", t0)).toBe(true);
		expect(limiter.take("target", t0)).toBe(false);
		expect(limiter.take("a", t0)).toBe(true);
		expect(limiter.take("b", t0)).toBe(true);
		// Full of buckets that remember something: new keys are refused, and
		// the drained one stays drained.
		for (let i = 0; i < 100; i++) expect(limiter.take(`k${i}`, t0)).toBe(false);
		expect(limiter.take("target", t0)).toBe(false);
		expect(limiter.size).toBe(3);
		// Once buckets are full again they make room.
		expect(limiter.take("new", t0 + 2000)).toBe(true);
	});

	test("evict-oldest (the default) gives an evicted key a fresh bucket", () => {
		const limiter = new RateLimiter({
			capacity: 1,
			refillPerSecond: 0.001,
			maxKeys: 2,
		});
		expect(limiter.take("target", 0)).toBe(true);
		expect(limiter.take("target", 0)).toBe(false);
		limiter.take("a", 0);
		limiter.take("b", 0); // evicts "target"
		expect(limiter.take("target", 0)).toBe(true);
	});

	test("refund gives one token back, never beyond capacity", () => {
		const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
		expect(limiter.take("k", 0)).toBe(true);
		expect(limiter.take("k", 0)).toBe(false);
		limiter.refund("k", 0);
		limiter.refund("k", 0);
		expect(limiter.take("k", 0)).toBe(true);
		expect(limiter.take("k", 0)).toBe(false);
	});
});

describe("7: /token is limited by failures per network, not by successes", () => {
	async function refreshTokens(r: OAuthTestRelay, n: number) {
		const addressId = addressIdFromSecret(newSecret());
		const tokens: string[] = [];
		for (let i = 0; i < n; i++) {
			const pair = await issueTokenPair(
				r.store,
				{
					grantId: newId("g"),
					addressId,
					clientId,
					clientName: "Test AI",
					scopes: ["tools"],
					grantCreatedAt: Date.now(),
				},
				{
					accessTtlMs: 3_600_000,
					refreshTtlMs: 3_600_000,
					grantEndsAt: Date.now() + 3_600_000,
				},
			);
			tokens.push(pair?.refreshToken ?? "");
		}
		return tokens;
	}

	test("the users of one AI app behind one IP refresh without throttling each other", async () => {
		const r = oauthRelay({ trustProxy: "x-real-ip" });
		const tokens = await refreshTokens(r, 45);
		const statuses: number[] = [];
		for (const refresh of tokens) {
			const res = await postForm(
				`${r.url}/token`,
				{
					grant_type: "refresh_token",
					refresh_token: refresh,
					client_id: clientId,
				},
				{ "x-real-ip": "198.51.100.20" },
			);
			statuses.push(res.status);
		}
		expect(statuses.every((s) => s === 200)).toBe(true);
	});

	test("failures from one IP are still throttled after 30, and only that IP", async () => {
		const r = oauthRelay({ trustProxy: "x-real-ip" });
		const [good] = await refreshTokens(r, 1);
		const bad = (ip: string) =>
			postForm(
				`${r.url}/token`,
				{
					grant_type: "refresh_token",
					refresh_token: "nope",
					client_id: clientId,
				},
				{ "x-real-ip": ip },
			);
		const statuses: number[] = [];
		for (let i = 0; i < 31; i++)
			statuses.push((await bad("203.0.113.30")).status);
		expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
		expect(statuses[30]).toBe(429);
		// A success does not get past a drained bucket either.
		const blocked = await postForm(
			`${r.url}/token`,
			{
				grant_type: "refresh_token",
				refresh_token: good ?? "",
				client_id: clientId,
			},
			{ "x-real-ip": "203.0.113.30" },
		);
		expect(blocked.status).toBe(429);
		const other = await postForm(
			`${r.url}/token`,
			{
				grant_type: "refresh_token",
				refresh_token: good ?? "",
				client_id: clientId,
			},
			{ "x-real-ip": "198.51.100.21" },
		);
		expect(other.status).toBe(200);
	});
});
