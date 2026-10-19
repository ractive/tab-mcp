/** Shared helpers for the client tests: an in-process relay, tokens, the SDK client. */

import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	createLogger,
	createRelay,
	MemoryTokenStore,
	type Relay,
	type TokenStore,
} from "@ractive-ch/tab-mcp";
import { TabMcp } from "../src/index.ts";
import type { SecretStorage, TabMcpOptions } from "../src/types.ts";

export interface TestRelay {
	relay: Relay;
	store: TokenStore;
	url: string;
	stop(): Promise<void>;
}

/** An in-process relay on a free port, open to any origin (Bun sends none). */
export function startRelay(
	options: Parameters<typeof createRelay>[0] = {},
): TestRelay {
	const store = new MemoryTokenStore();
	const relay = createRelay({
		development: true,
		port: 0,
		host: "127.0.0.1",
		allowedOrigins: "*",
		store,
		logger: createLogger("error", () => {}),
		...options,
	});
	return {
		relay,
		store,
		url: `http://127.0.0.1:${relay.port}`,
		stop: () => relay.stop(),
	};
}

/** A `localStorage` stand-in. */
export class MemoryStorage implements SecretStorage {
	readonly items = new Map<string, string>();
	getItem(key: string): string | null {
		return this.items.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.items.set(key, value);
	}
}

export function newTab(
	relayUrl: string,
	options: Partial<TabMcpOptions> = {},
): TabMcp {
	return new TabMcp({
		relay: relayUrl,
		server: {
			name: "test-page",
			version: "1.0.0",
			instructions: "Test tools.",
		},
		storage: new MemoryStorage(),
		...options,
	});
}

function hashToken(token: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(token)
		.digest()
		.toBase64({ alphabet: "base64url", omitPadding: true });
}

/**
 * Issue an access token for an address through the relay's public
 * `TokenStore` interface, for tests about the tunnel rather than OAuth
 * (the OAuth flow itself: oauth-e2e.test.ts).
 */
export async function tokenFor(
	store: TokenStore,
	address: string,
	client = {
		id: "https://client.example/cimd.json",
		name: "Test client",
		grantId: "g_test",
	},
): Promise<string> {
	const addressId = /\/a\/([a-z2-7]{52})\/mcp$/.exec(address)?.[1];
	if (addressId === undefined) throw new Error(`not an address: ${address}`);
	const token = `tmcp_at_${crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true })}`;
	const now = Date.now();
	await store.put({
		hash: hashToken(token),
		kind: "access",
		grantId: client.grantId,
		addressId,
		clientId: client.id,
		clientName: client.name,
		scopes: ["tools"],
		grantCreatedAt: now,
		issuedAt: now,
		expiresAt: now + 3_600_000,
	});
	return token;
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

/** The next event of a type, as a promise. */
export function nextEvent<T = unknown>(
	target: EventTarget,
	type: string,
): Promise<CustomEvent<T>> {
	return new Promise((resolve) => {
		target.addEventListener(type, (e) => resolve(e as CustomEvent<T>), {
			once: true,
		});
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

/** Raw MCP POST with the modern headers. */
export function mcpPost(
	address: string,
	body: ReturnType<typeof rpc>,
	options: { token?: string; signal?: AbortSignal } = {},
): Promise<Response> {
	const name = (body.params as { name?: unknown }).name;
	return fetch(address, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2026-07-28",
			"mcp-method": body.method,
			...(typeof name === "string" ? { "mcp-name": name } : {}),
			...(options.token === undefined
				? {}
				: { authorization: `Bearer ${options.token}` }),
		},
		body: JSON.stringify(body),
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
}

/** Read SSE events from a streamed response until `until` matches one. */
export async function readEvents(
	response: Response,
	until: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> {
	const reader = response.body?.getReader();
	if (reader === undefined) throw new Error("no body");
	const decoder = new TextDecoder();
	const events: Record<string, unknown>[] = [];
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return events;
		buffer += decoder.decode(value, { stream: true });
		let i = buffer.indexOf("\n\n");
		while (i >= 0) {
			const block = buffer.slice(0, i);
			buffer = buffer.slice(i + 2);
			const data = block
				.split("\n")
				.filter((l) => l.startsWith("data: "))
				.map((l) => l.slice(6))
				.join("\n");
			if (data !== "") {
				const event = JSON.parse(data) as Record<string, unknown>;
				events.push(event);
				if (until(event)) {
					await reader.cancel();
					return events;
				}
			}
			i = buffer.indexOf("\n\n");
		}
	}
}
