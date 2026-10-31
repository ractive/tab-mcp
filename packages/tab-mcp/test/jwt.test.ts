/**
 * JWT checks (DEC-076): the algorithms, key matching, and the tab assertion's
 * claims (typ, iss, aud, exp ≤ 60 s, single-use jti).
 */
import { describe, expect, test } from "bun:test";
import {
	identityKey,
	TAB_ASSERTION_TYP,
	TabAssertionVerifier,
} from "../src/identity.ts";
import {
	fetchJson,
	type Jwk,
	JwksCache,
	JwtError,
	type KeySource,
	verifyJwt,
} from "../src/jwt.ts";
import { APP_ISSUER, signingKey, signJwt } from "./oidc-fixture.ts";

const ADDRESS = "https://relay.example/a/abc/mcp";
const PROVIDER = "https://login.example";

function source(keys: Record<string, unknown>[]): KeySource {
	return {
		keys: async (kid) =>
			(keys as Jwk[]).filter((k) => kid === undefined || k.kid === kid),
	};
}

/** Base64url of JSON (these test values have no + or /). */
const enc = (v: unknown) => btoa(JSON.stringify(v)).replace(/=+$/, "");

async function reason(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (error) {
		if (error instanceof JwtError) return error.reason;
		throw error;
	}
	return "accepted";
}

describe("verifyJwt", () => {
	for (const alg of ["RS256", "PS256", "ES256", "EdDSA"]) {
		test(`${alg} signatures verify; a changed payload does not`, async () => {
			const key = await signingKey(alg, "k1");
			const token = await signJwt(key, { sub: "alice" });
			const jwt = await verifyJwt(token, source([key.publicJwk]));
			expect(jwt.payload["sub"]).toBe("alice");
			const [h, , s] = token.split(".");
			const forged = `${h}.${enc({ sub: "mallory" })}.${s}`;
			expect(await reason(verifyJwt(forged, source([key.publicJwk])))).toBe(
				"signature",
			);
		});
	}

	test("alg none and HMAC are refused", async () => {
		const key = await signingKey("ES256", "k1");
		const none = `${enc({ alg: "none" })}.${enc({ sub: "a" })}.`;
		expect(await reason(verifyJwt(none, source([key.publicJwk])))).toBe("alg");
		const token = await signJwt(key, { sub: "a" }, { alg: "HS256" });
		expect(await reason(verifyJwt(token, source([key.publicJwk])))).toBe("alg");
	});

	test("a key of another type or with another alg is never used", async () => {
		const ec = await signingKey("ES256", "k1");
		const rsa = await signingKey("RS256", "k1");
		// An ES256 token whose kid names an RSA key: no matching key.
		const token = await signJwt(ec, { sub: "a" });
		expect(await reason(verifyJwt(token, source([rsa.publicJwk])))).toBe("key");
		const wrongAlg = { ...ec.publicJwk, alg: "ES384" };
		expect(await reason(verifyJwt(token, source([wrongAlg])))).toBe("key");
		const encKey = { ...ec.publicJwk, use: "enc" };
		expect(await reason(verifyJwt(token, source([encKey])))).toBe("key");
	});

	test("without a kid only one fitting key is used", async () => {
		const a = await signingKey("ES256", "a");
		const b = await signingKey("ES256", "b");
		const token = await signJwt(a, { sub: "x" }, { kid: undefined });
		const noKid = (k: Record<string, unknown>) => ({ ...k, kid: undefined });
		expect(await reason(verifyJwt(token, source([noKid(a.publicJwk)])))).toBe(
			"accepted",
		);
		expect(
			await reason(
				verifyJwt(token, source([noKid(a.publicJwk), noKid(b.publicJwk)])),
			),
		).toBe("key");
	});

	test("an embedded jwk header is ignored, crit is refused", async () => {
		const real = await signingKey("ES256", "k1");
		const attacker = await signingKey("ES256", "k1");
		const token = await signJwt(
			attacker,
			{ sub: "a" },
			{ jwk: attacker.publicJwk },
		);
		expect(await reason(verifyJwt(token, source([real.publicJwk])))).toBe(
			"signature",
		);
		const crit = await signJwt(real, { sub: "a" }, { crit: ["exp"] });
		expect(await reason(verifyJwt(crit, source([real.publicJwk])))).toBe(
			"crit",
		);
	});

	test("garbage and oversize tokens are malformed", async () => {
		const key = await signingKey("ES256", "k1");
		const src = source([key.publicJwk]);
		expect(await reason(verifyJwt("a.b", src))).toBe("malformed");
		expect(await reason(verifyJwt("!!.??.**", src))).toBe("malformed");
		expect(await reason(verifyJwt("x".repeat(9000), src))).toBe("too_large");
	});
});

describe("tab assertions (DEC-076)", () => {
	async function setup() {
		const key = await signingKey("ES256", "app-1");
		const verifier = new TabAssertionVerifier(
			{
				issuer: PROVIDER,
				clientId: "relay",
				assertionIssuer: APP_ISSUER,
				assertionJwksUrl: "https://app.example/jwks",
			},
			source([key.publicJwk]),
		);
		const now = Math.floor(Date.now() / 1000);
		const make = (claims: Record<string, unknown> = {}, header = {}) =>
			signJwt(
				key,
				{
					iss: APP_ISSUER,
					sub: "alice",
					aud: ADDRESS,
					iat: now,
					exp: now + 60,
					jti: crypto.randomUUID(),
					...claims,
				},
				{ typ: TAB_ASSERTION_TYP, ...header },
			);
		return { verifier, make, now };
	}

	test("a good assertion gives the binding key of (provider, sub)", async () => {
		const { verifier, make } = await setup();
		expect(await verifier.verify(await make(), ADDRESS)).toBe(
			identityKey(PROVIDER, "alice"),
		);
		expect(identityKey(PROVIDER, "alice")).not.toBe(
			identityKey(PROVIDER, "bob"),
		);
		expect(identityKey(PROVIDER, "alice")).not.toContain("alice");
	});

	test("expired, too long-lived, future iat or nbf are refused", async () => {
		const { verifier, make, now } = await setup();
		const check = async (claims: Record<string, unknown>) =>
			reason(verifier.verify(await make(claims), ADDRESS));
		expect(await check({ exp: now - 10 })).toBe("expired");
		expect(await check({ exp: now + 120 })).toBe("lifetime");
		expect(await check({ exp: undefined })).toBe("exp");
		expect(await check({ iat: now + 60 })).toBe("iat");
		expect(await check({ nbf: now + 60 })).toBe("nbf");
	});

	test("a replayed jti is refused", async () => {
		const { verifier, make } = await setup();
		const token = await make({ jti: "once" });
		expect(await reason(verifier.verify(token, ADDRESS))).toBe("accepted");
		expect(await reason(verifier.verify(token, ADDRESS))).toBe("replayed");
		expect(
			await reason(verifier.verify(await make({ jti: undefined }), ADDRESS)),
		).toBe("jti");
	});

	test("the replay cache is per person: another user's jti does not collide", async () => {
		const { verifier, make } = await setup();
		const jti = "shared-jti";
		expect(await reason(verifier.verify(await make({ jti }), ADDRESS))).toBe(
			"accepted",
		);
		expect(
			await reason(verifier.verify(await make({ jti, sub: "bob" }), ADDRESS)),
		).toBe("accepted");
		expect(await reason(verifier.verify(await make({ jti }), ADDRESS))).toBe(
			"replayed",
		);
	});

	test("one person cannot fill the replay cache for everyone (review of PR #13)", async () => {
		const { verifier, make } = await setup();
		const results: string[] = [];
		for (let i = 0; i < 121; i++) {
			results.push(await reason(verifier.verify(await make(), ADDRESS)));
		}
		// 120 in the window, then that person is busy...
		expect(results.slice(0, 120).every((r) => r === "accepted")).toBe(true);
		expect(results[120]).toBe("busy");
		// ...and everyone else still gets through.
		expect(
			await reason(verifier.verify(await make({ sub: "bob" }), ADDRESS)),
		).toBe("accepted");
	});

	test("wrong aud, iss, typ or sub are refused", async () => {
		const { verifier, make } = await setup();
		const check = async (claims: Record<string, unknown>, header = {}) =>
			reason(verifier.verify(await make(claims, header), ADDRESS));
		expect(await check({ aud: "https://relay.example/a/other/mcp" })).toBe(
			"aud",
		);
		expect(await check({ aud: [ADDRESS, "https://elsewhere.example"] })).toBe(
			"aud",
		);
		expect(await check({ aud: [ADDRESS] })).toBe("accepted");
		expect(await check({ iss: "https://evil.example" })).toBe("iss");
		expect(await check({}, { typ: "JWT" })).toBe("typ");
		expect(await check({ sub: "" })).toBe("sub");
		expect(await check({ sub: 42 })).toBe("sub");
	});
});

describe("JwksCache: stale keys on errors, no hammering", () => {
	test("serves the last keys for a grace period while the JWKS is down, and waits 30 s between attempts", async () => {
		const key = await signingKey("ES256", "k1");
		let up = true;
		let hits = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => {
				hits++;
				return up
					? Response.json({ keys: [key.publicJwk] })
					: new Response("down", { status: 503 });
			},
		});
		let clock = 1_000_000;
		const cache = new JwksCache(`http://127.0.0.1:${server.port}/jwks`, {
			now: () => clock,
		});
		try {
			expect(await cache.keys("k1")).toHaveLength(1);
			expect(hits).toBe(1);
			up = false;
			clock += 11 * 60_000; // stale: the refetch fails, the old keys are served
			expect(await cache.keys("k1")).toHaveLength(1);
			expect(hits).toBe(2);
			clock += 10_000; // within 30 s of the failure: no new attempt
			expect(await cache.keys("k1")).toHaveLength(1);
			// An unknown kid that cannot be looked for: unavailable, not "no key".
			await expect(cache.keys("other")).rejects.toThrow();
			expect(hits).toBe(2);
			clock += 21_000;
			expect(await cache.keys("k1")).toHaveLength(1);
			expect(hits).toBe(3);
			clock += 60 * 60_000; // past the grace period
			await expect(cache.keys("k1")).rejects.toThrow();
		} finally {
			await server.stop(true);
		}
	});

	test("review of PR 65: a new kid is looked for after 5 s; throttled, it is unavailable, never 'no key'", async () => {
		const k1 = await signingKey("ES256", "k1");
		const k2 = await signingKey("ES256", "k2");
		let keys = [k1.publicJwk];
		let hits = 0;
		let clock = 1_000_000;
		const cache = new JwksCache("https://keys.example/jwks", {
			now: () => clock,
			load: async () => {
				hits++;
				return { keys };
			},
		});
		expect(await cache.keys("k1")).toHaveLength(1);
		keys = [k1.publicJwk, k2.publicJwk]; // the app rotates
		clock += 2_000; // too soon to fetch again
		await expect(cache.keys("k2")).rejects.toThrow();
		const jwt = await signJwt(k2, { sub: "x" });
		expect(await reason(verifyJwt(jwt, cache))).toBe("jwks_unavailable");
		expect(hits).toBe(1);
		clock += 4_000; // past the 5 s floor: fetched again, found
		expect(await cache.keys("k2")).toHaveLength(1);
		expect(hits).toBe(2);
		// Fetched just now and still unknown: that key does not exist.
		clock += 6_000;
		expect(await cache.keys("nope")).toHaveLength(0);
		expect(hits).toBe(3);
	});

	test("with no keys yet a failure throws, and the next call does not fetch again at once", async () => {
		let hits = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => {
				hits++;
				return new Response("down", { status: 503 });
			},
		});
		const cache = new JwksCache(`http://127.0.0.1:${server.port}/jwks`);
		try {
			await expect(cache.keys("k1")).rejects.toThrow();
			await expect(cache.keys("k1")).rejects.toThrow();
			expect(hits).toBe(1);
		} finally {
			await server.stop(true);
		}
	});

	test("callers during a fetch wait for it: a cold start and a key rotation (review of PR #13)", async () => {
		const k1 = await signingKey("ES256", "k1");
		const k2 = await signingKey("ES256", "k2");
		let keys = [k1.publicJwk];
		let hits = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async () => {
				hits++;
				await Bun.sleep(200); // a slow JWKS endpoint
				return Response.json({ keys });
			},
		});
		let clock = 1_000_000;
		const cache = new JwksCache(`http://127.0.0.1:${server.port}/jwks`, {
			now: () => clock,
		});
		try {
			// Many tabs after a restart: one fetch, every caller gets the key.
			const cold = await Promise.all(
				Array.from({ length: 5 }, () => cache.keys("k1")),
			);
			expect(cold.map((k) => k.length)).toEqual([1, 1, 1, 1, 1]);
			expect(hits).toBe(1);
			// The app rotates to k2: callers arriving during the refetch see it too.
			keys = [k1.publicJwk, k2.publicJwk];
			clock += 31_000;
			const rotated = await Promise.all([cache.keys("k2"), cache.keys("k2")]);
			expect(rotated.map((k) => k.length)).toEqual([1, 1]);
			expect(hits).toBe(2);
		} finally {
			await server.stop(true);
		}
	});
});

describe("fetchJson: the size limit", () => {
	test("a chunked body without Content-Length is cut off at the limit (review of PR #13)", async () => {
		let sent = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () =>
				new Response(
					new ReadableStream({
						async pull(controller) {
							if (sent >= 1024 * 1024) {
								controller.close();
								return;
							}
							sent += 16 * 1024;
							controller.enqueue(new Uint8Array(16 * 1024).fill(32));
							await Bun.sleep(1);
						},
					}),
					{ headers: { "content-type": "application/json" } },
				),
		});
		try {
			await expect(
				fetchJson(`http://127.0.0.1:${server.port}/big`, {}, 64 * 1024),
			).rejects.toThrow("too large");
			// It stopped reading soon after the limit, not at the end of the megabyte.
			expect(sent).toBeLessThan(512 * 1024);
		} finally {
			await server.stop(true);
		}
	});
});
