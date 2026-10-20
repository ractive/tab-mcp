/**
 * Public types of `@ractive-ch/tab-mcp-client`. Self-contained on purpose: the
 * published declarations must not import from other workspace packages.
 */

/** A JSON Schema document (draft 2020-12) describing a tool's input object. */
export type JsonSchema = { [key: string]: unknown };

/**
 * Tool annotations: the WebMCP hints plus the MCP-only hints. The WebMCP hints
 * are mapped to MCP (DEC-022); MCP hints given here win over the mapping.
 */
export interface ToolAnnotations {
	/** The tool only reads (WebMCP and MCP). */
	readOnlyHint?: boolean;
	/** The tool's results may contain untrusted content (WebMCP). */
	untrustedContentHint?: boolean;
	/** The tool has consequences the user should approve: asks in the page first (WebMCP). */
	consequentialHint?: boolean;
	/** The tool is meant for debugging (WebMCP). */
	debugging?: boolean;
	/** MCP: the tool may destroy data. */
	destructiveHint?: boolean;
	/** MCP: calling it twice with the same arguments has no extra effect. */
	idempotentHint?: boolean;
	/** MCP: the tool talks to the open world. */
	openWorldHint?: boolean;
}

/** The AI app that calls a tool, as far as the relay knows it. */
export interface ToolCallClient {
	/** The grant (connected app) the call came through. */
	grantId: string;
	/** The client's id (its Client ID Metadata Document URL). */
	id: string;
	/** Self-declared name, when known from the connected apps. */
	name?: string;
	/** Host of the client id URL: the verified part. */
	host: string;
}

/** Second argument of `execute`. */
export interface ToolExecuteOptions {
	/** Aborted when the AI app gives up on the call or the page disconnects. */
	signal: AbortSignal;
	/** Who is calling. */
	client: ToolCallClient;
}

/** A tool in the WebMCP shape (`document.modelContext.registerTool`). */
export interface Tool {
	/** 1–128 characters of `A–Z a–z 0–9 _ - .`. */
	name: string;
	title?: string;
	/** What the tool does, for the model. Must not be empty. */
	description: string;
	/** JSON Schema of the input object; defaults to `{ "type": "object" }`. */
	inputSchema?: JsonSchema;
	/** Runs the tool. Its return value becomes the result (DEC-023). */
	execute: (
		input: Record<string, unknown>,
		options: ToolExecuteOptions,
	) => unknown;
	annotations?: ToolAnnotations;
}

/** Options of `registerTool`. */
export interface RegisterToolOptions {
	/** Aborting it unregisters the tool. */
	signal?: AbortSignal;
	/** WebMCP's cross-document exposure; ignored by tab-mcp. */
	exposedTo?: string[];
}

/** What the page's MCP server says about itself in `server/discover`. */
export interface ServerInfo {
	name: string;
	version: string;
	title?: string;
	/** Instructions for the model, e.g. how the tools fit together. */
	instructions?: string;
}

/** A consequential tool call waiting for the user's approval. */
export interface ConfirmRequest {
	tool: { name: string; title?: string; description: string };
	arguments: Record<string, unknown>;
	client: ToolCallClient;
	/** Aborted when the call is cancelled; close the question then. */
	signal: AbortSignal;
}

/** Decides whether a consequential tool may run. */
export type ConfirmHandler = (
	request: ConfirmRequest,
) => boolean | Promise<boolean>;

/** Where the address secret is kept (`localStorage` by default). */
export interface SecretStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export interface TabMcpOptions {
	/** The relay, e.g. `https://relay.example` or `wss://relay.example`. */
	relay: string;
	/** Name, version and instructions of the page's MCP server. */
	server: ServerInfo;
	/** The page's app name (e.g. `saturnus`), shown when an AI app pairs; at most 64 characters. */
	appName?: string;
	/** Approves consequential tool calls; default: a dialog in the page. */
	onConfirm?: ConfirmHandler;
	/**
	 * How long the default confirmation keeps "Allow" disabled after it opens,
	 * in milliseconds: 750 by default, never less than 500.
	 */
	confirmDelayMs?: number;
	/**
	 * Where the address secret lives; default `localStorage`. `null` keeps it
	 * only for the page's lifetime (a new address on every visit).
	 */
	storage?: SecretStorage | null;
	/** Storage key of the secret; default `tab-mcp:secret:<relay origin>`. */
	storageKey?: string;
}

/** The session's limits, as the relay announces them. */
export interface Limits {
	maxMessageBytes: number;
	maxBodyBytes: number;
	requestTimeoutMs: number;
	idleTimeoutMs: number;
	heartbeatMs: number;
	keepAliveMs: number;
	maxConcurrentRequests: number;
}

/** A connected AI app. */
export interface Grant {
	grantId: string;
	client: { id: string; name: string; host: string };
	createdAt: string;
}

/** The current session with the relay. */
export interface SessionInfo {
	sessionId: string;
	/** The MCP address to give to the AI app. */
	address: string;
	/** The page origin the relay saw. */
	origin: string;
	/** The app name the relay shows when pairing, if any. */
	appName?: string;
	expiresAt: string;
	limits: Limits;
}

/** A pairing code to show (DEC-028). */
export interface PairingCode {
	code: string;
	expiresAt: string;
}

/** Options of `connect()`. */
export interface ConnectOptions {
	/**
	 * Connect without a user action, for a page whose user turned on something
	 * like "Keep AI access on" earlier (with a click): e.g. on page load or
	 * after a `disconnected` event. The library itself never reconnects.
	 */
	resume?: boolean;
}

export type ConnectionState = "disconnected" | "connecting" | "connected";

/** Why a session ended. */
export type DisconnectReason =
	/** `disconnect()` was called. */
	| "user"
	/** `newAddress()` ended the old session. */
	| "new_address"
	/** Another tab connected with the same address. */
	| "replaced"
	/** The session lifetime is over. */
	| "expired"
	/** No AI app used the tools for a long time. */
	| "idle"
	/** The relay is shutting down. */
	| "shutdown"
	/** The connection stopped answering. */
	| "heartbeat"
	/** The relay refused a message. */
	| "policy"
	| "too_large"
	| "rate_limited"
	/** The relay closed the connection for another reason. */
	| "closed"
	/** The network connection broke. */
	| "network";

export interface DisconnectDetail {
	reason: DisconnectReason;
	/** The WebSocket close code. */
	code: number;
}

/** A tool call from an AI app as it starts (the `toolcall` event). */
export interface ToolCallStart {
	/** Unique in this page; `toolcallend` carries the same id. */
	id: number;
	tool: string;
	title?: string;
	arguments: Record<string, unknown>;
	client: ToolCallClient;
}

/** How a tool call ended: `declined` by the user, `cancelled` by the AI app. */
export type ToolCallOutcome = "ok" | "error" | "declined" | "cancelled";

/** The MCP result of a tool call, as the AI app gets it. */
export interface ToolCallResult {
	content: unknown[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	[key: string]: unknown;
}

/** A tool call as it ends (the `toolcallend` event). */
export interface ToolCallEnd {
	id: number;
	tool: string;
	client: ToolCallClient;
	outcome: ToolCallOutcome;
	result: ToolCallResult;
	durationMs: number;
}

/** Events of `TabMcp`. */
export interface TabMcpEventMap {
	statechange: CustomEvent<{ state: ConnectionState }>;
	connected: CustomEvent<SessionInfo>;
	disconnected: CustomEvent<DisconnectDetail>;
	/** Another tab took over this address; `disconnected` follows. */
	replaced: CustomEvent<null>;
	/** Something went wrong outside a pending promise (e.g. a relay error message). */
	error: CustomEvent<{ error: Error }>;
	/** A new pairing code, or `null` when there is none (any more). */
	pairingcode: CustomEvent<PairingCode | null>;
	grantschange: CustomEvent<{ grants: readonly Grant[] }>;
	toolschange: CustomEvent<{ tools: readonly string[] }>;
	/** An AI app called a tool (before any confirmation). */
	toolcall: CustomEvent<ToolCallStart>;
	/** That call ended; also when the user declined it or the AI app cancelled it. */
	toolcallend: CustomEvent<ToolCallEnd>;
}
