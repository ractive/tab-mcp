/**
 * The page's end of the HTTP tunnel (`docs/protocol.md`, "Tunnelled MCP
 * requests"): `http.request` and `http.cancel` in, `http.response*` out. The
 * relay connection uses it (`connection.ts`), and so does `TabMcp.serve`,
 * which answers the same messages over a port, without a relay
 * (iteration 28). Part of the lazily loaded chunk.
 */

import { pageIcons } from "./icons.ts";
import type { CallHost } from "./internal.ts";
import {
	type CallContext,
	createMcpHandler,
	type McpHandler,
	type ToolSource,
} from "./mcp.ts";
import type { GrantRef, HttpRequestMessage, TabMessage } from "./protocol.ts";
import type { RegisteredTool, ToolRegistry } from "./registry.ts";
import type {
	ConfirmAnswer,
	LocalClient,
	ServeHandle,
	ServeOptions,
	ServerInfo,
	ToolCaller,
	TunnelPort,
} from "./types.ts";

/**
 * The tools that callers of `kind` see (`RegisterToolOptions.callers`): to
 * the others a tool they cannot see does not exist, in `tools/list` and in
 * `tools/call` alike. Without `callers`, the relay and a port see every tool.
 * The rule for WebMCP lives in the core's `mirror` (webmcp.ts), and WebMCP
 * calls come only for the tools it mirrored. Not one shared helper: a module
 * the core and this chunk both import would split the core in two.
 */
export function toolsFor(
	registry: ToolRegistry,
	kind: "relay" | "local",
): ToolSource {
	const sees = (tool: RegisteredTool | undefined) =>
		tool && (tool.callers?.includes(kind) ?? true);
	return {
		list: () => registry.list().filter(sees),
		get: (name) => {
			const tool = registry.get(name);
			return sees(tool) ? tool : undefined;
		},
	};
}

/**
 * Calls `changed` when the list that `tools` gives changed, not on every
 * change of the registry: a tool another kind of caller sees is no news to
 * this one (`list_changed` per caller). Returns a function that stops.
 */
export function watchTools(
	registry: ToolRegistry,
	tools: ToolSource,
	changed: () => void,
): () => void {
	let last = tools.list();
	return registry.onChange(() => {
		const now = tools.list();
		if (now.length === last.length && now.every((t, i) => t === last[i]))
			return;
		last = now;
		changed();
	});
}

/** What a call of `kind` through the relay, a port or WebMCP needs (`mcp.ts`), from the core's host. */
export function callContext(host: CallHost, kind: ToolCaller): CallContext {
	return {
		tools: kind === "webmcp" ? host.registry : toolsFor(host.registry, kind),
		confirm: (request) => host.confirm(request),
		ownConfirm: host.ownConfirm(),
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

/** The relay's JSON-RPC error for a request that took too long, as `createTunnelFetch` sends it. */
const TIMEOUT = -31002;
const TIMED_OUT = "The page did not answer in time.";

/** The JSON-RPC id of a request body, for the error that answers it. */
function rpcId(body: string): string | number | null {
	try {
		const id: unknown = JSON.parse(body)?.id;
		return typeof id === "string" || typeof id === "number" ? id : null;
	} catch {
		return null;
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
	/**
	 * How long a request may take until its answer has ended
	 * (`ServeOptions.requestTimeoutMs`); none for the relay's session, whose
	 * relay has its own. A `subscriptions/listen` stream is not limited.
	 */
	timeoutMs?: number;
}): Tunnel {
	const { handler, send, timeoutMs } = options;
	const inflight = new Map<string, AbortController>();
	let closed = false;

	async function run(msg: HttpRequestMessage): Promise<void> {
		const controller = new AbortController();
		// An id that is still in flight (a relay never sends one; another end
		// of a port may): the earlier request ends here, so that it does not
		// run on unheard, out of reach of `http.cancel`.
		inflight.get(msg.id)?.abort();
		inflight.set(msg.id, controller);
		const live = () =>
			!closed &&
			inflight.get(msg.id) === controller &&
			!controller.signal.aborted;
		/**
		 * Whether an event stream has started, for the time limit's error (a
		 * body in pieces goes out in one task, which no timer interrupts).
		 */
		let started = false;
		/** The last two characters of that stream: empty or a blank line is between two events. */
		let tail = "";
		// Header names in any case, as the handler reads them (review of PR 129).
		const listen = Object.entries(msg.headers).some(
			([name, value]) =>
				name.toLowerCase() === "mcp-method" && value === "subscriptions/listen",
		);
		const timer =
			timeoutMs === undefined || listen
				? undefined
				: setTimeout(() => {
						if (!live()) return;
						// The call ends as cancelled; whatever it answers later is dropped.
						controller.abort();
						const error = JSON.stringify({
							jsonrpc: "2.0",
							id: rpcId(msg.body),
							error: { code: TIMEOUT, message: TIMED_OUT },
						});
						if (!started) {
							send({
								type: "http.response",
								id: msg.id,
								status: 200,
								headers: { "content-type": "application/json" },
								body: error,
							});
							return;
						}
						// As `createTunnelFetch` does: the error as the stream's last
						// event where it stands between two events. The handler
						// (mcp.ts) enqueues whole events and each read's text goes out
						// in one task, so the timer always finds the stream between
						// two events; the check only guards against sending an event
						// into the middle of another (review of PR 129).
						if (tail === "" || tail === "\n\n")
							send({
								type: "http.response.chunk",
								id: msg.id,
								data: `event: message\ndata: ${error}\n\n`,
							});
						send({ type: "http.response.end", id: msg.id });
					}, timeoutMs);
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
			started = true;
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			controller.signal.addEventListener("abort", () => {
				reader.cancel().catch(() => {});
			});
			for (;;) {
				const { done, value } = await reader.read();
				if (done || !live()) break;
				const text = decoder.decode(value, { stream: true });
				if (text !== "") tail = (tail + text).slice(-2);
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
			clearTimeout(timer);
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
/** The default `ServeOptions.requestTimeoutMs`, as `createTunnelFetch`'s and the relay's. */
const REQUEST_TIMEOUT_MS = 300_000;
/** The longest request id, as between relay and tab. */
const MAX_ID = 128;

/** The ports being served now. */
const served = new WeakSet<object>();

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
	const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
	// What `setTimeout` can keep: beyond it (and for Infinity) it fires at once.
	if (typeof timeoutMs !== "number" || !(timeoutMs > 0) || timeoutMs >= 2 ** 31)
		throw new TypeError(
			"serve: requestTimeoutMs must be milliseconds above 0 and below 2^31",
		);
	const ask = options.onConfirm;
	if (ask !== undefined && typeof ask !== "function")
		throw new TypeError("serve: onConfirm must be a function");
	if (
		typeof port?.postMessage !== "function" ||
		!("onmessage" in (port as object))
	) {
		throw new TypeError("serve: the port needs postMessage and onmessage");
	}
	// A second serve would take `onmessage` from the first, whose calls in
	// flight would then run on unheard and unanswered.
	if (served.has(port)) {
		throw new DOMException(
			"serve: this port is served already; close that first",
			"InvalidStateError",
		);
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
	const context = callContext(host, "local");
	// This port's own question, in place of the page's (DEC-164). Normalised
	// as the page's: anything but `true` or "unanswered" is a refusal, and a
	// throw too (`runCall`).
	if (ask !== undefined) {
		context.confirm = (request) =>
			Promise.resolve()
				.then(() => ask(request))
				.then(
					(answer): ConfirmAnswer =>
						answer === "unanswered" ? answer : answer === true,
				);
		context.ownConfirm = true;
	}
	const handler = createMcpHandler({
		...context,
		// Without `icons`, the page's own <link rel="icon">, read now.
		server: { ...host.server, icons: host.server.icons ?? pageIcons() },
		client: () => ({ ...client }),
	});
	const stopWatching = watchTools(host.registry, context.tools, () =>
		handler.toolsChanged(),
	);
	const tunnel = createTunnel({
		handler,
		send,
		maxChunk: () => maxChunk,
		error: (error) => host.error(error),
		timeoutMs,
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

	// A `MessagePort` fires `close` when its other end is gone (closed, or its
	// frame unloaded), where the browser has the event: the calls, listen
	// streams and an open confirmation end then too, not only on `close()`.
	const events = port as Partial<
		Pick<EventTarget, "addEventListener" | "removeEventListener">
	>;
	const close = (): void => {
		if (closed) return;
		options.signal?.removeEventListener("abort", close);
		events.removeEventListener?.("close", close);
		stopWatching();
		tunnel.close();
		handler.close();
		// The other end is told, so that its requests end now and not with
		// their timeout; a port that was never served hears nothing.
		if (served.delete(port)) send({ type: "bye", reason: "closed" });
		closed = true;
		if (port.onmessage === onMessage) port.onmessage = null;
	};
	if (options.signal?.aborted === true) {
		close();
		return { close };
	}
	options.signal?.addEventListener("abort", close);
	events.addEventListener?.("close", close);
	served.add(port);
	port.onmessage = onMessage; // starts a MessagePort
	return { close };
}
