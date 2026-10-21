# Token store

The relay keeps grants (connected AI apps) and the hashes of their access and refresh
tokens in a token store. Two stores are built in:

| Store | Setting | Keeps data across restarts |
|---|---|---|
| `SqliteTokenStore` | `TAB_MCP_STORE=sqlite` (default), file `TAB_MCP_SQLITE_PATH` | yes |
| `MemoryTokenStore` | `TAB_MCP_STORE=memory` | no |

If you embed the relay in your own Bun program, you can pass any object that implements
the `TokenStore` interface, for example one backed by Redis, PostgreSQL or Prisma. This
page describes the interface, the guarantees a store must give, and how to check a store
with the conformance suite.

A shared store does not let you run several relays for one address. Tab sessions live in
the relay's memory, so each public address needs exactly one relay process.

## Using your own store

```ts
import { createRelay } from "@ractive-ch/tab-mcp";
import { RedisClient } from "bun";
import { RedisTokenStore } from "./redis-token-store.ts";

const relay = createRelay({
  publicUrl: "https://relay.example.com",
  allowedOrigins: ["https://app.example.com"],
  store: new RedisTokenStore(new RedisClient(process.env.REDIS_URL)),
});
```

`createRelay` takes the same settings as the [environment variables](configuration.md),
in milliseconds and bytes. `store` is either a `TokenStore` object or the name of a
built-in store (`"sqlite"` or `"memory"`). The relay does not call `close()` on a store
you pass in; close it yourself after `relay.stop()`.

## The interface

```ts
type TokenKind = "access" | "refresh";

interface TokenRecord {
  hash: string;           // SHA-256 of the token, base64url without padding
  kind: TokenKind;
  grantId: string;
  addressId: string;      // the address the grant belongs to
  clientId: string;       // the AI app's client id (its metadata document URL)
  clientName: string;     // the AI app's declared name, for display only
  scopes: string[];
  grantCreatedAt: number; // when the grant was created
  issuedAt: number;
  expiresAt: number;
  usedAt?: number;        // refresh tokens: when it was exchanged
  subject?: string;       // identity binding: hash of the person the grant was made for
}

interface GrantSummary {
  grantId: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  createdAt: number;
  subject?: string;       // the grant's subject, if it has one
}

type RevokeSelector = { grantId: string } | { addressId: string };
```

`subject` is set only on grants made by identity binding. Store it and return it
unchanged (and leave the key out when it was not set). A store that drops it does not
break anything open: the relay then refuses every request of such a grant as a
mismatch. The conformance suite checks the round trip.

```ts
interface RevokeOptions {
  now: number;
  keepUntil: number;      // keep the tombstone at least until then
}

interface TokenStore {
  put(record: TokenRecord): Promise<boolean>;
  get(hash: string): Promise<TokenRecord | undefined>;
  markUsed(hash: string, now: number): Promise<boolean>;
  revoke(selector: RevokeSelector, options: RevokeOptions): Promise<number>;
  listGrants(addressId: string, now: number): Promise<GrantSummary[]>;
  deleteExpired(now: number): Promise<number>;
  close?(): Promise<void>;
}
```

`TokenStore`, `TokenRecord`, `GrantSummary`, `RevokeSelector`, `RevokeOptions` and
`TokenKind` are exported as types from `@ractive-ch/tab-mcp`. All times are milliseconds since the Unix
epoch.

| Method | What it must do |
|---|---|
| `put` | Insert the record, or replace the record with the same `hash`. Return `false` and store nothing if the grant was revoked (see tombstones below). |
| `get` | Return the record for a hash, also when it is expired or used: the relay decides what that means. Return `undefined` once `revoke` or `deleteExpired` removed it. Changing the returned object must not change the store. |
| `markUsed` | Set `usedAt` to `now` if it is not set yet. Return `true` only for the call that set it; `false` if it was already used or does not exist. |
| `revoke` | Delete every token of the grant or of the address, leave a tombstone until `keepUntil`, and return how many tokens were deleted. |
| `listGrants` | The grants of an address that still have a usable token at `now` (an unexpired access token, or an unexpired and unused refresh token), oldest grant first. The page uses it to list connected apps. |
| `deleteExpired` | Delete every record with `expiresAt <= now` and every tombstone whose `keepUntil` has passed. Return how many records were deleted. The relay calls it every 10 minutes. |
| `close` | Optional: release connections or file handles. |

## Guarantees

Every store must give these guarantees. The relay's security depends on them.

- **Hashes only.** Records are keyed by `hash`, the SHA-256 of the token. The plain token
  never reaches the store, so a copy of the store contains no usable token. Do not add a
  field that stores it.
- **`markUsed` is atomic.** For one hash, exactly one call ever returns `true`, even when
  several run at the same time, in several processes. Refresh-token rotation relies on
  this: of two refreshes with the same token, one wins and the other counts as reuse,
  which revokes the grant. Use a conditional update ("set `usedAt` where it is null") or
  a script, never a read followed by a write.
- **Revocation is final.** `revoke` leaves a tombstone at least until `keepUntil`. Until
  then `put` refuses a record of a revoked grant, and a record of a grant of a revoked
  address if the grant was created at or before the revocation (`grantCreatedAt <=` the
  revocation's `now`). Checking the tombstone and inserting must be atomic, so tokens
  minted by a refresh that raced a Disconnect never outlive it. The relay sets
  `keepUntil` to the grant lifetime (90 days by default), the longest any earlier token
  could live.
- **No shared objects.** `get` and `listGrants` return copies.

If the store throws, MCP requests that need it fail with HTTP 503 and JSON-RPC error
`-31008`, with `Retry-After`, so AI apps keep their tokens and try again.

## Running the conformance suite

The package exports a test suite for `bun test` as `@ractive-ch/tab-mcp/testing`. It
checks every rule above, including concurrent `markUsed` calls and a `put` racing a
`revoke`. Call it with a name and a factory that returns a fresh, empty store:

```ts
// redis-token-store.test.ts
import { tokenStoreConformance } from "@ractive-ch/tab-mcp/testing";
import { RedisClient } from "bun";
import { RedisTokenStore } from "./redis-token-store.ts";

const redis = new RedisClient(process.env.REDIS_URL ?? "redis://localhost:6379");

tokenStoreConformance("RedisTokenStore", () =>
  new RedisTokenStore(redis, `test:${crypto.randomUUID()}:`),
);
```

```sh
bun add --dev @ractive-ch/tab-mcp
bun test redis-token-store.test.ts
```

The suite calls `close()` after each test if the store has it. Give every store from the
factory its own empty space (a key prefix, a schema or a fresh database), because the
tests expect to start empty.

## Sketch: a Redis store

This store uses Bun's built-in Redis client. Every write runs as one Lua script, which
Redis executes atomically, so the guarantees hold across processes. It passed the
conformance suite with Redis 7.0 when it was written; the store interface has not changed
since. It is a starting point, not
a supported package: it assumes a single Redis node (the scripts touch keys they do not
declare, which Redis Cluster does not allow), and `listGrants` reads tokens one by one.

```ts
// redis-token-store.ts
import type {
	GrantSummary,
	RevokeOptions,
	RevokeSelector,
	TokenRecord,
	TokenStore,
} from "@ractive-ch/tab-mcp";
import { RedisClient } from "bun";

// Keys, under a prefix:
//   tok:<hash>      the record as JSON
//   grant:<id>      set of token hashes of a grant
//   addr:<id>       set of token hashes of an address
//   exp             sorted set: token hash by expiresAt
//   rev:grant:<id>  tombstone of a grant: keepUntil
//   rev:addr:<id>   tombstone of an address: JSON {at, until}
//   revs            sorted set: tombstone key by keepUntil
// Each write runs as one Lua script, so it is atomic.

const DROP = `
local function drop(p, hash)
  local raw = redis.call('GET', p .. 'tok:' .. hash)
  if not raw then return 0 end
  local r = cjson.decode(raw)
  redis.call('DEL', p .. 'tok:' .. hash)
  redis.call('SREM', p .. 'grant:' .. r.grantId, hash)
  redis.call('SREM', p .. 'addr:' .. r.addressId, hash)
  redis.call('ZREM', p .. 'exp', hash)
  return 1
end
`;

const PUT = `${DROP}
local p, json = ARGV[1], ARGV[2]
local r = cjson.decode(json)
if redis.call('EXISTS', p .. 'rev:grant:' .. r.grantId) == 1 then return 0 end
local addr = redis.call('GET', p .. 'rev:addr:' .. r.addressId)
if addr and cjson.decode(addr).at >= r.grantCreatedAt then return 0 end
drop(p, r.hash)
redis.call('SET', p .. 'tok:' .. r.hash, json)
redis.call('SADD', p .. 'grant:' .. r.grantId, r.hash)
redis.call('SADD', p .. 'addr:' .. r.addressId, r.hash)
redis.call('ZADD', p .. 'exp', r.expiresAt, r.hash)
return 1`;

const MARK_USED = `
local key = ARGV[1] .. 'tok:' .. ARGV[2]
local raw = redis.call('GET', key)
if not raw then return 0 end
local r = cjson.decode(raw)
if r.usedAt then return 0 end
-- Patch the JSON text instead of re-encoding it: cjson would turn an
-- empty scopes array into an object.
redis.call('SET', key, string.sub(raw, 1, -2) .. ',"usedAt":' .. ARGV[3] .. '}')
return 1`;

const REVOKE = `${DROP}
local p, kind, id = ARGV[1], ARGV[2], ARGV[3]
local now, keep = tonumber(ARGV[4]), tonumber(ARGV[5])
local tomb
if kind == 'grant' then
  tomb = p .. 'rev:grant:' .. id
  local old = tonumber(redis.call('GET', tomb) or '0')
  keep = math.max(old, keep)
  redis.call('SET', tomb, keep)
else
  tomb = p .. 'rev:addr:' .. id
  local old = redis.call('GET', tomb)
  if old then
    local o = cjson.decode(old)
    now, keep = math.max(o.at, now), math.max(o['until'], keep)
  end
  redis.call('SET', tomb, string.format('{"at":%d,"until":%d}', now, keep))
end
redis.call('ZADD', p .. 'revs', keep, tomb)
local n = 0
for _, hash in ipairs(redis.call('SMEMBERS', p .. kind .. ':' .. id)) do
  n = n + drop(p, hash)
end
return n`;

const DELETE_EXPIRED = `${DROP}
local p, now = ARGV[1], ARGV[2]
local n = 0
for _, hash in ipairs(redis.call('ZRANGEBYSCORE', p .. 'exp', '-inf', now)) do
  n = n + drop(p, hash)
end
for _, tomb in ipairs(redis.call('ZRANGEBYSCORE', p .. 'revs', '-inf', now)) do
  redis.call('DEL', tomb)
  redis.call('ZREM', p .. 'revs', tomb)
end
return n`;

export class RedisTokenStore implements TokenStore {
	constructor(
		private readonly redis: RedisClient,
		private readonly prefix = "tab-mcp:",
	) {}

	#eval(script: string, ...args: (string | number)[]): Promise<number> {
		return this.redis.send("EVAL", [
			script,
			"0",
			this.prefix,
			...args.map(String),
		]);
	}

	async put(record: TokenRecord): Promise<boolean> {
		return (await this.#eval(PUT, JSON.stringify(record))) === 1;
	}

	async get(hash: string): Promise<TokenRecord | undefined> {
		const raw = await this.redis.get(`${this.prefix}tok:${hash}`);
		return raw === null ? undefined : JSON.parse(raw);
	}

	async markUsed(hash: string, now: number): Promise<boolean> {
		return (await this.#eval(MARK_USED, hash, now)) === 1;
	}

	async revoke(
		selector: RevokeSelector,
		options: RevokeOptions,
	): Promise<number> {
		const [kind, id] =
			"grantId" in selector
				? ["grant", selector.grantId]
				: ["addr", selector.addressId];
		return this.#eval(REVOKE, kind, id, options.now, options.keepUntil);
	}

	async listGrants(addressId: string, now: number): Promise<GrantSummary[]> {
		const hashes = await this.redis.smembers(`${this.prefix}addr:${addressId}`);
		const grants = new Map<string, GrantSummary>();
		for (const hash of hashes) {
			const r = await this.get(hash);
			const live =
				r !== undefined &&
				r.expiresAt > now &&
				(r.kind === "access" || r.usedAt === undefined);
			if (!live || grants.has(r.grantId)) continue;
			grants.set(r.grantId, {
				grantId: r.grantId,
				clientId: r.clientId,
				clientName: r.clientName,
				scopes: r.scopes,
				createdAt: r.grantCreatedAt,
				...(r.subject === undefined ? {} : { subject: r.subject }),
			});
		}
		return [...grants.values()].sort(
			(a, b) => a.createdAt - b.createdAt || a.grantId.localeCompare(b.grantId),
		);
	}

	async deleteExpired(now: number): Promise<number> {
		return this.#eval(DELETE_EXPIRED, now);
	}

	async close(): Promise<void> {}
}
```

## Sketch: SQL and Prisma

A relational store needs two tables:

- `tokens`: one row per record, primary key `hash`, indexes on `grant_id`, `address_id`
  and `expires_at`;
- `revocations`: tombstones with `kind` (`grant` or `address`), `id`, `at` and
  `keep_until`, primary key (`kind`, `id`).

Map the methods like this:

- `put`: in one transaction, look for a tombstone of the grant, or of the address with
  `at >= grantCreatedAt`. If there is one, return `false`; else insert or replace the
  row. Use a transaction level that keeps a concurrent `revoke` from slipping in between
  (SQLite's write lock does it; in PostgreSQL use `SERIALIZABLE`, or lock the
  tombstone row).
- `markUsed`: `UPDATE tokens SET used_at = $now WHERE hash = $hash AND used_at IS NULL`,
  and return whether one row changed. With Prisma, `updateMany` with
  `where: { hash, usedAt: null }` and check that `count` is 1.
- `revoke`: in one transaction, upsert the tombstone (keep the later `at` and
  `keep_until`) and delete the matching tokens.
- `deleteExpired`: delete tokens with `expires_at <= now` and tombstones with
  `keep_until <= now`.

The built-in `SqliteTokenStore` in the
[relay's source](../packages/tab-mcp/src/store/sqlite.ts) follows exactly this plan and
is a complete example. Run the conformance suite against your store before you use it.
