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
	type FillContext,
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

	test("once per document: a test's two pages are two documents, the content script's own the global's", () => {
		const scope = globalThis as Record<string, unknown>;
		const run = (doc: Document) =>
			runPairingPage({
				app: APP,
				connect: () => contentPort(),
				page: { document: doc, ...top },
			});
		expect(run(page(relayForm()))).toBe(true);
		expect(run(page(relayForm()))).toBe(true);
		// A test's page leaves the content script's own mark alone.
		expect(scope["__tabMcpPairingPage"]).toBeUndefined();
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
	const codes: ((code: string | undefined) => void)[] = [];
	const host: FillHost & {
		asked: typeof asked;
		answer(answer: FillAnswer): void;
		/** `code()` waits until `giveCode`. */
		holdCode: boolean;
		giveCode(code: string | undefined): void;
		codeSignals: AbortSignal[];
		codeContexts: FillContext[];
		advance(ms: number): void;
		released: number;
		failures: FillFailure[];
		failureContexts: FillContext[];
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
		failureContexts: [],
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
		codeSignals: [],
		codeContexts: [],
		code: (signal, context) => {
			host.codeSignals.push(signal);
			host.codeContexts.push(context);
			if (!host.holdCode)
				return Promise.resolve("code" in options ? options.code : "BCDF-GHJK");
			// Held until the test gives one; it pays no heed to `signal`, as a
			// careless host might not.
			return new Promise((resolve) => codes.push(resolve));
		},
		holdCode: false,
		giveCode: (code) => {
			for (const resolve of codes.splice(0)) resolve(code);
		},
		release: () => {
			host.released++;
		},
		failed: (why, context) => {
			host.failures.push(why);
			host.failureContexts.push(context);
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
const fillerFor = (
	host: FillHost,
	grants: string[] = [],
	options: { retry?: boolean } = {},
) => new CodeFiller(host, { grants, closeAfterMs: CLOSE_MS, ...options });

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

	test("retry: false: the same request's page back after a fill is asked about like any other, each fill with its own yes", async () => {
		const host = fillHost();
		const filler = fillerFor(host, [], { retry: false });
		const first = fakePort();
		const done = filler.page(first);
		await settle();
		host.answer("allow");
		await done;
		expect(first.sent).toEqual([fillMessage]);
		first.leave();
		host.advance(1_000);
		// The relay's answer: asked, nothing filled before the yes.
		const second = fakePort();
		const asking = filler.page(second);
		await settle();
		expect(host.asked).toHaveLength(2);
		expect(second.sent).toEqual([]);
		host.answer("deny");
		await asking;
		expect(second.sent).toEqual([]);
		expect(second.closed).toBe(true);
		// Again: asked again (one question per page load), filled on Allow.
		host.advance(1_000);
		const third = fakePort();
		const allowing = filler.page(third);
		await settle();
		expect(host.asked).toHaveLength(3);
		host.answer("allow");
		await allowing;
		expect(third.sent).toEqual([fillMessage]);
	});

	test("the relay changed while the page said who asks, or while it was asked: no question, no code", async () => {
		// During the wait for the hello.
		const host = fillHost();
		let hello: (message: unknown) => void = () => {};
		const port = {
			...fakePort(),
			hello: new Promise<unknown>((resolve) => {
				hello = resolve;
			}),
		};
		const done = fillerFor(host).page(port);
		await settle();
		host.relayOrigin = () => "https://other.example";
		hello(helloOf());
		await done;
		expect(host.asked).toEqual([]);
		expect(host.codeSignals).toEqual([]);
		// During the question, without a reset: Allow asks for no code.
		const asked = fillHost();
		const next = fakePort();
		const answering = fillerFor(asked).page(next);
		await settle();
		asked.relayOrigin = () => undefined;
		asked.answer("allow");
		await answering;
		expect(asked.codeSignals).toEqual([]);
		expect(next.sent).toEqual([]);
		expect(next.closed).toBe(true);
	});

	test("code and failed say which tab and AI app, as ask has them", async () => {
		const host = fillHost();
		const filler = fillerFor(host);
		const done = filler.page(fakePort({ tab: { id: 9 } }));
		await settle();
		host.answer("allow");
		await done;
		const claude = { tabId: 9, client: { name: "Claude", host: "claude.ai" } };
		expect(host.codeContexts).toEqual([claude]);
		// Busy: the sixth page is reported with its own tab and AI app.
		const busy = fillHost();
		const busyFiller = fillerFor(busy);
		for (let i = 0; i < 6; i++)
			void busyFiller.page(
				fakePort(
					{ tab: { id: 10 + i } },
					i === 5
						? helloOf({ name: "", host: "chatgpt.com", request: "r-6" })
						: helloOf({ request: `r-${i}` }),
				),
			);
		await settle();
		expect(busy.failureContexts).toEqual([
			{ tabId: 15, client: { name: "", host: "chatgpt.com" } },
		]);
		// No code.
		const none = fillHost({ code: undefined });
		const asking = fillerFor(none).page(fakePort({ tab: { id: 3 } }));
		await settle();
		none.answer("allow");
		await asking;
		expect(none.failureContexts).toEqual([{ ...claude, tabId: 3 }]);
	});

	test("a fill that ended without sending its code releases pairing, unless another fill still needs it", async () => {
		// No code: released.
		const none = fillHost({ code: undefined });
		const asking = fillerFor(none).page(fakePort());
		await settle();
		none.answer("allow");
		await asking;
		expect(none.released).toBe(1);
		// Withdrawn while its code was on its way: released.
		const host = fillHost();
		const filler = fillerFor(host);
		const { done } = await allowedAndWaiting(host, filler);
		filler.withdrawAll();
		host.giveCode("BCDF-GHJK");
		await done;
		expect(host.released).toBe(1);
		// A fill sent in tab 4 waits for the relay's check: a failed fill in
		// tab 5 leaves pairing held.
		const two = fillHost();
		const twoFiller = fillerFor(two);
		const sent = twoFiller.page(fakePort());
		await settle();
		two.answer("allow");
		await sent;
		two.holdCode = true;
		const other = fakePort({ tab: { id: 5 } });
		const failing = twoFiller.page(other);
		await settle();
		two.answer("allow");
		await settle();
		other.leave();
		two.giveCode(undefined);
		await failing;
		expect(other.sent).toEqual([]);
		expect(two.released).toBe(0);
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
		// The new relay's first list is the grants there are; a grant after it
		// is an AI app that just connected.
		const next = fakePort();
		const asked = filler.page(next);
		await settle();
		filler.grantsChanged([{ grantId: "old", host: "claude.ai" }]);
		expect(host.asked[1]?.signal.aborted).toBe(false);
		filler.grantsChanged([
			{ grantId: "old", host: "claude.ai" },
			{ grantId: "new", host: "claude.ai" },
		]);
		await asked;
		expect(host.asked[1]?.signal.aborted).toBe(true);
	});

	test("without grants to start with, the first list is the baseline: a worker that starts before its connection keeps its questions", async () => {
		const host = fillHost();
		const filler = new CodeFiller(host, { closeAfterMs: CLOSE_MS });
		const port = fakePort();
		const done = filler.page(port);
		await settle();
		// The relay's list once connected: claude.ai had a grant already.
		filler.grantsChanged([{ grantId: "earlier", host: "claude.ai" }]);
		expect(host.asked[0]?.signal.aborted).toBe(false);
		host.answer("allow");
		await done;
		expect(port.sent).toEqual([fillMessage]);
		expect(host.released).toBe(0);
		// The grant this fill made: done with, pairing released.
		filler.grantsChanged([
			{ grantId: "earlier", host: "claude.ai" },
			{ grantId: "now", host: "claude.ai" },
		]);
		expect(host.released).toBe(1);
	});

	test("seeded with an empty list, the first list's grants are new", async () => {
		const host = fillHost();
		const filler = fillerFor(host, []);
		const done = filler.page(fakePort());
		await settle();
		filler.grantsChanged([{ grantId: "g", host: "claude.ai" }]);
		await done;
		expect(host.asked[0]?.signal.aborted).toBe(true);
	});
});

/** Allow on a fresh page of `filler`, its code held: the page, and its fill under way. */
async function allowedAndWaiting(
	host: ReturnType<typeof fillHost>,
	filler: CodeFiller,
) {
	host.holdCode = true;
	const port = fakePort();
	const done = filler.page(port);
	await settle();
	host.answer("allow");
	await settle();
	expect(host.codeSignals).toHaveLength(1);
	return { port, done };
}

describe("a fill that waits for its code", () => {
	const withdrawals: [
		string,
		(host: ReturnType<typeof fillHost>, filler: CodeFiller) => void,
	][] = [
		[
			"filling in turned off",
			(host, filler) => {
				host.fill = false;
				filler.withdrawAll();
			},
		],
		[
			"AI access turned off",
			(host, filler) => {
				host.on = false;
				filler.withdrawAll();
			},
		],
		[
			"another relay",
			(host, filler) => {
				host.relayOrigin = () => "https://other.example";
				filler.reset();
			},
		],
		[
			"the AI app connected (typed by hand)",
			(_host, filler) =>
				filler.grantsChanged([{ grantId: "typed", host: "claude.ai" }]),
		],
	];

	for (const [what, withdraw] of withdrawals)
		test(`is withdrawn by ${what}: no code is sent, no one more fill is left`, async () => {
			const host = fillHost();
			const filler = fillerFor(host);
			const { port, done } = await allowedAndWaiting(host, filler);
			withdraw(host, filler);
			expect(host.codeSignals[0]?.aborted).toBe(true);
			// A host whose code comes anyway.
			host.giveCode("BCDF-GHJK");
			await done;
			expect(port.sent).toEqual([]);
			expect(port.closed).toBe(true);
			// Back as it was: the same request's page asks, it is not filled.
			host.fill = true;
			host.on = true;
			host.relayOrigin = () => RELAY;
			host.holdCode = false;
			const again = fakePort();
			void filler.page(again);
			await settle();
			expect(host.asked).toHaveLength(2);
			expect(again.sent).toEqual([]);
		});

	test("checked again once the code is there, also when the host withdrew nothing", async () => {
		for (const off of [
			(host: ReturnType<typeof fillHost>) => {
				host.fill = false;
			},
			(host: ReturnType<typeof fillHost>) => {
				host.on = false;
			},
			(host: ReturnType<typeof fillHost>) => {
				host.relayOrigin = () => "https://other.example";
			},
		]) {
			const host = fillHost();
			const filler = fillerFor(host);
			const { port, done } = await allowedAndWaiting(host, filler);
			off(host);
			host.giveCode("BCDF-GHJK");
			await done;
			expect(port.sent).toEqual([]);
			expect(port.closed).toBe(true);
		}
	});

	test("two pages of the same request while the one more fill waits: only one is filled, never a third", async () => {
		const host = fillHost();
		const filler = fillerFor(host);
		const first = fakePort();
		const done = filler.page(first);
		await settle();
		host.answer("allow");
		await done;
		first.leave();
		host.advance(1_000);
		host.holdCode = true;
		// The relay's answer (the one more fill, waiting for the next code)…
		const second = fakePort();
		const filling = filler.page(second);
		await settle();
		// …and a reload of the same request meanwhile.
		const third = fakePort();
		await filler.page(third);
		expect(third.closed).toBe(true);
		host.giveCode("BCDF-GHJK");
		await filling;
		expect(second.sent).toEqual([fillMessage]);
		expect(third.sent).toEqual([]);
		expect(host.asked).toHaveLength(1);
	});

	test("the one more fill without a code leaves the count as it was", async () => {
		const host = fillHost();
		const filler = fillerFor(host);
		const done = filler.page(fakePort());
		await settle();
		host.answer("allow");
		await done;
		host.advance(1_000);
		host.holdCode = true;
		const second = fakePort();
		const filling = filler.page(second);
		await settle();
		host.giveCode(undefined);
		await filling;
		expect(second.sent).toEqual([]);
		expect(host.failures).toEqual(["no-code"]);
		// The page again: the one more fill is still its due.
		host.holdCode = false;
		const third = fakePort();
		await filler.page(third);
		expect(third.sent).toEqual([fillMessage]);
		expect(host.asked).toHaveLength(1);
	});
});

describe("a host callback that fails", () => {
	test("fills nothing, closes the port, is logged, and never rejects", async () => {
		const warn = console.warn;
		const warned: unknown[][] = [];
		console.warn = (...args: unknown[]) => {
			warned.push(args);
		};
		try {
			const broken: [string, (host: ReturnType<typeof fillHost>) => void][] = [
				[
					"ask",
					(host) => {
						host.ask = () => Promise.reject(new Error("no panel"));
					},
				],
				[
					"enabled",
					(host) => {
						host.enabled = () => {
							throw new Error("no settings");
						};
					},
				],
				[
					"code",
					(host) => {
						host.code = () => Promise.reject(new Error("no code"));
					},
				],
			];
			for (const [name, breakIt] of broken) {
				const host = fillHost();
				breakIt(host);
				const filler = fillerFor(host);
				const port = fakePort();
				const done = filler.page(port);
				await settle();
				host.answer("allow");
				await done;
				expect(port.sent).toEqual([]);
				expect(port.closed).toBe(true);
				expect(warned.length).toBeGreaterThan(0);
				warned.length = 0;
				// Nothing left behind: the same request's page asks again.
				if (name === "code") {
					host.code = async () => "BCDF-GHJK";
					void filler.page(fakePort());
					await settle();
					expect(host.asked).toHaveLength(2);
				}
			}
		} finally {
			console.warn = warn;
		}
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
	const source: CodeSource & {
		next(code: string, leftMs?: number): void;
		again(): void;
	} = {
		current: () => current,
		onChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		next: (code, leftMs = 120_000) => {
			current = {
				code,
				expiresAt: new Date(NOW + leftMs).toISOString(),
			};
			for (const listener of listeners) listener();
		},
		// The relay's answer to `pairing.start` with pairing on already: the
		// code it shows, sent again as it is (`pairingcode` for it).
		again: () => {
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

	test("the code about to change sent again (startPairing() with pairing on) is not the next one", async () => {
		const source = codes({ code: "AAAA-AAAA", leftMs: 2_000 });
		let settled = false;
		const taken = takeCode(source, signal(), {
			now: NOW,
			waitMs: 1_000,
		}).finally(() => {
			settled = true;
		});
		source.again();
		await settle();
		expect(settled).toBe(false);
		source.next("CCCC-CCCC");
		expect(await taken).toBe("CCCC-CCCC");
	});

	test("the same code sent again with time left now (its expiry moved) is taken", async () => {
		const source = codes({ code: "AAAA-AAAA", leftMs: 2_000 });
		const taken = takeCode(source, signal(), { now: NOW, waitMs: 1_000 });
		source.next("AAAA-AAAA", 60_000);
		expect(await taken).toBe("AAAA-AAAA");
	});

	test("the startPairing() before takeCode pattern on a TabMcp with pairing on: the next code, not the old one again", async () => {
		// As the relay does: `pairing.start` is answered with the code shown,
		// after the call returns.
		let code: PairingCode | undefined = {
			code: "AAAA-AAAA",
			expiresAt: new Date(NOW + 2_000).toISOString(),
		};
		const target = new EventTarget();
		const mcp = {
			get pairingCode() {
				return code;
			},
			addEventListener: target.addEventListener.bind(target),
			removeEventListener: target.removeEventListener.bind(target),
			startPairing: () => {
				setTimeout(() => target.dispatchEvent(new Event("pairingcode")), 1);
			},
		};
		mcp.startPairing();
		const taken = takeCode(
			pairingCodes(mcp as unknown as Parameters<typeof pairingCodes>[0]),
			signal(),
			{ now: NOW, waitMs: 1_000 },
		);
		await settle();
		code = {
			code: "CCCC-CCCC",
			expiresAt: new Date(NOW + 120_000).toISOString(),
		};
		target.dispatchEvent(new Event("pairingcode"));
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
