/**
 * The lazily loaded part (DEC-035): the WebSocket session with the relay, the
 * HTTP tunnel and the MCP handler. Loaded by `TabMcp.connect()`.
 */

import type { ConnectionHandle, ConnectionHost } from "./internal.ts";
import { createMcpHandler } from "./mcp.ts";
import {
	type HttpRequestMessage,
	parseRelayMessage,
	type RelayMessage,
	SUBPROTOCOL,
	type TabMessage,
} from "./protocol.ts";
import type { DisconnectReason, SessionInfo } from "./types.ts";

/** How long `connect()` waits for the relay's `session`. */
const CONNECT_TIMEOUT_MS = 15_000;

const CLOSE_REASONS: Record<number, DisconnectReason> = {
	1000: "closed",
	1008: "policy",
	1009: "too_large",
	4001: "expired",
	4002: "idle",
	4003: "heartbeat",
	4004: "shutdown",
	4005: "replaced",
	4008: "rate_limited",
};

const BYE_REASONS: Record<string, DisconnectReason> = {
	replaced: "replaced",
	expired: "expired",
	idle: "idle",
	shutdown: "shutdown",
};

/** Response headers the relay passes on (it drops the rest). */
const RESPONSE_HEADERS = ["content-type", "cache-control"];

function pageTitle(): string {
	const title = (globalThis as { document?: { title?: unknown } }).document
		?.title;
	return typeof title === "string" ? title.slice(0, 300) : "";
}

function frameInfo(text: string): { type: string; id?: string } | undefined {
	try {
		const v = JSON.parse(text) as Record<string, unknown>;
		if (typeof v !== "object" || v === null || typeof v["type"] !== "string")
			return undefined;
		return typeof v["id"] === "string"
			? { type: v["type"], id: v["id"] }
			: { type: v["type"] };
	} catch {
		return undefined;
	}
}

const KNOWN_TYPES = new Set([
	"session",
	"ping",
	"bye",
	"http.request",
	"http.cancel",
	"pairing.code",
	"grant.added",
	"grant.removed",
	"error",
]);

/**
 * Split text into pieces of at most `max` UTF-16 units, never between the two
 * halves of a surrogate pair (a lone half would not survive JSON and UTF-8).
 */
export function* pieces(text: string, max: number): Generator<string> {
	let i = 0;
	while (i < text.length) {
		let end = Math.min(i + max, text.length);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd800 && last <= 0xdbff) {
			end += end - 1 > i ? -1 : 1; // keep the pair together
		}
		yield text.slice(i, end);
		i = end;
	}
}

/** Open the WebSocket and run the session. */
export function openConnection(
	host: ConnectionHost,
	url: string,
	secret: string,
): ConnectionHandle {
	const ws = new WebSocket(url, SUBPROTOCOL);
	const inflight = new Map<string, AbortController>();
	let state: "opening" | "ready" | "closed" = "opening";
	let byeReason: DisconnectReason | undefined;
	let maxChunk = 64 * 1024;
	let heartbeat: ReturnType<typeof setTimeout> | undefined;
	let heartbeatMs = 0;

	let resolveReady!: (session: SessionInfo) => void;
	let rejectReady!: (error: Error) => void;
	const ready = new Promise<SessionInfo>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	ready.catch(() => {}); // the caller handles it; never an unhandled rejection here
	const connectTimer = setTimeout(() => {
		fail(new Error("The relay did not answer in time."));
	}, CONNECT_TIMEOUT_MS);

	const handler = createMcpHandler({
		tools: host.registry,
		server: host.server,
		confirm: (request) => host.confirm(request),
		client: (grant) => host.clientFor(grant),
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
		for (const controller of inflight.values()) controller.abort();
		inflight.clear();
		handler.close();
		if (wasReady) {
			const reason =
				byeReason ??
				CLOSE_REASONS[code] ??
				(code === 1006 ? "network" : "closed");
			host.closed(reason, code);
		}
	}

	async function tunnel(msg: HttpRequestMessage): Promise<void> {
		const controller = new AbortController();
		inflight.set(msg.id, controller);
		const live = () =>
			state === "ready" &&
			inflight.get(msg.id) === controller &&
			!controller.signal.aborted;
		try {
			const request = new Request(`https://tab.invalid${msg.path}`, {
				method: msg.method,
				headers: msg.headers,
				signal: controller.signal,
			});
			const response = await handler.handle(request, {
				grant: msg.grant,
				body: msg.body,
			});
			if (!live()) {
				await response.body?.cancel().catch(() => {});
				return;
			}
			const headers: Record<string, string> = {};
			for (const name of RESPONSE_HEADERS) {
				const value = response.headers.get(name);
				if (value !== null) headers[name] = value;
			}
			const streamed = (headers["content-type"] ?? "").startsWith(
				"text/event-stream",
			);
			if (!streamed || response.body === null) {
				const body = await response.text();
				if (!live()) return;
				if (body.length <= maxChunk) {
					send({
						type: "http.response",
						id: msg.id,
						status: response.status,
						headers,
						body,
					});
					return;
				}
				// Too big for one message: stream it (the relay passes it on whole).
				send({
					type: "http.response.start",
					id: msg.id,
					status: response.status,
					headers,
				});
				for (const data of pieces(body, maxChunk)) {
					if (!live()) break;
					send({ type: "http.response.chunk", id: msg.id, data });
				}
				if (live()) send({ type: "http.response.end", id: msg.id });
				return;
			}
			send({
				type: "http.response.start",
				id: msg.id,
				status: response.status,
				headers,
			});
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			controller.signal.addEventListener("abort", () => {
				reader.cancel().catch(() => {});
			});
			for (;;) {
				const { done, value } = await reader.read();
				if (done || !live()) break;
				const text = decoder.decode(value, { stream: true });
				for (const data of pieces(text, maxChunk)) {
					send({ type: "http.response.chunk", id: msg.id, data });
				}
			}
			if (live()) send({ type: "http.response.end", id: msg.id });
		} catch (error) {
			if (live()) {
				host.error(error instanceof Error ? error : new Error(String(error)));
				send({
					type: "http.response",
					id: msg.id,
					status: 500,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: null,
						error: { code: -32603, message: "Internal server error" },
					}),
				});
			}
		} finally {
			if (inflight.get(msg.id) === controller) inflight.delete(msg.id);
		}
	}

	function onMessage(message: RelayMessage): void {
		if (state === "opening") {
			if (message.type === "session") {
				state = "ready";
				clearTimeout(connectTimer);
				heartbeatMs = message.limits.heartbeatMs;
				// Room for JSON escaping and the envelope within maxMessageBytes.
				maxChunk = Math.max(
					1024,
					Math.floor((message.limits.maxMessageBytes - 1024) / 6),
				);
				armHeartbeat();
				resolveReady(host.sessionStarted(message));
			} else if (message.type === "error") {
				fail(
					new Error(
						`The relay refused the connection: ${message.message || message.code}`,
					),
				);
			} else if (message.type === "bye") {
				fail(new Error(`The relay ended the connection: ${message.reason}`));
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
				void tunnel(message);
				return;
			case "http.cancel":
				inflight.get(message.id)?.abort();
				inflight.delete(message.id);
				return;
			case "pairing.code":
				host.pairingCode({ code: message.code, expiresAt: message.expiresAt });
				return;
			case "grant.added":
				host.grantAdded(message.grant);
				return;
			case "grant.removed":
				host.grantRemoved(message.grantId);
				return;
			case "bye":
				byeReason = BYE_REASONS[message.reason] ?? "closed";
				if (byeReason === "replaced") host.replaced();
				return;
			case "error":
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
			fail(new Error(`The relay speaks ${ws.protocol}, not ${SUBPROTOCOL}.`));
			return;
		}
		const hello: TabMessage = {
			type: "hello",
			library: host.library,
			page: { title: pageTitle() },
			secret,
		};
		if (host.appName !== undefined) hello.app = { name: host.appName };
		send(hello);
	});
	ws.addEventListener("message", (event: MessageEvent) => {
		if (typeof event.data !== "string") return;
		const message = parseRelayMessage(event.data);
		if (message !== undefined) {
			if (state === "ready") armHeartbeat(); // any traffic shows the link is alive
			onMessage(message);
			return;
		}
		const info = frameInfo(event.data);
		if (info?.id !== undefined) {
			send(
				KNOWN_TYPES.has(info.type)
					? {
							type: "error",
							code: "bad_message",
							message: `malformed ${info.type}`,
							id: info.id,
						}
					: {
							type: "error",
							code: "unknown_type",
							message: `unknown type ${info.type}`,
							id: info.id,
						},
			);
		}
	});
	ws.addEventListener("close", (event: CloseEvent) => {
		if (state === "opening") {
			finish(event.code);
			rejectReady(
				new Error(
					event.code === 1006
						? "Could not connect to the relay (refused, unreachable, or this page's origin is not allowed)."
						: `The relay closed the connection (${event.code}${event.reason ? `: ${event.reason}` : ""}).`,
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
