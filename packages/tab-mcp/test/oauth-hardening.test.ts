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
import type { CreateRelayOptions } from "../src/relay.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import type { TokenRecord } from "../src/store/types.ts";
import { mcpPost, rpc, ScriptedTab, waitFor } from "./helpers.ts";
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

const wrongFor = (code: string) => (code === "000000" ? "000001" : "000000");

describe("1: only real guesses count against an address; one network cannot lock out the owner", () => {
	test("junk and malformed input from many networks leaves the owner able to pair", async () => {
		const { r, tab, address } = await setup();
		for (let n = 0; n < 4; n++) {
			const attacker = browserAt(r, `203.0.113.${n + 1}`);
			let page = await openPage(attacker, r, address);
			for (let i = 0; i < 10; i++) {
				page = await attacker.submit(page, {
					action: "connect",
					code: i % 2 === 0 ? "junk" : "",
				});
				expect(page.status).toBe(400);
			}
		}
		const owner = browserAt(r, "198.51.100.7");
		const page = await openPage(owner, r, address);
		const done = await owner.submit(page, {
			action: "connect",
			code: tab.pairingCode ?? "",
		});
		expect(done.status).toBe(303);
	});

	test("a network that guesses wrong is stopped; the owner on another network still pairs", async () => {
		const { r, tab, address } = await setup();
		const attacker = browserAt(r, "203.0.113.9");
		let page = await openPage(attacker, r, address);
		const statuses: number[] = [];
		for (let i = 0; i < 11; i++) {
			page = await attacker.submit(page, {
				action: "connect",
				code: wrongFor(tab.pairingCode ?? ""),
			});
			statuses.push(page.status);
		}
		expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
		expect(statuses[10]).toBe(429);
		expect(page.html).toContain("New address");

		await waitFor(() => tab.pairingCode !== undefined, "a code");
		const owner = browserAt(r, "198.51.100.7");
		const ownerPage = await openPage(owner, r, address);
		const done = await owner.submit(ownerPage, {
			action: "connect",
			code: tab.pairingCode ?? "",
		});
		expect(done.status).toBe(303);
	});

	test("the brute-force cap per address still holds across networks", async () => {
		const { r, tab, address } = await setup();
		for (let n = 0; n < 3; n++) {
			const attacker = browserAt(r, `203.0.113.${20 + n}`);
			let page = await openPage(attacker, r, address);
			for (let i = 0; i < 10; i++) {
				page = await attacker.submit(page, {
					action: "connect",
					code: wrongFor(tab.pairingCode ?? ""),
				});
				expect(page.status).toBe(400);
			}
		}
		const fourth = browserAt(r, "203.0.113.99");
		const page = await openPage(fourth, r, address);
		const res = await fourth.submit(page, {
			action: "connect",
			code: tab.pairingCode ?? "",
		});
		expect(res.status).toBe(429);
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

describe("3: per-IP limits count IPv6 by /64; open requests are capped, not evicted", () => {
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

	test("open authorization requests per /64 are capped; another /64 is not affected", async () => {
		const { r, address } = await setup();
		for (let i = 1; i <= 10; i++) {
			const page = await openPage(
				browserAt(r, `2001:db8:1:2::${i}`),
				r,
				address,
			);
			expect(page.status).toBe(200);
		}
		const same = await openPage(browserAt(r, "2001:db8:1:2::ffff"), r, address);
		expect(same.status).toBe(429);
		const other = await openPage(browserAt(r, "2001:db8:1:3::1"), r, address);
		expect(other.status).toBe(200);
	});

	test("open authorization requests per address are capped", async () => {
		const { r, address } = await setup();
		for (const prefix of ["2001:db8:a:1", "2001:db8:a:2"]) {
			for (let i = 1; i <= 10; i++) {
				const page = await openPage(
					browserAt(r, `${prefix}::${i}`),
					r,
					address,
				);
				expect(page.status).toBe(200);
			}
		}
		const third = await openPage(browserAt(r, "2001:db8:a:3::1"), r, address);
		expect(third.status).toBe(429);
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
