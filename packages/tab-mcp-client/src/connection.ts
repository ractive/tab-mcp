/**
 * The lazily loaded part (DEC-035): the WebSocket session with the relay, the
 * HTTP tunnel and the MCP handler. Loaded by `TabMcp.connect()`.
 */

import { pageIcons } from "./icons.ts";
import type { CallHost, ConnectionHandle, ConnectionHost } from "./internal.ts";
import { createMcpHandler, webMcpCall } from "./mcp.ts";
import {
	parseRelayMessage,
	type RelayMessage,
	SUBPROTOCOL,
	type TabMessage,
} from "./protocol.ts";
import type { RegisteredTool } from "./registry.ts";
import { callContext, createTunnel } from "./serve.ts";
import type { DisconnectReason, SessionInfo } from "./types.ts";

/** For the core: the address id in the `/tab` URL (DEC-098). */
export { addressIdOf, withAddress } from "./address.ts";
/** For the core: compiles the schemas once this chunk (and the validator) is loaded. */
export { compileRegistry } from "./mcp.ts";
/** For the core: `TabMcp.serve`, the tunnel over a port (iteration 28). */
export { pieces, servePort } from "./serve.ts";

/**
 * For the core: a WebMCP call of a mirrored tool (iteration 25), on the
 * same path as an AI app's (`webMcpCall` in `mcp.ts`).
 */
export function callFromWebMcp(
	host: CallHost,
	tool: RegisteredTool,
	input: unknown,
	signal: unknown,
): Promise<unknown> {
	return webMcpCall(callContext(host), tool, input, signal);
}

/** How long `connect()` waits for the relay's `session`. */
const CONNECT_TIMEOUT_MS = 15_000;

const CLOSE_REASONS: Record<number, DisconnectReason> = {
	1000: "closed",
	/**
	 * Going away, internal error, service restart, try again later: what a
	 * proxy or platform in front of the relay sends when the relay behind it
	 * restarts without its own `bye`. Reconnecting may help.
	 */
	1001: "shutdown",
	1008: "policy",
	1009: "too_large",
	1011: "shutdown",
	1012: "shutdown",
	1013: "shutdown",
	4001: "expired",
	4002: "idle",
	4003: "heartbeat",
	4004: "shutdown",
	4005: "replaced",
	4008: "rate_limited",
	/** The URL's address id is not the secret's (DEC-098): retrying cannot help. */
	4009: "policy",
};

const BYE_REASONS: Record<string, DisconnectReason> = {
	replaced: "replaced",
	expired: "expired",
	idle: "idle",
	shutdown: "shutdown",
};

/**
 * An error of `ready` that says why the connection did not open, so that
 * reconnecting retries only what may get better (DEC-082).
 */
function refused(message: string, reason: DisconnectReason): Error {
	return Object.assign(new Error(message), { reason });
}

/**
 * Room for a message's envelope (`http.response` with its headers, or a
 * chunk) with an id of up to 128 characters (protocol limit).
 */
const ENVELOPE_BYTES = 512;
/** Worst case per UTF-16 unit once JSON-encoded as UTF-8: `\u0001` is 6 bytes. */
const WORST_BYTES_PER_UNIT = 6;
const MIN_CHUNK_UNITS = 64;
export const MIN_MESSAGE_BYTES: number =
	ENVELOPE_BYTES + WORST_BYTES_PER_UNIT * MIN_CHUNK_UNITS;

/**
 * The largest piece of body text (UTF-16 units) whose message cannot exceed
 * the relay's `maxMessageBytes`; `undefined` if the limit is too small to
 * frame anything useful.
 */
export function chunkSize(maxMessageBytes: number): number | undefined {
	const units = Math.floor(
		(maxMessageBytes - ENVELOPE_BYTES) / WORST_BYTES_PER_UNIT,
	);
	return units >= MIN_CHUNK_UNITS ? units : undefined;
}

/**
 * How long after a sibling tab's `claimed` a `replaced` counts as caused by
 * it (DEC-095). That tab posts it when the relay accepted its session, which
 * is when the relay ended this one.
 */
export const SIBLING_WINDOW_MS = 10_000;

/**
 * How long a replaced tab that heard no `claimed` yet waits for one before it
 * reports `replaced`: the sibling's session and this tab's `bye` leave the
 * relay at about the same time, so the message usually comes after the `bye`.
 */
export const SIBLING_GRACE_MS = 1_000;

/**
 * The tabs of one page (same relay, same storage key) tell each other on a
 * `BroadcastChannel` when the relay accepted their claim of an address
 * (`claimed`, once their `session` arrived), so that a replaced tab can tell
 * a sibling from an impostor. A sibling whose `hello` failed says nothing.
 * The message carries the address id (as in the `/tab` URL; no secret), and
 * only a claim of this tab's own address, heard after this tab's own
 * `session`, counts: one heard while this tab was still connecting, or from
 * a tab on another address (after `newAddress()` there), cannot have caused
 * the replacement (CC 5). A claim without an address, from a tab still on a
 * library up to 0.15, counts as before. Without `BroadcastChannel` nothing is heard, and
 * every `replaced` counts as unknown.
 */
function siblingTabs(
	name: string | undefined,
	address: string | undefined,
): {
	/** The own session arrived: say so, and listen to the others from now on. */
	claimed(): void;
	/** `true` once `claimed` was heard in the window, `false` after the grace. */
	heard(): Promise<boolean>;
	close(): void;
} {
	let channel: BroadcastChannel | undefined;
	let listening = false;
	let at = Number.NEGATIVE_INFINITY;
	let onClaim: (() => void) | undefined;
	try {
		if (name !== undefined && typeof BroadcastChannel === "function") {
			channel = new BroadcastChannel(name);
			channel.onmessage = (event: MessageEvent) => {
				const data = event.data as { type?: unknown; address?: unknown } | null;
				// No address: a tab with a library up to 0.15, while both run.
				if (
					!listening ||
					data?.type !== "claimed" ||
					(data.address !== undefined && data.address !== address)
				)
					return;
				at = Date.now();
				onClaim?.();
			};
		}
	} catch {
		channel = undefined; // e.g. an opaque origin
	}
	return {
		claimed() {
			listening = true;
			try {
				channel?.postMessage({ type: "claimed", address });
			} catch {
				// closed or not allowed: the other tab counts it as unknown
			}
		},
		heard() {
			if (Date.now() - at <= SIBLING_WINDOW_MS) return Promise.resolve(true);
			if (channel === undefined) return Promise.resolve(false);
			return new Promise((resolve) => {
				const timer = setTimeout(() => resolve(false), SIBLING_GRACE_MS);
				onClaim = () => {
					clearTimeout(timer);
					resolve(true);
				};
			});
		},
		close() {
			channel?.close();
		},
	};
}

/**
 * Open the WebSocket and run the session. `address`: the secret's address id
 * (`addressIdOf`). `revokeAll`: take the address back (DEC-095); the relay
 * revokes every grant as it claims the address, and its `session` lists none.
 */
export function openConnection(
	host: ConnectionHost,
	url: string,
	secret: string,
	options: { address?: string | undefined; revokeAll?: boolean } = {},
): ConnectionHandle {
	const revokeAll = options.revokeAll === true;
	const ws = new WebSocket(url, SUBPROTOCOL);
	let state: "opening" | "ready" | "closed" = "opening";
	let byeReason: DisconnectReason | undefined;
	let maxChunk = 64 * 1024;
	/** The relay's limit on a response body (CC 7); known once `session` came. */
	let maxBodyBytes: number | undefined;
	let heartbeat: ReturnType<typeof setTimeout> | undefined;
	let heartbeatMs = 0;
	const siblings = siblingTabs(host.tabs, options.address);

	let resolveReady!: (session: SessionInfo) => void;
	let rejectReady!: (error: Error) => void;
	const ready = new Promise<SessionInfo>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	ready.catch(() => {}); // the caller handles it; never an unhandled rejection here
	const connectTimer = setTimeout(() => {
		fail(refused("The relay did not answer in time.", "network"));
	}, CONNECT_TIMEOUT_MS);

	const handler = createMcpHandler({
		...callContext(host),
		// Without `icons`, the page's own <link rel="icon">, read now.
		server: { ...host.server, icons: host.server.icons ?? pageIcons() },
		client: (grant) => host.clientFor(grant),
		maxBodyBytes: () => maxBodyBytes,
	});
	const stopWatching = host.registry.onChange(() => handler.toolsChanged());

	function send(message: TabMessage): boolean {
		if (ws.readyState !== WebSocket.OPEN) return false;
		try {
			ws.send(JSON.stringify(message));
			return true;
		} catch {
			return false;
		}
	}

	/** Two missed pings mean the connection is dead (protocol: heartbeat). */
	function armHeartbeat(): void {
		if (heartbeatMs <= 0) return;
		clearTimeout(heartbeat);
		heartbeat = setTimeout(() => {
			byeReason ??= "heartbeat";
			finish(4003);
			try {
				ws.close();
			} catch {
				// already closing
			}
		}, heartbeatMs * 2.5);
	}

	function fail(error: Error): void {
		if (state !== "opening") return;
		finish(0);
		rejectReady(error);
		try {
			ws.close();
		} catch {
			// already closed
		}
	}

	/** The session is over: clean up once and tell the host. */
	function finish(code: number): void {
		if (state === "closed") return;
		const wasReady = state === "ready";
		state = "closed";
		clearTimeout(connectTimer);
		clearTimeout(heartbeat);
		stopWatching();
		tunnel.close();
		handler.close();
		if (wasReady) {
			const reason =
				byeReason ??
				CLOSE_REASONS[code] ??
				(code === 1006 ? "network" : "closed");
			// Over at once; only the detail of `replaced` waits for a sibling's
			// `claimed`, which comes a moment after the `bye` (DEC-095).
			host.closed(reason, code);
			if (reason === "replaced") {
				void siblings.heard().then((sibling) => {
					siblings.close();
					host.replaced({ sibling });
				});
				return;
			}
		}
		siblings.close();
	}

	const tunnel = createTunnel({
		handler,
		send,
		maxChunk: () => maxChunk,
		error: (error) => host.error(error),
	});

	function onMessage(message: RelayMessage): void {
		if (state === "opening") {
			if (message.type === "session") {
				const chunk = chunkSize(message.limits.maxMessageBytes);
				if (chunk === undefined) {
					fail(
						refused(
							`The relay's message limit (${message.limits.maxMessageBytes} bytes) is too small; tab-mcp needs at least ${MIN_MESSAGE_BYTES}.`,
							"policy",
						),
					);
					return;
				}
				if (revokeAll && message.grants.length > 0) {
					// A relay older than 0.5 ignores hello.revokeAll and lists the
					// grants: the address was not taken back (DEC-136).
					fail(
						refused(
							"The relay did not revoke the address's grants (it needs tab-mcp 0.5 or later).",
							"policy",
						),
					);
					return;
				}
				maxChunk = chunk;
				maxBodyBytes = message.limits.maxBodyBytes;
				state = "ready";
				clearTimeout(connectTimer);
				heartbeatMs = message.limits.heartbeatMs;
				armHeartbeat();
				siblings.claimed();
				resolveReady(host.sessionStarted(message));
			} else if (message.type === "error") {
				fail(
					refused(
						`The relay refused the connection: ${message.message || message.code}`,
						message.code === "rate_limited" ? "rate_limited" : "policy",
					),
				);
			} else if (message.type === "bye") {
				fail(
					refused(
						`The relay ended the connection: ${message.reason}`,
						BYE_REASONS[message.reason] ?? "closed",
					),
				);
			}
			return;
		}
		if (state !== "ready") return;
		switch (message.type) {
			case "ping":
				armHeartbeat();
				send({ type: "pong", t: message.t });
				return;
			case "http.request":
				tunnel.request(message);
				return;
			case "http.cancel":
				tunnel.cancel(message.id);
				return;
			case "pairing.code":
				host.pairingCode(
					message.reason === undefined
						? { code: message.code, expiresAt: message.expiresAt }
						: {
								code: message.code,
								expiresAt: message.expiresAt,
								reason: message.reason,
							},
				);
				return;
			case "grant.added":
				host.grantAdded(message.grant);
				return;
			case "grant.removed":
				host.grantRemoved(message.grantId);
				return;
			case "identity.bound":
				host.identityResult(true, message.round);
				return;
			case "bye":
				byeReason = BYE_REASONS[message.reason] ?? "closed";
				// Taken over: over at once, not when the socket closes (review of PR 39).
				if (byeReason === "replaced") finish(4005);
				return;
			case "error":
				if (message.code === "identity_refused") {
					host.identityResult(
						false,
						typeof message.round === "number" ? message.round : undefined,
						message.message,
					);
					return;
				}
				host.error(
					new Error(`Relay error ${message.code}: ${message.message}`),
				);
				return;
			case "session":
				return; // only once
		}
	}

	ws.addEventListener("open", () => {
		if (ws.protocol !== "" && ws.protocol !== SUBPROTOCOL) {
			fail(
				refused(
					`The relay speaks ${ws.protocol}, not ${SUBPROTOCOL}.`,
					"policy",
				),
			);
			return;
		}
		const hello: TabMessage = {
			type: "hello",
			library: host.library,
			// The relay never read the title (CC 6); relays up to 0.9 still
			// require the field.
			page: { title: "" },
			secret,
		};
		if (host.appName !== undefined) hello.app = { name: host.appName };
		if (revokeAll) hello.revokeAll = true;
		send(hello);
	});
	ws.addEventListener("message", (event: MessageEvent) => {
		if (typeof event.data !== "string") return;
		// A frame the tab cannot read is dropped without an answer (CC 15): the
		// relay only logged one, and its request ends at its own timeout.
		const message = parseRelayMessage(event.data);
		if (message === undefined) return;
		if (state === "ready") armHeartbeat(); // any traffic shows the link is alive
		onMessage(message);
	});
	ws.addEventListener("close", (event: CloseEvent) => {
		if (state === "opening") {
			finish(event.code);
			// No WebSocket at all: browsers say 1006, Bun 1002. The page cannot
			// tell a refused origin from an unreachable relay (DEC-082).
			const unreachable = event.code === 1006 || event.code === 1002;
			rejectReady(
				refused(
					unreachable
						? "Could not connect to the relay (refused, unreachable, or this page's origin is not allowed)."
						: `The relay closed the connection (${event.code}${event.reason ? `: ${event.reason}` : ""}).`,
					CLOSE_REASONS[event.code] ?? (unreachable ? "network" : "closed"),
				),
			);
			return;
		}
		finish(event.code);
	});

	return {
		ready,
		send,
		close(reason: DisconnectReason) {
			if (state === "closed") return;
			if (state === "opening") {
				fail(
					new DOMException(
						"The connection was cancelled",
						"AbortError",
					) as Error,
				);
				return;
			}
			byeReason = reason;
			send({ type: "bye", reason: "user" });
			finish(1000);
			try {
				ws.close(1000, "bye");
			} catch {
				// already closed
			}
		},
	};
}
