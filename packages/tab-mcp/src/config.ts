/**
 * Relay configuration: defaults (DEC-034), validation, and reading `TAB_MCP_*`
 * environment variables. The table lives in `kb/design/architecture.md`.
 */

export type TrustProxy = "none" | "x-real-ip" | "x-forwarded-for";
export type LogLevel = "error" | "warn" | "info" | "debug";
export type StoreKind = "sqlite" | "memory";

/**
 * How a browser at `/authorize` proves it belongs to the tab's user (DEC-042):
 * the 6-digit code shown in the tab (DEC-028), or, later, identity binding.
 */
export type PairingKind = "code" | "oidc";

/** The limits a site may set for its own tab sessions (DEC-045). */
export interface SiteLimits {
	maxMessageBytes: number;
	maxConcurrentRequests: number;
	requestTimeoutMs: number;
	keepAliveMs: number;
	idleTimeoutMs: number;
	sessionLifetimeMs: number;
	heartbeatMs: number;
}

/** One site (page origin) the relay serves, as configured (DEC-045). */
export interface SiteConfig {
	/** The page origin, e.g. `https://ractive.ch`. */
	origin: string;
	/** The app name `/authorize` shows; wins over the name the page sends. */
	name?: string;
	/** Pairing method; `code` (the default) is the only one so far. */
	pairing?: PairingKind;
	/** Overrides of the instance-wide limits for this site's sessions. */
	limits?: Partial<SiteLimits>;
}

/** A site with everything filled in. */
export interface Site {
	/** The origin, or `*` for the open relay's default site. */
	origin: string;
	name?: string;
	pairing: PairingKind;
	limits: SiteLimits;
}

/**
 * The smallest `maxMessageBytes` the relay accepts: MCP requests need room,
 * and the browser library refuses a session that cannot frame a response
 * chunk (below 896 bytes).
 */
export const MIN_MESSAGE_BYTES = 16_384;

/** Longest app name (configured or sent by the page). */
export const MAX_APP_NAME = 64;

export interface RelayConfig {
	/** External origin, e.g. `https://relay.ractive.ch`. Optional only in development. */
	publicUrl?: string;
	port: number;
	host: string;
	/**
	 * Page origins allowed to open tab sessions with the instance-wide limits;
	 * `"*"` admits any (open relay). Shorthand for `sites` without overrides.
	 */
	allowedOrigins: string[] | "*";
	/** Sites with their own name, pairing method or limits (DEC-045). */
	sites: SiteConfig[];
	/** Hosts whose Client ID Metadata Documents are accepted; empty = any. */
	clientIdHosts: string[];
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
	/** Deadline for receiving an MCP request body (Bun's idle timer does not cover it). */
	bodyTimeoutMs: number;
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
	sites: [],
	clientIdHosts: [],
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
	bodyTimeoutMs: 10_000,
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
	config.sites = config.sites.map((site) => validateSite(site));
	const seen = new Set(
		config.allowedOrigins === "*" ? [] : config.allowedOrigins,
	);
	for (const site of config.sites) {
		if (seen.has(site.origin)) {
			throw new ConfigError(`origin configured twice: ${site.origin}`);
		}
		seen.add(site.origin);
	}
	config.clientIdHosts = config.clientIdHosts.map((h) => {
		const host = h.trim().toLowerCase();
		if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) {
			throw new ConfigError(`not a host name: ${h}`);
		}
		return host;
	});

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
		"bodyTimeoutMs",
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
	if (config.maxMessageBytes < MIN_MESSAGE_BYTES) {
		throw new ConfigError(
			`maxMessageBytes must be at least ${MIN_MESSAGE_BYTES} (16 KiB)`,
		);
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

const SITE_KEYS = new Set(["origin", "name", "pairing", "limits"]);
const LIMIT_KEYS: readonly (keyof SiteLimits)[] = [
	"maxMessageBytes",
	"maxConcurrentRequests",
	"requestTimeoutMs",
	"keepAliveMs",
	"idleTimeoutMs",
	"sessionLifetimeMs",
	"heartbeatMs",
];

/** An app name: 1-64 characters, no control characters. */
export function isAppName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= MAX_APP_NAME &&
		![...value].some((ch) => {
			const c = ch.codePointAt(0) ?? 0;
			return c < 0x20 || (c >= 0x7f && c <= 0x9f);
		})
	);
}

function validateSite(input: unknown): SiteConfig {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new ConfigError("a site must be an object with an origin");
	}
	const site = input as Record<string, unknown>;
	for (const key of Object.keys(site)) {
		if (!SITE_KEYS.has(key)) throw new ConfigError(`unknown site key: ${key}`);
	}
	if (typeof site["origin"] !== "string") {
		throw new ConfigError("a site needs an origin");
	}
	const out: SiteConfig = { origin: normalizeOrigin(site["origin"]) };
	if (site["name"] !== undefined) {
		if (!isAppName(site["name"])) {
			throw new ConfigError(
				`site name must be 1-${MAX_APP_NAME} characters: ${out.origin}`,
			);
		}
		out.name = site["name"];
	}
	const pairing = site["pairing"];
	if (pairing !== undefined && pairing !== "code") {
		if (pairing === "oidc") {
			throw new ConfigError(
				`pairing "oidc" (identity binding) is planned but not available yet: ${out.origin}`,
			);
		}
		throw new ConfigError(`pairing must be "code": ${out.origin}`);
	}
	out.pairing = "code";
	const limits = site["limits"];
	if (limits !== undefined) {
		if (typeof limits !== "object" || limits === null) {
			throw new ConfigError(`site limits must be an object: ${out.origin}`);
		}
		const given = limits as Record<string, unknown>;
		const parsed: Partial<SiteLimits> = {};
		for (const [key, value] of Object.entries(given)) {
			if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
				throw new ConfigError(`unknown site limit: ${key}`);
			}
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
				throw new ConfigError(`site limit ${key} must be a positive number`);
			}
			parsed[key as keyof SiteLimits] = value;
		}
		if (
			parsed.maxMessageBytes !== undefined &&
			parsed.maxMessageBytes < MIN_MESSAGE_BYTES
		) {
			throw new ConfigError(
				`site limit maxMessageBytes must be at least ${MIN_MESSAGE_BYTES}`,
			);
		}
		out.limits = parsed;
	}
	return out;
}

/** The instance-wide limits, the defaults of every site. */
export function defaultLimits(config: RelayConfig): SiteLimits {
	return {
		maxMessageBytes: config.maxMessageBytes,
		maxConcurrentRequests: config.maxConcurrentRequests,
		requestTimeoutMs: config.requestTimeoutMs,
		keepAliveMs: config.keepAliveMs,
		idleTimeoutMs: config.idleTimeoutMs,
		sessionLifetimeMs: config.sessionLifetimeMs,
		heartbeatMs: config.heartbeatMs,
	};
}

/**
 * The site for a page origin, or `undefined` if the relay does not serve it.
 * Configured sites win; `allowedOrigins` origins and, on an open relay, any
 * other origin get the instance-wide defaults.
 */
export function siteFor(
	config: RelayConfig,
	origin: string | null,
): Site | undefined {
	const defaults = defaultLimits(config);
	const configured =
		origin === null ? undefined : config.sites.find((s) => s.origin === origin);
	if (configured !== undefined) {
		const site: Site = {
			origin: configured.origin,
			pairing: configured.pairing ?? "code",
			limits: { ...defaults, ...configured.limits },
		};
		if (configured.name !== undefined) site.name = configured.name;
		return site;
	}
	if (
		config.allowedOrigins === "*" ||
		(origin !== null && config.allowedOrigins.includes(origin))
	) {
		return {
			origin: config.allowedOrigins === "*" ? "*" : (origin ?? ""),
			pairing: "code",
			limits: defaults,
		};
	}
	return undefined;
}

/** The largest message limit of any site (Bun's server-wide limits). */
export function largestMessageBytes(config: RelayConfig): number {
	return Math.max(
		config.maxMessageBytes,
		...config.sites.map((s) => s.limits?.maxMessageBytes ?? 0),
	);
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

	const sites = env["TAB_MCP_SITES"];
	if (sites !== undefined && sites.trim() !== "") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(sites);
		} catch {
			throw new ConfigError("TAB_MCP_SITES must be a JSON array of sites");
		}
		if (!Array.isArray(parsed)) {
			throw new ConfigError("TAB_MCP_SITES must be a JSON array of sites");
		}
		out.sites = parsed as SiteConfig[];
	}
	const hosts = env["TAB_MCP_CLIENT_ID_HOSTS"];
	if (hosts !== undefined && hosts.trim() !== "") {
		out.clientIdHosts = hosts
			.split(",")
			.map((h) => h.trim())
			.filter((h) => h !== "");
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
	set("bodyTimeoutMs", seconds(env, "TAB_MCP_BODY_TIMEOUT_S"));
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
