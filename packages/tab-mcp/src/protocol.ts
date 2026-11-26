/**
 * The tab↔relay protocol, version 1 (`tab-mcp.v1`).
 *
 * One WebSocket per tab session; text frames with one JSON object each. The
 * normative description is `docs/protocol.md`.
 */

import {
	isAppId,
	isAppName,
	MAX_APP_ID,
	MAX_APP_NAME,
	type PairingKind,
} from "./config.ts";
import { MAX_JWT_BYTES } from "./jwt.ts";

export const SUBPROTOCOL = "tab-mcp.v1";

/**
 * The capability a tab names in `hello.capabilities` to get the sign-in
 * and group messages (DEC-231). A session that does not name it gets none of
 * them, and its `signin.*` and `member.*` messages are unknown types, as
 * before. A later, incompatible form of these messages gets a new name
 * (`signin.v2`), offered beside this one during a transition.
 */
export const SIGN_IN_CAPABILITY = "signin.v1";

/** Most capabilities in one `hello`; each is 1-32 of `a-z`, `0-9`, `.`, `-`. */
export const MAX_CAPABILITIES = 16;
const CAPABILITY = /^[a-z0-9][a-z0-9.-]{0,31}$/;

/** The longest member label (as an app name). */
export const MAX_LABEL: number = MAX_APP_NAME;

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
	/** The tab sent more control messages than its budget (`rate_limited`). */
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

/** A connected AI app as listed to the tab. */
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
	/** The name `/authorize` shows: the site's configured name, else the page's. */
	appName?: string;
	/** How AI apps pair with this page: `code` or `oidc` (DEC-079). */
	pairing: PairingKind;
	expiresAt: string;
	limits: Limits;
	grants: GrantInfo[];
	/**
	 * The providers this browser can sign in with (DEC-231): only to a session
	 * that named `signin.v1` and whose app may sign in.
	 */
	signIn?: {
		providers: { id: string; name: string }[];
		/** This browser's member id, while it is signed in (a `group` message follows). */
		member?: string;
	};
}
/** The URL to open for a sign-in (`identity.launchWebAuthFlow`), single use. */
export interface SignInUrlMessage {
	type: "signin.url";
	provider: string;
	url: string;
	expiresAt: string;
}
/** The browser is signed in and a member of its account's group. */
export interface SignInDoneMessage {
	type: "signin.done";
	provider: string;
	/** "Signed in as …": the e-mail address, user name or login. Not kept by the relay. */
	displayName: string;
	/**
	 * Microsoft only: a personal account (the consumer tenant) or a work or
	 * school one. The same address can name one of each, and both show it.
	 */
	kind?: "personal" | "work";
	/** This browser's member id in the group. */
	member: string;
}
export type SignInFailure =
	| "not_offered"
	| "bad_redirect"
	| "rate_limited"
	| "busy"
	| "provider_unavailable"
	| "code_refused"
	| "group_full"
	| "store_unavailable";
/**
 * Why a sign-in came back without a completion code: the reason in the
 * redirect URL (`signin_error`), which only the extension sees.
 */
export type SignInRedirectError =
	| "provider_error"
	| "unchecked"
	| "session_gone"
	| "cancelled";
export interface SignInFailedMessage {
	type: "signin.failed";
	provider?: string;
	reason: SignInFailure;
	message: string;
}
/** The browser's sign-in ended: signed out here, removed by a member, or 90 days over. */
export interface SignInEndedMessage {
	type: "signin.ended";
	reason: "signed_out" | "removed" | "expired";
}
export interface GroupMember {
	id: string;
	label: string;
	online: boolean;
	/** When the member signed in. */
	signedInAt: string;
}
/** The group's state, to every member when it changes and when a member connects. */
export interface GroupMessage {
	type: "group";
	provider: string;
	/** This browser's member id. */
	self: string;
	/** When this browser's sign-in ends unless it signs in again. */
	expiresAt: string;
	maxMembers: number;
	/** Every member, oldest first, this browser included. */
	members: GroupMember[];
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
export interface PairingCodeMessage {
	type: "pairing.code";
	code: string;
	expiresAt: string;
	/**
	 * Why this code comes: `start` (the dialog opened), `used` (the last one
	 * was entered), `expired`.
	 */
	reason: "start" | "used" | "expired";
}
/**
 * With identity binding (`oidc`), the answer to each `pairing.start`: a
 * sign-in pairs this page until `expiresAt` (the relay's clock), that is for
 * `expiresInMs` from now, and after it only once the page sends
 * `pairing.start` again (DEC-202). A page counts `expiresInMs` on its own
 * clock, which may differ from the relay's. From relays after 0.12.1; older
 * libraries ignore it.
 */
export interface PairingOpenMessage {
	type: "pairing.open";
	expiresAt: string;
	expiresInMs: number;
}
export interface GrantAddedMessage {
	type: "grant.added";
	grant: GrantInfo;
}
export interface GrantRemovedMessage {
	type: "grant.removed";
	grantId: string;
	reason: "revoked" | "reuse_detected" | "expired";
}
/** The page's identity assertion was accepted (DEC-076). */
export interface IdentityBoundMessage {
	type: "identity.bound";
	/** The `round` of the `identity` this answers, echoed when it had one. */
	round?: number;
}
export interface ErrorMessage {
	type: "error";
	code: ErrorCode;
	message: string;
	id?: string;
	/** On `identity_refused`: the `round` of the `identity` it answers, if it had one. */
	round?: number;
	/**
	 * The page's message this error answers, on `unknown_id` and
	 * `store_unavailable` for a revocation or a sign-out (since relay 0.10.2),
	 * so that a page with several of them pending settles the right one.
	 */
	for?: ErrorAnswers;
	/** With `for: "grant.revoke"`: the grant of that message. */
	grantId?: string;
	/** With `for: "member.rename"` or `"member.remove"`: the member of that message. */
	member?: string;
}
/** The page's messages an `error` can name in `for`. */
export type ErrorAnswers =
	| "grant.revoke"
	| "grants.revokeAll"
	| "identity.logout"
	| "signin.out"
	| "member.rename"
	| "member.remove";
export type RelayMessage =
	| SessionMessage
	| PingMessage
	| ByeMessage
	| HttpRequestMessage
	| HttpCancelMessage
	| PairingCodeMessage
	| PairingOpenMessage
	| GrantAddedMessage
	| GrantRemovedMessage
	| IdentityBoundMessage
	| SignInUrlMessage
	| SignInDoneMessage
	| SignInFailedMessage
	| SignInEndedMessage
	| GroupMessage
	| ErrorMessage;

export type ErrorCode =
	| "bad_message"
	| "unknown_type"
	| "unknown_id"
	| "too_large"
	| "rate_limited"
	| "identity_refused"
	| "store_unavailable"
	/** The page's origin may not serve the app it named (DEC-197). */
	| "app_not_allowed";

// Tab → relay

export interface HelloMessage {
	type: "hello";
	library: { name: string; version: string };
	/**
	 * The app: `id` is the `<app>` of its address `/s/<app>/mcp` (DEC-196);
	 * `name` is a self-declared name for people (DEC-045), unverified.
	 */
	app: { id: string; name?: string };
	secret: string;
	/**
	 * Revoke every grant of the address as the session claims it, before the
	 * `session` answer (which then lists none): a page taking its address back
	 * from whoever took it over (DEC-095).
	 */
	revokeAll?: boolean;
	/** What the tab understands beyond the base protocol, e.g. `signin.v1` (DEC-231). */
	capabilities?: string[];
}
/** Start a sign-in with a provider (DEC-231); answered with `signin.url` or `signin.failed`. */
export interface SignInStartMessage {
	type: "signin.start";
	provider: string;
	/** `identity.getRedirectURL()`: where the relay sends the browser at the end. */
	redirectUrl: string;
	/** The member's label in the group, e.g. "Chrome on macOS". */
	label?: string;
}
/** Hand back the completion code of the redirect URL: only then is the browser bound. */
export interface SignInCompleteMessage {
	type: "signin.complete";
	code: string;
}
export interface SignInOutMessage {
	type: "signin.out";
}
export interface MemberRenameMessage {
	type: "member.rename";
	member: string;
	label: string;
}
export interface MemberRemoveMessage {
	type: "member.remove";
	member: string;
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
export interface PairingStartMessage {
	type: "pairing.start";
}
export interface PairingStopMessage {
	type: "pairing.stop";
}
export interface GrantRevokeMessage {
	type: "grant.revoke";
	grantId: string;
}
export interface GrantsRevokeAllMessage {
	type: "grants.revokeAll";
}
/** The web app's signed statement of who the page's user is (DEC-076). */
export interface IdentityMessage {
	type: "identity";
	assertion: string;
	/** The page's number for this assertion, echoed in the answer (a lost answer cannot be mistaken for a later one). */
	round?: number;
}
/** The page's user signed out: end every AI connection (DEC-078). */
export interface IdentityLogoutMessage {
	type: "identity.logout";
}
export type TabMessage =
	| HelloMessage
	| PairingStartMessage
	| PairingStopMessage
	| GrantRevokeMessage
	| GrantsRevokeAllMessage
	| IdentityMessage
	| IdentityLogoutMessage
	| SignInStartMessage
	| SignInCompleteMessage
	| SignInOutMessage
	| MemberRenameMessage
	| MemberRemoveMessage
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

const MAX_NAME = 200;
const MAX_ID = 128;
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_VALUE = 8192;

/**
 * RFC 9110 §5.5 field value: visible ASCII, obs-text (0x80-0xFF), space and
 * tab; no other control characters (CR, LF, NUL, DEL, …) and nothing beyond
 * 0xFF, which `Headers` would reject.
 */
const FIELD_VALUE = /^[\t\x20-\x7E\x80-\xFF]*$/;

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
			/^[a-z0-9-]{1,64}$/.test(k) &&
			isString(val, MAX_HEADER_VALUE) &&
			FIELD_VALUE.test(val),
	);
}

function idOf(v: Json): string | undefined {
	return isId(v["id"]) ? v["id"] : undefined;
}

export interface ParseOptions {
	/**
	 * The session offers sign-in (DEC-231): `signin.*` and `member.*` are
	 * messages. Otherwise they are unknown types, as for a relay without them.
	 */
	signIn?: boolean;
}

/** The sign-in messages, known only to a session that offers sign-in. */
const SIGN_IN_TYPES: ReadonlySet<string> = new Set([
	"signin.start",
	"signin.complete",
	"signin.out",
	"member.rename",
	"member.remove",
]);

/** A label as sent: 1-64 characters without control characters (cleaned later). */
function isLabel(v: unknown): v is string {
	return isAppName(v) && v.length <= MAX_LABEL;
}

/**
 * Parse and validate one text frame from the tab. Hand-written on purpose: the
 * relay has no schema library (DEC-014).
 */
export function parseTabMessage(
	text: string,
	options: ParseOptions = {},
): ParseResult {
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
	if (SIGN_IN_TYPES.has(type) && options.signIn !== true) {
		return id === undefined
			? { ok: true, unknown: true, type }
			: { ok: true, unknown: true, type, id };
	}

	switch (type) {
		case "hello": {
			const library = v["library"];
			if (
				!isObject(library) ||
				!isString(library["name"], MAX_NAME) ||
				!isString(library["version"], MAX_NAME)
			) {
				return bad("hello.library must be {name, version}");
			}
			if (typeof v["secret"] !== "string") return bad("hello.secret missing");
			const app = v["app"];
			if (!isObject(app) || !isAppId(app["id"])) {
				return bad(
					`hello.app.id must be 1-${MAX_APP_ID} characters of a-z, 0-9 and - (tab-mcp-client 0.17 or later sends it)`,
				);
			}
			if (app["name"] !== undefined && !isAppName(app["name"])) {
				return bad(`hello.app.name must be 1-${MAX_APP_NAME} characters`);
			}
			const revokeAll = v["revokeAll"];
			if (revokeAll !== undefined && typeof revokeAll !== "boolean") {
				return bad("hello.revokeAll must be a boolean");
			}
			const capabilities = v["capabilities"];
			if (
				capabilities !== undefined &&
				!(
					Array.isArray(capabilities) &&
					capabilities.length <= MAX_CAPABILITIES &&
					capabilities.every((c) => typeof c === "string" && CAPABILITY.test(c))
				)
			) {
				return bad(
					`hello.capabilities must be a list of at most ${MAX_CAPABILITIES} names of 1-32 characters of a-z, 0-9, . and -`,
				);
			}
			const hello: HelloMessage = {
				type,
				library: { name: library["name"], version: library["version"] },
				secret: v["secret"],
				app: { id: app["id"] },
			};
			if (isAppName(app["name"])) hello.app.name = app["name"];
			if (revokeAll === true) hello.revokeAll = true;
			if (capabilities !== undefined) {
				hello.capabilities = [...(capabilities as string[])];
			}
			return { ok: true, message: hello };
		}
		case "signin.start": {
			const provider = v["provider"];
			if (!isString(provider, 32) || provider === "") {
				return bad("signin.start.provider missing");
			}
			const redirectUrl = v["redirectUrl"];
			if (!isString(redirectUrl, 256) || redirectUrl === "") {
				return bad("signin.start.redirectUrl missing");
			}
			const label = v["label"];
			if (label !== undefined && !isLabel(label)) {
				return bad(`signin.start.label must be 1-${MAX_LABEL} characters`);
			}
			return {
				ok: true,
				message:
					label === undefined
						? { type, provider, redirectUrl }
						: { type, provider, redirectUrl, label },
			};
		}
		case "signin.complete": {
			const code = v["code"];
			if (!isString(code, MAX_ID) || code === "") {
				return bad("signin.complete.code missing");
			}
			return { ok: true, message: { type, code } };
		}
		case "signin.out":
			return { ok: true, message: { type } };
		case "member.rename": {
			const member = v["member"];
			const label = v["label"];
			if (!isId(member)) return bad("member.rename.member missing");
			if (!isLabel(label)) {
				return bad(`member.rename.label must be 1-${MAX_LABEL} characters`);
			}
			return { ok: true, message: { type, member, label } };
		}
		case "member.remove": {
			const member = v["member"];
			if (!isId(member)) return bad("member.remove.member missing");
			return { ok: true, message: { type, member } };
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
		case "pairing.start":
		case "pairing.stop":
		case "grants.revokeAll":
		case "identity.logout":
			return { ok: true, message: { type } };
		case "identity": {
			const assertion = v["assertion"];
			if (
				typeof assertion !== "string" ||
				assertion === "" ||
				assertion.length > MAX_JWT_BYTES
			) {
				return bad(
					`identity.assertion must be a JWT of at most ${MAX_JWT_BYTES} bytes`,
				);
			}
			const round = v["round"];
			if (
				round !== undefined &&
				!(Number.isSafeInteger(round) && (round as number) >= 0)
			) {
				return bad("identity.round must be a non-negative integer");
			}
			return round === undefined
				? { ok: true, message: { type, assertion } }
				: { ok: true, message: { type, assertion, round: round as number } };
		}
		case "grant.revoke": {
			const grantId = v["grantId"];
			if (!isId(grantId)) return bad("grant.revoke.grantId missing");
			return { ok: true, message: { type, grantId } };
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
