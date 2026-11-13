/**
 * Public types of `@ractive-ch/tab-mcp-client`. Self-contained on purpose: the
 * published declarations must not import from other workspace packages.
 */

import type { DialogStrings } from "./strings.ts";

export type { DialogStrings };

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

/** An AI app that calls a tool through the relay, as far as the relay knows it. */
export interface RelayClient {
	kind: "relay";
	/** The grant (connected app) the call came through. */
	grantId: string;
	/** The client's id (its Client ID Metadata Document URL). */
	id: string;
	/** Self-declared name, when known from the connected apps. */
	name?: string;
	/** Host of the client id URL: the verified part. */
	host: string;
}

/**
 * An agent in this browser that calls a mirrored tool through WebMCP
 * (`webmcp: true`). Not paired and not identified: nothing more is known.
 */
export interface WebMcpClient {
	kind: "webmcp";
}

/**
 * This site's own assistant, which the page serves its tools to over a port
 * (`serve`). Not paired: the page chose who holds the other end of the port,
 * and `id` and `name` are what the page said in `serve`.
 */
export interface LocalClient {
	kind: "local";
	/** `ServeOptions.client.id`. */
	id: string;
	/** `ServeOptions.client.name`. */
	name?: string;
}

/**
 * Who calls a tool (`kind`): an AI app through the relay, an agent in the
 * browser, or this site's own assistant over a port.
 */
export type ToolCallClient = RelayClient | WebMcpClient | LocalClient;

/**
 * What `serve` talks over: a `MessagePort`, or an object of your own around
 * another channel. The messages are plain objects (`docs/protocol.md`, "The
 * tunnel without a relay"); `serve` sets `onmessage`.
 */
export interface TunnelPort {
	postMessage(message: unknown): void;
	onmessage: TunnelPortHandler | null;
}

/** `TunnelPort.onmessage` (declared as a method, so that a `MessagePort` fits). */
export type TunnelPortHandler = {
	handler(event: { data: unknown }): void;
}["handler"];

/** Options of `serve`. */
export interface ServeOptions {
	/** Who is on the other end: shown in confirmations, passed to `execute` and the events. */
	client: { id: string; name?: string };
	/** Aborting it stops serving: calls in flight are aborted, the port is let go. */
	signal?: AbortSignal;
	/**
	 * The largest piece of a response body in one message, in characters
	 * (UTF-16 units); 65536 by default, at least 64. Longer bodies are streamed.
	 */
	maxChunk?: number;
}

/** What `serve` resolves with. */
export interface ServeHandle {
	/** Stop serving this port: calls in flight are aborted, the port is let go. */
	close(): void;
}

/** Second argument of `execute`. */
export interface ToolExecuteOptions {
	/**
	 * Aborted when the caller gives up on the call or the page disconnects
	 * (a WebMCP call: when the browser cancels it).
	 */
	signal: AbortSignal;
	/** Who is calling: `client.kind` is `"relay"`, `"webmcp"` or `"local"`. */
	client: ToolCallClient;
}

/**
 * A tool in the WebMCP shape (`document.modelContext.registerTool`). `Input`
 * types `execute`'s first argument; the library checks the arguments against
 * `inputSchema` before it calls `execute`, so keep the two in step.
 */
export interface Tool<Input extends object = Record<string, unknown>> {
	/** 1–128 characters of `A–Z a–z 0–9 _ - .`. */
	name: string;
	title?: string;
	/** What the tool does, for the model. Must not be empty. */
	description: string;
	/** JSON Schema of the input object; defaults to `{ "type": "object" }`. */
	inputSchema?: JsonSchema;
	/**
	 * JSON Schema of the result object (`"type": "object"`), listed to AI apps
	 * and passed on to WebMCP. Not checked by the library. MCP wants every
	 * result of such a tool to have `structuredContent` that matches it, so
	 * `execute` should return a plain object (DEC-023), not a string.
	 */
	outputSchema?: JsonSchema;
	/** Runs the tool. Its return value becomes the result (DEC-023). */
	execute: (input: Input, options: ToolExecuteOptions) => unknown;
	annotations?: ToolAnnotations;
}

/** Options of `registerTool`. */
export interface RegisterToolOptions {
	/**
	 * Aborting it unregisters the tool. Already aborted: `registerTool`
	 * rejects with its reason and registers nothing (as WebMCP).
	 */
	signal?: AbortSignal;
	/**
	 * With `TabMcpOptions.webmcp` on: `true` also offers this tool through
	 * WebMCP when it is consequential, `false` never does. By default only
	 * tools that are not consequential (neither `consequentialHint` nor
	 * `destructiveHint`) are offered there. Ignored while `webmcp` is off.
	 */
	webmcp?: boolean;
	/**
	 * WebMCP's origins of other documents in this tab that may see the tool:
	 * passed on to the native `registerTool` of a mirrored tool, which checks
	 * it (an invalid list only warns). No effect on AI apps.
	 */
	exposedTo?: string[];
}

/** An icon the AI app may show for the page (MCP `Icon`). */
export interface Icon {
	/** An `https:` (or `http:`) URL or a `data:image/…` URI. */
	src: string;
	/** For example `"image/png"` or `"image/svg+xml"`. */
	mimeType?: string;
	/** `"48x48"`, `"any"` for SVG, …; absent: any size. */
	sizes?: string[];
	/** The background the icon is drawn for. */
	theme?: "light" | "dark";
}

/** What the page's MCP server says about itself in `server/discover`. */
export interface ServerInfo {
	name: string;
	version: string;
	title?: string;
	/**
	 * Icons the AI app may show for this page's connector. Default: the
	 * page's `<link rel="icon">` and `<link rel="apple-touch-icon">`, read
	 * when it connects; `[]` sends none. At most 8, `http(s):` or
	 * `data:image/` only.
	 */
	icons?: Icon[];
	/** Instructions for the model, e.g. how the tools fit together. */
	instructions?: string;
}

/** A part of a {@link SetupStep}'s note: plain text, or code to show as code. */
export type SetupNotePart = { text: string } | { code: string };

/**
 * How to add the page's address to one AI app, as the connect dialog shows it
 * under "How do I add it?". All strings are plain text.
 */
export interface SetupStep {
	/** The app's name as shown, such as "Claude Code". */
	app: string;
	/** What to do, a sentence or two. "Run:" when `command` follows. */
	text: string;
	/** Commands to run in a terminal, one per line, shown with a Copy button. */
	command?: string;
	/** Shown after the command (or the text): text and code, in order. */
	note?: SetupNotePart[];
}

/** Options of the library's dialogs (`TabMcpOptions.ui`). */
export interface DialogOptions {
	/**
	 * Texts of the dialogs, key by key; the rest stay English. The keys and
	 * the English texts are in `src/strings.ts`; `{name}` placeholders are
	 * filled in. Set `lang` and `dir` with the texts' language.
	 */
	strings?: Partial<DialogStrings>;
	/** The help in the connect dialog ("How do I add it?"). */
	setup?: {
		/**
		 * The link at its end; default the guide on ractive.ch, `null` for none
		 * (then pass `instructions` too: the default steps refer to the guide).
		 */
		guide?: string | null;
		/**
		 * The steps per AI app for the page's `server.name` and address;
		 * default `setupInstructions` of `@ractive-ch/tab-mcp-client/setup`.
		 */
		instructions?: (serverName: string, address: string) => SetupStep[];
	};
}

/** A consequential tool call waiting for the user's approval. */
export interface ConfirmRequest {
	tool: { name: string; title?: string; description: string };
	arguments: Record<string, unknown>;
	client: ToolCallClient;
	/** Aborted when the call is cancelled; close the question then. */
	signal: AbortSignal;
}

/**
 * The answer to a consequential tool call: `true` runs it, `false` is a
 * refusal, `"unanswered"` says the user was asked and did not answer (e.g. a
 * question of your own that timed out). The AI app is told which.
 */
export type ConfirmAnswer = boolean | "unanswered";

/** Decides whether a consequential tool may run. */
export type ConfirmHandler = (
	request: ConfirmRequest,
) => ConfirmAnswer | Promise<ConfirmAnswer>;

/** Where the address secret is kept (`localStorage` by default). */
export interface SecretStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export interface TabMcpOptions {
	/**
	 * The relay, e.g. `https://relay.example` or `wss://relay.example`.
	 * Without one the page offers its tools only through `serve` and WebMCP:
	 * `connect()`, `showConnectDialog()` and `newAddress()` reject, and no
	 * address secret is read or written.
	 */
	relay?: string;
	/** Name, version and instructions of the page's MCP server. */
	server: ServerInfo;
	/** The page's app name (e.g. `saturnus`), shown when an AI app pairs; at most 64 characters. */
	appName?: string;
	/** Approves consequential tool calls; default: a dialog in the page. */
	onConfirm?: ConfirmHandler;
	/**
	 * Offer "Allow until reload" in the default confirmation: it lets a tool
	 * run without asking for one AI app, with any arguments, until the page
	 * is reloaded or the app is disconnected; the connect dialog lists it
	 * with a reset. Off by default (DEC-096): the confirmation then shows
	 * only "Don't allow" and "Allow", and every call asks. Turn it on only
	 * for tools whose calls the user does not need to check one by one.
	 */
	alwaysAllow?: boolean;
	/** Texts and help of the library's dialogs. */
	ui?: DialogOptions;
	/**
	 * Where the address secret lives; default `localStorage`. `null` keeps it
	 * only for the page's lifetime (a new address on every visit).
	 */
	storage?: SecretStorage | null;
	/**
	 * Storage key of the secret; default `tab-mcp:secret:<relay origin>:<server.name>`
	 * (the name URI-encoded), so pages of one site with different server names get
	 * different addresses. Changing `server.name` therefore changes the address: set
	 * `storageKey` to keep it. Without it, a secret kept under 0.4's default
	 * `tab-mcp:secret:<relay origin>` is copied to the new key by the first page that
	 * connects, so that page keeps its address.
	 */
	storageKey?: string;
	/**
	 * Identity binding: returns a tab assertion from the web app's backend for
	 * the page's signed-in user and this MCP address (`request.address` is its
	 * `aud`), or `null` when nobody is signed in. Asked after every connect
	 * and by `refreshIdentity()`; only for relays whose site pairs by `oidc`.
	 */
	identityAssertion?: IdentityAssertionHandler;
	/**
	 * Connect again by itself after the connection broke (reason `network`,
	 * `heartbeat` or `shutdown`; `state` is `reconnecting` meanwhile): after
	 * about 5, 10, 20 and 40 seconds, then every 60 seconds, and at once when
	 * the tab comes back to the front or the network returns. On by default;
	 * `false` leaves it to the page.
	 */
	reconnect?: boolean;
	/**
	 * Also register the tools with the browser's own WebMCP
	 * (`document.modelContext.registerTool()`), where it has it, so that agents
	 * in the browser can call them, without pairing. Off by default. Tools
	 * marked `consequentialHint` or `destructiveHint` are left out unless
	 * registered with `{ webmcp: true }`: an agent that drives this tab can
	 * click Allow in the page's confirmation itself. A failed native
	 * registration only warns in the console.
	 */
	webmcp?: boolean;
}

/** The library is reconnecting by itself (`state` is `reconnecting`). */
export interface ReconnectingInfo {
	/** Why the connection ended. */
	reason: DisconnectReason;
	/** The number of the next (or running) attempt, from 1. */
	attempt: number;
	/** When that attempt starts, in milliseconds since the epoch (`Date.now()`). */
	at: number;
}

/** What the page's identity hook gets. */
export interface IdentityAssertionRequest {
	/** The MCP address: the assertion's `aud`. */
	address: string;
	/** The session the assertion is for. */
	sessionId: string;
}

export type IdentityAssertionHandler = (
	request: IdentityAssertionRequest,
) => string | null | undefined | Promise<string | null | undefined>;

/** Who the relay knows as the page's user (identity binding). */
export type IdentityState =
	/** No assertion was sent (not asked, signed out, or a `code` relay). */
	| "none"
	/** Asked the hook or waiting for the relay. */
	| "pending"
	/** The relay accepted the assertion. */
	| "bound"
	/** The relay refused it (`message` says why). */
	| "refused";

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
	/** How AI apps pair: a code shown here, or the same sign-in (`oidc`). */
	pairing: "code" | "oidc";
	expiresAt: string;
	limits: Limits;
}

/** Why the relay sent a pairing code (`PairingCode.reason`). */
export type PairingCodeReason = "start" | "used" | "locked" | "expired";

/** A pairing code to show (DEC-028). */
export interface PairingCode {
	code: string;
	expiresAt: string;
	/**
	 * Why it came: `start` (the dialog opened), `used` (the last code was
	 * entered: an AI app is about to connect), `locked` (the last one had too
	 * many wrong tries), `expired` (it timed out). Missing from older relays.
	 */
	reason?: PairingCodeReason;
}

/** Options of `connect()`. */
export interface ConnectOptions {
	/**
	 * Connect without a user action, for a page whose user turned on something
	 * like "Keep AI access on" earlier (with a click): e.g. on page load or
	 * after a `disconnected` event without `reconnect`.
	 */
	resume?: boolean;
}

/**
 * The connection to the relay. `reconnecting`: it broke, and the library
 * connects again by itself (waiting for the next attempt or making it;
 * `TabMcp.reconnecting` says which attempt and when).
 */
export type ConnectionState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "reconnecting";

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
	/**
	 * The relay is shutting down or restarting (also close codes 1001, 1011,
	 * 1012 and 1013, which a proxy in front of it sends).
	 */
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

/** The `statechange` event. */
export interface StateChangeDetail {
	state: ConnectionState;
	/**
	 * Why it ended: on the change from `connected` (to `disconnected`, or to
	 * `reconnecting` when the connection broke), and when `disconnect()` or
	 * `newAddress()` ends connecting or reconnecting (`user`, `new_address`).
	 */
	reason?: DisconnectReason;
}

/** The `replaced` event: who took over the page's address. */
export interface ReplacedDetail {
	/**
	 * `true`: a tab of the same page in this browser said, just before, that it
	 * took over the address; the usual, harmless cause ("Opened in another
	 * tab"). `false`: no such tab was heard (or the browser has no
	 * `BroadcastChannel`), so it may be a program with a copy of the address
	 * secret, and the AI apps paired with the address now talk to it. Offer
	 * `newAddress()`, which takes the address back and disconnects them
	 * (DEC-095). Script on the page's origin can make a takeover look like a
	 * sibling, so `true` is a hint, not a proof.
	 */
	sibling: boolean;
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

/**
 * How a tool call ended: `declined` by the user, `unanswered` (the user was
 * asked and did not answer, see `ConfirmAnswer`), `cancelled` by the AI app.
 */
export type ToolCallOutcome =
	| "ok"
	| "error"
	| "declined"
	| "unanswered"
	| "cancelled";

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

/**
 * Events of `TabMcp`. Every detail is an object; a change event names the
 * new values like the properties they change (`grantschange` has `grants`,
 * the value of `mcp.grants`), and a value that is gone is `undefined`.
 */
export interface TabMcpEventMap {
	/**
	 * `state` changed (`session` with it), or, while `reconnecting`, the next
	 * attempt was scheduled (`mcp.reconnecting`). A refusal that stops
	 * reconnecting comes as `error` just before the change to `disconnected`.
	 */
	statechange: CustomEvent<StateChangeDetail>;
	/**
	 * Another tab, or a program with this page's address secret, took over
	 * the address. It follows the `statechange` with reason `replaced`, up to
	 * a second later while the library listens for a sibling tab. `sibling`
	 * says which it probably was.
	 */
	replaced: CustomEvent<ReplacedDetail>;
	/** Something went wrong outside a pending promise (e.g. a relay error message). */
	error: CustomEvent<{ error: Error }>;
	/** A new pairing code, or `undefined` when there is none (any more). */
	pairingcode: CustomEvent<{ pairingCode: PairingCode | undefined }>;
	grantschange: CustomEvent<{ grants: readonly Grant[] }>;
	/** The relay accepted or refused the page's identity, or it was cleared. */
	identitychange: CustomEvent<{
		identity: IdentityState;
		identityMessage: string | undefined;
	}>;
	toolschange: CustomEvent<{ tools: readonly string[] }>;
	/** An AI app called a tool (before any confirmation). */
	toolcall: CustomEvent<ToolCallStart>;
	/** That call ended; also when the user declined it, did not answer, or the AI app cancelled it. */
	toolcallend: CustomEvent<ToolCallEnd>;
}
