/**
 * A scripted relay for protocol cases that are hard to provoke from the real
 * relay (exact message orders, malformed frames): it answers `hello` with a
 * `session`, records what the tab sends, and sends what a test tells it to.
 */

import type { Server, ServerWebSocket } from "bun";
import type { Grant, Limits } from "../src/types.ts";

export const STUB_LIMITS: Limits = {
	maxMessageBytes: 1_048_576,
	maxBodyBytes: 1_048_576,
	requestTimeoutMs: 300_000,
	idleTimeoutMs: 3_600_000,
	heartbeatMs: 60_000,
	keepAliveMs: 20_000,
	maxConcurrentRequests: 8,
};

type Message = Record<string, unknown> & { type: string };

export class StubRelay {
	readonly server: Server<undefined>;
	readonly received: Message[] = [];
	/** UTF-8 size of every frame the tab sent. */
	readonly frameBytes: number[] = [];
	limits: Limits = STUB_LIMITS;
	grants: Grant[] = [];
	/** Answer `hello` with a `session` (off: the test answers itself). */
	answerHello = true;
	#socket: ServerWebSocket<undefined> | undefined;
	readonly #waiters: {
		match: (m: Message) => boolean;
		resolve: (m: Message) => void;
	}[] = [];

	constructor() {
		this.server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req, srv) =>
				srv.upgrade(req, {
					headers: { "Sec-WebSocket-Protocol": "tab-mcp.v1" },
				})
					? undefined
					: new Response("upgrade expected", { status: 400 }),
			websocket: {
				open: (ws) => {
					this.#socket = ws;
				},
				message: (ws, data) => {
					this.frameBytes.push(Buffer.byteLength(String(data)));
					const m = JSON.parse(String(data)) as Message;
					if (m.type === "hello" && this.answerHello) {
						ws.send(
							JSON.stringify({
								type: "session",
								sessionId: "s_stub",
								address: `http://127.0.0.1:${this.server.port}/a/${"a".repeat(52)}/mcp`,
								origin: "https://page.example",
								appName: (m["app"] as { name?: string } | undefined)?.name,
								expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
								limits: this.limits,
								grants: this.grants,
							}),
						);
					}
					const i = this.#waiters.findIndex((w) => w.match(m));
					if (i >= 0) this.#waiters.splice(i, 1)[0]?.resolve(m);
					else this.received.push(m);
				},
			},
		});
	}

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}

	/** The next message of `type` from the tab (already received or future). */
	next(
		type: string,
		match: (m: Message) => boolean = () => true,
	): Promise<Message> {
		const i = this.received.findIndex((m) => m.type === type && match(m));
		if (i >= 0)
			return Promise.resolve(this.received.splice(i, 1)[0] as Message);
		return new Promise((resolve) =>
			this.#waiters.push({
				match: (m) => m.type === type && match(m),
				resolve,
			}),
		);
	}

	send(message: unknown): void {
		this.#socket?.send(
			typeof message === "string" ? message : JSON.stringify(message),
		);
	}

	close(code: number, reason = ""): void {
		this.#socket?.close(code, reason);
	}

	stop(): Promise<void> {
		return this.server.stop(true);
	}
}
