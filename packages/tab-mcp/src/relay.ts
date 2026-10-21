import type { Server, ServerWebSocket } from "bun";
import { version } from "../package.json" with { type: "json" };
import { addressIdFromSecret, isAddressId, shortAddress } from "./address.ts";
import {
	largestMessageBytes,
	type RelayConfig,
	resolveConfig,
	type Site,
	type StoreKind,
	siteFor,
} from "./config.ts";
import {
	type Exchange,
	RelayErrorCode,
	type RpcId,
	rpcErrorBody,
} from "./exchange.ts";
import { ipPrefixKey } from "./ip.ts";
import { createLogger, type Logger, truncateIp } from "./log.ts";
import { isRetryable, notOpenAnswer, type RelayInfo } from "./notopen.ts";
import {
	AuthorizationServer,
	type AuthorizationTestMode,
} from "./oauth/server.ts";
import {
	CloseCode,
	type GrantInfo,
	MCP_PROTOCOL_VERSION,
	PROTOCOL_VERSION_META_KEY,
	SUBPROTOCOL,
} from "./protocol.ts";
import { TabSession } from "./session.ts";
import { MemoryTokenStore } from "./store/memory.ts";
import { SqliteTokenStore } from "./store/sqlite.ts";
import type { TokenRecord, TokenStore } from "./store/types.ts";
import { hashToken } from "./tokens.ts";

export const VERSION: string = version;

const RELAY_INFO: RelayInfo = { name: "tab-mcp", version };

/** Settles the race between an exchange and its page going away. */
const RETRY = Symbol("retry");

/** The one mismatched header Claude sends today (claude-code #93290, DEC-033). */
const CLAUDE_MISMATCHED_HEADER = "2025-11-25";

/** Request headers forwarded to the tab (protocol: tunnelled MCP requests). */
const FORWARDED_HEADERS = new Set([
	"content-type",
	"accept",
	"mcp-method",
	"mcp-name",
	"traceparent",
	"tracestate",
]);

export interface CreateRelayOptions
	extends Omit<Partial<RelayConfig>, "store"> {
	/**
	 * The token store: a `TokenStore` instance (e.g. Prisma, Redis), or the name
	 * of a built-in one (`"sqlite"`, the default, at `sqlitePath`; `"memory"`).
	 */
	store?: StoreKind | TokenStore;
	/** Logger; defaults to JSON lines on stdout at `logLevel`. */
	logger?: Logger;
}

export interface Relay {
	/** The external origin (issuer and address base). */
	readonly url: string;
	/** The port the server listens on. */
	readonly port: number;
	readonly config: RelayConfig;
	/** The MCP address a page with this secret gets. */
	addressFor(secret: string): string;
	/** Number of connected tab sessions. */
	readonly sessionCount: number;
	/** Close all sessions (bye `shutdown`, close 4004) and stop the server. */
	stop(): Promise<void>;
}

interface WsData {
	ip: string;
	origin: string;
	site: Site;
	session?: TabSession;
}

/**
 * Test-only relaxations, never reachable from configuration or the package's
 * public API (`createTestRelay` is not exported from the package): CIMD
 * fetches from loopback test servers, shorter code lifetimes.
 */
export interface RelayTestHooks extends AuthorizationTestMode {
	pairingCodeTtlMs?: number;
}

interface Body {
	value: Record<string, unknown>;
	text: string;
}

function json(
	status: number,
	value: unknown,
	headers?: Record<string, string>,
): Response {
	const h = new Headers(headers);
	h.set("content-type", "application/json");
	return new Response(JSON.stringify(value), { status, headers: h });
}

function rpcError(
	status: number,
	rpcId: RpcId | undefined,
	code: number,
	message: string,
	headers: Record<string, string>,
	data?: unknown,
): Response {
	return new Response(rpcErrorBody(rpcId, code, message, data), {
		status,
		headers: { ...headers, "content-type": "application/json" },
	});
}

function rpcIdOf(body: Record<string, unknown>): RpcId | undefined {
	if (!("id" in body)) return undefined;
	const id = body["id"];
	return typeof id === "string" || typeof id === "number" ? id : null;
}

/** A loggable MCP method name (attacker-controlled input, so constrained). */
function methodForLog(body: Record<string, unknown>): string {
	const m = body["method"];
	return typeof m === "string" && /^[A-Za-z0-9_/.-]{1,64}$/.test(m) ? m : "?";
}

function metaVersion(body: Record<string, unknown>): unknown {
	const params = body["params"];
	if (typeof params !== "object" || params === null) return undefined;
	const meta = (params as Record<string, unknown>)["_meta"];
	if (typeof meta !== "object" || meta === null) return undefined;
	return (meta as Record<string, unknown>)[PROTOCOL_VERSION_META_KEY];
}

const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>tab-mcp relay</title></head>
<body><h1>tab-mcp relay</h1>
<p>This server relays AI apps' MCP requests to tools offered by web pages open in a browser tab.
It does not log request contents. Source and documentation:
<a href="https://github.com/ractive/tab-mcp">github.com/ractive/tab-mcp</a>.</p>
</body></html>`;

/** Start a relay. Returns once the server listens. */
export function createRelay(options: CreateRelayOptions = {}): Relay {
	return startRelay(options, undefined);
}

/**
 * A relay with test hooks. Only for this repository's tests: it refuses to
 * start outside development and logs a warning.
 */
export function createTestRelay(
	options: CreateRelayOptions,
	hooks: RelayTestHooks,
): Relay {
	if (options.development !== true) {
		throw new Error("test hooks need development: true");
	}
	return startRelay(options, hooks);
}

function startRelay(
	options: CreateRelayOptions,
	hooks: RelayTestHooks | undefined,
): Relay {
	const { store: storeOption, logger: givenLogger, ...partial } = options;
	const tokenStore = typeof storeOption === "object" ? storeOption : undefined;
	const config = resolveConfig(
		typeof storeOption === "string"
			? { ...partial, store: storeOption }
			: partial,
	);
	const logger = givenLogger ?? createLogger(config.logLevel);
	const ownsStore = tokenStore === undefined;
	const store: TokenStore =
		tokenStore ??
		(config.store === "sqlite"
			? new SqliteTokenStore(config.sqlitePath)
			: new MemoryTokenStore());

	const sessions = new Map<string, TabSession>();
	const allSessions = new Set<TabSession>();
	const perIp = new Map<string, number>();
	/** Requests waiting for their page, per address (DEC-074). */
	const waiters = new Map<string, Set<(s: TabSession | undefined) => void>>();
	let waitingCount = 0;
	/** The app name of each address's last session, for "open <name>". */
	const appNames = new Map<string, string>();
	let claudeWorkarounds = 0;
	let publicUrl = config.publicUrl ?? "";

	const corsHeaders: Record<string, string> = config.cors
		? {
				"access-control-allow-origin": "*",
				"access-control-expose-headers":
					"www-authenticate, mcp-protocol-version",
			}
		: {};

	/** Tombstones outlive every token issued before the revocation (DEC-063). */
	const revokeOptions = () => {
		const now = Date.now();
		return { now, keepUntil: now + config.grantLifetimeMs };
	};

	function grantRemoved(
		addressId: string,
		grantId: string,
		reason: "revoked" | "reuse_detected" | "expired",
	): void {
		const session = sessions.get(addressId);
		if (session?.ready)
			session.send({ type: "grant.removed", grantId, reason });
	}

	const host = {
		config,
		logger,
		store,
		...(hooks?.pairingCodeTtlMs === undefined
			? {}
			: { pairingCodeTtlMs: hooks.pairingCodeTtlMs }),
		publicUrl: () => publicUrl,
		async revokeGrant(session: TabSession, grantId: string): Promise<boolean> {
			const addressId = session.addressId;
			if (addressId === undefined) return false;
			const grants = await store.listGrants(addressId, Date.now());
			if (!grants.some((g) => g.grantId === grantId)) return false;
			await store.revoke({ grantId }, revokeOptions());
			logger.info("oauth.revoked", {
				address: shortAddress(addressId),
				by: "tab",
			});
			grantRemoved(addressId, grantId, "revoked");
			return true;
		},
		async revokeAll(session: TabSession): Promise<void> {
			const addressId = session.addressId;
			if (addressId === undefined) return;
			const grants = await store.listGrants(addressId, Date.now());
			await store.revoke({ addressId }, revokeOptions());
			logger.info("oauth.revoked_all", {
				address: shortAddress(addressId),
				grants: grants.length,
			});
			for (const g of grants) grantRemoved(addressId, g.grantId, "revoked");
		},
		claimAddress(session: TabSession): TabSession | undefined {
			const id = session.addressId;
			if (id === undefined) return undefined;
			const previous = sessions.get(id);
			sessions.set(id, session);
			return previous === session ? undefined : previous;
		},
		released(session: TabSession): void {
			allSessions.delete(session);
			if (
				session.addressId !== undefined &&
				sessions.get(session.addressId) === session
			) {
				sessions.delete(session.addressId);
			}
			releaseIp(session.ip);
		},
		ready(session: TabSession): void {
			const id = session.addressId;
			if (id === undefined) return;
			if (session.appName !== undefined) {
				appNames.delete(id);
				appNames.set(id, session.appName);
				// Bounded: forget the oldest names first.
				if (appNames.size > config.maxSessions * 2) {
					const oldest = appNames.keys().next().value;
					if (oldest !== undefined) appNames.delete(oldest);
				}
			}
			const waiting = waiters.get(id);
			if (waiting !== undefined) for (const wake of [...waiting]) wake(session);
		},
	};

	function readySession(addressId: string): TabSession | undefined {
		const s = sessions.get(addressId);
		return s?.ready === true ? s : undefined;
	}

	/**
	 * The page's ready session, waiting up to `waitMs` for it (DEC-074).
	 * `undefined` when it does not come in time or too many requests wait
	 * already; `"aborted"` when the AI app gave up.
	 */
	function waitForPage(
		addressId: string,
		signal: AbortSignal,
		waitMs: number,
	): Promise<TabSession | undefined | "aborted"> {
		const now = readySession(addressId);
		if (now !== undefined) return Promise.resolve(now);
		if (waitMs === 0 || stopping !== undefined) {
			return Promise.resolve(undefined);
		}
		const set = waiters.get(addressId) ?? new Set();
		// A waiting request holds its body and a socket like a forwarded one: at
		// most maxConcurrentRequests per address, maxSessions in all.
		if (
			set.size >= config.maxConcurrentRequests ||
			waitingCount >= config.maxSessions
		) {
			return Promise.resolve(undefined);
		}
		return new Promise((resolve) => {
			let timer: Timer | undefined;
			let settled = false;
			const done = (result: TabSession | undefined | "aborted") => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				set.delete(wake);
				waitingCount--;
				if (set.size === 0 && waiters.get(addressId) === set) {
					waiters.delete(addressId);
				}
				resolve(result);
			};
			const wake = (session: TabSession | undefined) => done(session);
			const onAbort = () => done("aborted");
			set.add(wake);
			waiters.set(addressId, set);
			waitingCount++;
			timer = setTimeout(() => done(undefined), waitMs);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
	}

	function releaseIp(ip: string): void {
		const n = (perIp.get(ip) ?? 1) - 1;
		if (n <= 0) perIp.delete(ip);
		else perIp.set(ip, n);
	}

	function clientIp(req: Request, server: Server<WsData>): string {
		if (config.trustProxy === "x-real-ip") {
			const v = req.headers.get("x-real-ip")?.trim();
			if (v) return v;
		} else if (config.trustProxy === "x-forwarded-for") {
			const parts = (req.headers.get("x-forwarded-for") ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s !== "");
			const last = parts.at(-1);
			if (last !== undefined) return last;
		}
		return server.requestIP(req)?.address ?? "unknown";
	}

	const auth = new AuthorizationServer(
		{
			config,
			logger,
			store,
			publicUrl: () => publicUrl,
			session: (addressId) => {
				const s = sessions.get(addressId);
				return s?.ready === true ? s : undefined;
			},
			grantAdded: (addressId: string, grant: GrantInfo) => {
				const session = sessions.get(addressId);
				if (session?.ready) session.send({ type: "grant.added", grant });
			},
			grantRemoved: (addressId, grantId, reason) =>
				grantRemoved(
					addressId,
					grantId,
					reason as "revoked" | "reuse_detected" | "expired",
				),
		},
		hooks,
	);
	if (hooks !== undefined) {
		logger.warn("relay.test_hooks", {
			message: "test hooks are on: never use this relay outside tests",
		});
	}

	function handleTab(
		req: Request,
		server: Server<WsData>,
	): Response | undefined {
		const origin = req.headers.get("origin");
		const site = siteFor(config, origin);
		if (site === undefined) {
			logger.info("tab.refused", { reason: "origin" });
			return json(403, { error: "origin_not_allowed" });
		}
		const offered = (req.headers.get("sec-websocket-protocol") ?? "")
			.split(",")
			.map((s) => s.trim());
		if (!offered.includes(SUBPROTOCOL)) {
			return json(426, {
				error: "unsupported_protocol",
				supported: [SUBPROTOCOL],
			});
		}
		const realIp = clientIp(req, server);
		// Counted per /64 for IPv6 (DEC-061): one subscriber owns a whole /64.
		const ip = ipPrefixKey(realIp);
		if (allSessions.size >= config.maxSessions) {
			logger.warn("tab.refused", { reason: "max_sessions" });
			return json(429, { error: "too_many_sessions" });
		}
		const count = perIp.get(ip) ?? 0;
		if (count >= config.maxSessionsPerIp) {
			logger.warn("tab.refused", {
				reason: "max_sessions_per_ip",
				ip: truncateIp(realIp),
			});
			return json(429, { error: "too_many_sessions" });
		}
		perIp.set(ip, count + 1);
		const ok = server.upgrade(req, {
			data: { ip, origin: origin ?? "", site },
			headers: { "Sec-WebSocket-Protocol": SUBPROTOCOL },
		});
		if (ok) return undefined;
		releaseIp(ip);
		return json(400, { error: "websocket_upgrade_expected" });
	}

	function wwwAuthenticate(id: string, presented: boolean): string {
		const metadata = `${publicUrl}/.well-known/oauth-protected-resource/a/${id}/mcp`;
		const error = presented ? ', error="invalid_token"' : "";
		return `Bearer resource_metadata="${metadata}", scope="tools"${error}`;
	}

	async function authenticate(
		req: Request,
		addressId: string,
	): Promise<TokenRecord | "missing" | "invalid" | "unavailable"> {
		const header = req.headers.get("authorization");
		if (header === null) return "missing";
		const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim());
		const token = match?.[1];
		if (token === undefined) return "invalid";
		let record: TokenRecord | undefined;
		try {
			record = await store.get(hashToken(token));
		} catch (error) {
			logger.error("store.error", {
				op: "get",
				message: error instanceof Error ? error.message : "unknown",
			});
			return "unavailable";
		}
		if (
			record === undefined ||
			record.kind !== "access" ||
			record.addressId !== addressId ||
			record.expiresAt <= Date.now() ||
			!record.scopes.includes("tools")
		) {
			return "invalid";
		}
		return record;
	}

	async function readBody(
		req: Request,
		maxBytes: number,
	): Promise<Body | Response> {
		const length = Number(req.headers.get("content-length") ?? "0");
		if (length > maxBytes) {
			return rpcError(
				413,
				undefined,
				-32600,
				"Request body too large.",
				corsHeaders,
			);
		}
		let bytes: ArrayBuffer;
		try {
			// Bun's idle timeout does not fire while a body is being read, so a
			// client that stalls mid-body would hold the socket; our own deadline
			// answers 408 and closes the connection.
			const reading = req.arrayBuffer();
			reading.catch(() => {}); // rejects once the socket is closed
			let timer: Timer | undefined;
			const deadline = new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), config.bodyTimeoutMs);
			});
			const result = await Promise.race([reading, deadline]);
			clearTimeout(timer);
			if (result === "timeout") {
				return rpcError(
					408,
					undefined,
					-32600,
					"The request body did not arrive in time.",
					{ ...corsHeaders, connection: "close" },
				);
			}
			bytes = result;
		} catch {
			return rpcError(
				400,
				undefined,
				-32700,
				"Could not read the request body.",
				corsHeaders,
			);
		}
		if (bytes.byteLength > maxBytes) {
			return rpcError(
				413,
				undefined,
				-32600,
				"Request body too large.",
				corsHeaders,
			);
		}
		let text: string;
		let value: unknown;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			value = JSON.parse(text);
		} catch {
			return rpcError(400, undefined, -32700, "Parse error.", corsHeaders);
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return rpcError(
				400,
				undefined,
				-32600,
				"The body must be one JSON-RPC message (no batches).",
				corsHeaders,
			);
		}
		return { value: value as Record<string, unknown>, text };
	}

	/** DEC-033 / DEC-040: the protocol-version pre-check. */
	function checkVersion(
		req: Request,
		body: Record<string, unknown>,
		rpcId: RpcId | undefined,
	): Response | { forwardVersion: string } {
		const header = req.headers.get("mcp-protocol-version");
		if (body["method"] === "initialize") {
			const params = body["params"] as Record<string, unknown> | undefined;
			const requested =
				typeof params?.["protocolVersion"] === "string"
					? params["protocolVersion"]
					: (header ?? null);
			return rpcError(
				400,
				rpcId,
				-32022,
				`Unsupported protocol version: ${String(requested)}. This server supports only ${MCP_PROTOCOL_VERSION}.`,
				corsHeaders,
				{ supported: [MCP_PROTOCOL_VERSION], requested },
			);
		}
		if (header === MCP_PROTOCOL_VERSION) return { forwardVersion: header };
		if (
			header === CLAUDE_MISMATCHED_HEADER &&
			metaVersion(body) === MCP_PROTOCOL_VERSION
		) {
			// Logged once per process; the running count is in /healthz.
			if (++claudeWorkarounds === 1) {
				logger.info("mcp.claude_header_workaround", {
					message:
						"accepting MCP-Protocol-Version 2025-11-25 with a 2026-07-28 body (claude-code #93290); counted in /healthz",
				});
			}
			return { forwardVersion: MCP_PROTOCOL_VERSION };
		}
		if (header === null) {
			return rpcError(
				400,
				rpcId,
				-32020,
				"Missing MCP-Protocol-Version header.",
				corsHeaders,
			);
		}
		return rpcError(
			400,
			rpcId,
			-32022,
			`Unsupported protocol version: ${header}. This server supports only ${MCP_PROTOCOL_VERSION}.`,
			corsHeaders,
			{ supported: [MCP_PROTOCOL_VERSION], requested: header },
		);
	}

	async function handleMcp(
		req: Request,
		server: Server<WsData>,
		addressId: string,
	): Promise<Response> {
		const started = Date.now();
		const logDone = (
			status: number,
			method: string,
			extra: Record<string, string | number> = {},
		) =>
			logger.info("mcp.request", {
				address: shortAddress(addressId),
				method,
				status,
				durationMs: Date.now() - started,
				...extra,
			});

		// The page's own limit when it is connected; else the instance's (the
		// request then ends with 401 or 503 anyway).
		const body = await readBody(
			req,
			sessions.get(addressId)?.limits.maxMessageBytes ?? config.maxMessageBytes,
		);
		if (body instanceof Response) {
			logDone(body.status, "?");
			return body;
		}
		const rpcId = rpcIdOf(body.value);
		const method = methodForLog(body.value);

		const version = checkVersion(req, body.value, rpcId);
		if (version instanceof Response) {
			logDone(version.status, method);
			return version;
		}

		const auth = await authenticate(req, addressId);
		if (auth === "unavailable") {
			// Not the token's fault: a 401 would make clients drop valid tokens.
			logDone(503, method, { reason: "store_unavailable" });
			return rpcError(
				503,
				rpcId,
				RelayErrorCode.storeUnavailable,
				"The relay cannot check tokens right now. Try again shortly.",
				{ ...corsHeaders, "retry-after": "5" },
			);
		}
		if (typeof auth === "string") {
			logDone(401, method);
			return json(
				401,
				{
					error: "invalid_token",
					error_description:
						auth === "missing"
							? "Authorization required."
							: "The access token is not valid.",
				},
				{
					...corsHeaders,
					"www-authenticate": wwwAuthenticate(addressId, auth === "invalid"),
				},
			);
		}

		const headers: Record<string, string> = {};
		for (const [k, v] of req.headers) {
			const key = k.toLowerCase();
			if (FORWARDED_HEADERS.has(key) || key.startsWith("mcp-param-"))
				headers[key] = v;
		}
		headers["mcp-protocol-version"] = version.forwardVersion;

		const clientHostName = (() => {
			try {
				return new URL(auth.clientId).host;
			} catch {
				return "";
			}
		})();
		const isListen = body.value["method"] === "subscriptions/listen";
		// `server/discover` does not wait: clients use it as the protocol-era
		// probe with a short timeout (Claude Code: 5 s, then it falls back to
		// the legacy handshake), and the stand-in answer has `ttlMs: 0`.
		const waitMs =
			body.value["method"] === "server/discover" ? 0 : config.pageWaitMs;
		const closed = () => {
			logDone(499, method, { outcome: "client_closed" });
			return new Response(null, { status: 499 });
		};

		// Only now, for an authenticated request, switch off Bun's idle timer:
		// our own timers (the page wait, the request timer) and keep-alives take
		// over (Bun research, finding 1). Body reading and every unauthenticated
		// path keep the idle timeout, so a stalled client cannot hold a socket.
		if (readySession(addressId) === undefined && waitMs > 0) {
			server.timeout(req, 0);
		}
		let retried = false;
		for (;;) {
			const found = await waitForPage(addressId, req.signal, waitMs);
			// The AI app may have gone while the body was read, the token checked
			// or the page awaited: then forward nothing (the abort event has
			// already fired and would not cancel the exchange, which would hold a
			// slot until the timeout).
			if (found === "aborted" || req.signal.aborted) return closed();
			if (found === undefined) {
				return pageNotOpen(body.value, rpcId, addressId, logDone, method);
			}
			const session = found;
			// The body was read with the instance's limit if the page was not
			// open yet; its site may allow less.
			if (Buffer.byteLength(body.text) > session.limits.maxMessageBytes) {
				logDone(413, method);
				return rpcError(
					413,
					rpcId,
					-32600,
					"Request body too large.",
					corsHeaders,
				);
			}
			if (session.pending.size >= session.limits.maxConcurrentRequests) {
				logDone(429, method);
				return rpcError(
					429,
					rpcId,
					RelayErrorCode.overloaded,
					"Too many requests at once for this page.",
					corsHeaders,
				);
			}
			server.timeout(req, 0);
			let retry: () => void = () => {};
			const retrying = new Promise<typeof RETRY>((resolve) => {
				retry = () => resolve(RETRY);
			});
			const mayRetry =
				!retried && waitMs > 0 && isRetryable(body.value["method"]);
			const exchange = session.forward({
				method: "POST",
				headers,
				body: body.text,
				rpcId,
				isListen,
				grant: {
					grantId: auth.grantId,
					clientId: auth.clientId,
					scopes: auth.scopes,
				},
				extraHeaders: corsHeaders,
				onDone: (e: Exchange) => {
					if (e.outcome === "page_gone_retry") return; // logged once, at the end
					logDone(e.status, method, {
						session: session.sessionId,
						client: clientHostName,
						outcome: e.outcome,
						...(e.outcome === "page_gone" ? { reason: "page_not_open" } : {}),
					});
				},
				pageGone: (waiting) => {
					if (waiting && mayRetry && !req.signal.aborted) {
						retry();
						return { retry: true };
					}
					const answer = notOpenAnswer(
						body.value,
						rpcId,
						session.appName,
						"gone",
						RELAY_INFO,
					);
					return answer === undefined
						? { retry: false }
						: { retry: false, body: answer };
				},
			});
			const onAbort = () => exchange.clientClosed();
			req.signal.addEventListener("abort", onAbort, { once: true });
			const result = await Promise.race([exchange.response, retrying]);
			if (result !== RETRY) return result;
			req.signal.removeEventListener("abort", onAbort);
			retried = true;
		}
	}

	/** DEC-074: HTTP 200 and a JSON-RPC message, not an HTTP error status. */
	function pageNotOpen(
		value: Record<string, unknown>,
		rpcId: RpcId | undefined,
		addressId: string,
		logDone: (
			status: number,
			method: string,
			extra?: Record<string, string | number>,
		) => void,
		method: string,
	): Response {
		const answer = notOpenAnswer(
			value,
			rpcId,
			appNames.get(addressId),
			"not_open",
			RELAY_INFO,
		);
		if (answer === undefined) {
			// A notification: the spec requires an HTTP error status.
			logDone(503, method, { reason: "page_not_open" });
			return rpcError(
				503,
				rpcId,
				RelayErrorCode.pageNotOpen,
				"The page is not open.",
				corsHeaders,
			);
		}
		logDone(200, method, { reason: "page_not_open" });
		return new Response(answer, {
			status: 200,
			headers: { ...corsHeaders, "content-type": "application/json" },
		});
	}

	function preflight(req: Request): Response {
		if (!config.cors)
			return new Response(null, { status: 405, headers: { allow: "POST" } });
		const requested = req.headers.get("access-control-request-headers") ?? "";
		return new Response(null, {
			status: 204,
			headers: {
				...corsHeaders,
				"access-control-allow-methods": "POST, OPTIONS",
				"access-control-allow-headers":
					requested !== ""
						? requested
						: "authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name",
				"access-control-max-age": "600",
			},
		});
	}

	const methodNotAllowed = () =>
		new Response(null, {
			status: 405,
			headers: { ...corsHeaders, allow: "POST" },
		});

	const postOnly = () =>
		new Response(null, { status: 405, headers: { allow: "POST, OPTIONS" } });
	const largest = largestMessageBytes(config);
	const ipOf = (req: Request, srv: Server<WsData>) =>
		ipPrefixKey(clientIp(req, srv));
	const server = Bun.serve({
		port: config.port,
		hostname: config.host,
		development: false,
		maxRequestBodySize: largest + 1024,
		idleTimeout: config.httpIdleTimeoutS,
		routes: {
			"/healthz": {
				GET: () =>
					json(200, {
						status: "ok",
						version: VERSION,
						counters: { claudeHeaderWorkaround: claudeWorkarounds },
					}),
			},
			"/": {
				GET: () =>
					new Response(INDEX_HTML, {
						headers: {
							"content-type": "text/html; charset=utf-8",
							"content-security-policy":
								"default-src 'none'; frame-ancestors 'none'",
							"x-content-type-options": "nosniff",
						},
					}),
			},
			"/tab": (req, srv) => handleTab(req, srv),
			"/.well-known/oauth-authorization-server": {
				GET: () => auth.metadata(),
				OPTIONS: () => auth.preflight("GET"),
			},
			"/.well-known/oauth-protected-resource/a/:id/mcp": {
				GET: (req) => auth.protectedResource(req.params.id),
				OPTIONS: () => auth.preflight("GET"),
			},
			"/authorize": {
				GET: (req, srv) => auth.authorize(req, ipOf(req, srv)),
				POST: (req, srv) => auth.authorizeSubmit(req, ipOf(req, srv)),
			},
			"/authorize.css": { GET: () => auth.stylesheet() },
			"/token": {
				POST: (req, srv) => auth.token(req, ipOf(req, srv)),
				OPTIONS: () => auth.preflight("POST"),
				GET: postOnly,
			},
			"/revoke": {
				POST: (req, srv) => auth.revoke(req, ipOf(req, srv)),
				OPTIONS: () => auth.preflight("POST"),
				GET: postOnly,
			},
			"/a/:id/mcp": {
				POST: (req, srv) => {
					const id = req.params.id;
					if (!isAddressId(id))
						return new Response("Not found", { status: 404 });
					return handleMcp(req, srv, id);
				},
				OPTIONS: (req) => preflight(req),
				GET: methodNotAllowed,
				DELETE: methodNotAllowed,
				PUT: methodNotAllowed,
				PATCH: methodNotAllowed,
			},
		},
		fetch: () => new Response("Not found", { status: 404 }),
		websocket: {
			data: {} as WsData,
			maxPayloadLength: largest * 4,
			backpressureLimit: config.backpressureLimitBytes,
			closeOnBackpressureLimit: false,
			idleTimeout: 120,
			sendPings: true,
			perMessageDeflate: false,
			open(ws: ServerWebSocket<WsData>) {
				const session = new TabSession(
					ws,
					ws.data.ip,
					ws.data.origin,
					ws.data.site,
					host,
				);
				ws.data.session = session;
				allSessions.add(session);
			},
			message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
				ws.data.session?.handleFrame(
					typeof message === "string" ? message : new Uint8Array(message),
				);
			},
			close(ws: ServerWebSocket<WsData>, code: number) {
				ws.data.session?.closed(code);
			},
		},
	});

	let stopping: Promise<void> | undefined;
	const port = server.port ?? config.port;
	if (publicUrl === "") publicUrl = `http://localhost:${port}`;

	const sweep = setInterval(() => {
		auth.sweep();
		store
			.deleteExpired(Date.now())
			.then((n) => {
				if (n > 0) logger.debug("store.swept", { deleted: n });
			})
			.catch((error: unknown) =>
				logger.error("store.error", {
					op: "deleteExpired",
					message: error instanceof Error ? error.message : "unknown",
				}),
			);
	}, config.sweepIntervalMs);

	const siteCount =
		config.allowedOrigins === "*"
			? "*"
			: config.allowedOrigins.length + config.sites.length;
	if (config.allowedOrigins === "*") {
		logger.warn("relay.open_relay", {
			message:
				"TAB_MCP_ALLOWED_ORIGINS=* lets any website open tab sessions on this relay",
		});
	} else if (siteCount === 0) {
		logger.warn("relay.no_origins", {
			message:
				"TAB_MCP_ALLOWED_ORIGINS and TAB_MCP_SITES are empty: no page can connect",
		});
	}
	logger.info("relay.start", {
		version: VERSION,
		url: publicUrl,
		port,
		store: ownsStore ? config.store : "custom",
		origins: siteCount,
	});

	return {
		url: publicUrl,
		port,
		config,
		addressFor: (secret) => `${publicUrl}/a/${addressIdFromSecret(secret)}/mcp`,
		get sessionCount() {
			return allSessions.size;
		},
		stop() {
			stopping ??= (async () => {
				clearInterval(sweep);
				for (const set of [...waiters.values()]) {
					for (const wake of [...set]) wake(undefined);
				}
				for (const session of [...allSessions]) {
					session.end(
						CloseCode.shuttingDown,
						"relay shutting down",
						"shutdown",
					);
				}
				await Bun.sleep(20); // let close frames leave
				await server.stop(true);
				if (ownsStore) await store.close?.();
				logger.info("relay.stop", {});
			})();
			return stopping;
		},
	};
}
