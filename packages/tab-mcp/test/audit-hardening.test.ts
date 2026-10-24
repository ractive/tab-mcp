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
import { ScriptedTab } from "./helpers.ts";
import {
	type AuthorizePage,
	authorizeUrl,
	type CimdServer,
	type OAuthTestRelay,
	pkce,
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
