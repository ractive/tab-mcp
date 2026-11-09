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
	type Answer,
	isContentEvent,
	isPanelSender,
	isQuestionSender,
	type PanelCommand,
	parseCommand,
	parseQuestionAnswer,
	startProblem,
} from "../src/protocol.ts";
import {
	attachWhenStarted,
	MAX_EARLY_MESSAGES,
	Starter,
} from "../src/starter.ts";
import { allowable, isAllowed, setAllowedMany } from "../src/worker/allowed.ts";
import { AlwaysAllowed, type AlwaysKey } from "../src/worker/always.ts";
import type { LookedUp } from "../src/worker/bridge.ts";
import { decide } from "../src/worker/decide.ts";
import { memoryKv } from "../src/worker/kv.ts";
import {
	type QuestionPort,
	QuestionWindows,
} from "../src/worker/question-windows.ts";
import {
	ARGS_CUT_NOTE,
	argsToSend,
	MAX_ARGS_NOTIFICATION,
	MAX_QUESTIONS_PER_APP,
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
	{
		type: "set-allowed-all",
		origin: "https://site.test",
		names: ["a", "b"],
		on: true,
	},
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

	test("a question window's port: this extension's question page, in a tab; it can only answer", () => {
		const page = `chrome-extension://${ID}/question/index.html`;
		expect(isQuestionSender({ id: ID, url: page, tab: { id: 9 } }, ID)).toBe(
			true,
		);
		// Not in a tab (the worker checks the tab's window is one it opened).
		expect(isQuestionSender({ id: ID, url: page }, ID)).toBe(false);
		expect(isQuestionSender({ id: ID, url: PANEL, tab: { id: 9 } }, ID)).toBe(
			false,
		);
		expect(isQuestionSender(contentScript, ID)).toBe(false);
		expect(
			isQuestionSender({ id: "other", url: page, tab: { id: 9 } }, ID),
		).toBe(false);
		for (const answer of ["allow", "always", "deny"] as const)
			expect(parseQuestionAnswer({ type: "answer", answer })).toBe(answer);
		for (const bad of [
			null,
			{ type: "answer", answer: "yes" },
			{ type: "answer", id: "q", answer: 1 },
			{ type: "connect" },
		])
			expect(parseQuestionAnswer(bad)).toBeUndefined();
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
			{ type: "set-allowed-all", origin: "o", names: "a", on: true },
			{ type: "set-allowed-all", origin: "o", names: [1], on: true },
			{
				type: "set-allowed-all",
				origin: "o",
				names: Array.from({ length: 65 }, (_, i) => `t${i}`),
				on: true,
			},
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
		showQuestions: Parameters<QuestionsHost["showQuestion"]>[0][];
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
		showQuestion: (where) => {
			host.showQuestions.push(where);
		},
		showQuestions: [],
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

	test("Don't allow is closing it", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		const answer = questions.ask(request(), { tabId: 7 });
		await settle();
		questions.notificationDismissed([...host.shown.keys()][0] as string);
		expect(await answer).toBe("deny");
	});

	test("a click on the body shows the whole question for its tab; it waits on there", async () => {
		const host = fakeHost();
		const questions = new Questions(host, 200);
		let settled: Answer | "timeout" | "busy" | undefined;
		const long = { text: "x".repeat(10_000) };
		const answer = questions.ask(request(long), {
			tabId: 7,
			origin: "https://site.test",
		});
		void answer.then((a) => {
			settled = a;
		});
		await settle();
		const [id] = [...host.shown.keys()] as [string];
		questions.notificationClicked(id);
		// At once (the user gesture), with the tab and its window.
		expect(host.showQuestions).toEqual([
			{ id: questions.list[0]?.id as string, tabId: 7, windowId: 3 },
		]);
		await settle();
		// The notification went; its closing now answers nothing.
		expect(host.shown.size).toBe(0);
		questions.notificationDismissed(id);
		questions.notificationClicked(id);
		await settle();
		expect(settled).toBeUndefined();
		expect(host.showQuestions).toHaveLength(1);
		// The arguments in full, for the panel or the question's window.
		expect(JSON.parse(questions.list[0]?.args as string)).toEqual(long);
		// The time limit still runs.
		expect(await answer).toBe("timeout");
		// A panel answer would have counted: see "an answer from a panel".
	});

	test("after the click, a panel closing hands the question to a new notification", async () => {
		const host = fakeHost({ panel: false });
		const questions = new Questions(host);
		const answer = questions.ask(request(), { tabId: 7 });
		await settle();
		questions.notificationClicked([...host.shown.keys()][0] as string);
		await settle();
		expect(host.shown.size).toBe(0);
		questions.panelClosed(3);
		expect(host.shown.size).toBe(1);
		questions.answer(questions.list[0]?.id as string, "allow");
		expect(await answer).toBe("allow");
	});

	test("arguments cut in a notification: it says so, Allow and Always allow stay", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		const answer = questions.ask(request({ text: "y".repeat(400) }), {
			tabId: 7,
			origin: "https://site.test",
		});
		await settle();
		const [[id, text]] = [...host.shown] as [[string, NotificationText]];
		expect(text.buttons).toEqual(["Allow", "Always allow"]);
		expect(text.message.endsWith(`\n${ARGS_CUT_NOTE}`)).toBe(true);
		expect(text.message.length).toBeLessThanOrEqual(300);
		expect(text.message).toContain("y".repeat(MAX_ARGS_NOTIFICATION - 20));
		questions.notificationDismissed(id);
		expect(await answer).toBe("deny");
		// Not cut: no note.
		const short = questions.ask(request(), { tabId: 7 });
		await settle();
		const [, shortText] = [...host.shown].at(-1) as [string, NotificationText];
		expect(shortText.message).not.toContain(ARGS_CUT_NOTE);
		questions.answer(questions.list[0]?.id as string, "deny");
		await short;
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
		expect(visible("pay\u202Eevil\u200B")).toBe("pay\\u202Eevil\\u200B");
		// As JSON writes them: a pair beyond U+FFFF.
		expect(visible("tag\u{E0041}")).toBe("tag\\uDB40\\uDC41");
		// Every space but the plain one, and the blank letters.
		expect(visible("a\u00A0b\u2007c\u3000d")).toBe("a\\u00A0b\\u2007c\\u3000d");
		expect(visible("\u2800\u3164\u115F\u1160\uFFA0")).toBe(
			"\\u2800\\u3164\\u115F\\u1160\\uFFA0",
		);
		// Default-ignorable, private-use, unassigned and C1 characters: the
		// client library's set.
		expect(
			visible("ok\uFE0F\uFE00\u034F\u{E0100}\u{E01EF}\uE000\u0378\u0085"),
		).toBe(
			"ok\\uFE0F\\uFE00\\u034F\\uDB40\\uDD00\\uDB40\\uDDEF\\uE000\\u0378\\u0085",
		);
		expect(visible("plain text, äöü 😀")).toBe("plain text, äöü 😀");
		// JSON's layout stays; a carriage return does not.
		expect(visible('{\n\t"a": 1\r}')).toBe('{\n\t"a": 1\\u000D}');
	});

	test("every character of the extension's own set before the client library's is still escaped", () => {
		// The old INVISIBLE: controls but tab and line feed, format characters,
		// line and paragraph separators, every space but U+0020, U+2800 and the
		// Hangul fillers.
		for (const code of [
			0x0000, 0x000d, 0x001f, 0x007f, 0x0085, 0x00ad, 0x200b, 0x202e, 0x2066,
			0xfeff, 0x2028, 0x2029, 0x00a0, 0x1680, 0x2000, 0x2007, 0x200a, 0x202f,
			0x205f, 0x3000, 0x2800, 0x3164, 0x115f, 0x1160, 0xffa0, 0xe0041,
		]) {
			const ch = String.fromCodePoint(code);
			const out = visible(`a${ch}b`);
			expect(out).not.toContain(ch);
			expect(out).toMatch(/^a(\\u[0-9A-F]{4})+b$/);
		}
	});

	test("an AI app has at most MAX_QUESTIONS_PER_APP waiting; more are busy, not asked", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		const asked = Array.from({ length: MAX_QUESTIONS_PER_APP }, (_, n) =>
			questions.ask(request({ n }), { tabId: 7 }),
		);
		await settle();
		expect(questions.list).toHaveLength(MAX_QUESTIONS_PER_APP);
		expect(await questions.ask(request({ n: 99 }), { tabId: 7 })).toBe("busy");
		expect(questions.list).toHaveLength(MAX_QUESTIONS_PER_APP);
		// Another AI app still asks.
		const other = questions.ask(
			{ ...request(), client: { ...request().client, grantId: "g2" } },
			{ tabId: 7 },
		);
		await settle();
		expect(questions.list).toHaveLength(MAX_QUESTIONS_PER_APP + 1);
		// One answered: room again.
		questions.answer(questions.list[0]?.id as string, "deny");
		await asked[0];
		const again = questions.ask(request({ n: 100 }), { tabId: 7 });
		await settle();
		expect(questions.list).toHaveLength(MAX_QUESTIONS_PER_APP + 1);
		for (const q of questions.list) questions.answer(q.id, "deny");
		await Promise.all([...asked, other, again]);
	});

	test("a panel gets each question's arguments once, before the state; not again", () => {
		const view = (id: string) => ({
			id,
			app: "Claude (claude.ai)",
			host: "claude.ai",
			tool: "page_x",
			args: `{"big": "${id.repeat(1000)}"}`,
			always: true,
		});
		const sent = new Set<string>();
		expect(argsToSend([view("a"), view("b")], sent).map((m) => m.id)).toEqual([
			"a",
			"b",
		]);
		expect(argsToSend([view("a"), view("b")], sent)).toEqual([]);
		// a settled, c came: only c; a forgotten.
		const next = argsToSend([view("b"), view("c")], sent);
		expect(next).toEqual([
			{ type: "question-args", id: "c", args: view("c").args },
		]);
		expect([...sent].sort()).toEqual(["b", "c"]);
	});

	test("a question's arguments: those characters escaped, still JSON for the same value", async () => {
		const host = fakeHost();
		const questions = new Questions(host);
		const args = { v: "a\uFE0Fb\u{E0100}c\u034Fd\uE000e\u0085" };
		const answer = questions.ask(request(args), { tabId: 7 });
		await settle();
		const shown = questions.list[0]?.args as string;
		expect(shown).not.toMatch(/[\uFE0F\u034F\uE000\u0085]|\u{E0100}/u);
		expect(JSON.parse(shown)).toEqual(args);
		const [, text] = [...host.shown][0] as [string, NotificationText];
		expect(text.message).toContain("\\uFE0F");
		questions.answer(questions.list[0]?.id as string, "deny");
		await answer;
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
	test("a write is all or nothing: a value that cannot be cloned stores none", async () => {
		const kv = memoryKv({ relay: "https://relay" });
		await expect(
			kv.set({ aiOn: true, allowedTools: {}, bad: () => {} }),
		).rejects.toThrow();
		expect(await kv.all()).toEqual({ relay: "https://relay" });
	});

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
});

describe("allowing all of a site's tools in one step", () => {
	test("one write for several names, only for an http(s) origin", async () => {
		const kv = memoryKv({ allowedTools: { "https://site.test": ["c"] } });
		expect(
			await setAllowedMany(kv, "https://site.test", ["a", "b"], true),
		).toEqual({ "https://site.test": ["a", "b", "c"] });
		expect(
			await setAllowedMany(kv, "https://site.test", ["a", "b", "c"], false),
		).toEqual({});
		expect(await setAllowedMany(kv, "null", ["a"], true)).toEqual({});
	});
});

describe("Always allow", () => {
	const key = (over: Partial<AlwaysKey> = {}): AlwaysKey => ({
		grantId: "g1",
		origin: "https://site.test",
		documentId: "doc-1",
		tool: "page_a",
		...over,
	});

	test("per AI app, origin, page and tool, gone with the grant or the tool", () => {
		const always = new AlwaysAllowed();
		always.add(key());
		always.add(key({ grantId: "g2", tool: "page_b" }));
		expect(always.has(key())).toBe(true);
		expect(always.has(key({ grantId: "g2" }))).toBe(false);
		// Another page (a reload, another tab), another site: not that answer.
		expect(always.has(key({ documentId: "doc-2" }))).toBe(false);
		expect(always.has(key({ origin: "https://other.test" }))).toBe(false);
		always.keepTools(["page_b"]);
		expect(always.has(key())).toBe(false);
		always.keepGrants(["g1"]);
		expect(always.has(key({ grantId: "g2", tool: "page_b" }))).toBe(false);
	});

	/** A decider whose bridge gives `first` until the test sets another tool. */
	function decider(first: LookedUp | undefined) {
		let current = first;
		const always = new AlwaysAllowed();
		const asked: unknown[] = [];
		let reply: Answer | "timeout" | "busy" = "always";
		let during = () => {};
		return {
			always,
			asked,
			set tool(tool: LookedUp | undefined) {
				current = tool;
			},
			set reply(answer: Answer | "timeout" | "busy") {
				reply = answer;
			},
			set during(run: () => void) {
				during = run;
			},
			d: {
				lookup: () => current,
				allowed: () => false,
				always,
				ask: async (_r: ConfirmRequest, where: unknown) => {
					asked.push(where);
					during();
					return reply;
				},
			},
		};
	}
	const page1: LookedUp = {
		tabId: 7,
		origin: "https://site.test",
		documentId: "doc-1",
		name: "place_order",
		readOnly: false,
	};

	test("kept for the page asked about, and checked the same way", async () => {
		const t = decider(page1);
		expect(await decide(t.d, request())).toBe(true);
		expect(t.asked).toHaveLength(1);
		// The next call on that page runs without asking.
		expect(await decide(t.d, request())).toBe(true);
		expect(t.asked).toHaveLength(1);
		// The same tool name on another page (a reload) asks again.
		t.tool = { ...page1, documentId: "doc-2" };
		t.reply = "allow";
		expect(await decide(t.d, request())).toBe(true);
		expect(t.asked).toHaveLength(2);
		// Another AI app asks too.
		t.tool = page1;
		expect(
			await decide(t.d, {
				...request(),
				client: { ...request().client, grantId: "g2" },
			}),
		).toBe(true);
		expect(t.asked).toHaveLength(3);
	});

	test("not kept when the page changed while the question was open", async () => {
		for (const changed of [
			{ ...page1, documentId: "doc-2" },
			{ ...page1, tabId: 8, documentId: "doc-3" },
			{ ...page1, origin: "https://other.test" },
			undefined,
		]) {
			const t = decider(page1);
			t.during = () => {
				t.tool = changed;
			};
			// The answer still counts for this call.
			expect(await decide(t.d, request())).toBe(true);
			// But no Always allow for whatever page came: back on the first, it asks.
			t.tool = page1;
			t.during = () => {};
			t.reply = "deny";
			expect(await decide(t.d, request())).toBe(false);
			if (changed !== undefined) {
				t.tool = changed;
				expect(await decide(t.d, request())).toBe(false);
			}
		}
	});

	test("never for an opaque origin; a timeout or too many waiting is an error", async () => {
		const t = decider({ ...page1, origin: "null" });
		expect(await decide(t.d, request())).toBe(true);
		t.reply = "deny";
		expect(await decide(t.d, request())).toBe(false);
		t.reply = "timeout";
		await expect(decide(t.d, request())).rejects.toThrow("did not answer");
		// Too many waiting already: not asked, said so.
		t.reply = "busy";
		await expect(decide(t.d, request())).rejects.toThrow("already wait");
	});
});

describe("the worker's start", () => {
	test("a start that failed is tried again by the next call, and its error kept", async () => {
		let attempts = 0;
		const starter = new Starter(async () => {
			attempts++;
			if (attempts < 3) throw new Error(`no database (${attempts})`);
			return "connection";
		});
		await expect(starter.ready()).rejects.toThrow("no database (1)");
		expect(starter.failed).toBe(true);
		expect(String(starter.error)).toContain("(1)");
		// Two calls at once share one start.
		const [a, b] = [starter.ready(), starter.ready()];
		expect(a).toBe(b);
		expect(starter.failed).toBe(false);
		await expect(a).rejects.toThrow("(2)");
		expect(await starter.ready()).toBe("connection");
		expect(starter.value).toBe("connection");
		expect(starter.failed).toBe(false);
		// Started: no further start.
		expect(await starter.ready()).toBe("connection");
		expect(attempts).toBe(3);
	});

	test("a start that throws at once counts as failed", async () => {
		const starter = new Starter<string>(() => {
			throw new Error("at once");
		});
		await expect(starter.ready()).rejects.toThrow("at once");
		expect(starter.failed).toBe(true);
	});

	/** A panel's port the test drives. */
	function fakePort() {
		const posted: unknown[] = [];
		let listener: ((m: unknown) => void) | undefined;
		let disconnect = () => {};
		return {
			posted,
			say(message: unknown) {
				listener?.(message);
			},
			close() {
				disconnect();
			},
			get listening() {
				return listener !== undefined;
			},
			port: {
				postMessage: (m: unknown) => void posted.push(m),
				onMessage: (l: (m: unknown) => void) => {
					listener = l;
					return () => {
						listener = undefined;
					};
				},
				onDisconnect: (l: () => void) => {
					disconnect = l;
				},
			},
		};
	}

	test("a panel that connected while the start failed is attached once another caller's start succeeds", async () => {
		let fail = true;
		const starter = new Starter(async () => {
			if (fail) throw new Error("no database");
			return "connection";
		});
		await starter.ready().catch(() => {});
		const panel = fakePort();
		const attached: [string, unknown[]][] = [];
		attachWhenStarted(
			starter,
			panel.port,
			(value, early) => attached.push([value, early]),
			(error) => ({ problem: String(error) }),
		);
		await settle();
		expect(panel.posted).toEqual([{ problem: "Error: no database" }]);
		panel.say({ type: "hello", windowId: 1 });
		await settle();
		expect(attached).toEqual([]);
		// Another event's retry succeeds: the panel is attached with what it said.
		fail = false;
		expect(await starter.ready()).toBe("connection");
		await settle();
		expect(attached).toEqual([
			["connection", [{ type: "hello", windowId: 1 }]],
		]);
		// Its port's messages go to the connection now, not into a queue.
		expect(panel.listening).toBe(false);
	});

	test("a panel's message retries a failed start; a panel attaches once; what it keeps is capped", async () => {
		let attempts = 0;
		const starter = new Starter(async () => {
			attempts++;
			if (attempts < 2) throw new Error("no database");
			return "connection";
		});
		const panel = fakePort();
		const attached: unknown[][] = [];
		attachWhenStarted(
			starter,
			panel.port,
			(_value, early) => attached.push(early),
			() => ({ problem: true }),
		);
		await settle();
		expect(attempts).toBe(1);
		// Hold the next start back with many messages at once: each tries
		// (sharing one start), at most MAX_EARLY_MESSAGES are kept.
		for (let i = 0; i < MAX_EARLY_MESSAGES + 10; i++)
			panel.say({ type: "visible", visible: i % 2 === 0 });
		await settle();
		expect(attempts).toBe(2);
		expect(attached).toHaveLength(1);
		expect(attached[0]).toHaveLength(MAX_EARLY_MESSAGES);
		// A panel gone before the start: never attached.
		const gone = fakePort();
		const starter2 = new Starter(async () => "connection");
		const late: unknown[] = [];
		const slow = new Starter(
			() =>
				new Promise<string>((resolve) => setTimeout(() => resolve("c"), 20)),
		);
		attachWhenStarted(
			slow,
			gone.port,
			(v) => late.push(v),
			() => ({}),
		);
		gone.close();
		await Bun.sleep(40);
		expect(late).toEqual([]);
		// Already started: attached at once.
		await starter2.ready();
		const now = fakePort();
		const at: unknown[] = [];
		attachWhenStarted(
			starter2,
			now.port,
			(v) => at.push(v),
			() => ({}),
		);
		expect(at).toEqual(["connection"]);
	});

	test("the panel's state for a failed start carries the problem and nothing to act on", () => {
		const state = startProblem(new Error("IndexedDB refused"));
		expect(state.problem).toContain("IndexedDB refused");
		expect(state).toMatchObject({
			status: "off",
			grants: [],
			questions: [],
			pairing: false,
		});
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

describe("a question's own window", () => {
	/** Windows, questions and ports the test drives. */
	function setup() {
		const waiting = new Map<string, QuestionViewLike>();
		const answers: [string, Answer][] = [];
		const removed: number[] = [];
		let nextWindow = 100;
		const windows = new QuestionWindows({
			create: async () => nextWindow++,
			remove: (windowId) => void removed.push(windowId),
			list: () => [...waiting.values()],
			answer: (id, answer) => {
				answers.push([id, answer]);
				waiting.delete(id);
			},
			parse: parseQuestionAnswer,
		});
		const port = (windowId: number | undefined) => {
			const posted: unknown[] = [];
			let listener: (m: unknown) => void = () => {};
			let gone = () => {};
			const p: QuestionPort & {
				posted: unknown[];
				say(m: unknown): void;
				disconnected: boolean;
			} = {
				windowId,
				posted,
				disconnected: false,
				postMessage: (m) => void posted.push(m),
				disconnect: () => {
					p.disconnected = true;
					gone();
				},
				onMessage: (l) => {
					listener = l;
				},
				onDisconnect: (l) => {
					gone = l;
				},
				say: (m) => listener(m),
			};
			return p;
		};
		const ask = (id: string) =>
			waiting.set(id, {
				id,
				app: "Claude (claude.ai)",
				host: "claude.ai",
				tool: "page_x",
				args: "{}",
				always: true,
			});
		return { windows, waiting, answers, removed, port, ask };
	}
	type QuestionViewLike = {
		id: string;
		app: string;
		host: string;
		tool: string;
		args: string;
		always: boolean;
	};

	test("a port from a window not opened for a question is disconnected and never heard", async () => {
		const t = setup();
		t.ask("q1");
		await t.windows.open("q1");
		const stranger = t.port(555);
		t.windows.addPort(stranger);
		expect(stranger.disconnected).toBe(true);
		stranger.say({ type: "answer", answer: "allow" });
		const none = t.port(undefined);
		t.windows.addPort(none);
		expect(none.disconnected).toBe(true);
		expect(t.answers).toEqual([]);
		expect(stranger.posted).toEqual([]);
	});

	test("a port answers only the question of its window, which it gets once", async () => {
		const t = setup();
		t.ask("q1");
		t.ask("q2");
		await t.windows.open("q1");
		await t.windows.open("q2");
		const p = t.port(100);
		t.windows.addPort(p);
		expect(p.posted).toEqual([
			{ type: "question", question: t.waiting.get("q1") },
		]);
		// Unchanged: not posted again.
		t.windows.sync();
		expect(p.posted).toHaveLength(1);
		// Garbage, or something that names another question, answers only q1 or nothing.
		p.say({ type: "answer", id: "q2", answer: "allow" });
		expect(t.answers).toEqual([["q1", "allow"]]);
		p.say({ type: "answer", answer: "maybe" });
		expect(t.answers).toHaveLength(1);
		// q1 settled: its window is told, closed, and answers nothing more.
		t.windows.sync();
		expect(p.posted.at(-1)).toEqual({ type: "question", question: undefined });
		expect(t.removed).toEqual([100]);
		p.say({ type: "answer", answer: "always" });
		t.windows.windowRemoved(100);
		expect(t.answers).toEqual([["q1", "allow"]]);
	});

	test("closing the window is Don't allow, once", async () => {
		const t = setup();
		t.ask("q1");
		await t.windows.open("q1");
		const p = t.port(100);
		t.windows.addPort(p);
		t.windows.windowRemoved(100);
		t.windows.windowRemoved(100);
		expect(t.answers).toEqual([["q1", "deny"]]);
		expect(p.disconnected).toBe(true);
		p.say({ type: "answer", answer: "allow" });
		expect(t.answers).toEqual([["q1", "deny"]]);
	});

	test("a question settled while its window opened closes the window at once", async () => {
		const t = setup();
		t.ask("q1");
		const opening = t.windows.open("q1");
		t.waiting.delete("q1");
		await opening;
		expect(t.removed).toEqual([100]);
		const p = t.port(100);
		t.windows.addPort(p);
		expect(p.disconnected).toBe(true);
		// No window for a question that is not waiting.
		await t.windows.open("gone");
		expect(t.removed).toEqual([100]);
	});
});
