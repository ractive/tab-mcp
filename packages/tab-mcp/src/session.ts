import {
	addressIdFromSecret,
	isWellFormedSecret,
	shortAddress,
} from "./address.ts";
import type { RelayConfig, Site, SiteLimits } from "./config.ts";
import {
	Exchange,
	type PageGoneReply,
	RelayErrorCode,
	type RpcId,
} from "./exchange.ts";
import { errorName, type Logger } from "./log.ts";
import { PairingCodes } from "./oauth/pairing.ts";
import {
	type ByeReason,
	CloseCode,
	type ErrorCode,
	type GrantInfo,
	type GrantRef,
	type Limits,
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
	/** Called once when a session is ready for MCP requests (DEC-074). */
	ready(session: TabSession): void;
	/** The tab pressed Disconnect for one app; false if the grant is not this address's. */
	revokeGrant(session: TabSession, grantId: string): Promise<boolean>;
	/** The tab revokes every grant of its address ("New address"). */
	revokeAll(session: TabSession): Promise<void>;
	/** The page proves who its user is (DEC-076); answers the tab itself. */
	bindIdentity(
		session: TabSession,
		assertion: string,
		round?: number,
	): Promise<void>;
	/** The page's user signed out (DEC-078). */
	signOut(session: TabSession): Promise<void>;
	/** Pairing code lifetime (tests shorten it). */
	readonly pairingCodeTtlMs?: number;
}

/** One MCP request for the tab: always `POST /mcp` (protocol: tunnelled MCP requests). */
export interface ForwardInput {
	headers: Record<string, string>;
	body: string;
	rpcId: RpcId | undefined;
	isListen: boolean;
	grant: GrantRef;
	extraHeaders: Record<string, string>;
	/** Called once with the finished exchange (for the request log line). */
	onDone: (exchange: Exchange) => void;
	/** The answer when the page goes away mid-request (DEC-074). */
	pageGone?: (waiting: boolean) => PageGoneReply;
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

/**
 * The request id of a frame too large to parse, from a cheap match at its
 * start (the tab library sends `type` and `id` first); `undefined` if absent.
 */
function frameId(data: string): string | undefined {
	return /"id"\s*:\s*"([^"\\]{1,64})"/.exec(data.slice(0, 256))?.[1];
}

/** One tab's WebSocket session, from open to close. */
export class TabSession {
	readonly sessionId: string = newId("s");
	readonly ip: string;
	readonly origin: string;
	/** The site this session's origin belongs to (DEC-045). */
	readonly site: Site;
	readonly openedAt: number = Date.now();
	/** Set once `hello` was accepted. */
	addressId: string | undefined;
	/** The app name `/authorize` shows: the site's name, else the page's claim. */
	appName: string | undefined;
	/** Pairing codes while the tab's dialog is open (DEC-028). */
	readonly codes: PairingCodes;
	/**
	 * The binding key of the page's user, once an assertion was accepted
	 * (DEC-077); `undefined` while nobody is signed in.
	 */
	identity: string | undefined;
	readonly pending: Map<string, Exchange> = new Map();
	/** The grant of each pending listen stream (a cap per grant). */
	readonly #listenGrants = new Map<string, string>();

	readonly #ws: SocketLike;
	readonly #host: SessionHost;
	#state: "new" | "hello" | "ready" | "ended" = "new";
	/** The "Connect your AI app" dialog is open (OIDC pairing, DEC-079). */
	#dialogOpen = false;
	#identityChain: Promise<void> = Promise.resolve();
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

	/** Whether the page's "Connect your AI app" dialog is open. */
	get pairingOpen(): boolean {
		return this.site.pairing === "code" ? this.codes.active : this.#dialogOpen;
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
		// Refused by length before parsing: a page of a site with a small limit
		// must not make the relay parse frames up to the largest site's.
		if (Buffer.byteLength(data) > this.limits.maxMessageBytes) {
			const id = frameId(data);
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
		const parsed = parseTabMessage(data);
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
				else this.#dialogOpen = true;
				return;
			case "pairing.stop":
				this.codes.stop();
				this.#dialogOpen = false;
				return;
			case "identity":
				await this.#serialIdentity(() =>
					this.#host.bindIdentity(this, msg.assertion, msg.round),
				);
				return;
			case "identity.logout":
				await this.#serialIdentity(() => this.#host.signOut(this));
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
				error: errorName(error),
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
			pairing: this.site.pairing,
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
		this.#host.ready(this);
	}

	/**
	 * Identity messages run one after another, in the order they came: frames
	 * are handled concurrently, and a slow assertion check must not finish
	 * after a later sign-out (review of PR #13).
	 */
	#serialIdentity(run: () => Promise<void>): Promise<void> {
		const next = this.#identityChain.then(run);
		this.#identityChain = next.catch(() => {});
		return next;
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

	/** The listen streams one grant has open on this session. */
	listenStreams(grantId: string): number {
		let n = 0;
		for (const g of this.#listenGrants.values()) if (g === grantId) n++;
		return n;
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
				this.#listenGrants.delete(id);
				this.#lastRequestAt = Date.now();
				input.onDone(e);
			},
			...(input.pageGone === undefined ? {} : { pageGone: input.pageGone }),
		});
		this.pending.set(id, exchange);
		if (input.isListen) this.#listenGrants.set(id, input.grant.grantId);
		const sent = this.send({
			type: "http.request",
			id,
			method: "POST",
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
		this.#dialogOpen = false;
		clearTimeout(this.#helloTimer);
		clearInterval(this.#heartbeatTimer);
		clearTimeout(this.#lifetimeTimer);
		// Released first, so a request the relay sends again waits for the next
		// session instead of finding this one.
		this.#host.released(this);
		for (const exchange of [...this.pending.values()]) exchange.tabGone();
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
