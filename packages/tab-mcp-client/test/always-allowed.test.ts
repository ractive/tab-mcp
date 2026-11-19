/**
 * The tools that run without asking (DEC-096, DEC-200): per grant, what the
 * user saw of each tool, "everything", kept in `storage` until the relay
 * says the grant ended, and honoured wherever a call is confirmed.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { allowedTools } from "../src/allowed.ts";
import { allowedFor } from "../src/always-allowed.ts";
import { confirmCall } from "../src/confirm.ts";
import type { TabMcp } from "../src/tab-mcp.ts";
import type {
	ConfirmRequest,
	Grant,
	RelayClient,
	TabMcpOptions,
	Tool,
} from "../src/types.ts";
import {
	MemoryStorage,
	mcpPost,
	newTab,
	nextEnd,
	rpc,
	startRelay,
	type TestRelay,
	tokenFor,
} from "./helpers.ts";
import { StubRelay } from "./stub-relay.ts";

const grant = (grantId: string): Grant => ({
	grantId,
	client: { id: "https://claude.ai/c.json", name: "Claude", host: "claude.ai" },
	createdAt: "2026-11-19T20:00:00.000Z",
});

const asking = (
	name: string,
	description = `Does ${name}`,
	extra: Partial<Tool> = {},
): Tool => ({
	name,
	description,
	annotations: { consequentialHint: true },
	execute: () => "ok",
	...extra,
});

const relayClient = (grantId: string): RelayClient => ({
	kind: "relay",
	grantId,
	id: "https://claude.ai/c.json",
	name: "Claude",
	host: "claude.ai",
});

const request = (
	grantId: string,
	tool: ConfirmRequest["tool"],
): ConfirmRequest => ({
	tool,
	arguments: { all: true },
	client: relayClient(grantId),
	signal: new AbortController().signal,
});

/** The kept value, parsed: what a page's storage holds. */
function kept(storage: MemoryStorage): unknown {
	const entry = [...storage.items].find(([key]) => key.endsWith("#allowed"));
	return entry === undefined ? undefined : JSON.parse(entry[1]);
}

describe("the allowances, with a stub relay", () => {
	let relay: StubRelay;
	const tabs: TabMcp[] = [];
	const tab = (options: Partial<TabMcpOptions> = {}) => {
		const t = newTab(relay.url, options);
		tabs.push(t);
		return t;
	};
	beforeAll(() => {
		relay = new StubRelay();
	});
	afterAll(() => relay.stop());
	afterEach(() => {
		for (const t of tabs.splice(0)) t.disconnect();
	});

	test("per grant and tool, as the user saw it: a call that shows another description is asked again (CU 11)", async () => {
		relay.grants = [grant("g_1"), grant("g_2")];
		const storage = new MemoryStorage();
		const t = tab({ storage });
		await t.registerTool(asking("clear_memory", "Clears", { title: "Clear" }));
		await t.connect();
		const allowed = allowedTools(t);
		expect(allowed.kept).toBe(true);
		expect(allowed.tools()).toEqual([
			{
				name: "clear_memory",
				title: "Clear",
				description: "Clears",
				destructive: false,
			},
		]);
		allowed.allow("g_1", "clear_memory");
		expect(allowed.has("g_1", "clear_memory")).toBe(true);
		expect(allowed.has("g_2", "clear_memory")).toBe(false);
		expect(allowed.list("g_1")).toEqual(["clear_memory"]);
		// What the call shows decides: another description is not what was allowed.
		const store = allowedFor(t);
		expect(
			store.allows("g_1", {
				name: "clear_memory",
				title: "Clear",
				description: "Clears",
			}),
		).toBe(true);
		expect(
			store.allows("g_1", {
				name: "clear_memory",
				title: "Clear",
				description: "Clears all, and more",
			}),
		).toBe(false);
	});

	test("the queries only read; one rule for drawing and deciding; clean-up when another tab's change arrives (review of PR 167)", async () => {
		relay.grants = [grant("g_1")];
		const storage = new MemoryStorage();
		const t = tab({ storage });
		await t.registerTool(asking("x", "D2"));
		await t.connect();
		const allowed = allowedTools(t);
		allowed.allow("g_1", "x");
		const key = [...storage.items.keys()].find((k) =>
			k.endsWith("#allowed"),
		) as string;
		// Another tab, with another build, allowed x as it shows it there (D1).
		const theirs = (storage.items.get(key) as string).replace('"D2"', '"D1"');
		storage.setItem(key, theirs);
		let changes = 0;
		const stop = allowed.onChange(() => changes++);
		// Drawn and decided alike: x asks here, and nothing is written meanwhile.
		expect(allowed.list("g_1")).toEqual([]);
		expect(allowed.has("g_1", "x")).toBe(false);
		expect(allowedFor(t).allows("g_1", { name: "x", description: "D2" })).toBe(
			false,
		);
		expect(storage.items.get(key)).toBe(theirs);
		expect(changes).toBe(0);
		// The storage event cleans up against this page's tools.
		globalThis.dispatchEvent(Object.assign(new Event("storage"), { key }));
		expect(changes).toBe(1);
		expect(kept(storage)).toMatchObject({ grants: [] });
		stop();
	});

	test("the methods are bound: they work taken off the object (review of PR 167)", async () => {
		relay.grants = [grant("g_1")];
		const t = tab({ storage: new MemoryStorage() });
		await t.registerTool(asking("a"));
		await t.connect();
		const {
			allow,
			ask,
			has,
			list,
			tools,
			everything,
			setEverything,
			forget,
			onChange,
		} = allowedTools(t);
		let changes = 0;
		const stop = onChange(() => changes++);
		expect(tools().map((x) => x.name)).toEqual(["a"]);
		allow("g_1", "a");
		expect(has("g_1", "a")).toBe(true);
		expect(list("g_1")).toEqual(["a"]);
		ask("g_1", "a");
		expect(has("g_1", "a")).toBe(false);
		setEverything("g_1", true);
		expect(everything("g_1")).toBe(true);
		forget("g_1");
		expect(everything("g_1")).toBe(false);
		expect(changes).toBe(4);
		stop();
	});

	test("ask while everything is on turns everything off and keeps the other tools (review of PR 167)", async () => {
		relay.grants = [grant("g_1")];
		const t = tab({ storage: new MemoryStorage() });
		for (const name of ["a", "b", "wipe"]) await t.registerTool(asking(name));
		await t.connect();
		const allowed = allowedTools(t);
		allowed.allow("g_1", "a");
		allowed.allow("g_1", "wipe");
		allowed.setEverything("g_1", true);
		expect(allowed.has("g_1", "b")).toBe(true);
		allowed.ask("g_1", "wipe");
		expect(allowed.everything("g_1")).toBe(false);
		expect(allowed.has("g_1", "wipe")).toBe(false);
		expect(allowed.has("g_1", "b")).toBe(false);
		expect(allowed.list("g_1")).toEqual(["a"]);
		// Asking for one that was never listed, under everything: everything goes too.
		allowed.setEverything("g_1", true);
		allowed.ask("g_1", "b");
		expect(allowed.everything("g_1")).toBe(false);
		expect(allowed.list("g_1")).toEqual(["a"]);
	});

	test("a failed write keeps the allowance for the page's lifetime; the next read does not drop it (review of PR 167)", async () => {
		relay.grants = [grant("g_1")];
		class Full extends MemoryStorage {
			full = false;
			override setItem(key: string, value: string): void {
				if (this.full && key.endsWith("#allowed"))
					throw new DOMException("full", "QuotaExceededError");
				super.setItem(key, value);
			}
		}
		const storage = new Full();
		const t = tab({ storage });
		for (const name of ["a", "b"]) await t.registerTool(asking(name));
		await t.connect();
		const allowed = allowedTools(t);
		allowed.allow("g_1", "a");
		storage.full = true;
		allowed.allow("g_1", "b");
		expect(allowed.list("g_1")).toEqual(["a", "b"]);
		expect(allowed.has("g_1", "b")).toBe(true);
		expect(kept(storage)).toMatchObject({
			grants: [{ tools: [{ name: "a" }] }],
		});
		// Room again: the next write saves what memory holds.
		storage.full = false;
		allowed.ask("g_1", "a");
		expect(kept(storage)).toMatchObject({
			grants: [{ tools: [{ name: "b" }] }],
		});
		expect(allowed.list("g_1")).toEqual(["b"]);
	});

	test("a tool registered again with another description leaves every list; one registered again unchanged keeps it (useTool)", async () => {
		relay.grants = [grant("g_1")];
		const t = tab({ storage: new MemoryStorage() });
		let registration = new AbortController();
		await t.registerTool(asking("delete_item"), {
			signal: registration.signal,
		});
		await t.connect();
		const allowed = allowedTools(t);
		allowed.allow("g_1", "delete_item");
		// What React does when a component's effect runs again.
		registration.abort();
		registration = new AbortController();
		await t.registerTool(asking("delete_item"), {
			signal: registration.signal,
		});
		expect(allowed.has("g_1", "delete_item")).toBe(true);
		// Gone for now: still allowed, for when it comes back unchanged.
		registration.abort();
		expect(allowed.list("g_1")).toEqual(["delete_item"]);
		expect(allowed.has("g_1", "delete_item")).toBe(false);
		registration = new AbortController();
		await t.registerTool(asking("delete_item", "Deletes every item"), {
			signal: registration.signal,
		});
		expect(allowed.list("g_1")).toEqual([]);
		expect(allowed.has("g_1", "delete_item")).toBe(false);
	});

	test("everything: every tool, also later, changed and destructive ones; a change does not end it", async () => {
		relay.grants = [grant("g_1"), grant("g_2")];
		const t = tab({ storage: new MemoryStorage() });
		await t.registerTool(asking("a"));
		await t.connect();
		const allowed = allowedTools(t);
		let changes = 0;
		const stop = allowed.onChange(() => changes++);
		allowed.setEverything("g_1", true);
		expect(changes).toBe(1);
		expect(allowed.everything("g_1")).toBe(true);
		expect(allowed.everything("g_2")).toBe(false);
		await t.registerTool(
			asking("wipe", "Wipes", {
				annotations: { consequentialHint: true, destructiveHint: true },
			}),
		);
		expect(changes).toBe(2); // tools() changed
		expect(allowed.tools().map((x) => [x.name, x.destructive])).toEqual([
			["a", false],
			["wipe", true],
		]);
		expect(allowed.has("g_1", "wipe")).toBe(true);
		expect(
			allowedFor(t).allows("g_1", { name: "never_seen", description: "?" }),
		).toBe(true);
		expect(allowed.has("g_2", "wipe")).toBe(false);
		allowed.setEverything("g_1", false);
		expect(allowed.has("g_1", "a")).toBe(false);
		stop();
		allowed.setEverything("g_1", true);
		expect(changes).toBe(3);
		allowed.forget("g_1");
		expect(allowed.everything("g_1")).toBe(false);
	});

	test("nothing for an app the relay does not list, a tool that does not ask, or one not registered", async () => {
		relay.grants = [grant("g_1")];
		const t = tab({ storage: new MemoryStorage() });
		await t.registerTool({
			name: "read",
			description: "Reads",
			execute: () => 1,
		});
		await t.registerTool(asking("relay_never", "Only here"), {
			callers: ["webmcp"],
		});
		await t.registerTool(asking("a"));
		const allowed = allowedTools(t);
		// Not connected yet: no grants to allow for.
		allowed.allow("g_1", "a");
		allowed.setEverything("g_1", true);
		expect(allowed.list("g_1")).toEqual([]);
		expect(allowed.everything("g_1")).toBe(false);
		await t.connect();
		expect(allowed.tools().map((x) => x.name)).toEqual(["a"]);
		for (const name of ["read", "relay_never", "nope"])
			allowed.allow("g_1", name);
		allowed.allow("g_9", "a");
		allowed.setEverything("g_9", true);
		expect(allowed.list("g_1")).toEqual([]);
		expect(allowed.everything("g_9")).toBe(false);
		// Asking again needs no grant.
		allowed.allow("g_1", "a");
		allowed.ask("g_1", "a");
		expect(allowed.list("g_1")).toEqual([]);
	});

	test("kept in storage under the secret's key: grant ids, names, what the user saw; no arguments", async () => {
		relay.grants = [grant("g_1")];
		const storage = new MemoryStorage();
		const t = tab({ storage, alwaysAllow: true });
		await t.registerTool(asking("clear_memory", "Clears", { title: "Clear" }));
		await t.connect();
		allowedFor(t).keep("g_1", {
			name: "clear_memory",
			title: "Clear",
			description: "Clears",
		});
		const keys = [...storage.items.keys()];
		const secretKey = keys.find((k) => !k.endsWith("#allowed")) as string;
		expect(keys.sort()).toEqual([secretKey, `${secretKey}#allowed`]);
		expect(kept(storage)).toEqual({
			secret: expect.stringMatching(/^[0-9a-f]{1,8}$/),
			grants: [
				{
					grantId: "g_1",
					everything: false,
					tools: [
						{ name: "clear_memory", description: "Clears", title: "Clear" },
					],
				},
			],
		});
		// Only a fingerprint of the secret, never the secret.
		expect(storage.items.get(`${secretKey}#allowed`)).not.toContain(
			storage.items.get(secretKey) as string,
		);
	});

	test("allow, reload, connect: still allowed; kept through a dropped connection and before connecting", async () => {
		relay.grants = [grant("g_1")];
		const storage = new MemoryStorage();
		const first = tab({ storage, alwaysAllow: true });
		await first.registerTool(asking("a"));
		await first.connect();
		allowedTools(first).allow("g_1", "a");
		// The connection drops: no grantschange, nothing pruned.
		const gone = nextEnd(first);
		relay.close(1001);
		expect((await gone).state).toBe("reconnecting");
		expect(allowedTools(first).has("g_1", "a")).toBe(true);
		first.disconnect();
		expect(kept(storage)).toMatchObject({ grants: [{ grantId: "g_1" }] });
		// A reload: a new TabMcp on the same storage, not connected yet.
		const second = tab({ storage, alwaysAllow: true });
		await second.registerTool(asking("a"));
		const allowed = allowedTools(second);
		expect(allowed.has("g_1", "a")).toBe(true);
		await second.connect();
		expect(allowed.has("g_1", "a")).toBe(true);
		expect(kept(storage)).toMatchObject({ grants: [{ grantId: "g_1" }] });
	});

	test("disconnecting the app in the page ends it, also in storage", async () => {
		relay.grants = [grant("g_1"), grant("g_2")];
		const storage = new MemoryStorage();
		const t = tab({ storage, alwaysAllow: true });
		await t.registerTool(asking("a"));
		await t.connect();
		const allowed = allowedTools(t);
		allowed.allow("g_1", "a");
		allowed.setEverything("g_2", true);
		const revoked = t.revoke("g_1");
		await relay.next("grant.revoke");
		relay.send({ type: "grant.removed", grantId: "g_1", reason: "revoked" });
		await revoked;
		expect(allowed.has("g_1", "a")).toBe(false);
		expect(allowed.list("g_1")).toEqual([]);
		expect(allowed.everything("g_2")).toBe(true);
		expect(kept(storage)).toMatchObject({ grants: [{ grantId: "g_2" }] });
		// The same grant id back (it never is): asked again.
		relay.send({ type: "grant.added", grant: grant("g_1") });
		await relay.settled();
		expect(allowed.has("g_1", "a")).toBe(false);
	});

	test("a grant the relay no longer lists after a reload (expired, disconnected elsewhere) is pruned on connect, not before", async () => {
		relay.grants = [grant("g_1"), grant("g_2")];
		const storage = new MemoryStorage();
		const first = tab({ storage });
		await first.registerTool(asking("a"));
		await first.connect();
		allowedTools(first).allow("g_1", "a");
		allowedTools(first).allow("g_2", "a");
		first.disconnect();
		relay.grants = [grant("g_2")];
		const second = tab({ storage });
		await second.registerTool(asking("a"));
		expect(allowedTools(second).list("g_1")).toEqual(["a"]);
		await second.connect();
		expect(allowedTools(second).list("g_1")).toEqual([]);
		expect(allowedTools(second).list("g_2")).toEqual(["a"]);
		expect(kept(storage)).toMatchObject({ grants: [{ grantId: "g_2" }] });
	});

	test("made while connected: grants the relay does not list are pruned at once", async () => {
		relay.grants = [grant("g_1")];
		const storage = new MemoryStorage();
		const first = tab({ storage });
		await first.registerTool(asking("a"));
		await first.connect();
		allowedTools(first).allow("g_1", "a");
		first.disconnect();
		relay.grants = [];
		const second = tab({ storage });
		await second.connect(); // nothing has asked for the allowances yet
		expect(allowedTools(second).list("g_1")).toEqual([]);
	});

	test("newAddress(): all gone, here and for a page that kept them under the old secret", async () => {
		relay.grants = [grant("g_1")];
		const storage = new MemoryStorage();
		const t = tab({ storage, alwaysAllow: true });
		await t.registerTool(asking("a"));
		await t.connect();
		allowedTools(t).allow("g_1", "a");
		allowedTools(t).setEverything("g_1", true);
		// Another tab on the same storage that has not asked for them yet.
		const other = tab({ storage, alwaysAllow: true });
		await t.newAddress();
		expect(allowedTools(t).list("g_1")).toEqual([]);
		expect(allowedTools(t).everything("g_1")).toBe(false);
		expect(allowedTools(other).everything("g_1")).toBe(false);
		expect(kept(storage)).toMatchObject({ grants: [] });
	});

	test("a page where nothing is allowed writes nothing next to the secret", async () => {
		relay.grants = [grant("g_1")];
		const storage = new MemoryStorage();
		const t = tab({ storage, onConfirm: () => false });
		await t.registerTool(asking("a"));
		await t.connect();
		expect(
			await confirmCall(
				t,
				request("g_1", { name: "a", description: "Does a" }),
				() => false,
			),
		).toBe(false);
		relay.send({ type: "grant.added", grant: grant("g_2") });
		await relay.settled();
		expect(kept(storage)).toBeUndefined();
		expect(storage.items.size).toBe(1); // the secret
	});

	test("another tab's change counts at once: storage is read first", async () => {
		relay.grants = [grant("g_1")];
		const storage = new MemoryStorage();
		const a = tab({ storage });
		const b = tab({ storage });
		for (const t of [a, b]) await t.registerTool(asking("x"));
		await a.connect();
		allowedTools(a).setEverything("g_1", true);
		expect(allowedTools(b).everything("g_1")).toBe(true);
		allowedTools(b).forget("g_1");
		expect(allowedTools(a).everything("g_1")).toBe(false);
		expect(
			allowedFor(a).allows("g_1", { name: "x", description: "Does x" }),
		).toBe(false);
	});

	test("anything stored that is not exactly the format allows nothing", async () => {
		relay.grants = [grant("g_1")];
		const storage = new MemoryStorage();
		const t = tab({ storage });
		await t.registerTool(asking("a"));
		await t.connect();
		allowedTools(t).setEverything("g_1", true);
		const key = [...storage.items.keys()].find((k) =>
			k.endsWith("#allowed"),
		) as string;
		const good = storage.items.get(key) as string;
		for (const bad of [
			"not json",
			"null",
			good.replace('"everything":true', '"everything":"true"'),
			good.replace(/"secret":"[0-9a-f]+"/, '"secret":"0"'),
			good.replace('"tools":[]', '"tools":[{"name":"a"}]'),
		]) {
			storage.setItem(key, bad);
			expect({ bad, everything: allowedTools(t).everything("g_1") }).toEqual({
				bad,
				everything: false,
			});
		}
	});

	test('"until-reload" and storage: null keep them in memory only', async () => {
		relay.grants = [grant("g_1")];
		const storage = new MemoryStorage();
		const t = tab({ storage, alwaysAllow: "until-reload" });
		await t.registerTool(asking("a"));
		await t.connect();
		const allowed = allowedTools(t);
		expect(allowed.kept).toBe(false);
		allowed.allow("g_1", "a");
		expect(allowed.has("g_1", "a")).toBe(true);
		expect(kept(storage)).toBeUndefined();
		const reloaded = tab({ storage, alwaysAllow: "until-reload" });
		await reloaded.registerTool(asking("a"));
		expect(allowedTools(reloaded).has("g_1", "a")).toBe(false);

		const memory = tab({ storage: null, alwaysAllow: true });
		await memory.registerTool(asking("a"));
		await memory.connect();
		expect(allowedTools(memory).kept).toBe(false);
		allowedTools(memory).allow("g_1", "a");
		expect(allowedTools(memory).has("g_1", "a")).toBe(true);
	});

	test("unset alwaysAllow: the page's own switches are kept in storage all the same", async () => {
		relay.grants = [grant("g_1")];
		const storage = new MemoryStorage();
		const t = tab({ storage });
		await t.registerTool(asking("a"));
		await t.connect();
		expect(allowedTools(t).kept).toBe(true);
		expect(allowedFor(t).offered).toBe(false);
		allowedTools(t).allow("g_1", "a");
		expect(kept(storage)).toMatchObject({
			grants: [{ grantId: "g_1", tools: [{ name: "a" }] }],
		});
	});

	test("an allowed call runs without the page's own onConfirm; others, and other callers, are asked", async () => {
		relay.grants = [grant("g_1"), grant("g_2")];
		const asked: string[] = [];
		const onConfirm = (r: ConfirmRequest) => {
			asked.push(r.client.kind === "relay" ? r.client.grantId : r.client.kind);
			return false;
		};
		const t = tab({ storage: new MemoryStorage(), onConfirm });
		await t.registerTool(asking("a"));
		await t.connect();
		allowedTools(t).allow("g_1", "a");
		const tool = { name: "a", description: "Does a" };
		expect(await confirmCall(t, request("g_1", tool), onConfirm)).toBe(true);
		expect(await confirmCall(t, request("g_2", tool), onConfirm)).toBe(false);
		allowedTools(t).setEverything("g_2", true);
		expect(await confirmCall(t, request("g_2", tool), onConfirm)).toBe(true);
		// An agent in the browser and a served port have no grant: always asked.
		for (const client of [
			{ kind: "webmcp" as const },
			{ kind: "local" as const, id: "chat" },
		])
			expect(
				await confirmCall(t, { ...request("g_1", tool), client }, onConfirm),
			).toBe(false);
		expect(asked).toEqual(["g_2", "webmcp", "local"]);
		// "unanswered" stays what it is.
		expect(await confirmCall(t, request("g_9", tool), () => "unanswered")).toBe(
			"unanswered",
		);
	});

	test("through the relay: an allowed AI app's call runs and onConfirm is not asked", async () => {
		relay.grants = [grant("g_1")];
		let asked = 0;
		const t = tab({
			storage: new MemoryStorage(),
			onConfirm: () => {
				asked++;
				return false;
			},
		});
		await t.registerTool(asking("a"));
		await t.connect();
		const call = async (id: string) => {
			relay.send({
				type: "http.request",
				id,
				method: "POST",
				path: "/mcp",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"mcp-protocol-version": "2026-07-28",
					"mcp-method": "tools/call",
					"mcp-name": "a",
				},
				body: JSON.stringify(
					rpc(1, "tools/call", { name: "a", arguments: {} }),
				),
				grant: {
					grantId: "g_1",
					clientId: grant("g_1").client.id,
					scopes: ["tools"],
				},
			});
			await relay.next("http.response.start", (m) => m["id"] === id);
			const chunk = await relay.next(
				"http.response.chunk",
				(m) => m["id"] === id,
			);
			return String(chunk["data"]);
		};
		expect(await call("r1")).toContain("The user declined");
		expect(asked).toBe(1);
		allowedTools(t).allow("g_1", "a");
		expect(await call("r2")).toContain('"text":"ok"');
		expect(asked).toBe(1);
	});
});

describe("the allowances, end to end with the relay", () => {
	let r: TestRelay;
	beforeAll(() => {
		r = startRelay({ keepAliveMs: 50, pageWaitMs: 0 });
	});
	afterAll(() => r.stop());

	test("allow, reload: the AI app calls without being asked; disconnected in the page, it is asked again", async () => {
		const storage = new MemoryStorage();
		let asked = 0;
		const page = () => {
			const t = newTab(r.url, {
				storage,
				alwaysAllow: true,
				onConfirm: () => {
					asked++;
					return false;
				},
			});
			void t.registerTool(asking("clear_memory", "Clears the memory"));
			return t;
		};
		const call = async (address: string, token: string) => {
			const res = await mcpPost(
				address,
				rpc(1, "tools/call", { name: "clear_memory", arguments: {} }),
				{ token },
			);
			return res.text();
		};
		const first = page();
		const { address } = await first.connect();
		const token = await tokenFor(r, address);
		// The relay names the new grant in the next session.
		first.disconnect();
		await first.connect();
		const [only] = first.grants;
		if (only === undefined) throw new Error("no grant");
		expect(await call(address, token)).toContain("The user declined");
		expect(asked).toBe(1);
		allowedTools(first).allow(only.grantId, "clear_memory");
		expect(await call(address, token)).toContain('"text":"ok"');
		expect(asked).toBe(1);
		first.disconnect();

		// Reload: a new page on the same storage.
		const second = page();
		await second.connect();
		expect(await call(address, token)).toContain('"text":"ok"');
		expect(asked).toBe(1);
		// Disconnected in the page: gone, also from storage.
		await second.revoke(only.grantId);
		expect(allowedTools(second).list(only.grantId)).toEqual([]);
		expect(kept(storage)).toMatchObject({ grants: [] });
		// Paired again: a new grant, asked again.
		const again = await tokenFor(r, address);
		second.disconnect();
		await second.connect();
		expect(await call(address, again)).toContain("The user declined");
		expect(asked).toBe(2);
		second.disconnect();
	});
});
