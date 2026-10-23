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

test("a version 2 SQLite file gains the subject column and keeps its tokens", async () => {
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
	await store.close();
});
