/** Sites (DEC-045): per-origin configuration, app names, limits. */
import { afterEach, describe, expect, test } from "bun:test";
import {
	ConfigError,
	configFromEnv,
	MIN_MESSAGE_BYTES,
	resolveConfig,
	siteFor,
} from "../src/config.ts";
import type { CreateRelayOptions } from "../src/relay.ts";
import { ORIGIN, ScriptedTab, startRelay, type TestRelay } from "./helpers.ts";

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
					limits: { maxConcurrentRequests: 2 },
				},
			],
		});
		expect(c.sites).toEqual([
			{
				origin: "https://ractive.ch",
				name: "saturnus",
				pairing: "code",
				limits: { maxConcurrentRequests: 2 },
			},
		]);
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
		).toThrow(/planned/);
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
			TAB_MCP_SITES: '[{"origin":"https://ractive.ch","name":"saturnus"}]',
			TAB_MCP_CLIENT_ID_HOSTS: "claude.ai, chatgpt.com",
		});
		expect(env.sites).toEqual([
			{ origin: "https://ractive.ch", name: "saturnus" },
		]);
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
			page: { title: "" },
			app: { name: "x".repeat(65) },
			secret: t.secret,
		});
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
