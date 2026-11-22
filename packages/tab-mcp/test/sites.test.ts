/**
 * Sites (DEC-045): per-origin configuration, app names, limits, and the apps
 * a site reserves (DEC-197).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	ConfigError,
	configFromEnv,
	MIN_MESSAGE_BYTES,
	resolveConfig,
	siteFor,
} from "../src/config.ts";
import type { CreateRelayOptions } from "../src/relay.ts";
import {
	APP,
	mcpPost,
	ORIGIN,
	rpc,
	ScriptedTab,
	startRelay,
	type TabOptions,
	type TestRelay,
	tokenFor,
	waitFor,
} from "./helpers.ts";

let current: TestRelay | undefined;
const tabs: ScriptedTab[] = [];
afterEach(async () => {
	for (const t of tabs.splice(0)) if (t.ws.readyState <= 1) t.close();
	await current?.stop();
	current = undefined;
});

function relay(options: CreateRelayOptions): TestRelay {
	current = startRelay(options);
	return current;
}

describe("configuration", () => {
	const base = { publicUrl: "https://relay.example" };

	test("sites are validated and normalised", () => {
		const c = resolveConfig({
			...base,
			sites: [
				{
					origin: "HTTPS://Ractive.CH",
					name: "saturnus",
					apps: ["saturnus", "hp-48", "saturnus", "a", "0"],
					limits: { maxConcurrentRequests: 2 },
				},
			],
		});
		expect(c.sites).toEqual([
			{
				origin: "https://ractive.ch",
				name: "saturnus",
				// Each app once, in the order given.
				apps: ["saturnus", "hp-48", "a", "0"],
				limits: { maxConcurrentRequests: 2 },
			},
		]);
	});

	test("site apps must be a list of at least one app id (DEC-197)", () => {
		const bad: unknown[] = [
			"notes",
			[],
			{},
			{ 0: "notes", length: 1 },
			null,
			true,
			["Notes"],
			["-notes"],
			["notes-"],
			["-"],
			["no tes"],
			["no_tes"],
			["no.tes"],
			["notes/x"],
			["nötes"],
			[""],
			["a".repeat(33)],
			[1],
			[["notes"]],
			["notes", ""],
			["notes", "Other"],
			["notes", null],
		];
		for (const apps of bad) {
			expect(() =>
				resolveConfig({
					...base,
					sites: [{ origin: "https://a.example", apps: apps as never }],
				}),
			).toThrow(
				"site apps must be a list of app ids (1-32 characters of a-z, 0-9 and -): https://a.example",
			);
		}
		// The longest id, and one site's app listed by another too.
		const c = resolveConfig({
			...base,
			sites: [
				{ origin: "https://a.example", apps: ["a".repeat(32), "shared"] },
				{ origin: "https://b.example", apps: ["shared"] },
			],
		});
		expect(c.sites.map((s) => s.apps)).toEqual([
			["a".repeat(32), "shared"],
			["shared"],
		]);
	});

	test("the configuration's list is not the caller's: changing that afterwards changes nothing", () => {
		const apps = ["notes"];
		const c = resolveConfig({
			...base,
			sites: [{ origin: "https://a.example", apps }],
		});
		apps.push("other");
		expect(c.sites[0]?.apps).toEqual(["notes"]);
	});

	test("bad sites are refused", () => {
		const bad: unknown[] = [
			{ name: "x" },
			{ origin: "https://a.example/path" },
			{ origin: "https://a.example", pairing: "oidc" },
			{ origin: "https://a.example", pairing: "magic" },
			{ origin: "https://a.example", name: "" },
			{ origin: "https://a.example", name: "x".repeat(65) },
			{ origin: "https://a.example", name: "a\u0007b" },
			{ origin: "https://a.example", color: "red" },
			{ origin: "https://a.example", limits: { maxSessions: 3 } },
			{ origin: "https://a.example", limits: { idleTimeoutMs: -1 } },
			{ origin: "https://a.example", limits: { maxMessageBytes: 1000 } },
		];
		for (const site of bad) {
			expect(() => resolveConfig({ ...base, sites: [site as never] })).toThrow(
				ConfigError,
			);
		}
		expect(() =>
			resolveConfig({
				...base,
				allowedOrigins: ["https://a.example"],
				sites: [{ origin: "https://a.example" }],
			}),
		).toThrow(/twice/);
		expect(() =>
			resolveConfig({
				...base,
				sites: [{ origin: "https://a.example", pairing: "oidc" }],
			}),
		).toThrow(/TAB_MCP_OIDC_ISSUER/);
	});

	test("maxMessageBytes has a floor of 16 KiB", () => {
		expect(MIN_MESSAGE_BYTES).toBe(16_384);
		expect(() => resolveConfig({ ...base, maxMessageBytes: 16_383 })).toThrow(
			/16 KiB/,
		);
		expect(
			resolveConfig({ ...base, maxMessageBytes: 16_384 }).maxMessageBytes,
		).toBe(16_384);
	});

	test("TAB_MCP_SITES (JSON) and TAB_MCP_CLIENT_ID_HOSTS", () => {
		const env = configFromEnv({
			TAB_MCP_SITES:
				'[{"origin":"https://ractive.ch","name":"saturnus","apps":["saturnus","hp-48"]}]',
			TAB_MCP_CLIENT_ID_HOSTS: "claude.ai, chatgpt.com",
		});
		expect(env.sites).toEqual([
			{
				origin: "https://ractive.ch",
				name: "saturnus",
				apps: ["saturnus", "hp-48"],
			},
		]);
		// A site's fields are checked when the configuration is resolved.
		const badApps = configFromEnv({
			TAB_MCP_SITES: '[{"origin":"https://ractive.ch","apps":"saturnus"}]',
		});
		expect(() => resolveConfig({ ...base, ...badApps })).toThrow(
			/site apps must be a list of app ids/,
		);
		expect(env.clientIdHosts).toEqual(["claude.ai", "chatgpt.com"]);
		expect(() => configFromEnv({ TAB_MCP_SITES: "{nope" })).toThrow(
			ConfigError,
		);
		expect(() => configFromEnv({ TAB_MCP_SITES: '{"origin":"x"}' })).toThrow(
			ConfigError,
		);
		expect(() =>
			resolveConfig({ ...base, clientIdHosts: ["https://claude.ai"] }),
		).toThrow(ConfigError);
	});

	test("siteFor: configured sites win, allowed origins and the open relay get the defaults", () => {
		const c = resolveConfig({
			...base,
			allowedOrigins: ["https://b.example"],
			sites: [
				{
					origin: "https://a.example",
					name: "A",
					limits: { requestTimeoutMs: 1000 },
				},
			],
		});
		expect(siteFor(c, "https://a.example")).toMatchObject({
			origin: "https://a.example",
			name: "A",
			pairing: "code",
			limits: { requestTimeoutMs: 1000, maxConcurrentRequests: 8 },
		});
		expect(siteFor(c, "https://b.example")?.limits.requestTimeoutMs).toBe(
			300_000,
		);
		expect(siteFor(c, "https://c.example")).toBeUndefined();
		expect(siteFor(c, null)).toBeUndefined();
		const open = resolveConfig({
			...base,
			allowedOrigins: "*",
			sites: [{ origin: "https://a.example", name: "A" }],
		});
		expect(siteFor(open, "https://c.example")?.origin).toBe("*");
		expect(siteFor(open, "https://a.example")?.name).toBe("A");
		expect(siteFor(resolveConfig(base), "https://a.example")).toBeUndefined();
		// A site's apps come with it; an origin without a site has none.
		const reserving = resolveConfig({
			...base,
			allowedOrigins: ["https://b.example"],
			sites: [{ origin: "https://a.example", apps: ["notes"] }],
		});
		expect(siteFor(reserving, "https://a.example")?.apps).toEqual(["notes"]);
		expect(siteFor(reserving, "https://b.example")).not.toHaveProperty("apps");
		expect(siteFor(c, "https://a.example")).not.toHaveProperty("apps");
	});
});

describe("sessions", () => {
	test("a configured site's name and limits reach the session; its name beats the page's", async () => {
		const r = relay({
			allowedOrigins: [],
			sites: [
				{
					origin: ORIGIN,
					name: "saturnus",
					limits: { maxConcurrentRequests: 2, maxMessageBytes: 32_768 },
				},
			],
		});
		const t = new ScriptedTab(r.wsUrl, { app: "pretender" });
		tabs.push(t);
		const s = await t.connect();
		expect(s.appName).toBe("saturnus");
		expect(s.limits.maxConcurrentRequests).toBe(2);
		expect(s.limits.maxMessageBytes).toBe(32_768);
		expect(s.limits.requestTimeoutMs).toBe(300_000);
	});

	test("without a configured name, the page's app name is used", async () => {
		const r = relay({});
		const t = new ScriptedTab(r.wsUrl, { app: "calculator" });
		tabs.push(t);
		expect((await t.connect()).appName).toBe("calculator");
		const anonymous = new ScriptedTab(r.wsUrl);
		tabs.push(anonymous);
		expect((await anonymous.connect()).appName).toBeUndefined();
	});

	test("a malformed app name in hello is a protocol error", async () => {
		const r = relay({});
		const t = new ScriptedTab(r.wsUrl, { app: "x".repeat(65) });
		tabs.push(t);
		await t.opened;
		t.send({
			type: "hello",
			library: { name: "t", version: "1" },
			// A good id, so that the name is what is wrong.
			app: { id: APP, name: "x".repeat(65) },
			secret: t.secret,
		});
		const error = (await t.next("error")) as { code: string; message: string };
		expect(error.code).toBe("bad_message");
		expect(error.message).toContain("hello.app.name");
		expect((await t.closed).code).toBe(1008);
	});

	test("an origin that is not a site is refused", async () => {
		const r = relay({
			allowedOrigins: [],
			sites: [{ origin: "https://other.example" }],
		});
		const res = await fetch(`http://127.0.0.1:${r.relay.port}/tab`, {
			headers: { origin: ORIGIN, "sec-websocket-protocol": "tab-mcp.v1" },
		});
		expect(res.status).toBe(403);
	});
});

describe("sites may reserve apps (DEC-197)", () => {
	const LISTING = "https://listing.example";
	const SECOND = "https://second.example";
	const PLAIN = "https://plain.example";
	const ALLOWED = "https://allowed.example";

	/** Say hello as `options` have it; the session, or the refusal. */
	async function hello(
		r: TestRelay,
		options: TabOptions,
	): Promise<
		| { tab: ScriptedTab; address: string }
		| { tab: ScriptedTab; error: string; message: string; close: number }
	> {
		const t = new ScriptedTab(r.wsUrl, options);
		tabs.push(t);
		const session = t.connect();
		const first = await Promise.race([
			session.then((s) => ({ address: s.address })),
			t.next("error").then((e) => e as { code: string; message: string }),
		]);
		if ("address" in first) return { tab: t, address: first.address };
		return {
			tab: t,
			error: first.code,
			message: first.message,
			close: (await t.closed).code,
		};
	}

	const refusal = (origin: string, app: string) => ({
		error: "app_not_allowed",
		message: `this relay does not let ${origin} serve the app "${app}"`,
		// Policy violation: the page's library does not connect again.
		close: 1008,
	});

	test("a site that lists apps serves those and no other; the refusal names origin and app, and is logged", async () => {
		const r = relay({
			allowedOrigins: [],
			sites: [{ origin: LISTING, apps: ["notes", "calc"] }],
		});
		for (const appId of ["notes", "calc"]) {
			expect(await hello(r, { origin: LISTING, appId })).toMatchObject({
				address: `${r.relay.url}/s/${appId}/mcp`,
			});
		}
		expect(r.relay.sessionCount).toBe(2);
		for (const appId of ["other", "note", "notes2", APP]) {
			expect(await hello(r, { origin: LISTING, appId })).toMatchObject(
				refusal(LISTING, appId),
			);
		}
		await waitFor(() => r.relay.sessionCount === 2, "the refused to close");
		expect(r.logs.events("tab.refused").at(-1)).toMatchObject({
			level: "warn",
			reason: "app_not_allowed",
			origin: LISTING,
			app: APP,
		});
		expect(r.logs.events("tab.refused")).toHaveLength(4);
		expect(r.logs.events("tab.session")).toHaveLength(2);
		expect(r.relay.pagesOf("other")).toEqual([]);
	});

	test("an origin that does not list a reserved app may not serve it: another site, with apps of its own or without, and an allowed origin", async () => {
		const r = relay({
			allowedOrigins: [ALLOWED],
			sites: [
				{ origin: LISTING, apps: ["notes"] },
				{ origin: SECOND, apps: ["calc"] },
				{ origin: PLAIN, name: "Plain" },
			],
		});
		for (const origin of [SECOND, PLAIN, ALLOWED]) {
			expect(await hello(r, { origin, appId: "notes" })).toMatchObject(
				refusal(origin, "notes"),
			);
		}
		expect(r.relay.pagesOf("notes")).toEqual([]);
		expect(await hello(r, { origin: LISTING, appId: "notes" })).toHaveProperty(
			"address",
		);
	});

	test("on an open relay no other origin serves a reserved app, whatever it sends as its origin", async () => {
		const r = relay({
			allowedOrigins: "*",
			sites: [{ origin: LISTING, apps: ["notes"] }],
		});
		for (const origin of [
			"https://anyone.example",
			"http://localhost:5173",
			`chrome-extension://${"a".repeat(32)}`,
			// Not the site: another scheme, port, host or case of it.
			"http://listing.example",
			"https://listing.example:444",
			"https://www.listing.example",
		]) {
			expect(await hello(r, { origin, appId: "notes" })).toMatchObject(
				refusal(origin, "notes"),
			);
		}
		// An origin the relay does not keep (RS 6) is "this page".
		expect(
			await hello(r, {
				origin: "https://listing.example (verified)",
				appId: "notes",
			}),
		).toMatchObject({
			error: "app_not_allowed",
			message: 'this relay does not let this page serve the app "notes"',
		});
		expect(await hello(r, { origin: LISTING, appId: "notes" })).toHaveProperty(
			"address",
		);
		// What nobody lists is anyone's there.
		expect(
			await hello(r, { origin: "https://anyone.example", appId: "other" }),
		).toHaveProperty("address");
	});

	test("an app no site lists is open to every origin the relay serves, but not to a site with a list of its own", async () => {
		const r = relay({
			allowedOrigins: [ALLOWED],
			sites: [
				{ origin: LISTING, apps: ["notes"] },
				{ origin: PLAIN, name: "Plain" },
			],
		});
		for (const origin of [ALLOWED, PLAIN]) {
			expect(await hello(r, { origin, appId: "free" })).toMatchObject({
				address: `${r.relay.url}/s/free/mcp`,
			});
		}
		expect(await hello(r, { origin: LISTING, appId: "free" })).toMatchObject(
			refusal(LISTING, "free"),
		);
		expect(r.relay.pagesOf("free")).toHaveLength(2);
	});

	test("two sites may list one app: both serve it", async () => {
		const r = relay({
			allowedOrigins: [ALLOWED],
			sites: [
				{ origin: LISTING, apps: ["shared", "notes"] },
				{ origin: SECOND, apps: ["shared"] },
			],
		});
		for (const origin of [LISTING, SECOND]) {
			expect(await hello(r, { origin, appId: "shared" })).toHaveProperty(
				"address",
			);
		}
		expect(r.relay.pagesOf("shared")).toHaveLength(2);
		expect(await hello(r, { origin: SECOND, appId: "notes" })).toMatchObject(
			refusal(SECOND, "notes"),
		);
		expect(await hello(r, { origin: ALLOWED, appId: "shared" })).toMatchObject(
			refusal(ALLOWED, "shared"),
		);
	});

	test("any Firefox extension (moz-extension://*) serves what nobody lists, and no reserved app", async () => {
		const firefox = "moz-extension://3f9a6c2e-1b7d-4e8a-9c5f-2d4b6a8e0c1f";
		const r = relay({
			allowedOrigins: ["moz-extension://*"],
			sites: [{ origin: LISTING, apps: ["notes"] }],
		});
		expect(await hello(r, { origin: firefox, appId: "notes" })).toMatchObject(
			refusal(firefox, "notes"),
		);
		expect(await hello(r, { origin: firefox, appId: "free" })).toHaveProperty(
			"address",
		);
	});

	test("a refused page does not take the address of the page that holds it: no bye, no revocation, and its requests keep arriving", async () => {
		const r = relay({
			allowedOrigins: [ALLOWED],
			sites: [{ origin: LISTING, apps: ["notes"] }],
		});
		const held = await hello(r, { origin: LISTING, appId: "notes" });
		if (!("address" in held)) throw new Error("not connected");
		const holder = held.tab;
		const token = await tokenFor(r.store, holder.addressId, { app: "notes" });
		// A page of an origin that may not serve the app says hello with the
		// same secret, and asks for every grant of the address to be revoked.
		for (const revokeAll of [false, true]) {
			expect(
				await hello(r, {
					origin: ALLOWED,
					appId: "notes",
					secret: holder.secret,
					revokeAll,
				}),
			).toMatchObject(refusal(ALLOWED, "notes"));
		}
		await waitFor(() => r.relay.sessionCount === 1, "the refused to close");
		expect(holder.ws.readyState).toBe(WebSocket.OPEN);
		expect(holder.received.filter((m) => m.type !== "ping")).toEqual([]);
		expect(r.relay.pagesOf("notes")).toEqual([holder.addressId]);
		expect(await r.store.listGrants(holder.addressId, Date.now())).toHaveLength(
			1,
		);
		const res = await mcpPost(
			held.address,
			rpc(1, "tools/call", { name: "add", arguments: { a: 1, b: 2 } }),
			{ token },
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('"text":"3"');

		// The same hello from the site itself does take the address: that the
		// refused one did not is the check above, not a relay that never
		// replaces.
		const again = await hello(r, {
			origin: LISTING,
			appId: "notes",
			secret: holder.secret,
		});
		expect(again).toHaveProperty("address");
		expect(await holder.next("bye")).toMatchObject({ reason: "replaced" });
		expect((await holder.closed).code).toBe(4005);
	});
});

describe("extension origins (DEC-108)", () => {
	const ext = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
	const other = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";

	test("a listed extension opens a session; the session carries its origin", async () => {
		const r = relay({ allowedOrigins: [`${ext}/`] });
		const t = new ScriptedTab(r.wsUrl, { origin: ext, app: "Overmark" });
		tabs.push(t);
		const s = await t.connect();
		expect(s.origin).toBe(ext);
		expect(s.appName).toBe("Overmark");
	});

	test("a configured extension site gets its name", async () => {
		const r = relay({
			allowedOrigins: [],
			sites: [
				{
					origin: "chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",
					name: "Overmark",
				},
			],
		});
		const t = new ScriptedTab(r.wsUrl, { origin: ext, app: "pretender" });
		tabs.push(t);
		expect((await t.connect()).appName).toBe("Overmark");
	});

	test("another extension, and a page of the web, are refused", async () => {
		const r = relay({ allowedOrigins: [ext] });
		for (const origin of [other, `${ext}/`, "https://page.example"]) {
			const res = await fetch(`http://127.0.0.1:${r.relay.port}/tab`, {
				headers: { origin, "sec-websocket-protocol": "tab-mcp.v1" },
			});
			expect(res.status).toBe(403);
		}
		expect(siteFor(r.relay.config, other)).toBeUndefined();
	});

	test("an open relay admits extensions", async () => {
		const r = relay({ allowedOrigins: "*" });
		const t = new ScriptedTab(r.wsUrl, { origin: other });
		tabs.push(t);
		expect((await t.connect()).origin).toBe(other);
	});
});

describe("any Firefox extension (moz-extension://*, iteration 44)", () => {
	const firefox = "moz-extension://3f9a6c2e-1b7d-4e8a-9c5f-2d4b6a8e0c1f";

	test("admits a Firefox extension's page, which pairs by code and keeps its origin", async () => {
		const r = relay({
			allowedOrigins: ["https://page.example", "MOZ-EXTENSION://*"],
		});
		expect(r.relay.config.allowedOrigins).toContain("moz-extension://*");
		const t = new ScriptedTab(r.wsUrl, { origin: firefox, app: "tab-mcp" });
		tabs.push(t);
		expect((await t.connect()).origin).toBe(firefox);
		expect(siteFor(r.relay.config, firefox)).toMatchObject({
			origin: firefox,
			pairing: "code",
		});
	});

	test("admits nothing else: not a made-up moz-extension origin, not Chrome's, not the web", async () => {
		const r = relay({ allowedOrigins: ["moz-extension://*"] });
		for (const origin of [
			"moz-extension://*",
			"moz-extension://not-a-uuid",
			`${firefox}/`,
			"moz-extension://3F9A6C2E-1B7D-4E8A-9C5F-2D4B6A8E0C1F",
			"safari-web-extension://3f9a6c2e-1b7d-4e8a-9c5f-2d4b6a8e0c1f",
			"chrome-extension://abcdefghijklmnopabcdefghijklmnop",
			"https://page.example",
		]) {
			expect(siteFor(r.relay.config, origin)).toBeUndefined();
			const res = await fetch(`http://127.0.0.1:${r.relay.port}/tab`, {
				headers: { origin, "sec-websocket-protocol": "tab-mcp.v1" },
			});
			expect(res.status).toBe(403);
		}
	});

	test("one Firefox extension cannot be listed, nor named in TAB_MCP_SITES", () => {
		expect(() => relay({ allowedOrigins: [firefox] })).toThrow(
			"moz-extension://* in TAB_MCP_ALLOWED_ORIGINS",
		);
		expect(() =>
			relay({
				allowedOrigins: [],
				sites: [{ origin: "moz-extension://*", name: "tab-mcp for Firefox" }],
			}),
		).toThrow();
	});
});
