import type { Server, ServerWebSocket } from "bun";
import pkg from "../package.json" with { type: "json" };
import { addressIdFromSecret, isAddressId, shortAddress } from "./address.ts";
import { type RelayConfig, resolveConfig, type StoreKind } from "./config.ts";
import {
	type Exchange,
	RelayErrorCode,
	type RpcId,
	rpcErrorBody,
} from "./exchange.ts";
import { createLogger, type Logger, truncateIp } from "./log.ts";
import {
	CloseCode,
	MCP_PROTOCOL_VERSION,
	PROTOCOL_VERSION_META_KEY,
	SUBPROTOCOL,
} from "./protocol.ts";
import { TabSession } from "./session.ts";
import { MemoryTokenStore } from "./store/memory.ts";
import { SqliteTokenStore } from "./store/sqlite.ts";
import type { TokenRecord, TokenStore } from "./store/types.ts";
import { hashToken } from "./tokens.ts";

export const VERSION: string = pkg.version;

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
	session?: TabSession;
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
	let claudeWorkarounds = 0;
	let publicUrl = config.publicUrl ?? "";

	const corsHeaders: Record<string, string> = config.cors
		? {
				"access-control-allow-origin": "*",
				"access-control-expose-headers":
					"www-authenticate, mcp-protocol-version",
			}
		: {};

	const host = {
		config,
		logger,
		store,
		publicUrl: () => publicUrl,
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
	};

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

	function originAllowed(origin: string | null): boolean {
		if (config.allowedOrigins === "*") return true;
		if (origin === null) return false;
		return config.allowedOrigins.includes(origin);
	}

	function handleTab(
		req: Request,
		server: Server<WsData>,
	): Response | undefined {
		const origin = req.headers.get("origin");
		if (!originAllowed(origin)) {
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
		const ip = clientIp(req, server);
		if (allSessions.size >= config.maxSessions) {
			logger.warn("tab.refused", { reason: "max_sessions" });
			return json(429, { error: "too_many_sessions" });
		}
		const count = perIp.get(ip) ?? 0;
		if (count >= config.maxSessionsPerIp) {
			logger.warn("tab.refused", {
				reason: "max_sessions_per_ip",
				ip: truncateIp(ip),
			});
			return json(429, { error: "too_many_sessions" });
		}
		perIp.set(ip, count + 1);
		const ok = server.upgrade(req, {
			data: { ip, origin: origin ?? "" },
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

	async function readBody(req: Request): Promise<Body | Response> {
		const length = Number(req.headers.get("content-length") ?? "0");
		if (length > config.maxMessageBytes) {
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
		if (bytes.byteLength > config.maxMessageBytes) {
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
			claudeWorkarounds++;
			logger.info("mcp.claude_header_workaround", { count: claudeWorkarounds });
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

		const body = await readBody(req);
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

		const session = sessions.get(addressId);
		if (session === undefined || !session.ready) {
			logDone(503, method, { reason: "page_not_open" });
			return rpcError(
				503,
				rpcId,
				RelayErrorCode.pageNotOpen,
				'The page is not open. Open the web page that offers these tools and click "Connect your AI tool".',
				corsHeaders,
			);
		}
		if (session.pending.size >= config.maxConcurrentRequests) {
			logDone(429, method);
			return rpcError(
				429,
				rpcId,
				RelayErrorCode.overloaded,
				"Too many requests at once for this page.",
				corsHeaders,
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
		// Only now, for an authenticated request that is about to be forwarded,
		// switch off Bun's idle timer: our own request timer and keep-alives take
		// over (Bun research, finding 1). Body reading and every unauthenticated
		// path keep the idle timeout, so a stalled client cannot hold a socket.
		server.timeout(req, 0);
		const exchange = session.forward({
			method: "POST",
			headers,
			body: body.text,
			rpcId,
			isListen: body.value["method"] === "subscriptions/listen",
			grant: {
				grantId: auth.grantId,
				clientId: auth.clientId,
				scopes: auth.scopes,
			},
			extraHeaders: corsHeaders,
			onDone: (e: Exchange) =>
				logDone(e.status, method, {
					session: session.sessionId,
					client: clientHostName,
					outcome: e.outcome,
				}),
		});
		req.signal.addEventListener("abort", () => exchange.clientClosed(), {
			once: true,
		});
		return exchange.response;
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

	const server = Bun.serve({
		port: config.port,
		hostname: config.host,
		development: false,
		maxRequestBodySize: config.maxMessageBytes + 1024,
		idleTimeout: config.httpIdleTimeoutS,
		routes: {
			"/healthz": {
				GET: () => json(200, { status: "ok", version: VERSION }),
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
			maxPayloadLength: config.maxMessageBytes * 4,
			backpressureLimit: config.backpressureLimitBytes,
			closeOnBackpressureLimit: false,
			idleTimeout: 120,
			sendPings: true,
			perMessageDeflate: false,
			open(ws: ServerWebSocket<WsData>) {
				const session = new TabSession(ws, ws.data.ip, ws.data.origin, host);
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

	const port = server.port ?? config.port;
	if (publicUrl === "") publicUrl = `http://localhost:${port}`;

	const sweep = setInterval(() => {
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

	if (config.allowedOrigins === "*") {
		logger.warn("relay.open_relay", {
			message:
				"TAB_MCP_ALLOWED_ORIGINS=* lets any website open tab sessions on this relay",
		});
	} else if (config.allowedOrigins.length === 0) {
		logger.warn("relay.no_origins", {
			message: "TAB_MCP_ALLOWED_ORIGINS is empty: no page can connect",
		});
	}
	logger.info("relay.start", {
		version: VERSION,
		url: publicUrl,
		port,
		store: ownsStore ? config.store : "custom",
		origins: config.allowedOrigins === "*" ? "*" : config.allowedOrigins.length,
	});

	let stopping: Promise<void> | undefined;
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
