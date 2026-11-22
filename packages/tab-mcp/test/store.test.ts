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
		app: "app",
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

test("review of PR 65: the file records the oldest relay schema that may open it, and a newer value is refused", async () => {
	const path = join(dir, "min-reader.db");
	const store = new SqliteTokenStore(path);
	await store.close();
	const db = new Database(path, { strict: true });
	expect(
		db.query("SELECT value FROM meta WHERE key = 'min_reader_version'").get(),
	).toEqual({ value: 6 });
	expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
	// A later release marks the file as needing schema 7.
	db.run("UPDATE meta SET value = 7 WHERE key = 'min_reader_version'");
	db.close();
	expect(() => new SqliteTokenStore(path)).toThrow(/needs a newer relay/);
	// Opening never lowers it.
	const again = new Database(path, { strict: true });
	expect(
		again
			.query("SELECT value FROM meta WHERE key = 'min_reader_version'")
			.get(),
	).toEqual({ value: 7 });
	again.close();
});

/** The tables as a relay of schema 5 made them: no `app` column (before DEC-196). */
function schema5File(path: string): Database {
	const old = new Database(path, { create: true, strict: true });
	old.run(`CREATE TABLE revocations (
		kind TEXT NOT NULL CHECK (kind IN ('grant', 'address')),
		id TEXT NOT NULL, at INTEGER NOT NULL, keep_until INTEGER NOT NULL,
		PRIMARY KEY (kind, id)) STRICT`);
	old.run(`CREATE TABLE tokens (hash TEXT PRIMARY KEY,
		kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
		grant_id TEXT NOT NULL, address_id TEXT NOT NULL, client_id TEXT NOT NULL,
		client_name TEXT NOT NULL, scopes TEXT NOT NULL, grant_created_at INTEGER NOT NULL,
		issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER,
		subject TEXT, client_auth TEXT) STRICT`);
	old.run(`CREATE TABLE nonces (key TEXT PRIMARY KEY,
		expires_at INTEGER NOT NULL) STRICT`);
	old.run("CREATE INDEX tokens_grant ON tokens (grant_id)");
	old.run("CREATE INDEX tokens_address ON tokens (address_id)");
	old.run("CREATE INDEX tokens_expires ON tokens (expires_at)");
	old.run(`CREATE TABLE meta (key TEXT PRIMARY KEY,
		value INTEGER NOT NULL) STRICT`);
	old.run("INSERT INTO meta (key, value) VALUES ('min_reader_version', 5)");
	old.run("PRAGMA user_version = 5");
	return old;
}

test("a schema 5 file opens and gains the app column; its tokens go, as they were for addresses that no longer exist (DEC-196)", async () => {
	const path = join(dir, "v5.db");
	const old = schema5File(path);
	old.run(
		`INSERT INTO tokens VALUES ('h1', 'access', 'g1', 'a1', 'c', 'C', '["tools"]', 1, 1, 9999999999999, NULL, 'who', 'private_key_jwt')`,
	);
	old.run(
		`INSERT INTO tokens VALUES ('h2', 'refresh', 'g1', 'a1', 'c', 'C', '["tools"]', 1, 1, 9999999999999, NULL, NULL, NULL)`,
	);
	old.close();

	const store = new SqliteTokenStore(path);
	// Neither could be used at any address, and the refresh token would keep
	// making more of them: none is left to list as a connected AI app.
	expect(await store.get("h1")).toBeUndefined();
	expect(await store.get("h2")).toBeUndefined();
	expect(await store.listGrants("a1", Date.now())).toEqual([]);
	// New tokens in the same file keep their app.
	const fresh = {
		hash: "h3",
		kind: "access" as const,
		grantId: "g2",
		addressId: "a1",
		app: "my-app",
		clientId: "c",
		clientName: "C",
		scopes: ["tools"],
		grantCreatedAt: 1,
		issuedAt: 1,
		expiresAt: 9999999999999,
	};
	expect(await store.put(fresh)).toBe(true);
	expect(await store.get("h3")).toEqual(fresh);
	await store.close();

	const db = new Database(path, { strict: true });
	expect(
		(db.query("PRAGMA table_info(tokens)").all() as { name: string }[]).map(
			(c) => c.name,
		),
	).toContain("app");
	expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
	// A relay of schema 5 would drop the column on write: it must refuse the file.
	expect(
		db.query("SELECT value FROM meta WHERE key = 'min_reader_version'").get(),
	).toEqual({ value: 6 });
	db.close();

	// Opening again changes nothing: the step runs once, and deletes nothing more.
	const again = new SqliteTokenStore(path);
	expect((await again.get("h3"))?.app).toBe("my-app");
	await again.close();
});

test("the app is stored in the file: it survives closing and opening, and replacing a record replaces it", async () => {
	const path = join(dir, "app.db");
	const record = {
		hash: "h",
		kind: "access" as const,
		grantId: "g",
		addressId: "a",
		app: "calc-2",
		clientId: "c",
		clientName: "C",
		scopes: ["tools"],
		grantCreatedAt: 1,
		issuedAt: 1,
		expiresAt: 9999999999999,
	};
	const store = new SqliteTokenStore(path);
	await store.put(record);
	await store.put({ ...record, hash: "longest", app: "a".repeat(32) });
	await store.close();
	const reopened = new SqliteTokenStore(path);
	expect(await reopened.get("h")).toEqual(record);
	expect((await reopened.get("longest"))?.app).toBe("a".repeat(32));
	await reopened.put({ ...record, app: "other" });
	expect((await reopened.get("h"))?.app).toBe("other");
	await reopened.close();
});

test("a version 2 SQLite file gains the subject, client_auth and app columns; its tokens go with the step to 6", async () => {
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
	// Its tokens were for addresses that no longer exist (DEC-196).
	expect(await store.get("h1")).toBeUndefined();
	const got = {
		hash: "h1",
		kind: "access" as const,
		grantId: "g1",
		addressId: "a1",
		app: "my-app",
		clientId: "c",
		clientName: "C",
		scopes: ["tools"],
		grantCreatedAt: 1,
		issuedAt: 1,
		expiresAt: 9999999999999,
	};
	await store.put({
		...got,
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
