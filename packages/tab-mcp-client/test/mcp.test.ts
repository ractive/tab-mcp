/**
 * The tab's MCP handler against the MCP SDK's `createMcpHandler` (DEC-049):
 * the same requests to both, the same statuses, error codes and result shapes.
 */
import { describe, expect, test } from "bun:test";
import {
	fromJsonSchema,
	McpServer,
	createMcpHandler as sdkHandler,
} from "@modelcontextprotocol/server";
import { createMcpHandler, decodeHeaderValue } from "../src/mcp.ts";
import type { GrantRef } from "../src/protocol.ts";
import { ToolRegistry } from "../src/registry.ts";
import type { ConfirmRequest } from "../src/types.ts";
import { rpc } from "./helpers.ts";

const ADD_SCHEMA = {
	type: "object",
	properties: { a: { type: "number" }, b: { type: "number" } },
	required: ["a", "b"],
};
const SERVER = { name: "probe", version: "1.2.3", instructions: "Use me." };
const GRANT: GrantRef = {
	grantId: "g_1",
	clientId: "https://client.example/cimd.json",
	scopes: ["tools"],
};

function ours(
	confirm: (r: ConfirmRequest) => Promise<boolean> = async () => true,
) {
	const registry = new ToolRegistry();
	registry.register({
		name: "add",
		title: "Add",
		description: "Add two numbers",
		inputSchema: ADD_SCHEMA,
		execute: ({ a, b }) => ({
			content: [{ type: "text", text: String(Number(a) + Number(b)) }],
		}),
	});
	registry.register({
		name: "boom",
		description: "Fails",
		execute: () => {
			throw new Error("kaput");
		},
	});
	const handler = createMcpHandler({
		tools: registry,
		server: SERVER,
		confirm,
		client: (g) => ({
			grantId: g.grantId,
			id: g.clientId,
			host: new URL(g.clientId).host,
		}),
	});
	return { registry, handler };
}

const sdk = sdkHandler(
	() => {
		const s = new McpServer(
			{ name: SERVER.name, version: SERVER.version },
			{ instructions: SERVER.instructions },
		);
		s.registerTool(
			"add",
			{
				title: "Add",
				description: "Add two numbers",
				inputSchema: fromJsonSchema(ADD_SCHEMA),
			},
			async (input) => {
				const { a, b } = input as { a: number; b: number };
				return { content: [{ type: "text", text: String(a + b) }] };
			},
		);
		s.registerTool(
			"boom",
			{ description: "Fails", inputSchema: fromJsonSchema({ type: "object" }) },
			async () => {
				throw new Error("kaput");
			},
		);
		return s;
	},
	{ legacy: "reject", responseMode: "sse" },
);

type Case = {
	name: string;
	body: unknown;
	headers?: Record<string, string>;
	drop?: string[];
};

function request(c: Case): Request {
	const body = c.body as { method?: string; params?: { name?: unknown } };
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		"mcp-protocol-version": "2026-07-28",
	};
	if (typeof body?.method === "string") headers["mcp-method"] = body.method;
	if (typeof body?.params?.name === "string")
		headers["mcp-name"] = body.params.name;
	Object.assign(headers, c.headers);
	for (const d of c.drop ?? []) delete headers[d];
	return new Request("http://tab/mcp", {
		method: "POST",
		headers,
		body: typeof c.body === "string" ? c.body : JSON.stringify(c.body),
	});
}

/** Status plus the one JSON-RPC message of the response (JSON or the last SSE event). */
async function outcome(
	res: Response,
): Promise<{ status: number; message: Record<string, unknown> | undefined }> {
	const text = await res.text();
	if (text === "") return { status: res.status, message: undefined };
	if ((res.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
		const events = text
			.split("\n\n")
			.map((block) =>
				block
					.split("\n")
					.filter((l) => l.startsWith("data: "))
					.map((l) => l.slice(6))
					.join("\n"),
			)
			.filter((d) => d !== "");
		return { status: res.status, message: JSON.parse(events.at(-1) ?? "null") };
	}
	return { status: res.status, message: JSON.parse(text) };
}

/** What must agree: status, error code, isError, result keys and content. */
function shape(o: {
	status: number;
	message: Record<string, unknown> | undefined;
}) {
	const m = o.message;
	const error = m?.["error"] as { code: number } | undefined;
	const result = m?.["result"] as Record<string, unknown> | undefined;
	return {
		status: o.status,
		id: m?.["id"],
		error: error?.code,
		isError: result?.["isError"] ?? false,
		resultKeys: result === undefined ? undefined : Object.keys(result).sort(),
		content: result?.["isError"] === true ? undefined : result?.["content"],
	};
}

const meta = rpc(0, "x").params._meta;
const CASES: Case[] = [
	{ name: "server/discover", body: rpc(1, "server/discover") },
	{ name: "tools/list", body: rpc(2, "tools/list") },
	{
		name: "tools/list with a cursor",
		body: rpc(3, "tools/list", { cursor: "abc" }),
	},
	{
		name: "tools/call",
		body: rpc(4, "tools/call", { name: "add", arguments: { a: 40, b: 2 } }),
	},
	{
		name: "tools/call with bad arguments",
		body: rpc(5, "tools/call", { name: "add", arguments: { a: "x", b: 1 } }),
	},
	{
		name: "tools/call without arguments",
		body: rpc(6, "tools/call", { name: "add" }),
	},
	{
		name: "tools/call of an unknown tool",
		body: rpc(7, "tools/call", { name: "nope", arguments: {} }),
	},
	{
		name: "tools/call of a tool that throws",
		body: rpc(8, "tools/call", { name: "boom", arguments: {} }),
	},
	{
		name: "tools/call with a numeric name",
		body: rpc(9, "tools/call", { name: 5 }),
	},
	{ name: "a string id", body: rpc("s-1", "tools/list") },
	{ name: "an unknown method", body: rpc(10, "resources/list") },
	{ name: "ping (gone in 2026-07-28)", body: rpc(11, "ping") },
	{
		name: "legacy initialize",
		body: {
			jsonrpc: "2.0",
			id: 12,
			method: "initialize",
			params: {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "a", version: "1" },
			},
		},
		drop: ["mcp-protocol-version"],
	},
	{
		name: "initialize with a modern header",
		body: {
			jsonrpc: "2.0",
			id: 13,
			method: "initialize",
			params: { protocolVersion: "2025-11-25", capabilities: {} },
		},
	},
	{
		name: "no _meta",
		body: { jsonrpc: "2.0", id: 14, method: "tools/list", params: {} },
	},
	{ name: "no params", body: { jsonrpc: "2.0", id: 15, method: "tools/list" } },
	{
		name: "no _meta and no version header",
		body: { jsonrpc: "2.0", id: 16, method: "tools/list", params: {} },
		drop: ["mcp-protocol-version"],
	},
	{
		name: "_meta without clientCapabilities",
		body: {
			jsonrpc: "2.0",
			id: 17,
			method: "tools/list",
			params: {
				_meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
			},
		},
	},
	{
		name: "_meta with a malformed clientInfo",
		body: {
			jsonrpc: "2.0",
			id: 18,
			method: "tools/list",
			params: { _meta: { ...meta, "io.modelcontextprotocol/clientInfo": "x" } },
		},
	},
	{
		name: "header names an older version",
		body: rpc(19, "tools/list"),
		headers: { "mcp-protocol-version": "2025-11-25" },
	},
	{
		name: "body names an older version",
		body: {
			jsonrpc: "2.0",
			id: 20,
			method: "tools/list",
			params: {
				_meta: {
					...meta,
					"io.modelcontextprotocol/protocolVersion": "2025-11-25",
				},
			},
		},
		headers: { "mcp-protocol-version": "2025-11-25" },
	},
	{
		name: "missing MCP-Protocol-Version",
		body: rpc(21, "tools/list"),
		drop: ["mcp-protocol-version"],
	},
	{
		name: "missing Mcp-Method",
		body: rpc(22, "tools/list"),
		drop: ["mcp-method"],
	},
	{
		name: "Mcp-Method disagrees",
		body: rpc(23, "tools/list"),
		headers: { "mcp-method": "tools/call" },
	},
	{
		name: "missing Mcp-Name",
		body: rpc(24, "tools/call", { name: "add", arguments: { a: 1, b: 2 } }),
		drop: ["mcp-name"],
	},
	{
		name: "Mcp-Name disagrees",
		body: rpc(25, "tools/call", { name: "add", arguments: { a: 1, b: 2 } }),
		headers: { "mcp-name": "boom" },
	},
	{
		name: "Mcp-Name in base64",
		body: rpc(26, "tools/call", { name: "add", arguments: { a: 1, b: 2 } }),
		headers: { "mcp-name": "=?base64?YWRk?=" },
	},
	{
		name: "Mcp-Name with broken base64",
		body: rpc(27, "tools/call", { name: "add", arguments: { a: 1, b: 2 } }),
		headers: { "mcp-name": "=?base64?Y$dk?=" },
	},
	{
		name: "a notification",
		body: {
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: 1 },
		},
	},
	{
		name: "a notification with a wrong Mcp-Method",
		body: { jsonrpc: "2.0", method: "notifications/cancelled", params: {} },
		headers: { "mcp-method": "x" },
	},
	{ name: "a posted response", body: { jsonrpc: "2.0", id: 1, result: {} } },
	{ name: "a batch", body: [rpc(1, "tools/list")] },
	{ name: "invalid JSON", body: "{nope" },
	{ name: "not JSON-RPC", body: { foo: 1 } },
	{
		name: "the wrong content type",
		body: rpc(28, "tools/list"),
		headers: { "content-type": "text/plain" },
	},
	{ name: "a null id", body: { ...rpc(29, "tools/list"), id: null } },
];

describe("conformance with the SDK's createMcpHandler", () => {
	for (const c of CASES) {
		test(c.name, async () => {
			const { handler } = ours();
			const mine = shape(
				await outcome(await handler.handle(request(c), { grant: GRANT })),
			);
			const theirs = shape(await outcome(await sdk.fetch(request(c), {})));
			expect(mine).toEqual(theirs);
		});
	}
});

describe("results", () => {
	test("server/discover and tools/list carry the 2026-07-28 fields", async () => {
		const { handler } = ours();
		const discover = await outcome(
			await handler.handle(
				request({ name: "", body: rpc(1, "server/discover") }),
				{ grant: GRANT },
			),
		);
		expect(discover.message?.["result"]).toEqual({
			supportedVersions: ["2026-07-28"],
			capabilities: { tools: { listChanged: true } },
			instructions: "Use me.",
			ttlMs: 0,
			cacheScope: "private",
			resultType: "complete",
			_meta: {
				"io.modelcontextprotocol/serverInfo": {
					name: "probe",
					version: "1.2.3",
				},
			},
		});
		const list = await outcome(
			await handler.handle(request({ name: "", body: rpc(2, "tools/list") }), {
				grant: GRANT,
			}),
		);
		const sdkList = await outcome(
			await sdk.fetch(request({ name: "", body: rpc(2, "tools/list") })),
		);
		expect(list.message?.["result"]).toEqual(
			sdkList.message?.["result"] as Record<string, unknown>,
		);
	});

	test("tools/call answers with an event stream at once (DEC-020)", async () => {
		const { registry, handler } = ours();
		let release!: () => void;
		registry.register({
			name: "slow",
			description: "Waits",
			execute: () => new Promise<string>((r) => (release = () => r("done"))),
		});
		const res = await handler.handle(
			request({ name: "", body: rpc(1, "tools/call", { name: "slow" }) }),
			{ grant: GRANT },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		release();
		expect((await outcome(res)).message?.["result"]).toMatchObject({
			content: [{ type: "text", text: "done" }],
		});
	});

	test("execute gets the arguments, an abort signal and the client", async () => {
		const { registry, handler } = ours();
		let seen: unknown;
		registry.register({
			name: "probe",
			description: "Probe",
			execute: (input, options) => {
				seen = {
					input,
					aborted: options.signal.aborted,
					client: options.client,
				};
				return "ok";
			},
		});
		await outcome(
			await handler.handle(
				request({
					name: "",
					body: rpc(1, "tools/call", { name: "probe", arguments: { x: 1 } }),
				}),
				{ grant: GRANT },
			),
		);
		expect(seen).toEqual({
			input: { x: 1 },
			aborted: false,
			client: {
				grantId: "g_1",
				id: "https://client.example/cimd.json",
				host: "client.example",
			},
		});
	});

	test("aborting the request aborts the tool's signal", async () => {
		const { registry, handler } = ours();
		let aborted!: () => void;
		const wasAborted = new Promise<void>((r) => (aborted = r));
		registry.register({
			name: "wait",
			description: "Waits for abort",
			execute: (_input, { signal }) => {
				signal.addEventListener("abort", () => aborted());
				return new Promise(() => {});
			},
		});
		const controller = new AbortController();
		const req = new Request(
			request({ name: "", body: rpc(1, "tools/call", { name: "wait" }) }),
			{ signal: controller.signal },
		);
		await handler.handle(req, { grant: GRANT });
		controller.abort();
		await wasAborted;
	});
});

describe("consequential tools", () => {
	const consequential = (confirm: (r: ConfirmRequest) => Promise<boolean>) => {
		const { registry, handler } = ours(confirm);
		let runs = 0;
		registry.register({
			name: "wipe",
			title: "Wipe memory",
			description: "Clears the memory",
			annotations: { consequentialHint: true },
			execute: () => {
				runs++;
				return "wiped";
			},
		});
		const call = async () =>
			(
				await outcome(
					await handler.handle(
						request({
							name: "",
							body: rpc(1, "tools/call", {
								name: "wipe",
								arguments: { all: true },
							}),
						}),
						{ grant: GRANT },
					),
				)
			).message?.["result"] as Record<string, unknown>;
		return { call, runs: () => runs };
	};

	test("run only after the confirmation resolves true", async () => {
		let asked: ConfirmRequest | undefined;
		let answer!: (v: boolean) => void;
		const t = consequential((r) => {
			asked = r;
			return new Promise((resolve) => (answer = resolve));
		});
		const pending = t.call();
		await Bun.sleep(0);
		expect(t.runs()).toBe(0);
		expect(asked?.tool).toEqual({
			name: "wipe",
			title: "Wipe memory",
			description: "Clears the memory",
		});
		expect(asked?.arguments).toEqual({ all: true });
		expect(asked?.client.host).toBe("client.example");
		answer(true);
		expect((await pending)["content"]).toEqual([
			{ type: "text", text: "wiped" },
		]);
		expect(t.runs()).toBe(1);
	});

	test("a refusal (or a failing confirmation) is an isError result", async () => {
		for (const confirm of [
			async () => false,
			async () => Promise.reject(new Error("x")),
		]) {
			const t = consequential(confirm);
			expect(await t.call()).toMatchObject({
				isError: true,
				content: [{ type: "text", text: "The user declined" }],
			});
			expect(t.runs()).toBe(0);
		}
	});

	test("the tool list shows destructiveHint and the WebMCP hint", async () => {
		const t = ours();
		t.registry.register({
			name: "c",
			description: "C",
			annotations: { consequentialHint: true },
			execute: () => "",
		});
		const list = await outcome(
			await t.handler.handle(
				request({ name: "", body: rpc(1, "tools/list") }),
				{ grant: GRANT },
			),
		);
		const result = list.message?.["result"] as {
			tools: Record<string, unknown>[];
		};
		const tools = result.tools;
		expect(tools.find((x) => x["name"] === "c")).toEqual({
			name: "c",
			description: "C",
			inputSchema: { type: "object" },
			annotations: { destructiveHint: true },
			_meta: { "ch.ractive.tab-mcp/annotations": { consequentialHint: true } },
		});
	});
});

describe("subscriptions/listen", () => {
	test("acknowledges, then sends tools/list_changed once per change burst", async () => {
		const { registry, handler } = ours();
		const res = await handler.handle(
			request({
				name: "",
				body: rpc(7, "subscriptions/listen", {
					notifications: { toolsListChanged: true, resourcesListChanged: true },
				}),
			}),
			{ grant: GRANT },
		);
		const reader = res.body?.getReader();
		const read = async () =>
			JSON.parse(
				new TextDecoder()
					.decode((await reader?.read())?.value)
					.split("data: ")[1] ?? "",
			);
		expect(await read()).toEqual({
			jsonrpc: "2.0",
			method: "notifications/subscriptions/acknowledged",
			params: {
				notifications: { toolsListChanged: true },
				_meta: { "io.modelcontextprotocol/subscriptionId": 7 },
			},
		});
		registry.register({ name: "n1", description: "N", execute: () => "" });
		registry.register({ name: "n2", description: "N", execute: () => "" });
		handler.toolsChanged();
		handler.toolsChanged();
		expect(await read()).toEqual({
			jsonrpc: "2.0",
			method: "notifications/tools/list_changed",
			params: { _meta: { "io.modelcontextprotocol/subscriptionId": 7 } },
		});
		handler.close();
		expect(await read()).toMatchObject({
			id: 7,
			result: { resultType: "complete" },
		});
		expect((await reader?.read())?.done).toBe(true);
	});

	test("with nothing to honour it ends at once, like the SDK", async () => {
		const { handler } = ours();
		const c = {
			name: "",
			body: rpc(8, "subscriptions/listen", { notifications: {} }),
		};
		const mine = await (
			await handler.handle(request(c), { grant: GRANT })
		).text();
		const theirs = await (await sdk.fetch(request(c))).text();
		const events = (t: string) =>
			t
				.split("\n\n")
				.filter((b) => b.startsWith("event:"))
				.map((b) => JSON.parse(b.split("data: ")[1] ?? ""));
		expect(events(mine)).toEqual(events(theirs));
	});
});

test("decodeHeaderValue", () => {
	expect(decodeHeaderValue("plain")).toBe("plain");
	expect(decodeHeaderValue("=?base64?w6TDtsO8?=")).toBe("äöü");
	expect(decodeHeaderValue("=?base64?nope!?=")).toBeUndefined();
	expect(decodeHeaderValue("=?base64?/w==?=")).toBeUndefined(); // not UTF-8
});

describe("review fixes", () => {
	test("cancelling one listen stream keeps another with the same id", async () => {
		const { registry, handler } = ours();
		const open = async () => {
			const res = await handler.handle(
				request({
					name: "",
					body: rpc(1, "subscriptions/listen", {
						notifications: { toolsListChanged: true },
					}),
				}),
				{ grant: GRANT },
			);
			const reader = res.body?.getReader();
			if (reader === undefined) throw new Error("no body");
			await reader.read(); // the acknowledgement
			return reader;
		};
		const first = await open();
		const second = await open();
		await first.cancel();
		registry.register({ name: "late", description: "Late", execute: () => "" });
		handler.toolsChanged();
		const next = new TextDecoder().decode((await second.read()).value);
		expect(next).toContain("notifications/tools/list_changed");
		await second.cancel();
	});
});
