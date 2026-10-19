import { Database } from "bun:sqlite";
import { summarizeGrants } from "./memory.ts";
import type {
	GrantSummary,
	RevokeSelector,
	TokenKind,
	TokenRecord,
	TokenStore,
} from "./types.ts";

const SCHEMA_VERSION = 1;

interface Row {
	hash: string;
	kind: string;
	grant_id: string;
	address_id: string;
	client_id: string;
	client_name: string;
	scopes: string;
	grant_created_at: number;
	issued_at: number;
	expires_at: number;
	used_at: number | null;
}

function toRecord(row: Row): TokenRecord {
	const record: TokenRecord = {
		hash: row.hash,
		kind: row.kind as TokenKind,
		grantId: row.grant_id,
		addressId: row.address_id,
		clientId: row.client_id,
		clientName: row.client_name,
		scopes: JSON.parse(row.scopes) as string[],
		grantCreatedAt: row.grant_created_at,
		issuedAt: row.issued_at,
		expiresAt: row.expires_at,
	};
	if (row.used_at !== null) record.usedAt = row.used_at;
	return record;
}

/**
 * Tokens in a SQLite file via `bun:sqlite` (the default store, DEC-030). Uses
 * WAL mode so another process (or a test) can read and write the same file.
 */
export class SqliteTokenStore implements TokenStore {
	readonly #db: Database;

	/** `path` is a file path, or `:memory:`. */
	constructor(path: string) {
		this.#db = new Database(path, { create: true, strict: true });
		this.#db.run("PRAGMA busy_timeout = 5000");
		if (path !== ":memory:") this.#db.run("PRAGMA journal_mode = WAL");
		this.#migrate();
	}

	#migrate(): void {
		const row = this.#db.query("PRAGMA user_version").get() as {
			user_version: number;
		};
		if (row.user_version >= SCHEMA_VERSION) return;
		this.#db.transaction(() => {
			this.#db.run(`CREATE TABLE IF NOT EXISTS tokens (
				hash TEXT PRIMARY KEY,
				kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
				grant_id TEXT NOT NULL,
				address_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				client_name TEXT NOT NULL,
				scopes TEXT NOT NULL,
				grant_created_at INTEGER NOT NULL,
				issued_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				used_at INTEGER
			) STRICT`);
			this.#db.run(
				"CREATE INDEX IF NOT EXISTS tokens_grant ON tokens (grant_id)",
			);
			this.#db.run(
				"CREATE INDEX IF NOT EXISTS tokens_address ON tokens (address_id)",
			);
			this.#db.run(
				"CREATE INDEX IF NOT EXISTS tokens_expires ON tokens (expires_at)",
			);
			this.#db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		})();
	}

	async put(r: TokenRecord): Promise<void> {
		this.#db
			.query(
				`INSERT OR REPLACE INTO tokens (hash, kind, grant_id, address_id, client_id,
				client_name, scopes, grant_created_at, issued_at, expires_at, used_at)
				VALUES ($hash, $kind, $grant_id, $address_id, $client_id, $client_name,
				$scopes, $grant_created_at, $issued_at, $expires_at, $used_at)`,
			)
			.run({
				hash: r.hash,
				kind: r.kind,
				grant_id: r.grantId,
				address_id: r.addressId,
				client_id: r.clientId,
				client_name: r.clientName,
				scopes: JSON.stringify(r.scopes),
				grant_created_at: r.grantCreatedAt,
				issued_at: r.issuedAt,
				expires_at: r.expiresAt,
				used_at: r.usedAt ?? null,
			});
	}

	async get(hash: string): Promise<TokenRecord | undefined> {
		const row = this.#db
			.query("SELECT * FROM tokens WHERE hash = $hash")
			.get({ hash }) as Row | null;
		return row === null ? undefined : toRecord(row);
	}

	async markUsed(hash: string, now: number): Promise<boolean> {
		const result = this.#db
			.query(
				"UPDATE tokens SET used_at = $now WHERE hash = $hash AND used_at IS NULL",
			)
			.run({ hash, now });
		return result.changes === 1;
	}

	async revoke(selector: RevokeSelector): Promise<number> {
		const result =
			"grantId" in selector
				? this.#db
						.query("DELETE FROM tokens WHERE grant_id = $id")
						.run({ id: selector.grantId })
				: this.#db
						.query("DELETE FROM tokens WHERE address_id = $id")
						.run({ id: selector.addressId });
		return result.changes;
	}

	async listGrants(addressId: string, now: number): Promise<GrantSummary[]> {
		const rows = this.#db
			.query(
				`SELECT * FROM tokens WHERE address_id = $addressId AND expires_at > $now
				AND (kind = 'access' OR used_at IS NULL)`,
			)
			.all({ addressId, now }) as Row[];
		return summarizeGrants(rows.map(toRecord), now);
	}

	async deleteExpired(now: number): Promise<number> {
		return this.#db
			.query("DELETE FROM tokens WHERE expires_at <= $now")
			.run({ now }).changes;
	}

	async close(): Promise<void> {
		this.#db.close();
	}
}
