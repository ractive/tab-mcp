/**
 * Findings of the security review of PR #4 (iteration 3), one block per
 * finding. Each test fails on the code before its fix. Findings 4, 7 (names)
 * and 8 are pinned in cimd.test.ts, finding 5 in oauth.test.ts.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { ipPrefixKey } from "../src/ip.ts";
import { normalizeCode } from "../src/oauth/pairing.ts";
import type { CreateRelayOptions } from "../src/relay.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import type { TokenRecord } from "../src/store/types.ts";
import { mcpPost, rpc, ScriptedTab } from "./helpers.ts";
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
	await tab.startPairing();
	return { r, tab, address: session.address };
}

/** A browser on its own network (behind the trusted proxy). */
function browserAt(r: OAuthTestRelay, ip: string): TestBrowser {
	return new TestBrowser(r.url, { "x-real-ip": ip });
}

async function openPage(
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

/** A well-formed code that none of `codes` is. */
function wrongFor(...codes: string[]): string {
	const live = new Set(codes.map((c) => normalizeCode(c)));
	for (const candidate of ["BBBB-BBBB", "CCCC-CCCC", "DDDD-DDDD"]) {
		if (!live.has(normalizeCode(candidate))) return candidate;
	}
	return "FFFF-FFFF";
}

const LIMITED_TEXT = "Too many wrong codes from your network.";

describe("1: only real guesses count, per network; one network cannot lock out the owner (DEC-061, DEC-196)", () => {
	test("junk and malformed input from many networks, the owner's too, leaves the owner able to pair", async () => {
		const { r, tab, address } = await setup();
		const junk = async (ip: string) => {
			const browser = browserAt(r, ip);
			let page = await openPage(browser, r, address);
			for (let i = 0; i < 12; i++) {
				page = await browser.submit(page, {
					action: "connect",
					code: ["junk", "", "123456", "BCDF-GHJ"][i % 4] ?? "",
				});
				expect(page.status).toBe(400);
				expect(page.html).toContain("Enter the 8 letters shown in the page.");
			}
		};
		for (let n = 0; n < 4; n++) await junk(`203.0.113.${n + 1}`);
		await junk("198.51.100.7");
		const owner = browserAt(r, "198.51.100.7");
		const page = await openPage(owner, r, address);
		const done = await owner.submit(page, {
			action: "connect",
			code: tab.pairingCode ?? "",
		});
		expect(done.status).toBe(303);
		expect(r.logs.events("oauth.rate_limited")).toHaveLength(0);
	});

	test("a network that guesses wrong is stopped: its eleventh code is refused unjudged, a right one too; the owner on another network pairs with that same code", async () => {
		const { r, tab, address } = await setup();
		const code = tab.pairingCode ?? "";
		const attacker = browserAt(r, "203.0.113.9");
		let page = await openPage(attacker, r, address);
		const statuses: number[] = [];
		for (let i = 0; i < 11; i++) {
			page = await attacker.submit(page, {
				action: "connect",
				code: wrongFor(code),
			});
			statuses.push(page.status);
		}
		expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
		expect(statuses[10]).toBe(429);
		expect(page.html).toContain(LIMITED_TEXT);
		// The limited network guesses right: refused without a look at the
		// code, which is therefore not used up.
		const right = await attacker.submit(page, { action: "connect", code });
		expect(right.status).toBe(429);
		expect(right.html).toContain(LIMITED_TEXT);
		// A new request does not help it either.
		const fresh = await openPage(attacker, r, address);
		expect(
			(await attacker.submit(fresh, { action: "connect", code })).status,
		).toBe(429);
		await Bun.sleep(20);
		expect(tab.pairingCode).toBe(code);
		expect(r.logs.events("oauth.paired")).toHaveLength(0);

		const owner = browserAt(r, "198.51.100.7");
		const ownerPage = await openPage(owner, r, address);
		const done = await owner.submit(ownerPage, { action: "connect", code });
		expect(done.status).toBe(303);
		expect(r.logs.events("oauth.rate_limited")).toEqual([
			expect.objectContaining({
				limit: "code_guesses",
				ip: "203.0.113.0/24",
			}),
		]);
	});

	// "The brute-force cap per address still holds across networks" stood
	// here. That cap is gone (DEC-196) and none across networks took its
	// place: guesses are limited per network only (10, then one a minute).
	// The test below pins that there is none, not a new cap.
	test("wrong guesses from many networks are no cap on the page: there is no limit per address that strangers could use up for its owner", async () => {
		const { r, tab, address } = await setup();
		const code = tab.pairingCode ?? "";
		// Before, the fourth network was refused here (30 guesses per address
		// from everywhere), which let strangers who knew an address lock its
		// owner out. The code's 20^8 values carry that now.
		for (let n = 0; n < 5; n++) {
			const attacker = browserAt(r, `203.0.113.${20 + n}`);
			let page = await openPage(attacker, r, address);
			for (let i = 0; i < 10; i++) {
				page = await attacker.submit(page, {
					action: "connect",
					code: wrongFor(code),
				});
				expect(page.status).toBe(400);
			}
		}
		// Fifty wrong codes later the page shows the code it showed.
		await Bun.sleep(20);
		expect(tab.pairingCode).toBe(code);
		const owner = browserAt(r, "203.0.113.99");
		const page = await openPage(owner, r, address);
		const res = await owner.submit(page, { action: "connect", code });
		expect(res.status).toBe(303);
	});

	test("the ten guesses are the network's for every app and page: another address buys no new ones", async () => {
		const { r, tab, address } = await setup();
		const second = new ScriptedTab(r.wsUrl, { appId: "other" });
		tabs.push(second);
		const other = (await second.connect()).address;
		const otherCode = await second.startPairing();
		const attacker = browserAt(r, "203.0.113.9");
		let page = await openPage(attacker, r, address);
		for (let i = 0; i < 10; i++) {
			page = await attacker.submit(page, {
				action: "connect",
				code: wrongFor(tab.pairingCode ?? "", otherCode),
			});
			expect(page.status).toBe(400);
		}
		// Before DEC-196 each address had its own share for a network.
		const elsewhere = await openPage(attacker, r, other);
		const wrong = await attacker.submit(elsewhere, {
			action: "connect",
			code: wrongFor(tab.pairingCode ?? "", otherCode),
		});
		expect(wrong.status).toBe(429);
		expect(
			(await attacker.submit(wrong, { action: "connect", code: otherCode }))
				.status,
		).toBe(429);
		const nobody = await openPage(attacker, r, r.relay.addressFor("nobody"));
		expect(
			(await attacker.submit(nobody, { action: "connect", code: "BCDF-GHJK" }))
				.status,
		).toBe(429);
		// The other app's owner, on another network, is not touched.
		const owner = browserAt(r, "198.51.100.7");
		const ownerPage = await openPage(owner, r, other);
		const done = await owner.submit(ownerPage, {
			action: "connect",
			code: otherCode,
		});
		expect(done.status).toBe(303);
	});

	test("a right code is given back: a network that pairs often keeps its ten guesses", async () => {
		const { r, tab, address } = await setup();
		const browser = browserAt(r, "198.51.100.7");
		let last: string | undefined;
		for (let i = 0; i < 6; i++) {
			const code = await tab.nextCode(last);
			const page = await openPage(browser, r, address);
			const done = await browser.submit(page, { action: "connect", code });
			expect(done.status).toBe(303);
			last = code;
		}
		const code = await tab.nextCode(last);
		let page = await openPage(browser, r, address);
		for (let i = 0; i < 10; i++) {
			page = await browser.submit(page, {
				action: "connect",
				code: wrongFor(code),
			});
			expect(page.status).toBe(400);
		}
		expect(
			(await browser.submit(page, { action: "connect", code: wrongFor(code) }))
				.status,
		).toBe(429);
	});
});

describe("2: a grant has an absolute end; refreshes cannot extend it forever", () => {
	test("refresh tokens never outlive grantCreatedAt + grantLifetimeMs", async () => {
		const { r, tab, address } = await setup({
			refreshTokenTtlMs: 60_000,
			grantLifetimeMs: 400,
		});
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
		const done = await browser.submit(page, {
			action: "connect",
			code: tab.pairingCode ?? "",
		});
		const code = new URL(done.location ?? "").searchParams.get("code") ?? "";
		const first = (await (
			await postForm(`${r.url}/token`, {
				grant_type: "authorization_code",
				code,
				redirect_uri: REDIRECT,
				code_verifier: verifier,
				client_id: clientId,
			})
		).json()) as { refresh_token: string; expires_in: number };
		expect(first.expires_in).toBe(0); // capped by the grant's end, not 3600

		const refreshed = await postForm(`${r.url}/token`, {
			grant_type: "refresh_token",
			refresh_token: first.refresh_token,
			client_id: clientId,
		});
		expect(refreshed.status).toBe(200);
		const second = (await refreshed.json()) as { refresh_token: string };
		await Bun.sleep(450);
		const late = await postForm(`${r.url}/token`, {
			grant_type: "refresh_token",
			refresh_token: second.refresh_token,
			client_id: clientId,
		});
		expect(late.status).toBe(400);
		expect(((await late.json()) as { error: string }).error).toBe(
			"invalid_grant",
		);
	});
});

describe("3: per-IP limits count IPv6 by /64 (open requests by /56); open requests are capped per network", () => {
	test("ipPrefixKey: IPv4 as is, IPv6 by /64, mapped IPv4 as IPv4", () => {
		expect(ipPrefixKey("203.0.113.5")).toBe("203.0.113.5");
		expect(ipPrefixKey("2001:db8:1:2::1")).toBe(
			ipPrefixKey("2001:db8:1:2:ffff::9"),
		);
		expect(ipPrefixKey("2001:db8:1:2::1")).not.toBe(
			ipPrefixKey("2001:db8:1:3::1"),
		);
		expect(ipPrefixKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
	});

	test("open authorization requests per /56 are capped, whatever address they are for: the eleventh pushes out the network's oldest; another /56 is not affected (RS 1)", async () => {
		const { r, address } = await setup();
		/** Still open: an action the form does not know shows the form again. */
		const isOpen = async (browser: TestBrowser, page: AuthorizePage) =>
			(await browser.submit(page, { action: "show" })).status === 200;
		// A request is kept for an app nobody serves too (DEC-196), and counts.
		const nobody = r.relay.addressFor("nobody");
		const first = browserAt(r, "2001:db8:1:2::1");
		const kept = await openPage(first, r, address);
		expect(kept.status).toBe(200);
		const second = browserAt(r, "2001:db8:1:2::2");
		const next = await openPage(second, r, address);
		expect(next.status).toBe(200);
		const others: { browser: TestBrowser; page: AuthorizePage }[] = [];
		for (let i = 3; i <= 10; i++) {
			const browser = browserAt(r, `2001:db8:1:2::${i}`);
			const page = await openPage(browser, r, i <= 6 ? address : nobody);
			expect(page.status).toBe(200);
			expect(page.requestId).toBeDefined();
			others.push({ browser, page });
		}
		// Another network first: it takes none of this one's ten.
		const elsewhere = await openPage(
			browserAt(r, "2001:db8:1:100::1"),
			r,
			address,
		);
		expect(elsewhere.status).toBe(200);
		expect(await isOpen(first, kept)).toBe(true);
		// Another /64 of the same /56 is the same subscriber: the eleventh
		// request opens, and the /56's oldest goes for it.
		const sibling = await openPage(browserAt(r, "2001:db8:1:3::1"), r, nobody);
		expect(sibling.status).toBe(200);
		expect(sibling.requestId).toBeDefined();
		expect(await isOpen(first, kept)).toBe(false);
		expect(await isOpen(second, next)).toBe(true);
		// A request that ends gives its place back: the next one evicts nothing.
		expect((await second.submit(next, { action: "cancel" })).status).toBe(303);
		expect((await openPage(second, r, address)).status).toBe(200);
		const [oldest] = others;
		if (oldest === undefined) throw new Error("no request");
		expect(await isOpen(oldest.browser, oldest.page)).toBe(true);
		// And the one after that takes the oldest again.
		expect((await openPage(second, r, nobody)).status).toBe(200);
		expect(await isOpen(oldest.browser, oldest.page)).toBe(false);
	});

	test("there is no cap per address: requests of many networks for one address all stay open", async () => {
		const { r, address } = await setup();
		// Before DEC-196 an address held 20 requests, 5 per network, and the
		// 21st pushed one out (DEC-088).
		const opened: { browser: TestBrowser; page: AuthorizePage }[] = [];
		for (const prefix of [
			"2001:db8:a:100",
			"2001:db8:a:200",
			"2001:db8:a:300",
		]) {
			for (let i = 1; i <= 8; i++) {
				const browser = browserAt(r, `${prefix}::${i}`);
				const page = await openPage(browser, r, address);
				expect(page.status).toBe(200);
				opened.push({ browser, page });
			}
		}
		// Each form is still good: an action it does not know shows it again.
		for (const { browser, page } of opened) {
			expect((await browser.submit(page, { action: "" })).status).toBe(200);
		}
	});

	test("the token endpoint counts a /64 as one client", async () => {
		const { r } = await setup();
		const statuses: number[] = [];
		for (let i = 1; i <= 31; i++) {
			const res = await postForm(
				`${r.url}/token`,
				{
					grant_type: "refresh_token",
					refresh_token: "x",
					client_id: clientId,
				},
				{ "x-real-ip": `2001:db8:5:6::${i.toString(16)}` },
			);
			statuses.push(res.status);
		}
		expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
		expect(statuses[30]).toBe(429);
	});

	test("tab sessions per IP count a /64 as one", async () => {
		const r = startOAuthRelay(cimd, {
			trustProxy: "x-real-ip",
			maxSessionsPerIp: 1,
		});
		current = r;
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
				"x-real-ip": "2001:db8:7:7::1",
			},
			protocols: ["tab-mcp.v1"],
		} as unknown as string[]);
		await new Promise((resolve) =>
			ws.addEventListener("open", resolve, { once: true }),
		);
		const sameNet = await upgrade("2001:db8:7:7::2");
		expect(sameNet.status).toBe(429);
		ws.close();
	});
});

describe("6: tokens minted while a grant is revoked do not survive", () => {
	test("a refresh that races Disconnect fails and leaves no working token", async () => {
		/** A store whose refresh-token puts wait until released. */
		class GatedStore extends MemoryTokenStore {
			gate: Promise<void> | undefined;
			reached: (() => void) | undefined;
			override async put(record: TokenRecord): Promise<boolean> {
				if (record.kind === "refresh" && this.gate !== undefined) {
					this.reached?.();
					await this.gate;
				}
				return super.put(record);
			}
		}
		const store = new GatedStore();
		const { r, tab, address } = await setup({ store });
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
		const done = await browser.submit(page, {
			action: "connect",
			code: tab.pairingCode ?? "",
		});
		const first = (await (
			await postForm(`${r.url}/token`, {
				grant_type: "authorization_code",
				code: new URL(done.location ?? "").searchParams.get("code") ?? "",
				redirect_uri: REDIRECT,
				code_verifier: verifier,
				client_id: clientId,
			})
		).json()) as { refresh_token: string };
		const added = (await tab.next("grant.added")) as unknown as {
			grant: { grantId: string };
		};

		let release: () => void = () => {};
		store.gate = new Promise((resolve) => {
			release = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			store.reached = resolve;
		});
		const refreshing = postForm(`${r.url}/token`, {
			grant_type: "refresh_token",
			refresh_token: first.refresh_token,
			client_id: clientId,
		});
		await reached; // the refresh is between markUsed and storing new tokens
		tab.send({ type: "grant.revoke", grantId: added.grant.grantId });
		await tab.next("grant.removed");
		store.gate = undefined;
		release();
		const res = await refreshing;
		expect(res.status).toBe(400);
		expect(await store.listGrants(tab.addressId, Date.now())).toEqual([]);
		const body = (await res.json()) as { access_token?: string };
		expect(body.access_token).toBeUndefined();
		expect(
			(await mcpPost(address, rpc(1, "tools/list"), { token: "x" })).status,
		).toBe(401);
	});
});

describe("7: the verified host is part of the heading and the title", () => {
	test("Connect <name> from <host>", async () => {
		const { r, address } = await setup();
		const page = await openPage(browserAt(r, "198.51.100.7"), r, address);
		const host = new URL(clientId).host;
		expect(page.html).toContain(`<h1>Connect Test AI from ${host}</h1>`);
		expect(page.html).toContain(`<title>Connect Test AI from ${host}</title>`);
	});
});
