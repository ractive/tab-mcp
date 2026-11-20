/**
 * What the side panel and the service worker say to each other, and who may
 * say what (DEC-116). The connection lives in the service worker; the side
 * panel is a view that sends commands over one named port and gets the state
 * back. Content scripts reach the same `chrome.runtime` events, so every
 * message is checked for its sender: a content script may only say that its
 * page's tools changed.
 */

import { FIREFOX, PRODUCT } from "./browser.ts";
import type { ContentEvent } from "./messages.ts";
import type { NoAccessReason } from "./tabs.ts";

/**
 * The extension's MCP server name: the worker's connection gives it to the
 * relay, and the side panel's setup commands name the server by it (its own
 * in the Firefox build, so one AI app can pair with both browsers).
 */
export const SERVER_NAME = FIREFOX
	? "tab-mcp-browser-extension-firefox"
	: "tab-mcp-browser-extension";

/**
 * The extension's app id: its MCP address is `<relay>/s/<APP_ID>/mcp`, the
 * same for everyone who has the extension (DEC-196); the code pairs an AI app
 * with one installation. Its own in the Firefox build, like the server name.
 * Set here because the Firefox server name is longer than an app id may be.
 */
export const APP_ID = FIREFOX
	? "tab-mcp-extension-firefox"
	: "tab-mcp-extension";

/** The name of the side panel's port (`chrome.runtime.connect`). */
export const PANEL_PORT = "panel";

/** The side panel's page in the build. */
export const PANEL_PATH = "/sidepanel/index.html";

/** A question nobody answers in this time is Don't allow. */
export const QUESTION_TIMEOUT_MS = 60_000;

/**
 * A question's answer: `site` is "Always allow on <host>", which allows
 * the tool on its site (the panel's "allowed"), for every AI app.
 */
export type Answer = "allow" | "site" | "deny";

/** From the side panel. */
export type PanelCommand =
	/** The panel opened in window `windowId`. */
	| { type: "hello"; windowId: number }
	/**
	 * Whether the panel is on screen: another extension's panel for the tab
	 * (Claude in Chrome's) can cover it while it stays open.
	 */
	| { type: "visible"; visible: boolean }
	/** AI access on (the panel's button: the user's click). */
	| { type: "connect" }
	/** AI access off. */
	| { type: "stop" }
	/** The pairing view opened (`on`) or closed: codes only while it is open. */
	| { type: "pair"; on: boolean }
	| { type: "revoke"; grantId: string }
	| { type: "disconnect-all" }
	| { type: "set-relay"; relay: string }
	| { type: "set-allowed"; origin: string; name: string; on: boolean }
	/**
	 * "Allow all" (or "Ask for all") for the tools listed on `origin`: the
	 * worker takes only the names it offers there itself.
	 */
	| { type: "set-allowed-all"; origin: string; names: string[]; on: boolean }
	| { type: "answer"; id: string; answer: Answer }
	/**
	 * Filling in the code on the relay's pairing page on or off (DEC-203):
	 * on only after the panel got the relay's site from the user.
	 */
	| { type: "set-fill"; on: boolean };

/** A connected AI app. */
export interface GrantView {
	grantId: string;
	/** Its self-declared name ("" if none). */
	name: string;
	/** The host of its client id: the verified part. */
	host: string;
}

/** A question waiting for the user (a tool that asks first). */
export interface QuestionView {
	id: string;
	/** The AI app: its declared name and verified host. */
	app: string;
	host: string;
	/** The page's tool: its name for the AI app, and its title. */
	tool: string;
	title?: string;
	/** The site the tool acts on (a navigation: the one the tab is on). */
	origin?: string;
	/**
	 * A navigation to another site (iteration 27): the address the tab would
	 * go to, or what is known of it (back or forward).
	 */
	navigation?: { to: string };
	/**
	 * Not a tool: whether to fill in the extension's code on the relay's
	 * pairing page for this AI app (DEC-203). `name` is its own name for
	 * itself ("" if none); `host` above is the one the relay verified.
	 */
	pairing?: { name: string };
	/** The arguments as JSON, invisible characters written as `\uXXXX`. */
	args: string;
	/** "Always allow on <host>" is offered (a page tool of an http(s) site). */
	site: boolean;
	/** When it ends unanswered as Don't allow (epoch ms, the worker's clock). */
	expiresAt: number;
}

/** A page tool as the panel lists it. */
export interface ToolView {
	name: string;
	title?: string;
	readOnly: boolean;
	/** Why it is not offered. */
	problem?: string;
	/** Allowed to run without asking on this site. */
	allowed: boolean;
}

/** The tab in front, as the panel shows it. */
export interface TabView {
	/**
	 * The page announced the client library (DEC-205), with the AI apps
	 * connected to it directly (the page's word).
	 */
	library?: { apps: { name: string; host: string }[] };
	title: string;
	host: string;
	/** `undefined`: the extension may not read it, `noAccess` or `access` says why. */
	webmcp?: { available: boolean; tools: number };
	/** Why it may not be read, for the panel to put in its own words (EQ 6). */
	noAccess?: NoAccessReason;
	/** Any other reason it could not be read (a page that did not answer). */
	access: string;
	origin?: string;
	tools: ToolView[];
	/**
	 * Its tools can be "allowed" (a page of an http(s) site; an opaque origin,
	 * "null", would share one entry with every other).
	 */
	canAllow: boolean;
}

/** Everything the panel shows. */
export interface PanelState {
	relay: string;
	/** off, connecting, retrying, waiting (on, no app yet), on. */
	status: "off" | "connecting" | "retrying" | "waiting" | "on";
	address?: string;
	grants: GrantView[];
	pairing: boolean;
	code?: string;
	/** The last error, until the next connection. */
	problem?: string;
	/** Another tab or program took the address over. */
	replaced?: { sibling: boolean };
	/** Host access on all sites ("Give access to all sites") is granted. */
	allSites: boolean;
	/** Filling in the code on the relay's pairing page is on (DEC-203). */
	fillCode?: boolean;
	tab?: TabView;
	/**
	 * Without their arguments, which can be large: each question's come once
	 * per panel, in a `question-args` message before the first state that
	 * lists it.
	 */
	questions: QuestionSummary[];
	/** The questions that ran out unanswered in the last few seconds (EQ 13). */
	expired: string[];
}

/** A question as the repeated state lists it: all but its arguments. */
export type QuestionSummary = Omit<QuestionView, "args">;

/** From the service worker. */
export type WorkerMessage =
	| { type: "state"; state: PanelState }
	/** A question's arguments, in full, once per panel. */
	| { type: "question-args"; id: string; args: string };

/**
 * What a panel shows when the worker could not start: the problem, and
 * nothing else to act on. The panel's next message or a panel that opens
 * tries again (`attachPanel`); a start that a Chrome event made meanwhile
 * attaches the panel at its next message.
 */
export function startProblem(error: unknown): PanelState {
	const why = error instanceof Error ? error.message : String(error);
	return {
		relay: "",
		status: "off",
		grants: [],
		pairing: false,
		problem: `The ${PRODUCT} could not start: ${why}. Close and open this panel to try again.`,
		allSites: false,
		questions: [],
		expired: [],
	};
}

/** The sender of a message or port, as far as the checks need it. */
export interface Sender {
	id?: string;
	url?: string;
	tab?: unknown;
	frameId?: number;
}

/**
 * A port from the side panel: this extension's page at the panel's path, not
 * in a tab. A content script's port has `tab`, and its `url` is the page's.
 * `origin`: the extension's pages' origin, `chrome-extension://<id>` unless
 * given (Firefox's is `moz-extension://<a UUID of this installation>`, not
 * the id). `inTab`: a panel page in a tab counts too (the Firefox test build).
 */
export function isPanelSender(
	sender: Sender,
	extensionId: string,
	options: { origin?: string; inTab?: boolean } = {},
): boolean {
	if (sender.id !== extensionId) return false;
	if (sender.tab !== undefined && !options.inTab) return false;
	try {
		const url = new URL(sender.url ?? "");
		// Not `url.origin`: it is "null" for these schemes in some engines.
		return (
			`${url.protocol}//${url.host}` ===
				(options.origin ?? `chrome-extension://${extensionId}`) &&
			url.pathname === PANEL_PATH
		);
	} catch {
		return false;
	}
}

/**
 * A one-off message (`runtime.sendMessage`) the service worker acts on: only
 * a content script's `webmcp-changed`, from a tab. Everything else, from
 * anyone, is ignored: commands come only over the panel's port.
 */
export function isContentEvent(
	message: unknown,
	sender: Sender,
	extensionId: string,
): message is ContentEvent {
	return (
		sender.id === extensionId &&
		sender.tab !== undefined &&
		typeof message === "object" &&
		message !== null &&
		(message as { type?: unknown }).type === "webmcp-changed"
	);
}

/**
 * A content script asks what the extension tells a page that announced the
 * client library (DEC-205): from this extension's content script in a tab's
 * top frame only, as only that one speaks to pages.
 */
export function isHandshakeAsk(
	message: unknown,
	sender: Sender,
	extensionId: string,
): boolean {
	return (
		sender.id === extensionId &&
		sender.tab !== undefined &&
		sender.frameId === 0 &&
		typeof message === "object" &&
		message !== null &&
		(message as { type?: unknown }).type === "handshake"
	);
}

const isString = (value: unknown): value is string => typeof value === "string";

/** At most this many names in "Allow all" (the bridge lists at most 64 tools). */
const MAX_NAMES = 64;

/** A panel command, checked; `undefined` for anything else. */
export function parseCommand(message: unknown): PanelCommand | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const m = message as Record<string, unknown>;
	switch (m["type"]) {
		case "hello":
			return Number.isInteger(m["windowId"])
				? { type: "hello", windowId: m["windowId"] as number }
				: undefined;
		case "visible":
			return typeof m["visible"] === "boolean"
				? { type: "visible", visible: m["visible"] }
				: undefined;
		case "connect":
		case "stop":
		case "disconnect-all":
			return { type: m["type"] };
		case "pair":
			return typeof m["on"] === "boolean"
				? { type: "pair", on: m["on"] }
				: undefined;
		case "revoke":
			return isString(m["grantId"])
				? { type: "revoke", grantId: m["grantId"] }
				: undefined;
		case "set-relay":
			return isString(m["relay"])
				? { type: "set-relay", relay: m["relay"] }
				: undefined;
		case "set-allowed":
			return isString(m["origin"]) &&
				isString(m["name"]) &&
				typeof m["on"] === "boolean"
				? {
						type: "set-allowed",
						origin: m["origin"],
						name: m["name"],
						on: m["on"],
					}
				: undefined;
		case "set-allowed-all":
			return isString(m["origin"]) &&
				Array.isArray(m["names"]) &&
				m["names"].length <= MAX_NAMES &&
				m["names"].every(isString) &&
				typeof m["on"] === "boolean"
				? {
						type: "set-allowed-all",
						origin: m["origin"],
						names: [...(m["names"] as string[])],
						on: m["on"],
					}
				: undefined;
		case "answer":
			return isString(m["id"]) &&
				(m["answer"] === "allow" ||
					m["answer"] === "site" ||
					m["answer"] === "deny")
				? { type: "answer", id: m["id"], answer: m["answer"] }
				: undefined;
		case "set-fill":
			return typeof m["on"] === "boolean"
				? { type: "set-fill", on: m["on"] }
				: undefined;
		default:
			return undefined;
	}
}
