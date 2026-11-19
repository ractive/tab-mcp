import { afterEach, describe, expect, test } from "bun:test";
import {
	addressIdFromSecret,
	newSecret,
	shortAddress,
} from "../src/address.ts";
import type { HttpRequestMessage } from "../src/protocol.ts";
import { type CreateRelayOptions, VERSION } from "../src/relay.ts";
import {
	APP,
	connectClient,
	mcpPost,
	ORIGIN,
	rpc,
	ScriptedTab,
	startRelay,
	streamResponse,
	type TabOptions,
	type TestRelay,
	tokenFor,
	waitFor,
} from "./helpers.ts";

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

/** Read an SSE response until `until` matches the text so far. */
async function readUntil(
	res: Response,
	until: (text: string) => boolean,
): Promise<string[]> {
	const reader = res.body?.getReader();
	if (reader === undefined) throw new Error("no body");
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let text = "";
	while (!until(text)) {
		const { done, value } = await reader.read();
		if (done) break;
		const s = decoder.decode(value, { stream: true });
		chunks.push(s);
		text += s;
	}
	return chunks;
}

describe("tab WebSocket", () => {
	test("hello gives the address of the app, which names neither the secret nor its id (DEC-196)", async () => {
		const r = relay();
		const t = tab(r);
		const s = await t.connect();
		expect(s.address).toBe(r.relay.addressFor(APP));
		expect(s.address).toBe(`${r.relay.url}/s/${APP}/mcp`);
		expect(s.origin).toBe(ORIGIN);
		expect(s.grants).toEqual([]);
		expect(s.limits.requestTimeoutMs).toBe(300_000);
		expect(s.limits.keepAliveMs).toBe(20_000);
	});

	test("two pages of one app get the same address, a page of another app another; both stay connected", async () => {
		const r = relay();
		const a = tab(r);
		const b = tab(r);
		const other = tab(r, { appId: "other-app" });
		const sa = await a.connect();
		const sb = await b.connect();
		const so = await other.connect();
		expect(sb.address).toBe(sa.address);
		expect(so.address).toBe(`${r.relay.url}/s/other-app/mcp`);
		// The secret still is what a tab is: neither replaced the other.
		expect(r.relay.sessionCount).toBe(3);
		expect(a.received.some((m) => m.type === "bye")).toBe(false);
		expect(r.relay.pagesOf(APP).sort()).toEqual(
			[a.addressId, b.addressId].sort(),
		);
		expect(r.relay.pagesOf("other-app")).toEqual([other.addressId]);
		expect(r.relay.pagesOf("nobody")).toEqual([]);
		b.close();
		await waitFor(
			() => r.relay.pagesOf(APP).length === 1,
			"the closed page to leave its app",
		);
		expect(r.relay.pagesOf(APP)).toEqual([a.addressId]);
	});

	test("hello without an app id, or with one that is no app id, closes with 1008 and claims nothing", async () => {
		const r = relay();
		const none = tab(r, { appId: null });
		await none.opened;
		void none.connect();
		expect(await none.next("error")).toEqual({
			type: "error",
			code: "bad_message",
			message: expect.stringContaining("hello.app.id"),
		});
		expect((await none.closed).code).toBe(1008);
		for (const appId of ["Test", "-test", "test-", "a_b", "a".repeat(33)]) {
			const t = tab(r, { appId });
			void t.connect();
			expect(await t.next("error")).toMatchObject({ code: "bad_message" });
			expect((await t.closed).code).toBe(1008);
		}
		expect(r.relay.pagesOf(APP)).toEqual([]);
		expect(r.logs.events("tab.session")).toEqual([]);
	});

	test("a page whose origin may not serve the app is refused before it claims the address (DEC-197)", async () => {
		const elsewhere = "https://elsewhere.example";
		const r = relay({
			allowedOrigins: [elsewhere],
			sites: [{ origin: ORIGIN, apps: [APP] }],
		});
		const secret = newSecret();
		const owner = tab(r, { secret });
		await owner.connect();
		// Even with the owner's secret: the session of the page that may serve
		// the app is not replaced.
		const intruder = tab(r, { secret, origin: elsewhere });
		void intruder.connect();
		expect(await intruder.next("error")).toEqual({
			type: "error",
			code: "app_not_allowed",
			message: expect.stringContaining(`"${APP}"`),
		});
		expect((await intruder.closed).code).toBe(1008);
		expect(owner.ws.readyState).toBe(WebSocket.OPEN);
		expect(owner.received.some((m) => m.type === "bye")).toBe(false);
		expect(r.relay.pagesOf(APP)).toEqual([owner.addressId]);
		// The reserving origin's pages may name only its apps.
		const stray = tab(r, { appId: "other-app" });
		void stray.connect();
		expect(await stray.next("error")).toMatchObject({
			code: "app_not_allowed",
		});
		expect((await stray.closed).code).toBe(1008);
		// An app nobody reserved is open to the other origin.
		await tab(r, { origin: elsewhere, appId: "other-app" }).connect();
	});

	test("the session lists the address's grants", async () => {
		const r = relay();
		const secret = newSecret();
		await tokenFor(r.store, addressIdFromSecret(secret, APP));
		const t = tab(r, { secret });
		const s = await t.connect();
		expect(s.grants).toHaveLength(1);
		expect(s.grants[0]?.client).toEqual({
			id: "https://client.example/cimd.json",
			name: "Test client",
			host: "client.example",
		});
	});

	test("a disallowed origin gets 403, no origins configured admits nobody", async () => {
		const r = relay();
		const res = await fetch(`http://127.0.0.1:${r.relay.port}/tab`, {
			headers: {
				origin: "https://evil.example",
				"sec-websocket-protocol": "tab-mcp.v1",
			},
		});
		expect(res.status).toBe(403);
		await r.stop();
		const closed = relay({ allowedOrigins: [] });
		const res2 = await fetch(`http://127.0.0.1:${closed.relay.port}/tab`, {
			headers: { origin: ORIGIN, "sec-websocket-protocol": "tab-mcp.v1" },
		});
		expect(res2.status).toBe(403);
	});

	test("an open relay admits any origin and logs a warning", async () => {
		const r = relay({ allowedOrigins: "*" });
		expect(r.logs.events("relay.open_relay")).toHaveLength(1);
		const t = tab(r, { origin: "https://anyone.example" });
		await t.connect();
	});

	test("a wrong subprotocol gets 426", async () => {
		const r = relay();
		const res = await fetch(`http://127.0.0.1:${r.relay.port}/tab`, {
			headers: { origin: ORIGIN, "sec-websocket-protocol": "tab-mcp.v2" },
		});
		expect(res.status).toBe(426);
		expect(await res.json()).toEqual({
			error: "unsupported_protocol",
			supported: ["tab-mcp.v1"],
		});
	});

	test("sessions per IP are limited", async () => {
		const r = relay({ maxSessionsPerIp: 2 });
		const a = tab(r);
		const b = tab(r);
		await a.connect();
		await b.connect();
		const res = await fetch(`http://127.0.0.1:${r.relay.port}/tab`, {
			headers: { origin: ORIGIN, "sec-websocket-protocol": "tab-mcp.v1" },
		});
		expect(res.status).toBe(429);
		a.close();
		await a.closed;
		await waitFor(
			() => r.relay.sessionCount === 1,
			"the closed session to be released",
		);
		await tab(r).connect();
	});

	test("hello.revokeAll takes the address back with its grants revoked: the session lists none (DEC-095)", async () => {
		const r = relay();
		const secret = newSecret();
		const impostor = tab(r, { secret });
		const first = await impostor.connect();
		const token = await tokenFor(r.store, addressIdFromSecret(secret, APP));
		expect(
			(await mcpPost(first.address, rpc(1, "tools/list"), { token })).status,
		).toBe(200);
		const owner = tab(r, { secret, revokeAll: true });
		const session = await owner.connect();
		expect(session.grants).toEqual([]);
		expect(await impostor.next("bye")).toEqual({
			type: "bye",
			reason: "replaced",
		});
		expect(
			(await mcpPost(session.address, rpc(2, "tools/list"), { token })).status,
		).toBe(401);
		expect(
			await r.store.listGrants(addressIdFromSecret(secret, APP), Date.now()),
		).toEqual([]);
	});

	test("hello.revokeAll must be a boolean", async () => {
		const r = relay();
		const t = tab(r);
		await t.opened;
		t.send({
			type: "hello",
			library: { name: "x", version: "1" },
			app: { id: APP },
			secret: newSecret(),
			revokeAll: "yes",
		});
		expect(await t.next("error")).toMatchObject({
			code: "bad_message",
			message: expect.stringContaining("revokeAll"),
		});
		expect((await t.closed).code).toBe(1008);
	});

	test("the global session limit applies", async () => {
		const r = relay({ maxSessions: 1 });
		await tab(r).connect();
		const res = await fetch(`http://127.0.0.1:${r.relay.port}/tab`, {
			headers: { origin: ORIGIN, "sec-websocket-protocol": "tab-mcp.v1" },
		});
		expect(res.status).toBe(429);
	});

	test("a second session with the same secret replaces the first", async () => {
		const r = relay();
		const secret = newSecret();
		const first = tab(r, { secret });
		const s1 = await first.connect();
		const second = tab(r, { secret });
		const s2 = await second.connect();
		expect(s2.address).toBe(s1.address);
		expect(await first.next("bye")).toEqual({
			type: "bye",
			reason: "replaced",
		});
		expect((await first.closed).code).toBe(4005);
		expect(r.relay.sessionCount).toBe(1);
	});

	test("a malformed secret closes with 1008", async () => {
		const r = relay();
		const t = tab(r);
		await t.opened;
		t.send({
			type: "hello",
			library: { name: "x", version: "1" },
			app: { id: APP },
			secret: "short",
		});
		expect(await t.next("error")).toMatchObject({
			code: "bad_message",
			message: expect.stringContaining("secret"),
		});
		expect((await t.closed).code).toBe(1008);
	});

	test("no hello in time closes with 1008", async () => {
		const r = relay({ helloTimeoutMs: 50 });
		const t = tab(r);
		await t.opened;
		expect((await t.closed).code).toBe(1008);
	});

	test("a message before hello closes with 1008", async () => {
		const r = relay();
		const t = tab(r);
		await t.opened;
		t.send({ type: "pong", t: 1 });
		expect((await t.closed).code).toBe(1008);
	});

	test("binary frames are refused", async () => {
		const r = relay();
		const t = tab(r);
		await t.opened;
		t.ws.send(new Uint8Array([1, 2, 3]));
		expect((await t.closed).code).toBe(1008);
	});

	test("unknown types with an id get unknown_type, without are ignored", async () => {
		const r = relay();
		const t = tab(r);
		await t.connect();
		t.send({ type: "future.thing" });
		t.send({ type: "future.thing", id: "x1" });
		expect(await t.next("error")).toEqual({
			type: "error",
			code: "unknown_type",
			message: "unknown type future.thing",
			id: "x1",
		});
	});

	test("heartbeat: pings are answered; a silent tab is closed with 4003", async () => {
		const r = relay({ heartbeatMs: 30 });
		const alive = tab(r);
		await alive.connect();
		const silent = tab(r, { pong: false });
		await silent.connect();
		expect((await silent.closed).code).toBe(4003);
		expect(alive.ws.readyState).toBe(WebSocket.OPEN);
	});

	test("idle timeout closes with bye idle and 4002", async () => {
		const r = relay({ heartbeatMs: 20, idleTimeoutMs: 80 });
		const t = tab(r);
		await t.connect();
		expect(await t.next("bye")).toEqual({ type: "bye", reason: "idle" });
		expect((await t.closed).code).toBe(4002);
	});

	test("the session lifetime closes with bye expired and 4001", async () => {
		const r = relay({ sessionLifetimeMs: 100 });
		const t = tab(r);
		await t.connect();
		expect(await t.next("bye")).toEqual({ type: "bye", reason: "expired" });
		expect((await t.closed).code).toBe(4001);
	});

	test("bye from the tab ends the session", async () => {
		const r = relay();
		const t = tab(r);
		await t.connect();
		t.send({ type: "bye", reason: "user" });
		expect((await t.closed).code).toBe(1000);
		await waitFor(() => r.relay.sessionCount === 0, "the session to end");
	});

	test("stopping the relay sends bye shutdown and closes with 4004", async () => {
		const r = relay();
		const t = tab(r);
		await t.connect();
		await r.stop();
		expect(await t.next("bye")).toEqual({ type: "bye", reason: "shutdown" });
		expect((await t.closed).code).toBe(4004);
	});
});

describe("MCP endpoint checks", () => {
	test("GET and DELETE get 405", async () => {
		const r = relay();
		const address = r.relay.addressFor(APP);
		expect((await fetch(address)).status).toBe(405);
		expect((await fetch(address, { method: "DELETE" })).status).toBe(405);
	});

	test("a legacy initialize gets 400 / -32022 naming 2026-07-28, even without a token", async () => {
		const r = relay();
		const res = await fetch(r.relay.addressFor(APP), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "x", version: "1" },
				},
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: number; data: unknown };
		};
		expect(body.error.code).toBe(-32022);
		expect(body.error.data).toEqual({
			supported: ["2026-07-28"],
			requested: "2025-11-25",
		});
	});

	test("an initialize in a 2026-07-28 envelope reaches the tab: 404 / -32601", async () => {
		const r = relay();
		const t = tab(r);
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const res = await mcpPost(t.session?.address ?? "", rpc(1, "initialize"), {
			token,
		});
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: { code: number } }).error.code).toBe(
			-32601,
		);
	});

	test("an older version header gets -32022, a missing one -32020", async () => {
		const r = relay();
		const address = r.relay.addressFor(APP);
		const old = await mcpPost(address, rpc(1, "tools/list"), {
			headers: { "mcp-protocol-version": "2025-06-18" },
		});
		expect(old.status).toBe(400);
		expect(((await old.json()) as { error: { code: number } }).error.code).toBe(
			-32022,
		);
		const missing = await fetch(address, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(rpc(2, "tools/list")),
		});
		expect(missing.status).toBe(400);
		expect(
			((await missing.json()) as { error: { code: number } }).error.code,
		).toBe(-32020);
	});

	test("invalid JSON, batches and oversized bodies are refused", async () => {
		const r = relay({ maxMessageBytes: 16_384 });
		const address = r.relay.addressFor(APP);
		const bad = await mcpPost(address, "{nope");
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(
			-32700,
		);
		const batch = await mcpPost(address, [rpc(1, "tools/list")]);
		expect(batch.status).toBe(400);
		const big = await mcpPost(
			address,
			rpc(1, "tools/call", {
				name: "echo",
				arguments: { text: "x".repeat(20_000) },
			}),
		);
		expect(big.status).toBe(413);
	});

	test("no token, an unknown token, an expired token: 401, and the challenge names the app's metadata", async () => {
		const r = relay();
		const t = tab(r);
		await t.connect();
		const address = t.session?.address ?? "";
		const none = await mcpPost(address, rpc(1, "tools/list"));
		expect(none.status).toBe(401);
		const challenge = none.headers.get("www-authenticate") ?? "";
		expect(challenge).toBe(
			`Bearer resource_metadata="${r.relay.url}/.well-known/oauth-protected-resource/s/${APP}/mcp", scope="tools"`,
		);
		// Before a token says which page is meant, nothing names one.
		expect(challenge).not.toContain(t.addressId);

		const unknown = await mcpPost(address, rpc(1, "tools/list"), {
			token: "tmcp_at_nope",
		});
		expect(unknown.status).toBe(401);
		expect(unknown.headers.get("www-authenticate")).toBe(
			`${challenge}, error="invalid_token"`,
		);

		const expired = await tokenFor(r.store, t.addressId, {
			ttlMs: 1,
			now: Date.now() - 10,
		});
		expect(
			(await mcpPost(address, rpc(1, "tools/list"), { token: expired })).status,
		).toBe(401);
	});

	test("the token decides the page: one of another page of the app reaches that page, never this one", async () => {
		const r = relay({ pageWaitMs: 0 });
		const seen = { mine: [] as string[], theirs: [] as string[] };
		const answer =
			(list: string[]) => (msg: HttpRequestMessage, tab: ScriptedTab) => {
				list.push(msg.grant.grantId);
				tab.send({
					type: "http.response",
					id: msg.id,
					status: 200,
					headers: { "content-type": "application/json" },
					body: "{}",
				});
			};
		const mine = tab(r, { onRequest: answer(seen.mine) });
		const theirs = tab(r, { onRequest: answer(seen.theirs) });
		const address = (await mine.connect()).address;
		expect((await theirs.connect()).address).toBe(address);
		const theirToken = await tokenFor(r.store, theirs.addressId);
		const res = await mcpPost(address, rpc(1, "tools/list"), {
			token: theirToken,
		});
		expect(res.status).toBe(200);
		expect(seen.theirs).toHaveLength(1);
		expect(seen.mine).toEqual([]);

		// Their page closed: the request is not handed to the page that is
		// left, although it has the same address.
		theirs.close();
		await waitFor(() => r.relay.pagesOf(APP).length === 1, "their page to go");
		const gone = await mcpPost(address, rpc(2, "tools/list"), {
			token: theirToken,
		});
		expect(gone.status).toBe(200);
		expect(
			((await gone.json()) as { error: { code: number } }).error.code,
		).toBe(-31001);
		expect(seen.mine).toEqual([]);
		// A token for a page that never connected: the same.
		const nobody = await tokenFor(r.store, "b".repeat(52));
		const never = await mcpPost(address, rpc(3, "tools/list"), {
			token: nobody,
		});
		expect(
			((await never.json()) as { error: { code: number } }).error.code,
		).toBe(-31001);
		expect(seen.mine).toEqual([]);
	});

	test("a token is valid only at its app's address: 401 at another app's, although its page is open", async () => {
		const r = relay();
		let forwarded = 0;
		const t = tab(r, {
			onRequest: (msg, tab) => {
				forwarded++;
				tab.send({
					type: "http.response",
					id: msg.id,
					status: 200,
					headers: { "content-type": "application/json" },
					body: "{}",
				});
			},
		});
		const address = (await t.connect()).address;
		// The record names this page, but another app (and, from a store file
		// of before DEC-196, no app at all).
		for (const app of ["other-app", ""]) {
			const token = await tokenFor(r.store, t.addressId, { app });
			const res = await mcpPost(address, rpc(1, "tools/list"), { token });
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toBe(
				`Bearer resource_metadata="${r.relay.url}/.well-known/oauth-protected-resource/s/${APP}/mcp", scope="tools", error="invalid_token"`,
			);
		}
		// And this app's token is refused at the other app's address, whose
		// challenge names that app.
		const token = await tokenFor(r.store, t.addressId);
		const elsewhere = await mcpPost(
			r.relay.addressFor("other-app"),
			rpc(2, "tools/list"),
			{ token },
		);
		expect(elsewhere.status).toBe(401);
		expect(elsewhere.headers.get("www-authenticate")).toContain(
			"/.well-known/oauth-protected-resource/s/other-app/mcp",
		);
		expect(forwarded).toBe(0);
		expect(
			(await mcpPost(address, rpc(3, "tools/list"), { token })).status,
		).toBe(200);
		expect(forwarded).toBe(1);
	});

	// The address id is of the app and the secret together: a page that
	// names another app with the same secret is another page, with its own
	// session and no grants of the first.
	test("a token of one app does not reach its page once that page names another app", async () => {
		const r = relay({ pageWaitMs: 0 });
		const secret = newSecret();
		const first = tab(r, { secret });
		const address = (await first.connect()).address;
		const token = await tokenFor(r.store, first.addressId);
		let forwarded = 0;
		const renamed = tab(r, {
			secret,
			appId: "other-app",
			onRequest: (msg, tab) => {
				forwarded++;
				tab.send({
					type: "http.response",
					id: msg.id,
					status: 200,
					headers: { "content-type": "application/json" },
					body: "{}",
				});
			},
		});
		const session = await renamed.connect();
		expect(session.address).not.toBe(address);
		expect(session.grants).toEqual([]);
		expect(renamed.addressId).not.toBe(first.addressId);
		expect(
			(await mcpPost(address, rpc(1, "tools/list"), { token })).status,
		).toBe(200);
		expect(forwarded).toBe(0);
		// The first page is still there; with it gone the token reaches nobody.
		first.close();
		await first.closed;
		await mcpPost(address, rpc(2, "tools/list"), { token });
		expect(forwarded).toBe(0);
	});

	test("a revoked grant's token gets 401", async () => {
		const r = relay();
		const t = tab(r);
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const address = t.session?.address ?? "";
		expect(
			(await mcpPost(address, rpc(1, "tools/list"), { token })).status,
		).toBe(200);
		await r.store.revoke(
			{ addressId: t.addressId },
			{ now: Date.now(), keepUntil: Date.now() + 60_000 },
		);
		expect(
			(await mcpPost(address, rpc(1, "tools/list"), { token })).status,
		).toBe(401);
	});

	test("a malformed app is 404; a well-formed one is 401 whether or not a page of it is connected", async () => {
		const r = relay();
		for (const app of [
			"Bad_App",
			"TEST",
			"-test",
			"test-",
			"a".repeat(33),
			"te%22st",
			"a%2Fb",
		]) {
			const res = await mcpPost(
				`${r.relay.url}/s/${app}/mcp`,
				rpc(1, "tools/list"),
			);
			expect(res.status).toBe(404);
			expect(res.headers.get("www-authenticate")).toBeNull();
		}
		// The router decodes the path: an escaped spelling of an app id is that
		// app, and the challenge names its address as the relay writes it,
		// never as the request spelt it.
		const escaped = await mcpPost(
			`${r.relay.url}/s/te%73t/mcp`,
			rpc(1, "tools/list"),
		);
		expect(escaped.status).toBe(401);
		expect(escaped.headers.get("www-authenticate")).toBe(
			`Bearer resource_metadata="${r.relay.url}/.well-known/oauth-protected-resource/s/${APP}/mcp", scope="tools"`,
		);
		const unknown = await mcpPost(
			r.relay.addressFor("nobody-serves-this"),
			rpc(1, "tools/list"),
		);
		expect(unknown.status).toBe(401);
		expect(unknown.headers.get("www-authenticate")).toBe(
			`Bearer resource_metadata="${r.relay.url}/.well-known/oauth-protected-resource/s/nobody-serves-this/mcp", scope="tools"`,
		);
		await tab(r).connect();
		const known = await mcpPost(r.relay.addressFor(APP), rpc(1, "tools/list"));
		expect(known.status).toBe(401);
		expect(await known.text()).toBe(await unknown.text());
	});

	test("the per-tab address of before DEC-196 is gone: 404, also for its metadata", async () => {
		const r = relay();
		const t = tab(r);
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const old = await mcpPost(
			`${r.relay.url}/a/${t.addressId}/mcp`,
			rpc(1, "tools/list"),
			{ token },
		);
		expect(old.status).toBe(404);
		expect(
			(
				await fetch(
					`${r.relay.url}/.well-known/oauth-protected-resource/a/${t.addressId}/mcp`,
				)
			).status,
		).toBe(404);
		// The id of a page is no app: it cannot be put where the app goes.
		expect(
			(
				await mcpPost(
					`${r.relay.url}/s/${t.addressId}/mcp`,
					rpc(1, "tools/list"),
					{ token },
				)
			).status,
		).toBe(404);
	});

	test("a valid token while the page is not open: HTTP 200 with a JSON-RPC error (DEC-074)", async () => {
		const r = relay({ pageWaitMs: 0 });
		const secret = newSecret();
		const token = await tokenFor(r.store, addressIdFromSecret(secret, APP));
		const res = await mcpPost(r.relay.addressFor(APP), rpc(7, "tools/list"), {
			token,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			id: number;
			error: { code: number; message: string };
		};
		expect(body.id).toBe(7);
		expect(body.error.code).toBe(-31001);
		expect(body.error.message).toContain("The page is not open");
	});

	test("CORS: preflight and headers without credentials; off when configured", async () => {
		const r = relay();
		const address = r.relay.addressFor(APP);
		const pre = await fetch(address, {
			method: "OPTIONS",
			headers: {
				origin: "https://chat.example",
				"access-control-request-method": "POST",
				"access-control-request-headers":
					"authorization, content-type, mcp-protocol-version",
			},
		});
		expect(pre.status).toBe(204);
		expect(pre.headers.get("access-control-allow-origin")).toBe("*");
		expect(pre.headers.get("access-control-allow-headers")).toBe(
			"authorization, content-type, mcp-protocol-version",
		);
		expect(pre.headers.get("access-control-allow-credentials")).toBeNull();
		const res = await mcpPost(address, rpc(1, "tools/list"));
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(res.headers.get("access-control-expose-headers")).toContain(
			"www-authenticate",
		);
		await r.stop();

		const off = relay({ cors: false });
		const address2 = off.relay.addressFor(APP);
		expect((await fetch(address2, { method: "OPTIONS" })).status).toBe(405);
		expect(
			(await mcpPost(address2, rpc(1, "tools/list"))).headers.get(
				"access-control-allow-origin",
			),
		).toBeNull();
	});

	test("the concurrency limit gives 429", async () => {
		const r = relay({ maxConcurrentRequests: 1 });
		const t = tab(r, { onRequest: () => {} }); // never answers
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const address = t.session?.address ?? "";
		const abort = new AbortController();
		const first = mcpPost(address, rpc(1, "tools/list"), {
			token,
			signal: abort.signal,
		}).catch(() => undefined);
		await t.next("http.request");
		const second = await mcpPost(address, rpc(2, "tools/list"), { token });
		expect(second.status).toBe(429);
		abort.abort();
		await first;
	});
});

describe("tunnel", () => {
	test("the SDK client discovers, lists and calls tools through the relay", async () => {
		const r = relay();
		const t = tab(r);
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const client = await connectClient(t.session?.address ?? "", token);
		const tools = await client.listTools();
		expect(tools.tools.map((x) => x.name).sort()).toEqual(["add", "echo"]);
		const result = await client.callTool({
			name: "add",
			arguments: { a: 30, b: 12 },
		});
		expect(result.content).toEqual([{ type: "text", text: "42" }]);
		await client.close();
	});

	test("forwarded requests carry filtered headers and the grant, never the token", async () => {
		const r = relay();
		let seen: Record<string, unknown> | undefined;
		const t = tab(r, {
			onRequest: (msg, tab) => {
				seen = msg as unknown as Record<string, unknown>;
				tab.send({
					type: "http.response",
					id: msg.id,
					status: 200,
					headers: { "content-type": "application/json", "set-cookie": "x=1" },
					body: "{}",
				});
			},
		});
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const res = await mcpPost(t.session?.address ?? "", rpc(1, "tools/list"), {
			token,
			headers: {
				cookie: "a=b",
				"x-forwarded-for": "1.2.3.4",
				"mcp-param-region": "eu",
				traceparent: "00-abc",
			},
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie")).toBeNull();
		const headers = seen?.["headers"] as Record<string, string>;
		expect(Object.keys(headers).sort()).toEqual(
			[
				"accept",
				"content-type",
				"mcp-method",
				"mcp-param-region",
				"mcp-protocol-version",
				"traceparent",
			].sort(),
		);
		expect(JSON.stringify(seen)).not.toContain(token);
		expect(seen?.["grant"]).toEqual({
			grantId: expect.any(String),
			clientId: "https://client.example/cimd.json",
			scopes: ["tools"],
		});
		expect(seen?.["path"]).toBe("/mcp");
	});

	test("the Claude header case is forwarded as 2026-07-28 and counted", async () => {
		const r = relay();
		const t = tab(r);
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const res = await mcpPost(t.session?.address ?? "", rpc(1, "tools/list"), {
			token,
			headers: { "mcp-protocol-version": "2025-11-25" },
		});
		expect(res.status).toBe(200);
		expect(r.logs.events("mcp.claude_header_workaround")).toHaveLength(1);
		// any other mismatch stays refused
		const other = await mcpPost(
			t.session?.address ?? "",
			rpc(2, "tools/list"),
			{
				token,
				headers: { "mcp-protocol-version": "2025-06-18" },
			},
		);
		expect(other.status).toBe(400);
	});

	test("a streamed response arrives in chunks", async () => {
		const r = relay();
		const t = tab(r, {
			onRequest: async (msg, tab) => {
				tab.send({
					type: "http.response.start",
					id: msg.id,
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
				for (let i = 0; i < 3; i++) {
					tab.send({
						type: "http.response.chunk",
						id: msg.id,
						data: `event: message\ndata: {"n":${i}}\n\n`,
					});
					await Bun.sleep(40);
				}
				tab.send({ type: "http.response.end", id: msg.id });
			},
		});
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const res = await mcpPost(
			t.session?.address ?? "",
			rpc(1, "tools/call", { name: "x" }),
			{ token },
		);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(res.headers.get("x-accel-buffering")).toBe("no");
		expect(res.headers.get("cache-control")).toBe("no-cache");
		const chunks = await readUntil(res, () => false);
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		expect(chunks.join("")).toBe(
			[0, 1, 2].map((i) => `event: message\ndata: {"n":${i}}\n\n`).join(""),
		);
	});

	test("a slow tool: the relay starts the stream, sends keep-alives, then the result (DEC-039)", async () => {
		const r = relay({ keepAliveMs: 60 });
		const t = tab(r, {
			onRequest: async (msg, tab) => {
				await Bun.sleep(300);
				tab.send({
					type: "http.response",
					id: msg.id,
					status: 200,
					headers: { "content-type": "application/json" },
					body: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
				});
			},
		});
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const res = await mcpPost(
			t.session?.address ?? "",
			rpc(1, "tools/call", { name: "slow" }),
			{ token },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		const text = (await readUntil(res, () => false)).join("");
		expect(text.match(/: keep-alive\n\n/g)?.length ?? 0).toBeGreaterThanOrEqual(
			2,
		);
		expect(
			text.endsWith(
				'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
			),
		).toBe(true);
	});

	test("keep-alives are written only at event boundaries", async () => {
		const r = relay({ keepAliveMs: 40 });
		const t = tab(r, {
			onRequest: async (msg, tab) => {
				tab.send({
					type: "http.response.start",
					id: msg.id,
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
				tab.send({
					type: "http.response.chunk",
					id: msg.id,
					data: "event: message\ndata: {",
				});
				await Bun.sleep(200);
				tab.send({
					type: "http.response.chunk",
					id: msg.id,
					data: '"a":1}\n\n',
				});
				await Bun.sleep(120);
				tab.send({ type: "http.response.end", id: msg.id });
			},
		});
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const res = await mcpPost(
			t.session?.address ?? "",
			rpc(1, "tools/call", { name: "x" }),
			{ token },
		);
		const text = (await readUntil(res, () => false)).join("");
		expect(text.startsWith('event: message\ndata: {"a":1}\n\n')).toBe(true);
		expect(text).toContain(": keep-alive\n\n");
	});

	test("a tool answering after Bun's HTTP idle timeout still works", async () => {
		const r = relay({ httpIdleTimeoutS: 1, keepAliveMs: 20_000 });
		const t = tab(r);
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const client = await connectClient(t.session?.address ?? "", token);
		const result = await client.callTool({
			name: "echo",
			arguments: { text: "late", delayMs: 2500 },
		});
		expect(result.content).toEqual([{ type: "text", text: "late" }]);
		await client.close();
	}, 10_000);

	test("the request timeout gives 504 and the tab gets http.cancel", async () => {
		const r = relay({ requestTimeoutMs: 100 });
		const t = tab(r, { onRequest: () => {} });
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const res = await mcpPost(
			t.session?.address ?? "",
			rpc(3, "tools/call", { name: "x" }),
			{ token },
		);
		expect(res.status).toBe(504);
		const body: unknown = await res.json();
		expect(body).toEqual({
			jsonrpc: "2.0",
			id: 3,
			error: expect.objectContaining({ code: -31002 }),
		});
		expect(await t.next("http.cancel")).toEqual({
			type: "http.cancel",
			id: expect.any(String),
			reason: "timeout",
		});
	});

	test("a timeout on a started stream ends it with an error event", async () => {
		const r = relay({ requestTimeoutMs: 200, keepAliveMs: 50 });
		const t = tab(r, { onRequest: () => {} });
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const res = await mcpPost(
			t.session?.address ?? "",
			rpc(4, "tools/call", { name: "x" }),
			{ token },
		);
		expect(res.status).toBe(200);
		const text = (await readUntil(res, () => false)).join("");
		expect(text).toMatch(
			/event: message\ndata: \{"jsonrpc":"2.0","id":4,"error":\{"code":-31002,/,
		);
		expect((await t.next("http.cancel")).type).toBe("http.cancel");
	});

	test("listen streams are exempt from the request timeout", async () => {
		// Event-driven: the client reads the stream like a real AI app and waits
		// for keep-alives well past the request timeout. The body must stay
		// referenced: Bun's fetch closes the connection when an unread Response
		// is garbage-collected, which the relay rightly reports as client_closed.
		const r = relay({ requestTimeoutMs: 80, keepAliveMs: 40 });
		const t = tab(r, {
			onRequest: (msg, tab) => {
				tab.send({
					type: "http.response.start",
					id: msg.id,
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const res = await mcpPost(
			t.session?.address ?? "",
			rpc(5, "subscriptions/listen", {
				notifications: { toolsListChanged: true },
			}),
			{ token },
		);
		expect(res.status).toBe(200);
		const reader = res.body?.getReader();
		if (reader === undefined) throw new Error("no body");
		const decoder = new TextDecoder();
		let text = "";
		const started = Date.now();
		// Five keep-alives span at least 200 ms, more than twice the 80 ms timeout.
		while ((text.match(/: keep-alive\n\n/g)?.length ?? 0) < 5) {
			const { done, value } = await reader.read();
			if (done) throw new Error("listen stream ended");
			text += decoder.decode(value, { stream: true });
			Bun.gc(true); // GC must not matter while the body is referenced
		}
		expect(Date.now() - started).toBeGreaterThanOrEqual(160);
		expect(t.received.some((m) => m.type === "http.cancel")).toBe(false);
		expect(r.logs.events("mcp.request")).toEqual([]); // still open
		await reader.cancel();
		expect(await t.next("http.cancel")).toEqual({
			type: "http.cancel",
			id: expect.any(String),
			reason: "client_closed",
		});
	});

	test("a client abort sends http.cancel and aborts the tab's request", async () => {
		const r = relay();
		let signal: AbortSignal | undefined;
		const t = tab(r, {
			onRequest: (msg, tab) => {
				signal = tab.signalFor(msg.id);
			},
		});
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const abort = new AbortController();
		const pending = mcpPost(
			t.session?.address ?? "",
			rpc(6, "tools/call", { name: "x" }),
			{ token, signal: abort.signal },
		).catch(() => "aborted");
		await t.next("http.request");
		abort.abort();
		expect(await pending).toBe("aborted");
		expect(await t.next("http.cancel")).toEqual({
			type: "http.cancel",
			id: expect.any(String),
			reason: "client_closed",
		});
		expect(signal?.aborted).toBe(true);
	});

	test("a request in flight when the page revokes its grant ends with 401, and the challenge names the app's metadata", async () => {
		const r = relay();
		const secret = newSecret();
		const token = await tokenFor(r.store, addressIdFromSecret(secret, APP));
		const again = tab(r, {
			secret,
			onRequest: (msg, tab) => {
				tab.send({ type: "grant.revoke", grantId: msg.grant.grantId });
			},
		});
		const session = await again.connect();
		expect(session.grants).toHaveLength(1);
		const res = await mcpPost(session.address, rpc(1, "tools/list"), {
			token,
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe(
			`Bearer resource_metadata="${r.relay.url}/.well-known/oauth-protected-resource/s/${APP}/mcp", scope="tools", error="invalid_token"`,
		);
	});

	test("closing the tab fails in-flight requests; the token works again after reconnecting", async () => {
		const r = relay({ pageWaitMs: 0 });
		const secret = newSecret();
		const t = tab(r, { secret, onRequest: () => {} });
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const address = t.session?.address ?? "";
		const inFlight = mcpPost(address, rpc(8, "tools/list"), { token });
		await t.next("http.request");
		t.close();
		const res = await inFlight;
		expect(res.status).toBe(200);
		expect(((await res.json()) as { error: { code: number } }).error.code).toBe(
			-31003,
		);
		// the session was released before the in-flight request was failed
		const after = await mcpPost(address, rpc(9, "tools/list"), { token });
		expect(after.status).toBe(200);
		expect(
			((await after.json()) as { error: { code: number } }).error.code,
		).toBe(-31001);

		const again = tab(r, { secret });
		await again.connect();
		const client = await connectClient(address, token);
		expect((await client.listTools()).tools).toHaveLength(2);
		await client.close();
	});

	test("a tab message over the limit fails that request with 502", async () => {
		const r = relay({ maxMessageBytes: 16_384 });
		const t = tab(r, {
			onRequest: (msg, tab) => {
				tab.send({
					type: "http.response",
					id: msg.id,
					status: 200,
					headers: {},
					body: "x".repeat(40_000),
				});
			},
		});
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const res = await mcpPost(t.session?.address ?? "", rpc(1, "tools/list"), {
			token,
		});
		expect(res.status).toBe(502);
		expect(
			(
				await t.next(
					"error",
					(m) => m.type === "error" && m.code === "too_large",
				)
			).type,
		).toBe("error");
	});

	test("late messages for finished requests are dropped", async () => {
		const r = relay();
		const t = tab(r, {
			onRequest: (msg, tab) => {
				const response = new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
					headers: { "content-type": "application/json" },
				});
				void streamResponse(msg.id, response, tab).then(() => {
					tab.send({ type: "http.response.chunk", id: msg.id, data: "late" });
					tab.send({ type: "http.response.end", id: msg.id });
				});
			},
		});
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const res = await mcpPost(t.session?.address ?? "", rpc(1, "tools/list"), {
			token,
		});
		expect(await res.text()).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
		// A round trip after the late frames: the relay processed them in order
		// and kept the session.
		t.send({ type: "probe.after-late", id: "probe1" });
		expect(
			await t.next("error", (m) => m.type === "error" && m.id === "probe1"),
		).toMatchObject({ code: "unknown_type" });
		expect(t.ws.readyState).toBe(WebSocket.OPEN);
	});
});

describe("health and index", () => {
	test("/healthz and /", async () => {
		const r = relay();
		const health = await fetch(`${r.relay.url}/healthz`);
		expect(await health.json()).toEqual({
			status: "ok",
			version: expect.any(String),
			counters: { claudeHeaderWorkaround: 0 },
		});
		// A CDN in front must not keep an old version (bunny caches for 30 days).
		expect(health.headers.get("cache-control")).toBe("no-store");
		const index = await fetch(`${r.relay.url}/`);
		expect(index.headers.get("content-type")).toContain("text/html");
		expect(index.headers.get("cache-control")).toBe("public, max-age=3600");
		// The page loads only the relay's own stylesheet and icon.
		expect(index.headers.get("content-security-policy")).toBe(
			"default-src 'none'; style-src 'self'; img-src 'self'; frame-ancestors 'none'",
		);
		const html = await index.text();
		expect(html).toContain('<link rel="icon" href="/favicon.svg"');
		expect(html).toContain(
			`<link rel="stylesheet" href="/authorize.css?v=${VERSION}">`,
		);
		expect(html).toContain('href="https://ractive.ch/tab-mcp/"');
		expect(html).toContain(`Version ${VERSION}`);
		expect((await fetch(`${r.relay.url}/nope`)).status).toBe(404);
	});

	test("the icon: favicon.ico, favicon.svg and apple-touch-icon.png", async () => {
		const r = relay();
		const get = (path: string) => fetch(`${r.relay.url}${path}`);
		const ico = await get("/favicon.ico");
		expect(ico.headers.get("content-type")).toBe("image/x-icon");
		// ICONDIR: reserved 0, type 1 (icon), three images.
		expect([...new Uint8Array(await ico.arrayBuffer()).slice(0, 6)]).toEqual([
			0, 0, 1, 0, 3, 0,
		]);
		const svg = await get("/favicon.svg");
		expect(svg.headers.get("content-type")).toBe("image/svg+xml");
		expect(svg.headers.get("content-security-policy")).toBe(
			"default-src 'none'",
		);
		expect(await svg.text()).toStartWith("<svg ");
		const png = await get("/apple-touch-icon.png");
		expect(png.headers.get("content-type")).toBe("image/png");
		expect([...new Uint8Array(await png.arrayBuffer()).slice(1, 4)]).toEqual([
			0x50, 0x4e, 0x47,
		]);
	});
});

describe("logs", () => {
	test("no log line contains a body, tool name, argument, result, token or secret", async () => {
		const r = relay({ keepAliveMs: 50 });
		const t = tab(r);
		await t.connect();
		const token = await tokenFor(r.store, t.addressId);
		const client = await connectClient(t.session?.address ?? "", token);
		await client.callTool({
			name: "echo",
			arguments: { text: "SECRET-ARGUMENT-4711", delayMs: 120 },
		});
		await client.callTool({ name: "add", arguments: { a: 1000001, b: 1 } });
		await client.close();
		const all = r.logs.lines.join("\n");
		for (const forbidden of [
			"SECRET-ARGUMENT-4711",
			"1000002",
			"1000001",
			"echo",
			'"add"',
			token,
			t.secret,
			t.addressId,
		]) {
			expect(all).not.toContain(forbidden);
		}
		const requests = r.logs.events("mcp.request");
		expect(requests.length).toBeGreaterThanOrEqual(3);
		expect(requests.map((e) => e["method"])).toContain("tools/call");
	});

	test("lines name the app, and the page (shortened) once a token or a hello says which", async () => {
		const r = relay();
		const t = tab(r);
		const address = (await t.connect()).address;
		expect(r.logs.events("tab.session")).toEqual([
			expect.objectContaining({
				app: APP,
				address: shortAddress(t.addressId),
			}),
		]);
		await mcpPost(address, rpc(1, "tools/list"));
		await mcpPost(address, rpc(2, "tools/list"), { token: "tmcp_at_nope" });
		const token = await tokenFor(r.store, t.addressId);
		await mcpPost(address, rpc(3, "tools/list"), { token });
		const requests = r.logs.events("mcp.request");
		expect(requests).toHaveLength(3);
		for (const line of requests.slice(0, 2)) {
			expect(line).toMatchObject({ app: APP, status: 401 });
			expect(line).not.toHaveProperty("address");
		}
		expect(requests[2]).toMatchObject({
			app: APP,
			address: shortAddress(t.addressId),
			status: 200,
		});
	});
});
