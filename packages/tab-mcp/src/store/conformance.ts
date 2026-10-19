import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenRecord, TokenStore } from "./types.ts";

/**
 * The conformance suite every `TokenStore` must pass (DEC-041). Call it from a
 * `bun test` file with a factory that returns a fresh, empty store:
 *
 * ```ts
 * import { tokenStoreConformance } from "@ractive-ch/tab-mcp/testing";
 * tokenStoreConformance("RedisTokenStore", async () => new RedisTokenStore(…));
 * ```
 */
export function tokenStoreConformance(
	name: string,
	factory: () => TokenStore | Promise<TokenStore>,
): void {
	describe(`TokenStore conformance: ${name}`, () => {
		let store: TokenStore;
		const now = 1_800_000_000_000;
		let seq = 0;

		const until = { now, keepUntil: now + 86_400_000 };

		const record = (over: Partial<TokenRecord> = {}): TokenRecord => {
			seq++;
			return {
				hash: `hash-${seq}`,
				kind: "access",
				grantId: "g_1",
				addressId: "addr-a",
				clientId: "https://client.example/cimd",
				clientName: "Client",
				scopes: ["tools"],
				grantCreatedAt: now - 1000,
				issuedAt: now,
				expiresAt: now + 3_600_000,
				...over,
			};
		};

		beforeEach(async () => {
			store = await factory();
		});

		afterEach(async () => {
			await store.close?.();
		});

		test("put then get returns an equal record", async () => {
			const r = record({ scopes: ["tools", "extra"] });
			expect(await store.put(r)).toBe(true);
			expect(await store.get(r.hash)).toEqual(r);
		});

		test("get of an unknown hash is undefined", async () => {
			expect(await store.get("nope")).toBeUndefined();
		});

		test("put replaces the record with the same hash", async () => {
			const r = record();
			await store.put(r);
			await store.put({ ...r, clientName: "Renamed", expiresAt: now + 5 });
			const got = await store.get(r.hash);
			expect(got?.clientName).toBe("Renamed");
			expect(got?.expiresAt).toBe(now + 5);
		});

		test("get returns expired and used records unchanged", async () => {
			const expired = record({ expiresAt: now - 1 });
			const used = record({ kind: "refresh", usedAt: now - 10 });
			await store.put(expired);
			await store.put(used);
			expect(await store.get(expired.hash)).toEqual(expired);
			expect(await store.get(used.hash)).toEqual(used);
		});

		test("a record without usedAt comes back without the key", async () => {
			const r = record();
			await store.put(r);
			const got = await store.get(r.hash);
			expect(got !== undefined && "usedAt" in got).toBe(false);
		});

		test("markUsed succeeds once, then fails", async () => {
			const r = record({ kind: "refresh" });
			await store.put(r);
			expect(await store.markUsed(r.hash, now + 1)).toBe(true);
			expect(await store.markUsed(r.hash, now + 2)).toBe(false);
			expect((await store.get(r.hash))?.usedAt).toBe(now + 1);
		});

		test("markUsed of an unknown hash fails", async () => {
			expect(await store.markUsed("nope", now)).toBe(false);
		});

		test("concurrent markUsed calls: exactly one wins", async () => {
			const r = record({ kind: "refresh" });
			await store.put(r);
			const results = await Promise.all(
				Array.from({ length: 10 }, (_, i) => store.markUsed(r.hash, now + i)),
			);
			expect(results.filter(Boolean)).toHaveLength(1);
		});

		test("revoke by grant deletes only that grant's tokens", async () => {
			const a = record({ grantId: "g_a" });
			const a2 = record({ grantId: "g_a", kind: "refresh" });
			const b = record({ grantId: "g_b" });
			for (const r of [a, a2, b]) await store.put(r);
			expect(await store.revoke({ grantId: "g_a" }, until)).toBe(2);
			expect(await store.get(a.hash)).toBeUndefined();
			expect(await store.get(a2.hash)).toBeUndefined();
			expect(await store.get(b.hash)).toEqual(b);
		});

		test("revoke by address deletes only that address's tokens", async () => {
			const a = record({ addressId: "addr-a", grantId: "g_a" });
			const b = record({ addressId: "addr-b", grantId: "g_b" });
			await store.put(a);
			await store.put(b);
			expect(await store.revoke({ addressId: "addr-a" }, until)).toBe(1);
			expect(await store.get(a.hash)).toBeUndefined();
			expect(await store.get(b.hash)).toEqual(b);
		});

		test("revoke of nothing returns 0", async () => {
			expect(await store.revoke({ grantId: "none" }, until)).toBe(0);
		});

		test("a revoked grant gets no new tokens until its tombstone expires", async () => {
			await store.revoke({ grantId: "g_dead" }, until);
			const late = record({ grantId: "g_dead", kind: "refresh" });
			expect(await store.put(late)).toBe(false);
			expect(await store.get(late.hash)).toBeUndefined();
			expect(await store.put(record({ grantId: "g_alive" }))).toBe(true);
			await store.deleteExpired(until.keepUntil);
			expect(await store.put(record({ grantId: "g_dead" }))).toBe(true);
		});

		test("a revoked address refuses grants created up to the revocation, not later ones", async () => {
			await store.revoke({ addressId: "addr-a" }, until);
			expect(
				await store.put(record({ grantId: "g_before", grantCreatedAt: now })),
			).toBe(false);
			expect(
				await store.put(
					record({ grantId: "g_after", grantCreatedAt: now + 1 }),
				),
			).toBe(true);
			expect(
				await store.put(
					record({
						grantId: "g_elsewhere",
						addressId: "addr-b",
						grantCreatedAt: now,
					}),
				),
			).toBe(true);
		});

		test("a put racing a revocation of its grant never survives it", async () => {
			for (let i = 0; i < 20; i++) {
				const r = record({ grantId: `g_race_${i}`, kind: "refresh" });
				await Promise.all([
					store.put(r),
					store.revoke({ grantId: r.grantId }, until),
				]);
				expect(await store.get(r.hash)).toBeUndefined();
			}
		});

		test("deleteExpired removes records with expiresAt <= now only", async () => {
			const gone = record({ expiresAt: now - 1 });
			const edge = record({ expiresAt: now });
			const kept = record({ expiresAt: now + 1 });
			for (const r of [gone, edge, kept]) await store.put(r);
			expect(await store.deleteExpired(now)).toBe(2);
			expect(await store.get(gone.hash)).toBeUndefined();
			expect(await store.get(edge.hash)).toBeUndefined();
			expect(await store.get(kept.hash)).toEqual(kept);
		});

		test("listGrants groups live tokens of one address by grant", async () => {
			await store.put(
				record({
					grantId: "g_new",
					grantCreatedAt: now - 10,
					clientName: "New",
				}),
			);
			await store.put(
				record({
					grantId: "g_old",
					grantCreatedAt: now - 500,
					clientName: "Old",
					scopes: ["tools"],
				}),
			);
			await store.put(
				record({
					grantId: "g_old",
					kind: "refresh",
					grantCreatedAt: now - 500,
					clientName: "Old",
				}),
			);
			await store.put(record({ grantId: "g_other", addressId: "addr-b" }));
			expect(await store.listGrants("addr-a", now)).toEqual([
				{
					grantId: "g_old",
					clientId: "https://client.example/cimd",
					clientName: "Old",
					scopes: ["tools"],
					createdAt: now - 500,
				},
				{
					grantId: "g_new",
					clientId: "https://client.example/cimd",
					clientName: "New",
					scopes: ["tools"],
					createdAt: now - 10,
				},
			]);
		});

		test("listGrants leaves out grants without a usable token", async () => {
			await store.put(record({ grantId: "g_expired", expiresAt: now }));
			await store.put(
				record({ grantId: "g_used", kind: "refresh", usedAt: now - 1 }),
			);
			await store.put(
				record({ grantId: "g_live", kind: "refresh", expiresAt: now + 1 }),
			);
			const grants = await store.listGrants("addr-a", now);
			expect(grants.map((g) => g.grantId)).toEqual(["g_live"]);
		});

		test("listGrants of an unknown address is empty", async () => {
			expect(await store.listGrants("nobody", now)).toEqual([]);
		});

		test("changing a returned record does not change the store", async () => {
			const r = record();
			await store.put(r);
			const got = await store.get(r.hash);
			if (got === undefined) throw new Error("missing");
			got.scopes.push("mutated");
			got.expiresAt = 0;
			expect(await store.get(r.hash)).toEqual(r);
		});
	});
}
