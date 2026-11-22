/**
 * The worker's `Connection` itself, with a fake Chrome and settings in
 * memory: the panel's commands as the worker runs them, the relay's
 * pairing page with AI access off and on, and the notifications' answers.
 * What the end-to-end tests asked of it through a real browser, where only
 * this code decided (iteration 50).
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import type { PagePort } from "@ractive-ch/tab-mcp-client/extension";
import type { PageTool, PageTools } from "../src/messages.ts";
import type { PanelState } from "../src/protocol.ts";
import { APP_ID } from "../src/protocol.ts";
import type { AllowedTools } from "../src/worker/allowed.ts";
import { Connection } from "../src/worker/connection.ts";
import { FillSetting } from "../src/worker/fill.ts";
import { memoryKv } from "../src/worker/kv.ts";
import { CachedSecretStorage } from "../src/worker/secret.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const SITE = "https://shop.example";
const OTHER = "https://other.example";
const RELAY = "https://relay.example";

/** What the fake Chrome answers, and what it was asked. */
interface Fake {
	tools: PageTool[];
	/** Every call of a function the fake does not answer itself. */
	calls: string[];
	/** The ids of the notifications made, in order. */
	notifications: string[];
}

/**
 * A Chrome with one normal window and one tab of `SITE`, whose content
 * script lists `fake.tools`. The side panel never opens (as without a
 * user's gesture). Any other function: recorded, resolves to nothing.
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
		windows: { getLastFocused: async () => ({ id: 1, focused: true }) },
		tabs: {
			query: async () => [tab],
			get: async () => ({ ...tab, status: "complete" }),
			sendMessage: async (_tabId: number, request: { type: string }) => {
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
			create: async (id: string) => {
				fake.notifications.push(id);
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

/** Until `check` holds, at most a second. */
async function until(
	check: () => boolean | Promise<boolean>,
	what: string,
): Promise<void> {
	const end = Date.now() + 1_000;
	while (!(await check())) {
		if (Date.now() > end) throw new Error(`never: ${what}`);
		await Bun.sleep(5);
	}
}

// Each test's own Chrome; the one before (none, in Bun) is back after the
// file. Every test ends with nothing of its connection still waiting.
const g = globalThis as { chrome?: unknown };
const before = g.chrome;
afterAll(() => {
	g.chrome = before;
});

/** A connection as `Connection.start()` makes one, from these settings. */
async function connection(
	options: {
		tools?: PageTool[];
		allowed?: AllowedTools;
		aiOn?: boolean;
		fill?: boolean;
	} = {},
) {
	const fake: Fake = {
		tools: options.tools ?? [],
		calls: [],
		notifications: [],
	};
	g.chrome = fakeChrome(fake);
	// Stored, as start() loads them.
	const kv = memoryKv({
		relay: RELAY,
		...(options.allowed ? { allowedTools: options.allowed } : {}),
		...(options.fill ? { fillCodeFor: RELAY } : {}),
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
	test("Allow all takes only tools the worker offers on that origin now, that ask first", async () => {
		const { c, kv } = await connection({
			tools: [pageTool("place_order", false), pageTool("get_greeting", true)],
		});
		const panel = fakePanel();
		const receive = c.addPanel(panel.port);
		// The bridge has read the tab (for the panel).
		await until(
			() => panel.state()?.tab?.tools.length === 2,
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
		// Not a name it does not offer, not a read-only one, not another site.
		expect(await allowedOn(kv, SITE)).toEqual(["place_order"]);
		expect(await allowedOn(kv, OTHER)).toEqual([]);
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
