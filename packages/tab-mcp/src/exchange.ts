import type {
	HttpResponseMessage,
	HttpResponseStartMessage,
} from "./protocol.ts";

/**
 * One tunnelled MCP request: the AI app's HTTP response, built from the tab's
 * `http.response*` messages, with the request timer, SSE keep-alives (DEC-020)
 * and the relay-started event stream (DEC-039).
 */

export type RpcId = string | number | null;

/** JSON-RPC error codes the relay itself uses (outside the reserved range). */
export const RelayErrorCode = {
	pageNotOpen: -31001,
	timeout: -31002,
	tabGone: -31003,
	overloaded: -31004,
	sendFailed: -31005,
	tooLarge: -31006,
	badResponse: -31007,
	storeUnavailable: -31008,
	signedOut: -31009,
	restarting: -31010,
} as const;

export type CancelReason = "client_closed" | "timeout" | "error";

/**
 * What to do when the page goes away mid-request (DEC-074): send the request
 * to the page again once it is back (only while nothing was sent to the AI
 * app), or answer with this JSON-RPC message at HTTP 200 (`undefined` for a
 * notification: then 503).
 */
export type PageGoneReply = { retry: true } | { retry: false; body?: string };

export interface ExchangeOptions {
	id: string;
	/** JSON-RPC id of the request; `undefined` for a notification. */
	rpcId: RpcId | undefined;
	/** `subscriptions/listen`: exempt from the request timer. */
	isListen: boolean;
	requestTimeoutMs: number;
	keepAliveMs: number;
	/**
	 * Limit for the response body the tab sends (not for listen streams), and
	 * the bound for bytes queued towards an AI app that does not read.
	 */
	maxBodyBytes: number;
	/** Extra headers for every response (CORS). */
	extraHeaders: Record<string, string>;
	/** Tell the tab to stop working on this request. */
	cancel: (reason: CancelReason) => void;
	/** Called once when the exchange is over. */
	onDone: (exchange: Exchange) => void;
	/**
	 * Decides the answer when the page goes away mid-request; `waiting` is true
	 * while nothing was sent to the AI app. Without it: 503, `-31003`.
	 */
	pageGone?: (waiting: boolean) => PageGoneReply;
}

const encoder = new TextEncoder();

/** Statuses that must not carry a body (Fetch "null body status", 101/103 excluded by the parser). */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Response headers the relay passes on from the tab. */
const PASSED_RESPONSE_HEADERS = new Set(["content-type", "cache-control"]);

function isEventStream(headers: Record<string, string>): boolean {
	return (headers["content-type"] ?? "")
		.toLowerCase()
		.startsWith("text/event-stream");
}

function endsAtBoundary(text: string): boolean {
	return (
		text.endsWith("\n\n") || text.endsWith("\r\n\r\n") || text.endsWith("\r\r")
	);
}

/** One SSE `message` event carrying `data` (split into `data:` lines). */
export function sseEvent(data: string): string {
	const lines = data.split(/\r\n|\r|\n/);
	return `event: message\n${lines.map((l) => `data: ${l}`).join("\n")}\n\n`;
}

export function rpcErrorBody(
	rpcId: RpcId | undefined,
	code: number,
	message: string,
	data?: unknown,
): string {
	const error: Record<string, unknown> = { code, message };
	if (data !== undefined) error["data"] = data;
	return JSON.stringify({ jsonrpc: "2.0", id: rpcId ?? null, error });
}

/**
 * Where an exchange is. While `waiting` nothing was sent to the AI app.
 * `tab_stream`: the tab's `http.response.start` was passed on. The relay may
 * start the event stream itself (`relay_stream`, DEC-039); the tab's response
 * then becomes events: a tab event stream passes through (`relay_passed`), any
 * other streamed body is buffered and sent as one event (`relay_wrapped`).
 */
type State =
	| "waiting"
	| "tab_stream"
	| "relay_stream"
	| "relay_passed"
	| "relay_wrapped"
	| "done";

/** States in which the tab sent `http.response.start`. */
const TAB_STARTED: ReadonlySet<State> = new Set([
	"tab_stream",
	"relay_passed",
	"relay_wrapped",
]);

export class Exchange {
	readonly id: string;
	readonly isListen: boolean;
	readonly response: Promise<Response>;
	/** HTTP status sent to the AI app (for logs); 0 while waiting. */
	status = 0;
	/** How the exchange ended (for logs). */
	outcome = "pending";
	/** Why the tab's response was refused, for the tab's `error` message. */
	badResponseReason: string | undefined;

	readonly #options: ExchangeOptions;
	#resolve!: (response: Response) => void;
	#state: State = "waiting";
	/** The buffered body in `relay_wrapped`. */
	#wrapped = "";
	#controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	/** The last write to the AI app ended an SSE event (or nothing was sent). */
	#atBoundary = true;
	/** Response body bytes received from the tab so far. */
	#bodyBytes = 0;
	#startTimer: Timer | undefined;
	#requestTimer: Timer | undefined;
	#keepAliveTimer: Timer | undefined;

	constructor(options: ExchangeOptions) {
		this.#options = options;
		this.id = options.id;
		this.isListen = options.isListen;
		this.response = new Promise((resolve) => {
			this.#resolve = resolve;
		});
		if (options.rpcId !== undefined) {
			this.#startTimer = setTimeout(
				() => this.#startRelayStream(),
				options.keepAliveMs,
			);
		}
		if (!options.isListen) {
			this.#requestTimer = setTimeout(
				() => this.#timeout(),
				options.requestTimeoutMs,
			);
		}
	}

	get done(): boolean {
		return this.#state === "done";
	}

	/** A complete response from the tab. */
	onResponse(msg: HttpResponseMessage): void {
		if (TAB_STARTED.has(this.#state)) {
			this.#badResponse("http.response after http.response.start");
			return;
		}
		if (this.#state === "waiting") {
			if (!this.#account(msg.body)) return;
			if (NULL_BODY_STATUSES.has(msg.status) && msg.body !== "") {
				this.#badResponse(`status ${msg.status} must not have a body`);
				return;
			}
			let response: Response;
			try {
				response = new Response(msg.body === "" ? null : msg.body, {
					status: msg.status,
					headers: this.#headers(msg.headers),
				});
			} catch {
				this.#badResponse("the response could not be built");
				return;
			}
			this.#respond(response, msg.status);
			this.#finish("ok");
		} else if (this.#state === "relay_stream") {
			if (!this.#account(msg.body)) return;
			if (msg.body !== "") this.#write(sseEvent(msg.body));
			this.#finish("ok");
		}
	}

	onStart(msg: HttpResponseStartMessage): void {
		if (this.#state === "done") return;
		if (TAB_STARTED.has(this.#state)) {
			this.#badResponse("http.response.start sent twice");
			return;
		}
		// A listen stream has no total limit, so it must be an event stream: any
		// other body would be buffered or passed on without bound.
		const eventStream = isEventStream(msg.headers);
		if (this.isListen && !eventStream) {
			this.#badResponse("a listen response must be an event stream");
			return;
		}
		if (this.#state === "waiting") {
			if (NULL_BODY_STATUSES.has(msg.status)) {
				this.#badResponse(`status ${msg.status} cannot be streamed`);
				return;
			}
			let headers: Headers;
			try {
				headers = this.#headers(msg.headers);
			} catch {
				this.#badResponse("the response headers are invalid");
				return;
			}
			this.#openStream(msg.status, headers, "tab_stream");
		} else {
			this.#state = eventStream ? "relay_passed" : "relay_wrapped";
		}
	}

	onChunk(data: string): void {
		if (!this.#streaming) return;
		if (this.#state === "relay_stream") {
			this.#badResponse("http.response.chunk before http.response.start");
			return;
		}
		if (!this.#account(data)) return;
		if (this.#state === "relay_wrapped") this.#wrapped += data;
		else this.#write(data);
	}

	onEnd(): void {
		if (!this.#streaming) return;
		if (this.#state === "relay_wrapped" && this.#wrapped !== "")
			this.#write(sseEvent(this.#wrapped));
		this.#finish("ok");
	}

	/** The AI app went away: tell the tab, send nothing more. */
	clientClosed(): void {
		if (this.#state === "done") return;
		if (this.#state === "waiting")
			this.#respond(new Response(null, { status: 503 }), 0);
		this.#options.cancel("client_closed");
		this.#finish("client_closed", false);
	}

	/**
	 * The page's session ended. With a retry the exchange ends without an
	 * answer (its `response` never settles; the relay sends the request again),
	 * else the AI app gets the `pageGone` answer at HTTP 200 (DEC-074).
	 */
	tabGone(): void {
		if (this.#state === "done") return;
		const waiting = this.#state === "waiting";
		const reply = this.#options.pageGone?.(waiting);
		if (reply?.retry === true && waiting) {
			clearTimeout(this.#startTimer);
			this.#finish("page_gone_retry");
			return;
		}
		const body = reply?.retry === false ? reply.body : undefined;
		if (body === undefined) {
			this.fail(
				503,
				RelayErrorCode.tabGone,
				"The page closed its connection to the relay.",
				false,
			);
			return;
		}
		if (waiting) {
			this.#respond(
				new Response(body, {
					status: 200,
					headers: this.#headers({ "content-type": "application/json" }),
				}),
				200,
			);
		} else if (this.#atBoundary) {
			this.#write(sseEvent(body));
		}
		this.#finish("page_gone");
	}

	/**
	 * End the exchange with an error the AI app can read: an HTTP error while
	 * nothing was sent, else a JSON-RPC error event if the stream is at an
	 * event boundary.
	 */
	fail(
		status: number,
		code: number,
		message: string,
		cancelTab: boolean,
		headers: Record<string, string> = {},
	): void {
		if (this.#state === "done") return;
		if (this.#state === "waiting") {
			this.#respond(
				this.#errorResponse(status, code, message, headers),
				status,
			);
		} else if (this.#atBoundary && this.#options.rpcId !== undefined) {
			this.#write(sseEvent(rpcErrorBody(this.#options.rpcId, code, message)));
		}
		if (cancelTab) this.#options.cancel("error");
		this.#finish(`error_${code}`);
	}

	/**
	 * The tab sent a response the relay cannot pass on: 502 to the AI app (or an
	 * error event), cancel the tab's work. `reason` goes to the tab, not the app.
	 */
	#badResponse(reason: string): void {
		this.badResponseReason = reason;
		this.fail(
			502,
			RelayErrorCode.badResponse,
			"The page sent an invalid response.",
			true,
		);
	}

	/**
	 * Count response bytes from the tab; past `maxBodyBytes` fail with 502 /
	 * -31006 and cancel the tab. False when failed. Only a listen request's
	 * event stream is exempt; a buffered body is always bounded.
	 */
	#account(data: string): boolean {
		this.#bodyBytes += Buffer.byteLength(data);
		const unbounded =
			this.isListen &&
			(this.#state === "tab_stream" || this.#state === "relay_passed");
		if (unbounded || this.#bodyBytes <= this.#options.maxBodyBytes) {
			return true;
		}
		this.fail(
			502,
			RelayErrorCode.tooLarge,
			"The page sent a response that is too large.",
			true,
		);
		return false;
	}

	#timeout(): void {
		if (this.#state === "done") return;
		this.fail(
			504,
			RelayErrorCode.timeout,
			"The page did not answer in time.",
			false,
		);
		this.#options.cancel("timeout");
	}

	#startRelayStream(): void {
		if (this.#state !== "waiting") return;
		this.#openStream(
			200,
			this.#headers({ "content-type": "text/event-stream" }),
			"relay_stream",
		);
	}

	#openStream(
		status: number,
		headers: Headers,
		state: "tab_stream" | "relay_stream",
	): void {
		// Bounded queue: if the AI app stops reading, desiredSize goes negative
		// once maxBodyBytes are queued, and the exchange ends (see #write).
		const stream = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					this.#controller = controller;
				},
				cancel: () => this.clientClosed(),
			},
			new ByteLengthQueuingStrategy({
				highWaterMark: this.#options.maxBodyBytes,
			}),
		);
		if (isEventStream(Object.fromEntries(headers))) {
			headers.set("x-accel-buffering", "no");
			if (!headers.has("cache-control"))
				headers.set("cache-control", "no-cache");
		}
		let response: Response;
		try {
			response = new Response(stream, { status, headers });
		} catch {
			this.#badResponse("the response could not be built");
			return;
		}
		this.#state = state;
		this.#respond(response, status);
		this.#scheduleKeepAlive();
	}

	#write(text: string): void {
		if (!this.#streaming || this.#controller === undefined || text === "")
			return;
		try {
			this.#controller.enqueue(encoder.encode(text));
		} catch {
			this.clientClosed();
			return;
		}
		this.#atBoundary = endsAtBoundary(text);
		const room = this.#controller.desiredSize;
		if (room !== null && room < 0) {
			// The AI app is not reading: stop the tab, drop the stream. No error
			// event, since nothing more would reach the reader anyway.
			this.#options.cancel("error");
			this.#finish("backpressure");
			return;
		}
		this.#scheduleKeepAlive();
	}

	/** The AI app's response is a stream that is still open. */
	get #streaming(): boolean {
		return this.#state !== "waiting" && this.#state !== "done";
	}

	/** A keep-alive comment `keepAliveMs` after the last write, at a boundary. */
	#scheduleKeepAlive(): void {
		clearTimeout(this.#keepAliveTimer);
		if (!this.#streaming) return;
		if (this.#state === "relay_wrapped") {
			this.#keepAliveTimer = setTimeout(() => {
				// While buffering a wrapped body nothing has been forwarded since
				// the last boundary, so a comment is safe.
				this.#write(": keep-alive\n\n");
			}, this.#options.keepAliveMs);
			return;
		}
		this.#keepAliveTimer = setTimeout(() => {
			if (this.#atBoundary) this.#write(": keep-alive\n\n");
			else this.#scheduleKeepAlive();
		}, this.#options.keepAliveMs);
	}

	#headers(fromTab: Record<string, string>): Headers {
		const headers = new Headers(this.#options.extraHeaders);
		for (const [k, v] of Object.entries(fromTab)) {
			if (PASSED_RESPONSE_HEADERS.has(k)) headers.set(k, v);
		}
		return headers;
	}

	#errorResponse(
		status: number,
		code: number,
		message: string,
		extra: Record<string, string>,
	): Response {
		const headers = this.#headers({ "content-type": "application/json" });
		for (const [k, v] of Object.entries(extra)) headers.set(k, v);
		return new Response(rpcErrorBody(this.#options.rpcId, code, message), {
			status,
			headers,
		});
	}

	#respond(response: Response, status: number): void {
		clearTimeout(this.#startTimer);
		this.status = status;
		this.#resolve(response);
	}

	#finish(outcome: string, closeStream = true): void {
		if (this.#state === "done") return;
		const wasStreaming = this.#streaming;
		this.#state = "done";
		this.outcome = outcome;
		clearTimeout(this.#startTimer);
		clearTimeout(this.#requestTimer);
		clearTimeout(this.#keepAliveTimer);
		if (wasStreaming && closeStream) {
			try {
				this.#controller?.close();
			} catch {
				// already closed by the client
			}
		}
		this.#options.onDone(this);
	}
}
