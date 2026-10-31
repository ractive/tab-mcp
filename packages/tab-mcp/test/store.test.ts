import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryTokenStore } from "../src/store/memory.ts";
import { SqliteTokenStore } from "../src/store/sqlite.ts";
import { tokenStoreConformance } from "../src/testing.ts";

const dir = mkdtempSync(join(tmpdir(), "tab-mcp-store-"));
let n = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

tokenStoreConformance("MemoryTokenStore", () => new MemoryTokenStore());
tokenStoreConformance(
	"SqliteTokenStore (:memory:)",
	() => new SqliteTokenStore(":memory:"),
);
tokenStoreConformance(
	"SqliteTokenStore (file)",
	() => new SqliteTokenStore(join(dir, `t${++n}.db`)),
);

test("review of PR 32: opening a version 3 file cuts used refresh tokens to the 24-hour window", async () => {
	const path = join(dir, "v3.db");
	const day = 86_400_000;
	const used = 1_800_000_000_000;
	const store = new SqliteTokenStore(path);
	const base = {
		grantId: "g1",
		addressId: "a1",
		clientId: "c",
		clientName: "C",
		scopes: ["tools"],
		grantCreatedAt: 1,
		issuedAt: 1,
	};
	await store.put({
		...base,
		hash: "used",
		kind: "refresh",
		expiresAt: used + 30 * day,
		usedAt: used,
	});
	await store.put({
		...base,
		hash: "live",
		kind: "refresh",
		expiresAt: used + 30 * day,
	});
	await store.put({
		...base,
		hash: "soon",
		kind: "refresh",
		expiresAt: used + 1000,
		usedAt: used,
	});
	await store.close();
	const db = new Database(path, { strict: true });
	db.run("PRAGMA user_version = 3");
	db.close();
	const reopened = new SqliteTokenStore(path);
	expect((await reopened.get("used"))?.expiresAt).toBe(used + day);
	expect((await reopened.get("live"))?.expiresAt).toBe(used + 30 * day);
	expect((await reopened.get("soon"))?.expiresAt).toBe(used + 1000);
	await reopened.close();
});

test("a version 2 SQLite file gains the subject and client_auth columns and keeps its tokens", async () => {
	const path = join(dir, "v2.db");
	const old = new Database(path, { create: true, strict: true });
	old.run(`CREATE TABLE revocations (
		kind TEXT NOT NULL CHECK (kind IN ('grant', 'address')),
		id TEXT NOT NULL, at INTEGER NOT NULL, keep_until INTEGER NOT NULL,
		PRIMARY KEY (kind, id)) STRICT`);
	old.run(`CREATE TABLE tokens (hash TEXT PRIMARY KEY,
		kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
		grant_id TEXT NOT NULL, address_id TEXT NOT NULL, client_id TEXT NOT NULL,
		client_name TEXT NOT NULL, scopes TEXT NOT NULL, grant_created_at INTEGER NOT NULL,
		issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER) STRICT`);
	old.run(
		`INSERT INTO tokens VALUES ('h1', 'access', 'g1', 'a1', 'c', 'C', '["tools"]', 1, 1, 9999999999999, NULL)`,
	);
	old.run("PRAGMA user_version = 2");
	old.close();
	const store = new SqliteTokenStore(path);
	const got = await store.get("h1");
	expect(got?.grantId).toBe("g1");
	expect(got !== undefined && "subject" in got).toBe(false);
	await store.put({
		...(got as NonNullable<typeof got>),
		hash: "h2",
		subject: "k",
	});
	expect((await store.get("h2"))?.subject).toBe("k");
	// Version 5 (DEC-106): the binding and the nonce table.
	await store.put({
		...(got as NonNullable<typeof got>),
		hash: "h3",
		clientAuth: "private_key_jwt",
	});
	expect((await store.get("h3"))?.clientAuth).toBe("private_key_jwt");
	expect(await store.claimNonce("n", 2000, 1000)).toBe(true);
	expect(await store.claimNonce("n", 2000, 1001)).toBe(false);
	await store.close();
});
