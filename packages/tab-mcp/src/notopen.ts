import { RelayErrorCode, type RpcId } from "./exchange.ts";
import { MCP_PROTOCOL_VERSION } from "./protocol.ts";

/**
 * The relay's answers when the page is not open (DEC-074): HTTP 200 with a
 * JSON-RPC message the AI app's model can act on, instead of an HTTP error
 * status that makes MCP clients re-probe the server's protocol era.
 */

/**
 * Why the page is not there: never came, went away mid-request, or is open
 * but nobody is signed in to it (identity binding, DEC-077).
 */
export type NotOpenPhase = "not_open" | "gone" | "signed_out";

/** What the relay says about itself in a stand-in `server/discover` result. */
export interface RelayInfo {
	name: string;
	version: string;
}

/**
 * Methods the relay sends to the page again after it went away mid-request:
 * read-only and not the era probe (`server/discover` must answer quickly).
 */
const RETRYABLE = new Set(["tools/list"]);

export function isRetryable(method: unknown): boolean {
	return typeof method === "string" && RETRYABLE.has(method);
}

function pageName(appName: string | undefined): string {
	return appName ?? "the web page";
}

/** The text for "the page is not open" (tool results and JSON-RPC errors). */
export function notOpenText(appName: string | undefined): string {
	return `The page is not open, or not in front. Ask the user to open ${pageName(appName)} and keep it in front (on a phone, in split screen), then try again.`;
}

/** The text for a page that is open but not signed in (DEC-077). */
export function signedOutText(appName: string | undefined): string {
	return `The page is open, but nobody is signed in to it. Ask the user to sign in to ${pageName(appName)}, then try again.`;
}

function phaseText(phase: NotOpenPhase, appName: string | undefined): string {
	return phase === "signed_out" ? signedOutText(appName) : notOpenText(appName);
}

/** The text for a tool call whose page went away while it ran. */
export function goneDuringCallText(appName: string | undefined): string {
	return `The page closed while the tool was running, so it may or may not have finished. Ask the user to open ${pageName(appName)} and keep it in front (on a phone, in split screen), then check the result before trying again.`;
}

/**
 * The JSON-RPC message the relay answers with (at HTTP 200) when the page is
 * not open, or `undefined` for a notification (that keeps an HTTP error
 * status: the spec requires one for a notification the server cannot accept).
 */
export function notOpenAnswer(
	body: Record<string, unknown>,
	rpcId: RpcId | undefined,
	appName: string | undefined,
	phase: NotOpenPhase,
	relay: RelayInfo,
): string | undefined {
	if (rpcId === undefined) return undefined;
	const id = rpcId;
	const method = body["method"];
	if (method === "tools/call") {
		const text =
			phase === "gone"
				? goneDuringCallText(appName)
				: phaseText(phase, appName);
		return JSON.stringify({
			jsonrpc: "2.0",
			id,
			result: {
				resultType: "complete",
				content: [{ type: "text", text }],
				isError: true,
			},
		});
	}
	if (method === "server/discover") {
		// A stand-in for the page's own result: the era probe must succeed (a
		// non-modern error makes dual-era clients fall back to `initialize`), and
		// `ttlMs: 0` makes clients ask the page again as soon as they need it.
		return JSON.stringify({
			jsonrpc: "2.0",
			id,
			result: {
				resultType: "complete",
				supportedVersions: [MCP_PROTOCOL_VERSION],
				capabilities: { tools: { listChanged: true } },
				instructions: phaseText(phase, appName),
				ttlMs: 0,
				cacheScope: "private",
				_meta: {
					"io.modelcontextprotocol/serverInfo": {
						name: relay.name,
						version: relay.version,
					},
				},
			},
		});
	}
	return JSON.stringify({
		jsonrpc: "2.0",
		id,
		error: {
			code:
				phase === "gone" ? RelayErrorCode.tabGone : RelayErrorCode.pageNotOpen,
			message: phaseText(phase, appName),
		},
	});
}
