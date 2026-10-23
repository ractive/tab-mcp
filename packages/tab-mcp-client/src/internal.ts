/**
 * The seam between the eager core (`tab-mcp.ts`) and the lazily loaded
 * connection (`connection.ts`). Types only, so importing it costs nothing.
 */

import type { GrantRef, SessionMessage, TabMessage } from "./protocol.ts";
import type { ToolRegistry } from "./registry.ts";
import type {
	ConfirmRequest,
	DisconnectReason,
	Grant,
	PairingCode,
	ServerInfo,
	SessionInfo,
	ToolCallClient,
	ToolCallEnd,
	ToolCallStart,
} from "./types.ts";

/** What a connection needs from the `TabMcp` that opened it. */
export interface ConnectionHost {
	readonly registry: ToolRegistry;
	readonly server: ServerInfo;
	readonly appName: string | undefined;
	/** Sent in `hello`. */
	readonly library: { name: string; version: string };
	/** Ask the user about a consequential tool call. */
	confirm(request: ConfirmRequest): Promise<boolean>;
	/** A tool call started or ended (the `toolcall` and `toolcallend` events). */
	toolCallStarted(call: ToolCallStart): void;
	toolCallEnded(call: ToolCallEnd): void;
	/** The caller of a tunnelled request, with the name from the grants list. */
	clientFor(grant: GrantRef): ToolCallClient;
	/** The relay accepted the session; returns what `connect()` resolves with. */
	sessionStarted(session: SessionMessage): SessionInfo;
	pairingCode(code: PairingCode): void;
	grantAdded(grant: Grant): void;
	grantRemoved(grantId: string): void;
	replaced(): void;
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
