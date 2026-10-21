/**
 * The tab↔relay protocol, version 1, as the tab speaks it
 * (`kb/design/protocol.md`). Internal: not part of the public API.
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
}
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
}
export interface ErrorMessage {
	type: "error";
	code: string;
	message: string;
	id?: string;
}
export type RelayMessage =
	| SessionMessage
	| PingMessage
	| ByeMessage
	| HttpRequestMessage
	| HttpCancelMessage
	| PairingCodeMessage
	| GrantAddedMessage
	| GrantRemovedMessage
	| IdentityBoundMessage
	| ErrorMessage;

// Tab → relay

export type TabMessage =
	| {
			type: "hello";
			library: { name: string; version: string };
			page: { title: string };
			app?: { name: string };
			secret: string;
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
	| { type: "identity"; assertion: string }
	| { type: "identity.logout" }
	| { type: "error"; code: string; message: string; id?: string };

type Json = Record<string, unknown>;

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
		case "pairing.code":
			return str(v["code"]) && str(v["expiresAt"])
				? (v as unknown as PairingCodeMessage)
				: undefined;
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
			return { type: "identity.bound" };
		case "error":
			return str(v["code"]) ? (v as unknown as ErrorMessage) : undefined;
		default:
			return undefined;
	}
}
