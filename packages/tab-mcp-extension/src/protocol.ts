/**
 * What the side panel and the service worker say to each other, and who may
 * say what (DEC-116). The connection lives in the service worker; the side
 * panel is a view that sends commands over one named port and gets the state
 * back. Content scripts reach the same `chrome.runtime` events, so every
 * message is checked for its sender: a content script may only say that its
 * page's tools changed.
 */

import type { ContentEvent } from "./messages.ts";

/** The name of the side panel's port (`chrome.runtime.connect`). */
export const PANEL_PORT = "panel";

/** The side panel's page in the build. */
export const PANEL_PATH = "/sidepanel/index.html";

/** A question's answer: Always allow holds for the tool and AI app on this page. */
export type Answer = "allow" | "always" | "deny";

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
	| { type: "new-address" }
	| { type: "set-relay"; relay: string }
	| { type: "set-allowed"; origin: string; name: string; on: boolean }
	| { type: "answer"; id: string; answer: Answer };

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
	/** The site the tool acts on. */
	origin?: string;
	/** The arguments as JSON, invisible characters written as `\uXXXX`. */
	args: string;
	/** "Always allow" is offered (a page of an http(s) site). */
	always: boolean;
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
	title: string;
	host: string;
	/** `undefined`: the extension may not read it, `access` says why. */
	webmcp?: { available: boolean; tools: number };
	access: string;
	origin?: string;
	tools: ToolView[];
	/**
	 * Its tools can be "allowed" (a page of an http(s) site; an opaque origin,
	 * "null", would share one entry with every other).
	 */
	canAllow: boolean;
	/** Tools the page's own tab-mcp connection offers, left out. */
	mirrored: number;
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
	/** "Allow on all sites" is granted. */
	allSites: boolean;
	tab?: TabView;
	questions: QuestionView[];
}

/** From the service worker. */
export type WorkerMessage = { type: "state"; state: PanelState };

/** The sender of a message or port, as far as the checks need it. */
export interface Sender {
	id?: string;
	url?: string;
	tab?: unknown;
}

/**
 * A port from the side panel: this extension's page at the panel's path, not
 * in a tab. A content script's port has `tab`, and its `url` is the page's.
 */
export function isPanelSender(sender: Sender, extensionId: string): boolean {
	if (sender.id !== extensionId || sender.tab !== undefined) return false;
	try {
		const url = new URL(sender.url ?? "");
		return (
			url.protocol === "chrome-extension:" &&
			url.host === extensionId &&
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

const isString = (value: unknown): value is string => typeof value === "string";

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
		case "new-address":
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
		case "answer":
			return isString(m["id"]) &&
				(m["answer"] === "allow" ||
					m["answer"] === "always" ||
					m["answer"] === "deny")
				? { type: "answer", id: m["id"], answer: m["answer"] }
				: undefined;
		default:
			return undefined;
	}
}
