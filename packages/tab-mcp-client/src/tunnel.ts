/**
 * `@ractive-ch/tab-mcp-client/tunnel`: the other end of `TabMcp.serve`
 * (iteration 28). A `fetch` function that sends each request as an
 * `http.request` message over a channel of your own (for example a
 * WebSocket from your backend to a chat in the page) and builds the
 * `Response` from the page's `http.response*` messages, so an MCP client
 * reaches the page's tools without a relay:
 *
 * ```ts
 * const tunnel = createTunnelFetch({ send: (message) => socket.send(JSON.stringify(message)) });
 * socket.onmessage = (event) => tunnel.receive(JSON.parse(event.data));
 * socket.onclose = () => tunnel.close();
 * new StreamableHTTPClientTransport(new URL("https://tab.invalid/mcp"), { fetch: tunnel.fetch });
 * ```
 *
 * It needs only `Request`, `Response` and web streams: no DOM, and nothing of
 * Bun or Node. It shares no code with the page's library.
 */

/** One HTTP request for the page (`docs/protocol.md`; without the relay's `grant`). */
export interface TunnelRequestMessage {
	type: "http.request";
	/** Unique per `createTunnelFetch`. */
	id: string;
	method: string;
	/** Path and query, e.g. `/mcp`. */
	path: string;
	/** Lower-case names; only the headers the protocol passes on. */
	headers: Record<string, string>;
	body: string;
}

/** The caller gave up on a request: the page stops and sends nothing more for it. */
export interface TunnelCancelMessage {
	type: "http.cancel";
	id: string;
	reason: "client_closed" | "timeout" | "error";
}

export interface TunnelFetchOptions {
	/**
	 * Sends one message to the page's `serve` (in order, as plain objects on
	 * a port, or as JSON on a channel that carries text).
	 */
	send(message: TunnelRequestMessage | TunnelCancelMessage): void;
	/**
	 * How long a request may take until its response has ended, in
	 * milliseconds; 300000 by default, as at the relay. A
	 * `subscriptions/listen` stream is not limited.
	 */
	requestTimeoutMs?: number;
}

export interface TunnelFetch {
	/** `fetch` for an MCP client; only the path and query of the URL are used. */
	fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
	/**
	 * Hand it every message from the page's end, as an object
	 * (`http.response*`, `error`, `bye`); unknown ones are ignored.
	 */
	receive(message: unknown): void;
	/**
	 * The page's end is gone, or this end gives up: requests in flight are
	 * answered with a JSON-RPC error (`-31003`) and cancelled at the page,
	 * and every later request gets that error too. The same happens by itself
	 * when the page closes its `serve` (it says `bye`). A closed tunnel stays
	 * closed: make a new one for a new `serve`.
	 */
	close(reason?: string): void;
}

/** The relay's error codes (`docs/protocol.md`, "Errors the relay sends to the AI app"). */
const TIMEOUT = -31002;
const GONE = -31003;
const SEND_FAILED = -31005;
const BAD_RESPONSE = -31007;

/** The request headers the protocol passes on; `mcp-param-*` too. */
const HEADERS = new Set([
	"content-type",
	"accept",
	"mcp-protocol-version",
	"mcp-method",
	"mcp-name",
	"traceparent",
	"tracestate",
]);

type RpcId = string | number | null;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The JSON-RPC id of a request body, for the error that answers it. */
function rpcId(body: string): RpcId {
	try {
		const v: unknown = JSON.parse(body);
		const id = isObject(v) ? v["id"] : undefined;
		return typeof id === "string" || typeof id === "number" ? id : null;
	} catch {
		return null;
	}
}

function rpcError(id: RpcId, code: number, message: string): string {
	return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

interface Pending {
	rpcId: RpcId;
	/** The fetch promise, until the response has started. */
	resolve(response: Response): void;
	reject(reason: unknown): void;
	/** The body of a streamed response, once it has started. */
	stream?: ReadableStreamDefaultController<Uint8Array>;
	/** Whether the streamed response is an event stream (else one body in pieces). */
	sse: boolean;
	/** The last two characters of the stream so far: empty or a blank line is between two events. */
	tail: string;
	/** Stop the timer and the abort listener. */
	release(): void;
}

/**
 * The caller's end of the tunnel that `TabMcp.serve` answers. A timeout, a
 * closed tunnel or an invalid answer of the page become JSON-RPC errors with
 * the relay's codes at HTTP 200 (or the last event of a stream that had
 * started), so that an MCP client reads an error, not a network failure, and
 * does not send a `tools/call` again. Only an aborted `signal` rejects.
 */
export function createTunnelFetch(options: TunnelFetchOptions): TunnelFetch {
	const timeoutMs = options.requestTimeoutMs ?? 300_000;
	if (
		typeof options.send !== "function" ||
		typeof timeoutMs !== "number" ||
		!(timeoutMs > 0) ||
		// What `setTimeout` can keep: beyond it (and for Infinity) it fires at once.
		timeoutMs >= 2 ** 31
	) {
		throw new TypeError(
			"createTunnelFetch: needs send, and requestTimeoutMs in milliseconds (below 2^31)",
		);
	}
	const pending = new Map<string, Pending>();
	const encoder = new TextEncoder();
	let closed: string | undefined;
	let last = 0;
	// Ids of two tunnels over one channel must not meet (a backend that makes
	// a new tunnel while the page still answers the old one's requests).
	const prefix = Math.random().toString(36).slice(2, 8);

	const cancel = (id: string, reason: TunnelCancelMessage["reason"]): void => {
		try {
			options.send({ type: "http.cancel", id, reason });
		} catch {
			// the channel is gone: nothing to cancel
		}
	};

	/** End a request with a JSON-RPC error: as its response, or as its stream's last event. */
	const fail = (id: string, code: number, message: string): void => {
		const entry = pending.get(id);
		if (entry === undefined) return;
		pending.delete(id);
		entry.release();
		const body = rpcError(entry.rpcId, code, message);
		if (entry.stream === undefined) {
			entry.resolve(
				new Response(body, {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
			return;
		}
		try {
			if (entry.sse && (entry.tail === "" || entry.tail === "\n\n")) {
				entry.stream.enqueue(
					encoder.encode(`event: message\ndata: ${body}\n\n`),
				);
				entry.stream.close();
			} else if (!entry.sse && entry.tail === "") {
				// A body in pieces of which none came yet: the error is the body.
				entry.stream.enqueue(encoder.encode(body));
				entry.stream.close();
			} else {
				// In the middle of an event or a body: nothing readable can follow it.
				entry.stream.error(new Error(message));
			}
		} catch {
			// the reader has gone
		}
	};

	/** The page broke the protocol for this request. */
	const invalid = (id: string): void => {
		cancel(id, "error");
		fail(id, BAD_RESPONSE, "The page sent an invalid response.");
	};

	async function tunnelFetch(
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> {
		const request = new Request(input, init);
		const { signal } = request;
		signal.throwIfAborted();
		const body = await request.text();
		signal.throwIfAborted();
		const jsonId = rpcId(body);
		const answer = (code: number, message: string) =>
			new Response(rpcError(jsonId, code, message), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		if (closed !== undefined) return answer(GONE, closed);
		const url = new URL(request.url);
		const headers: Record<string, string> = {};
		request.headers.forEach((value, name) => {
			const lower = name.toLowerCase();
			if (HEADERS.has(lower) || lower.startsWith("mcp-param-"))
				headers[lower] = value;
		});
		const id = `${prefix}-${++last}`;
		return new Promise<Response>((resolve, reject) => {
			const onAbort = () => {
				const entry = pending.get(id);
				if (entry === undefined) return;
				pending.delete(id);
				entry.release();
				cancel(id, "client_closed");
				if (entry.stream === undefined) entry.reject(signal.reason);
				else
					try {
						entry.stream.error(signal.reason);
					} catch {
						// the reader has gone
					}
			};
			// A listen stream stays open for as long as the caller wants it.
			const timer =
				headers["mcp-method"] === "subscriptions/listen"
					? undefined
					: setTimeout(() => {
							cancel(id, "timeout");
							fail(id, TIMEOUT, "The page did not answer in time.");
						}, timeoutMs);
			signal.addEventListener("abort", onAbort);
			pending.set(id, {
				rpcId: jsonId,
				resolve,
				reject,
				sse: false,
				tail: "",
				release() {
					clearTimeout(timer);
					signal.removeEventListener("abort", onAbort);
				},
			});
			try {
				options.send({
					type: "http.request",
					id,
					method: request.method,
					path: url.pathname + url.search,
					headers,
					body,
				});
			} catch {
				fail(id, SEND_FAILED, "The request could not be sent to the page.");
			}
		});
	}

	/** No more requests: those in flight end with `-31003`, and so does every later one. */
	function end(reason: string, tellPage: boolean): void {
		if (closed !== undefined) return;
		closed = reason;
		for (const id of [...pending.keys()]) {
			if (tellPage) cancel(id, "client_closed");
			fail(id, GONE, reason);
		}
	}

	function receive(message: unknown): void {
		if (!isObject(message)) return;
		const { type, id } = message;
		if (type === "bye") {
			// The page closed its `serve`: nothing will be answered any more.
			end("The page stopped serving its tools.", false);
			return;
		}
		if (typeof id !== "string") return;
		const entry = pending.get(id);
		if (entry === undefined) return; // over already: late messages are dropped
		const { status, headers } = message;
		const head =
			typeof status === "number" &&
			Number.isInteger(status) &&
			status >= 200 &&
			status <= 599 &&
			isObject(headers) &&
			Object.values(headers).every((v) => typeof v === "string");
		switch (type) {
			case "http.response": {
				const { body } = message;
				if (
					entry.stream !== undefined ||
					!head ||
					typeof body !== "string" ||
					// A status without a body, as the relay has it (`-31007`).
					(body !== "" && [204, 205, 304].includes(status as number))
				) {
					invalid(id);
					return;
				}
				let response: Response;
				try {
					response = new Response(body === "" ? null : body, {
						status: status as number,
						headers: headers as Record<string, string>,
					});
				} catch {
					invalid(id); // e.g. a body with status 204
					return;
				}
				pending.delete(id);
				entry.release();
				entry.resolve(response);
				return;
			}
			case "http.response.start": {
				if (entry.stream !== undefined || !head) {
					invalid(id);
					return;
				}
				let response: Response;
				try {
					response = new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								entry.stream = controller;
							},
							cancel() {
								// The reader gave up: so does the page.
								if (pending.get(id) !== entry) return;
								pending.delete(id);
								entry.release();
								cancel(id, "client_closed");
							},
						}),
						{
							status: status as number,
							headers: headers as Record<string, string>,
						},
					);
				} catch {
					delete entry.stream;
					invalid(id);
					return;
				}
				entry.sse = (
					(headers as Record<string, string>)["content-type"] ?? ""
				).startsWith("text/event-stream");
				entry.resolve(response);
				return;
			}
			case "http.response.chunk": {
				const { data } = message;
				if (entry.stream === undefined || typeof data !== "string") {
					invalid(id);
					return;
				}
				if (data === "") return;
				entry.tail = (entry.tail + data).slice(-2);
				entry.stream.enqueue(encoder.encode(data));
				return;
			}
			case "http.response.end":
				if (entry.stream === undefined) {
					invalid(id);
					return;
				}
				pending.delete(id);
				entry.release();
				entry.stream.close();
				return;
			case "error":
				// `serve` refused the request as sent (`bad_message`).
				fail(
					id,
					BAD_RESPONSE,
					`The page refused the request: ${
						typeof message["message"] === "string"
							? message["message"].slice(0, 200)
							: "bad message"
					}`,
				);
				return;
		}
	}

	return {
		fetch: tunnelFetch,
		receive,
		close(reason?: string): void {
			// The page is told too, in case the channel still stands.
			end(reason ?? "The connection to the page was closed.", true);
		},
	};
}
