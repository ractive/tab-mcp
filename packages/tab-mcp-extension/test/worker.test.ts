/**
 * The connection's pieces in the service worker: who may send what, the
 * questions of tools that ask first, the address secret's storage, Always
 * allow, and a background bundle a service worker can run.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfirmRequest } from "@ractive-ch/tab-mcp-client";
import { build } from "../scripts/build.ts";
import {
	isContentEvent,
	isPanelSender,
	type PanelCommand,
	parseCommand,
} from "../src/protocol.ts";
import { allowable, isAllowed } from "../src/worker/allowed.ts";
import { AlwaysAllowed } from "../src/worker/always.ts";
import { memoryKv, migrate } from "../src/worker/kv.ts";
import {
	NOTIFICATION_GUARD_MS,
	type NotificationText,
	notificationText,
	Questions,
	type QuestionsHost,
	visible,
} from "../src/worker/questions.ts";
import { CachedSecretStorage } from "../src/worker/secret.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const PANEL = `chrome-extension://${ID}/sidepanel/index.html`;
const contentScript = { id: ID, url: "https://site.test/page", tab: { id: 1 } };

/** Every command there is, valid. */
const COMMANDS: PanelCommand[] = [
	{ type: "hello", windowId: 1 },
	{ type: "visible", visible: false },
	{ type: "connect" },
	{ type: "stop" },
	{ type: "pair", on: true },
	{ type: "revoke", grantId: "g" },
	{ type: "new-address" },
	{ type: "set-relay", relay: "https://relay.example" },
	{ type: "set-allowed", origin: "https://site.test", name: "t", on: true },
	{ type: "answer", id: "q", answer: "allow" },
];

describe("who may send what", () => {
	test("a port is the panel's only from the panel's page of this extension", () => {
		expect(isPanelSender({ id: ID, url: PANEL }, ID)).toBe(true);
		expect(isPanelSender({ id: ID, url: `${PANEL}#x` }, ID)).toBe(true);
		// A content script: in a tab, at the page's address.
		expect(isPanelSender(contentScript, ID)).toBe(false);
		// Even one claiming the panel's address from a tab (a panel page opened as a tab).
		expect(isPanelSender({ id: ID, url: PANEL, tab: { id: 2 } }, ID)).toBe(
			false,
		);
		// Another extension, another page of this one, no address.
		expect(isPanelSender({ id: "other", url: PANEL }, ID)).toBe(false);
		expect(
			isPanelSender({ id: ID, url: `chrome-extension://${ID}/other.html` }, ID),
		).toBe(false);
		expect(
			isPanelSender(
				{ id: ID, url: `chrome-extension://other/sidepanel/index.html` },
				ID,
			),
		).toBe(false);
		expect(isPanelSender({ id: ID }, ID)).toBe(false);
	});

	test("a content script's message counts only as webmcp-changed; no command does anything", () => {
		expect(isContentEvent({ type: "webmcp-changed" }, contentScript, ID)).toBe(
			true,
		);
		for (const command of COMMANDS)
			expect(isContentEvent(command, contentScript, ID)).toBe(false);
		// Not from a tab (an extension page), or from another extension.
		expect(
			isContentEvent({ type: "webmcp-changed" }, { id: ID, url: PANEL }, ID),
		).toBe(false);
		expect(
			isContentEvent(
				{ type: "webmcp-changed" },
				{ ...contentScript, id: "other" },
				ID,
			),
		).toBe(false);
		expect(isContentEvent(null, contentScript, ID)).toBe(false);
	});

	test("commands are checked: only well-formed ones pass, as they are", () => {
		for (const command of COMMANDS)
			expect(parseCommand(command)).toEqual(command);
		// Extra fields go.
		expect(parseCommand({ type: "connect", relay: "x" })).toEqual({
			type: "connect",
		});
		for (const bad of [
			null,
			"connect",
			{},
			{ type: "webmcp-changed" },
			{ type: "hello", windowId: "1" },
			{ type: "pair" },
			{ type: "visible", visible: "no" },
			{ type: "revoke", grantId: 1 },
			{ type: "set-relay" },
			{ type: "set-allowed", origin: "o", name: "n" },
			{ type: "answer", id: "q", answer: "yes" },
		])
			expect(parseCommand(bad)).toBeUndefined();
	});
});

/** A host whose notifications and panels the test controls. */
function fakeHost(options: { panel?: boolean } = {}) {
	const shown = new Map<string, NotificationText>();
	const cleared: string[] = [];
	let now = 1_000_000;
	const host: QuestionsHost & {
		shown: typeof shown;
		cleared: string[];
		advance(ms: number): void;
		changes: number;
	} = {
		shown,
		cleared,
		changes: 0,
		advance(ms) {
			now += ms;
		},
		windowOf: async (tabId) => (tabId === 7 ? 3 : undefined),
		panelInFocus: async (windowId) => options.panel === true && windowId === 3,
		notify: async (id, text) => {
			shown.set(id, text);
		},
		clear: (id) => {
			shown.delete(id);
			cleared.push(id);
		},
		changed: () => {
			host.changes++;
		},
		now: () => now,
	};
	return host;
}

function request(
	args: Record<string, unknown> = { item: "tea" },
	signal = new AbortController().signal,
): ConfirmRequest {
	return {
		tool: { name: "page_place_order", title: "Place order", description: "" },
		arguments: args,
		client: {
			grantId: "g1",
			id: "https://claude.ai/oauth",
			name: "Claude",
			host: "claude.ai",
		},
		signal,
	};
}

const settle = () => Bun.sleep(5);

describe("questions", () => {
	test("without a panel in front, a notification asks: Allow, Always allow", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		const where = { tabId: 7, origin: "https://site.test" };
		const answer = questions.ask(request(), where);
		await settle();
		expect(questions.list).toHaveLength(1);
		const [[id, text]] = [...host.shown] as [[string, NotificationText]];
		expect(text.title).toBe("Allow Place order?");
		expect(text.contextMessage).toBe("On site.test · tab-mcp for Chrome");
		expect(text.message).toBe(
			'Claude (claude.ai) wants to run page_place_order: {"item":"tea"}',
		);
		expect(text.buttons).toEqual(["Allow", "Always allow"]);
		host.advance(NOTIFICATION_GUARD_MS);
		questions.notificationButton(id, 0);
		expect(await answer).toBe("allow");
		expect(questions.list).toEqual([]);
		expect(host.shown.size).toBe(0);
		const always = questions.ask(request(), where);
		await settle();
		host.advance(NOTIFICATION_GUARD_MS);
		questions.notificationButton([...host.shown.keys()][0] as string, 1);
		expect(await always).toBe("always");
	});

	test("where Always allow is not offered, only Allow, and a second button counts as nothing", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		const answer = questions.ask(request(), { tabId: 7, origin: "null" });
		await settle();
		const [[id, text]] = [...host.shown] as [[string, NotificationText]];
		expect(text.buttons).toEqual(["Allow"]);
		host.advance(NOTIFICATION_GUARD_MS);
		questions.notificationButton(id, 1);
		await settle();
		expect(questions.list).toHaveLength(1);
		questions.notificationButton(id, 0);
		expect(await answer).toBe("allow");
	});

	test("Don't allow is a click on the body or closing it", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		const answer = questions.ask(request(), { tabId: 7 });
		await settle();
		questions.notificationDismissed([...host.shown.keys()][0] as string);
		expect(await answer).toBe("deny");
	});

	test("an Allow or Always allow within the guard does not count: the notification shows again", async () => {
		for (const index of [0, 1]) {
			const host = fakeHost();
			const questions = new Questions(host);
			let settled = false;
			const answer = questions.ask(request(), {
				tabId: 7,
				origin: "https://site.test",
			});
			void answer.then(() => {
				settled = true;
			});
			await settle();
			const first = [...host.shown.keys()][0] as string;
			host.advance(NOTIFICATION_GUARD_MS - 1);
			questions.notificationButton(first, index);
			await settle();
			expect(settled).toBe(false);
			const second = [...host.shown.keys()][0] as string;
			expect(second).not.toBe(first);
			expect(host.cleared).toContain(first);
			// The old one closing (as it was cleared) answers nothing.
			questions.notificationDismissed(first);
			await settle();
			expect(settled).toBe(false);
			host.advance(NOTIFICATION_GUARD_MS);
			questions.notificationButton(second, index);
			expect(await answer).toBe(index === 0 ? "allow" : "always");
		}
	});

	test("a click answers only its own call; one on a settled call is dropped", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		const a = questions.ask(request({ n: 1 }), { tabId: 7 });
		const b = questions.ask(request({ n: 2 }), { tabId: 7 });
		await settle();
		const [idA, idB] = [...host.shown.keys()] as [string, string];
		host.advance(NOTIFICATION_GUARD_MS);
		questions.notificationDismissed(idB);
		expect(await b).toBe("deny");
		// A late Allow on b's notification does not go to a.
		questions.notificationButton(idB, 0);
		await settle();
		expect(questions.list.map((q) => q.args)).toEqual(['{\n  "n": 1\n}']);
		questions.notificationButton(idA, 0);
		expect(await a).toBe("allow");
	});

	test("a notification is cleared only once Chrome has made it (a slow create)", async () => {
		const host = fakeHost();
		const events: string[] = [];
		let finish = () => {};
		host.notify = (id) => {
			events.push(`create ${id}`);
			return new Promise((resolve) => {
				finish = () => {
					events.push(`created ${id}`);
					resolve();
				};
			});
		};
		host.clear = (id) => events.push(`clear ${id}`);
		const questions = new Questions(host);
		const controller = new AbortController();
		const answer = questions.ask(request({}, controller.signal), { tabId: 7 });
		await settle();
		// The AI app cancels while create still runs.
		controller.abort();
		expect(await answer).toBe("deny");
		await settle();
		const id = events[0]?.slice("create ".length);
		expect(events).toEqual([`create ${id}`]);
		finish();
		await settle();
		expect(events).toEqual([`create ${id}`, `created ${id}`, `clear ${id}`]);
	});

	test("a panel that goes away while a question is routed sends one notification, not two", async () => {
		const host = fakeHost();
		let inFocus: (focused: boolean) => void = () => {};
		host.panelInFocus = () =>
			new Promise((resolve) => {
				inFocus = resolve;
			});
		const questions = new Questions(host);
		const answer = questions.ask(request(), { tabId: 7 });
		await settle();
		// Routing waits on the window; meanwhile the panel is covered.
		questions.panelClosed(3);
		expect(host.shown.size).toBe(1);
		inFocus(false);
		await settle();
		expect(host.shown.size).toBe(1);
		host.advance(NOTIFICATION_GUARD_MS);
		questions.notificationButton([...host.shown.keys()][0] as string, 0);
		expect(await answer).toBe("allow");
	});

	test("with the panel of the tab's focused window open, no notification; it goes out once the panel closes", async () => {
		const host = fakeHost({ panel: true });
		const questions = new Questions(host);
		const answer = questions.ask(request(), { tabId: 7 });
		await settle();
		expect(host.shown.size).toBe(0);
		expect(questions.list).toHaveLength(1);
		questions.panelClosed(3);
		expect(host.shown.size).toBe(1);
		questions.answer(questions.list[0]?.id as string, "always");
		expect(await answer).toBe("always");
		// Cleared once its create is done.
		await settle();
		expect(host.shown.size).toBe(0);
	});

	test("an answer from a panel counts, also while a notification shows", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		const answer = questions.ask(request(), { tabId: 7 });
		await settle();
		expect(host.shown.size).toBe(1);
		questions.answer("not-a-question", "allow");
		questions.answer(questions.list[0]?.id as string, "deny");
		expect(await answer).toBe("deny");
		expect(host.shown.size).toBe(0);
	});

	test("nobody answering is a timeout; the AI app cancelling is Don't allow", async () => {
		const host = fakeHost();
		const questions = new Questions(host, 20);
		expect(await questions.ask(request(), { tabId: 7 })).toBe("timeout");
		expect(host.shown.size).toBe(0);
		const controller = new AbortController();
		const cancelled = questions.ask(request({}, controller.signal), {});
		await settle();
		controller.abort();
		expect(await cancelled).toBe("deny");
		expect(questions.list).toEqual([]);
		const gone = new AbortController();
		gone.abort();
		expect(await questions.ask(request({}, gone.signal), {})).toBe("deny");
	});

	test("arguments and names show invisible, blank and direction characters as \\u escapes", () => {
		expect(visible("pay‮evil​")).toBe("pay\\u202eevil\\u200b");
		expect(visible("tag\u{E0041}")).toBe("tag\\u{e0041}");
		// Every space but the plain one, and the blank letters.
		expect(visible("a b c　d")).toBe("a\\u00a0b\\u2007c\\u3000d");
		expect(visible("⠀ㅤᅟᅠﾠ")).toBe("\\u2800\\u3164\\u115f\\u1160\\uffa0");
		expect(visible("plain text, äöü 😀")).toBe("plain text, äöü 😀");
		// JSON's layout stays; a carriage return does not.
		expect(visible('{\n\t"a": 1\r}')).toBe('{\n\t"a": 1\\u000d}');
	});

	test("a notification's title cuts the page's title on its own; the site stays whole", () => {
		const view = {
			id: "q",
			app: "Claude (claude.ai)",
			host: "claude.ai",
			tool: "page_x",
			title: "A".repeat(200),
			origin: "https://shop.example",
			args: "{}",
			always: true,
		};
		const text = notificationText(view, "{}");
		expect(text.title).toBe(`Allow ${"A".repeat(59)}…?`);
		expect(text.contextMessage).toBe("On shop.example · tab-mcp for Chrome");
		expect(notificationText({ ...view, title: "Order" }, "{}").title).toBe(
			"Allow Order?",
		);
		const { origin: _, title: __, ...bare } = view;
		expect(notificationText({ ...bare, always: false }, "{}")).toEqual({
			title: "Allow page_x?",
			message: "Claude (claude.ai) wants to run page_x.",
			contextMessage: "tab-mcp for Chrome",
			buttons: ["Allow"],
		});
	});

	test("Always allow is offered only for a page of an http(s) site", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		for (const [origin, always] of [
			["https://site.test", true],
			["http://localhost:8080", true],
			["null", false],
			["file://", false],
			["chrome-extension://abc", false],
		] as const) {
			const answer = questions.ask(request(), { tabId: 7, origin });
			await settle();
			const q = questions.list.at(-1);
			expect(q?.always).toBe(always);
			questions.answer(q?.id as string, "deny");
			await answer;
		}
	});
});

describe("allowed tools", () => {
	test("only for http(s) origins: an opaque origin (null) is never allowed", () => {
		expect(allowable("https://site.test")).toBe(true);
		expect(allowable("http://127.0.0.1:3000")).toBe(true);
		for (const origin of [
			"null",
			"",
			"file://",
			"data:text/html,x",
			"chrome-extension://abc",
			"https://site.test/path",
		])
			expect(allowable(origin)).toBe(false);
		const allowed = { null: ["t"], "https://site.test": ["t"] };
		expect(isAllowed(allowed, "null", "t")).toBe(false);
		expect(isAllowed(allowed, "https://site.test", "t")).toBe(true);
	});
});

describe("the settings in IndexedDB", () => {
	test("the address secret: loaded once, read from memory, written through", async () => {
		const kv = memoryKv({
			"tab-mcp:secret:https://relay:tab-mcp-for-chrome": "s1",
			relay: "https://relay",
		});
		const storage = await CachedSecretStorage.load(kv);
		expect(
			storage.getItem("tab-mcp:secret:https://relay:tab-mcp-for-chrome"),
		).toBe("s1");
		// Only the library's keys.
		expect(storage.getItem("relay")).toBeNull();
		storage.setItem("tab-mcp:secret:https://other:tab-mcp-for-chrome", "s2");
		expect(
			storage.getItem("tab-mcp:secret:https://other:tab-mcp-for-chrome"),
		).toBe("s2");
		await storage.written;
		expect(kv.data.get("tab-mcp:secret:https://other:tab-mcp-for-chrome")).toBe(
			"s2",
		);
	});

	/** chrome.storage.local as the migration sees it. */
	function oldArea(initial: Record<string, unknown>, failRemove = false) {
		const data = { ...initial };
		return {
			data,
			get: async () => ({ ...data }),
			async remove(keys: string[]) {
				if (failRemove) throw new Error("gone");
				for (const key of keys) delete data[key];
			},
		};
	}

	const OLD = {
		"tab-mcp:secret:https://relay:tab-mcp-for-chrome": "secret",
		relay: "https://relay",
		aiOn: true,
		replaced: { sibling: false },
		allowedTools: { "https://site.test": ["t"] },
		somethingElse: 1,
	};

	test("the old settings move from chrome.storage.local, then go from there", async () => {
		const old = oldArea(OLD);
		const kv = memoryKv();
		const moved = await migrate(old, kv);
		expect(moved.sort()).toEqual(
			[
				"aiOn",
				"allowedTools",
				"relay",
				"replaced",
				"tab-mcp:secret:https://relay:tab-mcp-for-chrome",
			].sort(),
		);
		const { somethingElse: _, ...settings } = OLD;
		expect(Object.fromEntries(kv.data)).toEqual(settings);
		expect(old.data).toEqual({ somethingElse: 1 });
		// Again: nothing left to move, nothing changes.
		expect(await migrate(old, kv)).toEqual([]);
		expect(Object.fromEntries(kv.data)).toEqual(settings);
	});

	test("crash-safe: written before removed; a second run keeps what changed since", async () => {
		const old = oldArea(OLD, true);
		const kv = memoryKv();
		await expect(migrate(old, kv)).rejects.toThrow("gone");
		// Written, not removed: nothing lost.
		expect(kv.data.get("tab-mcp:secret:https://relay:tab-mcp-for-chrome")).toBe(
			"secret",
		);
		// The user turned AI access off meanwhile; the old value must not win.
		await kv.set({ aiOn: false });
		const again = oldArea(old.data);
		await migrate(again, kv);
		expect(kv.data.get("aiOn")).toBe(false);
		expect(again.data).toEqual({ somethingElse: 1 });
	});
});

describe("Always allow", () => {
	test("per AI app and tool, gone with the grant or the tool", () => {
		const always = new AlwaysAllowed();
		always.add("g1", "page_a");
		always.add("g2", "page_b");
		expect(always.has("g1", "page_a")).toBe(true);
		expect(always.has("g2", "page_a")).toBe(false);
		always.keepTools(["page_b"]);
		expect(always.has("g1", "page_a")).toBe(false);
		always.keepGrants(["g1"]);
		expect(always.has("g2", "page_b")).toBe(false);
	});
});

describe("the service worker's bundle", () => {
	test("has no dynamic import(), which a service worker refuses", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tab-mcp-ext-build-"));
		try {
			const { outdir } = await build({ outdir: join(dir, "dist"), test: true });
			const code = await Bun.file(join(outdir, "background.js")).text();
			expect(code).not.toMatch(/\bimport\s*\(/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
