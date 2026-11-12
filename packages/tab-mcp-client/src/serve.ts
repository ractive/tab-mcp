/**
 * The page's end of the HTTP tunnel (`docs/protocol.md`, "Tunnelled MCP
 * requests"): `http.request` and `http.cancel` in, `http.response*` out. The
 * relay connection uses it (`connection.ts`), and so does `TabMcp.serve`,
 * which answers the same messages over a port, without a relay
 * (iteration 28). Part of the lazily loaded chunk.
 */

import { pageIcons } from "./icons.ts";
import type { CallHost } from "./internal.ts";
import { type CallContext, createMcpHandler, type McpHandler } from "./mcp.ts";
import type { GrantRef, HttpRequestMessage, TabMessage } from "./protocol.ts";
import type {
	LocalClient,
	ServeHandle,
	ServeOptions,
	ServerInfo,
	TunnelPort,
} from "./types.ts";

/** What a call through the relay, a port or WebMCP needs (`mcp.ts`), from the core's host. */
export function callContext(host: CallHost): CallContext {
	return {
		tools: host.registry,
		confirm: (request) => host.confirm(request),
		observe: {
			start: (call) => host.toolCallStarted(call),
			end: (call) => host.toolCallEnded(call),
		},
	};
}

/** Response headers that are passed on (the relay drops the rest). */
const RESPONSE_HEADERS = ["content-type", "cache-control"];

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

/** The requests in flight of one channel (a relay session or a port). */
export interface Tunnel {
	/** Answer one request; nothing is sent for it once it is cancelled or the tunnel closed. */
	request(message: HttpRequestMessage): void;
	cancel(id: string): void;
	/** Abort every request in flight; later requests are ignored. */
	close(): void;
}

export function createTunnel(options: {
	handler: McpHandler;
	send(message: TabMessage): boolean;
	/** The largest piece of body text in one message (UTF-16 units), read per answer. */
	maxChunk(): number;
	/** Something failed outside the handler. */
	error(error: Error): void;
}): Tunnel {
	const { handler, send } = options;
	const inflight = new Map<string, AbortController>();
	let closed = false;

	async function run(msg: HttpRequestMessage): Promise<void> {
		const controller = new AbortController();
		inflight.set(msg.id, controller);
		const live = () =>
			!closed &&
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
			const maxChunk = options.maxChunk();
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
				options.error(
					error instanceof Error ? error : new Error(String(error)),
				);
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

	return {
		request(message) {
			if (!closed) void run(message);
		},
		cancel(id) {
			inflight.get(id)?.abort();
			inflight.delete(id);
		},
		close() {
			if (closed) return;
			closed = true;
			for (const controller of inflight.values()) controller.abort();
			inflight.clear();
		},
	};
}

/** What `serve` needs from the `TabMcp`. */
export interface ServeHost extends CallHost {
	readonly server: ServerInfo;
	error(error: Error): void;
}

/** The default and the smallest `ServeOptions.maxChunk`. */
const MAX_CHUNK = 64 * 1024;
const MIN_CHUNK = 64;
/** The longest request id, as between relay and tab. */
const MAX_ID = 128;

/** One per `serve` call: the `n` of its grant id `local:<n>`. */
let lastPort = 0;

const str = (v: unknown): v is string => typeof v === "string";

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `TabMcp.serve`: answer the tunnel's messages on `port` until `close()` or
 * `options.signal`. Every request runs as `options.client` (`kind: "local"`),
 * whatever `grant` it carries: the other end cannot pose as an AI app of the
 * relay. Throws a `TypeError` for options it cannot use.
 */
export function servePort(
	host: ServeHost,
	port: TunnelPort,
	options: ServeOptions,
): ServeHandle {
	const who = options?.client;
	if (
		!isObject(who) ||
		!str(who.id) ||
		who.id === "" ||
		(who.name !== undefined && !str(who.name))
	) {
		throw new TypeError("serve: client needs an id (and may have a name)");
	}
	const maxChunk = options.maxChunk ?? MAX_CHUNK;
	if (!Number.isInteger(maxChunk) || maxChunk < MIN_CHUNK) {
		throw new TypeError(
			`serve: maxChunk must be a whole number of at least ${MIN_CHUNK}`,
		);
	}
	if (
		typeof port?.postMessage !== "function" ||
		!("onmessage" in (port as object))
	) {
		throw new TypeError("serve: the port needs postMessage and onmessage");
	}
	const client: LocalClient = { kind: "local", id: who.id };
	if (who.name !== undefined && who.name !== "") client.name = who.name;
	const grant: GrantRef = {
		grantId: `local:${++lastPort}`,
		clientId: who.id,
		scopes: ["tools"],
	};
	let closed = false;

	const send = (message: TabMessage): boolean => {
		if (closed) return false;
		try {
			port.postMessage(message);
			return true;
		} catch {
			return false;
		}
	};
	const handler = createMcpHandler({
		...callContext(host),
		// Without `icons`, the page's own <link rel="icon">, read now.
		server: { ...host.server, icons: host.server.icons ?? pageIcons() },
		client: () => ({ ...client }),
	});
	const stopWatching = host.registry.onChange(() => handler.toolsChanged());
	const tunnel = createTunnel({
		handler,
		send,
		maxChunk: () => maxChunk,
		error: (error) => host.error(error),
	});

	const bad = (message: string, id?: unknown): void => {
		const error: TabMessage = { type: "error", code: "bad_message", message };
		if (str(id) && id.length <= MAX_ID) error.id = id;
		send(error);
	};
	const onMessage = (event: { data: unknown }): void => {
		if (closed) return;
		const m = event?.data;
		if (!isObject(m) || !str(m["type"])) {
			bad("not a message");
			return;
		}
		const id = m["id"];
		switch (m["type"]) {
			case "http.request": {
				const { method, path, headers, body } = m;
				if (
					!str(id) ||
					id === "" ||
					id.length > MAX_ID ||
					!str(method) ||
					!str(path) ||
					!path.startsWith("/") ||
					!isObject(headers) ||
					!Object.values(headers).every(str) ||
					!str(body)
				) {
					bad("malformed http.request", id);
					return;
				}
				tunnel.request({
					type: "http.request",
					id,
					method,
					path,
					headers: headers as Record<string, string>,
					body,
					grant, // never the one in the message
				});
				return;
			}
			case "http.cancel":
				if (str(id)) tunnel.cancel(id);
				else bad("malformed http.cancel");
				return;
			case "error":
				return; // never answered, so that two ends cannot answer each other for ever
			default:
				bad(`unexpected ${m["type"].slice(0, 64)}`, id);
		}
	};

	const close = (): void => {
		if (closed) return;
		closed = true;
		options.signal?.removeEventListener("abort", close);
		stopWatching();
		tunnel.close();
		handler.close();
		if (port.onmessage === onMessage) port.onmessage = null;
	};
	if (options.signal?.aborted === true) {
		close();
		return { close };
	}
	options.signal?.addEventListener("abort", close);
	port.onmessage = onMessage; // starts a MessagePort
	return { close };
}
