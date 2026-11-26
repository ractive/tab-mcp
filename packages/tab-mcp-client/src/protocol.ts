/**
 * The tab↔relay protocol, version 1, as the tab speaks it
 * (`docs/protocol.md`, normative). Internal: not part of the public API.
 */

import type { Grant, Limits } from "./types.ts";

export const SUBPROTOCOL = "tab-mcp.v1";

/** Who is calling a tunnelled request (the relay's view of the grant). */
export interface GrantRef {
	grantId: string;
	clientId: string;
	scopes: string[];
}

// Relay → tab

export interface SessionMessage {
	type: "session";
	sessionId: string;
	address: string;
	origin: string;
	appName?: string;
	/** How AI apps pair: `code` or `oidc` (identity binding). Older relays omit it. */
	pairing?: "code" | "oidc";
	expiresAt: string;
	limits: Limits;
	grants: Grant[];
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
	reason: string;
}
export interface PairingCodeMessage {
	type: "pairing.code";
	code: string;
	expiresAt: string;
	/** Why it came; left out when it is not one of these. */
	reason?: "start" | "used" | "expired";
}

const CODE_REASONS = new Set(["start", "used", "expired"]);
/**
 * Identity binding: a sign-in pairs the page for `expiresInMs` from now
 * (DEC-202), until `expiresAt` on the relay's clock. As parsed, `expiresAt`
 * is on the page's clock: now plus `expiresInMs`, or the relay's
 * `expiresAt` when it sent no usable `expiresInMs`.
 */
export interface PairingOpenMessage {
	type: "pairing.open";
	expiresAt: string;
}

/** The longest `expiresInMs` taken: what `setTimeout` can wait (24.8 days). */
const MAX_DELAY_MS = 2_147_483_647;
export interface GrantAddedMessage {
	type: "grant.added";
	grant: Grant;
}
export interface GrantRemovedMessage {
	type: "grant.removed";
	grantId: string;
	reason: string;
}
export interface IdentityBoundMessage {
	type: "identity.bound";
	/** The `round` of the `identity` this answers. */
	round?: number;
}
export interface ErrorMessage {
	type: "error";
	code: string;
	message: string;
	id?: string;
	/** On `identity_refused`: the `round` of the `identity` it answers. */
	round?: number;
	/**
	 * On `unknown_id` and `store_unavailable` from relay 0.10.2: the type of
	 * the page's message it answers (`grant.revoke`, `grants.revokeAll`,
	 * `identity.logout`); older relays leave it out.
	 */
	for?: unknown;
	/** With `for: "grant.revoke"`: that message's grant. */
	grantId?: unknown;
}
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
	| ErrorMessage;

// Tab → relay

export type TabMessage =
	| {
			type: "hello";
			library: { name: string; version: string };
			/** `id`: the `<app>` of the address `/s/<app>/mcp` (DEC-196). */
			app: { id: string; name?: string };
			secret: string;
			/** Take the address back: the relay revokes its grants as it claims it (DEC-095). */
			revokeAll?: true;
			/** What the tab understands beyond the library's messages (`RelayMessages`). */
			capabilities?: string[];
	  }
	| { type: "pong"; t: number }
	| { type: "bye"; reason: string }
	| {
			type: "http.response";
			id: string;
			status: number;
			headers: Record<string, string>;
			body: string;
	  }
	| {
			type: "http.response.start";
			id: string;
			status: number;
			headers: Record<string, string>;
	  }
	| { type: "http.response.chunk"; id: string; data: string }
	| { type: "http.response.end"; id: string }
	| { type: "pairing.start" }
	| { type: "pairing.stop" }
	| { type: "grant.revoke"; grantId: string }
	| { type: "grants.revokeAll" }
	| { type: "identity"; assertion: string; round: number }
	| { type: "identity.logout" }
	| { type: "error"; code: string; message: string; id?: string };

/**
 * A message of a type the library does not speak itself, sent for a
 * `RelayMessages` user (the `send` its `receive` gets).
 */
export type RelayMessageOut = { type: string } & Record<string, unknown>;

/** The types of the tab's messages the library sends itself: none of them through `RelayMessages`. */
const TAB_TYPES: ReadonlySet<string> = new Set([
	"hello",
	"pong",
	"bye",
	"http.response",
	"http.response.start",
	"http.response.chunk",
	"http.response.end",
	"pairing.start",
	"pairing.stop",
	"grant.revoke",
	"grants.revokeAll",
	"identity",
	"identity.logout",
	"error",
]);

/** Whether `message` may go out for a `RelayMessages` user: a type that is not the library's. */
export function isOtherTabMessage(
	message: unknown,
): message is RelayMessageOut {
	return (
		typeof message === "object" &&
		message !== null &&
		typeof (message as { type?: unknown }).type === "string" &&
		!TAB_TYPES.has((message as { type: string }).type)
	);
}

/** A `hello.capabilities` name, as the relay takes it. */
const CAPABILITY = /^[a-z0-9][a-z0-9.-]{0,31}$/;

/** Whether `names` may go into `hello.capabilities` (at most 16 names). */
export function isCapabilityList(names: unknown): names is readonly string[] {
	return (
		Array.isArray(names) &&
		names.length <= 16 &&
		names.every((n) => typeof n === "string" && CAPABILITY.test(n))
	);
}

/** The types of the relay's messages the library reads (`parseRelayMessage`). */
const RELAY_TYPES = new Set([
	"session",
	"ping",
	"bye",
	"http.request",
	"http.cancel",
	"pairing.code",
	"pairing.open",
	"grant.added",
	"grant.removed",
	"identity.bound",
	"error",
]);

type Json = Record<string, unknown>;

/**
 * A frame of a type the library does not know, for `RelayMessages`: an
 * object with a string `type`; `undefined` for anything else (a known
 * type, malformed or not, is the library's).
 */
export function otherRelayMessage(text: string): Json | undefined {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		return undefined;
	}
	return isObject(v) && str(v["type"]) && !RELAY_TYPES.has(v["type"])
		? v
		: undefined;
}

function isObject(v: unknown): v is Json {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): v is string => typeof v === "string";

function isGrant(v: unknown): v is Grant {
	if (!isObject(v) || !str(v["grantId"]) || !str(v["createdAt"])) return false;
	const c = v["client"];
	return isObject(c) && str(c["id"]) && str(c["name"]) && str(c["host"]);
}

function isLimits(v: unknown): v is Limits {
	if (!isObject(v)) return false;
	return [
		"maxMessageBytes",
		"maxBodyBytes",
		"requestTimeoutMs",
		"idleTimeoutMs",
		"heartbeatMs",
		"keepAliveMs",
		"maxConcurrentRequests",
	].every((k) => typeof v[k] === "number");
}

function isStringRecord(v: unknown): v is Record<string, string> {
	return isObject(v) && Object.values(v).every(str);
}

/**
 * Parse one frame from the relay. Returns `undefined` for anything malformed
 * or unknown; the caller ignores it (forward compatibility).
 */
export function parseRelayMessage(text: string): RelayMessage | undefined {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isObject(v)) return undefined;
	switch (v["type"]) {
		case "session":
			return str(v["sessionId"]) &&
				str(v["address"]) &&
				str(v["origin"]) &&
				str(v["expiresAt"]) &&
				isLimits(v["limits"]) &&
				Array.isArray(v["grants"]) &&
				v["grants"].every(isGrant) &&
				(v["appName"] === undefined || str(v["appName"])) &&
				(v["pairing"] === undefined || str(v["pairing"]))
				? (v as unknown as SessionMessage)
				: undefined;
		case "ping":
			return typeof v["t"] === "number"
				? (v as unknown as PingMessage)
				: undefined;
		case "bye":
			return { type: "bye", reason: str(v["reason"]) ? v["reason"] : "" };
		case "http.request":
			return str(v["id"]) &&
				str(v["method"]) &&
				str(v["path"]) &&
				isStringRecord(v["headers"]) &&
				str(v["body"]) &&
				isObject(v["grant"]) &&
				str(v["grant"]["grantId"]) &&
				str(v["grant"]["clientId"])
				? (v as unknown as HttpRequestMessage)
				: undefined;
		case "http.cancel":
			return str(v["id"]) ? (v as unknown as HttpCancelMessage) : undefined;
		case "pairing.code": {
			if (!str(v["code"]) || !str(v["expiresAt"])) return undefined;
			const message: PairingCodeMessage = {
				type: "pairing.code",
				code: v["code"],
				expiresAt: v["expiresAt"],
			};
			// An unknown reason (a newer relay) counts as none.
			const reason = v["reason"];
			if (typeof reason === "string" && CODE_REASONS.has(reason))
				message.reason = reason as NonNullable<PairingCodeMessage["reason"]>;
			return message;
		}
		case "pairing.open": {
			// Counted on the page's clock from now, which may differ from the
			// relay's; the relay's absolute time only without a duration.
			const ms = v["expiresInMs"];
			if (
				typeof ms === "number" &&
				Number.isFinite(ms) &&
				ms >= 0 &&
				ms <= MAX_DELAY_MS
			)
				return {
					type: "pairing.open",
					expiresAt: new Date(Date.now() + ms).toISOString(),
				};
			return str(v["expiresAt"]) && !Number.isNaN(Date.parse(v["expiresAt"]))
				? { type: "pairing.open", expiresAt: v["expiresAt"] }
				: undefined;
		}
		case "grant.added":
			return isGrant(v["grant"])
				? (v as unknown as GrantAddedMessage)
				: undefined;
		case "grant.removed":
			return str(v["grantId"])
				? {
						type: "grant.removed",
						grantId: v["grantId"],
						reason: str(v["reason"]) ? v["reason"] : "",
					}
				: undefined;
		case "identity.bound":
			return typeof v["round"] === "number"
				? { type: "identity.bound", round: v["round"] }
				: { type: "identity.bound" };
		case "error":
			return str(v["code"]) ? (v as unknown as ErrorMessage) : undefined;
		default:
			return undefined;
	}
}
