/**
 * The seam between the eager core (`tab-mcp.ts`) and the lazily loaded
 * connection (`connection.ts`). Types only, so importing it costs nothing.
 */

import type { GrantRef, SessionMessage, TabMessage } from "./protocol.ts";
import type { ToolRegistry } from "./registry.ts";
import type {
	ConfirmAnswer,
	ConfirmHandler,
	ConfirmRequest,
	DisconnectReason,
	Grant,
	PairingCode,
	RelayMessages,
	ReplacedDetail,
	ServerInfo,
	SessionInfo,
	ToolCallClient,
	ToolCallEnd,
	ToolCallStart,
} from "./types.ts";

/** What a tool call needs from the `TabMcp`, through the relay or WebMCP. */
export interface CallHost {
	readonly registry: ToolRegistry;
	/** Ask the user about a consequential tool call. */
	confirm(request: ConfirmRequest): Promise<ConfirmAnswer>;
	/**
	 * The page's own `onConfirm`, if it has one: it asks, not the library's
	 * dialog in the tab. For an unvouched WebMCP call it is the only check
	 * (DEC-215).
	 */
	onConfirm(): ConfirmHandler | undefined;
	/** A tool call started or ended (the `toolcall` and `toolcallend` events). */
	toolCallStarted(call: ToolCallStart): void;
	toolCallEnded(call: ToolCallEnd): void;
}

/** What a connection needs from the `TabMcp` that opened it. */
export interface ConnectionHost extends CallHost {
	readonly server: ServerInfo;
	/** The app id: the `<app>` of the page's address `/s/<app>/mcp` (DEC-196). */
	readonly app: string;
	readonly appName: string | undefined;
	/**
	 * The `BroadcastChannel` of the tabs that share this page's secret
	 * (DEC-095); `undefined` when the secret is not shared (`storage: null`).
	 */
	readonly tabs: string | undefined;
	/** Sent in `hello`. */
	readonly library: { name: string; version: string };
	/** `TabMcpOptions.relayMessages`: its capabilities go into `hello`. */
	readonly extra: RelayMessages | undefined;
	/** The caller of a tunnelled request, with the name from the grants list. */
	clientFor(grant: GrantRef): ToolCallClient;
	/** The relay accepted the session; returns what `connect()` resolves with. */
	sessionStarted(session: SessionMessage): SessionInfo;
	pairingCode(code: PairingCode): void;
	/** `pairing.open`: a sign-in pairs the page until `until` (DEC-202). */
	pairingOpen(until: string): void;
	grantAdded(grant: Grant): void;
	grantRemoved(grantId: string): void;
	/** Another tab or program took over the address (reported once, before `closed`). */
	replaced(detail: ReplacedDetail): void;
	/** The relay accepted the page's identity assertion, or refused it. */
	/** The relay's answer to the `identity` with this `round` (undefined from a relay that does not echo it). */
	identityResult(
		bound: boolean,
		round: number | undefined,
		message?: string,
	): void;
	error(error: Error): void;
	/** The session is over (only after `sessionStarted`). */
	closed(reason: DisconnectReason, code: number): void;
}

/** The core's handle on an open connection. */
export interface ConnectionHandle {
	/** Resolves with the session, rejects if the connection fails first. */
	readonly ready: Promise<SessionInfo>;
	send(message: TabMessage): boolean;
	/** Say `bye` and close. */
	close(reason: DisconnectReason): void;
}
