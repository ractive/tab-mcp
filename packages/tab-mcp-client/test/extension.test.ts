/**
 * `./extension`: filling in a browser extension's own code on the relay's
 * pairing page (DEC-199, DEC-203, DEC-206). Which page is one, who may speak
 * for it, what is said, the content script on the page, the rules of asking
 * and filling in, and which code is filled in.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	CodeFiller,
	type CodeSource,
	type ContentPort,
	type FillAnswer,
	type FillFailure,
	type FillHost,
	fillIn,
	findPairingForm,
	helloFor,
	isPairingSender,
	PAIRING_PORT,
	type PagePort,
	type PageSender,
	pagePort,
	pairingCodes,
	pairingPagePattern,
	parseFill,
	parseHello,
	RETRY_WINDOW_MS,
	relayPageOrigin,
	relaySitePattern,
	runPairingPage,
	takeCode,
	type WorkerPort,
} from "../src/extension.ts";
import type { PairingCode } from "../src/types.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const APP = "tab-mcp-extension";
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
	const form = `<form method="post" action="/authorize" data-tab-mcp-pairing="1" data-app="${options.app ?? APP}" data-client-name="Claude" data-client-host="claude.ai">
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
	delete (globalThis as Record<string, unknown>)["__tabMcpPairingPage"];
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

	test("the site's pattern and the page's, without a port", () => {
		expect(relaySitePattern("https://tab-mcp.ractive.ch")).toBe(
			"https://tab-mcp.ractive.ch/*",
		);
		// Firefox's patterns take no port; the exact origin is checked in code.
		expect(relaySitePattern("http://127.0.0.1:8787")).toBe(
			"http://127.0.0.1/*",
		);
		expect(pairingPagePattern("wss://relay.example:8443")).toBe(
			"https://relay.example/authorize*",
		);
		expect(relaySitePattern("nope")).toBeUndefined();
		expect(pairingPagePattern("nope")).toBeUndefined();
	});

	test("the pattern's host is normalised; one that gives no pattern gives none", () => {
		// Lower case already from the URL parser; the trailing dot goes.
		expect(relaySitePattern("https://Relay.Example.:8443/")).toBe(
			"https://relay.example/*",
		);
		// An IPv6 literal: the browsers do not agree on a pattern for it.
		expect(relaySitePattern("http://[::1]:8787")).toBeUndefined();
		expect(pairingPagePattern("http://[::1]:8787")).toBeUndefined();
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
			app: APP,
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
		const found = findPairingForm(page(relayForm()), top, APP);
		expect(found).toBeDefined();
		expect(found && helloFor(found, NONCE)).toEqual({
			type: "pairing-page",
			nonce: NONCE,
			app: APP,
			clientName: "Claude",
			clientHost: "claude.ai",
			requestId: REQUEST,
		});
		// Another app's form, a page that pairs by sign-in only (no code
		// field), one without the relay's request id, a frame, another path,
		// two forms: nothing.
		expect(
			findPairingForm(page(relayForm({ app: "sitegloss" })), top, APP),
		).toBeUndefined();
		expect(
			findPairingForm(page(relayForm({ field: false })), top, APP),
		).toBeUndefined();
		expect(
			findPairingForm(page(relayForm({ request: false })), top, APP),
		).toBeUndefined();
		expect(
			findPairingForm(page(relayForm()), { ...top, topLevel: false }, APP),
		).toBeUndefined();
		expect(
			findPairingForm(page(relayForm()), { ...top, pathname: "/" }, APP),
		).toBeUndefined();
		expect(
			findPairingForm(page(relayForm({ forms: 2 })), top, APP),
		).toBeUndefined();
		// Each extension its own app's form.
		expect(
			findPairingForm(page(relayForm({ app: "sitegloss" })), top, "sitegloss")
				?.app,
		).toBe("sitegloss");
	});

	/** Submits of `doc`'s form, kept from going anywhere. */
	function submits(doc: Document): Record<string, string>[] {
		const submitted: Record<string, string>[] = [];
		const form = doc.querySelector("form");
		form?.addEventListener("submit", (event) => {
			event.preventDefault();
			const submitter = (event as SubmitEvent).submitter;
			submitted.push({
				code: (doc.getElementById("code") as HTMLInputElement).value,
				action: (submitter as HTMLButtonElement | null)?.value ?? "",
			});
		});
		return submitted;
	}

	test("the code goes into the field and the form is submitted with Connect", () => {
		const doc = page(relayForm());
		const found = findPairingForm(doc, top, APP);
		if (found === undefined) throw new Error("no form");
		const submitted = submits(doc);
		fillIn(found, "BCDF-GHJK");
		expect(submitted).toEqual([{ code: "BCDF-GHJK", action: "connect" }]);
	});

	/** A content script's port that the test drives. */
	function contentPort() {
		const sent: unknown[] = [];
		const listeners: ((message: unknown) => void)[] = [];
		const port: ContentPort & {
			sent: unknown[];
			deliver(message: unknown): void;
		} = {
			sent,
			postMessage: (message) => {
				sent.push(message);
			},
			onMessage: { addListener: (listener) => listeners.push(listener) },
			deliver: (message) => {
				for (const listener of listeners) listener(message);
			},
		};
		return port;
	}

	test("says who asks once, and fills in only the code with its own nonce, once", () => {
		const doc = page(relayForm());
		const submitted = submits(doc);
		const port = contentPort();
		const names: string[] = [];
		expect(
			runPairingPage({
				app: APP,
				connect: () => {
					names.push(PAIRING_PORT);
					return port;
				},
				page: { document: doc, ...top },
			}),
		).toBe(true);
		expect(names).toEqual(["pairing-page"]);
		const hello = parseHello(port.sent[0]);
		expect(hello).toMatchObject({
			app: APP,
			clientName: "Claude",
			clientHost: "claude.ai",
			requestId: REQUEST,
		});
		expect(port.sent).toHaveLength(1);
		const nonce = hello?.nonce ?? "";
		// Another nonce, not a fill: nothing.
		port.deliver({ type: "fill", nonce: "another-page-load-0000", code: "X" });
		port.deliver({ type: "something", nonce });
		expect(submitted).toEqual([]);
		port.deliver({ type: "fill", nonce, code: "BCDF-GHJK" });
		port.deliver({ type: "fill", nonce, code: "ZZZZ-ZZZZ" });
		expect(submitted).toEqual([{ code: "BCDF-GHJK", action: "connect" }]);
		// Put in again into the same document: nothing more.
		expect(
			runPairingPage({
				app: APP,
				connect: () => port,
				page: { document: doc, ...top },
			}),
		).toBe(false);
		expect(port.sent).toHaveLength(1);
	});

	test("no form of its app: no port", () => {
		let connected = false;
		expect(
			runPairingPage({
				app: "sitegloss",
				connect: () => {
					connected = true;
					return contentPort();
				},
				page: { document: page(relayForm()), ...top },
			}),
		).toBe(false);
		expect(connected).toBe(false);
	});
});

describe("the worker's end of a page's port", () => {
	function chromePort(sender: PageSender) {
		const messages: ((message: unknown) => void)[] = [];
		const ends: (() => void)[] = [];
		const port: WorkerPort & {
			posted: unknown[];
			disconnected: number;
			say(message: unknown): void;
			end(): void;
		} = {
			sender,
			posted: [],
			disconnected: 0,
			postMessage: (message) => {
				port.posted.push(message);
			},
			disconnect: () => {
				port.disconnected++;
			},
			onMessage: {
				addListener: (listener) => messages.push(listener),
				removeListener: (listener) => {
					messages.splice(messages.indexOf(listener), 1);
				},
			},
			onDisconnect: { addListener: (listener) => ends.push(listener) },
			say: (message) => {
				for (const listener of [...messages]) listener(message);
			},
			end: () => {
				for (const listener of ends) listener();
			},
		};
		return port;
	}

	test("the first message is the hello, taken at once; the page going aborts", async () => {
		const port = chromePort({ id: ID });
		const page = pagePort(port);
		port.say("first");
		port.say("second");
		expect(await page.hello).toBe("first");
		expect(page.signal.aborted).toBe(false);
		port.end();
		expect(page.signal.aborted).toBe(true);
	});

	test("closing it disconnects once and ends the wait for a hello", async () => {
		const port = chromePort({ id: ID });
		const page = pagePort(port);
		page.close();
		page.close();
		expect(await page.hello).toBeUndefined();
		expect(page.signal.aborted).toBe(true);
		expect(port.disconnected).toBe(1);
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
		app: options.app ?? APP,
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
	/** After this many questions, the next are "busy" (the extension's cap). */
	const busyAfter = 5;
	const asked: {
		tabId: number;
		name: string;
		host: string;
		signal: AbortSignal;
	}[] = [];
	const answers: ((answer: FillAnswer) => void)[] = [];
	const host: FillHost & {
		asked: typeof asked;
		answer(answer: FillAnswer): void;
		advance(ms: number): void;
		released: number;
		failures: FillFailure[];
		on: boolean;
		fill: boolean;
	} = {
		extensionId: ID,
		app: APP,
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
	new CodeFiller(host, { grants, closeAfterMs: CLOSE_MS });

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

	test("a page that cannot be asked about (too many questions wait) is not dropped unseen: it is reported", async () => {
		const host = fillHost();
		const filler = fillerFor(host);
		const ports = Array.from({ length: 6 }, (_, i) =>
			fakePort({ tab: { id: 10 + i } }),
		);
		for (const port of ports) void filler.page(port);
		await settle();
		expect(host.failures).toEqual(["busy"]);
		expect(ports[5]?.closed).toBe(true);
	});

	test("Don't allow or a timeout fill nothing", async () => {
		for (const answer of ["deny", "timeout"] as const) {
			const host = fillHost();
			const port = fakePort();
			const done = fillerFor(host).page(port);
			await settle();
			host.answer(answer);
			await done;
			expect(port.sent).toEqual([]);
			expect(port.closed).toBe(true);
			expect(host.failures).toEqual([]);
		}
	});

	test("with AI access off, nothing: no question, no fill", async () => {
		const host = fillHost({ aiOn: false });
		const port = fakePort();
		await fillerFor(host).page(port);
		expect(host.asked).toEqual([]);
		expect(port.closed).toBe(true);
	});

	test("AI access or the setting turned off before the answer: Allow fills nothing", async () => {
		for (const off of ["on", "fill"] as const) {
			const host = fillHost();
			const port = fakePort();
			const done = fillerFor(host).page(port);
			await settle();
			host[off] = false;
			host.answer("allow");
			await done;
			expect(port.sent).toEqual([]);
			expect(port.closed).toBe(true);
		}
	});

	test("a look-alike page elsewhere, a frame, another app, a page that says nothing: ignored, nobody asked", async () => {
		for (const port of [
			fakePort({
				url: "https://evil.example/authorize",
				origin: "https://evil.example",
			}),
			fakePort({ frameId: 2 }),
			fakePort({ id: "another-extension" }),
			fakePort({ tab: undefined }),
			fakePort({}, helloOf({ app: "sitegloss" })),
			fakePort({}, { type: "webmcp-changed" }),
			fakePort({}, null),
		]) {
			const host = fillHost();
			await fillerFor(host).page(port);
			expect(host.asked).toEqual([]);
			expect(port.closed).toBe(true);
		}
	});

	test("no relay to fill in for (another one in use): nothing", async () => {
		const host = fillHost();
		host.relayOrigin = () => undefined;
		const port = fakePort();
		await fillerFor(host).page(port);
		expect(host.asked).toEqual([]);
		expect(port.closed).toBe(true);
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

	test("the one more fill is for the same tab only: another tab with the same request asks", async () => {
		const host = fillHost();
		const filler = fillerFor(host);
		const done = filler.page(fakePort());
		await settle();
		host.answer("allow");
		await done;
		host.advance(1_000);
		const other = fakePort({ tab: { id: 5 } });
		void filler.page(other);
		await settle();
		expect(host.asked).toHaveLength(2);
		expect(other.sent).toEqual([]);
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

	test("no code from the relay after Allow: reported, nothing is filled", async () => {
		const host = fillHost({ code: undefined });
		const port = fakePort();
		const done = fillerFor(host).page(port);
		await settle();
		host.answer("allow");
		await done;
		expect(port.sent).toEqual([]);
		expect(host.failures).toEqual(["no-code"]);
	});

	test("another relay: the questions of the one before are withdrawn, its grants forgotten", async () => {
		const host = fillHost();
		const filler = fillerFor(host, ["old"]);
		const port = fakePort();
		const done = filler.page(port);
		await settle();
		filler.reset();
		await done;
		expect(port.sent).toEqual([]);
		// The same grant id listed by the new relay is new to it.
		const next = fakePort();
		const asked = filler.page(next);
		await settle();
		filler.grantsChanged([{ grantId: "old", host: "claude.ai" }]);
		await asked;
		expect(host.asked[1]?.signal.aborted).toBe(true);
	});
});

/** A code source the test drives; `expiresAt` relative to NOW. */
function codes(first?: { code: string; leftMs: number | "bad" }) {
	let current: PairingCode | undefined =
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

	test("the codes of a TabMcp: its pairingCode, and its pairingcode events until stopped", () => {
		let code: PairingCode | undefined = {
			code: "AAAA-AAAA",
			expiresAt: new Date(NOW).toISOString(),
		};
		const target = new EventTarget();
		const mcp = {
			get pairingCode() {
				return code;
			},
			addEventListener: target.addEventListener.bind(target),
			removeEventListener: target.removeEventListener.bind(target),
		};
		const source = pairingCodes(mcp as Parameters<typeof pairingCodes>[0]);
		expect(source.current()?.code).toBe("AAAA-AAAA");
		let heard = 0;
		const stop = source.onChange(() => heard++);
		code = undefined;
		target.dispatchEvent(new Event("pairingcode"));
		expect(source.current()).toBeUndefined();
		stop();
		target.dispatchEvent(new Event("pairingcode"));
		expect(heard).toBe(1);
	});
});
