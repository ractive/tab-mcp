import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hasBindings } from "./guard.ts";
import type { BindingRecord, TokenRecord, TokenStore } from "./types.ts";

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
				app: "app-a",
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

		test("the subject of an identity-bound grant round-trips (DEC-077)", async () => {
			const bound = record({ grantId: "g_bound", subject: "key-of-alice" });
			const plain = record({ grantId: "g_plain" });
			await store.put(bound);
			await store.put(plain);
			expect(await store.get(bound.hash)).toEqual(bound);
			const got = await store.get(plain.hash);
			expect(got !== undefined && "subject" in got).toBe(false);
			const grants = await store.listGrants("addr-a", now);
			expect(grants.find((g) => g.grantId === "g_bound")?.subject).toBe(
				"key-of-alice",
			);
			const unbound = grants.find((g) => g.grantId === "g_plain");
			expect(unbound !== undefined && "subject" in unbound).toBe(false);
		});

		test("the client authentication binding round-trips (DEC-106)", async () => {
			const bound = record({
				grantId: "g_key",
				kind: "refresh",
				clientAuth: "private_key_jwt",
			});
			const plain = record({ grantId: "g_public", kind: "refresh" });
			await store.put(bound);
			await store.put(plain);
			expect(await store.get(bound.hash)).toEqual(bound);
			const got = await store.get(plain.hash);
			expect(got !== undefined && "clientAuth" in got).toBe(false);
			expect(await store.markUsed(bound.hash, now, now + 1000)).toBe(true);
			expect((await store.get(bound.hash))?.clientAuth).toBe("private_key_jwt");
		});

		test("claimNonce, if implemented: once until it expires, then again (DEC-106)", async () => {
			if (store.claimNonce === undefined) return;
			expect(await store.claimNonce("n1", now + 1000, now)).toBe(true);
			expect(await store.claimNonce("n1", now + 5000, now + 1)).toBe(false);
			expect(await store.claimNonce("n2", now + 1000, now)).toBe(true);
			// Expired, whether or not deleteExpired has run yet.
			expect(await store.claimNonce("n1", now + 9000, now + 1000)).toBe(true);
			expect(await store.claimNonce("n1", now + 9000, now + 2000)).toBe(false);
			await store.deleteExpired(now + 9000);
			expect(await store.claimNonce("n1", now + 20_000, now + 9000)).toBe(true);
		});

		test("claimNonce, if implemented: of concurrent calls exactly one wins", async () => {
			if (store.claimNonce === undefined) return;
			const claim = store.claimNonce.bind(store);
			const results = await Promise.all(
				Array.from({ length: 10 }, () => claim("race", now + 1000, now)),
			);
			expect(results.filter(Boolean)).toHaveLength(1);
		});

		const binding = (over: Partial<BindingRecord> = {}): BindingRecord => {
			seq++;
			return {
				addressId: `addr-${seq}`,
				group: "group-a",
				memberId: `m_${seq}`,
				provider: "google",
				app: "app-a",
				label: "Chrome on macOS",
				createdAt: now + seq,
				expiresAt: now + 86_400_000,
				...over,
			};
		};

		test("bindings, if implemented: all five methods or none (DEC-231)", () => {
			const methods = [
				store.putBinding,
				store.getBinding,
				store.listBindings,
				store.renameBinding,
				store.deleteBinding,
			].filter((m) => m !== undefined);
			expect([0, 5]).toContain(methods.length);
		});

		test("bindings, if implemented: put, get, list oldest first, replace by address", async () => {
			if (!hasBindings(store)) return;
			const a = binding();
			const b = binding();
			const other = binding({ group: "group-b" });
			for (const r of [b, a, other]) {
				expect(await store.putBinding(r, 16, now)).toBe("ok");
			}
			expect(await store.getBinding(a.addressId, now)).toEqual(a);
			expect(await store.getBinding("nope", now)).toBeUndefined();
			expect(await store.listBindings("group-a", now)).toEqual([a, b]);
			// The same address signs in again, here with another account.
			const moved = {
				...a,
				group: "group-b",
				label: "Work",
				createdAt: now + 99,
			};
			expect(await store.putBinding(moved, 16, now)).toBe("ok");
			expect(await store.listBindings("group-a", now)).toEqual([b]);
			expect(await store.listBindings("group-b", now)).toEqual([other, moved]);
		});

		test("bindings, if implemented: a full group refuses another address, not one of its own", async () => {
			if (!hasBindings(store)) return;
			const first = binding();
			const second = binding();
			expect(await store.putBinding(first, 2, now)).toBe("ok");
			expect(await store.putBinding(second, 2, now)).toBe("ok");
			const third = binding();
			expect(await store.putBinding(third, 2, now)).toBe("full");
			expect(await store.getBinding(third.addressId, now)).toBeUndefined();
			// A member signing in again takes no new place.
			expect(
				await store.putBinding({ ...first, expiresAt: now + 5000 }, 2, now),
			).toBe("ok");
			// An expired member counts for nothing.
			expect(
				await store.putBinding({ ...second, expiresAt: now - 1 }, 2, now),
			).toBe("ok");
			expect(await store.putBinding(third, 2, now)).toBe("ok");
		});

		test("bindings, if implemented: of concurrent sign-ins for the last place exactly one wins", async () => {
			if (!hasBindings(store)) return;
			const put = store.putBinding.bind(store);
			const results = await Promise.all(
				Array.from({ length: 8 }, () => put(binding(), 1, now)),
			);
			expect(results.filter((r) => r === "ok")).toHaveLength(1);
		});

		test("bindings, if implemented: expired ones are absent everywhere, and deleteExpired drops them", async () => {
			if (!hasBindings(store)) return;
			const r = binding({ expiresAt: now + 10 });
			await store.putBinding(r, 16, now);
			expect(await store.getBinding(r.addressId, now + 10)).toBeUndefined();
			expect(await store.listBindings(r.group, now + 10)).toEqual([]);
			expect(
				await store.renameBinding(r.group, r.memberId, "x", now + 10),
			).toBe(false);
			await store.deleteExpired(now + 10);
			expect(await store.getBinding(r.addressId, now)).toBeUndefined();
		});

		test("bindings, if implemented: rename and delete by member id within its group only", async () => {
			if (!hasBindings(store)) return;
			const r = binding();
			await store.putBinding(r, 16, now);
			expect(await store.renameBinding("group-b", r.memberId, "x", now)).toBe(
				false,
			);
			expect(await store.renameBinding(r.group, r.memberId, "Work", now)).toBe(
				true,
			);
			expect((await store.getBinding(r.addressId, now))?.label).toBe("Work");
			expect(
				await store.deleteBinding({ group: "group-b", memberId: r.memberId }),
			).toBeUndefined();
			expect(
				await store.deleteBinding({ group: r.group, memberId: r.memberId }),
			).toEqual({ ...r, label: "Work" });
			expect(await store.getBinding(r.addressId, now)).toBeUndefined();
			const s = binding();
			await store.putBinding(s, 16, now);
			expect(await store.deleteBinding({ addressId: s.addressId })).toEqual(s);
			expect(
				await store.deleteBinding({ addressId: s.addressId }),
			).toBeUndefined();
		});

		test("bindings, if implemented: revoking an address's grants leaves its binding", async () => {
			if (!hasBindings(store)) return;
			const r = binding({ addressId: "addr-a" });
			await store.putBinding(r, 16, now);
			await store.revoke({ addressId: "addr-a" }, until);
			expect(await store.getBinding("addr-a", now)).toEqual(r);
		});

		test("markUsed succeeds once, then fails", async () => {
			const r = record({ kind: "refresh" });
			await store.put(r);
			expect(await store.markUsed(r.hash, now + 1, r.expiresAt)).toBe(true);
			expect(await store.markUsed(r.hash, now + 2, r.expiresAt)).toBe(false);
			expect((await store.get(r.hash))?.usedAt).toBe(now + 1);
		});

		test("markUsed cuts expiresAt to keepUntil, so deleteExpired drops the used token then", async () => {
			const r = record({ kind: "refresh", expiresAt: now + 30 * 86_400_000 });
			await store.put(r);
			expect(await store.markUsed(r.hash, now, now + 86_400_000)).toBe(true);
			const used = await store.get(r.hash);
			expect(used?.usedAt).toBe(now);
			expect(used?.expiresAt).toBe(now + 86_400_000);
			await store.deleteExpired(now + 86_400_000 - 1);
			expect(await store.get(r.hash)).toBeDefined();
			await store.deleteExpired(now + 86_400_000);
			expect(await store.get(r.hash)).toBeUndefined();
		});

		test("markUsed never extends expiresAt, and a failed call changes nothing", async () => {
			const r = record({ kind: "refresh", expiresAt: now + 1000 });
			await store.put(r);
			expect(await store.markUsed(r.hash, now, now + 86_400_000)).toBe(true);
			expect((await store.get(r.hash))?.expiresAt).toBe(now + 1000);
			expect(await store.markUsed(r.hash, now + 1, now + 10)).toBe(false);
			const got = await store.get(r.hash);
			expect(got?.expiresAt).toBe(now + 1000);
			expect(got?.usedAt).toBe(now);
		});

		test("markUsed of an unknown hash fails", async () => {
			expect(await store.markUsed("nope", now, now + 1000)).toBe(false);
		});

		test("concurrent markUsed calls: exactly one wins", async () => {
			const r = record({ kind: "refresh" });
			await store.put(r);
			const results = await Promise.all(
				Array.from({ length: 10 }, (_, i) =>
					store.markUsed(r.hash, now + i, r.expiresAt),
				),
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
