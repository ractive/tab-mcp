/**
 * `private_key_jwt` client authentication (RFC 7523 §2.2 and §3, OpenID
 * Connect Core §9; DEC-106): the CIMD rules, the guarded JWKS fetch, every
 * assertion check at `/token` and `/revoke`, and how a grant is bound to the
 * method it was made with. Keys are generated per process.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import {
	ClientMetadataError,
	ClientMetadataFetcher,
	validateDocument,
} from "../src/oauth/cimd.ts";
import {
	CLIENT_ASSERTION_TYPE,
	NonceQuota,
	nonceKey,
	quotaKey,
} from "../src/oauth/client-auth.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import type { TokenStore } from "../src/store/types.ts";
import { hashToken } from "../src/tokens.ts";
import { LogCapture, ScriptedTab, waitFor } from "./helpers.ts";
import {
	authorizeUrl,
	type CimdServer,
	type OAuthTestRelay,
	pkce,
	postForm,
	startCimdServer,
	startOAuthRelay,
	TestBrowser,
} from "./oauth-helpers.ts";
import { type SigningKey, signingKey, signJwt } from "./oidc-fixture.ts";

type Json = Record<string, unknown>;

const REDIRECT = "http://127.0.0.1:4567/callback";

let cimd: CimdServer;
let rsa: SigningKey;
let rsa2: SigningKey;
let ec: SigningKey;
let ps: SigningKey;
/** private_key_jwt only: an assertion with every code and refresh. */
let strictId: string;
/** ChatGPT's shape: private_key_jwt preferred, none listed, RS256 (DEC-104). */
let dualId: string;
let publicId: string;
/** private_key_jwt whose jwks_uri answers 500. */
let brokenId: string;
const relays: OAuthTestRelay[] = [];
const tabs: ScriptedTab[] = [];

beforeAll(async () => {
	cimd = await startCimdServer();
	rsa = await signingKey("RS256", "k1");
	rsa2 = await signingKey("RS256", "k2");
	ec = await signingKey("ES256", "e1");
	ps = await signingKey("PS256", "p1");
	const jwks = cimd.serve("/jwks.json", {
		keys: [rsa.publicJwk, rsa2.publicJwk, ec.publicJwk, ps.publicJwk],
	});
	const broken = cimd.serve(
		"/broken-jwks.json",
		() => new Response("no", { status: 500 }),
	);
	strictId = cimd.serve(
		"/strict.json",
		cimd.document(`${cimd.origin}/strict.json`, {
			client_name: "Strict AI",
			token_endpoint_auth_method: "private_key_jwt",
			token_endpoint_auth_methods_supported: ["private_key_jwt"],
			jwks_uri: jwks,
		}),
	);
	dualId = cimd.serve(
		"/dual.json",
		cimd.document(`${cimd.origin}/dual.json`, {
			client_name: "Dual AI",
			token_endpoint_auth_method: "private_key_jwt",
			token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
			token_endpoint_auth_signing_alg: "RS256",
			jwks_uri: jwks,
		}),
	);
	publicId = cimd.serve(
		"/public.json",
		cimd.document(`${cimd.origin}/public.json`),
	);
	brokenId = cimd.serve(
		"/broken.json",
		cimd.document(`${cimd.origin}/broken.json`, {
			token_endpoint_auth_method: "private_key_jwt",
			jwks_uri: broken,
		}),
	);
});
afterAll(() => cimd.stop());
afterEach(async () => {
	for (const t of tabs.splice(0)) if (t.ws.readyState <= 1) t.close();
	for (const r of relays.splice(0)) await r.stop();
});

function relay(store?: TokenStore): OAuthTestRelay {
	const r = startOAuthRelay(cimd, store === undefined ? {} : { store });
	relays.push(r);
	return r;
}

/** A signed client assertion; `undefined` in `claims` or `header` drops one. */
async function assertion(
	r: OAuthTestRelay,
	clientId: string,
	claims: Json = {},
	header: Json = {},
	key: SigningKey = rsa,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return signJwt(
		key,
		{
			iss: clientId,
			sub: clientId,
			aud: `${r.url}/token`,
			exp: now + 60,
			iat: now,
			jti: crypto.randomUUID(),
			...claims,
		},
		header,
	);
}

function b64url(value: unknown): string {
	return new TextEncoder()
		.encode(JSON.stringify(value))
		.toBase64({ alphabet: "base64url", omitPadding: true });
}

function auth(token: string): Record<string, string> {
	return {
		client_assertion_type: CLIENT_ASSERTION_TYPE,
		client_assertion: token,
	};
}

/** A refresh with a made-up token: client authentication runs first. */
function probe(
	r: OAuthTestRelay,
	clientId: string | undefined,
	fields: Record<string, string | undefined>,
): Promise<Response> {
	return postForm(`${r.url}/token`, {
		grant_type: "refresh_token",
		refresh_token: "tmcp_rt_unknown",
		client_id: clientId,
		...fields,
	});
}

async function error(
	res: Response,
): Promise<{ status: number; error: string }> {
	const body = (await res.json()) as { error: string };
	return { status: res.status, error: body.error };
}

/** The reasons logged for client authentication failures. */
function reasons(r: OAuthTestRelay): unknown[] {
	return r.logs.events("oauth.client_auth_failed").map((e) => e["reason"]);
}

/** The reasons logged when a client could not be checked right now. */
function unavailable(r: OAuthTestRelay): unknown[] {
	return r.logs.events("oauth.client_auth_unavailable").map((e) => e["reason"]);
}

const UNAUTHENTICATED = { status: 401, error: "invalid_client" };
const UNAVAILABLE = { status: 503, error: "temporarily_unavailable" };
/** The assertion passed; the made-up refresh token did not. */
const AUTHENTICATED = { status: 400, error: "invalid_grant" };

describe("CIMD: which documents may use private_key_jwt", () => {
	const id = "https://ai.example/client.json";
	const url = new URL(id);
	const base: Json = {
		client_id: id,
		client_name: "Example AI",
		redirect_uris: ["https://ai.example/cb"],
		token_endpoint_auth_method: "private_key_jwt",
		jwks_uri: "https://ai.example/jwks.json",
	};
	const check = (extra: Json): string => {
		const doc: Json = { ...base, ...extra };
		for (const [k, v] of Object.entries(doc))
			if (v === undefined) delete doc[k];
		try {
			const meta = validateDocument(doc, id, url);
			return meta.auth.method === "none"
				? "public"
				: `private_key_jwt${meta.auth.publicAllowed ? "+none" : ""}`;
		} catch (e) {
			if (e instanceof ClientMetadataError) return e.reason;
			throw e;
		}
	};

	test("a jwks_uri on the client id's host: private_key_jwt, with or without none listed", () => {
		expect(check({})).toBe("private_key_jwt");
		expect(
			check({
				token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
			}),
		).toBe("private_key_jwt+none");
		const meta = validateDocument({ ...base }, id, url);
		expect(meta.auth).toEqual({
			method: "private_key_jwt",
			jwksUri: "https://ai.example/jwks.json",
			algorithms: expect.arrayContaining(["RS256", "ES256", "EdDSA"]),
			publicAllowed: false,
		});
	});

	test("token_endpoint_auth_signing_alg: the only one accepted; one the relay does not verify is refused", () => {
		const meta = validateDocument(
			{ ...base, token_endpoint_auth_signing_alg: "RS256" },
			id,
			url,
		);
		expect(
			meta.auth.method === "private_key_jwt" && meta.auth.algorithms,
		).toEqual(["RS256"]);
		for (const alg of ["HS256", "none", 7]) {
			expect(check({ token_endpoint_auth_signing_alg: alg })).toBe(
				"invalid_metadata",
			);
		}
	});

	test("a jwks_uri elsewhere, on http, with credentials or not canonical is refused", () => {
		for (const jwks of [
			"https://other.example/jwks.json",
			"https://sub.ai.example/jwks.json",
			"http://ai.example/jwks.json",
			"https://ai.example:8443/jwks.json",
			"https://u:p@ai.example/jwks.json",
			"https://ai.example/jwks.json#x",
			"https://AI.example/jwks.json",
			"/jwks.json",
			42,
		]) {
			expect([jwks, check({ jwks_uri: jwks })]).toEqual([
				jwks,
				"invalid_metadata",
			]);
		}
	});

	test("an inline jwks is not accepted; with none listed the client is public (DEC-104)", () => {
		const inline = { jwks_uri: undefined, jwks: { keys: [rsa.publicJwk] } };
		expect(check(inline)).toBe("invalid_metadata");
		expect(
			check({ ...inline, token_endpoint_auth_methods_supported: ["none"] }),
		).toBe("public");
		expect(check({ jwks: { keys: [] } })).toBe("invalid_metadata");
	});

	test("DEC-104 stays: no jwks_uri, or another method, is public when none is listed", () => {
		expect(check({ jwks_uri: undefined })).toBe("invalid_metadata");
		expect(
			check({
				jwks_uri: undefined,
				token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
			}),
		).toBe("public");
		expect(check({ token_endpoint_auth_method: "client_secret_basic" })).toBe(
			"invalid_metadata",
		);
		expect(
			check({
				token_endpoint_auth_method: "client_secret_basic",
				token_endpoint_auth_methods_supported: ["none"],
			}),
		).toBe("public");
		expect(check({ token_endpoint_auth_method: "none" })).toBe("public");
	});

	test("review of PR 65: keys the relay cannot use fall back to none when it is listed (DEC-104), and say why", () => {
		const cases: [Json, string][] = [
			[{ jwks_uri: "https://other.example/jwks.json" }, "bad_jwks_uri"],
			[{ jwks_uri: "https://AI.example/jwks.json" }, "bad_jwks_uri"],
			[{ jwks_uri: "http://ai.example/jwks.json" }, "bad_jwks_uri"],
			[{ jwks: { keys: [] } }, "jwks_and_jwks_uri"],
			[{ token_endpoint_auth_signing_alg: "HS256" }, "signing_alg"],
			[{ jwks_uri: undefined }, "no_jwks_uri"],
			[
				{ token_endpoint_auth_method: "client_secret_basic" },
				"unsupported_method",
			],
		];
		for (const [extra, why] of cases) {
			const doc: Json = {
				...base,
				token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
				...extra,
			};
			for (const [k, v] of Object.entries(doc)) {
				if (v === undefined) delete doc[k];
			}
			const reasons: string[] = [];
			const meta = validateDocument(doc, id, url, {
				onFallback: (r) => reasons.push(r),
			});
			expect([extra, meta.auth.method, reasons]).toEqual([
				extra,
				"none",
				[why],
			]);
			// Without none listed, the same document is refused.
			delete doc["token_endpoint_auth_methods_supported"];
			expect(() => validateDocument(doc, id, url)).toThrow(ClientMetadataError);
		}
		// A usable document does not fall back.
		const quiet: string[] = [];
		validateDocument({ ...base }, id, url, {
			onFallback: (r) => quiet.push(r),
		});
		expect(quiet).toEqual([]);
	});

	test("review of PR 65: jwks_uri takes http and a port only in test mode, as the fetch does", () => {
		const cases: [string, string][] = [
			["http://ai.example/client.json", "http://ai.example/jwks.json"],
			[
				"https://ai.example:8443/client.json",
				"https://ai.example:8443/jwks.json",
			],
		];
		for (const [clientId, jwksUri] of cases) {
			const doc = { ...base, client_id: clientId, jwks_uri: jwksUri };
			const u = new URL(clientId);
			expect(() => validateDocument(doc, clientId, u)).toThrow(
				ClientMetadataError,
			);
			const meta = validateDocument(doc, clientId, u, { test: true });
			expect(meta.auth.method === "private_key_jwt" && meta.auth.jwksUri).toBe(
				jwksUri,
			);
		}
	});
});

describe("review of PR 65: a recent document when the fetch fails (DEC-106)", () => {
	const id = "https://ai.example/client.json";
	const doc = {
		client_id: id,
		client_name: "Example AI",
		redirect_uris: ["https://ai.example/cb"],
		token_endpoint_auth_method: "private_key_jwt",
		jwks_uri: "https://ai.example/jwks.json",
	};
	const setup = () => {
		let now = 1_800_000_000_000;
		let answer: (url: string) => Response = () =>
			Response.json(doc, { headers: { "cache-control": "max-age=300" } });
		const logs = new LogCapture();
		const calls: string[] = [];
		const f = new ClientMetadataFetcher({
			lookup: async () => ["93.184.216.34"],
			fetch: (async (u: string, init?: RequestInit) => {
				// The URL meant: the pinned address with its Host put back.
				const host = (init?.headers as Record<string, string> | undefined)?.[
					"host"
				];
				const meant = `https://${host}${new URL(u).pathname}`;
				calls.push(meant);
				return answer(meant);
			}) as unknown as typeof fetch,
			logger: logs.logger,
			now: () => now,
		});
		return {
			f,
			logs,
			calls,
			at: (t: number) => {
				now = 1_800_000_000_000 + t;
			},
			answer: (a: (url: string) => Response) => {
				answer = a;
			},
		};
	};
	const reason = async (p: Promise<unknown>): Promise<string> => {
		try {
			await p;
			return "accepted";
		} catch (e) {
			if (e instanceof ClientMetadataError) return e.reason;
			throw e;
		}
	};

	test("allowStale serves the last good copy for an hour after it expires, on a transient failure only", async () => {
		const s = setup();
		await s.f.get(id);
		s.answer(() => new Response("down", { status: 503 }));
		s.at(10 * 60_000); // expired after 5 minutes
		expect(await reason(s.f.get(id))).toBe("fetch_failed");
		expect((await s.f.get(id, { allowStale: true })).clientId).toBe(id);
		expect(s.logs.events("oauth.cimd_stale")).toHaveLength(1);
		s.at(5 * 60_000 + 60 * 60_000 + 1); // past the grace
		expect(await reason(s.f.get(id, { allowStale: true }))).toBe(
			"fetch_failed",
		);
	});

	test("a document that became invalid is not served stale, and is forgotten", async () => {
		const s = setup();
		await s.f.get(id);
		s.at(10 * 60_000);
		s.answer(() => Response.json({ ...doc, client_id: "https://x.example/c" }));
		expect(await reason(s.f.get(id, { allowStale: true }))).toBe(
			"invalid_metadata",
		);
		s.answer(() => new Response("down", { status: 503 }));
		s.at(10 * 60_000 + 61_000); // past the failure cache
		expect(await reason(s.f.get(id, { allowStale: true }))).toBe(
			"fetch_failed",
		);
	});

	test("review of PR 65: a failed fetch is answered again for a minute, per client id", async () => {
		const s = setup();
		s.answer(() => new Response("nope", { status: 404 }));
		const missing = "https://ai.example/missing.json";
		expect(await reason(s.f.get(missing))).toBe("fetch_failed");
		expect(await reason(s.f.get(missing))).toBe("fetch_failed");
		expect(s.calls).toHaveLength(1);
		s.at(61_000);
		expect(await reason(s.f.get(missing))).toBe("fetch_failed");
		expect(s.calls).toHaveLength(2);
	});

	test("review of PR 65: requests for unknown client ids cannot use up a known client's refreshes and keys", async () => {
		const s = setup();
		s.answer((url) =>
			url.endsWith("/client.json")
				? Response.json(doc, { headers: { "cache-control": "max-age=300" } })
				: url.endsWith("/jwks.json")
					? Response.json({ keys: [] })
					: new Response("nope", { status: 404 }),
		);
		await s.f.get(id);
		s.at(6 * 60_000); // the document has expired
		// Made-up paths on the same host use up its budget for new ids...
		const results: string[] = [];
		for (let i = 0; i < 8; i++) {
			results.push(await reason(s.f.get(`https://ai.example/x${i}.json`)));
		}
		expect(results).toContain("rate_limited");
		// ...but the known client's refresh and its keys still load fresh.
		const before = s.calls.length;
		expect(await reason(s.f.get(id))).toBe("accepted");
		expect(await s.f.fetchJwks("https://ai.example/jwks.json")).toEqual({
			keys: [],
		});
		expect(s.calls.slice(before)).toEqual([
			"https://ai.example/client.json",
			"https://ai.example/jwks.json",
		]);
	});

	test("review of PR 65: key fetches (which anyone can cause with a made-up kid) cannot use up a client's document refreshes", async () => {
		const s = setup();
		s.answer((url) =>
			url.endsWith("/client.json")
				? Response.json(doc, { headers: { "cache-control": "max-age=300" } })
				: Response.json({ keys: [] }),
		);
		await s.f.get(id);
		s.at(6 * 60_000);
		const results: string[] = [];
		for (let i = 0; i < 7; i++) {
			results.push(await reason(s.f.fetchJwks("https://ai.example/jwks.json")));
		}
		expect(results).toContain("rate_limited");
		expect(await reason(s.f.get(id))).toBe("accepted");
	});

	test("review of PR 65: one party's many documents push out their own, not a live client's", async () => {
		const s = setup();
		s.answer((url) =>
			Response.json(
				{ ...doc, client_id: url, token_endpoint_auth_method: "none" },
				{ headers: { "cache-control": "max-age=86400" } },
			),
		);
		await s.f.get(id);
		// 1100 documents on one attacker domain, the clock moving so the fetch
		// limits refill.
		for (let i = 0; i < 1100; i++) {
			s.at((i + 1) * 5_000);
			await s.f.get(`https://h${i}.evil.example/c.json`);
		}
		const before = s.calls.length;
		await s.f.get(id);
		expect(s.calls.length).toBe(before); // still cached: no fetch
	});

	test("the fallback to none is logged with its reason", async () => {
		const s = setup();
		s.answer(() =>
			Response.json({
				...doc,
				jwks_uri: "https://other.example/jwks.json",
				token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
			}),
		);
		expect((await s.f.get(id)).auth.method).toBe("none");
		expect(s.logs.events("oauth.cimd_auth_fallback")).toEqual([
			expect.objectContaining({ host: "ai.example", reason: "bad_jwks_uri" }),
		]);
	});
});

describe("review of PR 65: replay store shares per AI app domain (DEC-106)", () => {
	test("review of PR 65: shares are per full host; an IPv6 literal by its /64, IPv4 as is", () => {
		expect(quotaKey("https://alice.github.io/c.json")).toBe("alice.github.io");
		expect(quotaKey("https://bob.github.io/c.json")).toBe("bob.github.io");
		expect(quotaKey("https://chatgpt.com/oauth/client.json")).toBe(
			"chatgpt.com",
		);
		expect(quotaKey("https://[2001:db8:1:2::1]/c.json")).toBe(
			quotaKey("https://[2001:db8:1:2:ffff::9]/c.json"),
		);
		expect(quotaKey("https://[2001:db8:1:2::1]/c.json")).not.toBe(
			quotaKey("https://[2001:db8:1:3::1]/c.json"),
		);
		expect(quotaKey("https://93.184.216.34/c.json")).toBe("93.184.216.34");
	});

	test("a full domain is refused alone; others go on until the total is full", () => {
		const q = new NonceQuota(2, 3);
		const now = 1000;
		q.add("evil.example", now + 60_000);
		q.add("evil.example", now + 60_000);
		expect(q.refusal("evil.example", now)).toBe("domain_full");
		expect(q.refusal("chatgpt.com", now)).toBeUndefined();
		q.add("chatgpt.com", now + 60_000);
		expect(q.refusal("claude.ai", now)).toBe("full");
	});

	test("expired entries are dropped, at most once a second", () => {
		const q = new NonceQuota(1, 10);
		expect(q.sweep(0)).toBe(true);
		q.add("a.example", 500);
		expect(q.refusal("a.example", 600)).toBe("domain_full"); // swept at 0 only
		expect(q.sweep(999)).toBe(false);
		expect(q.refusal("a.example", 1000)).toBeUndefined();
	});

	test("the store is asked to remember a jti for five minutes from iat, not until a far exp", async () => {
		const inner = new MemoryTokenStore();
		const asked: number[] = [];
		const store: TokenStore = {
			put: (r) => inner.put(r),
			get: (h) => inner.get(h),
			markUsed: (h, n, k) => inner.markUsed(h, n, k),
			revoke: (s, o) => inner.revoke(s, o),
			listGrants: (a, n) => inner.listGrants(a, n),
			deleteExpired: (n) => inner.deleteExpired(n),
			claimNonce: (k, until, n) => {
				asked.push(until);
				return inner.claimNonce(k, until, n);
			},
		};
		const r = relay(store);
		const now = Math.floor(Date.now() / 1000);
		const token = await assertion(r, strictId, { iat: now, exp: now + 3600 });
		expect(await error(await probe(r, strictId, auth(token)))).toEqual(
			AUTHENTICATED,
		);
		expect(asked).toEqual([(now + 5 * 60) * 1000 + 30_000]);
	});
});

describe("the JWKS fetch has the CIMD fetch's SSRF rules", () => {
	const make = (
		answer: () => Response,
		addresses: string[] = ["93.184.216.34"],
		allowedHosts: string[] = [],
	) => {
		const calls: string[] = [];
		const f = new ClientMetadataFetcher({
			lookup: async () => addresses,
			fetch: (async (u: string | URL | Request, init?: RequestInit) => {
				calls.push(String(u));
				expect(init?.redirect).toBe("manual");
				return answer();
			}) as typeof fetch,
			allowedHosts,
		});
		return { f, calls };
	};
	const reason = async (p: Promise<unknown>): Promise<string> => {
		try {
			await p;
			return "accepted";
		} catch (e) {
			if (e instanceof ClientMetadataError) return e.reason;
			throw e;
		}
	};
	const keys = { keys: [{ kty: "RSA", n: "x", e: "AQAB" }] };

	test("a public host's JWKS loads, as application/json or application/jwk-set+json, pinned to the vetted address", async () => {
		const { f, calls } = make(() => Response.json(keys));
		expect(await f.fetchJwks("https://ai.example/jwks.json")).toEqual(keys);
		expect(calls).toEqual(["https://93.184.216.34/jwks.json"]);
		const typed = make(
			() =>
				new Response(JSON.stringify(keys), {
					headers: { "content-type": "application/jwk-set+json" },
				}),
		);
		expect(await typed.f.fetchJwks("https://ai.example/jwks.json")).toEqual(
			keys,
		);
	});

	test("private addresses, other schemes and ports, redirects, other types and large bodies are refused", async () => {
		const ok = () => Response.json(keys);
		expect(
			await reason(make(ok, ["10.0.0.1"]).f.fetchJwks("https://ai.example/k")),
		).toBe("private_address");
		expect(
			await reason(make(ok).f.fetchJwks("https://127.0.0.1/jwks.json")),
		).toBe("private_address");
		expect(await reason(make(ok).f.fetchJwks("http://ai.example/k"))).toBe(
			"invalid_jwks_uri",
		);
		expect(
			await reason(make(ok).f.fetchJwks("https://ai.example:8443/k")),
		).toBe("invalid_jwks_uri");
		const redirect = () =>
			new Response(null, {
				status: 302,
				headers: { location: "http://169.254.169.254/" },
			});
		expect(
			await reason(make(redirect).f.fetchJwks("https://ai.example/k")),
		).toBe("fetch_failed");
		const html = () =>
			new Response("<html>", { headers: { "content-type": "text/html" } });
		expect(await reason(make(html).f.fetchJwks("https://ai.example/k"))).toBe(
			"fetch_failed",
		);
		const big = () => Response.json({ keys: [], pad: "x".repeat(70_000) });
		expect(await reason(make(big).f.fetchJwks("https://ai.example/k"))).toBe(
			"too_large",
		);
		expect(
			await reason(
				make(ok, undefined, ["claude.ai"]).f.fetchJwks("https://ai.example/k"),
			),
		).toBe("host_not_allowed");
	});

	test("JWKS fetches count against the host's CIMD limit", async () => {
		const { f } = make(() => Response.json(keys));
		const results: string[] = [];
		for (let i = 0; i < 7; i++) {
			results.push(await reason(f.fetchJwks(`https://ai.example/k${i}`)));
		}
		expect(results.slice(0, 5)).toEqual(Array(5).fill("accepted"));
		expect(results[6]).toBe("rate_limited");
	});
});

describe("RFC 7523 §3: the assertion's checks at /token", () => {
	test("a good assertion authenticates; client_id may be left out (RFC 7521 §4.2)", async () => {
		const r = relay();
		expect(
			await error(await probe(r, strictId, auth(await assertion(r, strictId)))),
		).toEqual(AUTHENTICATED);
		expect(
			await error(
				await probe(r, undefined, auth(await assertion(r, strictId))),
			),
		).toEqual(AUTHENTICATED);
		// aud may be the issuer, or an array that contains the token endpoint.
		for (const aud of [
			r.url,
			["https://elsewhere.example", `${r.url}/token`],
		]) {
			const token = await assertion(r, strictId, { aud });
			expect(await error(await probe(r, strictId, auth(token)))).toEqual(
				AUTHENTICATED,
			);
		}
		// typ JWT or the explicit client-authentication+jwt is fine.
		for (const typ of ["JWT", "client-authentication+jwt"]) {
			const token = await assertion(r, strictId, {}, { typ });
			expect(await error(await probe(r, strictId, auth(token)))).toEqual(
				AUTHENTICATED,
			);
		}
		expect(reasons(r)).toEqual([]);
	});

	test("algorithms: none, HMAC, a key of another type, and one the document does not name are refused", async () => {
		const r = relay();
		const now = Math.floor(Date.now() / 1000);
		const claims = {
			iss: strictId,
			sub: strictId,
			aud: `${r.url}/token`,
			exp: now + 60,
			jti: "j-none",
		};
		const unsigned = `${b64url({ alg: "none", kid: "k1" })}.${b64url(claims)}.`;
		const hmac = `${b64url({ alg: "HS256", kid: "k1" })}.${b64url(claims)}.c2ln`;
		// ES256 named, but k1 is an RSA key: the algorithm is tied to the key type.
		const crossType = await assertion(r, strictId, {}, { kid: "k1" }, ec);
		// The dual document names RS256 only; PS256 with an RSA key is refused.
		const ps256 = await assertion(r, dualId, {}, {}, ps);
		const results = [
			await probe(r, strictId, auth(unsigned)),
			await probe(r, strictId, auth(hmac)),
			await probe(r, strictId, auth(crossType)),
			await probe(r, dualId, auth(ps256)),
		];
		for (const res of results)
			expect(await error(res)).toEqual(UNAUTHENTICATED);
		expect(reasons(r)).toEqual(["alg", "alg", "key", "alg"]);
	});

	test("keys come only from the client's JWKS: by kid, never from the header", async () => {
		const r = relay();
		const stranger = await signingKey("RS256", "k1");
		// Signed with another key under k1's kid, with that key embedded.
		const embedded = await assertion(
			r,
			strictId,
			{},
			{ jwk: stranger.publicJwk, jku: `${cimd.origin}/other.json` },
			stranger,
		);
		// Without a kid, two RSA keys fit: ambiguous, refused.
		const noKid = await assertion(r, strictId, {}, { kid: undefined });
		for (const token of [embedded, noKid]) {
			expect(await error(await probe(r, strictId, auth(token)))).toEqual(
				UNAUTHENTICATED,
			);
		}
		expect(reasons(r)).toEqual(["signature", "key"]);
		// An unknown kid right after the keys were fetched: they may have been
		// rotated since, so try again (503), not "your key is wrong" (401).
		const unknownKid = await assertion(r, strictId, {}, { kid: "nope" });
		const res = await probe(r, strictId, auth(unknownKid));
		expect(await error(res)).toEqual(UNAVAILABLE);
		expect(unavailable(r)).toEqual(["jwks_unavailable"]);
		// The kid picks the key: k2 signs as k2.
		const k2 = await assertion(r, strictId, {}, {}, rsa2);
		expect(await error(await probe(r, strictId, auth(k2)))).toEqual(
			AUTHENTICATED,
		);
	});

	test("iss, sub, aud and typ must be the client's, for this relay", async () => {
		const r = relay();
		const cases: [Json, Json][] = [
			[{ iss: dualId }, {}],
			[{ sub: dualId }, {}],
			[{ iss: undefined }, {}],
			[{ aud: "https://other-relay.example/token" }, {}],
			[{ aud: [`${r.url}/revoke`] }, {}],
			[{ aud: undefined }, {}],
			[{}, { typ: "at+jwt" }],
			[{}, { typ: "tab-mcp-identity+jwt" }],
			[{}, { crit: ["exp"] }],
		];
		for (const [claims, header] of cases) {
			const token = await assertion(r, strictId, claims, header);
			expect(await error(await probe(r, strictId, auth(token)))).toEqual(
				UNAUTHENTICATED,
			);
		}
		// client_id that is not the assertion's issuer.
		const other = await assertion(r, dualId);
		expect(await error(await probe(r, strictId, auth(other)))).toEqual(
			UNAUTHENTICATED,
		);
		expect(reasons(r)).toEqual([
			"iss",
			"sub",
			"iss",
			"aud",
			"aud",
			"claims",
			"typ",
			"typ",
			"crit",
			"iss",
		]);
	});

	test("exp is required, live and at most an hour ahead; iat and nbf not in the future (30 s leeway)", async () => {
		const r = relay();
		const now = Math.floor(Date.now() / 1000);
		const cases: Json[] = [
			{ exp: undefined },
			{ exp: now - 60 },
			{ exp: now + 3600 + 120 },
			{ exp: "soon" },
			{ iat: now + 120 },
			{ nbf: now + 120 },
			{ jti: undefined },
			{ jti: "" },
			{ jti: "j".repeat(257) },
			// Review of PR 65: usable five minutes from iat, or with exp that
			// close when there is no iat.
			{ iat: now - 6 * 60 },
			{ iat: undefined, exp: now + 10 * 60 },
		];
		for (const claims of cases) {
			const token = await assertion(r, strictId, claims);
			expect(await error(await probe(r, strictId, auth(token)))).toEqual(
				UNAUTHENTICATED,
			);
		}
		expect(reasons(r)).toEqual([
			"exp",
			"expired",
			"lifetime",
			"claims",
			"iat",
			"nbf",
			"jti",
			"jti",
			"jti",
			"too_old",
			"lifetime",
		]);
		// Within the leeway, the full hour with a fresh iat, and five minutes
		// without iat are fine.
		for (const claims of [
			{ exp: now - 10 },
			{ exp: now + 3600 },
			{ iat: now + 10, nbf: now + 10 },
			{ iat: now - 4 * 60 },
			{ iat: undefined, exp: now + 4 * 60 },
		]) {
			const token = await assertion(r, strictId, claims);
			expect(await error(await probe(r, strictId, auth(token)))).toEqual(
				AUTHENTICATED,
			);
		}
	});

	test("a jti is single-use until its exp", async () => {
		const r = relay();
		const token = await assertion(r, strictId, { jti: "once" });
		expect(await error(await probe(r, strictId, auth(token)))).toEqual(
			AUTHENTICATED,
		);
		expect(await error(await probe(r, strictId, auth(token)))).toEqual(
			UNAUTHENTICATED,
		);
		// The same jti from another client is that client's own.
		const theirs = await assertion(r, dualId, { jti: "once" });
		expect(await error(await probe(r, dualId, auth(theirs)))).toEqual(
			AUTHENTICATED,
		);
		expect(reasons(r)).toEqual(["replayed"]);
		const until = await r.store.claimNonce?.(
			nonceKey(strictId, "once"),
			0,
			Date.now(),
		);
		expect(until).toBe(false);
	});

	test("review of PR 65: a JWKS or metadata fetch failure is 503 with Retry-After, not invalid_client", async () => {
		const r = relay();
		const broken = await probe(r, brokenId, auth(await assertion(r, brokenId)));
		expect(await error(broken)).toEqual(UNAVAILABLE);
		expect(broken.headers.get("retry-after")).toBe("10");
		const missing = `${cimd.origin}/missing.json`;
		const gone = await probe(r, missing, auth(await assertion(r, missing)));
		expect(await error(gone)).toEqual(UNAVAILABLE);
		expect(unavailable(r)).toEqual([
			"jwks_unavailable",
			"metadata_fetch_failed",
		]);
		expect(reasons(r)).toEqual([]);
	});

	test("review of PR 65: a client id on a private address answers like an unreachable one (503)", async () => {
		const r = relay();
		const privateId = "https://10.0.0.1/client.json";
		const res = await probe(r, privateId, auth(await assertion(r, privateId)));
		expect(await error(res)).toEqual(UNAVAILABLE);
		expect(unavailable(r)).toEqual(["metadata_private_address"]);
		expect(reasons(r)).toEqual([]);
	});

	test("review of PR 65: the CIMD fetch budget used up is 503 (rate_limited), not invalid_client", async () => {
		const r = relay();
		// Unknown client ids on the fixture's host use up its fetch allowance.
		for (let i = 0; i < 6; i++) {
			const id = `${cimd.origin}/missing-${i}.json`;
			const res = await probe(r, id, auth(await assertion(r, id)));
			expect(await error(res)).toEqual(UNAVAILABLE);
		}
		expect(unavailable(r)).toContain("metadata_rate_limited");
		expect(reasons(r)).toEqual([]);
	});

	test("a public client's assertion and a bad assertion type: invalid_client", async () => {
		const r = relay();
		const publicOne = await assertion(r, publicId);
		expect(await error(await probe(r, publicId, auth(publicOne)))).toEqual(
			UNAUTHENTICATED,
		);
		const wrongType = await probe(r, strictId, {
			client_assertion_type:
				"urn:ietf:params:oauth:client-assertion-type:saml2-bearer",
			client_assertion: await assertion(r, strictId),
		});
		expect(await error(wrongType)).toEqual(UNAUTHENTICATED);
		expect(wrongType.headers.get("www-authenticate")).not.toBeNull();
		expect(reasons(r)).toEqual(["not_private_key_jwt", "assertion_type"]);
		// Half of the pair is a malformed request; a garbage token is a failed one.
		expect(
			await error(
				await probe(r, strictId, {
					client_assertion: await assertion(r, strictId),
				}),
			),
		).toEqual({ status: 400, error: "invalid_request" });
		expect(await error(await probe(r, strictId, auth("not.a.jwt")))).toEqual(
			UNAUTHENTICATED,
		);
		expect(await error(await probe(r, undefined, auth("garbage")))).toEqual(
			UNAUTHENTICATED,
		);
	});

	test("the response says nothing beyond invalid_client; client_secret stays refused", async () => {
		const r = relay();
		const res = await probe(
			r,
			strictId,
			auth(await assertion(r, strictId, { aud: "https://x.example" })),
		);
		const body = (await res.json()) as Json;
		expect(body).toEqual({
			error: "invalid_client",
			error_description: "client authentication failed",
		});
		const secret = await probe(r, strictId, {
			client_secret: "s",
			...auth(await assertion(r, strictId)),
		});
		expect(await error(secret)).toEqual({
			status: 400,
			error: "invalid_client",
		});
	});
});

// The full flow: a tab, the pairing code, the code exchange and refreshes.

interface Flow {
	r: OAuthTestRelay;
	tab: ScriptedTab;
	address: string;
	browser: TestBrowser;
	used: Set<string>;
}

async function flow(store?: TokenStore): Promise<Flow> {
	const r = relay(store);
	const tab = new ScriptedTab(r.wsUrl);
	tabs.push(tab);
	const session = await tab.connect();
	await tab.startPairing();
	return {
		r,
		tab,
		address: session.address,
		browser: new TestBrowser(r.url),
		used: new Set(),
	};
}

/** Pair at /authorize and return the code and its verifier. */
async function authorize(
	f: Flow,
	clientId: string,
): Promise<{ code: string; verifier: string }> {
	const { verifier, challenge } = pkce();
	const page = await f.browser.open(
		authorizeUrl(f.r.url, {
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_challenge: challenge,
			resource: f.address,
		}),
	);
	expect(page.status).toBe(200);
	await waitFor(
		() => f.tab.pairingCode !== undefined && !f.used.has(f.tab.pairingCode),
		"a fresh code",
	);
	const pairing = f.tab.pairingCode ?? "";
	f.used.add(pairing);
	const result = await f.browser.submit(page, {
		action: "connect",
		code: pairing,
	});
	expect(result.status).toBe(303);
	const code = new URL(result.location ?? "").searchParams.get("code") ?? "";
	return { code, verifier };
}

function exchange(
	f: Flow,
	clientId: string,
	a: { code: string; verifier: string },
	extra: Record<string, string> = {},
): Promise<Response> {
	return postForm(`${f.r.url}/token`, {
		grant_type: "authorization_code",
		code: a.code,
		redirect_uri: REDIRECT,
		code_verifier: a.verifier,
		client_id: clientId,
		...extra,
	});
}

function refresh(
	f: Flow,
	clientId: string,
	token: string,
	extra: Record<string, string> = {},
): Promise<Response> {
	return postForm(`${f.r.url}/token`, {
		grant_type: "refresh_token",
		refresh_token: token,
		client_id: clientId,
		...extra,
	});
}

async function refreshToken(res: Response): Promise<string> {
	expect(res.status).toBe(200);
	return ((await res.json()) as { refresh_token: string }).refresh_token;
}

async function binding(f: Flow, token: string): Promise<string | undefined> {
	return (await f.r.store.get(hashToken(token)))?.clientAuth;
}

describe("DEC-106: a grant is bound to the method it was made with", () => {
	test("strict client: no code without an assertion, and the code survives the attempt", async () => {
		const f = await flow();
		const a = await authorize(f, strictId);
		expect(await error(await exchange(f, strictId, a))).toEqual(
			UNAUTHENTICATED,
		);
		expect(reasons(f.r)).toEqual(["assertion_required"]);
		const ok = await exchange(
			f,
			strictId,
			a,
			auth(await assertion(f.r, strictId)),
		);
		const rt = await refreshToken(ok);
		expect(await binding(f, rt)).toBe("private_key_jwt");
	});

	test("strict client: a refresh token is never redeemed as a public client, and the attempt revokes nothing", async () => {
		const f = await flow();
		const a = await authorize(f, strictId);
		const rt = await refreshToken(
			await exchange(f, strictId, a, auth(await assertion(f.r, strictId))),
		);
		expect(await error(await refresh(f, strictId, rt))).toEqual(
			UNAUTHENTICATED,
		);
		expect(f.r.logs.events("oauth.refresh_reuse")).toHaveLength(0);
		const next = await refreshToken(
			await refresh(f, strictId, rt, auth(await assertion(f.r, strictId))),
		);
		expect(await binding(f, next)).toBe("private_key_jwt");
		// A used token without the key: still refused before reuse detection.
		expect(await error(await refresh(f, strictId, rt))).toEqual(
			UNAUTHENTICATED,
		);
		expect(f.r.logs.events("oauth.refresh_reuse")).toHaveLength(0);
		await refreshToken(
			await refresh(f, strictId, next, auth(await assertion(f.r, strictId))),
		);
	});

	test("ChatGPT's shape (none listed): a public grant stays public until an assertion binds it", async () => {
		const f = await flow();
		const a = await authorize(f, dualId);
		const rt = await refreshToken(await exchange(f, dualId, a));
		expect(await binding(f, rt)).toBeUndefined();
		const rt2 = await refreshToken(await refresh(f, dualId, rt));
		expect(await binding(f, rt2)).toBeUndefined();
		const rt3 = await refreshToken(
			await refresh(f, dualId, rt2, auth(await assertion(f.r, dualId))),
		);
		expect(await binding(f, rt3)).toBe("private_key_jwt");
		expect(await error(await refresh(f, dualId, rt3))).toEqual(UNAUTHENTICATED);
	});

	test("ChatGPT's shape: a grant made with an assertion needs one for every refresh", async () => {
		const f = await flow();
		const a = await authorize(f, dualId);
		const rt = await refreshToken(
			await exchange(f, dualId, a, auth(await assertion(f.r, dualId))),
		);
		expect(await binding(f, rt)).toBe("private_key_jwt");
		expect(await error(await refresh(f, dualId, rt))).toEqual(UNAUTHENTICATED);
		await refreshToken(
			await refresh(f, dualId, rt, auth(await assertion(f.r, dualId))),
		);
	});

	test("a public client: no assertion needed, and one sent is refused", async () => {
		const f = await flow();
		const a = await authorize(f, publicId);
		expect(
			await error(
				await exchange(f, publicId, a, auth(await assertion(f.r, publicId))),
			),
		).toEqual(UNAUTHENTICATED);
		const rt = await refreshToken(await exchange(f, publicId, a));
		expect(await binding(f, rt)).toBeUndefined();
		await refreshToken(await refresh(f, publicId, rt));
	});

	test("review of PR 65: another client's valid assertion neither burns a code nor revokes its grant", async () => {
		const f = await flow();
		// Strict, ChatGPT-shaped and public victims; the attacker signs as dualId
		// (or, for the dual victim, as strictId), whose keys it holds.
		for (const [victim, attacker] of [
			[strictId, dualId],
			[dualId, strictId],
			[publicId, dualId],
		] as const) {
			const a = await authorize(f, victim);
			const steal = async () =>
				exchange(f, attacker, a, auth(await assertion(f.r, attacker)));
			expect(await error(await steal())).toEqual({
				status: 400,
				error: "invalid_grant",
			});
			// Not burnt: the real client still redeems it.
			const extra =
				victim === publicId ? {} : auth(await assertion(f.r, victim));
			const rt = await refreshToken(await exchange(f, victim, a, extra));
			// Presented again by the attacker: refused, and nothing is revoked.
			expect(await error(await steal())).toEqual({
				status: 400,
				error: "invalid_grant",
			});
			const again =
				victim === publicId ? {} : auth(await assertion(f.r, victim));
			await refreshToken(await refresh(f, victim, rt, again));
		}
		expect(f.tab.received.filter((m) => m.type === "grant.removed")).toEqual(
			[],
		);
	});

	test("review of PR 65: /revoke of a bound grant needs the client's assertion", async () => {
		const f = await flow();
		const a = await authorize(f, dualId);
		const rt = await refreshToken(
			await exchange(f, dualId, a, auth(await assertion(f.r, dualId))),
		);
		// A stolen refresh token with the public client_id ends nothing.
		const stolen = await postForm(`${f.r.url}/revoke`, {
			token: rt,
			client_id: dualId,
		});
		expect(await error(stolen)).toEqual(UNAUTHENTICATED);
		expect(reasons(f.r)).toEqual(["assertion_required"]);
		const next = await refreshToken(
			await refresh(f, dualId, rt, auth(await assertion(f.r, dualId))),
		);
		// A public grant is still revoked with the client_id alone.
		const b = await authorize(f, publicId);
		const publicRt = await refreshToken(await exchange(f, publicId, b));
		const plain = await postForm(`${f.r.url}/revoke`, {
			token: publicRt,
			client_id: publicId,
		});
		expect(plain.status).toBe(200);
		expect(await f.r.store.get(hashToken(publicRt))).toBeUndefined();
		expect(await binding(f, next)).toBe("private_key_jwt");
	});

	test("/revoke: an assertion is optional, but must be valid if sent", async () => {
		const f = await flow();
		const a = await authorize(f, strictId);
		const rt = await refreshToken(
			await exchange(f, strictId, a, auth(await assertion(f.r, strictId))),
		);
		const bad = await postForm(`${f.r.url}/revoke`, {
			token: rt,
			client_id: strictId,
			...auth(await assertion(f.r, strictId, { iss: dualId })),
		});
		expect(await error(bad)).toEqual(UNAUTHENTICATED);
		expect(await binding(f, rt)).toBe("private_key_jwt");
		const revoked = await postForm(`${f.r.url}/revoke`, {
			token: rt,
			...auth(await assertion(f.r, strictId, { aud: `${f.r.url}/revoke` })),
		});
		expect(revoked.status).toBe(200);
		expect(await f.r.store.get(hashToken(rt))).toBeUndefined();
	});
});

describe("the jti replay store across instances", () => {
	test("with a shared store, an assertion used at one instance is refused at another", async () => {
		const shared = new MemoryTokenStore();
		const one = relay(shared);
		const two = relay(shared);
		// Both relays accept the same audience only if it is the same issuer;
		// here each has its own URL, so the assertion names both.
		const token = await assertion(one, strictId, {
			aud: [`${one.url}/token`, `${two.url}/token`],
		});
		expect(await error(await probe(one, strictId, auth(token)))).toEqual(
			AUTHENTICATED,
		);
		expect(await error(await probe(two, strictId, auth(token)))).toEqual(
			UNAUTHENTICATED,
		);
		expect(reasons(two)).toEqual(["replayed"]);
	});

	test("a store without claimNonce: the relay remembers the jti itself", async () => {
		const inner = new MemoryTokenStore();
		const store: TokenStore = {
			put: (r) => inner.put(r),
			get: (h) => inner.get(h),
			markUsed: (h, n, k) => inner.markUsed(h, n, k),
			revoke: (s, o) => inner.revoke(s, o),
			listGrants: (a, n) => inner.listGrants(a, n),
			deleteExpired: (n) => inner.deleteExpired(n),
		};
		const r = relay(store);
		const token = await assertion(r, strictId);
		expect(await error(await probe(r, strictId, auth(token)))).toEqual(
			AUTHENTICATED,
		);
		expect(await error(await probe(r, strictId, auth(token)))).toEqual(
			UNAUTHENTICATED,
		);
		expect(reasons(r)).toEqual(["replayed"]);
	});
});
