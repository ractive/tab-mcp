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
import type { CreateRelayOptions, RelayTestHooks } from "../src/relay.ts";
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

async function setup(
	options: CreateRelayOptions = {},
	hooks: RelayTestHooks = {},
) {
	const r = startOAuthRelay(
		cimd,
		{ trustProxy: "x-real-ip", ...options },
		hooks,
	);
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

/**
 * The address is public now: it names the app (DEC-196). The audit's worry
 * stays, in another form: whoever knows an address must not be able to keep
 * the people of that app off `/authorize`. Requests are counted per network
 * and in all, never per address, so there is no share of an address a
 * stranger could use up.
 */
describe("1: knowing an address does not keep its owner off /authorize", () => {
	/** Whether the request of `page` is still open: an action the form does not know shows the form again. */
	async function isOpen(
		browser: TestBrowser,
		page: AuthorizePage,
	): Promise<boolean> {
		return (await browser.submit(page, { action: "show" })).status === 200;
	}

	test("a network at its cap of 10 open requests loses its own oldest to the next; nobody is refused, and another network pairs", async () => {
		const { r, tab, address } = await setup();
		const code = await tab.startPairing();
		const firsts: { browser: TestBrowser; page: AuthorizePage }[] = [];
		const seconds: { browser: TestBrowser; page: AuthorizePage }[] = [];
		for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
			const browser = browserAt(r, ip);
			for (let i = 0; i < 10; i++) {
				const page = await openPage(browser, r, address);
				expect(page.status).toBe(200);
				expect(page.requestId).toBeDefined();
				if (i === 0) firsts.push({ browser, page });
				if (i === 1) seconds.push({ browser, page });
			}
			// The eleventh: someone loading the pairing page again, or the next
			// person of an office behind one address. It opens.
			const eleventh = await openPage(browser, r, address);
			expect(eleventh.status).toBe(200);
			expect(eleventh.requestId).toBeDefined();
		}
		// Each network paid with its own oldest request, and only that one.
		for (const first of firsts) {
			expect(await isOpen(first.browser, first.page)).toBe(false);
		}
		for (const second of seconds) {
			expect(await isOpen(second.browser, second.page)).toBe(true);
		}
		// 30 requests are open; the owner's is the 31st.
		const owner = browserAt(r, "198.51.100.7");
		const page = await openPage(owner, r, address);
		expect(page.status).toBe(200);
		const done = await owner.submit(page, { action: "connect", code });
		expect(done.status).toBe(303);
	});

	test("the cap counts an IPv6 /56 as one network, and every app together", async () => {
		const { r, address } = await setup();
		const other = r.relay.addressFor("another-app");
		const opened: { browser: TestBrowser; page: AuthorizePage }[] = [];
		for (let i = 0; i < 10; i++) {
			// Ten /64s of one /56, alternating between two apps.
			const browser = browserAt(r, `2001:db8:a:1${i.toString(16)}0::1`);
			const page = await openPage(browser, r, i % 2 === 0 ? address : other);
			expect(page.status).toBe(200);
			opened.push({ browser, page });
		}
		// Two more from the /56, one for each app: its two oldest go, whichever
		// app and /64 they were for.
		for (const resource of [address, other]) {
			const page = await openPage(
				browserAt(r, "2001:db8:a:1ff::1"),
				r,
				resource,
			);
			expect(page.status).toBe(200);
		}
		const open: boolean[] = [];
		for (const o of opened) open.push(await isOpen(o.browser, o.page));
		expect(open).toEqual([
			false,
			false,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
		]);
		// The next /56 is another network: it takes nothing from this one.
		const next = await openPage(browserAt(r, "2001:db8:a:200::1"), r, address);
		expect(next.status).toBe(200);
		const [, , third] = opened;
		if (third === undefined) throw new Error("no request");
		expect(await isOpen(third.browser, third.page)).toBe(true);
	});

	test("with the relay full, a flood from many networks evicts its own requests, not the one of a network with one", async () => {
		const { r, tab, address } = await setup({}, { maxPending: 20 });
		const code = await tab.startPairing();
		const owner = browserAt(r, "198.51.100.7");
		const ownerPage = await openPage(owner, r, address);
		expect(ownerPage.requestId).toBeDefined();
		// 64 requests from 8 networks for 20 places: none is refused, each
		// pushes out the oldest of the network that holds the most.
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
		// ... and the owner's first one was not among those evicted.
		const done = await owner.submit(ownerPage, { action: "connect", code });
		expect(done.status).toBe(303);
	});

	// What "review of PR 32" pinned here is gone with the cap per address:
	// among networks holding equally many, the one that came last lost, so an
	// equal flood never evicted the owner who came first. The relay-wide
	// eviction that is left takes the oldest request of the network holding
	// the most (dos-hardening.test.ts, RS 1): 10 000 open requests, one or
	// equally many per network, push a user's request out in the order they
	// came.
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
