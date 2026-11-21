/**
 * Filling in the code on the relay's pairing page (DEC-203), this
 * extension's parts of it: the permission it asks for, the question, the
 * content script's registration, the panel's line and texts. The rules,
 * the page's side and the messages are the library's, tested there
 * (`@ractive-ch/tab-mcp-client/extension`, DEC-206).
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { PairingCode } from "@ractive-ch/tab-mcp-client";
import { Window } from "happy-dom";
import { fillAccess, pairingMatches } from "../src/fill.ts";
import {
	type Answer,
	parseCommand,
	type QuestionView,
} from "../src/protocol.ts";
import { fillView, NO_PATTERN } from "../src/sidepanel/fill.ts";
import {
	expiredText,
	questionAnnouncement,
	questionCard,
} from "../src/sidepanel/question.ts";
import {
	BUSY,
	codeWithPairingOn,
	failureText,
	HOLD_MS,
	NO_CODE,
	type ScriptApi,
	syncPairingScript,
} from "../src/worker/fill.ts";
import {
	NOTIFICATION_GUARD_MS,
	type NotificationText,
	Questions,
	type QuestionsHost,
} from "../src/worker/questions.ts";

const RELAY = "https://relay.example";

const settle = () => Bun.sleep(5);

const windows: Window[] = [];
afterEach(async () => {
	for (const window of windows.splice(0)) await window.happyDOM.close();
});

describe("what the extension asks for", () => {
	test("access to the relay's site; the script registered for /authorize only, without a port", () => {
		expect(fillAccess("https://tab-mcp.ractive.ch")).toEqual({
			origins: ["https://tab-mcp.ractive.ch/*"],
		});
		// Firefox's patterns take no port; the exact origin is checked in code.
		expect(fillAccess("http://127.0.0.1:8787")).toEqual({
			origins: ["http://127.0.0.1/*"],
		});
		expect(pairingMatches("wss://relay.example:8443")).toEqual([
			"https://relay.example/authorize*",
		]);
		// No pattern for the address: nothing to ask for, nowhere to register.
		expect(fillAccess("http://[::1]:8787")).toBeUndefined();
		expect(pairingMatches("nope")).toEqual([]);
	});

	test("what the panel says when a page filled in nothing; pairing is held for the check", () => {
		expect(failureText("busy")).toBe(BUSY);
		expect(failureText("no-code")).toBe(NO_CODE);
		expect(HOLD_MS).toBe(30_000);
	});

	test("the code with pairing on already: the relay's answer to starting it again is the code about to change, so the next one is filled in", async () => {
		const now = Date.UTC(2026, 10, 21, 12);
		let code: PairingCode | undefined = {
			code: "AAAA-AAAA",
			expiresAt: new Date(now + 2_000).toISOString(),
		};
		const target = new EventTarget();
		let starts = 0;
		const mcp = {
			get pairingCode() {
				return code;
			},
			addEventListener: target.addEventListener.bind(target),
			removeEventListener: target.removeEventListener.bind(target),
			// As the relay answers `pairing.start` with pairing on: the code
			// it shows, sent again, after the call returns.
			startPairing: () => {
				starts++;
				setTimeout(() => target.dispatchEvent(new Event("pairingcode")), 1);
			},
		} as unknown as Parameters<typeof codeWithPairingOn>[0];
		let settled = false;
		const taken = codeWithPairingOn(
			mcp,
			new AbortController().signal,
			now,
		).finally(() => {
			settled = true;
		});
		await settle();
		expect(starts).toBe(1);
		expect(settled).toBe(false);
		code = {
			code: "CCCC-CCCC",
			expiresAt: new Date(now + 120_000).toISOString(),
		};
		target.dispatchEvent(new Event("pairingcode"));
		expect(await taken).toBe("CCCC-CCCC");
	});
});

/** A questions host with no panel: every question is a notification. */
function questionsHost() {
	let now = 1_000_000;
	const shown = new Map<string, NotificationText>();
	const host: QuestionsHost & {
		shown: typeof shown;
		advance(ms: number): void;
	} = {
		shown,
		advance: (ms) => {
			now += ms;
		},
		windowOf: async () => 3,
		panelInFocus: async () => false,
		notify: async (id, text) => {
			shown.set(id, text);
		},
		clear: (id) => {
			shown.delete(id);
		},
		showQuestion: async () => true,
		changed: () => {},
		now: () => now,
	};
	return host;
}

describe("the question", () => {
	test("Connect <name> (<host>)?, the verified host whole; Allow, never for good", async () => {
		const host = questionsHost();
		const questions = new Questions(host);
		const answer = questions.askPairing(
			{ tabId: 4 },
			{ name: "Claude", host: "claude.ai" },
			new AbortController().signal,
		);
		await settle();
		const [view] = questions.list;
		expect(view).toMatchObject({
			app: "Claude (claude.ai)",
			host: "claude.ai",
			pairing: { name: "Claude" },
			site: false,
		});
		const [[id, text]] = [...host.shown] as [[string, NotificationText]];
		expect(text).toEqual({
			title: "Connect an AI app?",
			message:
				"Connect Claude (claude.ai) to the tab-mcp browser extension? Allow fills in the code on the sign-in page.",
			contextMessage: "AI app at claude.ai · Closing this is Don't allow",
			buttons: ["Allow"],
		});
		host.advance(NOTIFICATION_GUARD_MS);
		questions.notificationButton(id, 0);
		expect(await answer).toBe("allow");
	});

	test("a name the AI app gave itself shows invisible characters escaped; withdrawn is Don't allow", async () => {
		const questions = new Questions(questionsHost());
		const withdraw = new AbortController();
		const answer = questions.askPairing(
			{ tabId: 4 },
			{ name: "Claude‮", host: "evil.example" },
			withdraw.signal,
		);
		await settle();
		expect(questions.list[0]?.app).toBe("Claude\\u202E (evil.example)");
		withdraw.abort();
		expect(await answer).toBe("deny");
		expect(questions.list).toEqual([]);
	});

	test("nobody answering is a timeout", async () => {
		const questions = new Questions(questionsHost(), 20);
		const answer = questions.askPairing(
			{ tabId: 4 },
			{ name: "", host: "claude.ai" },
			new AbortController().signal,
		);
		expect(await answer).toBe("timeout");
	});
});

describe("the panel", () => {
	const view: QuestionView = {
		id: "q1",
		app: "Claude (claude.ai)",
		host: "claude.ai",
		tool: "",
		pairing: { name: "Claude" },
		args: "",
		site: false,
		expiresAt: 2_000_000,
	};

	test("the card: the verified host on a line of its own, the name apart, Don't allow and Allow", () => {
		const window = new Window();
		windows.push(window);
		const saved = globalThis.document;
		globalThis.document = window.document as unknown as Document;
		try {
			const answers: Answer[] = [];
			const card = questionCard(view, (a) => answers.push(a), 1_990_000);
			const lines = [...card.querySelectorAll("p")].map((p) => p.textContent);
			expect(lines).toContain(
				"Connect Claude (claude.ai) to the tab-mcp browser extension?",
			);
			expect(card.querySelector(".app-host")?.textContent).toBe(
				"AI app at (verified) claude.ai",
			);
			expect(lines).toContain("Its name (from the AI app) Claude");
			expect(card.querySelector("pre")).toBeNull();
			expect(
				[...card.querySelectorAll("button")].map((b) => b.textContent),
			).toEqual(["Don't allow", "Allow"]);
		} finally {
			globalThis.document = saved;
		}
		expect(questionAnnouncement(view)).toBe(
			"Claude (claude.ai) asks to connect.",
		);
		expect(expiredText(view)).toBe(
			"Not answered in time: the code was not filled in.",
		);
	});

	test("Fill in the code for me: a switch that shows what is in effect, what it does in one line", () => {
		const relay = "https://tab-mcp.ractive.ch";
		const does =
			"While this is on, tab-mcp asks you and fills in the code when an AI app opens the sign-in page of tab-mcp.ractive.ch in this Chrome profile.";
		const asks = "Chrome asks you for access to that site when you turn it on.";
		const gone =
			"tab-mcp no longer has access to tab-mcp.ractive.ch, so this went off.";
		// Off, the site not granted: Chrome asks when it is turned on.
		expect(fillView(relay, false, false, false)).toEqual({
			text: `${does} ${asks}`,
			shown: true,
			checked: false,
		});
		// The site granted already (access to all sites): still off until
		// turned on, and Chrome asks nothing.
		expect(fillView(relay, false, true, false)).toEqual({
			text: does,
			shown: true,
			checked: false,
		});
		expect(fillView(relay, true, true, false)).toEqual({
			text: does,
			shown: true,
			checked: true,
		});
		// The site taken away in the browser's settings: off, and why. The
		// worker turns the setting off (lost); until it has, the same.
		const lost = {
			text: `${gone} ${does} ${asks}`,
			shown: true,
			checked: false,
		};
		expect(fillView(relay, false, false, true)).toEqual(lost);
		expect(fillView(relay, true, false, false)).toEqual(lost);
		// It went off, and the site came back (access to all sites): just off.
		expect(fillView(relay, false, true, true)).toEqual({
			text: does,
			shown: true,
			checked: false,
		});
		// No pattern for the address: one plain sentence, no switch, unless
		// the setting is on there, to turn it off.
		expect(fillView("http://[::1]:8787", false, false, false)).toEqual({
			text: NO_PATTERN,
			shown: false,
			checked: false,
		});
		expect(fillView("http://[::1]:8787", true, false, false)).toEqual({
			text: NO_PATTERN,
			shown: true,
			checked: true,
		});
		expect(parseCommand({ type: "set-fill", on: true })).toEqual({
			type: "set-fill",
			on: true,
		});
		expect(parseCommand({ type: "set-fill", on: "yes" })).toBeUndefined();
	});
});

/** The browser's scripting, permissions and tabs, as the registration uses them. */
function scriptApi(granted: Set<string>, openTabs: number[] = []) {
	const registered = new Map<
		string,
		chrome.scripting.RegisteredContentScript
	>();
	const injected: number[] = [];
	const api = {
		registered,
		injected,
		permissions: {
			contains: async (p: chrome.permissions.Permissions) =>
				(p.origins ?? []).every((o) => granted.has(o)),
		},
		scripting: {
			getRegisteredContentScripts: async (filter?: { ids?: string[] }) =>
				[...registered.values()].filter(
					(s) => filter?.ids === undefined || filter.ids.includes(s.id),
				),
			registerContentScripts: async (
				scripts: chrome.scripting.RegisteredContentScript[],
			) => {
				for (const s of scripts) registered.set(s.id, s);
			},
			unregisterContentScripts: async (filter?: { ids?: string[] }) => {
				for (const id of filter?.ids ?? []) registered.delete(id);
			},
			executeScript: async (injection: { target: { tabId: number } }) => {
				injected.push(injection.target.tabId);
				return [];
			},
		},
		tabs: {
			query: async () => openTabs.map((id) => ({ id })),
		},
	};
	return api as typeof api & ScriptApi;
}

describe("the pairing page's script", () => {
	test("not turned on: never registered, also with the relay's site granted", async () => {
		const api = scriptApi(new Set(["https://relay.example/*"]), [9]);
		await syncPairingScript(RELAY, false, api);
		expect(api.registered.size).toBe(0);
		expect(api.injected).toEqual([]);
		await syncPairingScript(RELAY, true, api);
		expect(api.registered.size).toBe(1);
		// Turned off: unregistered.
		await syncPairingScript(RELAY, false, api);
		expect(api.registered.size).toBe(0);
	});

	test("registered only with access to the relay's site, for its /authorize; put into a page open already", async () => {
		const granted = new Set<string>();
		const api = scriptApi(granted, [9]);
		await syncPairingScript(RELAY, true, api);
		expect(api.registered.size).toBe(0);
		granted.add("https://relay.example/*");
		await syncPairingScript(RELAY, true, api);
		expect([...api.registered.values()]).toEqual([
			{
				id: "tab-mcp-pairing-page",
				js: ["pairing.js"],
				matches: ["https://relay.example/authorize*"],
				runAt: "document_idle",
			},
		]);
		expect(api.injected).toEqual([9]);
		// Once registered, not again.
		await syncPairingScript(RELAY, true, api);
		expect(api.injected).toEqual([9]);
		// Another relay: its own registration, or none without its access.
		await syncPairingScript("https://other.example", true, api);
		expect(api.registered.size).toBe(0);
		granted.add("https://other.example/*");
		await syncPairingScript("https://other.example", true, api);
		expect(api.registered.get("tab-mcp-pairing-page")?.matches).toEqual([
			"https://other.example/authorize*",
		]);
		granted.clear();
		await syncPairingScript("https://other.example", true, api);
		expect(api.registered.size).toBe(0);
	});
});
