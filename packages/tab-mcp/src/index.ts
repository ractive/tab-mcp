/**
 * `@ractive-ch/tab-mcp`: the relay that lets AI apps call MCP tools offered by
 * a web page open in a browser tab.
 */

export { addressIdFromSecret, newSecret } from "./address.ts";
export {
	ConfigError,
	configFromEnv,
	DEFAULT_CONFIG,
	type LogLevel,
	type OidcConfig,
	type PairingKind,
	type RelayConfig,
	resolveConfig,
	type StoreKind,
	type SubjectClaim,
	type TrustProxy,
} from "./config.ts";
export { TAB_ASSERTION_TYP } from "./identity.ts";
export { createLogger, type LogFields, type Logger } from "./log.ts";
export { SUBPROTOCOL } from "./protocol.ts";
export {
	type CreateRelayOptions,
	createRelay,
	type Relay,
	VERSION,
} from "./relay.ts";
export { MemoryTokenStore } from "./store/memory.ts";
export { SqliteTokenStore } from "./store/sqlite.ts";
export type {
	GrantSummary,
	RevokeOptions,
	RevokeSelector,
	TokenKind,
	TokenRecord,
	TokenStore,
} from "./store/types.ts";
