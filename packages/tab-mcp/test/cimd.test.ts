/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document,
 * MCP 2026-07-28 client registration) and the SSRF guards of threat model A3.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isLoopbackHost, isPublicIp } from "../src/ip.ts";
import {
	ClientMetadataError,
	ClientMetadataFetcher,
	displayName,
	limitKey,
	redirectUriMatches,
} from "../src/oauth/cimd.ts";
import { type CimdServer, startCimdServer } from "./oauth-helpers.ts";

const DOC = (id: string, extra: Record<string, unknown> = {}) => ({
	client_id: id,
	client_name: "Example AI",
	redirect_uris: ["https://ai.example/callback"],
	token_endpoint_auth_method: "none",
	...extra,
});

interface Pinned {
	url: string;
	host: string | undefined;
	serverName: string | undefined;
}

/** The URL the fetch was meant for: the pinned URL with its Host header put back. */
function original(url: string, init?: RequestInit): string {
	const u = new URL(url);
	const host = (init?.headers as Record<string, string> | undefined)?.["host"];
	return host === undefined
		? url
		: `${u.protocol}//${host}${u.pathname}${u.search}`;
}

/** A fetcher with a fake DNS and a fake network. */
function fetcher(
	responder: (url: string) => Response,
	addresses: string[] = ["93.184.216.34"],
	options: { allowedHosts?: string[]; now?: () => number } = {},
) {
	const calls: string[] = [];
	const pinned: Pinned[] = [];
	const f = new ClientMetadataFetcher({
		lookup: async () => addresses,
		fetch: (async (url: string | URL | Request, init?: RequestInit) => {
			const meant = original(String(url), init);
			calls.push(meant);
			pinned.push({
				url: String(url),
				host: (init?.headers as Record<string, string> | undefined)?.["host"],
				serverName: (init as { tls?: { serverName?: string } } | undefined)?.tls
					?.serverName,
			});
			return responder(meant);
		}) as typeof fetch,
		...options,
	});
	return { f, calls, pinned };
}

async function reason(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ClientMetadataError) return error.reason;
		throw error;
	}
	return "accepted";
}

describe("CIMD §3: the client_id URL", () => {
	const { f, calls } = fetcher((url) => Response.json(DOC(url)));

	test("https with a path is fetched; the document's client_id must equal the URL", async () => {
		const meta = await f.get("https://ai.example/oauth/client.json");
		expect(meta).toEqual({
			clientId: "https://ai.example/oauth/client.json",
			name: "Example AI",
			host: "ai.example",
			redirectUris: ["https://ai.example/callback"],
		});
	});

	test("refused before any network use: http, no path, credentials, fragment, port, dot segments, aliases", async () => {
		calls.length = 0;
		for (const id of [
			"http://ai.example/client.json",
			"https://ai.example/",
			"https://ai.example",
			"https://user:pw@ai.example/client.json",
			"https://ai.example/client.json#x",
			"https://ai.example:8443/client.json",
			"https://ai.example:443/client.json",
			"https://ai.example/a/../client.json",
			"https://AI.example/client.json",
			"ftp://ai.example/client.json",
			"not a url",
			"",
			`https://ai.example/${"x".repeat(2100)}`,
		]) {
			expect(await reason(f.get(id))).toBe("invalid_client_id");
		}
		expect(calls).toEqual([]);
	});
});

describe("threat model A3: SSRF guards", () => {
	test("IP literals in private, loopback, link-local, CGNAT, multicast and special ranges are refused", async () => {
		const { f, calls } = fetcher((url) => Response.json(DOC(url)));
		for (const host of [
			"127.0.0.1",
			"10.1.2.3",
			"172.16.0.1",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"224.0.0.1",
			"255.255.255.255",
			"[::1]",
			"[::]",
			"[fe80::1]",
			"[fc00::1]",
			"[fd12:3456::1]",
			"[ff02::1]",
			"[::ffff:7f00:1]", // ::ffff:127.0.0.1 in canonical form
			"[::ffff:a00:1]",
			"[64:ff9b::a00:1]",
			"[2002:a00:1::1]",
			"[2001:db8::1]",
		]) {
			expect(await reason(f.get(`https://${host}/client.json`))).toBe(
				"private_address",
			);
		}
		expect(calls).toEqual([]);
	});

	test("a host name that resolves to any private address is refused (localhost too)", async () => {
		for (const addresses of [
			["127.0.0.1"],
			["93.184.216.34", "10.0.0.5"],
			["::1"],
			["169.254.169.254"],
			[],
		]) {
			const { f, calls } = fetcher((url) => Response.json(DOC(url)), addresses);
			expect(await reason(f.get("https://ai.example/client.json"))).toBe(
				"private_address",
			);
			expect(calls).toEqual([]);
		}
	});

	test("review finding 4: the fetch is pinned to the vetted address (IPv4 first), Host and TLS name kept", async () => {
		const { f, pinned } = fetcher(
			(url) => Response.json(DOC(url)),
			["2606:4700::6810:1", "93.184.216.34"],
		);
		await f.get("https://ai.example/client.json");
		expect(pinned).toEqual([
			{
				url: "https://93.184.216.34/client.json",
				host: "ai.example",
				serverName: "ai.example",
			},
		]);
		const v6 = fetcher((url) => Response.json(DOC(url)), ["2606:4700::6810:1"]);
		await v6.f.get("https://ai.example/client.json");
		expect(v6.pinned[0]?.url).toBe("https://[2606:4700::6810:1]/client.json");
	});

	test("review finding 4: every failure from resolving to parsing shows one fixed message, no upstream status", async () => {
		const messages = new Set<string>();
		const cases: [Response, string[]][] = [
			[
				new Response("{}", {
					status: 404,
					headers: { "content-type": "application/json" },
				}),
				["93.184.216.34"],
			],
			[
				new Response(null, {
					status: 302,
					headers: { location: "https://x.example/" },
				}),
				["93.184.216.34"],
			],
			[
				new Response("<html>", { headers: { "content-type": "text/html" } }),
				["93.184.216.34"],
			],
			[
				new Response("{nope", {
					headers: { "content-type": "application/json" },
				}),
				["93.184.216.34"],
			],
			[new Response("{}", { status: 500 }), ["10.0.0.1"]],
		];
		for (const [response, addresses] of cases) {
			const { f } = fetcher(() => response, addresses);
			try {
				await f.get("https://ai.example/client.json");
			} catch (error) {
				messages.add((error as Error).message);
			}
		}
		expect([...messages]).toEqual([
			"The AI app's details could not be loaded from ai.example.",
		]);
	});

	test("an unresolvable host is refused", async () => {
		const f = new ClientMetadataFetcher({
			lookup: async () => {
				throw new Error("ENOTFOUND");
			},
		});
		expect(await reason(f.get("https://nope.example/client.json"))).toBe(
			"unresolvable",
		);
	});

	test("redirects are not followed", async () => {
		const { f, calls } = fetcher(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "http://169.254.169.254/latest/meta-data" },
				}),
		);
		expect(await reason(f.get("https://ai.example/client.json"))).toBe(
			"fetch_failed",
		);
		expect(calls).toEqual(["https://ai.example/client.json"]);
	});

	test("oversized documents are refused, by header and by stream", async () => {
		const big = JSON.stringify(
			DOC("https://ai.example/client.json", { pad: "x".repeat(70_000) }),
		);
		const declared = fetcher(
			() =>
				new Response(big, { headers: { "content-type": "application/json" } }),
		);
		expect(await reason(declared.f.get("https://ai.example/client.json"))).toBe(
			"too_large",
		);
		const streamed = fetcher(
			() =>
				new Response(
					new ReadableStream({
						start(c) {
							for (let i = 0; i < 10; i++)
								c.enqueue(new TextEncoder().encode("x".repeat(10_000)));
							c.close();
						},
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		expect(await reason(streamed.f.get("https://ai.example/client.json"))).toBe(
			"too_large",
		);
	});

	test("non-JSON, other statuses and bad UTF-8 are refused", async () => {
		const html = fetcher(
			() =>
				new Response("<html>", { headers: { "content-type": "text/html" } }),
		);
		expect(await reason(html.f.get("https://ai.example/client.json"))).toBe(
			"fetch_failed",
		);
		const missing = fetcher(
			() =>
				new Response("{}", {
					status: 404,
					headers: { "content-type": "application/json" },
				}),
		);
		expect(await reason(missing.f.get("https://ai.example/client.json"))).toBe(
			"fetch_failed",
		);
		const broken = fetcher(
			() =>
				new Response("{nope", {
					headers: { "content-type": "application/json" },
				}),
		);
		expect(await reason(broken.f.get("https://ai.example/client.json"))).toBe(
			"fetch_failed",
		);
		const bytes = fetcher(
			() =>
				new Response(new Uint8Array([0x7b, 0xff, 0x7d]), {
					headers: { "content-type": "application/json" },
				}),
		);
		expect(await reason(bytes.f.get("https://ai.example/client.json"))).toBe(
			"fetch_failed",
		);
	});

	test("a hanging server is cut off after the timeout", async () => {
		const f = new ClientMetadataFetcher({
			lookup: async () => ["93.184.216.34"],
			timeoutMs: 50,
			fetch: ((_url: string, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("timeout", "TimeoutError")),
					);
				})) as unknown as typeof fetch,
		});
		const started = Date.now();
		expect(await reason(f.get("https://ai.example/client.json"))).toBe(
			"fetch_failed",
		);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test("the optional host allow-list (TAB_MCP_CLIENT_ID_HOSTS)", async () => {
		const { f } = fetcher((url) => Response.json(DOC(url)), undefined, {
			allowedHosts: ["claude.ai"],
		});
		expect(await reason(f.get("https://ai.example/client.json"))).toBe(
			"host_not_allowed",
		);
		expect(await reason(f.get("https://claude.ai/oauth/x"))).toBe("accepted");
	});

	test("review finding 3: fetches across many hosts are capped together", async () => {
		const { f } = fetcher(() => new Response("{}", { status: 500 }));
		const reasons: string[] = [];
		for (let i = 0; i < 32; i++)
			reasons.push(await reason(f.get(`https://h${i}.example/c.json`)));
		expect(reasons.slice(0, 30).every((r) => r === "fetch_failed")).toBe(true);
		expect(reasons.slice(30)).toEqual(["rate_limited", "rate_limited"]);
	});

	test("fetches per host are rate-limited", async () => {
		const { f } = fetcher(() => new Response("{}", { status: 500 }));
		const reasons: string[] = [];
		for (let i = 0; i < 7; i++)
			reasons.push(await reason(f.get(`https://ai.example/c${i}.json`)));
		expect(reasons.slice(0, 5).every((r) => r === "fetch_failed")).toBe(true);
		expect(reasons.slice(5)).toEqual(["rate_limited", "rate_limited"]);
	});

	test("audit finding 2: limitKey is the last two labels, or the IP literal", () => {
		expect(limitKey("x1.evil.example")).toBe("evil.example");
		expect(limitKey("claude.ai")).toBe("claude.ai");
		expect(limitKey("a.b.example.co.uk")).toBe("co.uk");
		expect(limitKey("evil.example.")).toBe("evil.example");
		expect(limitKey("93.184.216.34")).toBe("93.184.216.34");
		expect(limitKey("[2001:db8::1]")).toBe("2001:db8::1");
	});

	test("audit finding 2: wildcard subdomains share their domain's limit and do not drain the global one", async () => {
		const { f } = fetcher((url) =>
			url.includes("evil.example")
				? new Response("{}", { status: 500 })
				: Response.json(DOC(url)),
		);
		const reasons: string[] = [];
		for (let i = 0; i < 40; i++)
			reasons.push(await reason(f.get(`https://x${i}.evil.example/c.json`)));
		expect(reasons.slice(0, 5).every((r) => r === "fetch_failed")).toBe(true);
		expect(reasons.slice(5).every((r) => r === "rate_limited")).toBe(true);
		// The refused fetches took nothing from the global bucket.
		for (let i = 0; i < 25; i++) {
			expect(await reason(f.get(`https://d${i}.example/c.json`))).toBe(
				"accepted",
			);
		}
	});

	test("audit finding 2: a fetch the global limit refuses leaves the domain's tokens", async () => {
		const clock = { t: 1_800_000_000_000 };
		const { f } = fetcher(
			() => new Response("{}", { status: 500 }),
			undefined,
			{
				now: () => clock.t,
			},
		);
		for (let i = 0; i < 30; i++)
			await reason(f.get(`https://h${i}.example/c.json`));
		for (let i = 0; i < 5; i++) {
			expect(await reason(f.get(`https://ai.example/${i}.json`))).toBe(
				"rate_limited",
			);
		}
		clock.t += 5000; // the global bucket gets 5 back, the domain's only 1
		const reasons: string[] = [];
		for (let i = 0; i < 5; i++)
			reasons.push(await reason(f.get(`https://ai.example/${i}.json`)));
		expect(reasons.every((r) => r === "fetch_failed")).toBe(true);
	});
});

describe("audit finding 2: the cache evicts the least recently used entry", () => {
	const ok = (url: string) => Response.json(DOC(url));
	/** Fill the cache with 1000 other clients, one second apart (the global limit refills 1/s). */
	async function fill(
		f: ClientMetadataFetcher,
		clock: { t: number },
		from = 0,
		count = 1000,
	) {
		for (let i = from; i < from + count; i++) {
			clock.t += 1000;
			expect(await reason(f.get(`https://c${i}.example/c.json`))).toBe(
				"accepted",
			);
		}
	}

	test("an entry in use stays cached while 1000 others come and go", async () => {
		const clock = { t: 1_800_000_000_000 };
		const { f, calls } = fetcher(ok, undefined, { now: () => clock.t });
		const claude = "https://claude.ai/oauth/claude-code-client-metadata";
		await f.get(claude);
		await fill(f, clock, 0, 999);
		await f.get(claude); // a hit: now the most recently used
		await fill(f, clock, 999, 500);
		await f.get(claude);
		expect(calls.filter((c) => c === claude)).toHaveLength(1);
	});
});

describe("CIMD §4 / MCP client registration: the document", () => {
	const check = async (
		doc: Record<string, unknown>,
		id = "https://ai.example/client.json",
	) => {
		const { f } = fetcher(() => Response.json(doc));
		return reason(f.get(id));
	};
	const id = "https://ai.example/client.json";

	test("required: client_id equal to the URL, client_name, redirect_uris", async () => {
		expect(await check(DOC(id))).toBe("accepted");
		expect(await check(DOC("https://other.example/client.json"))).toBe(
			"invalid_metadata",
		);
		expect(await check(DOC(id, { client_name: undefined }))).toBe(
			"invalid_metadata",
		);
		expect(await check(DOC(id, { client_name: "   " }))).toBe(
			"invalid_metadata",
		);
		expect(await check(DOC(id, { redirect_uris: [] }))).toBe(
			"invalid_metadata",
		);
		expect(await check(DOC(id, { redirect_uris: ["not a url"] }))).toBe(
			"invalid_metadata",
		);
		expect(
			await check(DOC(id, { redirect_uris: ["https://x.example/cb#f"] })),
		).toBe("invalid_metadata");
		expect(
			await check(DOC(id, { redirect_uris: ["javascript:alert(1)"] })),
		).toBe("invalid_metadata");
		// Review finding 8: https, loopback http, reverse-domain private-use schemes only.
		for (const uri of [
			"file:///etc/passwd",
			"blob:https://x.example/1",
			"data:text/html,x",
			"http://ai.example/callback",
			"myapp:/callback",
			"ftp://ai.example/cb",
			"https://user:pw@ai.example/cb",
		]) {
			expect([uri, await check(DOC(id, { redirect_uris: [uri] }))]).toEqual([
				uri,
				"invalid_metadata",
			]);
		}
		for (const uri of [
			"https://ai.example/cb",
			"http://localhost/callback",
			"http://127.0.0.1/callback",
			"http://[::1]/callback",
			"com.example.app:/oauth/callback",
		]) {
			expect([uri, await check(DOC(id, { redirect_uris: [uri] }))]).toEqual([
				uri,
				"accepted",
			]);
		}
		expect(await check([] as unknown as Record<string, unknown>)).toBe(
			"invalid_metadata",
		);
	});

	test("public clients only: auth method none, no secret; code grant and response type", async () => {
		expect(
			await check(
				DOC(id, { token_endpoint_auth_method: "client_secret_basic" }),
			),
		).toBe("invalid_metadata");
		expect(
			await check(DOC(id, { token_endpoint_auth_method: undefined })),
		).toBe("accepted");
		expect(await check(DOC(id, { client_secret: "s" }))).toBe(
			"invalid_metadata",
		);
		expect(await check(DOC(id, { grant_types: ["client_credentials"] }))).toBe(
			"invalid_metadata",
		);
		expect(await check(DOC(id, { response_types: ["token"] }))).toBe(
			"invalid_metadata",
		);
	});

	test("audit finding 5: a name with another domain anywhere is refused", async () => {
		for (const name of [
			"Claude [claude.ai]",
			"Claude · claude.ai",
			"Claude from claude.ai",
			"claude.ai",
			"Claude claude.ai/connect",
			"Claude — chatgpt.com",
			"Claude claude。ai",
			"Claude claude．ai",
			"Claude ｃｌａｕｄｅ.ａｉ",
			"Claude CLAUDE.AI",
			"Claude via ai.example.evil",
			"Claude via xai.example",
		]) {
			expect([name, await check(DOC(id, { client_name: name }))]).toEqual([
				name,
				"invalid_metadata",
			]);
		}
	});

	test("audit finding 5: the names of known AI apps, versions and the client's own domain pass", async () => {
		for (const name of [
			"Claude",
			"Claude Code",
			"ChatGPT",
			"Codex",
			"OpenAI Codex",
			"Claude 3.5",
			"Tool v1.2",
			"Tool (v1.2)",
			"Example AI from ai.example",
			"ai.example",
		]) {
			expect([name, await check(DOC(id, { client_name: name }))]).toEqual([
				name,
				"accepted",
			]);
		}
		// A subdomain of the verified host, or the host's parent, is the same owner.
		const sub = "https://mcp.ai.example/client.json";
		expect(await check(DOC(sub, { client_name: "AI · ai.example" }), sub)).toBe(
			"accepted",
		);
		expect(
			await check(DOC(id, { client_name: "AI · mcp.ai.example" }), id),
		).toBe("accepted");
	});

	test("review finding 7: a name with a web address in parentheses is refused", async () => {
		expect(await check(DOC(id, { client_name: "Claude (claude.ai)" }))).toBe(
			"invalid_metadata",
		);
		expect(
			await check(DOC(id, { client_name: "Claude ( claude.ai/x )" })),
		).toBe("invalid_metadata");
		expect(
			await check(DOC(id, { client_name: "Claude\u200B (claude.ai)" })),
		).toBe("invalid_metadata");
		expect(await check(DOC(id, { client_name: "Tool (beta 2)" }))).toBe(
			"accepted",
		);
		expect(await check(DOC(id, { client_name: "Tool (v1.2)" }))).toBe(
			"accepted",
		);
	});

	test("Claude Code's published document is accepted", async () => {
		const claude = "https://claude.ai/oauth/claude-code-client-metadata";
		expect(
			await check(
				{
					client_id: claude,
					client_name: "Claude Code",
					client_uri: "https://claude.ai",
					redirect_uris: [
						"http://localhost/callback",
						"http://127.0.0.1/callback",
					],
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
					token_endpoint_auth_method: "none",
				},
				claude,
			),
		).toBe("accepted");
	});

	test("names are cleaned for display: control, format and invisible characters, whitespace, length", () => {
		expect(displayName("  Evil\u202Eedoc\u0000 AI\n")).toBe("Eviledoc AI");
		// Format (Cf) and invisible characters are removed (review finding 7).
		for (const invisible of [
			"\u200B",
			"\u200C",
			"\u200D",
			"\u200E",
			"\u200F",
			"\u061C",
			"\u2060",
			"\uFEFF",
			"\u00AD",
			"\u3164",
			"\u115F",
		]) {
			expect(displayName(`Cl${invisible}aude`)).toBe("Claude");
		}
		expect(displayName("A\u2028B")).toBe("A B");
		expect([...displayName("x".repeat(100))]).toHaveLength(64);
	});
});

describe("caching per Cache-Control (5 min to 24 h)", () => {
	test("a cached document is not fetched again", async () => {
		const { f, calls } = fetcher((url) =>
			Response.json(DOC(url), { headers: { "cache-control": "max-age=60" } }),
		);
		await f.get("https://ai.example/client.json");
		await f.get("https://ai.example/client.json");
		expect(calls).toHaveLength(1);
	});

	test("no-store is cached for the minimum of 5 minutes; max-age is capped at 24 h", async () => {
		let now = 0;
		const calls: string[] = [];
		const make = (cacheControl: string) =>
			new ClientMetadataFetcher({
				lookup: async () => ["93.184.216.34"],
				now: () => now,
				fetch: (async (pinnedUrl: string, init?: RequestInit) => {
					const url = original(pinnedUrl, init);
					calls.push(url);
					return Response.json(DOC(url), {
						headers: { "cache-control": cacheControl },
					});
				}) as unknown as typeof fetch,
			});
		const f = make("no-store");
		await f.get("https://ai.example/client.json");
		now = 4 * 60_000;
		await f.get("https://ai.example/client.json");
		expect(calls).toHaveLength(1);
		now = 5 * 60_000 + 1;
		await f.get("https://ai.example/client.json");
		expect(calls).toHaveLength(2);

		calls.length = 0;
		now = 0;
		const g = make("max-age=999999999");
		await g.get("https://ai.example/client.json");
		now = 24 * 3_600_000 + 1;
		await g.get("https://ai.example/client.json");
		expect(calls).toHaveLength(2);
	});
});

describe("RFC 8252 §7.3 and OAuth 2.1 §2.3.1: redirect URI matching", () => {
	test("exact, except the port of an http loopback redirect", () => {
		const cases: [string, string, boolean][] = [
			["https://a.example/cb", "https://a.example/cb", true],
			["https://a.example/cb/", "https://a.example/cb", false],
			["https://a.example:444/cb", "https://a.example/cb", false],
			["https://A.example/cb", "https://a.example/cb", false],
			["http://127.0.0.1:5000/callback", "http://127.0.0.1/callback", true],
			["http://localhost:5000/callback", "http://localhost/callback", true],
			["http://[::1]:5000/callback", "http://[::1]/callback", true],
			["http://localhost:5000/callback", "http://127.0.0.1/callback", false],
			["http://127.0.0.1:5000/other", "http://127.0.0.1/callback", false],
			[
				"http://127.0.0.1:5000/callback?x=1",
				"http://127.0.0.1/callback",
				false,
			],
			[
				"http://127.0.0.1:5000/a/../callback",
				"http://127.0.0.1/callback",
				false,
			],
			["http://127.0.0.1:5000/callback#f", "http://127.0.0.1/callback", false],
			[
				"http://user@127.0.0.1:5000/callback",
				"http://127.0.0.1/callback",
				false,
			],
			["https://127.0.0.1:5000/callback", "https://127.0.0.1/callback", false],
			[
				"http://evil.example:80/callback",
				"http://evil.example/callback",
				false,
			],
		];
		for (const [requested, registered, expected] of cases) {
			expect([requested, redirectUriMatches(requested, registered)]).toEqual([
				requested,
				expected,
			]);
		}
	});
});

describe("public addresses", () => {
	test("isPublicIp and isLoopbackHost", () => {
		for (const ip of [
			"93.184.216.34",
			"1.1.1.1",
			"2606:4700::1111",
			"2001:4860:4860::8888",
			"::ffff:8.8.8.8",
		]) {
			expect([ip, isPublicIp(ip)]).toEqual([ip, true]);
		}
		for (const ip of [
			"192.0.2.1",
			"198.18.0.1",
			"203.0.113.9",
			"2001::1",
			"3fff::1",
			"100::1",
			"garbage",
		]) {
			expect([ip, isPublicIp(ip)]).toEqual([ip, false]);
		}
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("a.localhost")).toBe(true);
		expect(isLoopbackHost("127.9.9.9")).toBe(true);
		expect(isLoopbackHost("[::1]")).toBe(true);
		expect(isLoopbackHost("example.com")).toBe(false);
	});
});

describe("the test-only switch", () => {
	let server: CimdServer;
	beforeAll(async () => {
		server = await startCimdServer();
	});
	afterAll(() => server.stop());

	test("without it, the loopback fixture is refused; with it, fetched over real TLS", async () => {
		const id = server.serve(
			"/c.json",
			server.document(`${server.origin}/c.json`),
		);
		expect(await reason(new ClientMetadataFetcher().get(id))).toBe(
			"invalid_client_id",
		); // port
		const meta = await new ClientMetadataFetcher({
			testMode: { ca: server.ca },
		}).get(id);
		expect(meta.name).toBe("Test AI");
	});

	test("the relay cannot be given test hooks outside development", async () => {
		const { createTestRelay } = await import("../src/relay.ts");
		expect(() =>
			createTestRelay({ publicUrl: "https://r.example" }, {}),
		).toThrow("development");
		const index = await import("../src/index.ts");
		expect("createTestRelay" in index).toBe(false);
	});
});
