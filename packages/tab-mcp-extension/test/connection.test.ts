/**
 * The worker's `Connection` itself, with a fake Chrome and settings in
 * memory: the panel's commands as the worker runs them, the relay's
 * pairing page with AI access off and on, and the notifications' answers.
 * What the end-to-end tests asked of it through a real browser, where only
 * this code decided (iteration 50).
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
	TabMcp,
	type Tool,
	type ToolExecuteOptions,
} from "@ractive-ch/tab-mcp-client";
import type { PagePort } from "@ractive-ch/tab-mcp-client/extension";
import type { PageTool, PageTools } from "../src/messages.ts";
import type { PanelState } from "../src/protocol.ts";
import { APP_ID } from "../src/protocol.ts";
import type { AllowedTools } from "../src/worker/allowed.ts";
import { Connection } from "../src/worker/connection.ts";
import { FillSetting } from "../src/worker/fill.ts";
import { memoryKv } from "../src/worker/kv.ts";
import { ARGS_CUT_NOTE } from "../src/worker/questions.ts";
import { CachedSecretStorage } from "../src/worker/secret.ts";

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
		},
		windows: {
			getLastFocused: async () => ({ id: 1, focused: fake.focused }),
			get: async (id: number) => ({ id, focused: fake.focused }),
		},
		tabs: {
			query: async () => [tab],
			get: async () => ({ ...tab, status: "complete" }),
			sendMessage: async (
				_tabId: number,
				request: { type: string; name?: string },
			) => {
				if (request.type === "webmcp-call") {
					fake.pageCalls.push(request.name ?? "");
					return { ok: true, value: "done" };
				}
				if (request.type === "webmcp-list")
					return {
						ok: true,
						url: tab.url,
						origin: SITE,
						documentId: "doc-1",
						more: 0,
						available: true,
						tools: fake.tools,
					} satisfies { ok: true } & PageTools;
				if (request.type === "page-info")
					return {
						ok: true,
						url: tab.url,
						title: tab.title,
						webmcp: { available: true, tools: fake.tools.length },
					};
				return { ok: true, value: null };
			},
		},
		permissions: { contains: async () => true },
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
 * library's connect makes one, its disconnect closes it.
 */
class FakeSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static made: string[] = [];
	readyState = FakeSocket.CONNECTING;
	constructor(readonly url: string) {
		super();
		FakeSocket.made.push(url);
	}
	send(): void {}
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
		.map(([t]) => t as Tool)
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
		} as ToolExecuteOptions),
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
	} = {},
) {
	const fake: Fake = {
		tools: options.tools ?? [],
		focused: true,
		calls: [],
		notifications: [],
		notificationOptions: [],
		pageCalls: [],
	};
	g.chrome = fakeChrome(fake);
	// Stored, as start() loads them.
	const kv = memoryKv({
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

describe("the state for pages with the client library (DEC-207, DEC-221)", () => {
	test("its name, on and the AI apps: no version, nothing of the relay", async () => {
		const { c } = await connection();
		expect(c.handshakeState()).toEqual({
			name: "tab-mcp browser extension",
			on: false,
			apps: [],
			whileInFront: true,
		});
	});
});

describe("a page tool's question", () => {
	test("Always allow on <host>: kept for the site, shown in the panel; that tool runs unasked after, another still asks (EQ 10)", async () => {
		const { c, kv, fake } = await connection({
			tools: [pageTool("place_order", false), pageTool("pay", false)],
		});
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
