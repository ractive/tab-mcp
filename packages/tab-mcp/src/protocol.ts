/**
 * The tab↔relay protocol, version 1 (`tab-mcp.v1`).
 *
 * One WebSocket per tab session; text frames with one JSON object each. The
 * normative description is `kb/design/protocol.md` (later `docs/protocol.md`).
 */

export const SUBPROTOCOL = "tab-mcp.v1";

/** The only MCP revision the relay serves (DEC-033). */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/** `_meta` key that carries the protocol version in every 2026-07-28 request. */
export const PROTOCOL_VERSION_META_KEY =
	"io.modelcontextprotocol/protocolVersion";

export const CloseCode = {
	normal: 1000,
	policyViolation: 1008,
	tooLarge: 1009,
	sessionExpired: 4001,
	idleTimeout: 4002,
	heartbeatLost: 4003,
	shuttingDown: 4004,
	replaced: 4005,
	rateLimited: 4008,
} as const;

export type ByeReason = "replaced" | "expired" | "idle" | "shutdown" | "user";

export interface Limits {
	maxMessageBytes: number;
	maxBodyBytes: number;
	requestTimeoutMs: number;
	idleTimeoutMs: number;
	heartbeatMs: number;
	keepAliveMs: number;
	maxConcurrentRequests: number;
}

/** Who is calling, as the tab sees it (passed to the MCP handler as `authInfo`). */
export interface GrantRef {
	grantId: string;
	clientId: string;
	scopes: string[];
}

/** A connected AI app as listed to the tab (filled from iteration 3 on). */
export interface GrantInfo {
	grantId: string;
	client: { id: string; name: string; host: string };
	createdAt: string;
}

// Relay → tab

export interface SessionMessage {
	type: "session";
	sessionId: string;
	address: string;
	origin: string;
	expiresAt: string;
	limits: Limits;
	grants: GrantInfo[];
}
export interface PingMessage {
	type: "ping";
	t: number;
}
export interface ByeMessage {
	type: "bye";
	reason: string;
}
export interface HttpRequestMessage {
	type: "http.request";
	id: string;
	method: string;
	path: string;
	headers: Record<string, string>;
	body: string;
	grant: GrantRef;
}
export interface HttpCancelMessage {
	type: "http.cancel";
	id: string;
	reason: "client_closed" | "timeout" | "error";
}
export interface ErrorMessage {
	type: "error";
	code: ErrorCode;
	message: string;
	id?: string;
}
export type RelayMessage =
	| SessionMessage
	| PingMessage
	| ByeMessage
	| HttpRequestMessage
	| HttpCancelMessage
	| ErrorMessage;

export type ErrorCode =
	| "bad_message"
	| "unknown_type"
	| "unknown_id"
	| "too_large"
	| "rate_limited";

// Tab → relay

export interface HelloMessage {
	type: "hello";
	library: { name: string; version: string };
	page: { title: string };
	secret: string;
}
export interface PongMessage {
	type: "pong";
	t: number;
}
export interface HttpResponseMessage {
	type: "http.response";
	id: string;
	status: number;
	headers: Record<string, string>;
	body: string;
}
export interface HttpResponseStartMessage {
	type: "http.response.start";
	id: string;
	status: number;
	headers: Record<string, string>;
}
export interface HttpResponseChunkMessage {
	type: "http.response.chunk";
	id: string;
	data: string;
}
export interface HttpResponseEndMessage {
	type: "http.response.end";
	id: string;
}
export interface TabErrorMessage {
	type: "error";
	code: string;
	message: string;
	id?: string;
}
export type TabMessage =
	| HelloMessage
	| PongMessage
	| ByeMessage
	| HttpResponseMessage
	| HttpResponseStartMessage
	| HttpResponseChunkMessage
	| HttpResponseEndMessage
	| TabErrorMessage;

/** Result of parsing one frame from the tab. */
export type ParseResult =
	| { ok: true; message: TabMessage }
	/** A well-formed message of a type this relay does not know. */
	| { ok: true; unknown: true; type: string; id?: string }
	| { ok: false; error: string; id?: string };

const MAX_TITLE = 300;
const MAX_NAME = 200;
const MAX_ID = 128;
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_VALUE = 8192;

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown, max: number): v is string {
	return typeof v === "string" && v.length <= max;
}

function isId(v: unknown): v is string {
	return typeof v === "string" && v.length > 0 && v.length <= MAX_ID;
}

function isStatus(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v >= 200 && v <= 599;
}

function isHeaders(v: unknown): v is Record<string, string> {
	if (!isObject(v)) return false;
	const entries = Object.entries(v);
	if (entries.length > MAX_HEADER_COUNT) return false;
	return entries.every(
		([k, val]) =>
			/^[a-z0-9-]{1,64}$/.test(k) && isString(val, MAX_HEADER_VALUE),
	);
}

function idOf(v: Json): string | undefined {
	return isId(v["id"]) ? v["id"] : undefined;
}

/**
 * Parse and validate one text frame from the tab. Hand-written on purpose: the
 * relay has no schema library (DEC-014).
 */
export function parseTabMessage(text: string): ParseResult {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		return { ok: false, error: "not JSON" };
	}
	if (!isObject(v)) return { ok: false, error: "not a JSON object" };
	const type = v["type"];
	if (typeof type !== "string" || type.length === 0 || type.length > 64) {
		return { ok: false, error: "missing type" };
	}
	const id = idOf(v);
	const bad = (error: string): ParseResult =>
		id === undefined ? { ok: false, error } : { ok: false, error, id };

	switch (type) {
		case "hello": {
			const library = v["library"];
			const page = v["page"];
			if (
				!isObject(library) ||
				!isString(library["name"], MAX_NAME) ||
				!isString(library["version"], MAX_NAME)
			) {
				return bad("hello.library must be {name, version}");
			}
			if (!isObject(page) || !isString(page["title"], MAX_TITLE)) {
				return bad("hello.page must be {title}");
			}
			if (typeof v["secret"] !== "string") return bad("hello.secret missing");
			return {
				ok: true,
				message: {
					type,
					library: { name: library["name"], version: library["version"] },
					page: { title: page["title"] },
					secret: v["secret"],
				},
			};
		}
		case "pong": {
			const t = v["t"];
			if (typeof t !== "number") return bad("pong.t must be a number");
			return { ok: true, message: { type, t } };
		}
		case "bye": {
			const reason = v["reason"];
			return {
				ok: true,
				message: {
					type,
					reason: isString(reason, MAX_NAME) ? reason : "",
				},
			};
		}
		case "http.response": {
			if (id === undefined) return bad("http.response.id missing");
			const { status, headers, body } = v;
			if (!isStatus(status)) return bad("http.response.status invalid");
			if (!isHeaders(headers)) return bad("http.response.headers invalid");
			if (typeof body !== "string") return bad("http.response.body invalid");
			return { ok: true, message: { type, id, status, headers, body } };
		}
		case "http.response.start": {
			if (id === undefined) return bad("http.response.start.id missing");
			const { status, headers } = v;
			if (!isStatus(status)) return bad("http.response.start.status invalid");
			if (!isHeaders(headers))
				return bad("http.response.start.headers invalid");
			return { ok: true, message: { type, id, status, headers } };
		}
		case "http.response.chunk": {
			if (id === undefined) return bad("http.response.chunk.id missing");
			const data = v["data"];
			if (typeof data !== "string")
				return bad("http.response.chunk.data invalid");
			return { ok: true, message: { type, id, data } };
		}
		case "http.response.end": {
			if (id === undefined) return bad("http.response.end.id missing");
			return { ok: true, message: { type, id } };
		}
		case "error": {
			const code = v["code"];
			const message = v["message"];
			if (!isString(code, MAX_NAME)) return bad("error.code invalid");
			const m: TabErrorMessage = {
				type,
				code,
				message: isString(message, 1000) ? message : "",
			};
			if (id !== undefined) m.id = id;
			return { ok: true, message: m };
		}
		default:
			return id === undefined
				? { ok: true, unknown: true, type }
				: { ok: true, unknown: true, type, id };
	}
}
