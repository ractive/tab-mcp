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
	type PanelState,
	parseCommand,
	type QuestionView,
} from "../src/protocol.ts";
import {
	type FillPermissions,
	fillPanel,
	fillView,
	NO_PATTERN,
	NOT_ASKED,
} from "../src/sidepanel/fill.ts";
import {
	expiredText,
	questionAnnouncement,
	questionCard,
} from "../src/sidepanel/question.ts";
import {
	BUSY,
	type Contains,
	codeWithPairingOn,
	FillSetting,
	failureText,
	HOLD_MS,
	NO_CODE,
	type ScriptApi,
	syncPairingScript,
} from "../src/worker/fill.ts";
import { memoryKv } from "../src/worker/kv.ts";
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
		expect(parseCommand({ type: "set-fill", on: true, id: "a" })).toEqual({
			type: "set-fill",
			on: true,
			id: "a",
		});
		expect(
			parseCommand({ type: "set-fill", on: "yes", id: "a" }),
		).toBeUndefined();
		expect(parseCommand({ type: "set-fill", on: true })).toBeUndefined();
	});
});

/**
 * The browser's permissions as the panel uses them: `request` waits until
 * the test answers it; `granted` is the relay's site, events by hand.
 */
function panelPermissions() {
	const removed: (() => void)[] = [];
	const requests: { resolve(given: boolean): void; reject(): void }[] = [];
	const api = {
		granted: false,
		contains: async () => api.granted,
		request: () =>
			new Promise<boolean>((resolve, reject) =>
				requests.push({
					resolve: (given) => {
						if (given) api.granted = true;
						resolve(given);
					},
					reject: () => reject(new Error("no prompt")),
				}),
			),
		onAdded: { addListener: () => {} },
		onRemoved: { addListener: (f: () => void) => removed.push(f) },
		/** The site taken away (by the worker or in the browser's settings). */
		remove() {
			api.granted = false;
			for (const f of removed) f();
		},
		requests,
	};
	return api;
}

/** The panel's fill box on happy-dom, with the browser and the worker faked. */
function panel(granted: boolean) {
	const window = new Window();
	windows.push(window);
	const document = window.document as unknown as Document;
	document.body.innerHTML = `<div id="fill" hidden><label id="fill-label" hidden><input id="fill-switch" type="checkbox" role="switch" aria-checked="false"><span>Fill in the code for me</span></label><p id="fill-text"></p></div>`;
	const $ = (id: string) => document.getElementById(id) as HTMLElement;
	const toggle = $("fill-switch") as HTMLInputElement;
	const permissions = panelPermissions();
	permissions.granted = granted;
	const sent: { on: boolean; id: string }[] = [];
	const problems: string[] = [];
	const fill = fillPanel(
		{ box: $("fill"), text: $("fill-text"), label: $("fill-label"), toggle },
		(on, id) => sent.push({ on, id }),
		(text) => problems.push(text),
		permissions as unknown as FillPermissions,
	);
	const state = (
		fillCode: boolean,
		extra: Partial<PanelState> = {},
	): PanelState => ({
		status: "on",
		relay: RELAY,
		pairing: true,
		grants: [],
		allSites: false,
		questions: [],
		expired: [],
		fillCode,
		...extra,
	});
	return {
		fill,
		permissions,
		sent,
		problems,
		state,
		/** The worker's answer to the `n`th command sent. */
		answer: (n: number) => ({ fillAnswered: sent[n]?.id ?? "" }),
		/** A real click: the box toggles, then the handler runs. */
		click: () => toggle.click(),
		shown: () => ({
			checked: toggle.checked,
			aria: toggle.getAttribute("aria-checked"),
			text: $("fill-text").textContent ?? "",
		}),
	};
}

describe("the panel's switch against the worker's own permission changes", () => {
	const host = new URL(RELAY).host;
	const why = `tab-mcp no longer has access to ${host}, so this went off.`;

	test("turning on: Chrome asks, Allow sends on; the switch stays on until the worker answers", async () => {
		const p = panel(false);
		p.fill.show(p.state(false));
		await settle();
		expect(p.shown()).toMatchObject({ checked: false, aria: "false" });
		p.click();
		expect(p.permissions.requests.length).toBe(1);
		p.permissions.requests[0]?.resolve(true);
		await settle();
		expect(p.sent.map((s) => s.on)).toEqual([true]);
		expect(p.shown()).toMatchObject({ checked: true, aria: "true" });
		// A state from something else (a tab) does not answer the click.
		p.fill.show(p.state(false, { allSites: true }));
		await settle();
		expect(p.shown()).toMatchObject({ checked: true, aria: "true" });
		p.fill.show(p.state(true, p.answer(0)));
		await settle();
		expect(p.shown()).toMatchObject({ checked: true, aria: "true" });
		expect(p.shown().text).not.toContain("no longer");
	});

	test("declined or not asked: back to off, the problem text when it could not ask", async () => {
		const p = panel(false);
		p.fill.show(p.state(false));
		await settle();
		p.click();
		p.permissions.requests[0]?.resolve(false);
		await settle();
		expect(p.shown()).toMatchObject({ checked: false, aria: "false" });
		p.click();
		p.permissions.requests[1]?.reject();
		await settle();
		expect(p.shown()).toMatchObject({ checked: false, aria: "false" });
		expect(p.problems).toEqual([NOT_ASKED]);
		expect(p.sent).toEqual([]);
	});

	test("turning off: the site given back before the worker's state says no 'no longer has access'", async () => {
		const p = panel(true);
		p.fill.show(p.state(true));
		await settle();
		expect(p.shown()).toMatchObject({ checked: true });
		p.click();
		expect(p.sent.map((s) => s.on)).toEqual([false]);
		// The worker gives the site back: onRemoved reaches the panel first.
		p.permissions.remove();
		await settle();
		expect(p.shown().checked).toBe(false);
		expect(p.shown().text).not.toContain(why);
		p.fill.show(p.state(false, p.answer(0)));
		await settle();
		expect(p.shown().checked).toBe(false);
		expect(p.shown().text).not.toContain(why);
	});

	test("Allow after the user turned it off again: not turned on, the site goes back", async () => {
		const p = panel(false);
		p.fill.show(p.state(false));
		await settle();
		p.click(); // on: Firefox's prompt does not block the sidebar
		p.click(); // off again while it asks
		expect(p.sent.map((s) => s.on)).toEqual([false]);
		p.fill.show(p.state(false, p.answer(0)));
		await settle();
		p.permissions.requests[0]?.resolve(true);
		await settle();
		// No "on"; an "off" so that the worker gives the site back.
		expect(p.sent.map((s) => s.on)).toEqual([false, false]);
		expect(p.shown().checked).toBe(false);
	});

	test("off and straight back on: the worker's answer decides, without a wrong reason", async () => {
		const p = panel(true);
		p.fill.show(p.state(true));
		await settle();
		p.click(); // off
		p.click(); // on: the site is still there, Chrome answers at once
		p.permissions.requests[0]?.resolve(true);
		await settle();
		expect(p.sent.map((s) => s.on)).toEqual([false, true]);
		// The worker handles "off" (gives the site back), then "on", finds
		// the site gone and stays off without the note (FillSetting.turnOn).
		p.permissions.remove();
		p.fill.show(p.state(false, p.answer(0)));
		await settle();
		// The answer to "off" is not the answer to the last click.
		expect(p.shown().checked).toBe(true);
		expect(p.shown().text).not.toContain(why);
		p.fill.show(p.state(false, p.answer(1)));
		await settle();
		expect(p.shown()).toMatchObject({ checked: false, aria: "false" });
		expect(p.shown().text).not.toContain(why);
		expect(p.shown().text).toContain("Chrome asks you for access");
	});

	test("the site taken away in the browser's settings: off, and why", async () => {
		const p = panel(true);
		p.fill.show(p.state(true));
		await settle();
		p.permissions.remove();
		await settle();
		expect(p.shown().checked).toBe(false);
		expect(p.shown().text).toStartWith(why);
		p.fill.show(p.state(false, { fillLost: true }));
		await settle();
		expect(p.shown().checked).toBe(false);
		expect(p.shown().text).toStartWith(why);
	});
});

describe("the setting in the worker (DEC-210)", () => {
	const site = fillAccess(RELAY)?.origins?.[0] ?? "";
	const setup = (granted: boolean, initial: Record<string, unknown> = {}) => {
		const kv = memoryKv(initial);
		const sites = new Set<string>(granted ? [site] : []);
		const contains: Contains = async (p) =>
			(p.origins ?? []).every((o) => sites.has(o));
		return { kv, sites, load: () => FillSetting.load(kv, contains) };
	};

	test("the site taken away: off with the note, kept in storage, and not back when the site returns", async () => {
		const s = setup(true);
		const fill = await s.load();
		expect(await fill.turnOn(RELAY)).toBe(true);
		expect(fill.on(RELAY)).toBe(true);
		expect(await fill.check(RELAY)).toBe(false);
		s.sites.delete(site);
		expect(await fill.check(RELAY)).toBe(true);
		expect(fill.on(RELAY)).toBe(false);
		expect(fill.lost(RELAY)).toBe(true);
		// A new worker reads the same.
		const again = await s.load();
		expect(again.on(RELAY)).toBe(false);
		expect(again.lost(RELAY)).toBe(true);
		// The site back (access to all sites, say): still off.
		s.sites.add(site);
		expect(await again.check(RELAY)).toBe(false);
		expect(again.on(RELAY)).toBe(false);
		expect((await s.load()).on(RELAY)).toBe(false);
	});

	test("the note goes when the switch is turned on or off, or with another relay", async () => {
		const s = setup(true, { fillCodeLost: RELAY });
		let fill = await s.load();
		expect(fill.lost(RELAY)).toBe(true);
		await fill.turnOn(RELAY);
		expect(fill.lost(RELAY)).toBe(false);
		expect(s.kv.data.has("fillCodeLost")).toBe(false);
		await s.kv.set({ fillCodeLost: RELAY });
		fill = await s.load();
		await fill.turnOff();
		expect(fill.lost(RELAY)).toBe(false);
		expect(fill.on(RELAY)).toBe(false);
		expect(s.kv.data.has("fillCodeFor")).toBe(false);
		await s.kv.set({ fillCodeLost: RELAY, fillCodeFor: RELAY });
		fill = await s.load();
		expect(await fill.reset()).toBe(RELAY);
		expect(fill.lost(RELAY)).toBe(false);
		expect(fill.on(RELAY)).toBe(false);
		expect(s.kv.data.has("fillCodeLost")).toBe(false);
		expect(s.kv.data.has("fillCodeFor")).toBe(false);
	});

	test("on after the worker gave the site back for an off just before: stays off, without the note", async () => {
		const s = setup(false);
		const fill = await s.load();
		expect(await fill.turnOn(RELAY)).toBe(false);
		expect(fill.on(RELAY)).toBe(false);
		expect(fill.lost(RELAY)).toBe(false);
		expect(s.kv.data.has("fillCodeFor")).toBe(false);
	});

	test("only the relay in use; another relay's setting is not checked", async () => {
		const s = setup(false, { fillCodeFor: "https://other.example" });
		const fill = await s.load();
		expect(fill.on(RELAY)).toBe(false);
		expect(await fill.check(RELAY)).toBe(false);
		expect(fill.on("https://other.example")).toBe(true);
	});

	test("a relay address without a pattern that is somehow on: off with the note", async () => {
		const relay = "http://[::1]:8787";
		const s = setup(false, { fillCodeFor: relay });
		const fill = await s.load();
		expect(await fill.check(relay)).toBe(true);
		expect(fill.on(relay)).toBe(false);
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
