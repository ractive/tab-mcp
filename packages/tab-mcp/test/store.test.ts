import { afterAll } from "bun:test";
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
