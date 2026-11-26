/**
 * The worker's `Connection` itself, with a fake Chrome and settings in
 * memory: the panel's commands as the worker runs them, the relay's
 * pairing page with AI access off and on, and the notifications' answers.
 * What the end-to-end tests asked of it through a real browser, where only
 * this code decided (iteration 50).
 */

import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	type ModelContextTool,
	TabMcp,
	type ToolExecuteCallbackOptions,
} from "@ractive-ch/tab-mcp-client";
import type { PagePort } from "@ractive-ch/tab-mcp-client/extension";
import type { ExtensionState, PageTool, PageTools } from "../src/messages.ts";
import type { PanelState } from "../src/protocol.ts";
import { APP_ID } from "../src/protocol.ts";
import type { AllowedTools } from "../src/worker/allowed.ts";
import { Connection } from "../src/worker/connection.ts";
import { FillSetting } from "../src/worker/fill.ts";
import { memoryKv } from "../src/worker/kv.ts";
import { ARGS_CUT_NOTE } from "../src/worker/questions.ts";
import { CachedSecretStorage } from "../src/worker/secret.ts";
import { SignIn } from "../src/worker/signin.ts";
import { PINNED_ELSEWHERE } from "../src/worker/targets.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const SITE = "https://shop.example";
const OTHER = "https://other.example";
const RELAY = "https://relay.example";

/** What the fake Chrome answers, and what it was asked. */
interface Fake {
	tools: PageTool[];
	/** Whether the window (id 1) has the focus; it has by default. */
	focused: boolean;
	/** Every call of a function the fake does not answer itself. */
	calls: string[];
	/** The ids of the notifications made, in order. */
	notifications: string[];
	/** The options each was made with, as the worker passed them. */
	notificationOptions: Record<string, unknown>[];
	/** The page tools the content script was asked to run, by name. */
	pageCalls: string[];
	/** `chrome.storage.session`: the pinned tab (DEC-230). */
	session: Map<string, unknown>;
	/** How often the page's tools were read (`webmcp-list`). */
	lists?: number;
	/** More tabs than the one of `SITE` (`tabs.query` lists them after it). */
	moreTabs?: { id: number; url?: string; active: boolean; windowId: number }[];
	/** The `extension-state` messages sent, by tab id. */
	states?: [number, unknown][];
	/** Each page call's vouch and the state that came with it. */
	vouches?: { vouch: unknown; state: unknown }[];
	/** The page has no WebMCP (it has by default). */
	noWebmcp?: boolean;
	/** The content script id the tab shows when probed ("doc-1", the page read, by default). */
	shownDocument?: string;
	/** `identity.launchWebAuthFlow`: the address the flow ends at (DEC-233). */
	authFlow?: (url: string) => Promise<string | undefined>;
	/** The URLs `launchWebAuthFlow` was opened at. */
	authUrls?: string[];
}

/**
 * A Chrome with one normal window and one tab of `SITE`, whose content
 * script lists `fake.tools` and answers a call with "done". The side panel
 * never opens (as without a user's gesture). Any other function: recorded,
 * resolves to nothing.
 */
function fakeChrome(fake: Fake) {
	const tab = {
		id: 1,
		url: `${SITE}/`,
		title: "Shop",
		active: true,
		windowId: 1,
	};
	const record =
		(name: string, value: unknown = undefined) =>
		async (...args: unknown[]) => {
			fake.calls.push(`${name} ${JSON.stringify(args)}`);
			return value;
		};
	const loose = <T extends object>(namespace: string, given: T): T =>
		new Proxy(given, {
			get: (target, key) =>
				key in target
					? target[key as keyof T]
					: record(`${namespace}.${String(key)}`),
		});
	const api = {
		runtime: {
			id: ID,
			getURL: (path: string) => `chrome-extension://${ID}/${path}`,
			getManifest: () => ({ version: "1.0.0" }),
			getPlatformInfo: async () => ({ os: "mac" }),
		},
		identity: {
			getRedirectURL: () => `https://${ID}.chromiumapp.org/`,
			launchWebAuthFlow: async ({ url }: { url: string }) => {
				fake.authUrls ??= [];
				fake.authUrls.push(url);
				if (fake.authFlow === undefined) throw new Error("no flow");
				return fake.authFlow(url);
			},
		},
		windows: {
			WINDOW_ID_NONE: -1,
			getLastFocused: async () => ({ id: 1, focused: fake.focused }),
			get: async (id: number) => ({
				id,
				focused: fake.focused,
				type: "normal",
			}),
		},
		tabs: {
			query: async () => [tab, ...(fake.moreTabs ?? [])],
			get: async () => ({ ...tab, status: "complete" }),
			sendMessage: async (
				tabId: number,
				request: {
					type: string;
					name?: string;
					state?: unknown;
					vouch?: unknown;
				},
				options?: unknown,
			) => {
				if (request.type === "extension-state")
					fake.states?.push([tabId, request.state]);
				if (request.type === "webmcp-install")
					fake.calls.push(
						`tabs.sendMessage ${JSON.stringify([tabId, request, options])}`,
					);
				if (request.type === "webmcp-call") {
					fake.pageCalls.push(request.name ?? "");
					fake.vouches?.push({ vouch: request.vouch, state: request.state });
					return { ok: true, value: "done" };
				}
				if (request.type === "webmcp-list") fake.lists = (fake.lists ?? 0) + 1;
				if (request.type === "webmcp-list")
					return {
						ok: true,
						url: tab.url,
						origin: SITE,
						documentId: "doc-1",
						more: 0,
						available: fake.noWebmcp !== true,
						tools: fake.tools,
					} satisfies { ok: true } & PageTools;
				if (request.type === "page-info")
					return {
						ok: true,
						url: tab.url,
						title: tab.title,
						webmcp: {
							available: fake.noWebmcp !== true,
							tools: fake.tools.length,
						},
					};
				return { ok: true, value: null };
			},
		},
		permissions: { contains: async () => true },
		storage: {
			session: {
				get: async (key: string) =>
					fake.session.has(key) ? { [key]: fake.session.get(key) } : {},
				set: async (items: Record<string, unknown>) => {
					for (const [key, value] of Object.entries(items))
						fake.session.set(key, value);
				},
				remove: async (key: string) => void fake.session.delete(key),
			},
		},
		// A function's injection (the probe for Chrome's id of the page that
		// was read) finds the content script of "doc-1" in "chrome-doc-1".
		scripting: {
			executeScript: async (details: { func?: unknown }) => {
				fake.calls.push(`scripting.executeScript ${JSON.stringify([details])}`);
				return details.func === undefined
					? []
					: [
							{
								frameId: 0,
								documentId: "chrome-doc-1",
								result: fake.shownDocument ?? "doc-1",
							},
						];
			},
		},
		sidePanel: {
			open: async () => {
				throw new Error(
					"sidePanel.open() may only be called in response to a user gesture.",
				);
			},
		},
		notifications: {
			create: async (id: string, options: Record<string, unknown>) => {
				fake.notifications.push(id);
				fake.notificationOptions.push(options);
				return id;
			},
			clear: async () => true,
			getAll: async () => ({}),
		},
	};
	const namespaces = new Map<string, object>(
		Object.entries(api).map(([name, given]) => [name, loose(name, given)]),
	);
	// Any other namespace (action, alarms, scripting): loose, empty.
	return new Proxy(
		{},
		{
			get: (_target, key) => {
				const name = String(key);
				if (!namespaces.has(name)) namespaces.set(name, loose(name, {}));
				return namespaces.get(name);
			},
		},
	);
}

const pageTool = (name: string, readOnly: boolean): PageTool =>
	({
		name,
		description: name,
		inputSchema: { type: "object" },
		annotations: readOnly ? { readOnlyHint: true } : {},
	}) as unknown as PageTool;

/** A side panel's port: what the worker sends it, and its last state. */
function fakePanel() {
	const posted: unknown[] = [];
	return {
		posted,
		state: () =>
			(
				posted.filter((m) => (m as { type?: string }).type === "state") as {
					state: PanelState;
				}[]
			).at(-1)?.state,
		port: {
			postMessage: (m: unknown) => void posted.push(m),
			onDisconnect: { addListener: () => {} },
		} as unknown as chrome.runtime.Port,
	};
}

/** The relay's pairing page in tab 1, as the content script's port gives it. */
function pairingPage(): PagePort & { closed: boolean; sent: unknown[] } {
	const gone = new AbortController();
	const port = {
		sender: {
			id: ID,
			url: `${RELAY}/authorize?response_type=code&client_id=x`,
			origin: RELAY,
			tab: { id: 1 },
			frameId: 0,
		},
		hello: Promise.resolve({
			type: "pairing-page",
			nonce: "0123456789abcdef0123",
			app: APP_ID,
			clientName: "Claude",
			clientHost: "claude.ai",
			requestId: "Zm9vYmFyYmF6cXV4cXV1eHh5enp6",
		}),
		signal: gone.signal,
		sent: [] as unknown[],
		closed: false,
		send: (message: unknown) => void port.sent.push(message),
		close: () => {
			port.closed = true;
			gone.abort();
		},
	};
	return port;
}

/** Until `check` holds, at most 5 s (it returns as soon as it does). */
async function until(
	check: () => boolean | Promise<boolean>,
	what: string,
): Promise<void> {
	const end = Date.now() + 5_000;
	while (!(await check())) {
		if (Date.now() > end) throw new Error(`never: ${what}`);
		await Bun.sleep(5);
	}
}

/**
 * A WebSocket that never reaches a relay (no network from unit tests): the
 * library's connect makes one, its disconnect closes it. With `relay` set
 * it opens and is the relay itself: it answers `hello` with a session (its
 * `signIn`, if given), records what the tab sends, and delivers what a test
 * gives it (DEC-233).
 */
class FakeSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static made: string[] = [];
	/** Answer as a relay; `signIn` goes into the session. */
	static relay: { signIn?: unknown } | undefined;
	static last: FakeSocket | undefined;
	readyState = FakeSocket.CONNECTING;
	protocol = "";
	readonly sent: Record<string, unknown>[] = [];
	constructor(readonly url: string) {
		super();
		FakeSocket.made.push(url);
		FakeSocket.last = this;
		if (FakeSocket.relay !== undefined)
			queueMicrotask(() => {
				this.readyState = FakeSocket.OPEN;
				this.protocol = "tab-mcp.v1";
				this.dispatchEvent(new Event("open"));
			});
	}
	send(data: string): void {
		const relay = FakeSocket.relay;
		if (relay === undefined) return;
		const message = JSON.parse(data) as Record<string, unknown>;
		this.sent.push(message);
		if (message["type"] === "hello")
			this.deliver({
				type: "session",
				sessionId: "s_1",
				address: `${RELAY}/s/tab-mcp-extension/mcp`,
				origin: `chrome-extension://${ID}`,
				pairing: "code",
				expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
				limits: {
					maxMessageBytes: 1_048_576,
					maxBodyBytes: 1_048_576,
					requestTimeoutMs: 300_000,
					idleTimeoutMs: 3_600_000,
					heartbeatMs: 60_000,
					keepAliveMs: 20_000,
					maxConcurrentRequests: 8,
				},
				grants: [],
				...(relay.signIn === undefined ? {} : { signIn: relay.signIn }),
			});
	}
	/** A message of the relay's. */
	deliver(message: Record<string, unknown>): void {
		queueMicrotask(() =>
			this.dispatchEvent(
				new MessageEvent("message", { data: JSON.stringify(message) }),
			),
		);
	}
	/** What the tab sent of `type`. */
	of(type: string): Record<string, unknown>[] {
		return this.sent.filter((m) => m["type"] === type);
	}
	close(code = 1000, reason = ""): void {
		if (this.readyState === FakeSocket.CLOSED) return;
		this.readyState = FakeSocket.CLOSED;
		this.dispatchEvent(
			Object.assign(new Event("close"), { code, reason, wasClean: true }),
		);
	}
}

/** Every tool a connection's library was given, the newest last. */
const registered = spyOn(TabMcp.prototype, "registerTool");
/** Every connect of a connection's library (to the fake socket). */
const connected = spyOn(TabMcp.prototype, "connect");

/**
 * Call the page tool `name` as an AI app through the relay would, through
 * the tool the worker registered with its library.
 */
function callTool(name: string, args: Record<string, unknown> = {}) {
	const tool = registered.mock.calls
		.map(([t]) => t as ModelContextTool)
		.findLast((t) => t.name === name);
	if (tool === undefined) throw new Error(`no tool ${name} registered`);
	return Promise.resolve(
		tool.execute(args, {
			signal: new AbortController().signal,
			client: {
				kind: "relay",
				grantId: "g1",
				name: "Claude",
				host: "claude.ai",
			},
		} as ToolExecuteCallbackOptions),
	);
}

// Each test's own Chrome; the one before (none, in Bun) is back after the
// file, as are the WebSocket and the library's registerTool. Every test
// ends with nothing of its connection still waiting.
const g = globalThis as { chrome?: unknown; WebSocket: unknown };
const before = { chrome: g.chrome, WebSocket: g.WebSocket };
g.WebSocket = FakeSocket;
afterAll(() => {
	g.chrome = before.chrome;
	g.WebSocket = before.WebSocket;
	registered.mockRestore();
	connected.mockRestore();
});

/** A connection as `Connection.start()` makes one, from these settings. */
async function connection(
	options: {
		tools?: PageTool[];
		allowed?: AllowedTools;
		aiOn?: boolean;
		fill?: boolean;
		/** The AI apps' hosts filled in for without a question (DEC-213). */
		alwaysHosts?: string[];
		/** More entries of the worker's IndexedDB (the sign-in's, DEC-233). */
		stored?: Record<string, unknown>;
	} = {},
) {
	const fake: Fake = {
		tools: options.tools ?? [],
		focused: true,
		calls: [],
		notifications: [],
		notificationOptions: [],
		pageCalls: [],
		session: new Map(),
	};
	g.chrome = fakeChrome(fake);
	// Stored, as start() loads them.
	const kv = memoryKv({
		...options.stored,
		relay: RELAY,
		...(options.allowed ? { allowedTools: options.allowed } : {}),
		...(options.fill ? { fillCodeFor: RELAY } : {}),
		...(options.alwaysHosts
			? {
					fillCodeAlways: {
						relay: RELAY,
						hosts: options.alwaysHosts,
						unasked: {},
					},
				}
			: {}),
	});
	// The constructor `start()` uses, without IndexedDB.
	const make = Connection as unknown as new (...args: unknown[]) => Connection;
	const c = new make(
		await CachedSecretStorage.load(kv),
		[],
		options.allowed ?? {},
		RELAY,
		undefined,
		kv,
		options.aiOn ?? false,
		[],
		await FillSetting.load(kv, async () => true),
		await SignIn.stored(kv),
	);
	return { c, kv, fake };
}

const allowedOn = async (
	kv: ReturnType<typeof memoryKv>,
	origin: string,
): Promise<string[]> =>
	((await kv.get("allowedTools")) as AllowedTools | undefined)?.[origin] ?? [];

describe("Always allow all from the panel (set-allowed-all)", () => {
	test("Allow all takes only tools the worker offers on that origin now, that ask first, and that the panel listed", async () => {
		const { c, kv } = await connection({
			tools: [
				pageTool("place_order", false),
				pageTool("pay", false),
				pageTool("get_greeting", true),
			],
		});
		const panel = fakePanel();
		const receive = c.addPanel(panel.port);
		receive({ type: "hello", windowId: 1 });
		// The bridge has read the tab (for the panel).
		await until(
			() => panel.state()?.tab?.tools.length === 3,
			"the tab's tools in the panel",
		);
		receive({
			type: "set-allowed-all",
			origin: SITE,
			names: ["place_order", "not_offered", "get_greeting"],
			on: true,
		});
		receive({
			type: "set-allowed-all",
			origin: OTHER,
			names: ["place_order"],
			on: true,
		});
		await until(() => kv.data.has("allowedTools"), "a write");
		await Bun.sleep(20);
		// Not a name it does not offer, not a read-only one, not another site,
		// and not pay: it asks first too, but the panel did not list it.
		expect(await allowedOn(kv, SITE)).toEqual(["place_order"]);
		expect(await allowedOn(kv, OTHER)).toEqual([]);
		const paid = callTool("page_pay");
		await until(() => panel.state()?.questions.length === 1, "pay asks");
		receive({
			type: "answer",
			id: panel.state()?.questions[0]?.id ?? "",
			answer: "deny",
		});
		await expect(paid).rejects.toThrow("did not allow");
		// The panel's state shows it allowed (its switch on).
		await until(
			() =>
				panel.state()?.tab?.tools.find((t) => t.name === "place_order")
					?.allowed === true,
			"allowed in the panel's state",
		);
		receive({
			type: "set-allowed-all",
			origin: SITE,
			names: ["place_order"],
			on: false,
		});
		await until(
			() => JSON.stringify(kv.data.get("allowedTools")) === "{}",
			"off",
		);
	});

	test("Ask for all also takes away a tool the page dropped since, as the panel named it", async () => {
		// Allowed while the page offered it; the page dropped it since.
		const { c, kv } = await connection({
			tools: [pageTool("place_order", false)],
			allowed: { [SITE]: ["dropped_order", "place_order"] },
		});
		const panel = fakePanel();
		const receive = c.addPanel(panel.port);
		await until(
			() => panel.state()?.tab?.tools.length === 1,
			"the tab's tools in the panel",
		);
		// The panel's "Ask for all" still names it.
		receive({
			type: "set-allowed-all",
			origin: SITE,
			names: ["dropped_order", "place_order"],
			on: false,
		});
		// The one it still offers goes in any case; the dropped one too.
		await until(
			async () => !(await allowedOn(kv, SITE)).includes("place_order"),
			"place_order taken away",
		);
		expect(await allowedOn(kv, SITE)).toEqual([]);
	});
});

describe("Recent calls in the worker (DEC-226)", () => {
	let lastId = 1000;
	/**
	 * A call as the library makes it for an AI app: `toolcall`, the tool the
	 * worker registered (wrapped), `toolcallend` with how it went.
	 */
	async function libraryCall(
		mcp: TabMcp,
		name: string,
		args: Record<string, unknown>,
	): Promise<void> {
		const id = ++lastId;
		const client = {
			kind: "relay",
			grantId: "g1",
			id: "https://claude.ai/client",
			name: "Claude",
			host: "claude.ai",
		};
		mcp.dispatchEvent(
			new CustomEvent("toolcall", {
				detail: { id, tool: name, arguments: args, client },
			}),
		);
		let outcome = "ok";
		let text = "done";
		try {
			await callTool(name, args);
		} catch (error) {
			outcome = "error";
			text = (error as Error).message;
		}
		mcp.dispatchEvent(
			new CustomEvent("toolcallend", {
				detail: {
					id,
					tool: name,
					client,
					outcome,
					result: {
						content: [{ type: "text", text }],
						...(outcome === "ok" ? {} : { isError: true }),
					},
					durationMs: 1,
				},
			}),
		);
	}

	const messages = (posted: unknown[], type: string) =>
		posted.filter((m) => (m as { type?: string }).type === type) as {
			calls?: { tool: string; state: string; site?: string }[];
			call?: { tool: string; state: string; site?: string };
		}[];

	test("the state carries the count; a panel that opens the section gets the list, then each change; nothing of it is stored", async () => {
		const { c, kv, fake } = await connection({
			tools: [pageTool("get_greeting", true), pageTool("place_order", false)],
		});
		const mcp = registered.mock.contexts.at(-1) as TabMcp;
		const panel = fakePanel();
		const receive = c.addPanel(panel.port);
		receive({ type: "hello", windowId: 1 });
		await until(
			() => panel.state()?.tab?.tools.length === 2,
			"the tab's tools in the panel",
		);
		const storedBefore = JSON.stringify([...kv.data]);
		expect(panel.state()?.recentCalls).toBe(0);

		// A read-only call with the section closed: only the count.
		await libraryCall(mcp, "page_get_greeting", { name: "Ada" });
		await until(() => panel.state()?.recentCalls === 1, "the count");
		expect(messages(panel.posted, "calls")).toEqual([]);
		expect(messages(panel.posted, "call")).toEqual([]);

		// Opened: the list, with the site the page tool ran on.
		receive({ type: "calls", open: true });
		await until(() => messages(panel.posted, "calls").length === 1, "the list");
		expect(messages(panel.posted, "calls")[0]?.calls).toMatchObject([
			{ tool: "page_get_greeting", state: "ok", site: SITE },
		]);

		// A call the user declines: running, waiting, declined, as it goes.
		const declined = libraryCall(mcp, "page_place_order", { item: "tea" });
		await until(() => panel.state()?.questions.length === 1, "a question");
		receive({
			type: "answer",
			id: panel.state()?.questions[0]?.id ?? "",
			answer: "deny",
		});
		await declined;
		expect(
			messages(panel.posted, "call").map((m) => [m.call?.tool, m.call?.state]),
		).toEqual([
			["page_place_order", "running"],
			["page_place_order", "running"], // its site
			["page_place_order", "waiting"],
			["page_place_order", "running"], // the answer
			["page_place_order", "declined"],
		]);
		await until(() => panel.state()?.recentCalls === 2, "the count");

		// Closed: no more changes to it.
		receive({ type: "calls", open: false });
		await until(
			() => (panel.posted.at(-1) as { type?: string }).type !== "calls",
			"the close handled",
		);
		const before = messages(panel.posted, "call").length;
		await libraryCall(mcp, "page_get_greeting", { name: "Bo" });
		await until(() => panel.state()?.recentCalls === 3, "the count");
		expect(messages(panel.posted, "call")).toHaveLength(before);

		// Memory only: the settings as they were, no storage API asked.
		expect(JSON.stringify([...kv.data])).toBe(storedBefore);
		expect(fake.calls.filter((name) => /storage/i.test(name))).toEqual([]);
	});
});

describe("the panel's commands", () => {
	test("run one after another: a connect then a stop ends off, two allowed writes both hold", async () => {
		const { c, kv } = await connection();
		const panel = fakePanel();
		const receive = c.addPanel(panel.port);
		const connects = connected.mock.calls.length;
		receive({ type: "connect" });
		receive({ type: "stop" });
		for (const name of ["a", "b"])
			receive({ type: "set-allowed", origin: SITE, name, on: true });
		await until(
			() => (kv.data.get("allowedTools") as AllowedTools)?.[SITE]?.length === 2,
			"both writes",
		);
		await Bun.sleep(20);
		expect(kv.data.get("aiOn")).toBe(false);
		expect(panel.state()?.status).toBe("off");
		expect(await allowedOn(kv, SITE)).toEqual(["a", "b"]);
		// The connect did set out for the relay (any socket a fake: no network).
		expect(connected.mock.calls.length - connects).toBe(1);
	});
});

describe("where AI apps work, in the worker (DEC-230)", () => {
	test("the panel's state says it; Work here pins the tab the panel shows, only that one; the setting back to the tab in front drops the pin", async () => {
		const { c, kv, fake } = await connection({
			tools: [pageTool("look", true)],
		});
		const panel = fakePanel();
		const receive = c.addPanel(panel.port);
		await until(() => panel.state()?.tab?.tabId === 1, "the tab shown");
		expect(panel.state()?.target).toEqual({ mode: "front" });
		// A tab the panel no longer shows: nothing is pinned.
		receive({ type: "work-here", tabId: 7 });
		await Bun.sleep(20);
		expect(kv.data.get("aiTarget")).toBeUndefined();
		receive({ type: "work-here", tabId: 1 });
		await until(
			() => panel.state()?.target?.pinned !== undefined,
			"the pin shown",
		);
		expect(kv.data.get("aiTarget")).toEqual({ mode: "pinned" });
		expect(fake.session.get("pinnedTab")).toBe(1);
		expect(panel.state()?.target).toEqual({
			mode: "pinned",
			pinned: { tabId: 1, title: "Shop" },
		});
		receive({ type: "set-target-mode", mode: "front" });
		await until(
			() => panel.state()?.target?.mode === "front",
			"the tab in front shown",
		);
		expect(kv.data.get("aiTarget")).toEqual({ mode: "front" });
		receive({ type: "set-target-mode", mode: "pinned" });
		await until(() => panel.state()?.target?.mode === "pinned", "pinned");
		expect(panel.state()?.target).toEqual({ mode: "pinned" });
	});

	test("with a tab pinned, a tab switch or a window's focus does not read the pinned tab's tools again; its own load does (DEC-177)", async () => {
		const { c, fake } = await connection({ tools: [pageTool("look", true)] });
		const panel = fakePanel();
		c.addPanel(panel.port);
		await until(() => panel.state()?.tab?.tabId === 1, "the tab shown");
		// The tab in front: a switch reads the tools of the new one.
		await Bun.sleep(20);
		let before = fake.lists ?? 0;
		c.frontChanged();
		await until(() => (fake.lists ?? 0) > before, "read after a switch");
		await callTool("use_tab", { tab: "1" });
		await Bun.sleep(20);
		before = fake.lists ?? 0;
		c.frontChanged();
		c.pageChanged(5, true);
		await Bun.sleep(30);
		expect(fake.lists ?? 0).toBe(before);
		// The pinned tab's own load or toolchange reads it again.
		c.pageChanged(1, false);
		await until(() => (fake.lists ?? 0) > before, "read after its load");
	});

	test("a question for a tab that is not in front says which one, pinned or not", async () => {
		const { c, fake } = await connection({
			tools: [pageTool("place_order", false)],
		});
		fake.moreTabs = [{ id: 2, url: `${SITE}/`, active: false, windowId: 1 }];
		const panel = fakePanel();
		const receive = c.addPanel(panel.port);
		const running = callTool("webmcp_call", {
			name: "place_order",
			tab: "2",
		});
		await until(() => panel.state()?.questions.length === 1, "the question");
		const [question] = panel.state()?.questions ?? [];
		expect(question?.inTab).toEqual({ title: "Shop", pinned: false });
		receive({ type: "answer", id: question?.id ?? "", answer: "deny" });
		await expect(running).rejects.toThrow("did not allow");
		// The tab in front: no such line.
		const front = callTool("webmcp_call", { name: "place_order" });
		await until(() => panel.state()?.questions.length === 1, "the question");
		const [again] = panel.state()?.questions ?? [];
		expect(again?.inTab).toBeUndefined();
		receive({ type: "answer", id: again?.id ?? "", answer: "deny" });
		await expect(front).rejects.toThrow("did not allow");
		expect(fake.pageCalls).toEqual([]);
	});

	test("list_tabs: the tab it may read, the others counted; use_tab pins it", async () => {
		const { fake, kv } = await connection({ tools: [pageTool("look", true)] });
		// A tab whose address Chrome hides (no access), and the panel's own page.
		fake.moreTabs = [
			{ id: 2, active: false, windowId: 1 },
			{
				id: 3,
				url: `chrome-extension://${ID}/sidepanel/index.html`,
				active: true,
				windowId: 1,
			},
		];
		expect(await callTool("list_tabs")).toMatchObject({
			mode: "the tab in front",
			tabs: [{ tab: "1", title: "Shop", url: `${SITE}/`, inFront: true }],
			notReadable: 1,
		});
		expect(await callTool("use_tab", { tab: "1" })).toMatchObject({
			tab: "1",
			pinned: true,
			title: "Shop",
		});
		expect(kv.data.get("aiTarget")).toEqual({ mode: "pinned" });
		expect(fake.session.get("pinnedTab")).toBe(1);
	});
});

test("the extension's own library mirrors nothing into WebMCP, even with a document that has it (webmcp: false, DEC-222)", async () => {
	const w = globalThis as { Document?: unknown; document?: unknown };
	const saved = { Document: w.Document, document: w.document };
	const native: string[] = [];
	class FakeDocument extends EventTarget {}
	Object.defineProperty(FakeDocument.prototype, "modelContext", {
		configurable: true,
		get: () => ({
			registerTool: (tool: { name: string }) => {
				native.push(tool.name);
			},
		}),
	});
	w.Document = FakeDocument;
	w.document = new FakeDocument();
	try {
		await connection({ aiOn: true });
		await Bun.sleep(20); // the mirror's chunk would have loaded by now
		expect(registered.mock.calls.length).toBeGreaterThan(0);
		expect(native).toEqual([]);
	} finally {
		Object.assign(w, saved);
	}
});

describe("signed in at the relay, and the group (DEC-233)", () => {
	const SELF = "m_self000000000000";
	const OTHER_MEMBER = "m_other00000000000";
	const PROVIDERS = [
		{ id: "google", name: "Google" },
		{ id: "microsoft", name: "Microsoft" },
	];
	const ACCOUNT = {
		provider: "google",
		providerName: "Google",
		displayName: "ada@example.com",
	};
	afterEach(() => {
		FakeSocket.relay = undefined;
	});

	/** The group message as the relay sends it. */
	const group = (more: Record<string, unknown> = {}) => ({
		type: "group",
		provider: "microsoft",
		self: SELF,
		expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
		maxMembers: 16,
		members: [{ id: SELF, label: "Chrome on macOS", online: true }],
		mode: "front",
		grants: [],
		...more,
	});

	/** A connection, connected to the fake relay with `signIn` in its session. */
	async function signedIn(
		signIn: unknown,
		options: Parameters<typeof connection>[0] = {},
	) {
		FakeSocket.relay = { signIn };
		const made = await connection(options);
		const panel = fakePanel();
		const receive = made.c.addPanel(panel.port);
		receive({ type: "connect" });
		await until(
			() =>
				panel.state()?.status === "waiting" || panel.state()?.status === "on",
			"connected",
		);
		const socket = FakeSocket.last;
		if (socket === undefined) throw new Error("no socket");
		const stop = async () => {
			receive({ type: "stop" });
			await until(() => panel.state()?.status === "off", "off");
		};
		return { ...made, panel, receive, socket, stop };
	}

	test("hello names signin.v1; a relay that offers no sign-in shows nothing new, and the setting stays the browser's own", async () => {
		const { c, panel, receive, socket, kv, stop } = await signedIn(undefined, {
			tools: [pageTool("look", true)],
		});
		expect(socket.of("hello")[0]?.["capabilities"]).toEqual(["signin.v1"]);
		expect(panel.state()?.signIn).toBeUndefined();
		receive({ type: "set-target-mode", mode: "pinned" });
		await until(() => panel.state()?.target?.mode === "pinned", "pinned");
		expect(kv.data.get("aiTarget")).toEqual({ mode: "pinned" });
		expect(socket.of("group.mode")).toEqual([]);
		c.windowFocused(1);
		await Bun.sleep(10);
		expect(socket.of("focus")).toEqual([]);
		await stop();
	});

	test("Sign in: the relay's URL in launchWebAuthFlow, the code back over the socket; signed in with its kind, kept only in the extension", async () => {
		const { panel, receive, socket, kv, fake, stop } = await signedIn({
			providers: PROVIDERS,
		});
		expect(panel.state()?.signIn).toMatchObject({
			providers: PROVIDERS,
			connected: true,
		});
		fake.authFlow = async () =>
			`https://${ID}.chromiumapp.org/?signin=completion-code`;
		receive({ type: "sign-in", provider: "microsoft" });
		await until(() => socket.of("signin.start").length === 1, "the start");
		expect(socket.of("signin.start")[0]).toEqual({
			type: "signin.start",
			provider: "microsoft",
			redirectUrl: `https://${ID}.chromiumapp.org/`,
			label: "Chrome on macOS",
		});
		expect(panel.state()?.signIn?.pending).toBe("Microsoft");
		// Not the relay's own address: never opened.
		socket.deliver({
			type: "signin.url",
			provider: "microsoft",
			url: "https://evil.example/signin?flow=x",
			expiresAt: "",
		});
		await until(
			() => panel.state()?.signIn?.problem !== undefined,
			"the refusal",
		);
		expect(fake.authUrls ?? []).toEqual([]);
		receive({ type: "sign-in", provider: "microsoft" });
		await until(() => socket.of("signin.start").length === 2, "again");
		socket.deliver({
			type: "signin.url",
			provider: "microsoft",
			url: `${RELAY}/signin?flow=abc`,
			expiresAt: "",
		});
		await until(() => socket.of("signin.complete").length === 1, "complete");
		expect(fake.authUrls).toEqual([`${RELAY}/signin?flow=abc`]);
		expect(socket.of("signin.complete")[0]).toEqual({
			type: "signin.complete",
			code: "completion-code",
		});
		socket.deliver({
			type: "signin.done",
			provider: "microsoft",
			displayName: "ada@example.ch",
			kind: "work",
			member: SELF,
		});
		socket.deliver(group());
		await until(
			() => panel.state()?.signIn?.members !== undefined,
			"the group",
		);
		expect(panel.state()?.signIn).toMatchObject({
			providers: [],
			account: {
				providerName: "Microsoft",
				displayName: "ada@example.ch",
				kind: "work",
			},
			members: [
				{ id: SELF, label: "Chrome on macOS", online: true, self: true },
			],
		});
		expect(panel.state()?.signIn?.pending).toBeUndefined();
		expect(kv.data.get("signInAccount")).toEqual({
			provider: "microsoft",
			providerName: "Microsoft",
			displayName: "ada@example.ch",
			kind: "work",
		});
		// The name goes nowhere but the panel: not to the relay, not to pages.
		expect(JSON.stringify(socket.sent)).not.toContain("ada@example.ch");
		await stop();
	});

	test("a sign-in that comes back without a code: the reason in the panel's words; a Microsoft admin approval as such; a closed window", async () => {
		const { panel, receive, socket, fake, stop } = await signedIn({
			providers: PROVIDERS,
		});
		const back = async (address: string, provider = "microsoft") => {
			fake.authFlow = async () => address;
			const starts = socket.of("signin.start").length;
			receive({ type: "sign-in", provider });
			await until(() => socket.of("signin.start").length > starts, "start");
			socket.deliver({
				type: "signin.url",
				provider,
				url: `${RELAY}/signin?flow=f`,
				expiresAt: "",
			});
			await until(
				() =>
					panel.state()?.signIn?.pending === undefined &&
					panel.state()?.signIn?.problem !== undefined,
				"the problem",
			);
			return panel.state()?.signIn?.problem;
		};
		const redirect = `https://${ID}.chromiumapp.org/`;
		expect(await back(`${redirect}?signin_error=provider_error`)).toBe(
			"Microsoft did not sign you in: cancelled or refused. With a work or school account, your organisation's administrator may have to approve tab-mcp relay first.",
		);
		expect(
			await back(
				`${redirect}?signin_error=provider_error&error_description=AADSTS90094%3A+Admin+consent+is+required`,
			),
		).toBe(
			"Your organisation's administrator has to approve tab-mcp relay first.",
		);
		expect(await back(`${redirect}?signin_error=admin_approval`)).toBe(
			"Your organisation's administrator has to approve tab-mcp relay first.",
		);
		expect(
			await back(`${redirect}?signin_error=provider_error`, "google"),
		).toBe("Google did not sign you in: cancelled or refused.");
		expect(await back(`${redirect}?signin_error=cancelled`)).toBe(
			"The sign-in was cancelled.",
		);
		fake.authFlow = async () => {
			throw new Error("The user did not approve access.");
		};
		receive({ type: "sign-in", provider: "google" });
		await until(() => socket.of("signin.start").length === 6, "start");
		socket.deliver({
			type: "signin.url",
			provider: "google",
			url: `${RELAY}/signin?flow=g`,
			expiresAt: "",
		});
		await until(
			() =>
				panel.state()?.signIn?.problem?.includes("window was closed") === true,
			"closed",
		);
		// The relay's own refusal, in the panel's words.
		receive({ type: "sign-in", provider: "google" });
		await until(() => socket.of("signin.start").length === 7, "start");
		socket.deliver({
			type: "signin.failed",
			provider: "google",
			reason: "group_full",
			message: "the account has 16 browsers",
		});
		await until(
			() =>
				panel.state()?.signIn?.problem?.startsWith("Your account has") === true,
			"group full",
		);
		expect(socket.of("signin.complete")).toEqual([]);
		await stop();
	});

	test("signed in, where calls go is the group's: the setting sends group.mode, the first pinning call and Work here group.pin; a pin in another browser runs nothing here", async () => {
		const { c, panel, receive, socket, kv, fake, stop } = await signedIn(
			{ providers: PROVIDERS, member: SELF },
			{ tools: [pageTool("look", true)] },
		);
		socket.deliver(
			group({
				members: [
					{ id: SELF, label: "Chrome on macOS", online: true },
					{ id: OTHER_MEMBER, label: "work Chrome", online: true },
				],
				focus: OTHER_MEMBER,
			}),
		);
		await until(
			() => panel.state()?.target?.browser?.label === "work Chrome",
			"the focus shown",
		);
		expect(panel.state()?.target).toEqual({
			mode: "front",
			browser: { label: "work Chrome", self: false },
		});
		receive({ type: "set-target-mode", mode: "pinned" });
		await until(() => socket.of("group.mode").length === 1, "group.mode");
		expect(socket.of("group.mode")[0]).toEqual({
			type: "group.mode",
			mode: "pinned",
		});
		// The browser's own setting is left as it was.
		expect(kv.data.get("aiTarget")).toBeUndefined();
		// The first call in mode "pinned" pins the tab in front, for the group.
		await callTool("page_info");
		expect(socket.of("group.pin")).toEqual([{ type: "group.pin", tab: "1" }]);
		expect(fake.session.get("pinnedTab")).toBeUndefined();
		// The relay confirms; then another browser pins one of its tabs.
		socket.deliver(group({ mode: "pinned", pin: { member: SELF, tab: "1" } }));
		socket.deliver(
			group({
				members: [
					{ id: SELF, label: "Chrome on macOS", online: true },
					{ id: OTHER_MEMBER, label: "work Chrome", online: true },
				],
				mode: "pinned",
				pin: { member: OTHER_MEMBER, tab: "77" },
			}),
		);
		await until(() => panel.state()?.target?.elsewhere === true, "elsewhere");
		expect(panel.state()?.target).toEqual({
			mode: "pinned",
			elsewhere: true,
			browser: { label: "work Chrome", self: false },
		});
		await expect(callTool("page_info")).rejects.toThrow(
			"The pinned tab is in another of the user's browsers",
		);
		// A call that names its tab still runs here.
		expect(await callTool("page_info", { tab: "1" })).toMatchObject({
			title: "Shop",
		});
		// Work here takes the pin back.
		await until(() => panel.state()?.tab?.tabId === 1, "the tab shown");
		receive({ type: "work-here", tabId: 1 });
		await until(() => socket.of("group.pin").length === 2, "Work here");
		expect(socket.of("group.pin")[1]).toEqual({ type: "group.pin", tab: "1" });
		await until(
			() => panel.state()?.target?.pinned?.tabId === 1,
			"pinned here",
		);
		expect(panel.state()?.target?.browser).toEqual({
			label: "Chrome on macOS",
			self: true,
		});
		void c;
		await stop();
	});

	test('focus: in mode "the tab in front" only, once after connecting if a window has it, and as one gains it; never in mode "a pinned tab"', async () => {
		const { c, socket, stop } = await signedIn({
			providers: PROVIDERS,
			member: SELF,
		});
		socket.deliver(group());
		await until(() => socket.of("focus").length === 1, "the first focus");
		expect(socket.of("focus")[0]).toEqual({ type: "focus" });
		c.windowFocused(1);
		expect(socket.of("focus").length).toBe(2);
		// The browser lost the focus: nothing to say.
		c.windowFocused(-1);
		expect(socket.of("focus").length).toBe(2);
		socket.deliver(group({ mode: "pinned" }));
		await Bun.sleep(20);
		c.windowFocused(1);
		expect(socket.of("focus").length).toBe(2);
		await stop();
	});

	test("the group's AI apps: listed, connected (the status, the pages), each with Disconnect; a browser that joined is announced, the ones there at the sign-in are not", async () => {
		const { c, panel, receive, socket, fake, stop } = await signedIn({
			providers: PROVIDERS,
			member: SELF,
		});
		const grant = {
			grantId: "g_group",
			client: { id: "https://claude.ai/x", name: "Claude", host: "claude.ai" },
			createdAt: "2026-11-26T10:00:00.000Z",
		};
		socket.deliver(
			group({
				grants: [grant],
				members: [
					{ id: SELF, label: "Chrome on macOS", online: true },
					{ id: OTHER_MEMBER, label: "work Chrome", online: false },
				],
			}),
		);
		await until(
			() => panel.state()?.status === "on",
			"on with the group's AI app",
		);
		expect(panel.state()?.signIn?.grants).toEqual([
			{ grantId: "g_group", name: "Claude", host: "claude.ai" },
		]);
		expect(c.handshakeState().apps).toEqual([
			{ name: "Claude", host: "claude.ai" },
		]);
		// The members of the first group are not news.
		expect(panel.state()?.signIn?.notice).toBeUndefined();
		expect(fake.notifications.some((id) => id.startsWith("joined:"))).toBe(
			false,
		);
		receive({ type: "revoke-group-grant", grantId: "g_group" });
		receive({ type: "revoke-group-grant", grantId: "g_unknown" });
		await until(() => socket.of("group.grant.revoke").length === 1, "revoke");
		await Bun.sleep(10);
		expect(socket.of("group.grant.revoke")).toEqual([
			{ type: "group.grant.revoke", grantId: "g_group" },
		]);
		socket.deliver(
			group({
				members: [
					{ id: SELF, label: "Chrome on macOS", online: true },
					{ id: OTHER_MEMBER, label: "work Chrome", online: false },
					{ id: "m_new0000000000000", label: "Firefox on Linux", online: true },
				],
			}),
		);
		await until(
			() => panel.state()?.signIn?.notice !== undefined,
			"the join notice",
		);
		expect(panel.state()?.signIn?.notice).toBe(
			"“Firefox on Linux” signed in with your account and joined your browsers. If you did not sign it in, remove it below.",
		);
		expect(
			fake.notifications.filter((id) => id.startsWith("joined:")).length,
		).toBe(1);
		const shown = fake.notificationOptions.at(-1);
		expect(shown?.["message"]).toContain(
			"“Firefox on Linux” signed in with your account.",
		);
		receive({ type: "dismiss-sign-in-notice" });
		await until(() => panel.state()?.signIn?.notice === undefined, "dismissed");
		// Rename and remove go to the relay; removing itself is signing out.
		receive({ type: "rename-member", member: OTHER_MEMBER, label: "  work  " });
		receive({ type: "remove-member", member: "m_new0000000000000" });
		receive({ type: "remove-member", member: SELF });
		await until(() => socket.of("signin.out").length === 1, "sign-out");
		expect(socket.of("member.rename")).toEqual([
			{ type: "member.rename", member: OTHER_MEMBER, label: "work" },
		]);
		expect(socket.of("member.remove")).toEqual([
			{ type: "member.remove", member: "m_new0000000000000" },
		]);
		await stop();
	});

	test("Sign out: the relay ends it; what was kept goes, the buttons are back, and the setting is the browser's own again", async () => {
		const { panel, receive, socket, kv, stop } = await signedIn(
			{ providers: PROVIDERS, member: SELF },
			{ stored: { signInAccount: ACCOUNT } },
		);
		socket.deliver(group({ mode: "pinned" }));
		await until(() => panel.state()?.target?.mode === "pinned", "the group's");
		receive({ type: "sign-out" });
		await until(() => socket.of("signin.out").length === 1, "signin.out");
		socket.deliver({ type: "signin.ended", reason: "signed_out" });
		await until(
			() => (panel.state()?.signIn?.providers.length ?? 0) === 2,
			"the buttons",
		);
		expect(kv.data.get("signInAccount")).toBeUndefined();
		expect(kv.data.get("signInKnown")).toBeUndefined();
		expect(panel.state()?.signIn?.members).toBeUndefined();
		await until(() => panel.state()?.target?.mode === "front", "its own");
		// Removed by another browser: said so.
		socket.deliver({ type: "signin.ended", reason: "removed" });
		await until(
			() =>
				panel.state()?.signIn?.notice?.includes("removed this one") === true,
			"removed",
		);
		await stop();
	});

	test("review 4: a session without this browser's member keeps the sign-in, unused and not shown; a relay without sign-in forgets it; a refusal of a group message is the sign-in's line", async () => {
		const first = await signedIn(
			{ providers: PROVIDERS },
			{ stored: { signInAccount: ACCOUNT } },
		);
		await until(
			() => first.panel.state()?.signIn?.providers.length === 2,
			"the buttons",
		);
		expect(first.kv.data.get("signInAccount")).toEqual(ACCOUNT);
		expect(first.panel.state()?.signIn?.account).toBeUndefined();
		expect(first.panel.state()?.signIn?.members).toBeUndefined();
		first.socket.deliver({
			type: "error",
			code: "unknown_id",
			message: "not signed in",
			for: "group.mode",
		});
		await until(
			() => first.panel.state()?.signIn?.problem !== undefined,
			"the sign-in's problem",
		);
		expect(first.panel.state()?.problem).toBeUndefined();
		await first.stop();
		// The same browser at a relay that offers no sign-in.
		const second = await signedIn(undefined, {
			stored: { signInAccount: ACCOUNT },
		});
		await until(() => !second.kv.data.has("signInAccount"), "forgotten");
		expect(second.panel.state()?.signIn).toBeUndefined();
		await second.stop();
	});

	test("review 1: after a worker restart, a call that comes before the session's group waits for it and goes where it says, never to the tab in front", async () => {
		FakeSocket.relay = { signIn: { providers: PROVIDERS, member: SELF } };
		const { c } = await connection({
			tools: [pageTool("look", true)],
			stored: { signInAccount: ACCOUNT },
		});
		const panel = fakePanel();
		const receive = c.addPanel(panel.port);
		// Read before the session: what a new worker knows, the default.
		await until(() => panel.state()?.target !== undefined, "the setting read");
		expect(panel.state()?.target?.mode).toBe("front");
		receive({ type: "connect" });
		await until(
			() => panel.state()?.status === "waiting",
			"connected, no group yet",
		);
		const socket = FakeSocket.last;
		if (socket === undefined) throw new Error("no socket");
		let settled = false;
		const call = callTool("page_info").finally(() => {
			settled = true;
		});
		await Bun.sleep(50);
		expect(settled).toBe(false);
		socket.deliver(
			group({
				members: [
					{ id: SELF, label: "Chrome on macOS", online: true },
					{ id: OTHER_MEMBER, label: "work Chrome", online: true },
				],
				mode: "pinned",
				pin: { member: OTHER_MEMBER, tab: "77" },
			}),
		);
		await expect(call).rejects.toThrow(PINNED_ELSEWHERE);
		receive({ type: "stop" });
		await until(() => panel.state()?.status === "off", "off");
	});

	test("review 3: one signin.url per start; a malformed one or another provider's ends the sign-in with a reason", async () => {
		const { panel, receive, socket, fake, stop } = await signedIn({
			providers: PROVIDERS,
		});
		fake.authFlow = async () => `https://${ID}.chromiumapp.org/?signin=code-1`;
		const start = async (n: number) => {
			receive({ type: "sign-in", provider: "google" });
			await until(() => socket.of("signin.start").length === n, "start");
		};
		const unusable =
			"The relay's answer to the sign-in could not be used. Try again.";
		await start(1);
		socket.deliver({
			type: "signin.url",
			provider: "github",
			url: `${RELAY}/signin?flow=a`,
		});
		await until(() => panel.state()?.signIn?.problem === unusable, "mismatch");
		expect(panel.state()?.signIn?.pending).toBeUndefined();
		await start(2);
		socket.deliver({ type: "signin.url", provider: "google", url: "::nope" });
		await until(() => panel.state()?.signIn?.problem === unusable, "malformed");
		await start(3);
		for (const flow of ["b", "c"])
			socket.deliver({
				type: "signin.url",
				provider: "google",
				url: `${RELAY}/signin?flow=${flow}`,
			});
		await until(() => socket.of("signin.complete").length === 1, "complete");
		await Bun.sleep(20);
		expect(fake.authUrls).toEqual([`${RELAY}/signin?flow=b`]);
		expect(socket.of("signin.complete").length).toBe(1);
		await stop();
	});

	test("review 5: with the pin in another browser, the panel still lists the tools of the tab in front", async () => {
		const { panel, socket, stop } = await signedIn(
			{ providers: PROVIDERS, member: SELF },
			{ tools: [pageTool("look", true), pageTool("buy", false)] },
		);
		socket.deliver(
			group({
				members: [
					{ id: SELF, label: "Chrome on macOS", online: true },
					{ id: OTHER_MEMBER, label: "work Chrome", online: true },
				],
				mode: "pinned",
				pin: { member: OTHER_MEMBER, tab: "77" },
			}),
		);
		await until(() => panel.state()?.target?.elsewhere === true, "elsewhere");
		await Bun.sleep(50);
		await until(
			() => (panel.state()?.tab?.tools.length ?? 0) === 2,
			"the tools listed",
		);
		expect(panel.state()?.tab?.tools.map((t) => t.name)).toEqual([
			"look",
			"buy",
		]);
		expect(panel.state()?.tab?.canAllow).toBe(true);
		await stop();
	});

	test("review 6: no focus when calls go to this browser already", async () => {
		const { c, socket, stop } = await signedIn({
			providers: PROVIDERS,
			member: SELF,
		});
		socket.deliver(group({ focus: SELF }));
		await Bun.sleep(30);
		c.windowFocused(1);
		expect(socket.of("focus")).toEqual([]);
		socket.deliver(group({ focus: OTHER_MEMBER }));
		await Bun.sleep(20);
		c.windowFocused(1);
		expect(socket.of("focus")).toEqual([{ type: "focus" }]);
		await stop();
	});
});

describe("the state for pages with the client library (DEC-207, DEC-221)", () => {
	test("its name, on and the AI apps: no version, nothing of the relay", async () => {
		const { c } = await connection();
		expect(c.handshakeState()).toEqual({
			name: "tab-mcp browser extension",
			on: false,
			apps: [],
			whileInFront: false,
		});
	});

	test("host access changed: told again, also to a tab it may no longer read (only off), never to a page that is not a site", async () => {
		const { c, fake } = await connection();
		fake.states = [];
		fake.moreTabs = [
			// Host access withdrawn: Chrome gives no address.
			{ id: 2, active: false, windowId: 1 },
			{ id: 3, url: "chrome://settings/", active: false, windowId: 1 },
		];
		c.hostAccessChanged();
		await until(() => fake.states?.length === 2, "both tabs told");
		await Bun.sleep(10);
		const off: ExtensionState = {
			name: "tab-mcp browser extension",
			on: false,
			apps: [],
			whileInFront: false,
		};
		expect(fake.states).toEqual([
			[1, off],
			[2, off],
		]);
		// On: the tab it may read hears it, the other one still only off.
		const on = {
			...off,
			on: true,
			apps: [{ name: "Claude", host: "claude.ai" }],
		};
		spyOn(c, "handshakeState").mockReturnValue(on);
		fake.states = [];
		c.hostAccessChanged();
		await until(() => fake.states?.length === 2, "both tabs told again");
		expect(fake.states).toEqual([
			[1, on],
			[2, off],
		]);
	});
});

describe("WebMCP given late to a page without it (DEC-223)", () => {
	const on: ExtensionState = {
		name: "tab-mcp browser extension",
		on: true,
		apps: [],
		whileInFront: true,
	};
	/** The polyfill's injections into a main world. */
	const gives = (fake: Fake) =>
		fake.calls.filter(
			(call) =>
				call.startsWith("scripting.executeScript") &&
				call.includes('"world":"MAIN"'),
		);
	const installs = (fake: Fake) =>
		fake.calls.filter((call) => call.includes('"webmcp-install"'));

	test("while on: the page-world polyfill into the main world of the very document that was read, once per document; the panel waits for it", async () => {
		const { c, fake } = await connection();
		fake.noWebmcp = true;
		spyOn(c, "handshakeState").mockReturnValue(on);
		const panel = fakePanel();
		c.addPanel(panel.port);
		await until(() => installs(fake).length === 1, "the polyfill given");
		// Pinned to Chrome's id of the page that was read (review of PR 234):
		// the polyfill and the message go to that document only, and the
		// message names the content script's page too.
		expect(installs(fake)).toEqual([
			`tabs.sendMessage ${JSON.stringify([
				1,
				{ type: "webmcp-install", documentId: "doc-1" },
				{ documentId: "chrome-doc-1" },
			])}`,
		]);
		expect(
			JSON.parse(
				gives(fake)[0]?.slice("scripting.executeScript ".length) ?? "",
			),
		).toEqual([
			{
				target: { tabId: 1, documentIds: ["chrome-doc-1"] },
				world: "MAIN",
				files: ["webmcp-main.js"],
			},
		]);
		// While it is on its way, the panel does not say there is none.
		await until(
			() => panel.state()?.tab?.webmcp?.pending === true,
			"pending shown",
		);
		// Read after it was given (the content script's change): what the
		// page has now is what it gets, and the same document is not given
		// again.
		c.tabChanged();
		await until(
			() =>
				panel.state()?.tab?.webmcp !== undefined &&
				panel.state()?.tab?.webmcp?.pending === undefined,
			"settled",
		);
		c.tabChanged();
		await Bun.sleep(50);
		expect(gives(fake)).toHaveLength(1);
		expect(panel.state()?.tab?.webmcp).toEqual({ available: false, tools: 0 });
	});

	test("the tab shows another page by the time of the give: nothing goes into it (review of PR 234)", async () => {
		const { c, fake } = await connection();
		fake.noWebmcp = true;
		fake.shownDocument = "doc-2";
		spyOn(c, "handshakeState").mockReturnValue(on);
		const panel = fakePanel();
		c.addPanel(panel.port);
		await until(
			() =>
				fake.calls.some((call) => call.startsWith("scripting.executeScript")),
			"the probe",
		);
		await Bun.sleep(50);
		expect(gives(fake)).toEqual([]);
		expect(installs(fake)).toEqual([]);
	});

	test("while off: nothing given, and the panel says the page has none at once", async () => {
		const { c, fake } = await connection();
		fake.noWebmcp = true;
		const panel = fakePanel();
		c.addPanel(panel.port);
		await until(() => panel.state()?.tab !== undefined, "the tab read");
		c.tabChanged();
		await Bun.sleep(50);
		expect(gives(fake)).toEqual([]);
		expect(panel.state()?.tab?.webmcp).toEqual({ available: false, tools: 0 });
	});

	test("a page with WebMCP: nothing given", async () => {
		const { c, fake } = await connection();
		spyOn(c, "handshakeState").mockReturnValue(on);
		const panel = fakePanel();
		c.addPanel(panel.port);
		await until(() => panel.state()?.tab !== undefined, "the tab read");
		await Bun.sleep(50);
		expect(gives(fake)).toEqual([]);
	});
});

describe("a page tool's question", () => {
	test("Always allow on <host>: kept for the site, shown in the panel; that tool runs unasked after, another still asks (EQ 10)", async () => {
		const { c, kv, fake } = await connection({
			tools: [pageTool("place_order", false), pageTool("pay", false)],
		});
		fake.vouches = [];
		const panel = fakePanel();
		const receive = c.addPanel(panel.port);
		receive({ type: "hello", windowId: 1 });
		await until(
			() => panel.state()?.tab?.tools.length === 2,
			"the tab's tools in the panel",
		);
		const first = callTool("page_place_order");
		await until(() => panel.state()?.questions.length === 1, "a question");
		receive({
			type: "answer",
			id: panel.state()?.questions[0]?.id ?? "",
			answer: "site",
		});
		expect(await first).toBe("done");
		expect(await allowedOn(kv, SITE)).toEqual(["place_order"]);
		// The panel's tab is read again: its switch is on.
		await until(
			() =>
				panel.state()?.tab?.tools.find((t) => t.name === "place_order")
					?.allowed === true,
			"allowed in the panel's state",
		);
		// The same tool again: no question.
		expect(await callTool("page_place_order")).toBe("done");
		expect(panel.state()?.questions).toEqual([]);
		expect(fake.pageCalls).toEqual(["place_order", "place_order"]);
		// Each with its vouch and the state for a page not told on yet
		// (DEC-221).
		expect(fake.vouches).toHaveLength(2);
		for (const v of fake.vouches ?? []) {
			expect(v.vouch).toMatchObject({ app: { host: expect.any(String) } });
			expect(v.state).toEqual(c.handshakeState());
		}
		// Another tool of the site still asks.
		const paid = callTool("page_pay");
		await until(() => panel.state()?.questions.length === 1, "pay asks");
		receive({
			type: "answer",
			id: panel.state()?.questions[0]?.id ?? "",
			answer: "deny",
		});
		await expect(paid).rejects.toThrow("did not allow");
		expect(fake.pageCalls).toEqual(["place_order", "place_order"]);
	});

	test("in the panel of the tab's focused window, no notification; with the window not focused, a notification too", async () => {
		const { c, fake } = await connection({
			tools: [pageTool("place_order", false)],
		});
		const panel = fakePanel();
		const receive = c.addPanel(panel.port);
		receive({ type: "hello", windowId: 1 });
		await until(
			() => panel.state()?.tab?.tools.length === 1,
			"the tab's tools in the panel",
		);
		const answer = async (call: Promise<unknown>) => {
			await until(() => panel.state()?.questions.length === 1, "a question");
			receive({
				type: "answer",
				id: panel.state()?.questions[0]?.id ?? "",
				answer: "deny",
			});
			await call.catch(() => {});
		};
		await answer(callTool("page_place_order"));
		expect(fake.notifications).toEqual([]);
		fake.focused = false;
		const second = callTool("page_place_order");
		await until(() => fake.notifications.length === 1, "a notification");
		await answer(second);
	});

	test("without a panel, a notification: Allow once its only button, the tool, the site and the AI app in it; arguments cut say so", async () => {
		const { c, fake } = await connection({
			tools: [pageTool("place_order", false)],
		});
		// The bridge reads the page once a panel or a connection needs it.
		const panel = fakePanel();
		c.addPanel(panel.port);
		await until(
			() => panel.state()?.tab?.tools.length === 1,
			"the tab's tools",
		);
		const short = callTool("page_place_order", { item: "tea" });
		await until(() => fake.notifications.length === 1, "a notification");
		expect(fake.notificationOptions[0]).toEqual({
			type: "basic",
			iconUrl: `chrome-extension://${ID}/icons/icon-128.png`,
			title: "Allow place_order?",
			message:
				'Claude (claude.ai) wants to run page_place_order: {"item":"tea"}',
			contextMessage: "On shop.example · Closing this is Don't allow",
			buttons: [{ title: "Allow once" }],
			requireInteraction: true,
			priority: 2,
		});
		c.notificationDismissed(fake.notifications[0] as string);
		await expect(short).rejects.toThrow("did not allow");
		const long = callTool("page_place_order", { item: "x".repeat(5_000) });
		await until(() => fake.notifications.length === 2, "a notification");
		expect(String(fake.notificationOptions[1]?.["message"])).toEndWith(
			`\n${ARGS_CUT_NOTE}`,
		);
		expect(fake.notificationOptions[1]?.["buttons"]).toEqual([
			{ title: "Allow once" },
		]);
		c.notificationDismissed(fake.notifications[1] as string);
		await expect(long).rejects.toThrow("did not allow");
		expect(fake.pageCalls).toEqual([]);
	});
});

describe("the relay's pairing page (DEC-203)", () => {
	test("with AI access off, the page gets no question", async () => {
		const { c, fake } = await connection({ aiOn: false, fill: true });
		const panel = fakePanel();
		c.addPanel(panel.port);
		const page = pairingPage();
		c.pairingPage(page);
		await until(() => page.closed, "the page's port closed");
		expect(panel.state()?.questions).toEqual([]);
		expect(fake.notifications).toEqual([]);
	});

	test("turning AI access off withdraws a question that waits", async () => {
		const { c } = await connection({ aiOn: true, fill: true });
		const panel = fakePanel();
		const receive = c.addPanel(panel.port);
		receive({ type: "hello", windowId: 1 });
		const page = pairingPage();
		c.pairingPage(page);
		await until(() => panel.state()?.questions.length === 1, "the question");
		receive({ type: "stop" });
		await until(() => panel.state()?.questions.length === 0, "withdrawn");
		await until(() => page.closed, "the page's port closed");
		expect(page.sent).toEqual([]);
	});

	test("a host removed under the switch (Remove in the panel): its next page asks again (DEC-213)", async () => {
		const { c } = await connection({
			aiOn: true,
			fill: true,
			alwaysHosts: ["claude.ai"],
		});
		const panel = fakePanel();
		const receive = c.addPanel(panel.port);
		receive({ type: "hello", windowId: 1 });
		await until(
			() => panel.state()?.fillAlways?.includes("claude.ai") === true,
			"the host listed",
		);
		receive({ type: "forget-fill-host", host: "claude.ai" });
		await until(
			() => panel.state()?.fillAlways?.length === 0,
			"the host removed",
		);
		const page = pairingPage();
		c.pairingPage(page);
		await until(() => panel.state()?.questions.length === 1, "the question");
		receive({ type: "stop" });
		await until(() => page.closed, "the page's port closed");
	});
});

describe("a question's notification (no panel)", () => {
	test("closing it is Don't allow: nothing is filled in", async () => {
		const { c, fake } = await connection({ aiOn: true, fill: true });
		const page = pairingPage();
		c.pairingPage(page);
		await until(() => fake.notifications.length === 1, "a notification");
		c.notificationDismissed(fake.notifications[0] as string);
		await until(() => page.closed, "the page's port closed");
		expect(page.sent).toEqual([]);
	});

	test("a click on its body where Chrome refuses the side panel: a new notification asks again (EQ 18)", async () => {
		const { c, fake } = await connection({ aiOn: true, fill: true });
		const page = pairingPage();
		c.pairingPage(page);
		await until(() => fake.notifications.length === 1, "a notification");
		// What the worker logs where Chrome refuses the panel.
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			c.notificationClicked(fake.notifications[0] as string);
			await until(() => fake.notifications.length === 2, "a new notification");
			expect(String(warn.mock.calls[0]?.[0])).toContain("side panel");
		} finally {
			warn.mockRestore();
		}
		expect(fake.notifications[1]).not.toBe(fake.notifications[0]);
		// The question still waits: the old one's closing answers nothing.
		c.notificationDismissed(fake.notifications[0] as string);
		await Bun.sleep(20);
		expect(page.closed).toBe(false);
		c.notificationDismissed(fake.notifications[1] as string);
		await until(() => page.closed, "the page's port closed");
		expect(page.sent).toEqual([]);
	});
});
