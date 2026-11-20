/**
 * Filling in the extension's own pairing code on the relay's pairing page
 * (`/authorize`) when an AI app opens it in this browser (DEC-199, DEC-203).
 * What the content script of that page, the service worker and the side
 * panel share: where the page is, who may speak for it, and what is said.
 *
 * The relay's page has no scripts (DEC-057), so it cannot call the extension:
 * a content script reads the form's `data-tab-mcp-*` hooks and tells the
 * worker who asks (the AI app's name and verified host). The worker asks its
 * user and, on Allow, hands the code to that one page over its port. The
 * content script never sees a code before that, and the worker never takes a
 * page's word for where it is: any site can copy the markup, so the origin
 * Chrome reports for the port is the check.
 */

/** The name of the port a pairing page's content script opens. */
export const PAIRING_PORT = "pairing-page";

/** The content script for the pairing page in the build, and its registration id. */
export const PAIRING_SCRIPT = "pairing.js";
export const PAIRING_SCRIPT_ID = "tab-mcp-pairing-page";

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
 */
function hostPattern(relay: string, path: string): string | undefined {
	const origin = relayPageOrigin(relay);
	if (origin === undefined) return undefined;
	const { protocol, hostname } = new URL(origin);
	return `${protocol}//${hostname}${path}`;
}

/**
 * The host access that lets the extension see the relay's pages: one origin
 * of its optional host permissions (`http://*` and `https://*`), asked for
 * with a click in the panel. `undefined` for an address that has none.
 */
export function fillAccess(
	relay: string,
): chrome.permissions.Permissions | undefined {
	const pattern = hostPattern(relay, "/*");
	return pattern === undefined ? undefined : { origins: [pattern] };
}

/** Where the pairing page's content script is registered: the page only. */
export function pairingMatches(relay: string): string[] {
	const pattern = hostPattern(relay, `${PAIRING_PATH}*`);
	return pattern === undefined ? [] : [pattern];
}

/** The sender of a port, as far as the check needs it. */
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

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * The content script's hello, checked; `undefined` for anything else. The
 * name and host are what the relay's page says, kept as they are (the
 * question shows invisible characters escaped).
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
