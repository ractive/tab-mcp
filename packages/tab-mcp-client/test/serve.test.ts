/**
 * The tools without a relay (iteration 28): `TabMcp.serve` answers the
 * tunnel's messages on a port, and `createTunnelFetch` speaks the other end.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { TabMcp } from "../src/index.ts";
import { createTunnelFetch, type TunnelFetch } from "../src/tunnel.ts";
import type {
	ServeHandle,
	ServeOptions,
	TabMcpOptions,
	ToolCallClient,
	ToolCallEnd,
	ToolCallStart,
} from "../src/types.ts";
import { MemoryStorage, nextEvent, readEvents, rpc } from "./helpers.ts";

const ASSISTANT = { id: "assistant", name: "Example assistant" };

const open: { close(): void }[] = [];
afterEach(() => {
	for (const item of open.splice(0)) item.close();
});

function newPage(options: Partial<TabMcpOptions> = {}): TabMcp {
	return new TabMcp({
		server: { name: "test-page", version: "1.0.0", icons: [] },
		...options,
	});
}

interface Wire {
	tunnel: TunnelFetch;
	served: ServeHandle;
	/** The caller's port: what the page's answers arrive on. */
	port: MessagePort;
	/** Every message the page sent. */
	received: Record<string, unknown>[];
}

/** A `MessageChannel` with `serve` on one port and `createTunnelFetch` on the other. */
async function wire(
	mcp: TabMcp,
	options: Partial<ServeOptions> = {},
	requestTimeoutMs?: number,
): Promise<Wire> {
	const { port1, port2 } = new MessageChannel();
	open.push(port1, port2);
	const tunnel = createTunnelFetch({
		send: (message) => port2.postMessage(message),
		...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
	});
	const received: Record<string, unknown>[] = [];
	port2.onmessage = (event: MessageEvent) => {
		received.push(event.data as Record<string, unknown>);
		tunnel.receive(event.data);
	};
	const served = await mcp.serve(port1, { client: ASSISTANT, ...options });
	open.push(served);
	return { tunnel, served, port: port2, received };
}

/** A raw MCP POST through the tunnel, with the modern headers. */
function post(
	tunnel: TunnelFetch,
	body: ReturnType<typeof rpc>,
	signal?: AbortSignal,
): Promise<Response> {
	const name = (body.params as { name?: unknown }).name;
	return tunnel.fetch("https://tab.invalid/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2026-07-28",
			"mcp-method": body.method,
			...(typeof name === "string" ? { "mcp-name": name } : {}),
			// Never forwarded (docs/protocol.md).
			authorization: "Bearer nothing",
			cookie: "a=b",
		},
		body: JSON.stringify(body),
		...(signal === undefined ? {} : { signal }),
	});
}

/** The result or error that ends a `tools/call` stream. */
async function answer(response: Response): Promise<Record<string, unknown>> {
	const events = await readEvents(
		response,
		(event) => "result" in event || "error" in event,
	);
	return events.at(-1) ?? {};
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A message of a type that arrives on the caller's port. */
async function received(
	w: Wire,
	type: string,
): Promise<Record<string, unknown>> {
	for (let i = 0; i < 200; i++) {
		const found = w.received.find((m) => m["type"] === type);
		if (found !== undefined) return found;
		await wait(5);
	}
	throw new Error(`no ${type} arrived`);
}

describe("without a relay", () => {
	test("connect(), showConnectDialog() and newAddress() reject; nothing is stored", async () => {
		const storage = new MemoryStorage();
		const reads: string[] = [];
		const mcp = newPage({
			storage: {
				getItem: (key) => {
					reads.push(key);
					return storage.getItem(key);
				},
				setItem: (key, value) => storage.setItem(key, value),
			},
		});
		expect(mcp.hasRelay).toBe(false);
		for (const attempt of [
			mcp.connect({ resume: true }),
			mcp.showConnectDialog(),
			mcp.newAddress(),
		]) {
			const error = await attempt.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(TypeError);
			expect((error as Error).message).toBe("TabMcp: this TabMcp has no relay");
		}
		expect(mcp.state).toBe("disconnected");
		mcp.disconnect();
		mcp.startPairing();
		mcp.stopPairing();
		await mcp.revoke("g_1"); // not listed: nothing to do
		await expect(mcp.signOut()).rejects.toThrow("not connected");
		await expect(mcp.refreshIdentity()).rejects.toThrow("no identityAssertion");
		const w = await wire(mcp);
		await mcp.registerTool({
			name: "ping",
			description: "Ping",
			execute: () => "pong",
		});
		const result = await answer(
			await post(w.tunnel, rpc(1, "tools/call", { name: "ping" })),
		);
		expect(result).toMatchObject({
			result: { content: [{ type: "text", text: "pong" }] },
		});
		expect(reads).toEqual([]);
		expect(storage.items.size).toBe(0);
	});

	test("with a relay, hasRelay is true and serve works without connecting", async () => {
		const mcp = newPage({
			relay: "https://relay.invalid",
			storage: new MemoryStorage(),
		});
		expect(mcp.hasRelay).toBe(true);
		const w = await wire(mcp);
		const response = await post(w.tunnel, rpc(1, "tools/list"));
		expect(response.status).toBe(200);
		expect(mcp.state).toBe("disconnected");
	});
});

describe("serve and createTunnelFetch over a MessageChannel", () => {
	test("tools/list answers in one message, with only the protocol's headers sent", async () => {
		const mcp = newPage();
		await mcp.registerTool({
			name: "add",
			description: "Add two numbers",
			inputSchema: {
				type: "object",
				properties: { a: { type: "number" }, b: { type: "number" } },
				required: ["a", "b"],
			},
			execute: ({ a, b }) => Number(a) + Number(b),
		});
		const { port1, port2 } = new MessageChannel();
		open.push(port1, port2);
		const sent: Record<string, unknown>[] = [];
		const tunnel = createTunnelFetch({
			send: (message) => {
				sent.push({ ...message });
				port2.postMessage(message);
			},
		});
		port2.onmessage = (event: MessageEvent) => tunnel.receive(event.data);
		open.push(await mcp.serve(port1, { client: ASSISTANT }));
		const response = await post(tunnel, rpc(1, "tools/list"));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		const body = (await response.json()) as {
			result: { tools: { name: string }[] };
		};
		expect(body.result.tools.map((t) => t.name)).toEqual(["add"]);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			type: "http.request",
			method: "POST",
			path: "/mcp",
		});
		// A prefix of the tunnel's own, then a count.
		expect(sent[0]?.["id"]).toMatch(/^[a-z0-9]+-1$/);
		expect("grant" in (sent[0] ?? {})).toBe(false);
		expect(
			Object.keys(sent[0]?.["headers"] as Record<string, string>).sort(),
		).toEqual(["accept", "content-type", "mcp-method", "mcp-protocol-version"]);
	});

	test("a tools/call runs as the local client, with the events around it", async () => {
		const mcp = newPage();
		const clients: ToolCallClient[] = [];
		await mcp.registerTool({
			name: "who",
			description: "Who calls",
			execute: (_, { client }) => {
				clients.push(client);
				return { ok: true };
			},
		});
		const starts: ToolCallStart[] = [];
		const ends: ToolCallEnd[] = [];
		mcp.addEventListener("toolcall", (e) => starts.push(e.detail));
		mcp.addEventListener("toolcallend", (e) => ends.push(e.detail));
		const w = await wire(mcp);
		const response = await post(
			w.tunnel,
			rpc(2, "tools/call", { name: "who" }),
		);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(await answer(response)).toMatchObject({
			id: 2,
			result: { structuredContent: { ok: true } },
		});
		const local: ToolCallClient = {
			kind: "local",
			id: "assistant",
			name: "Example assistant",
		};
		expect(clients).toEqual([local]);
		expect(starts.map((s) => s.client)).toEqual([local]);
		expect(ends.map((e) => e.outcome)).toEqual(["ok"]);
		expect(ends.map((e) => e.client)).toEqual([local]);
	});

	test("a grant sent on the port is ignored", async () => {
		const mcp = newPage();
		const clients: ToolCallClient[] = [];
		await mcp.registerTool({
			name: "who",
			description: "Who calls",
			execute: (_, { client }) => {
				clients.push(client);
				return "x";
			},
		});
		const w = await wire(mcp, { client: { id: "assistant" } });
		w.port.postMessage({
			type: "http.request",
			id: "forged",
			method: "POST",
			path: "/mcp",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2026-07-28",
				"mcp-method": "tools/call",
				"mcp-name": "who",
			},
			body: JSON.stringify(rpc(1, "tools/call", { name: "who" })),
			grant: {
				grantId: "g_1",
				clientId: "https://claude.ai/oauth/client.json",
				scopes: ["tools"],
			},
		});
		await received(w, "http.response.end");
		// No name given: none on the client.
		expect(clients).toEqual([{ kind: "local", id: "assistant" }]);
	});

	test("a consequential tool asks, also for the local client; a refusal reaches the caller", async () => {
		const asked: ToolCallClient[] = [];
		let allow = false;
		const mcp = newPage({
			onConfirm: (request) => {
				asked.push(request.client);
				return allow;
			},
		});
		let runs = 0;
		await mcp.registerTool({
			name: "wipe",
			description: "Delete everything",
			annotations: { consequentialHint: true },
			execute: () => {
				runs++;
				return "gone";
			},
		});
		const w = await wire(mcp);
		const declined = await answer(
			await post(w.tunnel, rpc(1, "tools/call", { name: "wipe" })),
		);
		expect(declined).toMatchObject({
			result: {
				isError: true,
				content: [{ type: "text", text: "The user declined" }],
			},
		});
		expect(runs).toBe(0);
		allow = true;
		const allowed = await answer(
			await post(w.tunnel, rpc(2, "tools/call", { name: "wipe" })),
		);
		expect(allowed).toMatchObject({
			result: { content: [{ type: "text", text: "gone" }] },
		});
		expect(runs).toBe(1);
		expect(asked.map((c) => c.kind)).toEqual(["local", "local"]);
	});

	test("aborting the fetch cancels the page's call", async () => {
		const mcp = newPage();
		let aborted: (() => void) | undefined;
		const stopped = new Promise<void>((resolve) => {
			aborted = resolve;
		});
		await mcp.registerTool({
			name: "slow",
			description: "Never ends",
			execute: (_, { signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						aborted?.();
						reject(new Error("aborted"));
					});
				}),
		});
		const w = await wire(mcp);
		const controller = new AbortController();
		const ended = nextEvent<ToolCallEnd>(mcp, "toolcallend");
		const started = nextEvent(mcp, "toolcall");
		const response = await post(
			w.tunnel,
			rpc(1, "tools/call", { name: "slow" }),
			controller.signal,
		);
		await started;
		const reading = response.text().catch((e: unknown) => (e as Error).name);
		controller.abort();
		await stopped;
		expect((await ended).detail.outcome).toBe("cancelled");
		expect(await reading).toBe("AbortError");
	});

	test("a fetch aborted before the answer rejects with AbortError and cancels", async () => {
		const sent: { type: string }[] = [];
		const tunnel = createTunnelFetch({ send: (m) => sent.push(m) });
		const controller = new AbortController();
		const pending = post(tunnel, rpc(1, "tools/list"), controller.signal);
		await wait(1);
		controller.abort();
		expect(await pending.catch((e: unknown) => (e as Error).name)).toBe(
			"AbortError",
		);
		expect(sent.map((m) => m.type)).toEqual(["http.request", "http.cancel"]);
		const already = post(tunnel, rpc(2, "tools/list"), controller.signal);
		expect(await already.catch((e: unknown) => (e as Error).name)).toBe(
			"AbortError",
		);
		expect(sent).toHaveLength(2);
	});

	test("a request that takes too long ends with -31002, and the page's call is cancelled", async () => {
		const mcp = newPage();
		await mcp.registerTool({
			name: "slow",
			description: "Never ends",
			execute: (_, { signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		});
		const w = await wire(mcp, {}, 50);
		const ended = nextEvent<ToolCallEnd>(mcp, "toolcallend");
		const response = await post(
			w.tunnel,
			rpc(7, "tools/call", { name: "slow" }),
		);
		expect(await answer(response)).toEqual({
			jsonrpc: "2.0",
			id: 7,
			error: { code: -31002, message: "The page did not answer in time." },
		});
		expect((await ended).detail.outcome).toBe("cancelled");
	});

	test("a request nobody answers ends with -31002 at HTTP 200", async () => {
		const sent: { type: string }[] = [];
		const tunnel = createTunnelFetch({
			send: (m) => sent.push(m),
			requestTimeoutMs: 20,
		});
		const response = await post(tunnel, rpc(3, "tools/list"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			jsonrpc: "2.0",
			id: 3,
			error: { code: -31002, message: "The page did not answer in time." },
		});
		expect(sent.map((m) => m.type)).toEqual(["http.request", "http.cancel"]);
	});

	test("closing the tunnel answers requests in flight and later ones with -31003", async () => {
		const mcp = newPage();
		await mcp.registerTool({
			name: "slow",
			description: "Never ends",
			execute: () => new Promise(() => {}),
		});
		const w = await wire(mcp);
		const started = nextEvent(mcp, "toolcall");
		const streaming = await post(
			w.tunnel,
			rpc(1, "tools/call", { name: "slow" }),
		);
		await started;
		const waiting = createTunnelFetch({ send: () => {} });
		const unanswered = post(waiting, rpc(2, "tools/list"));
		await wait(1);
		w.tunnel.close();
		waiting.close("The chat was closed.");
		expect(await answer(streaming)).toEqual({
			jsonrpc: "2.0",
			id: 1,
			error: {
				code: -31003,
				message: "The connection to the page was closed.",
			},
		});
		const gone = { code: -31003, message: "The chat was closed." };
		expect(await (await unanswered).json()).toMatchObject({
			id: 2,
			error: gone,
		});
		const later = await post(waiting, rpc(3, "tools/list"));
		expect(later.status).toBe(200);
		expect(await later.json()).toMatchObject({ id: 3, error: gone });
	});

	test("close() aborts the calls in flight and lets the port go; signal does the same", async () => {
		const mcp = newPage();
		let aborts = 0;
		await mcp.registerTool({
			name: "slow",
			description: "Never ends",
			execute: (_, { signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						aborts++;
						reject(new Error("aborted"));
					});
				}),
		});
		const { port1, port2 } = new MessageChannel();
		open.push(port1, port2);
		const messages: Record<string, unknown>[] = [];
		port2.onmessage = (event: MessageEvent) => messages.push(event.data);
		const served = await mcp.serve(port1, { client: ASSISTANT });
		const request = (id: string) => ({
			type: "http.request",
			id,
			method: "POST",
			path: "/mcp",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2026-07-28",
				"mcp-method": "tools/call",
				"mcp-name": "slow",
			},
			body: JSON.stringify(rpc(1, "tools/call", { name: "slow" })),
		});
		let ended = nextEvent<ToolCallEnd>(mcp, "toolcallend");
		const started = nextEvent(mcp, "toolcall");
		port2.postMessage(request("a"));
		await started;
		served.close();
		served.close(); // twice is fine
		expect((await ended).detail.outcome).toBe("cancelled");
		expect(aborts).toBe(1);
		expect(port1.onmessage).toBeNull();
		await wait(10);
		const before = messages.length;
		// Nothing more for the cancelled call but the news that serving ended,
		// and nothing for a new request.
		expect(messages.some((m) => m["type"] === "http.response.end")).toBe(false);
		expect(messages.at(-1)).toEqual({ type: "bye", reason: "closed" });
		port1.onmessage = () => {};
		port2.postMessage(request("b"));
		await wait(10);
		expect(messages.length).toBe(before);

		// The same with `signal`, on a new channel.
		const second = new MessageChannel();
		open.push(second.port1, second.port2);
		const controller = new AbortController();
		await mcp.serve(second.port1, {
			client: ASSISTANT,
			signal: controller.signal,
		});
		ended = nextEvent<ToolCallEnd>(mcp, "toolcallend");
		const again = nextEvent(mcp, "toolcall");
		second.port2.postMessage(request("c"));
		await again;
		controller.abort();
		expect((await ended).detail.outcome).toBe("cancelled");
		expect(second.port1.onmessage).toBeNull();

		// Aborted already: the port is never taken.
		const third = new MessageChannel();
		open.push(third.port1, third.port2);
		await mcp.serve(third.port1, {
			client: ASSISTANT,
			signal: controller.signal,
		});
		expect(third.port1.onmessage).toBeNull();
	});

	test("the port's close event ends the serve: calls, listen streams and an open confirmation (CC 1)", async () => {
		const asked: AbortSignal[] = [];
		const mcp = newPage({
			onConfirm: ({ signal }) => {
				asked.push(signal);
				// As the library's dialog does: closes when the call is cancelled.
				return new Promise((resolve) =>
					signal.addEventListener("abort", () => resolve(false)),
				);
			},
		});
		await mcp.registerTool({
			name: "wipe",
			description: "Wipes",
			annotations: { consequentialHint: true },
			execute: () => "wiped",
		});
		const { port1, port2 } = new MessageChannel();
		open.push(port1, port2);
		await mcp.serve(port1, { client: ASSISTANT });
		const ended = nextEvent<ToolCallEnd>(mcp, "toolcallend");
		const started = nextEvent(mcp, "toolcall");
		port2.postMessage({
			type: "http.request",
			id: "a",
			method: "POST",
			path: "/mcp",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2026-07-28",
				"mcp-method": "tools/call",
				"mcp-name": "wipe",
			},
			body: JSON.stringify(rpc(1, "tools/call", { name: "wipe" })),
		});
		await started;
		await wait(10);
		expect(asked.length).toBe(1);
		// The other end goes away without a word (its frame unloaded, say).
		port2.close();
		expect((await ended).detail.outcome).toBe("cancelled");
		expect(asked[0]?.aborted).toBe(true);
		expect(port1.onmessage).toBeNull();
		// The port can be served again (it was let go).
		const fake = new (class extends EventTarget {
			onmessage: ((event: { data: unknown }) => void) | null = null;
			sent: unknown[] = [];
			postMessage(message: unknown) {
				this.sent.push(message);
			}
		})();
		await mcp.serve(fake, { client: ASSISTANT });
		expect(fake.onmessage).not.toBeNull();
		fake.dispatchEvent(new Event("close"));
		expect(fake.onmessage).toBeNull();
		await mcp.serve(fake, { client: ASSISTANT }); // let go: served again
		expect(fake.onmessage).not.toBeNull();
	});

	test("closing the serve ends the caller's requests at once, and its later ones (review of PR 114)", async () => {
		const mcp = newPage();
		await mcp.registerTool({
			name: "slow",
			description: "Never ends",
			execute: () => new Promise(() => {}),
		});
		const w = await wire(mcp);
		const started = nextEvent(mcp, "toolcall");
		const call = await post(w.tunnel, rpc(1, "tools/call", { name: "slow" }));
		const listen = await post(
			w.tunnel,
			rpc(2, "subscriptions/listen", {
				notifications: { toolsListChanged: true },
			}),
		);
		await started;
		w.served.close();
		const gone = {
			code: -31003,
			message: "The page stopped serving its tools.",
		};
		expect(await answer(call)).toMatchObject({ id: 1, error: gone });
		// The listen stream, which has no timeout, ends too.
		expect(
			(await readEvents(listen, (event) => "error" in event)).at(-1),
		).toMatchObject({ id: 2, error: gone });
		const later = await post(w.tunnel, rpc(3, "tools/list"));
		expect(await later.json()).toMatchObject({ id: 3, error: gone });
	});

	test("a request id that is still in flight ends the earlier request (review of PR 114)", async () => {
		const mcp = newPage();
		const aborted: number[] = [];
		let calls = 0;
		await mcp.registerTool({
			name: "slow",
			description: "Never ends",
			execute: (_, { signal }) => {
				const n = ++calls;
				return new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						aborted.push(n);
						reject(new Error("aborted"));
					});
				});
			},
		});
		const w = await wire(mcp);
		const request = {
			type: "http.request",
			id: "same",
			method: "POST",
			path: "/mcp",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2026-07-28",
				"mcp-method": "tools/call",
				"mcp-name": "slow",
			},
			body: JSON.stringify(rpc(1, "tools/call", { name: "slow" })),
		};
		const first = nextEvent(mcp, "toolcall");
		w.port.postMessage(request);
		await first;
		const ended = nextEvent<ToolCallEnd>(mcp, "toolcallend");
		w.port.postMessage(request);
		expect((await ended).detail.outcome).toBe("cancelled");
		expect(aborted).toEqual([1]);
		// The cancel reaches the one that is left.
		const last = nextEvent<ToolCallEnd>(mcp, "toolcallend");
		w.port.postMessage({ type: "http.cancel", id: "same" });
		expect((await last).detail.outcome).toBe("cancelled");
		expect(aborted).toEqual([1, 2]);
	});

	test("a registered tool reaches a subscriptions/listen stream", async () => {
		const mcp = newPage();
		const w = await wire(mcp);
		const response = await post(
			w.tunnel,
			rpc(5, "subscriptions/listen", {
				notifications: { toolsListChanged: true },
			}),
		);
		const reader = response.body?.getReader();
		const read = async () =>
			JSON.parse(
				new TextDecoder()
					.decode((await reader?.read())?.value)
					.split("data: ")[1] ?? "",
			) as Record<string, unknown>;
		expect(await read()).toMatchObject({
			method: "notifications/subscriptions/acknowledged",
		});
		await mcp.registerTool({
			name: "n",
			description: "New",
			execute: () => "",
		});
		expect(await read()).toMatchObject({
			method: "notifications/tools/list_changed",
		});
		// The reader gives up: the page is told, and its stream ends.
		await reader?.cancel();
		w.port.postMessage({ type: "http.request", id: "x" }); // answered after the cancel
		await received(w, "error");
		expect(w.received.at(-1)).toMatchObject({ code: "bad_message", id: "x" });
	});

	test("anything but http.request and http.cancel is answered with bad_message", async () => {
		const mcp = newPage();
		const w = await wire(mcp);
		const errors = () => w.received.filter((m) => m["type"] === "error");
		w.port.postMessage({ type: "hello", secret: "x" });
		w.port.postMessage("text");
		w.port.postMessage({ type: "http.request", id: "r1", method: "POST" });
		w.port.postMessage({
			type: "http.request",
			id: "r2",
			method: "POST",
			path: "mcp", // not a path
			headers: {},
			body: "",
		});
		w.port.postMessage({ type: "http.cancel" });
		// An error is never answered: two ends cannot answer each other for ever.
		w.port.postMessage({ type: "error", code: "bad_message", message: "x" });
		w.port.postMessage({ type: "http.cancel", id: "unknown" }); // fine, nothing to cancel
		w.port.postMessage({ type: "pong", t: 1, id: "p" });
		for (let i = 0; i < 100 && errors().length < 6; i++) await wait(5);
		expect(errors()).toEqual([
			{ type: "error", code: "bad_message", message: "unexpected hello" },
			{ type: "error", code: "bad_message", message: "not a message" },
			{
				type: "error",
				code: "bad_message",
				message: "malformed http.request",
				id: "r1",
			},
			{
				type: "error",
				code: "bad_message",
				message: "malformed http.request",
				id: "r2",
			},
			{ type: "error", code: "bad_message", message: "malformed http.cancel" },
			{
				type: "error",
				code: "bad_message",
				message: "unexpected pong",
				id: "p",
			},
		]);
	});

	test("a request the page refuses ends with a JSON-RPC error, not a hanging fetch", async () => {
		const mcp = newPage();
		const { port1, port2 } = new MessageChannel();
		open.push(port1, port2);
		const tunnel = createTunnelFetch({
			// A channel that loses the path: the page answers bad_message.
			send: (message) => port2.postMessage({ ...message, path: undefined }),
		});
		port2.onmessage = (event: MessageEvent) => tunnel.receive(event.data);
		open.push(await mcp.serve(port1, { client: ASSISTANT }));
		const response = await post(tunnel, rpc(4, "tools/list"));
		expect(await response.json()).toEqual({
			jsonrpc: "2.0",
			id: 4,
			error: {
				code: -31007,
				message: "The page refused the request: malformed http.request",
			},
		});
	});

	test("two ports at once: each call runs as its own client, and closing one leaves the other", async () => {
		const mcp = newPage();
		const seen: string[] = [];
		await mcp.registerTool({
			name: "who",
			description: "Who calls",
			execute: (_, { client }) => {
				seen.push(client.kind === "local" ? client.id : client.kind);
				return "x";
			},
		});
		const a = await wire(mcp, { client: { id: "a" } });
		const b = await wire(mcp, { client: { id: "b" } });
		await Promise.all([
			post(a.tunnel, rpc(1, "tools/call", { name: "who" })).then(answer),
			post(b.tunnel, rpc(1, "tools/call", { name: "who" })).then(answer),
		]);
		expect(seen.sort()).toEqual(["a", "b"]);
		a.served.close();
		expect(
			await answer(await post(b.tunnel, rpc(2, "tools/call", { name: "who" }))),
		).toMatchObject({ id: 2, result: {} });
	});

	test("a body larger than maxChunk is streamed in pieces and arrives whole", async () => {
		const mcp = newPage();
		const text = `${"é😀".repeat(400)}`;
		await mcp.registerTool({
			name: "big",
			description: text,
			execute: () => text,
		});
		const w = await wire(mcp, { maxChunk: 64 });
		const list = (await (
			await post(w.tunnel, rpc(1, "tools/list"))
		).json()) as {
			result: { tools: { description: string }[] };
		};
		expect(list.result.tools[0]?.description).toBe(text);
		const chunks = w.received.filter(
			(m) => m["type"] === "http.response.chunk",
		);
		expect(chunks.length).toBeGreaterThan(10);
		expect(chunks.every((m) => (m["data"] as string).length <= 64)).toBe(true);
		const called = await answer(
			await post(w.tunnel, rpc(2, "tools/call", { name: "big" })),
		);
		expect(called).toMatchObject({
			result: { content: [{ type: "text", text }] },
		});
	});

	test("a port that is served already is refused until that serve is closed", async () => {
		const mcp = newPage();
		const { port1, port2 } = new MessageChannel();
		open.push(port1, port2);
		const first = await mcp.serve(port1, { client: ASSISTANT });
		const handler = port1.onmessage;
		const error = await mcp
			.serve(port1, { client: { id: "other" } })
			.catch((e: unknown) => e);
		expect((error as DOMException).name).toBe("InvalidStateError");
		expect(port1.onmessage).toBe(handler); // the first one still has it
		first.close();
		const again = await mcp.serve(port1, { client: ASSISTANT });
		open.push(again);
		expect(port1.onmessage).not.toBeNull();
	});

	test("serve rejects options it cannot use", async () => {
		const mcp = newPage();
		const { port1, port2 } = new MessageChannel();
		open.push(port1, port2);
		const bad: [unknown, unknown][] = [
			[port1, {}],
			[port1, { client: { id: "" } }],
			[port1, { client: { id: "a", name: 1 } }],
			[port1, { client: { id: "a" }, maxChunk: 10 }],
			[port1, { client: { id: "a" }, maxChunk: 100.5 }],
			[{}, { client: { id: "a" } }],
			[null, { client: { id: "a" } }],
		];
		for (const [port, options] of bad) {
			const error = await mcp
				.serve(port as MessagePort, options as ServeOptions)
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(TypeError);
		}
		expect(port1.onmessage).toBeNull();
	});

	test("a port of your own: JSON text over another channel", async () => {
		const mcp = newPage();
		await mcp.registerTool({
			name: "ping",
			description: "Ping",
			execute: () => "pong",
		});
		// Two ends that pass text, as a WebSocket would.
		let toCaller: (text: string) => void = () => {};
		const port = {
			onmessage: null as ((event: { data: unknown }) => void) | null,
			postMessage(message: unknown) {
				const text = JSON.stringify(message);
				queueMicrotask(() => toCaller(text));
			},
		};
		const tunnel = createTunnelFetch({
			send: (message) => {
				const text = JSON.stringify(message);
				queueMicrotask(() => port.onmessage?.({ data: JSON.parse(text) }));
			},
		});
		toCaller = (text) => tunnel.receive(JSON.parse(text));
		open.push(await mcp.serve(port, { client: ASSISTANT }));
		expect(
			await answer(await post(tunnel, rpc(1, "tools/call", { name: "ping" }))),
		).toMatchObject({ result: { content: [{ type: "text", text: "pong" }] } });
	});
});

describe("createTunnelFetch against a page that breaks the protocol", () => {
	const sentBy = () => {
		const sent: { type: string; id: string }[] = [];
		const tunnel = createTunnelFetch({ send: (m) => sent.push(m) });
		return { sent, tunnel };
	};
	/** A request in flight, and the id the tunnel gave it. */
	const inFlight = async (method = "tools/list") => {
		const { sent, tunnel } = sentBy();
		const pending = post(tunnel, rpc(9, method, { name: "x" }));
		await wait(1);
		return { sent, tunnel, pending, id: sent[0]?.id ?? "" };
	};
	const invalid = {
		code: -31007,
		message: "The page sent an invalid response.",
	};
	const sse = { "content-type": "text/event-stream" };

	test("a chunk before the start, an end without one, a body with 204, a bad head", async () => {
		const cases: ((id: string) => Record<string, unknown>)[] = [
			(id) => ({ type: "http.response.chunk", id, data: "x" }),
			(id) => ({ type: "http.response.end", id }),
			(id) => ({
				type: "http.response",
				id,
				status: 204,
				headers: {},
				body: "x",
			}),
			(id) => ({
				type: "http.response",
				id,
				status: 99,
				headers: {},
				body: "",
			}),
			(id) => ({
				type: "http.response",
				id,
				status: 200,
				headers: { a: 1 },
				body: "",
			}),
			(id) => ({ type: "http.response.start", id, status: 200 }),
		];
		for (const message of cases) {
			const { sent, tunnel, pending, id } = await inFlight();
			tunnel.receive(message(id));
			expect(await (await pending).json()).toEqual({
				jsonrpc: "2.0",
				id: 9,
				error: invalid,
			});
			expect(sent.map((m) => m.type)).toEqual(["http.request", "http.cancel"]);
		}
	});

	test("an invalid message on a started stream: an error event between events, a broken stream inside one", async () => {
		const between = await inFlight("tools/call");
		const start = (id: string, headers = sse) => ({
			type: "http.response.start",
			id,
			status: 200,
			headers,
		});
		between.tunnel.receive(start(between.id));
		between.tunnel.receive({
			type: "http.response.chunk",
			id: between.id,
			data: 'event: message\ndata: {"jsonrpc":"2.0","method":"x"}\n',
		});
		// The blank line that ends the event comes in a piece of its own.
		between.tunnel.receive({
			type: "http.response.chunk",
			id: between.id,
			data: "\n",
		});
		between.tunnel.receive(start(between.id)); // a second start
		expect(await answer(await between.pending)).toEqual({
			jsonrpc: "2.0",
			id: 9,
			error: invalid,
		});

		const inside = await inFlight("tools/call");
		inside.tunnel.receive(start(inside.id));
		inside.tunnel.receive({
			type: "http.response.chunk",
			id: inside.id,
			data: "event: message\ndata: {",
		});
		inside.tunnel.receive({
			type: "http.response.chunk",
			id: inside.id,
			data: 5,
		});
		const failure = await (await inside.pending)
			.text()
			.catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(Error);
		// Late messages for a request that is over are dropped.
		inside.tunnel.receive({ type: "http.response.end", id: inside.id });
		inside.tunnel.receive({ type: "http.response.end", id: "nobody" });
		inside.tunnel.receive("text");
		inside.tunnel.receive({ type: "session" });
	});

	test("a JSON body in pieces that ends early: the error is the body before the first piece, a broken stream after it (review of PR 114)", async () => {
		const json = { "content-type": "application/json" };
		const before = await inFlight();
		before.tunnel.receive({
			type: "http.response.start",
			id: before.id,
			status: 200,
			headers: json,
		});
		before.tunnel.close();
		// JSON under the JSON content type, not an SSE event.
		expect(await (await before.pending).json()).toEqual({
			jsonrpc: "2.0",
			id: 9,
			error: {
				code: -31003,
				message: "The connection to the page was closed.",
			},
		});

		const after = await inFlight();
		after.tunnel.receive({
			type: "http.response.start",
			id: after.id,
			status: 200,
			headers: json,
		});
		after.tunnel.receive({
			type: "http.response.chunk",
			id: after.id,
			data: '{"jsonrpc":',
		});
		after.tunnel.close();
		const failure = await (await after.pending).text().catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(Error);
	});

	test("a send that throws answers -31005; bad options throw", async () => {
		const tunnel = createTunnelFetch({
			send: () => {
				throw new Error("closed");
			},
		});
		expect(await (await post(tunnel, rpc(1, "tools/list"))).json()).toEqual({
			jsonrpc: "2.0",
			id: 1,
			error: {
				code: -31005,
				message: "The request could not be sent to the page.",
			},
		});
		// Infinity and anything setTimeout cannot keep would time out at once.
		for (const requestTimeoutMs of [0, -1, Number.NaN, Infinity, 2 ** 31])
			expect(() =>
				createTunnelFetch({ send: () => {}, requestTimeoutMs }),
			).toThrow(TypeError);
		expect(() =>
			createTunnelFetch({} as Parameters<typeof createTunnelFetch>[0]),
		).toThrow(TypeError);
	});

	test("two tunnels never share an id; close() cancels at the page", async () => {
		const a = await inFlight();
		const b = await inFlight();
		expect(a.id).not.toBe(b.id);
		expect(a.id.split("-")[0]).not.toBe(b.id.split("-")[0]);
		a.tunnel.close();
		b.tunnel.close();
		expect(a.sent).toEqual([
			expect.objectContaining({ type: "http.request", id: a.id }),
			{ type: "http.cancel", id: a.id, reason: "client_closed" },
		]);
		await a.pending;
		await b.pending;
	});
});

describe("the MCP SDK client through createTunnelFetch", () => {
	test("lists and calls the page's tools, pinned to 2026-07-28", async () => {
		const mcp = newPage({
			server: {
				name: "test-page",
				version: "1.0.0",
				instructions: "Test tools.",
				icons: [],
			},
		});
		await mcp.registerTool({
			name: "add",
			description: "Add two numbers",
			inputSchema: {
				type: "object",
				properties: { a: { type: "number" }, b: { type: "number" } },
				required: ["a", "b"],
			},
			execute: ({ a, b }) => Number(a) + Number(b),
		});
		const w = await wire(mcp);
		const client = new Client(
			{ name: "test-client", version: "1.0.0" },
			{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
		);
		await client.connect(
			new StreamableHTTPClientTransport(new URL("https://tab.invalid/mcp"), {
				fetch: w.tunnel.fetch,
			}),
		);
		open.push({ close: () => void client.close() });
		expect(client.getServerVersion()).toMatchObject({ name: "test-page" });
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toEqual(["add"]);
		const result = await client.callTool({
			name: "add",
			arguments: { a: 2, b: 3 },
		});
		expect(result.content).toEqual([{ type: "text", text: "5" }]);
		// Invalid arguments are the tool's error, as over the relay.
		const wrong = await client.callTool({ name: "add", arguments: { a: "2" } });
		expect(wrong.isError).toBe(true);
		// A closed tunnel is an error the client reads, not a network failure.
		w.tunnel.close();
		const error = await client
			.callTool({ name: "add", arguments: { a: 1, b: 1 } })
			.catch((e: unknown) => e);
		expect(String((error as Error).message)).toContain(
			"The connection to the page was closed.",
		);
	});
});
