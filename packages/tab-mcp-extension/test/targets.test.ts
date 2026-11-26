/**
 * Where a call goes (iteration 53, DEC-230) without a browser: the mode
 * "the tab in front" (as before) and "a pinned tab", the `tab` argument,
 * `list_tabs` and `use_tab`, and the page's tools following the target,
 * through the extension's own tools, the bridge and the navigation tools
 * as the worker wires them.
 */

import { describe, expect, test } from "bun:test";
import type {
	ModelContextTool,
	ToolExecuteCallbackOptions,
} from "@ractive-ch/tab-mcp-client";
import type { PageInfo, PageTool } from "../src/messages.ts";
import { noAccess, type TargetTab } from "../src/tabs.ts";
import { PageToolBridge } from "../src/worker/bridge.ts";
import { memoryKv } from "../src/worker/kv.ts";
import { navigationTools, type Step } from "../src/worker/navigation.ts";
import { type TabList, tabTools } from "../src/worker/tab-tools.ts";
import {
	kvTargetStore,
	LIST_TABS_HINT,
	parseTargetSetting,
	type TargetSetting,
	Targets,
	tabIdOf,
} from "../src/worker/targets.ts";
import { createTools } from "../src/worker/tools.ts";

interface FakeTab {
	id: number;
	url: string;
	title: string;
	/** The extension may read it: the browser shows it the address and title. */
	readable: boolean;
	tools: PageTool[];
	window?: "normal" | "popup";
	closed?: boolean;
}

const readOnly = (name: string): PageTool => ({
	name,
	description: `The ${name} tool.`,
	inputSchema: { type: "object" },
	annotations: { readOnlyHint: true },
});

const options = (): ToolExecuteCallbackOptions => ({
	signal: new AbortController().signal,
	client: {
		kind: "relay",
		grantId: "g",
		id: "https://client.example",
		host: "client.example",
	},
});

/**
 * Three tabs: a shop (1, in front), a docs page (2) and a bank's page the
 * extension may not read (3, its title not shown to it), each with tools of
 * its own; the targets, the bridge and the tools wired as the worker does.
 */
function world(setting?: TargetSetting) {
	const tabs: FakeTab[] = [
		{
			id: 1,
			url: "https://shop.example/",
			title: "Shop",
			readable: true,
			tools: [readOnly("search")],
		},
		{
			id: 2,
			url: "https://docs.example/a",
			title: "Docs",
			readable: true,
			tools: [readOnly("lookup")],
		},
		{
			id: 3,
			url: "https://bank.example/statement",
			title: "Secret bank statement",
			readable: false,
			tools: [readOnly("balance")],
		},
	];
	let front = 1;
	const open = (id: number) => tabs.find((t) => t.id === id && !t.closed);
	// The browser hides the address and title of a tab the extension may not read.
	const view = (t: FakeTab): TargetTab => ({
		id: t.id,
		url: t.readable ? t.url : "",
		title: t.readable ? t.title : "",
	});
	const kv = memoryKv(setting === undefined ? {} : { aiTarget: setting });
	const frontTab = async () => {
		const t = open(front);
		if (t === undefined) throw new Error("No tab is in front.");
		return view(t);
	};
	let changes = 0;
	const targets = new Targets(
		kvTargetStore(kv),
		{
			front: frontTab,
			tab: async (id) => {
				const t = open(id);
				return t !== undefined && (t.window ?? "normal") === "normal"
					? view(t)
					: undefined;
			},
		},
		() => changes++,
	);
	const page = async (tab: TargetTab): Promise<PageInfo> => {
		const t = open(tab.id);
		if (t === undefined || !t.readable) throw noAccess(tab.url);
		return {
			url: t.url,
			title: t.title,
			webmcp: { available: true, tools: t.tools.length },
		};
	};
	const calls: { tabId: number; name: string }[] = [];
	const registered = new Map<string, ModelContextTool>();
	const bridge = new PageToolBridge(
		{
			async registerTool(tool, { signal }) {
				registered.set(tool.name, tool);
				signal.addEventListener("abort", () => registered.delete(tool.name));
			},
		},
		{
			current: () => targets.peek(),
			list: async (tab) => {
				const t = open(tab.id);
				if (t === undefined || !t.readable) throw noAccess(tab.url);
				return {
					url: t.url,
					origin: new URL(t.url).origin,
					documentId: `doc-${t.id}`,
					more: 0,
					available: true,
					tools: t.tools,
				};
			},
			call: async (tabId, target) => {
				calls.push({ tabId, name: target.name });
				return { ok: true, value: `done in ${tabId}` };
			},
			settled: async () => ({}),
		},
		{ callIn: (id) => targets.callIn(id) },
	);
	const steps: { tabId: number; step: Step }[] = [];
	const own = [
		...createTools(
			{ current: (tab) => targets.forCall(tab), page },
			() => bridge,
		),
		...tabTools(
			targets,
			{
				tabs: async () => tabs.filter((t) => !t.closed).map(view),
				front: frontTab,
				page,
			},
			() => bridge.refresh(),
		),
		...navigationTools(
			{
				target: (tab) => targets.forCall(tab),
				current: (tab) => targets.peek(tab),
				tab: async (id) => {
					const t = open(id);
					return t === undefined ? undefined : view(t);
				},
				page,
				history: async () => ({ length: 1 }),
				go: async (tabId, step) => {
					steps.push({ tabId, step });
					return "complete";
				},
			},
			async () => "allow",
			() => bridge.refresh(),
		),
	];
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const tool =
			own.find((t) => t.name === name) ?? registered.get(name) ?? undefined;
		if (tool === undefined) throw new Error(`no tool ${name}`);
		return tool.execute(args, options());
	};
	return {
		tabs,
		kv,
		targets,
		bridge,
		registered,
		calls,
		steps,
		call,
		changes: () => changes,
		front: (id: number) => {
			front = id;
		},
		close: (id: number) => {
			const t = tabs.find((x) => x.id === id);
			if (t) t.closed = true;
		},
		stored: async () => parseTargetSetting(await kv.get("aiTarget")),
	};
}

const pageInfo = async (w: ReturnType<typeof world>, args = {}) =>
	(await w.call("page_info", args)) as PageInfo;

describe("the setting", () => {
	test("anything stored that is not a pinned mode is the tab in front; a pin only as a tab id", () => {
		expect(parseTargetSetting(undefined)).toEqual({ mode: "front" });
		expect(parseTargetSetting({ mode: "front", pin: 3 })).toEqual({
			mode: "front",
		});
		expect(parseTargetSetting({ mode: "pinned" })).toEqual({ mode: "pinned" });
		expect(parseTargetSetting({ mode: "pinned", pin: 3 })).toEqual({
			mode: "pinned",
			pin: 3,
		});
		expect(parseTargetSetting({ mode: "pinned", pin: "3" })).toEqual({
			mode: "pinned",
		});
		expect(parseTargetSetting("pinned")).toEqual({ mode: "front" });
	});

	test("a tab argument is a decimal tab id; anything else says to call list_tabs", () => {
		expect(tabIdOf("12")).toBe(12);
		for (const bad of ["", "1.5", "-1", "a:1", " 1", "1e3"])
			expect(() => tabIdOf(bad)).toThrow(LIST_TABS_HINT);
	});
});

describe("mode: the tab in front (the default)", () => {
	test("as before: calls follow the tab in front, nothing is pinned, nothing stored", async () => {
		const w = world();
		expect((await pageInfo(w)).title).toBe("Shop");
		w.front(2);
		expect((await pageInfo(w)).title).toBe("Docs");
		expect(await w.kv.get("aiTarget")).toBeUndefined();
		// The page tools are those of the tab in front, and follow it.
		await w.bridge.refresh();
		expect([...w.registered.keys()]).toEqual(["page_lookup"]);
		w.front(1);
		await w.bridge.refresh();
		expect([...w.registered.keys()]).toEqual(["page_search"]);
	});

	test("use_tab pins all the same, and switches the setting to a pinned tab", async () => {
		const w = world();
		const used = (await w.call("use_tab", { tab: "2" })) as Record<
			string,
			unknown
		>;
		expect(used).toMatchObject({ tab: "2", pinned: true, title: "Docs" });
		expect(await w.stored()).toEqual({ mode: "pinned", pin: 2 });
		expect(w.changes()).toBe(1);
		// Its page tools are offered by the answer.
		expect([...w.registered.keys()]).toEqual(["page_lookup"]);
		expect((await pageInfo(w)).title).toBe("Docs");
	});

	test("switching the setting to a pinned tab pins at the next call, the tab in front then", async () => {
		const w = world();
		await w.targets.setMode("pinned");
		expect(await w.stored()).toEqual({ mode: "pinned" });
		w.front(2);
		expect((await pageInfo(w)).title).toBe("Docs");
		expect(await w.stored()).toEqual({ mode: "pinned", pin: 2 });
	});
});

describe("mode: a pinned tab", () => {
	test("the first call pins the tab in front; a tab switch moves nothing", async () => {
		const w = world({ mode: "pinned" });
		expect((await pageInfo(w)).title).toBe("Shop");
		expect(await w.stored()).toEqual({ mode: "pinned", pin: 1 });
		w.front(2);
		expect((await pageInfo(w)).title).toBe("Shop");
		await w.bridge.refresh();
		expect([...w.registered.keys()]).toEqual(["page_search"]);
		expect(await w.call("page_search")).toBe("done in 1");
		expect(w.calls).toEqual([{ tabId: 1, name: "search" }]);
	});

	test("two first calls at once pin one tab", async () => {
		const w = world({ mode: "pinned" });
		const both = Promise.all([pageInfo(w), pageInfo(w)]);
		w.front(2);
		const [a, b] = await both;
		expect(a.title).toBe(b.title);
		expect((await w.stored()).pin).toBe(a.title === "Shop" ? 1 : 2);
	});

	test("a page tool's call pins the tab it was offered from", async () => {
		const w = world({ mode: "pinned" });
		await w.bridge.refresh();
		expect(await w.call("page_search")).toBe("done in 1");
		expect(await w.stored()).toEqual({ mode: "pinned", pin: 1 });
	});

	test("the pinned tab closed: every call fails and says to call list_tabs; nothing goes to another tab", async () => {
		const w = world({ mode: "pinned", pin: 2 });
		w.close(2);
		await expect(pageInfo(w)).rejects.toThrow(
			`The pinned tab was closed; nothing was done in another tab. ${LIST_TABS_HINT}`,
		);
		await expect(
			w.call("webmcp_call", { name: "search" }) as Promise<unknown>,
		).rejects.toThrow("The pinned tab was closed");
		await expect(
			w.call("navigate", { url: "/x" }) as Promise<unknown>,
		).rejects.toThrow("The pinned tab was closed");
		// webmcp_tools lists no tools, with the reason.
		expect(await w.call("webmcp_tools")).toMatchObject({
			tools: [],
			error: expect.stringContaining("The pinned tab was closed"),
		});
		expect(w.calls).toEqual([]);
		expect(w.steps).toEqual([]);
		// The pin stays: the next call fails the same way.
		expect(await w.stored()).toEqual({ mode: "pinned", pin: 2 });
		// A tab in another window than a normal one counts as gone too.
		const v = world({ mode: "pinned", pin: 2 });
		(v.tabs[1] as FakeTab).window = "popup";
		await expect(pageInfo(v)).rejects.toThrow("The pinned tab was closed");
	});

	test("the setting back to the tab in front drops the pin", async () => {
		const w = world({ mode: "pinned", pin: 2 });
		await w.targets.setMode("front");
		expect(await w.stored()).toEqual({ mode: "front" });
		expect((await pageInfo(w)).title).toBe("Shop");
		await w.targets.setMode("pinned");
		expect(await w.stored()).toEqual({ mode: "pinned" });
	});

	test("a browser start forgets the pin (its id may be another tab's), not the mode", async () => {
		const w = world({ mode: "pinned", pin: 2 });
		await w.targets.forgetPin();
		expect(await w.stored()).toEqual({ mode: "pinned" });
	});

	test("a page tool offered from a tab that is no longer the pinned one does not run", async () => {
		const w = world({ mode: "pinned", pin: 1 });
		await w.bridge.refresh();
		const search = w.registered.get("page_search");
		await w.targets.use(2);
		await expect(
			Promise.resolve(search?.execute({}, options())),
		).rejects.toThrow("AI apps work in another tab now");
		expect(w.calls).toEqual([]);
	});
});

describe("the tab argument", () => {
	test("wins over the mode and leaves the pin as it is", async () => {
		const w = world({ mode: "pinned", pin: 1 });
		expect((await pageInfo(w, { tab: "2" })).title).toBe("Docs");
		expect(await w.stored()).toEqual({ mode: "pinned", pin: 1 });
		const f = world();
		expect((await pageInfo(f, { tab: "2" })).title).toBe("Docs");
		expect(await f.kv.get("aiTarget")).toBeUndefined();
	});

	test("webmcp_tools and webmcp_call reach another tab's tools; the page tools offered stay the target's", async () => {
		const w = world({ mode: "pinned", pin: 1 });
		await w.bridge.refresh();
		expect([...w.registered.keys()]).toEqual(["page_search"]);
		const listed = (await w.call("webmcp_tools", { tab: "2" })) as {
			tabId: number;
			tools: { name: string; tool?: string }[];
		};
		expect(listed.tabId).toBe(2);
		expect(listed.tools.map((t) => [t.name, t.tool])).toEqual([
			["lookup", "page_lookup"],
		]);
		expect(await w.call("webmcp_call", { name: "lookup", tab: "2" })).toBe(
			"done in 2",
		);
		expect(w.calls).toEqual([{ tabId: 2, name: "lookup" }]);
		// Not offered, and the target's own still are.
		expect([...w.registered.keys()]).toEqual(["page_search"]);
		// The other tab's tool is not the target's.
		await expect(
			w.call("webmcp_call", { name: "lookup" }) as Promise<unknown>,
		).rejects.toThrow("offers no tool lookup");
		await expect(
			w.call("webmcp_call", { name: "search", tab: "2" }) as Promise<unknown>,
		).rejects.toThrow("offers no tool search");
	});

	test("a tab the extension may not read: the access message, as page_info gives it", async () => {
		const w = world();
		await expect(pageInfo(w, { tab: "3" })).rejects.toThrow(
			"may not read this tab yet",
		);
		const listed = (await w.call("webmcp_tools", { tab: "3" })) as {
			tools: unknown[];
			error?: string;
		};
		expect(listed.tools).toEqual([]);
		expect(listed.error).toContain("may not read this tab yet");
		await expect(
			w.call("webmcp_call", { name: "balance", tab: "3" }) as Promise<unknown>,
		).rejects.toThrow("may not read this tab yet");
		expect(w.calls).toEqual([]);
	});

	test("a closed tab or no id from list_tabs: the call fails and says to call list_tabs", async () => {
		const w = world();
		w.close(2);
		await expect(pageInfo(w, { tab: "2" })).rejects.toThrow(
			`No tab 2 is open: it was closed, or the id is not one list_tabs gave. ${LIST_TABS_HINT}`,
		);
		await expect(pageInfo(w, { tab: "two" })).rejects.toThrow(
			"Not a tab id from list_tabs",
		);
	});

	test("navigate goes to the tab named, and the pin stays", async () => {
		const w = world({ mode: "pinned", pin: 1 });
		const result = (await w.call("navigate", {
			url: "/b",
			tab: "2",
		})) as PageInfo;
		expect(w.steps).toEqual([
			{ tabId: 2, step: { url: "https://docs.example/b" } },
		]);
		expect(result.title).toBe("Docs");
		expect(await w.stored()).toEqual({ mode: "pinned", pin: 1 });
	});
});

describe("list_tabs and use_tab", () => {
	test("only tabs the extension may read, with ids, in front and pinned; the others only counted, nothing of them said", async () => {
		const w = world({ mode: "pinned", pin: 2 });
		const list = (await w.call("list_tabs")) as TabList;
		expect(list.mode).toBe("a pinned tab");
		expect(list.tabs).toEqual([
			{ tab: "1", title: "Shop", url: "https://shop.example/", inFront: true },
			{ tab: "2", title: "Docs", url: "https://docs.example/a", pinned: true },
		]);
		expect(list.notReadable).toBe(1);
		expect(list.note).toContain("1 more tab is open that the");
		// Not even what the fake would give: no title, no address, no id of it.
		const text = JSON.stringify(list);
		expect(text).not.toContain("bank");
		expect(text).not.toContain("Secret");
		expect(text).not.toContain('"3"');
	});

	test("says where calls go: the tab in front, none pinned yet, a pinned tab that was closed", async () => {
		const front = (await world().call("list_tabs")) as TabList;
		expect(front.mode).toBe("the tab in front");
		expect(front.note).toContain("go to the tab in front");
		expect(front.tabs.some((t) => t.pinned)).toBe(false);
		const none = (await world({ mode: "pinned" }).call("list_tabs")) as TabList;
		expect(none.note).toContain("the next one pins the tab in front");
		const gone = world({ mode: "pinned", pin: 2 });
		gone.close(2);
		const closed = (await gone.call("list_tabs")) as TabList;
		expect(closed.note).toContain("which was closed");
		// Listing pins nothing.
		const w = world({ mode: "pinned" });
		await w.call("list_tabs");
		expect(await w.stored()).toEqual({ mode: "pinned" });
	});

	test("use_tab on a tab the extension may not read fails as page_info does, and pins nothing", async () => {
		const w = world();
		await expect(
			w.call("use_tab", { tab: "3" }) as Promise<unknown>,
		).rejects.toThrow("may not read this tab yet");
		expect(await w.kv.get("aiTarget")).toBeUndefined();
		const p = world({ mode: "pinned", pin: 1 });
		await expect(
			p.call("use_tab", { tab: "9" }) as Promise<unknown>,
		).rejects.toThrow("No tab 9 is open");
		expect(await p.stored()).toEqual({ mode: "pinned", pin: 1 });
	});

	test("use_tab moves the page tools to the tab it pins", async () => {
		const w = world({ mode: "pinned", pin: 1 });
		await w.bridge.refresh();
		expect([...w.registered.keys()]).toEqual(["page_search"]);
		await w.call("use_tab", { tab: "2" });
		expect([...w.registered.keys()]).toEqual(["page_lookup"]);
		expect(await w.call("page_lookup")).toBe("done in 2");
	});
});
