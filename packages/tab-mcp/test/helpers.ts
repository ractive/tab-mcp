import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	createMcpHandler,
	fromJsonSchema,
	McpServer,
} from "@modelcontextprotocol/server";
import { addressIdFromSecret, newSecret } from "../src/address.ts";
import { createLogger, type Logger } from "../src/log.ts";
import type {
	HttpRequestMessage,
	RelayMessage,
	SessionMessage,
} from "../src/protocol.ts";
import {
	type CreateRelayOptions,
	createRelay,
	type Relay,
} from "../src/relay.ts";
import { MemoryTokenStore } from "../src/store/memory.ts";
import type { TokenStore } from "../src/store/types.ts";
import { issueAccessToken } from "../src/tokens.ts";

export const ORIGIN = "https://page.example";

/** Collects log lines in memory. */
export class LogCapture {
	readonly lines: string[] = [];
	readonly logger: Logger = createLogger("debug", (line) => {
		this.lines.push(line);
	});
	events(name: string): Record<string, unknown>[] {
		return this.lines
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((e) => e["event"] === name);
	}
}

export interface TestRelay {
	relay: Relay;
	store: TokenStore;
	logs: LogCapture;
	wsUrl: string;
	stop(): Promise<void>;
}

/** An in-process relay on port 0 with a memory store and captured logs. */
export function startRelay(options: CreateRelayOptions = {}): TestRelay {
	const store = new MemoryTokenStore();
	const logs = new LogCapture();
	const relay = createRelay({
		development: true,
		port: 0,
		host: "127.0.0.1",
		allowedOrigins: [ORIGIN],
		store,
		logger: logs.logger,
		...options,
	});
	return {
		relay,
		store:
			options.store !== undefined && typeof options.store === "object"
				? options.store
				: store,
		logs,
		wsUrl: `ws://127.0.0.1:${relay.port}/tab`,
		stop: () => relay.stop(),
	};
}

export type RequestHandler = (
	msg: HttpRequestMessage,
	tab: ScriptedTab,
) => void | Promise<void>;

export interface TabOptions {
	origin?: string;
	protocols?: string[];
	secret?: string;
	/** Answer pings (default true). */
	pong?: boolean;
	/** Handles `http.request`; default: the SDK handler with test tools. */
	onRequest?: RequestHandler;
	/** The app name sent in hello. */
	app?: string;
}

/** A scripted (non-browser) tab: Bun's WebSocket plus the SDK handler. */
export class ScriptedTab {
	readonly secret: string;
	readonly received: RelayMessage[] = [];
	readonly ws: WebSocket;
	readonly opened: Promise<void>;
	readonly closed: Promise<{ code: number; reason: string }>;
	session: SessionMessage | undefined;
	/** The latest pairing code the relay sent (codes are not consumed by `next`). */
	pairingCode: string | undefined;
	readonly #options: TabOptions;
	readonly #waiters: {
		match: (m: RelayMessage) => boolean;
		resolve: (m: RelayMessage) => void;
	}[] = [];
	readonly #controllers = new Map<string, AbortController>();

	constructor(url: string, options: TabOptions = {}) {
		this.#options = options;
		this.secret = options.secret ?? newSecret();
		this.ws = new WebSocket(url, {
			headers: { Origin: options.origin ?? ORIGIN },
			protocols: options.protocols ?? ["tab-mcp.v1"],
		} as unknown as string[]);
		this.opened = new Promise((resolve, reject) => {
			this.ws.addEventListener("open", () => resolve(), { once: true });
			this.ws.addEventListener("error", () => reject(new Error("ws error")), {
				once: true,
			});
		});
		this.closed = new Promise((resolve) => {
			this.ws.addEventListener("close", (e) =>
				resolve({ code: e.code, reason: e.reason }),
			);
		});
		this.ws.addEventListener("message", (e) => this.#onMessage(String(e.data)));
	}

	get addressId(): string {
		return addressIdFromSecret(this.secret);
	}

	send(message: unknown): void {
		this.ws.send(JSON.stringify(message));
	}

	/** Open, send hello, wait for `session`. */
	async connect(): Promise<SessionMessage> {
		await this.opened;
		this.send({
			type: "hello",
			library: { name: "scripted-tab", version: "0.0.0" },
			page: { title: "Test page" },
			...(this.#options.app === undefined
				? {}
				: { app: { name: this.#options.app } }),
			secret: this.secret,
		});
		const m = await this.next("session");
		this.session = m as SessionMessage;
		return this.session;
	}

	next(
		type: string,
		match: (m: RelayMessage) => boolean = () => true,
	): Promise<RelayMessage> {
		const found = this.received.find((m) => m.type === type && match(m));
		if (found !== undefined) {
			this.received.splice(this.received.indexOf(found), 1);
			return Promise.resolve(found);
		}
		return new Promise((resolve) => {
			this.#waiters.push({
				match: (m) => m.type === type && match(m),
				resolve,
			});
		});
	}

	/** Start pairing and wait for the first code. */
	async startPairing(): Promise<string> {
		this.send({ type: "pairing.start" });
		const m = await this.next("pairing.code");
		return (m as { code: string }).code;
	}

	/** Wait for a pairing code other than `previous`. */
	async nextCode(previous: string | undefined): Promise<string> {
		await waitFor(
			() => this.pairingCode !== undefined && this.pairingCode !== previous,
			"a new pairing code",
		);
		return this.pairingCode ?? "";
	}

	signalFor(id: string): AbortSignal | undefined {
		return this.#controllers.get(id)?.signal;
	}

	close(): void {
		this.ws.close();
	}

	#onMessage(text: string): void {
		const msg = JSON.parse(text) as RelayMessage;
		if (msg.type === "pairing.code") this.pairingCode = msg.code;
		if (msg.type === "ping" && this.#options.pong !== false) {
			this.send({ type: "pong", t: msg.t });
		}
		if (msg.type === "http.cancel") {
			this.#controllers.get(msg.id)?.abort();
		}
		if (msg.type === "http.request") {
			const controller = new AbortController();
			this.#controllers.set(msg.id, controller);
			const handler = this.#options.onRequest ?? sdkRequestHandler;
			void Promise.resolve(handler(msg, this));
		}
		const i = this.#waiters.findIndex((w) => w.match(msg));
		if (i >= 0) {
			const [w] = this.#waiters.splice(i, 1);
			w?.resolve(msg);
		} else {
			this.received.push(msg);
		}
	}
}

/** Tools the default scripted tab offers. */
function buildServer(): McpServer {
	const server = new McpServer({ name: "scripted-tab", version: "1.0.0" });
	server.registerTool(
		"add",
		{
			description: "Add two numbers",
			inputSchema: fromJsonSchema({
				type: "object",
				properties: { a: { type: "number" }, b: { type: "number" } },
				required: ["a", "b"],
			}),
		},
		async (input) => {
			const args = input as Record<string, unknown>;
			return {
				content: [
					{ type: "text", text: String(Number(args["a"]) + Number(args["b"])) },
				],
			};
		},
	);
	server.registerTool(
		"echo",
		{
			description: "Echo a text after an optional delay",
			inputSchema: fromJsonSchema({
				type: "object",
				properties: { text: { type: "string" }, delayMs: { type: "number" } },
				required: ["text"],
			}),
		},
		async (input) => {
			const args = input as Record<string, unknown>;
			const delay = Number(args["delayMs"] ?? 0);
			if (delay > 0) await Bun.sleep(delay);
			return { content: [{ type: "text", text: String(args["text"]) }] };
		},
	);
	return server;
}

const handler = createMcpHandler(buildServer, {
	legacy: "reject",
	responseMode: "sse",
});

/** Run the request through the SDK handler and stream the response back. */
export async function sdkRequestHandler(
	msg: HttpRequestMessage,
	tab: ScriptedTab,
): Promise<void> {
	const signal = tab.signalFor(msg.id);
	const request = new Request(`http://tab${msg.path}`, {
		method: msg.method,
		headers: msg.headers,
		body: msg.body,
		...(signal === undefined ? {} : { signal }),
	});
	const response = await handler.fetch(request, {
		parsedBody: JSON.parse(msg.body),
		authInfo: {
			token: "",
			clientId: msg.grant.clientId,
			scopes: msg.grant.scopes,
		},
	});
	await streamResponse(msg.id, response, tab);
}

export async function streamResponse(
	id: string,
	response: Response,
	tab: ScriptedTab,
): Promise<void> {
	const headers: Record<string, string> = {};
	response.headers.forEach((v, k) => {
		headers[k.toLowerCase()] = v;
	});
	const isSse = (headers["content-type"] ?? "").startsWith("text/event-stream");
	if (!isSse || response.body === null) {
		tab.send({
			type: "http.response",
			id,
			status: response.status,
			headers,
			body: await response.text(),
		});
		return;
	}
	tab.send({
		type: "http.response.start",
		id,
		status: response.status,
		headers,
	});
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		tab.send({
			type: "http.response.chunk",
			id,
			data: decoder.decode(value, { stream: true }),
		});
	}
	tab.send({ type: "http.response.end", id });
}

/** An SDK client pinned to 2026-07-28 with a bearer token. */
export async function connectClient(
	address: string,
	token: string,
): Promise<Client> {
	const client = new Client(
		{ name: "test-client", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL(address), {
			requestInit: { headers: { Authorization: `Bearer ${token}` } },
		}),
	);
	return client;
}

export async function tokenFor(
	store: TokenStore,
	addressId: string,
	options: { ttlMs?: number; now?: number } = {},
): Promise<string> {
	const { token } = await issueAccessToken(
		store,
		{
			addressId,
			clientId: "https://client.example/cimd.json",
			clientName: "Test client",
		},
		{
			ttlMs: options.ttlMs ?? 3_600_000,
			...(options.now === undefined ? {} : { now: options.now }),
		},
	);
	return token;
}

/** Raw MCP POST with modern headers. */
export function mcpPost(
	address: string,
	body: unknown,
	options: {
		token?: string;
		headers?: Record<string, string>;
		signal?: AbortSignal;
	} = {},
): Promise<Response> {
	const b = body as { method?: string; params?: { name?: string } };
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		"mcp-protocol-version": "2026-07-28",
		...(b.method === undefined ? {} : { "mcp-method": b.method }),
		...(b.params?.name === undefined ? {} : { "mcp-name": b.params.name }),
		...(options.token === undefined
			? {}
			: { authorization: `Bearer ${options.token}` }),
		...options.headers,
	};
	return fetch(address, {
		method: "POST",
		headers,
		body: typeof body === "string" ? body : JSON.stringify(body),
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
}

/** A 2026-07-28 request body. */
export function rpc(
	id: number | string,
	method: string,
	params: Record<string, unknown> = {},
) {
	return {
		jsonrpc: "2.0",
		id,
		method,
		params: {
			...params,
			_meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientCapabilities": {},
				"io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
			},
		},
	};
}

/** Wait until `condition` holds (polling each 5 ms), or fail after `timeoutMs`. */
export async function waitFor(
	condition: () => boolean,
	what: string,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}
