/**
 * Findings of the security audit of 2026-10-24 (iteration 12), one block per
 * finding. Each test fails on the code before its fix. Findings 2 and 5 (the
 * CIMD fetcher and client names) are pinned in cimd.test.ts.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import type { CreateRelayOptions } from "../src/relay.ts";
import { hashToken } from "../src/tokens.ts";
import { ScriptedTab } from "./helpers.ts";
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

async function setup(options: CreateRelayOptions = {}) {
	const r = startOAuthRelay(cimd, { trustProxy: "x-real-ip", ...options });
	current = r;
	const tab = new ScriptedTab(r.wsUrl);
	tabs.push(tab);
	const session = await tab.connect();
	return { r, tab, address: session.address };
}

/** A browser on its own network (behind the trusted proxy). */
function browserAt(r: OAuthTestRelay, ip: string): TestBrowser {
	return new TestBrowser(r.url, { "x-real-ip": ip });
}

function openPage(
	browser: TestBrowser,
	r: OAuthTestRelay,
	address: string,
): Promise<AuthorizePage> {
	return browser.open(
		authorizeUrl(r.url, {
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_challenge: pkce().challenge,
			resource: address,
		}),
	);
}

describe("1: knowing an address does not keep its owner off /authorize", () => {
	test("while the page's dialog is closed, /authorize keeps no request; the owner pairs once it opens", async () => {
		const { r, tab, address } = await setup();
		for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
			const attacker = browserAt(r, ip);
			for (let i = 0; i < 10; i++) {
				const page = await openPage(attacker, r, address);
				expect(page.status).toBe(200);
				expect(page.requestId).toBeUndefined();
				expect(page.html).toContain("Connect your AI app");
			}
		}
		const code = await tab.startPairing();
		const owner = browserAt(r, "198.51.100.7");
		const page = await openPage(owner, r, address);
		expect(page.status).toBe(200);
		expect(page.requestId).toBeDefined();
		const done = await owner.submit(page, { action: "connect", code });
		expect(done.status).toBe(303);
	});

	test("Try again on the closed-dialog page opens the request once the dialog is open", async () => {
		const { r, tab, address } = await setup();
		const owner = browserAt(r, "198.51.100.7");
		const closed = await openPage(owner, r, address);
		const retry = /href="(\/authorize\?[^"]+)"/.exec(closed.html)?.[1];
		expect(retry).toBeDefined();
		const code = await tab.startPairing();
		const page = await owner.open(
			`${r.url}${(retry ?? "").replaceAll("&amp;", "&")}`,
		);
		expect(page.requestId).toBeDefined();
		const done = await owner.submit(page, { action: "connect", code });
		expect(done.status).toBe(303);
	});

	test("at the cap per address, requests are evicted, not refused: a flood from many networks leaves the owner's request", async () => {
		const { r, tab, address } = await setup();
		const code = await tab.startPairing();
		const owner = browserAt(r, "198.51.100.7");
		const ownerPage = await openPage(owner, r, address);
		expect(ownerPage.requestId).toBeDefined();
		for (let n = 0; n < 8; n++) {
			const attacker = browserAt(r, `203.0.113.${n + 10}`);
			for (let i = 0; i < 8; i++) {
				const page = await openPage(attacker, r, address);
				expect(page.status).toBe(200);
				expect(page.requestId).toBeDefined();
			}
		}
		// A late owner still gets a request ...
		const late = browserAt(r, "198.51.100.8");
		expect((await openPage(late, r, address)).requestId).toBeDefined();
		// ... and the owner's first one was not the one evicted.
		const done = await owner.submit(ownerPage, { action: "connect", code });
		expect(done.status).toBe(303);
	});

	test("review of PR 32: with equal shares the network that came last loses, not the owner who came first", async () => {
		const { r, tab, address } = await setup();
		const code = await tab.startPairing();
		const owner = browserAt(r, "198.51.100.7");
		const ownerPage = await openPage(owner, r, address);
		await openPage(owner, r, address);
		for (let n = 0; n < 9; n++) {
			const attacker = browserAt(r, `203.0.113.${n + 10}`);
			await openPage(attacker, r, address);
			await openPage(attacker, r, address);
		}
		// 20 open, two per network: the next one evicts.
		await openPage(browserAt(r, "203.0.113.50"), r, address);
		const done = await owner.submit(ownerPage, { action: "connect", code });
		expect(done.status).toBe(303);
	});

	test("one network that reloads past its share of an address loses its own oldest request", async () => {
		const { r, tab, address } = await setup();
		await tab.startPairing();
		const browser = browserAt(r, "198.51.100.7");
		const first = await openPage(browser, r, address);
		for (let i = 0; i < 5; i++) await openPage(browser, r, address);
		const stale = await browser.submit(first, { action: "connect" });
		expect(stale.status).toBe(400);
		expect(stale.html).toContain("expired or was already used");
	});
});

/** Pair through /authorize and exchange the code; returns the token response. */
async function pairedTokens(
	r: OAuthTestRelay,
	tab: ScriptedTab,
	address: string,
): Promise<{ access_token: string; refresh_token: string }> {
	const code = await tab.startPairing();
	const browser = browserAt(r, "198.51.100.7");
	const { verifier, challenge } = pkce();
	const page = await browser.open(
		authorizeUrl(r.url, {
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_challenge: challenge,
			resource: address,
		}),
	);
	const done = await browser.submit(page, { action: "connect", code });
	const res = await postForm(`${r.url}/token`, {
		grant_type: "authorization_code",
		code: new URL(done.location ?? "").searchParams.get("code") ?? "",
		redirect_uri: REDIRECT,
		code_verifier: verifier,
		client_id: clientId,
	});
	expect(res.status).toBe(200);
	return (await res.json()) as { access_token: string; refresh_token: string };
}

function refresh(r: OAuthTestRelay, token: string, ip = "198.51.100.7") {
	return postForm(
		`${r.url}/token`,
		{ grant_type: "refresh_token", refresh_token: token, client_id: clientId },
		{ "x-real-ip": ip },
	);
}

describe("4: a used refresh token is kept only for the reuse window", () => {
	const DAY = 24 * 60 * 60_000;

	test("its expiry is cut to 24 hours; inside the window, reuse still revokes the grant", async () => {
		const { r, tab, address } = await setup();
		const first = await pairedTokens(r, tab, address);
		const before = Date.now();
		const res = await refresh(r, first.refresh_token);
		expect(res.status).toBe(200);
		const second = (await res.json()) as { refresh_token: string };
		const used = await r.store.get(hashToken(first.refresh_token));
		expect(used?.usedAt).toBeDefined();
		expect(used?.expiresAt).toBeLessThanOrEqual(Date.now() + DAY);
		expect(used?.expiresAt).toBeGreaterThanOrEqual(before + DAY);

		const reuse = await refresh(r, first.refresh_token);
		expect(reuse.status).toBe(400);
		expect((await refresh(r, second.refresh_token)).status).toBe(400);
	});

	test("after the window the sweep removes it; a late replay is refused without ending the grant", async () => {
		const { r, tab, address } = await setup();
		const first = await pairedTokens(r, tab, address);
		const res = await refresh(r, first.refresh_token);
		const second = (await res.json()) as { refresh_token: string };
		await r.store.deleteExpired(Date.now() + DAY + 1000);
		expect(await r.store.get(hashToken(first.refresh_token))).toBeUndefined();
		const replay = await refresh(r, first.refresh_token);
		expect(replay.status).toBe(400);
		expect((await refresh(r, second.refresh_token)).status).toBe(200);
	});

	test("refreshes per grant are capped: 20, then 1 a minute", async () => {
		const { r, tab, address } = await setup();
		let token = (await pairedTokens(r, tab, address)).refresh_token;
		const statuses: number[] = [];
		for (let i = 0; i < 21; i++) {
			const res = await refresh(r, token, `203.0.113.${i + 1}`);
			statuses.push(res.status);
			if (res.status === 200) {
				token = ((await res.json()) as { refresh_token: string }).refresh_token;
			}
		}
		expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
		expect(statuses[20]).toBe(429);
		// The refused refresh did not use the token up.
		expect((await r.store.get(hashToken(token)))?.usedAt).toBeUndefined();
	});
});

describe("small items", () => {
	test("a client_id that is not a URL is not written to the log", async () => {
		const { r, address } = await setup();
		const junk = "evil-text-for-the-log";
		const page = await browserAt(r, "198.51.100.7").open(
			authorizeUrl(r.url, {
				client_id: junk,
				redirect_uri: REDIRECT,
				code_challenge: pkce().challenge,
				resource: address,
			}),
		);
		expect(page.status).toBe(400);
		const refused = r.logs.events("oauth.client_refused");
		expect(refused).toHaveLength(1);
		expect(refused[0]?.["host"]).toBe("(not a URL)");
		expect(r.logs.lines.join("\n")).not.toContain(junk);
	});
});
