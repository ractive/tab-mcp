/**
 * Relay configuration: defaults (DEC-034), validation, and reading `TAB_MCP_*`
 * environment variables. The table lives in `kb/design/architecture.md`.
 */

export type TrustProxy = "none" | "x-real-ip" | "x-forwarded-for";
export type LogLevel = "error" | "warn" | "info" | "debug";
export type StoreKind = "sqlite" | "memory";

export interface RelayConfig {
	/** External origin, e.g. `https://relay.ractive.ch`. Optional only in development. */
	publicUrl?: string;
	port: number;
	host: string;
	/** Page origins allowed to open tab sessions; `"*"` admits any (open relay). */
	allowedOrigins: string[] | "*";
	trustProxy: TrustProxy;
	/** CORS without credentials on the MCP endpoint (DEC-036). */
	cors: boolean;
	store: StoreKind;
	sqlitePath: string;
	maxSessions: number;
	maxSessionsPerIp: number;
	maxConcurrentRequests: number;
	requestTimeoutMs: number;
	keepAliveMs: number;
	idleTimeoutMs: number;
	sessionLifetimeMs: number;
	heartbeatMs: number;
	helloTimeoutMs: number;
	/** Limit for MCP request bodies and for messages from the tab. */
	maxMessageBytes: number;
	accessTokenTtlMs: number;
	refreshTokenTtlMs: number;
	/** How often expired tokens are deleted from the store. */
	sweepIntervalMs: number;
	/** Per-socket WebSocket send buffer; beyond it sends are dropped (DEC-021). */
	backpressureLimitBytes: number;
	/** Bun's HTTP idle timeout in seconds; MCP requests switch it off per request. */
	httpIdleTimeoutS: number;
	logLevel: LogLevel;
	/** Allows `http:` public URLs and a derived public URL. */
	development: boolean;
}

export const DEFAULT_CONFIG: Readonly<RelayConfig> = {
	port: 8080,
	host: "0.0.0.0",
	allowedOrigins: [],
	trustProxy: "none",
	cors: true,
	store: "sqlite",
	sqlitePath: "tab-mcp.db",
	maxSessions: 500,
	maxSessionsPerIp: 5,
	maxConcurrentRequests: 8,
	requestTimeoutMs: 300_000,
	keepAliveMs: 20_000,
	idleTimeoutMs: 3_600_000,
	sessionLifetimeMs: 43_200_000,
	heartbeatMs: 25_000,
	helloTimeoutMs: 10_000,
	maxMessageBytes: 1_048_576,
	accessTokenTtlMs: 3_600_000,
	refreshTokenTtlMs: 2_592_000_000,
	sweepIntervalMs: 600_000,
	backpressureLimitBytes: 4 * 1_048_576,
	httpIdleTimeoutS: 30,
	logLevel: "info",
	development: false,
};

export class ConfigError extends Error {
	override name = "ConfigError";
}

/** Normalise an origin (`scheme://host[:port]`), or throw. */
export function normalizeOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigError(`not an origin: ${value}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new ConfigError(`origin must be http or https: ${value}`);
	}
	if (
		(url.pathname !== "/" && url.pathname !== "") ||
		url.search !== "" ||
		url.hash !== "" ||
		url.username !== "" ||
		url.password !== ""
	) {
		throw new ConfigError(
			`an origin has no path, query or credentials (browsers send only the origin): ${value}`,
		);
	}
	return url.origin;
}

/** Fill in defaults and validate. Throws `ConfigError` on bad values. */
export function resolveConfig(input: Partial<RelayConfig> = {}): RelayConfig {
	const config: RelayConfig = { ...DEFAULT_CONFIG, ...input };

	if (config.publicUrl !== undefined) {
		const origin = normalizeOrigin(config.publicUrl);
		if (!origin.startsWith("https:") && !config.development) {
			throw new ConfigError(
				"TAB_MCP_PUBLIC_URL must be https outside development",
			);
		}
		config.publicUrl = origin;
	} else if (!config.development) {
		throw new ConfigError("TAB_MCP_PUBLIC_URL is required");
	}

	if (config.allowedOrigins !== "*") {
		config.allowedOrigins = config.allowedOrigins.map(normalizeOrigin);
	}

	const positive: (keyof RelayConfig)[] = [
		"maxSessions",
		"maxSessionsPerIp",
		"maxConcurrentRequests",
		"requestTimeoutMs",
		"keepAliveMs",
		"idleTimeoutMs",
		"sessionLifetimeMs",
		"heartbeatMs",
		"helloTimeoutMs",
		"maxMessageBytes",
		"accessTokenTtlMs",
		"refreshTokenTtlMs",
		"sweepIntervalMs",
		"backpressureLimitBytes",
		"httpIdleTimeoutS",
	];
	for (const key of positive) {
		const v = config[key];
		if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
			throw new ConfigError(`${key} must be a positive number`);
		}
	}
	if (config.httpIdleTimeoutS > 255) {
		throw new ConfigError("httpIdleTimeoutS must be at most 255");
	}
	if (
		!Number.isInteger(config.port) ||
		config.port < 0 ||
		config.port > 65535
	) {
		throw new ConfigError("port must be 0-65535");
	}
	return config;
}

type Env = Record<string, string | undefined>;

function seconds(env: Env, name: string): number | undefined {
	const raw = env[name];
	if (raw === undefined || raw === "") return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw new ConfigError(`${name} must be a positive number of seconds`);
	}
	return Math.round(n * 1000);
}

function integer(env: Env, name: string): number | undefined {
	const raw = env[name];
	if (raw === undefined || raw === "") return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		throw new ConfigError(`${name} must be a whole number`);
	}
	return n;
}

function oneOf<T extends string>(
	env: Env,
	name: string,
	values: readonly T[],
): T | undefined {
	const raw = env[name];
	if (raw === undefined || raw === "") return undefined;
	if (!(values as readonly string[]).includes(raw)) {
		throw new ConfigError(`${name} must be one of ${values.join(", ")}`);
	}
	return raw as T;
}

/** Read `TAB_MCP_*` variables (and `NODE_ENV`) into a partial config. */
export function configFromEnv(env: Env): Partial<RelayConfig> {
	const out: Partial<RelayConfig> = {};
	const set = <K extends keyof RelayConfig>(
		key: K,
		value: RelayConfig[K] | undefined,
	) => {
		if (value !== undefined) out[key] = value;
	};

	set("development", env["NODE_ENV"] === "development" ? true : undefined);
	const publicUrl = env["TAB_MCP_PUBLIC_URL"];
	if (publicUrl !== undefined && publicUrl !== "") out.publicUrl = publicUrl;
	set("port", integer(env, "TAB_MCP_PORT"));
	const host = env["TAB_MCP_HOST"];
	if (host !== undefined && host !== "") out.host = host;

	const origins = env["TAB_MCP_ALLOWED_ORIGINS"];
	if (origins !== undefined) {
		const trimmed = origins.trim();
		out.allowedOrigins =
			trimmed === "*"
				? "*"
				: trimmed
						.split(",")
						.map((s) => s.trim())
						.filter((s) => s !== "");
	}

	set(
		"trustProxy",
		oneOf(env, "TAB_MCP_TRUST_PROXY", [
			"none",
			"x-real-ip",
			"x-forwarded-for",
		] as const),
	);
	const cors = oneOf(env, "TAB_MCP_CORS", ["on", "off"] as const);
	if (cors !== undefined) out.cors = cors === "on";
	set("store", oneOf(env, "TAB_MCP_STORE", ["sqlite", "memory"] as const));
	const sqlitePath = env["TAB_MCP_SQLITE_PATH"];
	if (sqlitePath !== undefined && sqlitePath !== "")
		out.sqlitePath = sqlitePath;

	set("maxSessions", integer(env, "TAB_MCP_MAX_SESSIONS"));
	set("maxSessionsPerIp", integer(env, "TAB_MCP_MAX_SESSIONS_PER_IP"));
	set("maxConcurrentRequests", integer(env, "TAB_MCP_MAX_CONCURRENT_REQUESTS"));
	set("requestTimeoutMs", seconds(env, "TAB_MCP_REQUEST_TIMEOUT_S"));
	set("keepAliveMs", seconds(env, "TAB_MCP_KEEPALIVE_S"));
	set("idleTimeoutMs", seconds(env, "TAB_MCP_IDLE_TIMEOUT_S"));
	set("sessionLifetimeMs", seconds(env, "TAB_MCP_SESSION_LIFETIME_S"));
	set("heartbeatMs", seconds(env, "TAB_MCP_HEARTBEAT_S"));
	set("maxMessageBytes", integer(env, "TAB_MCP_MAX_MESSAGE_BYTES"));
	set("accessTokenTtlMs", seconds(env, "TAB_MCP_ACCESS_TOKEN_TTL_S"));
	set("refreshTokenTtlMs", seconds(env, "TAB_MCP_REFRESH_TOKEN_TTL_S"));
	set(
		"logLevel",
		oneOf(env, "TAB_MCP_LOG_LEVEL", [
			"error",
			"warn",
			"info",
			"debug",
		] as const),
	);
	return out;
}
