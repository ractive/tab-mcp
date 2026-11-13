/** Shared helpers for the client tests: an in-process relay, tokens, the SDK client. */

import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	startTestRelay as startRelay,
	type TestRelay,
	tokenFor,
} from "@ractive-ch/tab-mcp/testing";
import { TabMcp } from "../src/index.ts";
import { timing } from "../src/tab-mcp.ts";
import type {
	ConnectionState,
	SecretStorage,
	StateChangeDetail,
	TabMcpOptions,
} from "../src/types.ts";

/** The published test relay and token helper (`@ractive-ch/tab-mcp/testing`). */
export { startRelay, type TestRelay, tokenFor };

/** A `localStorage` stand-in. */
export class MemoryStorage implements SecretStorage {
	readonly items = new Map<string, string>();
	getItem(key: string): string | null {
		return this.items.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.items.set(key, value);
	}
	removeItem(key: string): void {
		this.items.delete(key);
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

/** The next `statechange` to `state`, as a promise of its detail. */
export function nextState(
	target: EventTarget,
	state: ConnectionState,
): Promise<StateChangeDetail> {
	return new Promise((resolve) => {
		const listener = (e: Event) => {
			const detail = (e as CustomEvent<StateChangeDetail>).detail;
			if (detail.state !== state) return;
			target.removeEventListener("statechange", listener);
			resolve(detail);
		};
		target.addEventListener("statechange", listener);
	});
}

/**
 * The next end of a session: the `statechange` that carries a `reason` (to
 * `disconnected`, or to `reconnecting` when it reconnects by itself).
 */
export function nextEnd(target: EventTarget): Promise<StateChangeDetail> {
	return new Promise((resolve) => {
		const listener = (e: Event) => {
			const detail = (e as CustomEvent<StateChangeDetail>).detail;
			if (detail.reason === undefined) return;
			target.removeEventListener("statechange", listener);
			resolve(detail);
		};
		target.addEventListener("statechange", listener);
	});
}

/**
 * Sets the library's waits (`timing` of `tab-mcp.ts`, CU 17) until the
 * returned function puts the defaults back; call that in `afterEach`.
 */
export function setTiming(values: Partial<typeof timing>): () => void {
	const before = { ...timing };
	Object.assign(timing, values);
	return () => {
		Object.assign(timing, before);
	};
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
