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
} as const;

export type CancelReason = "client_closed" | "timeout" | "error";

export interface ExchangeOptions {
	id: string;
	/** JSON-RPC id of the request; `undefined` for a notification. */
	rpcId: RpcId | undefined;
	/** `subscriptions/listen`: exempt from the request timer. */
	isListen: boolean;
	requestTimeoutMs: number;
	keepAliveMs: number;
	/** Extra headers for every response (CORS). */
	extraHeaders: Record<string, string>;
	/** Tell the tab to stop working on this request. */
	cancel: (reason: CancelReason) => void;
	/** Called once when the exchange is over. */
	onDone: (exchange: Exchange) => void;
}

const encoder = new TextEncoder();

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

export class Exchange {
	readonly id: string;
	readonly isListen: boolean;
	readonly response: Promise<Response>;
	/** HTTP status sent to the AI app (for logs); 0 while waiting. */
	status = 0;
	/** How the exchange ended (for logs). */
	outcome = "pending";

	readonly #options: ExchangeOptions;
	#resolve!: (response: Response) => void;
	#state: "waiting" | "streaming" | "done" = "waiting";
	/** The relay started the stream; a tab `http.response` becomes one event. */
	#relayStarted = false;
	/** Buffer a non-SSE streamed body to send it as one event. */
	#wrap = false;
	#wrapped = "";
	#controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	#atBoundary = true;
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
		if (this.#state === "waiting") {
			this.#respond(
				new Response(msg.body === "" ? null : msg.body, {
					status: msg.status,
					headers: this.#headers(msg.headers),
				}),
				msg.status,
			);
			this.#finish("ok");
		} else if (this.#state === "streaming" && this.#relayStarted) {
			if (msg.body !== "") this.#write(sseEvent(msg.body));
			this.#finish("ok");
		}
	}

	onStart(msg: HttpResponseStartMessage): void {
		if (this.#state === "waiting") {
			this.#openStream(msg.status, this.#headers(msg.headers));
		} else if (this.#state === "streaming" && this.#relayStarted) {
			this.#wrap = !isEventStream(msg.headers);
		}
	}

	onChunk(data: string): void {
		if (this.#state !== "streaming") return;
		if (this.#wrap) this.#wrapped += data;
		else this.#write(data);
	}

	onEnd(): void {
		if (this.#state !== "streaming") return;
		if (this.#wrap && this.#wrapped !== "")
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
	 * End the exchange with an error the AI app can read: an HTTP error while
	 * nothing was sent, else a JSON-RPC error event if the stream is at an
	 * event boundary.
	 */
	fail(
		status: number,
		code: number,
		message: string,
		cancelTab: boolean,
	): void {
		if (this.#state === "done") return;
		if (this.#state === "waiting") {
			this.#respond(this.#errorResponse(status, code, message), status);
		} else if (this.#atBoundary && this.#options.rpcId !== undefined) {
			this.#write(sseEvent(rpcErrorBody(this.#options.rpcId, code, message)));
		}
		if (cancelTab) this.#options.cancel("error");
		this.#finish(`error_${code}`);
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
		this.#relayStarted = true;
		this.#openStream(
			200,
			this.#headers({ "content-type": "text/event-stream" }),
		);
	}

	#openStream(status: number, headers: Headers): void {
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.#controller = controller;
			},
			cancel: () => this.clientClosed(),
		});
		if (isEventStream(Object.fromEntries(headers))) {
			headers.set("x-accel-buffering", "no");
			if (!headers.has("cache-control"))
				headers.set("cache-control", "no-cache");
		}
		this.#state = "streaming";
		this.#respond(new Response(stream, { status, headers }), status);
		this.#scheduleKeepAlive();
	}

	#write(text: string): void {
		if (
			this.#state !== "streaming" ||
			this.#controller === undefined ||
			text === ""
		)
			return;
		try {
			this.#controller.enqueue(encoder.encode(text));
		} catch {
			this.clientClosed();
			return;
		}
		this.#atBoundary = endsAtBoundary(text);
		this.#scheduleKeepAlive();
	}

	/** A keep-alive comment `keepAliveMs` after the last write, at a boundary. */
	#scheduleKeepAlive(): void {
		clearTimeout(this.#keepAliveTimer);
		if (this.#state !== "streaming" || this.#wrap) {
			if (this.#state === "streaming") {
				this.#keepAliveTimer = setTimeout(() => {
					// While buffering a wrapped body nothing has been forwarded since
					// the last boundary, so a comment is safe.
					this.#write(": keep-alive\n\n");
				}, this.#options.keepAliveMs);
			}
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

	#errorResponse(status: number, code: number, message: string): Response {
		const headers = this.#headers({ "content-type": "application/json" });
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
		const wasStreaming = this.#state === "streaming";
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
