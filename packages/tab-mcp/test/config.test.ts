import { describe, expect, test } from "bun:test";
import {
	appAllowed,
	ConfigError,
	configFromEnv,
	DEFAULT_CONFIG,
	describeConfigError,
	isAppId,
	isExtensionOrigin,
	MAX_APP_ID,
	normalizePageOrigin,
	pairingKindsOf,
	type RelayConfig,
	resolveConfig,
	siteFor,
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

describe("app ids (DEC-196): the <app> of /s/<app>/mcp", () => {
	test("1 to 32 characters of a-z, 0-9 and -, neither starting nor ending with -", () => {
		expect(MAX_APP_ID).toBe(32);
		for (const id of [
			"a",
			"0",
			"ab",
			"a-b",
			"a--b",
			"sitegloss",
			"hp-48gx",
			"42",
			"a".repeat(32),
			`a${"-".repeat(30)}b`,
		]) {
			expect(isAppId(id)).toBe(true);
		}
		for (const id of [
			"",
			"-",
			"--",
			"-a",
			"a-",
			"A",
			"Sitegloss",
			"a b",
			"a_b",
			"a.b",
			"a/b",
			"a%2fb",
			"a\n",
			"\na",
			" a",
			"ä",
			"а", // a Cyrillic a
			"a".repeat(33),
			`${"a".repeat(32)}\n`,
			"..",
			"mcp/../x",
		]) {
			expect(isAppId(id)).toBe(false);
		}
		for (const notText of [undefined, null, 1, ["a"], { id: "a" }, true]) {
			expect(isAppId(notText)).toBe(false);
		}
	});
});

describe("the apps a site reserves (DEC-197)", () => {
	const A = "https://a.example";
	const B = "https://b.example";
	const C = "https://c.example";
	// The provider is never asked: these settings only pass validation.
	const oidc = {
		issuer: "https://idp.example",
		clientId: "relay",
		clientSecret: "not-a-secret",
		assertionIssuer: "https://app.example",
		assertionJwksUrl: "https://app.example/jwks",
	};
	const config = (input: Partial<RelayConfig>) =>
		resolveConfig({ publicUrl: "https://relay.example", ...input });

	/** Whether a page of `origin` may serve `app`; `undefined`: no such site. */
	function allowed(c: RelayConfig, origin: string, app: string) {
		const site = siteFor(c, origin);
		return site === undefined ? undefined : appAllowed(c, site, app);
	}

	test("appAllowed: a site that lists apps serves only those; a listed app is served only by the sites that list it", () => {
		const c = config({
			allowedOrigins: [C],
			sites: [
				{ origin: A, apps: ["notes", "shared"] },
				{ origin: B, apps: ["shared"] },
				{ origin: "https://plain.example", name: "Plain" },
			],
		});
		const table: [string, string, boolean][] = [
			[A, "notes", true],
			[A, "shared", true],
			[A, "free", false],
			[B, "shared", true],
			[B, "notes", false],
			[B, "free", false],
			["https://plain.example", "free", true],
			["https://plain.example", "notes", false],
			["https://plain.example", "shared", false],
			[C, "free", true],
			[C, "notes", false],
			[C, "shared", false],
		];
		for (const [origin, app, expected] of table) {
			expect([origin, app, allowed(c, origin, app)]).toEqual([
				origin,
				app,
				expected,
			]);
		}
		expect(allowed(c, "https://unknown.example", "free")).toBeUndefined();
	});

	test("appAllowed on an open relay: any origin serves what nobody lists, only the listing site what is listed", () => {
		const c = config({
			allowedOrigins: "*",
			sites: [{ origin: A, apps: ["notes"] }],
		});
		expect(allowed(c, "https://anyone.example", "free")).toBe(true);
		expect(allowed(c, "https://anyone.example", "notes")).toBe(false);
		expect(allowed(c, A, "notes")).toBe(true);
		expect(allowed(c, A, "free")).toBe(false);
	});

	test("without any list every app is open to every site", () => {
		const c = config({ allowedOrigins: [C], sites: [{ origin: A }] });
		for (const origin of [A, C]) {
			for (const app of ["notes", "free", "a"]) {
				expect(allowed(c, origin, app)).toBe(true);
			}
		}
	});

	test("a bad list is a configuration error of TAB_MCP_SITES", () => {
		let error: unknown;
		try {
			config({ sites: [{ origin: A, apps: [] }] });
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(ConfigError);
		expect(describeConfigError(error as ConfigError)).toBe(
			`TAB_MCP_SITES: site apps must be a list of app ids (1-32 characters of a-z, 0-9 and -): ${A}`,
		);
	});

	describe("pairingKindsOf: the ways an app's pages can pair, from the configuration alone", () => {
		test("a reserved app: the methods of the sites that list it, code first", () => {
			const c = config({
				oidc,
				allowedOrigins: [C],
				sites: [
					{ origin: B, pairing: "oidc", apps: ["both", "bound"] },
					{ origin: A, pairing: "code", apps: ["both", "plain"] },
				],
			});
			expect(pairingKindsOf(c, "plain")).toEqual(["code"]);
			expect(pairingKindsOf(c, "bound")).toEqual(["oidc"]);
			// Whatever the order of the sites.
			expect(pairingKindsOf(c, "both")).toEqual(["code", "oidc"]);
		});

		test("a reserved app takes nothing from the origins that may not serve it", () => {
			// The allowed origin pairs by code and so does the open relay, but
			// neither may serve an app the oidc site reserves.
			for (const allowedOrigins of [[C], "*"] as const) {
				const c = config({
					oidc,
					allowedOrigins: allowedOrigins as RelayConfig["allowedOrigins"],
					sites: [
						{ origin: B, pairing: "oidc", apps: ["bound"] },
						{ origin: A, pairing: "code" },
					],
				});
				expect(pairingKindsOf(c, "bound")).toEqual(["oidc"]);
			}
		});

		test("a site without a method of its own has the instance's (identity)", () => {
			const c = config({
				oidc,
				identity: "oidc",
				sites: [
					{ origin: A, apps: ["inherits"] },
					{ origin: B, pairing: "code", apps: ["plain"] },
				],
			});
			expect(pairingKindsOf(c, "inherits")).toEqual(["oidc"]);
			expect(pairingKindsOf(c, "plain")).toEqual(["code"]);
		});

		test("an app nobody lists: the methods of the sites without a list and of the allowed origins", () => {
			const code = config({ allowedOrigins: [C] });
			expect(pairingKindsOf(code, "free")).toEqual(["code"]);
			const bound = config({ oidc, identity: "oidc", allowedOrigins: [C] });
			expect(pairingKindsOf(bound, "free")).toEqual(["oidc"]);
			const both = config({
				oidc,
				identity: "oidc",
				allowedOrigins: [C],
				sites: [{ origin: A, pairing: "code" }],
			});
			expect(pairingKindsOf(both, "free")).toEqual(["code", "oidc"]);
			const siteOnly = config({
				oidc,
				sites: [{ origin: A, pairing: "oidc" }],
			});
			expect(pairingKindsOf(siteOnly, "free")).toEqual(["oidc"]);
		});

		test("an app nobody lists takes nothing from the sites that list others: they may not serve it", () => {
			const c = config({
				oidc,
				allowedOrigins: [C],
				sites: [{ origin: B, pairing: "oidc", apps: ["bound"] }],
			});
			expect(pairingKindsOf(c, "free")).toEqual(["code"]);
		});

		test("an open relay: code for an app nobody lists, and the method of a site without a list", () => {
			expect(pairingKindsOf(config({ allowedOrigins: "*" }), "free")).toEqual([
				"code",
			]);
			const c = config({
				oidc,
				allowedOrigins: "*",
				sites: [{ origin: A, pairing: "oidc" }],
			});
			expect(pairingKindsOf(c, "free")).toEqual(["code", "oidc"]);
		});

		test("moz-extension://* pairs by code, whatever the instance's identity", () => {
			const firefox = config({
				oidc,
				identity: "oidc",
				allowedOrigins: ["moz-extension://*"],
			});
			expect(pairingKindsOf(firefox, "free")).toEqual(["code"]);
			const mixed = config({
				oidc,
				identity: "oidc",
				allowedOrigins: ["moz-extension://*", C],
			});
			expect(pairingKindsOf(mixed, "free")).toEqual(["code", "oidc"]);
			// A reserved app is not Firefox's extensions' to serve.
			const reserved = config({
				oidc,
				allowedOrigins: ["moz-extension://*"],
				sites: [{ origin: B, pairing: "oidc", apps: ["bound"] }],
			});
			expect(pairingKindsOf(reserved, "bound")).toEqual(["oidc"]);
		});

		test("an app no origin may serve has no method", () => {
			const c = config({ sites: [{ origin: A, apps: ["notes"] }] });
			expect(pairingKindsOf(c, "free")).toEqual([]);
			expect(pairingKindsOf(config({}), "free")).toEqual([]);
		});

		test("what it says is what siteFor and appAllowed let a page do", () => {
			// For every origin that may serve the app, its method is offered;
			// no method is offered that none of them has.
			const c = config({
				oidc,
				identity: "oidc",
				allowedOrigins: [C, "moz-extension://*"],
				sites: [
					{ origin: A, pairing: "code", apps: ["plain", "both"] },
					{ origin: B, apps: ["both", "bound"] },
					{ origin: "https://d.example", pairing: "code" },
				],
			});
			const origins = [
				A,
				B,
				C,
				"https://d.example",
				"moz-extension://3f9a6c2e-1b7d-4e8a-9c5f-2d4b6a8e0c1f",
			];
			for (const app of ["plain", "both", "bound", "free"]) {
				const served = new Set<string>();
				for (const origin of origins) {
					const site = siteFor(c, origin);
					if (site !== undefined && appAllowed(c, site, app)) {
						served.add(site.pairing);
					}
				}
				expect([app, pairingKindsOf(c, app)]).toEqual([
					app,
					(["code", "oidc"] as const).filter((k) => served.has(k)),
				]);
			}
		});
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
