import { describe, expect, test } from "bun:test";
import {
	ConfigError,
	configFromEnv,
	DEFAULT_CONFIG,
	isExtensionOrigin,
	normalizePageOrigin,
	resolveConfig,
} from "../src/config.ts";

describe("config", () => {
	test("defaults follow DEC-034", () => {
		const c = resolveConfig({ publicUrl: "https://relay.example" });
		expect(c.requestTimeoutMs).toBe(300_000);
		expect(c.keepAliveMs).toBe(20_000);
		expect(c.idleTimeoutMs).toBe(3_600_000);
		expect(c.sessionLifetimeMs).toBe(43_200_000);
		expect(c.maxSessionsPerIp).toBe(5);
		expect(c.maxMessageBytes).toBe(1_048_576);
		expect(c.accessTokenTtlMs).toBe(3_600_000);
		expect(c.refreshTokenTtlMs).toBe(30 * 24 * 3_600_000);
		expect(c.allowedOrigins).toEqual([]);
		expect(c.store).toBe("sqlite");
		expect(c.cors).toBe(true);
	});

	test("the public URL is required and must be https outside development", () => {
		expect(() => resolveConfig({})).toThrow(ConfigError);
		expect(() => resolveConfig({ publicUrl: "http://relay.example" })).toThrow(
			/https/,
		);
		expect(
			resolveConfig({ publicUrl: "http://localhost:1", development: true })
				.publicUrl,
		).toBe("http://localhost:1");
		expect(resolveConfig({ development: true }).publicUrl).toBeUndefined();
	});

	test("origins are normalised; paths are refused", () => {
		const c = resolveConfig({
			publicUrl: "https://r.example/",
			allowedOrigins: ["HTTPS://Ractive.CH"],
		});
		expect(c.publicUrl).toBe("https://r.example");
		expect(c.allowedOrigins).toEqual(["https://ractive.ch"]);
		expect(() =>
			resolveConfig({
				publicUrl: "https://r.example",
				allowedOrigins: ["https://ractive.ch/saturnus"],
			}),
		).toThrow(/origin/);
	});

	test("environment variables", () => {
		const env = configFromEnv({
			TAB_MCP_PUBLIC_URL: "https://relay.example",
			TAB_MCP_PORT: "9000",
			TAB_MCP_ALLOWED_ORIGINS: "https://a.example, https://b.example",
			TAB_MCP_CORS: "off",
			TAB_MCP_STORE: "memory",
			TAB_MCP_SQLITE_PATH: "/data/tab-mcp.db",
			TAB_MCP_REQUEST_TIMEOUT_S: "1.5",
			TAB_MCP_MAX_SESSIONS_PER_IP: "2",
			TAB_MCP_TRUST_PROXY: "x-real-ip",
		});
		expect(env).toEqual({
			publicUrl: "https://relay.example",
			port: 9000,
			allowedOrigins: ["https://a.example", "https://b.example"],
			cors: false,
			store: "memory",
			sqlitePath: "/data/tab-mcp.db",
			requestTimeoutMs: 1500,
			maxSessionsPerIp: 2,
			trustProxy: "x-real-ip",
		});
		expect(
			configFromEnv({ TAB_MCP_ALLOWED_ORIGINS: " * " }).allowedOrigins,
		).toBe("*");
		expect(configFromEnv({ NODE_ENV: "development" }).development).toBe(true);
	});

	test("bad environment values throw", () => {
		expect(() => configFromEnv({ TAB_MCP_STORE: "redis" })).toThrow(
			ConfigError,
		);
		expect(() => configFromEnv({ TAB_MCP_IDLE_TIMEOUT_S: "-1" })).toThrow(
			ConfigError,
		);
		expect(() => configFromEnv({ TAB_MCP_PORT: "x" })).toThrow(ConfigError);
		expect(() =>
			resolveConfig({ publicUrl: "https://r.example", maxSessions: 0 }),
		).toThrow(ConfigError);
	});

	test("TAB_MCP_PAGE_WAIT_S: 10 s by default, 0 turns it off, at most 60 s (DEC-074)", () => {
		expect(DEFAULT_CONFIG.pageWaitMs).toBe(10_000);
		expect(configFromEnv({ TAB_MCP_PAGE_WAIT_S: "0" }).pageWaitMs).toBe(0);
		expect(configFromEnv({ TAB_MCP_PAGE_WAIT_S: "2.5" }).pageWaitMs).toBe(
			2_500,
		);
		expect(() => configFromEnv({ TAB_MCP_PAGE_WAIT_S: "-1" })).toThrow(
			ConfigError,
		);
		expect(
			resolveConfig({ publicUrl: "https://r.example", pageWaitMs: 0 })
				.pageWaitMs,
		).toBe(0);
		expect(() =>
			resolveConfig({ publicUrl: "https://r.example", pageWaitMs: 61_000 }),
		).toThrow(ConfigError);
	});

	test("DEFAULT_CONFIG has no public URL", () => {
		expect(DEFAULT_CONFIG.publicUrl).toBeUndefined();
	});
});

describe("extension origins (DEC-108)", () => {
	const id = "abcdefghijklmnopabcdefghijklmnop";
	const ext = `chrome-extension://${id}`;

	test("a Chrome or Edge extension's origin is a page origin, in lower case", () => {
		expect(normalizePageOrigin(ext)).toBe(ext);
		expect(normalizePageOrigin(`${ext}/`)).toBe(ext);
		expect(
			normalizePageOrigin(` CHROME-EXTENSION://${id.toUpperCase()} `),
		).toBe(ext);
		expect(normalizePageOrigin("HTTPS://Ractive.CH")).toBe(
			"https://ractive.ch",
		);
		const c = resolveConfig({
			publicUrl: "https://r.example",
			allowedOrigins: [`${ext}/`, "https://ractive.ch"],
			sites: [
				{ origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba" },
			],
		});
		expect(c.allowedOrigins).toEqual([ext, "https://ractive.ch"]);
		expect(c.sites[0]?.origin).toBe(
			"chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba",
		);
		expect(isExtensionOrigin(ext)).toBe(true);
		expect(
			isExtensionOrigin("moz-extension://0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"),
		).toBe(true);
		expect(
			isExtensionOrigin(
				"safari-web-extension://0F1E2D3C-4B5A-6978-8A9B-0C1D2E3F4A5B",
			),
		).toBe(true);
		expect(isExtensionOrigin("https://ractive.ch")).toBe(false);
		expect(isExtensionOrigin("chrome-extension://")).toBe(false);
		// What a non-browser client could send to an open relay.
		expect(isExtensionOrigin("chrome-extension://x")).toBe(false);
		expect(isExtensionOrigin("safari-web-extension://Your Bank Support")).toBe(
			false,
		);
		expect(isExtensionOrigin("moz-extension://0f1e2d3c-4b5a-6978")).toBe(false);
	});

	test("malformed ids, paths and other extension schemes are refused", () => {
		const bad: [string, RegExp][] = [
			["chrome-extension://abcdefghijklmnopabcdefghijklmno", /32-letter/],
			[`chrome-extension://${id}a`, /32-letter/],
			["chrome-extension://abcdefghijklmnopabcdefghijklmnoz", /32-letter/],
			[`chrome-extension://${id}/side-panel.html`, /32-letter/],
			[`chrome-extension://${id}:8080`, /32-letter/],
			["chrome-extension://", /32-letter/],
			[`moz-extension://${id}`, /Firefox and Safari/],
			[
				"safari-web-extension://0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0",
				/Firefox and Safari/,
			],
			["ftp://ractive.ch", /http, https or chrome-extension/],
			["file:///tmp", /http, https or chrome-extension/],
			["ractive.ch", /not an origin/],
		];
		for (const [value, message] of bad) {
			expect(() => normalizePageOrigin(value)).toThrow(message);
			expect(() =>
				resolveConfig({
					publicUrl: "https://r.example",
					allowedOrigins: [value],
				}),
			).toThrow(ConfigError);
		}
	});

	test("the public URL is never an extension origin", () => {
		expect(() => resolveConfig({ publicUrl: ext, development: true })).toThrow(
			/http or https/,
		);
	});

	test("TAB_MCP_ALLOWED_ORIGINS and TAB_MCP_SITES take extension origins", () => {
		const env = configFromEnv({
			TAB_MCP_PUBLIC_URL: "https://relay.example",
			TAB_MCP_ALLOWED_ORIGINS: `https://ractive.ch, ${ext}`,
			TAB_MCP_SITES: `[{"origin":"chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba","name":"Overmark"}]`,
		});
		const c = resolveConfig(env);
		expect(c.allowedOrigins).toEqual(["https://ractive.ch", ext]);
		expect(c.sites).toEqual([
			{
				origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba",
				name: "Overmark",
			},
		]);
	});
});
