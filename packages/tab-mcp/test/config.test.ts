import { describe, expect, test } from "bun:test";
import {
	ConfigError,
	configFromEnv,
	DEFAULT_CONFIG,
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

	test("DEFAULT_CONFIG has no public URL", () => {
		expect(DEFAULT_CONFIG.publicUrl).toBeUndefined();
	});
});
