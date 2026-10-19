import {
	addressIdFromSecret,
	isWellFormedSecret,
	shortAddress,
} from "./address.ts";
import type { RelayConfig, Site, SiteLimits } from "./config.ts";
import { Exchange, RelayErrorCode, type RpcId } from "./exchange.ts";
import type { Logger } from "./log.ts";
import { PairingCodes } from "./oauth/pairing.ts";
import {
	type ByeReason,
	CloseCode,
	type ErrorCode,
	type GrantInfo,
	type GrantRef,
	type Limits,
	type ParseResult,
	parseTabMessage,
	type RelayMessage,
	type TabMessage,
} from "./protocol.ts";
import type { TokenStore } from "./store/types.ts";
import { newId } from "./tokens.ts";

/** The part of Bun's `ServerWebSocket` a session uses (a fake in unit tests). */
export interface SocketLike {
	/** Bytes sent, -1 when queued under backpressure, 0 when dropped. */
	send(data: string): number;
	close(code?: number, reason?: string): void;
}

/** What a session needs from its relay. */
export interface SessionHost {
	readonly config: RelayConfig;
	readonly logger: Logger;
	readonly store: TokenStore;
	/** The external origin, e.g. `https://relay.ractive.ch`. */
	publicUrl(): string;
	/** Register a session for its address; returns the session it replaced. */
	claimAddress(session: TabSession): TabSession | undefined;
	/** Called once when a session is over. */
	released(session: TabSession): void;
	/** The tab pressed Disconnect for one app; false if the grant is not this address's. */
	revokeGrant(session: TabSession, grantId: string): Promise<boolean>;
	/** The tab revokes every grant of its address ("New address"). */
	revokeAll(session: TabSession): Promise<void>;
	/** Pairing code lifetime (tests shorten it). */
	readonly pairingCodeTtlMs?: number;
}

export interface ForwardInput {
	method: string;
	headers: Record<string, string>;
	body: string;
	rpcId: RpcId | undefined;
	isListen: boolean;
	grant: GrantRef;
	extraHeaders: Record<string, string>;
	/** Called once with the finished exchange (for the request log line). */
	onDone: (exchange: Exchange) => void;
}

/** The limits announced to the tab (protocol: `session.limits`). */
export function limitsOf(limits: SiteLimits | RelayConfig): Limits {
	return {
		maxMessageBytes: limits.maxMessageBytes,
		maxBodyBytes: limits.maxMessageBytes,
		requestTimeoutMs: limits.requestTimeoutMs,
		idleTimeoutMs: limits.idleTimeoutMs,
		heartbeatMs: limits.heartbeatMs,
		keepAliveMs: limits.keepAliveMs,
		maxConcurrentRequests: limits.maxConcurrentRequests,
	};
}

function clientHost(clientId: string): string {
	try {
		return new URL(clientId).host;
	} catch {
		return "";
	}
}

/** The request id a parsed frame refers to, if any. */
function messageId(parsed: ParseResult): string | undefined {
	if ("message" in parsed) {
		return "id" in parsed.message ? parsed.message.id : undefined;
	}
	return parsed.id;
}

/** One tab's WebSocket session, from open to close. */
export class TabSession {
	readonly sessionId = newId("s");
	readonly ip: string;
	readonly origin: string;
	/** The site this session's origin belongs to (DEC-045). */
	readonly site: Site;
	readonly openedAt = Date.now();
	/** Set once `hello` was accepted. */
	addressId: string | undefined;
	/** The app name `/authorize` shows: the site's name, else the page's claim. */
	appName: string | undefined;
	/** Pairing codes while the tab's dialog is open (DEC-028). */
	readonly codes: PairingCodes;
	readonly pending = new Map<string, Exchange>();

	readonly #ws: SocketLike;
	readonly #host: SessionHost;
	#state: "new" | "hello" | "ready" | "ended" = "new";
	#lastRequestAt = Date.now();
	#missedPongs = 0;
	#nextRequest = 0;
	#helloTimer: Timer | undefined;
	#heartbeatTimer: Timer | undefined;
	#lifetimeTimer: Timer | undefined;

	constructor(
		ws: SocketLike,
		ip: string,
		origin: string,
		site: Site,
		host: SessionHost,
	) {
		this.#ws = ws;
		this.ip = ip;
		this.origin = origin;
		this.site = site;
		this.#host = host;
		this.codes = new PairingCodes(
			(code, expiresAt) => {
				this.send({
					type: "pairing.code",
					code,
					expiresAt: new Date(expiresAt).toISOString(),
				});
			},
			host.pairingCodeTtlMs === undefined
				? {}
				: { ttlMs: host.pairingCodeTtlMs },
		);
		this.#helloTimer = setTimeout(() => {
			if (this.#state === "new") {
				this.#protocolError("bad_message", "no hello in time");
			}
		}, host.config.helloTimeoutMs);
	}

	get ready(): boolean {
		return this.#state === "ready";
	}

	/** The limits of this session (its site's). */
	get limits(): SiteLimits {
		return this.site.limits;
	}

	/** Send one message; false if Bun dropped it under backpressure (DEC-021). */
	send(message: RelayMessage): boolean {
		if (this.#state === "ended") return false;
		let sent: number;
		try {
			sent = this.#ws.send(JSON.stringify(message));
		} catch {
			return false;
		}
		if (sent === 0) {
			this.#host.logger.warn("tab.send_dropped", {
				session: this.sessionId,
				type: message.type,
			});
			return false;
		}
		return true;
	}

	/** A frame arrived from the tab. */
	handleFrame(data: string | Uint8Array): void {
		if (this.#state === "ended") return;
		if (typeof data !== "string") {
			this.#protocolError("bad_message", "binary frames are not allowed");
			return;
		}
		const tooLarge = Buffer.byteLength(data) > this.limits.maxMessageBytes;
		const parsed = parseTabMessage(data);
		if (tooLarge) {
			const id = messageId(parsed);
			this.#sendError("too_large", "message exceeds maxMessageBytes", id);
			const exchange = id === undefined ? undefined : this.pending.get(id);
			exchange?.fail(
				502,
				RelayErrorCode.tooLarge,
				"The page sent a response that is too large.",
				true,
			);
			return;
		}
		if (!parsed.ok) {
			if (this.#state === "new") {
				this.#protocolError("bad_message", parsed.error);
				return;
			}
			this.#sendError("bad_message", parsed.error, parsed.id);
			// A malformed response must not leave its request hanging.
			const exchange =
				parsed.id === undefined ? undefined : this.pending.get(parsed.id);
			exchange?.fail(
				502,
				RelayErrorCode.badResponse,
				"The page sent an invalid response.",
				true,
			);
			return;
		}
		if ("unknown" in parsed) {
			if (this.#state === "new") {
				this.#protocolError("bad_message", "hello expected");
			} else if (parsed.id !== undefined) {
				this.#sendError(
					"unknown_type",
					`unknown type ${parsed.type}`,
					parsed.id,
				);
			}
			return;
		}
		// One bad frame must never become an unhandled rejection (it would end
		// the process): log it, tell the tab, keep the session.
		this.#handle(parsed.message).catch((error: unknown) => {
			this.#host.logger.error("tab.handler_error", {
				session: this.sessionId,
				type: parsed.message.type,
				message: error instanceof Error ? error.name : "unknown",
			});
			this.#sendError("bad_message", "the relay could not handle this message");
		});
	}

	async #handle(msg: TabMessage): Promise<void> {
		if (this.#state === "new") {
			if (msg.type !== "hello") {
				this.#protocolError("bad_message", "hello expected");
				return;
			}
			await this.#hello(msg.secret, msg.library, msg.app?.name);
			return;
		}
		if (this.#state === "hello") return; // still answering hello
		switch (msg.type) {
			case "hello":
				this.#sendError("bad_message", "hello was already sent");
				return;
			case "pong":
				this.#missedPongs = 0;
				return;
			case "bye":
				this.end(CloseCode.normal, "bye");
				return;
			case "pairing.start":
				if (this.site.pairing === "code") this.codes.start();
				return;
			case "pairing.stop":
				this.codes.stop();
				return;
			case "grant.revoke":
				if (!(await this.#host.revokeGrant(this, msg.grantId))) {
					this.#sendError("unknown_id", "unknown grant");
				}
				return;
			case "grants.revokeAll":
				await this.#host.revokeAll(this);
				return;
			case "error":
				this.#host.logger.debug("tab.error", {
					session: this.sessionId,
					code: msg.code,
				});
				return;
			case "http.response":
			case "http.response.start":
			case "http.response.chunk":
			case "http.response.end": {
				const exchange = this.pending.get(msg.id);
				if (exchange === undefined) return; // finished or cancelled: drop
				if (msg.type === "http.response") exchange.onResponse(msg);
				else if (msg.type === "http.response.start") exchange.onStart(msg);
				else if (msg.type === "http.response.chunk") exchange.onChunk(msg.data);
				else exchange.onEnd();
				if (exchange.badResponseReason !== undefined) {
					this.#sendError("bad_message", exchange.badResponseReason, msg.id);
				}
				return;
			}
		}
	}

	async #hello(
		secret: string,
		library: { name: string; version: string },
		appName: string | undefined,
	): Promise<void> {
		if (!isWellFormedSecret(secret)) {
			this.#protocolError(
				"bad_message",
				"secret must be 43 base64url characters",
			);
			return;
		}
		clearTimeout(this.#helloTimer);
		this.#state = "hello";
		this.addressId = addressIdFromSecret(secret);
		this.appName = this.site.name ?? appName;
		const replaced = this.#host.claimAddress(this);
		if (replaced !== undefined) {
			replaced.end(
				CloseCode.replaced,
				"replaced by a newer session",
				"replaced",
			);
		}

		let grants: GrantInfo[] = [];
		try {
			const list = await this.#host.store.listGrants(
				this.addressId,
				Date.now(),
			);
			grants = list.map((g) => ({
				grantId: g.grantId,
				client: {
					id: g.clientId,
					name: g.clientName,
					host: clientHost(g.clientId),
				},
				createdAt: new Date(g.createdAt).toISOString(),
			}));
		} catch (error) {
			this.#host.logger.error("store.error", {
				op: "listGrants",
				message: error instanceof Error ? error.message : "unknown",
			});
		}
		if (this.#state !== "hello") return; // closed meanwhile

		const limits = this.limits;
		const expiresAt = this.openedAt + limits.sessionLifetimeMs;
		this.#state = "ready";
		const sent = this.send({
			type: "session",
			sessionId: this.sessionId,
			address: `${this.#host.publicUrl()}/a/${this.addressId}/mcp`,
			origin: this.origin,
			...(this.appName === undefined ? {} : { appName: this.appName }),
			expiresAt: new Date(expiresAt).toISOString(),
			limits: limitsOf(limits),
			grants,
		});
		if (!sent) {
			this.end(CloseCode.policyViolation, "send failed");
			return;
		}
		this.#heartbeatTimer = setInterval(() => this.#tick(), limits.heartbeatMs);
		this.#lifetimeTimer = setTimeout(
			() =>
				this.end(
					CloseCode.sessionExpired,
					"session lifetime reached",
					"expired",
				),
			Math.max(0, expiresAt - Date.now()),
		);
		this.#host.logger.info("tab.session", {
			session: this.sessionId,
			address: shortAddress(this.addressId),
			origin: this.origin,
			library: `${library.name}@${library.version}`,
			replaced: replaced !== undefined,
		});
	}

	#tick(): void {
		if (this.#state !== "ready") return;
		if (this.#missedPongs >= 2) {
			this.end(CloseCode.heartbeatLost, "heartbeat lost");
			return;
		}
		// Idle = no MCP request and nothing in flight, listen streams included:
		// a listen stream may stay open for the session's lifetime (protocol.md),
		// which still caps it.
		if (
			this.pending.size === 0 &&
			Date.now() - this.#lastRequestAt >= this.limits.idleTimeoutMs
		) {
			this.end(CloseCode.idleTimeout, "idle", "idle");
			return;
		}
		this.#missedPongs++;
		this.send({ type: "ping", t: Date.now() });
	}

	/** Tunnel one MCP request to the tab. Resolves with the AI app's response. */
	forward(input: ForwardInput): Exchange {
		this.#lastRequestAt = Date.now();
		const id = `r${++this.#nextRequest}`;
		const limits = this.limits;
		const exchange = new Exchange({
			id,
			rpcId: input.rpcId,
			isListen: input.isListen,
			requestTimeoutMs: limits.requestTimeoutMs,
			keepAliveMs: limits.keepAliveMs,
			maxBodyBytes: limitsOf(limits).maxBodyBytes,
			extraHeaders: input.extraHeaders,
			cancel: (reason) => {
				if (!this.send({ type: "http.cancel", id, reason })) {
					this.#host.logger.debug("tab.cancel_not_sent", {
						session: this.sessionId,
					});
				}
			},
			onDone: (e) => {
				this.pending.delete(id);
				this.#lastRequestAt = Date.now();
				input.onDone(e);
			},
		});
		this.pending.set(id, exchange);
		const sent = this.send({
			type: "http.request",
			id,
			method: input.method,
			path: "/mcp",
			headers: input.headers,
			body: input.body,
			grant: input.grant,
		});
		if (!sent) {
			exchange.fail(
				503,
				RelayErrorCode.sendFailed,
				"The connection to the page is overloaded. Try again.",
				false,
			);
		}
		return exchange;
	}

	/** End the session: optional `bye`, then close the socket. Idempotent. */
	end(code: number, reason: string, bye?: ByeReason): void {
		if (this.#state === "ended") return;
		if (bye !== undefined) this.send({ type: "bye", reason: bye });
		this.#cleanup(code, reason);
		try {
			this.#ws.close(code, reason);
		} catch {
			// already closed
		}
	}

	/** The socket closed (from Bun's `close` handler). */
	closed(code: number): void {
		this.#cleanup(code, "closed");
	}

	#cleanup(code: number, reason: string): void {
		if (this.#state === "ended") return;
		const wasReady = this.#state === "ready" || this.#state === "hello";
		this.#state = "ended";
		this.codes.stop();
		clearTimeout(this.#helloTimer);
		clearInterval(this.#heartbeatTimer);
		clearTimeout(this.#lifetimeTimer);
		for (const exchange of [...this.pending.values()]) {
			exchange.fail(
				503,
				RelayErrorCode.tabGone,
				"The page closed its connection to the relay.",
				false,
			);
		}
		this.#host.released(this);
		if (wasReady) {
			this.#host.logger.info("tab.closed", {
				session: this.sessionId,
				code,
				reason,
				durationMs: Date.now() - this.openedAt,
			});
		}
	}

	#sendError(code: ErrorCode, message: string, id?: string): void {
		this.send(
			id === undefined
				? { type: "error", code, message }
				: { type: "error", code, message, id },
		);
	}

	#protocolError(code: ErrorCode, message: string): void {
		this.#sendError(code, message);
		this.end(CloseCode.policyViolation, message);
	}
}
