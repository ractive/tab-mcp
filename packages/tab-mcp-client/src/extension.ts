/**
 * `@ractive-ch/tab-mcp-client/extension`: for a browser extension that is a
 * tab-mcp page itself (the tab-mcp browser extension, Sitegloss). It fills
 * in the extension's own pairing code on the relay's pairing page
 * (`/authorize`) when an AI app opens it in the same browser, after asking
 * the user (DEC-199, DEC-203). What is the same for every such extension
 * lives here, reviewed once (DEC-206); how the user is asked, where the
 * setting is kept, the permission prompt, the content script's registration
 * and holding pairing on are each extension's own, given as callbacks.
 *
 * The relay's page has no scripts (DEC-057), so it cannot call the
 * extension: a content script reads the form's `data-tab-mcp-*` hooks and
 * tells the worker who asks (the AI app's name and verified host). The
 * worker asks its user and, on Allow, hands the code to that one page over
 * its port. The content script never sees a code before that, and the
 * worker never takes a page's word for where it is: any site can copy the
 * markup, so the origin the browser reports for the port is the check.
 *
 * An entry of its own that a web page never loads, out of the core. It
 * imports nothing of the rest of the library at run time and touches no
 * `window` or `document` until called, so a service worker and a content
 * script can both import it; a content script's bundle keeps only the page
 * side (`runPairingPage` and what it uses). No `chrome` types: the browser's
 * ports and senders are taken as the small structural types below.
 *
 * ```ts
 * // The content script, registered for the relay's /authorize page:
 * import { PAIRING_PORT, runPairingPage } from "@ractive-ch/tab-mcp-client/extension";
 * runPairingPage({ app: "my-app", connect: () => chrome.runtime.connect({ name: PAIRING_PORT }) });
 *
 * // The worker:
 * import { CodeFiller, PAIRING_PORT, pagePort } from "@ractive-ch/tab-mcp-client/extension";
 * const filler = new CodeFiller({ extensionId: chrome.runtime.id, app: "my-app", ... });
 * chrome.runtime.onConnect.addListener((port) => {
 *   if (port.name === PAIRING_PORT) void filler.page(pagePort(port));
 * });
 * ```
 */

import type { TabMcp } from "./tab-mcp.ts";
import type { PairingCode } from "./types.ts";

// --- What the content script and the worker say to each other ---

/** The name of the port a pairing page's content script opens. */
export const PAIRING_PORT = "pairing-page";

/** The relay's pairing page. */
export const PAIRING_PATH = "/authorize";

/** What the content script says once, on its page's port. */
export interface PairingHello {
	type: "pairing-page";
	/** This page load's own: the code comes back only with it. */
	nonce: string;
	/** `data-app`: the app the AI app asks to connect to. */
	app: string;
	/** `data-client-name`: the AI app's name for itself. */
	clientName: string;
	/** `data-client-host`: the host the relay verified for the AI app. */
	clientHost: string;
	/**
	 * The form's hidden `request_id`: the relay's id of this authorization
	 * request, the same on its page again after a wrong code. The one fill
	 * without a question is for this request only.
	 */
	requestId: string;
}

/** What the worker sends after the user's Allow: the code to fill in and submit. */
export interface FillMessage {
	type: "fill";
	nonce: string;
	code: string;
}

/** The longest name and host a hello may carry (the relay's own limits are lower). */
export const MAX_CLIENT_NAME = 200;
export const MAX_CLIENT_HOST = 253;

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * The content script's hello, checked; `undefined` for anything else. The
 * name and host are what the relay's page says, kept as they are: the
 * extension's question must show invisible characters escaped (`./visible`).
 */
export function parseHello(message: unknown): PairingHello | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const m = message as Record<string, unknown>;
	if (
		m["type"] !== "pairing-page" ||
		!isString(m["nonce"]) ||
		!/^[\w-]{16,64}$/.test(m["nonce"]) ||
		!isString(m["app"]) ||
		!isString(m["clientName"]) ||
		!isString(m["clientHost"]) ||
		m["clientHost"] === "" ||
		!isString(m["requestId"]) ||
		!/^[\w-]{1,128}$/.test(m["requestId"]) ||
		m["clientName"].length > MAX_CLIENT_NAME ||
		m["clientHost"].length > MAX_CLIENT_HOST
	)
		return undefined;
	return {
		type: "pairing-page",
		nonce: m["nonce"],
		app: m["app"],
		clientName: m["clientName"],
		clientHost: m["clientHost"],
		requestId: m["requestId"],
	};
}

/** The worker's fill message, checked against this page's nonce. */
export function parseFill(
	message: unknown,
	nonce: string,
): FillMessage | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const m = message as Record<string, unknown>;
	return m["type"] === "fill" &&
		m["nonce"] === nonce &&
		isString(m["code"]) &&
		m["code"] !== ""
		? { type: "fill", nonce, code: m["code"] }
		: undefined;
}

// --- Where the relay's pages are ---

/**
 * The origin of the relay's web pages for the relay address `relay`: its
 * `ws:`/`wss:` forms are the same server's `http:`/`https:`. `undefined` for
 * anything that is not one.
 */
export function relayPageOrigin(relay: string): string | undefined {
	let url: URL;
	try {
		url = new URL(relay);
	} catch {
		return undefined;
	}
	const scheme =
		url.protocol === "wss:"
			? "https:"
			: url.protocol === "ws:"
				? "http:"
				: url.protocol;
	if (scheme !== "https:" && scheme !== "http:") return undefined;
	return `${scheme}//${url.host}`;
}

/**
 * The match pattern for the relay's host, without its port: Firefox's
 * patterns take none, and Chrome's without one match every port. The exact
 * origin, port and all, is checked in the content script and in the worker.
 * The host in lower case without a trailing dot; one that is no plain name
 * or IPv4 address (an IPv6 literal, say) gives no pattern, as the browsers
 * do not agree on one for it.
 */
function hostPattern(relay: string, path: string): string | undefined {
	const origin = relayPageOrigin(relay);
	if (origin === undefined) return undefined;
	const { protocol, hostname } = new URL(origin);
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) return undefined;
	return `${protocol}//${host}${path}`;
}

/**
 * The host permission for the relay's site (`<scheme>://<host>/*`), the one
 * origin to ask for (`permissions.request({ origins: [it] })`) before the
 * extension can see the pairing page. `undefined` for an address that has
 * no pattern: the user types the code.
 */
export function relaySitePattern(relay: string): string | undefined {
	return hostPattern(relay, "/*");
}

/** The match pattern of the relay's pairing page, for a content script's `matches`. */
export function pairingPagePattern(relay: string): string | undefined {
	return hostPattern(relay, `${PAIRING_PATH}*`);
}

// --- The content script on the relay's page ---

/** The page's pairing form, as far as filling it in needs it. */
export interface PairingForm {
	form: HTMLFormElement;
	field: HTMLInputElement;
	button: HTMLButtonElement;
	app: string;
	clientName: string;
	clientHost: string;
	/** The relay's id of this request (the form's hidden `request_id`). */
	requestId: string;
}

/**
 * The pairing form of app `app` on `doc`, if this is a top-level page at
 * `/authorize` with exactly one such form that has a code field and a
 * Connect button (DEC-199's hooks, version 1). The worker checks the origin
 * itself; this only spares it the pages that are not one. A page that pairs
 * by sign-in only has no code field.
 */
export function findPairingForm(
	doc: Document,
	where: { topLevel: boolean; pathname: string },
	app: string,
): PairingForm | undefined {
	if (!where.topLevel || where.pathname !== PAIRING_PATH) return undefined;
	const forms = doc.querySelectorAll<HTMLFormElement>(
		'form[data-tab-mcp-pairing="1"]',
	);
	const [form] = forms;
	if (forms.length !== 1 || form === undefined) return undefined;
	if (form.dataset["app"] !== app) return undefined;
	const field = form.querySelector<HTMLInputElement>(
		'input[data-tab-mcp-field="code"]',
	);
	const button = form.querySelector<HTMLButtonElement>(
		'button[data-tab-mcp-action="connect"]',
	);
	const clientName = form.dataset["clientName"];
	const clientHost = form.dataset["clientHost"];
	const requestId = form.querySelector<HTMLInputElement>(
		'input[type="hidden"][name="request_id"]',
	)?.value;
	if (
		field === null ||
		button === null ||
		clientName === undefined ||
		clientHost === undefined ||
		clientHost === "" ||
		!requestId
	)
		return undefined;
	return { form, field, button, app, clientName, clientHost, requestId };
}

/**
 * Write `code` into the form's field and submit it with its Connect button:
 * the page's own post, as if the user had typed it and clicked.
 */
export function fillIn(found: PairingForm, code: string): void {
	found.field.value = code;
	// The document's own Event (a test's DOM need not be the global one).
	const Input = found.field.ownerDocument.defaultView?.Event ?? Event;
	found.field.dispatchEvent(new Input("input", { bubbles: true }));
	found.form.requestSubmit(found.button);
}

/** The hello for `found`, with this page load's nonce. */
export function helloFor(found: PairingForm, nonce: string): PairingHello {
	return {
		type: "pairing-page",
		nonce,
		app: found.app,
		clientName: found.clientName,
		clientHost: found.clientHost,
		requestId: found.requestId,
	};
}

/** The content script's end of its port (`chrome.runtime.Port` is one). */
export interface ContentPort {
	postMessage(message: unknown): void;
	readonly onMessage: {
		addListener(listener: (message: unknown) => void): void;
	};
}

/**
 * The content script of the relay's pairing page: if the page has app
 * `app`'s pairing form, open a port to the worker (`connect`, with the name
 * PAIRING_PORT), say who asks, and wait. Only the worker's fill with this
 * page load's nonce is taken, once: its code is written into the field and
 * the form submitted. Once per document, also if the script is put in again
 * (after the user gave access with the page already open). Whether the
 * page has the form. `page` is the content script's own page unless a test
 * gives one.
 */
export function runPairingPage(options: {
	app: string;
	connect: () => ContentPort;
	page?: { document: Document; topLevel: boolean; pathname: string };
}): boolean {
	const flag = "__tabMcpPairingPage";
	// A content script put in again runs in the same isolated world, so its
	// global marks the document. The document a test gives carries the mark
	// itself: two such pages in one test are independent.
	const scope = (options.page?.document ?? globalThis) as unknown as Record<
		string,
		unknown
	>;
	if (scope[flag] === true) return false;
	scope[flag] = true;
	const page = options.page ?? {
		document,
		topLevel: window.top === window,
		pathname: location.pathname,
	};
	const found = findPairingForm(page.document, page, options.app);
	if (found === undefined) return false;
	const nonce = crypto.randomUUID();
	const port = options.connect();
	let filled = false;
	port.onMessage.addListener((message) => {
		const fill = parseFill(message, nonce);
		// One fill per page load: the page posts and goes.
		if (fill === undefined || filled) return;
		filled = true;
		fillIn(found, fill.code);
	});
	port.postMessage(helloFor(found, nonce));
	return true;
}

// --- The worker ---

/** The sender of a port, as far as the check needs it (`chrome.runtime.MessageSender`). */
export interface PageSender {
	id?: string;
	url?: string;
	/** Chrome gives the document's origin; Firefox may not. */
	origin?: string;
	tab?: unknown;
	frameId?: number;
}

/**
 * A port from the pairing page of the relay at `relayOrigin`: this
 * extension's content script, in a tab, in its top frame, on a page whose
 * origin is exactly the relay's (port included) and whose path is
 * `/authorize`. A page anywhere else can carry the same markup: it is
 * ignored.
 */
export function isPairingSender(
	sender: PageSender,
	extensionId: string,
	relayOrigin: string | undefined,
): boolean {
	if (relayOrigin === undefined) return false;
	if (sender.id !== extensionId) return false;
	if (sender.tab === undefined || sender.frameId !== 0) return false;
	// Where the browser gives the document's origin, it is the one to trust
	// (a URL can be a `blob:` or `about:` of another origin's making).
	if (sender.origin !== undefined && sender.origin !== relayOrigin)
		return false;
	try {
		const url = new URL(sender.url ?? "");
		return url.origin === relayOrigin && url.pathname === PAIRING_PATH;
	} catch {
		return false;
	}
}

/** A page will not say who asks in this time: it is dropped. */
export const HELLO_WAIT_MS = 5_000;
/**
 * The same request's page in the same tab within this time after a fill is
 * the relay's answer to it: the code was not taken.
 */
export const RETRY_WINDOW_MS = 30_000;
/** `takeCode`: how long to wait for the next code. */
export const CODE_WAIT_MS = 10_000;
/** `takeCode`: a code with less time left than this is not used, the next one is. */
export const MIN_CODE_LEFT_MS = 5_000;
/**
 * A filled-in page's port is closed this long after the fill: the page has
 * posted by then, and its answer, if any, is a new document with a port of
 * its own.
 */
export const FILLED_CLOSE_MS = 5_000;

/** The worker's end of a page's port (`chrome.runtime.Port` is one). */
export interface WorkerPort {
	readonly sender?: PageSender;
	postMessage(message: unknown): void;
	disconnect(): void;
	readonly onMessage: {
		addListener(listener: (message: unknown) => void): void;
		removeListener(listener: (message: unknown) => void): void;
	};
	readonly onDisconnect: { addListener(listener: () => void): void };
}

/**
 * A pairing page's port in the worker. Its first message and its end are
 * taken from the moment it connects: the worker may still be starting, and
 * Chrome hands a message only to the listeners there are.
 */
export interface PagePort {
	readonly sender: PageSender;
	/** The first message; `undefined` if the port went before one came. */
	readonly hello: Promise<unknown>;
	/** Aborted when the page goes (or the worker closes the port). */
	readonly signal: AbortSignal;
	send(message: FillMessage): void;
	close(): void;
}

/**
 * `port`, taken over at once (see PagePort): call it in `onConnect` itself,
 * before any `await`.
 */
export function pagePort(port: WorkerPort): PagePort {
	const gone = new AbortController();
	let first: (message: unknown) => void = () => {};
	const hello = new Promise<unknown>((resolve) => {
		first = resolve;
	});
	const take = (message: unknown) => {
		port.onMessage.removeListener(take);
		first(message);
	};
	port.onMessage.addListener(take);
	port.onDisconnect.addListener(() => {
		gone.abort();
		first(undefined);
	});
	return {
		sender: port.sender ?? {},
		hello,
		signal: gone.signal,
		send: (message) => {
			try {
				port.postMessage(message);
			} catch {
				// The page went meanwhile.
			}
		},
		close: () => {
			if (gone.signal.aborted) return;
			// Our own `disconnect()` fires no `onDisconnect` here.
			gone.abort();
			first(undefined);
			try {
				port.disconnect();
			} catch {
				// Gone already.
			}
		},
	};
}

/**
 * The user's answer to "Connect <name> (<host>)?": only `allow` fills in.
 * `busy`: the extension could not ask (too many questions wait); the page is
 * reported (`failed("busy")`), not dropped unseen.
 */
export type FillAnswer = "allow" | "deny" | "timeout" | "busy";

/** Why a page that asked got no code: the extension tells its user. */
export type FillFailure =
	/** It could not be asked about (`ask` answered `busy`). */
	| "busy"
	/** Allow, but no code came from the relay (`code` gave none). */
	| "no-code";

/** The page a fill is for: its tab and the AI app that asks there. */
export interface FillContext {
	tabId: number;
	/** The AI app's own name (may be `""`) and the host the relay verified, as `ask` gets them. */
	client: { name: string; host: string };
}

/** What `CodeFiller` needs from the extension: its parts of the fill-in. */
export interface FillHost {
	/** This extension's id (`chrome.runtime.id`): only its own content script speaks. */
	extensionId: string;
	/** The app id of the extension's page: only forms with this `data-app`. */
	app: string;
	/**
	 * The origin of the relay's pages (`relayPageOrigin`) whose pairing page
	 * may be filled in; `undefined` for none (another relay than the one the
	 * extension fills in for).
	 */
	relayOrigin(): string | undefined;
	/** AI access is on: connected, or on its way. Off, nothing is asked. */
	aiOn(): boolean;
	/** The user turned filling in on, for this relay (opt-in, off by default). */
	enabled(): boolean;
	/**
	 * Ask the user whether to connect the AI app `client` (its own name for
	 * itself and the host the relay verified, both to be shown with invisible
	 * characters escaped) in tab `tabId`. `signal` withdraws the question:
	 * the page went, AI access or the setting went off, the relay changed,
	 * or the AI app connected meanwhile; answer then with anything but
	 * `allow`.
	 */
	ask(
		tabId: number,
		client: { name: string; host: string },
		signal: AbortSignal,
	): Promise<FillAnswer>;
	/**
	 * The code to fill in now on the page `context`, with pairing held on for
	 * the relay to check it (`takeCode`); `undefined` if none came or
	 * `signal` aborted (the page went, or the fill was withdrawn as a
	 * question is). Even with a code, nothing is sent if what holds for
	 * asking no longer does.
	 */
	code(signal: AbortSignal, context: FillContext): Promise<string | undefined>;
	/**
	 * No fill needs pairing held on any more: a filled-in code paired its AI
	 * app, or a fill ended without sending its code (withdrawn, the page
	 * went, no code) while no other fill is under way or waits for the
	 * relay's check. It may come again with nothing held: ignore it then.
	 */
	release(): void;
	/** The page `context` filled in nothing for `why`, or was not asked about: say so. */
	failed(why: FillFailure, context: FillContext): void;
	/** The clock (`Date.now`; a test's own). */
	now(): number;
}

/** A page whose question waits. */
interface Waiting {
	host: string;
	withdraw: AbortController;
}

/** The last fill in a tab. */
interface Filled {
	/** The relay's id of the request filled in. */
	requestId: string;
	host: string;
	/** Fills for it so far: 1 after Allow, 2 after the one more. */
	count: number;
	at: number;
}

const tabIdOf = (sender: PageSender): number | undefined => {
	const id = (sender.tab as { id?: unknown } | undefined)?.id;
	return typeof id === "number" ? id : undefined;
};

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/**
 * The worker's side of filling in the code (DEC-199, DEC-203): a page's port
 * is taken only from this extension's content script in the top frame of a
 * tab at exactly the relay's origin, and only while AI access is on and the
 * user turned filling in on. Then the user is asked, with the AI app's
 * verified host; on Allow the code goes to that one page, which fills it in
 * and submits.
 *
 * No loops: one question per page load (one port per document, one hello
 * per port). When the same tab shows the page of the same request (the
 * relay's `request_id`) again soon after a fill, it is the relay's answer
 * that the code was not taken (it had just changed): filled once more with
 * the code of then, without asking; the time after, nothing. Any other
 * request asks. With `retry: false` that page is asked about like any
 * other: every fill has a yes of its own. Don't allow, a timeout, the page
 * going, AI access or the setting going off, another relay or the AI app
 * connecting meanwhile fill nothing, and typing by hand works as before.
 */
export class CodeFiller {
	readonly #host: FillHost;
	readonly #waiting = new Set<Waiting>();
	/**
	 * By tab: what was filled in there last, or is being filled in (marked
	 * before the wait for the code, so that a page of the same request
	 * meanwhile counts it).
	 */
	readonly #filled = new Map<number, Filled>();
	/**
	 * The grants seen so far: a new one is an AI app that just connected.
	 * `undefined` until the first list, which is taken as it is: a worker
	 * that starts before its connection is up has none to compare with.
	 */
	#grants: Set<string> | undefined;
	readonly #closeAfterMs: number;
	readonly #retry: boolean;

	/**
	 * `grants`: the ids of the grants there are already, if the extension kept
	 * them between worker starts (not new when listed again); without them,
	 * the first `grantsChanged` is taken as the list there is, nothing in it
	 * new. `retry`: the one more fill without asking when the same request's
	 * page comes back to the same tab soon after a fill (on unless `false`;
	 * off, that page is asked about like any other, one question per page
	 * load, and never filled without a yes). `closeAfterMs`: FILLED_CLOSE_MS
	 * unless a test's is shorter.
	 */
	constructor(
		host: FillHost,
		options: {
			grants?: Iterable<string>;
			retry?: boolean;
			closeAfterMs?: number;
		} = {},
	) {
		this.#host = host;
		this.#grants =
			options.grants === undefined ? undefined : new Set(options.grants);
		this.#retry = options.retry ?? true;
		this.#closeAfterMs = options.closeAfterMs ?? FILLED_CLOSE_MS;
	}

	/**
	 * A pairing page's port: checked, then asked about and maybe filled in.
	 * Never rejects: a host callback that throws fills nothing, closes the
	 * port and is logged.
	 */
	async page(port: PagePort): Promise<void> {
		try {
			await this.#page(port);
		} catch (error) {
			console.warn("tab-mcp: pairing page", error);
			port.close();
		}
	}

	async #page(port: PagePort): Promise<void> {
		const host = this.#host;
		const tabId = tabIdOf(port.sender);
		if (
			tabId === undefined ||
			!isPairingSender(port.sender, host.extensionId, host.relayOrigin())
		) {
			port.close();
			return;
		}
		const hello = parseHello(await within(port.hello, HELLO_WAIT_MS));
		// Only this extension's own app, only if the user turned filling in
		// on, only while AI access is on, and only while the relay is still
		// the one the page is of (it may have changed during the wait for
		// the hello): otherwise they have not asked for it.
		if (
			hello === undefined ||
			hello.app !== host.app ||
			port.signal.aborted ||
			!host.enabled() ||
			!host.aiOn() ||
			!isPairingSender(port.sender, host.extensionId, host.relayOrigin())
		) {
			port.close();
			return;
		}
		const context: FillContext = {
			tabId,
			client: { name: hello.clientName, host: hello.clientHost },
		};
		const before = this.#lastFill(tabId);
		if (this.#retry && before?.requestId === hello.requestId) {
			// The same request's page again after a fill: the code was not
			// taken. Once more with the code of now, then never again for it.
			if (before.count === 1) await this.#fill(port, context, hello, 2);
			else port.close();
			return;
		}
		const waiting: Waiting = {
			host: hello.clientHost,
			withdraw: new AbortController(),
		};
		this.#waiting.add(waiting);
		const signal = AbortSignal.any([port.signal, waiting.withdraw.signal]);
		let answer: FillAnswer;
		try {
			answer = await host.ask(tabId, { ...context.client }, signal);
		} finally {
			this.#waiting.delete(waiting);
		}
		// Too many questions wait: not dropped unseen.
		if (answer === "busy") host.failed("busy", context);
		if (
			answer !== "allow" ||
			signal.aborted ||
			!host.enabled() ||
			!host.aiOn() ||
			!isPairingSender(port.sender, host.extensionId, host.relayOrigin())
		) {
			port.close();
			return;
		}
		await this.#fill(port, context, hello, 1);
	}

	/**
	 * Whether a fill is under way or was sent recently enough for the relay
	 * to be checking its code (the tabs' last fills, the stale ones dropped).
	 */
	#anyFill(): boolean {
		this.#dropStale();
		return this.#filled.size > 0;
	}

	/** The last fill in `tabId`, if it is recent enough to be answered by this page. */
	#lastFill(tabId: number): Filled | undefined {
		this.#dropStale();
		return this.#filled.get(tabId);
	}

	#dropStale(): void {
		const now = this.#host.now();
		for (const [id, filled] of this.#filled)
			if (now - filled.at > RETRY_WINDOW_MS) this.#filled.delete(id);
	}

	/**
	 * Fill `count` (1 after Allow, 2 the one more) of `hello`'s request in
	 * `tabId`. The wait for the code is withdrawn like a question, and what
	 * holds for asking is checked again once the code is there.
	 */
	async #fill(
		port: PagePort,
		context: FillContext,
		hello: PairingHello,
		count: number,
	): Promise<void> {
		const host = this.#host;
		const { tabId } = context;
		const before = this.#filled.get(tabId);
		// Marked before the wait: a page of the same request that comes
		// meanwhile sees this count, so there is never a third fill.
		const mark: Filled = {
			requestId: hello.requestId,
			host: hello.clientHost,
			count,
			at: host.now(),
		};
		this.#filled.set(tabId, mark);
		const waiting: Waiting = {
			host: hello.clientHost,
			withdraw: new AbortController(),
		};
		this.#waiting.add(waiting);
		const signal = AbortSignal.any([port.signal, waiting.withdraw.signal]);
		let sent = false;
		// A page that went or a code that did not come leaves the tab's last
		// fill as it was; a withdrawal leaves nothing to fill once more.
		let keepBefore = true;
		try {
			const code = await host.code(signal, {
				tabId,
				client: { ...context.client },
			});
			const off =
				waiting.withdraw.signal.aborted ||
				!host.enabled() ||
				!host.aiOn() ||
				!isPairingSender(port.sender, host.extensionId, host.relayOrigin());
			if (off) keepBefore = false;
			if (off || port.signal.aborted) return;
			if (code === undefined) {
				host.failed("no-code", { tabId, client: { ...context.client } });
				return;
			}
			mark.at = host.now();
			port.send({ type: "fill", nonce: hello.nonce, code });
			sent = true;
			setTimeout(() => port.close(), this.#closeAfterMs);
		} finally {
			this.#waiting.delete(waiting);
			if (!sent) {
				port.close();
				if (this.#filled.get(tabId) === mark) {
					if (keepBefore && before !== undefined)
						this.#filled.set(tabId, before);
					else this.#filled.delete(tabId);
				}
				// `code` may have held pairing on for this fill: with no other
				// fill to hold it for, the host need not keep it on.
				if (!this.#anyFill()) host.release();
			}
		}
	}

	/**
	 * The relay's list of grants (`grantschange`): an AI app that just
	 * connected (typed by hand, or filled in) withdraws the questions for its
	 * host, and its fills are done with.
	 */
	grantsChanged(grants: readonly { grantId: string; host: string }[]): void {
		if (this.#grants === undefined) {
			// The first list without a seed: the grants there are, none new.
			this.#grants = new Set(grants.map((grant) => grant.grantId));
			return;
		}
		const connected = new Set<string>();
		for (const grant of grants)
			if (!this.#grants.has(grant.grantId)) {
				this.#grants.add(grant.grantId);
				connected.add(grant.host);
			}
		if (connected.size === 0) return;
		for (const waiting of this.#waiting)
			if (connected.has(waiting.host)) waiting.withdraw.abort();
		let done = false;
		for (const [tabId, filled] of this.#filled)
			if (connected.has(filled.host)) {
				this.#filled.delete(tabId);
				done = true;
			}
		// Another AI app's fill may still be under way or wait for the relay's
		// check: stopping pairing now would void its code.
		if (done && !this.#anyFill()) this.#host.release();
	}

	/**
	 * AI access off, or filling in turned off: the questions waiting are
	 * withdrawn and no page gets the one more fill.
	 */
	withdrawAll(): void {
		for (const waiting of this.#waiting) waiting.withdraw.abort();
		this.#filled.clear();
	}

	/**
	 * Another relay: no page of the one before is asked about or filled in,
	 * and the new relay's first list of grants is taken as it is.
	 */
	reset(): void {
		this.withdrawAll();
		this.#grants = undefined;
	}
}

/** Where the pairing codes come from (`pairingCodes(mcp)`). */
export interface CodeSource {
	current(): PairingCode | undefined;
	/** Call `listener` on every new code (or none); returns how to stop. */
	onChange(listener: () => void): () => void;
}

/** The pairing codes of the extension's `TabMcp`, for `takeCode`. */
export function pairingCodes(
	mcp: Pick<TabMcp, "pairingCode" | "addEventListener" | "removeEventListener">,
): CodeSource {
	return {
		current: () => mcp.pairingCode,
		onChange: (listener) => {
			mcp.addEventListener("pairingcode", listener);
			return () => mcp.removeEventListener("pairingcode", listener);
		},
	};
}

/**
 * The code to fill in. The current one if it has `minLeftMs` left by this
 * clock (or an expiry that cannot be read); else the next one the relay
 * sends, which is fresh whatever the clocks say. The same code sent again
 * is not the next one: the relay answers each `pairing.start` with the code
 * it shows, so `startPairing()` with pairing on already brings back the
 * code that is about to change; it counts only if its expiry now leaves
 * `minLeftMs`. If no next one comes within `waitMs`, the current one after
 * all: with this clock ahead every code would look expired, so the fill
 * then waits the whole `waitMs` before it gets that code. The relay
 * refuses a code that has expired; the one more fill for the same request
 * covers that, or with `retry: false` a new question. `undefined` only
 * without any code, or when `signal` aborts. Pairing must be on
 * (`startPairing()`) for codes to come.
 */
export function takeCode(
	source: CodeSource,
	signal: AbortSignal,
	options: { now: number; waitMs?: number; minLeftMs?: number },
): Promise<string | undefined> {
	const { waitMs = CODE_WAIT_MS, minLeftMs = MIN_CODE_LEFT_MS } = options;
	// `now` is the caller's clock; the time since is the real one's.
	const started = Date.now();
	const leaves = (code: PairingCode) =>
		!(
			Date.parse(code.expiresAt) - (options.now + Date.now() - started) <
			minLeftMs
		);
	const current = source.current();
	if (current !== undefined && leaves(current))
		return Promise.resolve(current.code);
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const done = (code: string | undefined) => {
			clearTimeout(timer);
			stop();
			signal.removeEventListener("abort", aborted);
			resolve(code);
		};
		const stop = source.onChange(() => {
			const next = source.current();
			if (next !== undefined && (next.code !== current?.code || leaves(next)))
				done(next.code);
		});
		const aborted = () => done(undefined);
		const timer = setTimeout(() => done(source.current()?.code), waitMs);
		signal.addEventListener("abort", aborted, { once: true });
	});
}
