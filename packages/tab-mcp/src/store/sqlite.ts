import { Database } from "bun:sqlite";
import { summarizeGrants } from "./memory.ts";
import type {
	GrantSummary,
	RevokeOptions,
	RevokeSelector,
	TokenKind,
	TokenRecord,
	TokenStore,
} from "./types.ts";

const SCHEMA_VERSION = 5;
/**
 * The oldest schema a relay must know to use a file of this version safely,
 * kept in the file's `meta` table (review of PR 65). A relay refuses a file
 * whose value is above its own `SCHEMA_VERSION`: a later release that adds
 * a column an older relay would drop raises it, and older relays from this
 * one on refuse to open that file rather than quietly lose the column.
 * Relays before this one do not read it: one of them drops `client_auth`
 * (DEC-106), so bound grants come back unbound.
 */
const MIN_READER_VERSION = 5;
/** The reuse window of used refresh tokens (DEC-091), for the version 4 step. */
const REUSE_WINDOW_MS = 86_400_000;

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
	subject: string | null;
	client_auth: string | null;
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
	if (row.subject !== null) record.subject = row.subject;
	if (row.client_auth === "private_key_jwt")
		record.clientAuth = "private_key_jwt";
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
		this.#checkReader();
		this.#migrate();
		this.#db.run(`CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value INTEGER NOT NULL
		) STRICT`);
		this.#db
			.query(
				`INSERT INTO meta (key, value) VALUES ('min_reader_version', $v)
				ON CONFLICT (key) DO UPDATE SET value = max(value, excluded.value)`,
			)
			.run({ v: MIN_READER_VERSION });
	}

	/** Refuse a file that a newer relay marked as needing at least its schema. */
	#checkReader(): void {
		const table = this.#db
			.query(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
			)
			.get();
		if (table === null) return;
		const row = this.#db
			.query("SELECT value FROM meta WHERE key = 'min_reader_version'")
			.get() as { value: number } | null;
		if (row !== null && row.value > SCHEMA_VERSION) {
			this.#db.close();
			throw new Error(
				`the token store file needs a newer relay (schema ${row.value}; this relay knows ${SCHEMA_VERSION})`,
			);
		}
	}

	#migrate(): void {
		const row = this.#db.query("PRAGMA user_version").get() as {
			user_version: number;
		};
		if (row.user_version >= SCHEMA_VERSION) return;
		this.#db.transaction(() => {
			// Version 2: tombstones of revoked grants and addresses.
			this.#db.run(`CREATE TABLE IF NOT EXISTS revocations (
				kind TEXT NOT NULL CHECK (kind IN ('grant', 'address')),
				id TEXT NOT NULL,
				at INTEGER NOT NULL,
				keep_until INTEGER NOT NULL,
				PRIMARY KEY (kind, id)
			) STRICT`);
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
				used_at INTEGER,
				subject TEXT,
				client_auth TEXT
			) STRICT`);
			// Version 3: the subject of identity-bound grants (DEC-077).
			const columns = this.#db.query("PRAGMA table_info(tokens)").all() as {
				name: string;
			}[];
			if (!columns.some((c) => c.name === "subject")) {
				this.#db.run("ALTER TABLE tokens ADD COLUMN subject TEXT");
			}
			// Version 5: the client authentication binding of a grant, and the
			// used client assertion ids (DEC-106).
			if (!columns.some((c) => c.name === "client_auth")) {
				this.#db.run("ALTER TABLE tokens ADD COLUMN client_auth TEXT");
			}
			this.#db.run(`CREATE TABLE IF NOT EXISTS nonces (
				key TEXT PRIMARY KEY,
				expires_at INTEGER NOT NULL
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
			// Version 4: refresh tokens used before the upgrade get the reuse
			// window that markUsed now gives (DEC-091), so they go too.
			this.#db
				.query(
					`UPDATE tokens SET expires_at = min(expires_at, used_at + $window)
					WHERE kind = 'refresh' AND used_at IS NOT NULL`,
				)
				.run({ window: REUSE_WINDOW_MS });
			this.#db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		})();
	}

	async put(r: TokenRecord): Promise<boolean> {
		return this.#db.transaction(() => {
			const revoked = this.#db
				.query(
					`SELECT 1 FROM revocations WHERE (kind = 'grant' AND id = $grant_id)
					OR (kind = 'address' AND id = $address_id AND at >= $created)`,
				)
				.get({
					grant_id: r.grantId,
					address_id: r.addressId,
					created: r.grantCreatedAt,
				});
			if (revoked !== null) return false;
			this.#insert(r);
			return true;
		})();
	}

	#insert(r: TokenRecord): void {
		this.#db
			.query(
				`INSERT OR REPLACE INTO tokens (hash, kind, grant_id, address_id, client_id,
				client_name, scopes, grant_created_at, issued_at, expires_at, used_at, subject,
				client_auth)
				VALUES ($hash, $kind, $grant_id, $address_id, $client_id, $client_name,
				$scopes, $grant_created_at, $issued_at, $expires_at, $used_at, $subject,
				$client_auth)`,
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
				subject: r.subject ?? null,
				client_auth: r.clientAuth ?? null,
			});
	}

	async get(hash: string): Promise<TokenRecord | undefined> {
		const row = this.#db
			.query("SELECT * FROM tokens WHERE hash = $hash")
			.get({ hash }) as Row | null;
		return row === null ? undefined : toRecord(row);
	}

	async markUsed(
		hash: string,
		now: number,
		keepUntil: number,
	): Promise<boolean> {
		const result = this.#db
			.query(
				`UPDATE tokens SET used_at = $now, expires_at = min(expires_at, $keep_until)
				WHERE hash = $hash AND used_at IS NULL`,
			)
			.run({ hash, now, keep_until: keepUntil });
		return result.changes === 1;
	}

	async revoke(
		selector: RevokeSelector,
		options: RevokeOptions,
	): Promise<number> {
		return this.#db.transaction(() => {
			this.#db
				.query(
					`INSERT INTO revocations (kind, id, at, keep_until) VALUES ($kind, $id, $at, $until)
					ON CONFLICT (kind, id) DO UPDATE SET at = max(at, excluded.at),
					keep_until = max(keep_until, excluded.keep_until)`,
				)
				.run({
					kind: "grantId" in selector ? "grant" : "address",
					id: "grantId" in selector ? selector.grantId : selector.addressId,
					at: options.now,
					until: options.keepUntil,
				});
			return this.#delete(selector);
		})();
	}

	#delete(selector: RevokeSelector): number {
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
		this.#db
			.query("DELETE FROM revocations WHERE keep_until <= $now")
			.run({ now });
		this.#db.query("DELETE FROM nonces WHERE expires_at <= $now").run({ now });
		return this.#db
			.query("DELETE FROM tokens WHERE expires_at <= $now")
			.run({ now }).changes;
	}

	/** One statement: inserted, or an expired entry replaced; a live one stays. */
	async claimNonce(
		key: string,
		expiresAt: number,
		now: number,
	): Promise<boolean> {
		const result = this.#db
			.query(
				`INSERT INTO nonces (key, expires_at) VALUES ($key, $expires_at)
				ON CONFLICT (key) DO UPDATE SET expires_at = excluded.expires_at
				WHERE nonces.expires_at <= $now`,
			)
			.run({ key, expires_at: expiresAt, now });
		return result.changes === 1;
	}

	async close(): Promise<void> {
		this.#db.close();
	}
}
