import { afterEach, describe, expect, test } from "bun:test";
import { addressIdFromSecret, newSecret } from "../src/address.ts";
import type { CreateRelayOptions } from "../src/relay.ts";
import {
	mcpPost,
	rpc,
	ScriptedTab,
	startRelay,
	type TabOptions,
	type TestRelay,
	tokenFor,
	waitFor,
} from "./helpers.ts";

/** DEC-074: the relay's answer when the page is not open. */

let current: TestRelay | undefined;
const tabs: ScriptedTab[] = [];

function relay(options: CreateRelayOptions = {}): TestRelay {
	current = startRelay(options);
	return current;
}

function tab(r: TestRelay, options: TabOptions = {}): ScriptedTab {
	const t = new ScriptedTab(r.wsUrl, options);
	tabs.push(t);
	return t;
}

afterEach(async () => {
	for (const t of tabs.splice(0)) {
		if (t.ws.readyState <= 1) t.close();
	}
	await current?.stop();
	current = undefined;
});

interface RpcMessage {
	jsonrpc: string;
	id: number | string | null;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

/** The JSON-RPC response in a JSON or SSE body. */
async function rpcMessage(res: Response): Promise<RpcMessage> {
	const text = await res.text();
	if (!(res.headers.get("content-type") ?? "").startsWith("text/event-stream"))
		return JSON.parse(text) as RpcMessage;
	const messages = text
		.split(/\n\n/)
		.map((event) =>
			event
				.split("\n")
				.filter((l) => l.startsWith("data: "))
				.map((l) => l.slice(6))
				.join("\n"),
		)
		.filter((d) => d !== "")
		.map((d) => JSON.parse(d) as RpcMessage);
	const last = messages.findLast((m) => "result" in m || "error" in m);
	if (last === undefined) throw new Error(`no response in ${text}`);
	return last;
}

function toolText(message: RpcMessage): string {
	const content = message.result?.["content"] as { text: string }[] | undefined;
	return content?.[0]?.text ?? "";
}

async function closedAddress(r: TestRelay) {
	const secret = newSecret();
	const token = await tokenFor(r.store, addressIdFromSecret(secret));
	return { secret, token, address: r.relay.addressFor(secret) };
}

describe("answers at HTTP 200 when the page stays away", () => {
	test("tools/call: a tool result with isError and what to do", async () => {
		const r = relay({ pageWaitMs: 0 });
		const { token, address } = await closedAddress(r);
		const res = await mcpPost(address, rpc(3, "tools/call", { name: "add" }), {
			token,
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/json");
		const message = await rpcMessage(res);
		expect(message.id).toBe(3);
		expect(message.result?.["isError"]).toBe(true);
		expect(message.result?.["resultType"]).toBe("complete");
		expect(toolText(message)).toBe(
			"The page is not open, or not in front. Ask the user to open the web page and keep it in front (on a phone, in split screen), then try again.",
		);
		const line = r.logs.events("mcp.request").at(-1);
		expect(line).toMatchObject({
			method: "tools/call",
			status: 200,
			reason: "page_not_open",
		});
	});

	test("the text names the page's app once it has connected", async () => {
		const r = relay({ pageWaitMs: 0 });
		const t = tab(r, { app: "Calculator" });
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const address = t.session?.address ?? "";
		t.close();
		await waitFor(() => r.relay.sessionCount === 0, "the session to end");
		const res = await mcpPost(address, rpc(1, "tools/call", { name: "add" }), {
			token,
		});
		expect(toolText(await rpcMessage(res))).toContain(
			"Ask the user to open Calculator and keep it in front",
		);
	});

	test("server/discover: a stand-in result with ttlMs 0, so the era probe succeeds", async () => {
		const r = relay({ pageWaitMs: 0 });
		const { token, address } = await closedAddress(r);
		const res = await mcpPost(address, rpc(1, "server/discover"), { token });
		expect(res.status).toBe(200);
		const message = await rpcMessage(res);
		expect(message.error).toBeUndefined();
		expect(message.result).toMatchObject({
			resultType: "complete",
			supportedVersions: ["2026-07-28"],
			capabilities: { tools: { listChanged: true } },
			ttlMs: 0,
			cacheScope: "private",
			instructions: expect.stringContaining("The page is not open"),
		});
	});

	test("tools/list and subscriptions/listen: a JSON-RPC error, not an empty list", async () => {
		const r = relay({ pageWaitMs: 0 });
		const { token, address } = await closedAddress(r);
		for (const [id, method] of [
			[4, "tools/list"],
			["l", "subscriptions/listen"],
		] as const) {
			const res = await mcpPost(address, rpc(id, method), { token });
			expect(res.status).toBe(200);
			const message = await rpcMessage(res);
			expect(message.id).toBe(id);
			expect(message.result).toBeUndefined();
			expect(message.error?.code).toBe(-31001);
			expect(message.error?.message).toContain("The page is not open");
		}
	});

	test("a notification keeps HTTP 503 (the spec requires an error status)", async () => {
		const r = relay({ pageWaitMs: 0 });
		const { token, address } = await closedAddress(r);
		const { id: _id, ...notification } = rpc(1, "notifications/initialized");
		const res = await mcpPost(address, notification, { token });
		expect(res.status).toBe(503);
	});

	test("a missing token is still 401 while the page is closed", async () => {
		const r = relay({ pageWaitMs: 5_000 });
		const { address } = await closedAddress(r);
		const started = Date.now();
		const res = await mcpPost(address, rpc(1, "tools/list"));
		expect(res.status).toBe(401);
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});

describe("the grace period", () => {
	test("a request waits for the page and is forwarded when it connects", async () => {
		const r = relay({ pageWaitMs: 3_000 });
		const { secret, token, address } = await closedAddress(r);
		const pending = mcpPost(address, rpc(5, "tools/list"), { token });
		await Bun.sleep(150);
		await tab(r, { secret }).connect();
		const res = await pending;
		expect(res.status).toBe(200);
		const message = await rpcMessage(res);
		const tools = (message.result?.["tools"] ?? []) as { name: string }[];
		expect(tools.map((t) => t.name).sort()).toEqual(["add", "echo"]);
	});

	test("server/discover does not wait: clients probe with a short timeout", async () => {
		const r = relay({ pageWaitMs: 5_000 });
		const { token, address } = await closedAddress(r);
		const started = Date.now();
		const res = await mcpPost(address, rpc(1, "server/discover"), { token });
		expect(Date.now() - started).toBeLessThan(1_000);
		expect((await rpcMessage(res)).result?.["ttlMs"]).toBe(0);
	});

	test("a request larger than 16 KiB does not wait: it holds no body for long", async () => {
		const r = relay({ pageWaitMs: 3_000 });
		const { token, address } = await closedAddress(r);
		const started = Date.now();
		const res = await mcpPost(
			address,
			rpc(1, "tools/call", {
				name: "echo",
				arguments: { text: "x".repeat(20_000) },
			}),
			{ token },
		);
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(res.status).toBe(200);
		expect(JSON.stringify(await res.json())).toContain("The page is not open");
	});

	test("after the grace period the relay answers 'not open'", async () => {
		const r = relay({ pageWaitMs: 200 });
		const { token, address } = await closedAddress(r);
		const started = Date.now();
		const res = await mcpPost(address, rpc(1, "tools/call", { name: "add" }), {
			token,
		});
		expect(Date.now() - started).toBeGreaterThanOrEqual(190);
		expect(res.status).toBe(200);
		expect((await rpcMessage(res)).result?.["isError"]).toBe(true);
	});

	test("the wait ends when the AI app aborts its request", async () => {
		const r = relay({ pageWaitMs: 5_000 });
		const { token, address } = await closedAddress(r);
		const abort = new AbortController();
		const pending = mcpPost(address, rpc(1, "tools/list"), {
			token,
			signal: abort.signal,
		}).catch(() => "aborted");
		await Bun.sleep(100);
		const started = Date.now();
		abort.abort();
		expect(await pending).toBe("aborted");
		await waitFor(
			() =>
				r.logs
					.events("mcp.request")
					.some((e) => e["status"] === 499 && e["outcome"] === "client_closed"),
			"the 499 log line",
		);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test("waiting requests are bounded per address: beyond the limit the answer comes at once", async () => {
		const r = relay({ pageWaitMs: 5_000, maxConcurrentRequests: 1 });
		const { token, address } = await closedAddress(r);
		const abort = new AbortController();
		const first = mcpPost(address, rpc(1, "tools/list"), {
			token,
			signal: abort.signal,
		}).catch(() => "aborted");
		await Bun.sleep(100);
		const started = Date.now();
		const second = await mcpPost(address, rpc(2, "tools/list"), { token });
		expect(Date.now() - started).toBeLessThan(1_000);
		expect((await rpcMessage(second)).error?.code).toBe(-31001);
		abort.abort();
		expect(await first).toBe("aborted");
	});

	test("waiting requests are bounded in total by maxSessions", async () => {
		const r = relay({ pageWaitMs: 5_000, maxSessions: 1 });
		const a = await closedAddress(r);
		const b = await closedAddress(r);
		const abort = new AbortController();
		const first = mcpPost(a.address, rpc(1, "tools/list"), {
			token: a.token,
			signal: abort.signal,
		}).catch(() => "aborted");
		await Bun.sleep(100);
		const started = Date.now();
		const other = await mcpPost(b.address, rpc(2, "tools/list"), {
			token: b.token,
		});
		expect(Date.now() - started).toBeLessThan(1_000);
		expect((await rpcMessage(other)).error?.code).toBe(-31001);
		abort.abort();
		expect(await first).toBe("aborted");
	});

	test("stopping the relay ends waiting requests", async () => {
		const r = relay({ pageWaitMs: 5_000 });
		const { token, address } = await closedAddress(r);
		const pending = mcpPost(address, rpc(1, "tools/list"), { token }).then(
			(res) => res.status,
			() => "closed",
		);
		await Bun.sleep(100);
		const started = Date.now();
		await r.stop();
		current = undefined;
		await pending;
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});

describe("the page goes away mid-request", () => {
	test("tools/list is sent again once the page is back", async () => {
		const r = relay({ pageWaitMs: 3_000 });
		const secret = newSecret();
		const first = tab(r, { secret, onRequest: () => {} });
		await first.connect();
		const token = await tokenFor(r.store, first.addressId);
		const address = first.session?.address ?? "";
		const pending = mcpPost(address, rpc(8, "tools/list"), { token });
		await first.next("http.request");
		first.close();
		await Bun.sleep(100);
		await tab(r, { secret }).connect();
		const res = await pending;
		expect(res.status).toBe(200);
		const message = await rpcMessage(res);
		expect(message.id).toBe(8);
		expect(
			((message.result?.["tools"] ?? []) as { name: string }[]).map(
				(t) => t.name,
			),
		).toContain("add");
		// one log line for the request, the one that answered
		expect(
			r.logs.events("mcp.request").filter((e) => e["method"] === "tools/list"),
		).toHaveLength(1);
	});

	test("tools/call is not sent twice: a tool result says it may have run", async () => {
		const r = relay({ pageWaitMs: 3_000 });
		const secret = newSecret();
		const first = tab(r, { secret, onRequest: () => {}, app: "Calculator" });
		await first.connect();
		const token = await tokenFor(r.store, first.addressId);
		const address = first.session?.address ?? "";
		const pending = mcpPost(
			address,
			rpc(9, "tools/call", { name: "add", arguments: { a: 1, b: 2 } }),
			{ token },
		);
		await first.next("http.request");
		const second = tab(r, { secret });
		first.close();
		const res = await pending;
		expect(res.status).toBe(200);
		const message = await rpcMessage(res);
		expect(message.result?.["isError"]).toBe(true);
		expect(toolText(message)).toBe(
			"The page closed while the tool was running, so it may or may not have finished. Ask the user to open Calculator and keep it in front (on a phone, in split screen), then check the result before trying again.",
		);
		await second.connect();
		await Bun.sleep(100);
		expect(second.received.some((m) => m.type === "http.request")).toBe(false);
		expect(r.logs.events("mcp.request").at(-1)).toMatchObject({
			method: "tools/call",
			status: 200,
			outcome: "page_gone",
			reason: "page_not_open",
		});
	});

	test("on a stream the relay already started, the tool result is the last event", async () => {
		const r = relay({ pageWaitMs: 3_000, keepAliveMs: 50 });
		const first = tab(r, { onRequest: () => {} });
		await first.connect();
		const token = await tokenFor(r.store, first.addressId);
		const res = await mcpPost(
			first.session?.address ?? "",
			rpc(10, "tools/call", { name: "add" }),
			{ token },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		first.close();
		const message = await rpcMessage(res);
		expect(message.id).toBe(10);
		expect(message.result?.["isError"]).toBe(true);
	});

	test("server/discover is not sent again: the stand-in result at once", async () => {
		const r = relay({ pageWaitMs: 5_000 });
		const first = tab(r, { onRequest: () => {} });
		await first.connect();
		const token = await tokenFor(r.store, first.addressId);
		const pending = mcpPost(
			first.session?.address ?? "",
			rpc(12, "server/discover"),
			{ token },
		);
		await first.next("http.request");
		const started = Date.now();
		first.close();
		const res = await pending;
		expect(Date.now() - started).toBeLessThan(1_000);
		const message = await rpcMessage(res);
		expect(message.id).toBe(12);
		expect(message.result?.["supportedVersions"]).toEqual(["2026-07-28"]);
	});

	test("with the grace period off, tools/list gets the error at once", async () => {
		const r = relay({ pageWaitMs: 0 });
		const first = tab(r, { onRequest: () => {} });
		await first.connect();
		const token = await tokenFor(r.store, first.addressId);
		const pending = mcpPost(
			first.session?.address ?? "",
			rpc(11, "tools/list"),
			{ token },
		);
		await first.next("http.request");
		first.close();
		const res = await pending;
		expect(res.status).toBe(200);
		expect((await rpcMessage(res)).error?.code).toBe(-31003);
	});
});
