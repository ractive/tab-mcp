/**
 * Filling in the code on the relay's pairing page (DEC-203): which page is
 * one, who may speak for it, the question, what is filled in when, the
 * content script's registration and the panel's line for it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	fillAccess,
	isPairingSender,
	type PageSender,
	pairingMatches,
	parseFill,
	parseHello,
	relayPageOrigin,
} from "../src/fill.ts";
import { fillIn, findPairingForm, helloFor } from "../src/pairing-page.ts";
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
	CodeFiller,
	type CodeSource,
	type FillHost,
	HOLD_MS,
	NO_CODE,
	type PagePort,
	RETRY_WINDOW_MS,
	type ScriptApi,
	syncPairingScript,
	takeCode,
} from "../src/worker/fill.ts";
import {
	NOTIFICATION_GUARD_MS,
	type NotificationText,
	Questions,
	type QuestionsHost,
} from "../src/worker/questions.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const RELAY = "https://relay.example";
const PAGE = `${RELAY}/authorize?response_type=code&client_id=x`;
const NONCE = "0123456789abcdef0123";
/** The relay's id of the request (`randomBase64url(24)` there). */
const REQUEST = "Zm9vYmFyYmF6cXV4cXV1eHh5enp6";

const settle = () => Bun.sleep(5);

/** The relay's form, as `#pairingPage` writes it (DEC-199's hooks). */
function relayForm(
	options: {
		app?: string;
		field?: boolean;
		forms?: number;
		request?: boolean;
	} = {},
): string {
	const form = `<form method="post" action="/authorize" data-tab-mcp-pairing="1" data-app="${options.app ?? "tab-mcp-extension"}" data-client-name="Claude" data-client-host="claude.ai">
${options.request === false ? "" : `<input type="hidden" name="request_id" value="${REQUEST}">`}
${options.field === false ? "" : '<input id="code" name="code" type="text" data-tab-mcp-field="code" required>'}
<button type="submit" name="action" value="connect" data-tab-mcp-action="connect">Connect</button>
<button type="submit" name="action" value="cancel" formnovalidate>Cancel</button>
</form>`;
	return form.repeat(options.forms ?? 1);
}

const windows: Window[] = [];
afterEach(async () => {
	for (const window of windows.splice(0)) await window.happyDOM.close();
});

function page(html: string): Document {
	const window = new Window({ url: PAGE });
	windows.push(window);
	window.document.body.innerHTML = html;
	return window.document as unknown as Document;
}

describe("where the relay's pairing page is", () => {
	test("the relay's pages are at its http(s) origin, also for a ws(s) address", () => {
		expect(relayPageOrigin("https://relay.example")).toBe(RELAY);
		expect(relayPageOrigin("wss://relay.example/")).toBe(RELAY);
		expect(relayPageOrigin("ws://127.0.0.1:8787")).toBe(
			"http://127.0.0.1:8787",
		);
		expect(relayPageOrigin("https://relay.example:8443/x")).toBe(
			"https://relay.example:8443",
		);
		expect(relayPageOrigin("ftp://relay.example")).toBeUndefined();
		expect(relayPageOrigin("not an address")).toBeUndefined();
	});

	test("access is asked for the relay's site; the script is registered for /authorize only, without a port", () => {
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
		expect(fillAccess("nope")).toBeUndefined();
		expect(pairingMatches("nope")).toEqual([]);
	});

	test("the pattern's host is normalised; one that gives no pattern gives none", () => {
		// Lower case already from the URL parser; the trailing dot goes.
		expect(fillAccess("https://Relay.Example.:8443/")).toEqual({
			origins: ["https://relay.example/*"],
		});
		// An IPv6 literal: the browsers do not agree on a pattern for it.
		expect(fillAccess("http://[::1]:8787")).toBeUndefined();
		expect(pairingMatches("http://[::1]:8787")).toEqual([]);
	});
});

describe("who may speak for the pairing page", () => {
	const ok: PageSender = {
		id: ID,
		url: PAGE,
		origin: RELAY,
		tab: { id: 4 },
		frameId: 0,
	};

	test("only this extension's script, in a tab's top frame, at exactly the relay's origin and /authorize", () => {
		expect(isPairingSender(ok, ID, RELAY)).toBe(true);
		// Firefox gives no `origin`: the address decides.
		const { origin: _, ...firefox } = ok;
		expect(isPairingSender(firefox, ID, RELAY)).toBe(true);
		// A look-alike: the same markup on another site, another port, http.
		for (const url of [
			"https://relay.example.evil.test/authorize",
			"https://relay.example:444/authorize",
			"http://relay.example/authorize",
		])
			expect(
				isPairingSender({ ...ok, url, origin: new URL(url).origin }, ID, RELAY),
			).toBe(false);
		// A frame, no tab, another extension, another path, no relay.
		expect(isPairingSender({ ...ok, frameId: 3 }, ID, RELAY)).toBe(false);
		const { tab: _t, ...noTab } = ok;
		expect(isPairingSender(noTab, ID, RELAY)).toBe(false);
		expect(isPairingSender({ ...ok, id: "other" }, ID, RELAY)).toBe(false);
		expect(
			isPairingSender({ ...ok, url: `${RELAY}/authorize/x` }, ID, RELAY),
		).toBe(false);
		expect(isPairingSender({ ...ok, url: `${RELAY}/` }, ID, RELAY)).toBe(false);
		expect(isPairingSender(ok, ID, undefined)).toBe(false);
		// The document's origin, where given, wins over the address.
		expect(
			isPairingSender({ ...ok, origin: "https://other.example" }, ID, RELAY),
		).toBe(false);
	});

	test("the hello carries the form's three attributes, its request id and a nonce, nothing else", () => {
		const hello = {
			type: "pairing-page",
			nonce: NONCE,
			app: "tab-mcp-extension",
			clientName: "Claude",
			clientHost: "claude.ai",
			requestId: REQUEST,
		};
		expect(parseHello({ ...hello, extra: "x" })).toEqual(
			hello as ReturnType<typeof parseHello>,
		);
		for (const bad of [
			null,
			{ ...hello, type: "fill" },
			{ ...hello, nonce: "short" },
			{ ...hello, clientHost: "" },
			{ ...hello, clientName: 1 },
			{ ...hello, clientName: "x".repeat(201) },
			{ ...hello, app: undefined },
			{ ...hello, requestId: undefined },
			{ ...hello, requestId: "" },
			{ ...hello, requestId: "a b" },
		])
			expect(parseHello(bad)).toBeUndefined();
		expect(
			parseFill({ type: "fill", nonce: NONCE, code: "ABCD-EFGH" }, NONCE),
		).toEqual({ type: "fill", nonce: NONCE, code: "ABCD-EFGH" });
		// Another page load's nonce, or no code: nothing.
		expect(
			parseFill({ type: "fill", nonce: "x", code: "ABCD-EFGH" }, NONCE),
		).toBeUndefined();
		expect(
			parseFill({ type: "fill", nonce: NONCE, code: "" }, NONCE),
		).toBeUndefined();
	});
});

describe("the content script on the page", () => {
	const top = { topLevel: true, pathname: "/authorize" };

	test("finds its own app's form with a code field, at the top, at /authorize", () => {
		const found = findPairingForm(page(relayForm()), top);
		expect(found).toBeDefined();
		expect(found && helloFor(found, NONCE)).toEqual({
			type: "pairing-page",
			nonce: NONCE,
			app: "tab-mcp-extension",
			clientName: "Claude",
			clientHost: "claude.ai",
			requestId: REQUEST,
		});
		// Another app's form, a page that pairs by sign-in only (no code
		// field), one without the relay's request id, a frame, another path,
		// two forms: nothing.
		expect(
			findPairingForm(page(relayForm({ app: "sitegloss" })), top),
		).toBeUndefined();
		expect(
			findPairingForm(page(relayForm({ field: false })), top),
		).toBeUndefined();
		expect(
			findPairingForm(page(relayForm({ request: false })), top),
		).toBeUndefined();
		expect(
			findPairingForm(page(relayForm()), { ...top, topLevel: false }),
		).toBeUndefined();
		expect(
			findPairingForm(page(relayForm()), { ...top, pathname: "/" }),
		).toBeUndefined();
		expect(findPairingForm(page(relayForm({ forms: 2 })), top)).toBeUndefined();
	});

	test("the code goes into the field and the form is submitted with Connect", () => {
		const doc = page(relayForm());
		const found = findPairingForm(doc, {
			topLevel: true,
			pathname: "/authorize",
		});
		if (found === undefined) throw new Error("no form");
		const submitted: Record<string, string>[] = [];
		found.form.addEventListener("submit", (event) => {
			event.preventDefault();
			const submitter = (event as SubmitEvent).submitter;
			submitted.push({
				code: found.field.value,
				action: (submitter as HTMLButtonElement | null)?.value ?? "",
			});
		});
		fillIn(found, "BCDF-GHJK");
		expect(submitted).toEqual([{ code: "BCDF-GHJK", action: "connect" }]);
	});
});

/** A hello of the relay's page; `request`: its request id. */
function helloOf(
	options: {
		request?: string;
		name?: string;
		host?: string;
		app?: string;
	} = {},
) {
	return {
		type: "pairing-page",
		nonce: NONCE,
		app: options.app ?? "tab-mcp-extension",
		clientName: options.name ?? "Claude",
		clientHost: options.host ?? "claude.ai",
		requestId: options.request ?? REQUEST,
	};
}

/** A page's port that the test drives. */
function fakePort(
	sender: Partial<PageSender> = {},
	hello: unknown = helloOf(),
) {
	const gone = new AbortController();
	const sent: unknown[] = [];
	const port: PagePort & { sent: unknown[]; leave(): void; closed: boolean } = {
		sender: {
			id: ID,
			url: PAGE,
			origin: RELAY,
			tab: { id: 4 },
			frameId: 0,
			...sender,
		},
		hello: Promise.resolve(hello),
		signal: gone.signal,
		sent,
		closed: false,
		send: (message) => {
			sent.push(message);
		},
		close: () => {
			port.closed = true;
			gone.abort();
		},
		leave: () => gone.abort(),
	};
	return port;
}

/** A filler's host whose answers, code and clock the test sets. */
function fillHost(
	options: {
		aiOn?: boolean;
		enabled?: boolean;
		code?: string | undefined;
	} = {},
) {
	let now = 1_000_000;
	/** After this many questions, the next are "busy" (Questions' cap). */
	const busyAfter = 5;
	const asked: {
		tabId: number;
		name: string;
		host: string;
		signal: AbortSignal;
	}[] = [];
	const answers: ((answer: Answer | "timeout") => void)[] = [];
	const host: FillHost & {
		asked: typeof asked;
		answer(answer: Answer | "timeout"): void;
		advance(ms: number): void;
		released: number;
		failures: string[];
		on: boolean;
		fill: boolean;
	} = {
		extensionId: ID,
		on: options.aiOn ?? true,
		fill: options.enabled ?? true,
		enabled: () => host.fill,
		asked,
		released: 0,
		failures: [],
		relayOrigin: () => RELAY,
		aiOn: () => host.on,
		ask: (tabId, client, signal) => {
			asked.push({ tabId, ...client, signal });
			if (asked.length > busyAfter) return Promise.resolve("busy");
			return new Promise((resolve) => {
				answers.push(resolve);
				signal.addEventListener("abort", () => resolve("deny"));
			});
		},
		answer: (answer) => answers.shift()?.(answer),
		code: async () => ("code" in options ? options.code : "BCDF-GHJK"),
		release: () => {
			host.released++;
		},
		failed: (why) => {
			host.failures.push(why);
		},
		now: () => now,
		advance: (ms) => {
			now += ms;
		},
	};
	return host;
}

const fillMessage = { type: "fill", nonce: NONCE, code: "BCDF-GHJK" };

/** The port of a filled page is closed this soon after (FILLED_CLOSE_MS). */
const CLOSE_MS = 20;
const fillerFor = (host: FillHost, grants: string[] = []) =>
	new CodeFiller(host, grants, CLOSE_MS);

describe("asking and filling in", () => {
	test("Allow: the code goes to that page, with its nonce; its port is closed shortly after", async () => {
		const host = fillHost();
		const filler = fillerFor(host);
		const port = fakePort();
		const done = filler.page(port);
		await settle();
		expect(host.asked).toMatchObject([
			{ tabId: 4, name: "Claude", host: "claude.ai" },
		]);
		host.answer("allow");
		await done;
		expect(port.sent).toEqual([fillMessage]);
		expect(port.closed).toBe(false);
		await Bun.sleep(CLOSE_MS * 3);
		expect(port.closed).toBe(true);
	});

	test("not turned on (also with access to all sites): nothing, no question", async () => {
		const host = fillHost({ enabled: false });
		const port = fakePort();
		await fillerFor(host).page(port);
		expect(host.asked).toEqual([]);
		expect(port.closed).toBe(true);
	});

	test("turned off or AI access off while the question waits: it is withdrawn at once", async () => {
		const host = fillHost();
		const filler = fillerFor(host);
		const port = fakePort();
		const done = filler.page(port);
		await settle();
		filler.withdrawAll();
		await done;
		expect(host.asked[0]?.signal.aborted).toBe(true);
		expect(port.sent).toEqual([]);
		expect(port.closed).toBe(true);
	});

	test("a page that cannot be asked about (too many questions wait) is not dropped unseen: the panel says so", async () => {
		const host = fillHost();
		const filler = fillerFor(host);
		const ports = Array.from({ length: 6 }, (_, i) =>
			fakePort({ tab: { id: 10 + i } }),
		);
		for (const port of ports) void filler.page(port);
		await settle();
		expect(host.failures).toEqual([BUSY]);
		expect(ports[5]?.closed).toBe(true);
	});

	test("Don't allow, a timeout or a busy answer fill nothing", async () => {
		for (const answer of ["deny", "timeout"] as const) {
			const host = fillHost();
			const port = fakePort();
			const done = fillerFor(host).page(port);
			await settle();
			host.answer(answer);
			await done;
			expect(port.sent).toEqual([]);
			expect(port.closed).toBe(true);
		}
	});

	test("with AI access off, nothing: no question, no fill", async () => {
		const host = fillHost({ aiOn: false });
		const port = fakePort();
		await fillerFor(host).page(port);
		expect(host.asked).toEqual([]);
		expect(port.closed).toBe(true);
	});

	test("AI access turned off before the answer: Allow fills nothing", async () => {
		const host = fillHost();
		const port = fakePort();
		const done = fillerFor(host).page(port);
		await settle();
		host.on = false;
		host.answer("allow");
		await done;
		expect(port.sent).toEqual([]);
	});

	test("a look-alike page elsewhere, a frame, another app: ignored, nobody asked", async () => {
		for (const port of [
			fakePort({
				url: "https://evil.example/authorize",
				origin: "https://evil.example",
			}),
			fakePort({ frameId: 2 }),
			fakePort({}, helloOf({ app: "sitegloss" })),
			fakePort({}, { type: "webmcp-changed" }),
		]) {
			const host = fillHost();
			await fillerFor(host).page(port);
			expect(host.asked).toEqual([]);
			expect(port.closed).toBe(true);
		}
	});

	test("the page going (closed, navigated) withdraws the question; nothing is filled", async () => {
		const host = fillHost();
		const port = fakePort();
		const done = fillerFor(host).page(port);
		await settle();
		port.leave();
		await done;
		expect(host.asked[0]?.signal.aborted).toBe(true);
		expect(port.sent).toEqual([]);
	});

	test("the AI app connecting meanwhile (typed by hand) withdraws its question; an app listed already does not", async () => {
		const host = fillHost();
		const filler = fillerFor(host, ["old"]);
		const port = fakePort();
		const done = filler.page(port);
		await settle();
		filler.grantsChanged([{ grantId: "old", host: "claude.ai" }]);
		expect(host.asked[0]?.signal.aborted).toBe(false);
		filler.grantsChanged([
			{ grantId: "old", host: "claude.ai" },
			{ grantId: "other", host: "chatgpt.com" },
		]);
		expect(host.asked[0]?.signal.aborted).toBe(false);
		filler.grantsChanged([
			{ grantId: "old", host: "claude.ai" },
			{ grantId: "new", host: "claude.ai" },
		]);
		await done;
		expect(host.asked[0]?.signal.aborted).toBe(true);
		expect(port.sent).toEqual([]);
	});

	test("no loops: the same request's page back after a fill gets one more fill without asking, then nothing", async () => {
		const host = fillHost();
		const filler = fillerFor(host);
		const first = fakePort();
		const done = filler.page(first);
		await settle();
		host.answer("allow");
		await done;
		first.leave();
		// The relay's answer: the same request's page again in that tab.
		host.advance(1_000);
		const second = fakePort();
		await filler.page(second);
		expect(host.asked).toHaveLength(1);
		expect(second.sent).toEqual([fillMessage]);
		second.leave();
		host.advance(1_000);
		const third = fakePort();
		await filler.page(third);
		expect(host.asked).toHaveLength(1);
		expect(third.sent).toEqual([]);
		expect(third.closed).toBe(true);
	});

	test("a new request in the same tab right after a fill asks: the one more fill is for the same request only", async () => {
		const host = fillHost();
		const filler = fillerFor(host);
		const first = fakePort();
		const done = filler.page(first);
		await settle();
		host.answer("allow");
		await done;
		first.leave();
		// The client sends the tab to /authorize again, with a new request.
		host.advance(1_000);
		const again = fakePort({}, helloOf({ request: "another-request-id" }));
		const asked = filler.page(again);
		await settle();
		expect(host.asked).toHaveLength(2);
		expect(again.sent).toEqual([]);
		host.answer("deny");
		await asked;
		expect(again.sent).toEqual([]);
	});

	test("one question per page load; later, or in another tab, or for another app, it asks again", async () => {
		const host = fillHost();
		const filler = fillerFor(host);
		const first = fakePort();
		const done = filler.page(first);
		await settle();
		host.answer("allow");
		await done;
		// Another tab, another request: their own question.
		void filler.page(fakePort({ tab: { id: 5 } }));
		void filler.page(
			fakePort(
				{},
				helloOf({ name: "ChatGPT", host: "chatgpt.com", request: "r-chatgpt" }),
			),
		);
		await settle();
		expect(host.asked.map((a) => [a.tabId, a.host])).toEqual([
			[4, "claude.ai"],
			[5, "claude.ai"],
			[4, "chatgpt.com"],
		]);
		// The same page after the window: not the answer to the fill.
		host.advance(RETRY_WINDOW_MS + 1);
		void filler.page(fakePort());
		await settle();
		expect(host.asked).toHaveLength(4);
	});

	test("the app connected after a fill: the fill is done with, pairing need not be held", async () => {
		const host = fillHost();
		const filler = fillerFor(host);
		const done = filler.page(fakePort());
		await settle();
		host.answer("allow");
		await done;
		filler.grantsChanged([{ grantId: "g", host: "claude.ai" }]);
		expect(host.released).toBe(1);
		// Back to the page (a new request): asked again, not filled blindly.
		void filler.page(fakePort());
		await settle();
		expect(host.asked).toHaveLength(2);
	});

	test("no code from the relay after Allow: the panel says so, nothing is filled", async () => {
		const host = fillHost({ code: undefined });
		const port = fakePort();
		const done = fillerFor(host).page(port);
		await settle();
		host.answer("allow");
		await done;
		expect(port.sent).toEqual([]);
		expect(host.failures).toEqual([NO_CODE]);
	});

	test("another relay: the questions of the one before are withdrawn", async () => {
		const host = fillHost();
		const filler = fillerFor(host);
		const port = fakePort();
		const done = filler.page(port);
		await settle();
		filler.reset();
		await done;
		expect(port.sent).toEqual([]);
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
				"Connect Claude (claude.ai) to the tab-mcp browser extension? Allow fills in the code on the relay's page.",
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

	test("Fill in the code for me: a setting of its own, what it does in one line, Stop while it is on", () => {
		const relay = "https://tab-mcp.ractive.ch";
		const then =
			"Then, when an AI app opens the sign-in page of tab-mcp.ractive.ch in this Chrome profile, tab-mcp asks you and fills in the code.";
		expect(fillView(relay, false, false)).toEqual({
			text: `${then} Chrome asks you first.`,
			on: true,
			off: false,
		});
		// The site granted already (access to all sites): still off until
		// turned on, and Chrome asks nothing.
		expect(fillView(relay, false, true)).toEqual({
			text: then,
			on: true,
			off: false,
		});
		expect(fillView(relay, true, true)).toEqual({
			text: "When an AI app opens the sign-in page of tab-mcp.ractive.ch in this Chrome profile, tab-mcp asks you and fills in the code.",
			on: false,
			off: true,
		});
		// On, but the site was taken away in the browser's settings.
		expect(fillView(relay, true, false)).toMatchObject({ on: true, off: true });
		// No pattern for the address: one plain sentence, no button.
		expect(fillView("http://[::1]:8787", false, false)).toEqual({
			text: NO_PATTERN,
			on: false,
			off: false,
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

/** A code source the test drives; `expiresAt` relative to NOW. */
function codes(first?: { code: string; leftMs: number | "bad" }) {
	let current =
		first === undefined
			? undefined
			: {
					code: first.code,
					expiresAt:
						first.leftMs === "bad"
							? "not a date"
							: new Date(NOW + first.leftMs).toISOString(),
				};
	const listeners = new Set<() => void>();
	const source: CodeSource & { next(code: string): void } = {
		current: () => current,
		onChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		next: (code) => {
			current = {
				code,
				expiresAt: new Date(NOW + 120_000).toISOString(),
			};
			for (const listener of listeners) listener();
		},
	};
	return source;
}

const NOW = Date.UTC(2026, 10, 20, 12);

describe("the code to fill in", () => {
	const signal = () => new AbortController().signal;

	test("the current code while it has time left, or when its expiry cannot be read", async () => {
		expect(
			await takeCode(codes({ code: "AAAA-AAAA", leftMs: 60_000 }), signal(), {
				now: NOW,
			}),
		).toBe("AAAA-AAAA");
		expect(
			await takeCode(codes({ code: "BBBB-BBBB", leftMs: "bad" }), signal(), {
				now: NOW,
			}),
		).toBe("BBBB-BBBB");
	});

	test("about to change: the next one the relay sends", async () => {
		const source = codes({ code: "AAAA-AAAA", leftMs: 2_000 });
		const taken = takeCode(source, signal(), { now: NOW, waitMs: 1_000 });
		source.next("CCCC-CCCC");
		expect(await taken).toBe("CCCC-CCCC");
	});

	test("with this clock ahead every code looks expired: none comes, so the current one after all", async () => {
		const source = codes({ code: "AAAA-AAAA", leftMs: -180_000 });
		expect(await takeCode(source, signal(), { now: NOW, waitMs: 20 })).toBe(
			"AAAA-AAAA",
		);
	});

	test("no code at all, or the page gone: none", async () => {
		expect(await takeCode(codes(), signal(), { now: NOW, waitMs: 20 })).toBe(
			undefined,
		);
		const gone = new AbortController();
		const taken = takeCode(codes(), gone.signal, { now: NOW, waitMs: 1_000 });
		gone.abort();
		expect(await taken).toBeUndefined();
	});

	test("pairing is held for the check", () => {
		expect(HOLD_MS).toBe(30_000);
	});
});
