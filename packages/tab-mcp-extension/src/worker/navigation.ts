/**
 * The navigation tools (iteration 27, DEC-121): `navigate`, `go_back`,
 * `go_forward` and `reload`, for the tab in front, and only while the
 * extension may read it. Within the page's origin they run at once (a link
 * on the page could do the same, and Chrome keeps the extension's access
 * there); to another origin they ask the user first, with Allow and Don't
 * allow only, since a page's result could tell the AI app to go anywhere.
 * A back or forward whose target the content script cannot see (the
 * Navigation API lists only the page's own origin) counts as another origin.
 * Each tool waits for the page to load and answers with its `page_info`, or
 * with why the extension may not read it.
 */

import type { Tool, ToolExecuteOptions } from "@ractive-ch/tab-mcp-client";
import type { PageHistory, PageInfo } from "../messages.ts";
import type { Answer } from "../protocol.ts";
import type { TargetTab } from "../tabs.ts";
import {
	type AppRequest,
	MAX_QUESTIONS_PER_APP,
	QUESTION_TIMEOUT_MS,
} from "./questions.ts";

/** A navigation that has not loaded in this time answers that it is still loading. */
export const LOAD_TIMEOUT_MS = 30_000;
/**
 * A navigation that does not start loading within this time counts as done:
 * one within the document (`#section`) never does.
 */
export const QUIET_MS = 1_000;
/** An address longer than this is not opened. */
export const MAX_URL = 8192;

export const NAVIGATION_TOOL_NAMES = [
	"navigate",
	"go_back",
	"go_forward",
	"reload",
] as const;

/** What a navigation does to the tab. */
export type Step = { url: string } | "back" | "forward" | "reload";

/** How a navigation ended: loaded, still loading at the time limit, the tab closed. */
export type Loaded = "complete" | "timeout" | "closed";

/** The tab events `waitForLoad` follows. */
export interface TabEvents {
	/** Follow tab `tabId`'s loading status and its closing; returns the end of it. */
	watch(
		tabId: number,
		on: { status(status: string): void; removed(): void },
	): () => void;
	/** Tab `tabId`'s status now, `undefined` if it is gone. */
	status(tabId: number): Promise<string | undefined>;
}

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/**
 * Run `start` (a navigation of tab `tabId`) and wait until the tab has
 * loaded: status `complete` after `loading`. A navigation that has not
 * started loading `quietMs` after `start` resolved, the tab being complete,
 * counts as done. Rejects with `start`'s error, or when `signal` aborts.
 */
export function waitForLoad(
	events: TabEvents,
	tabId: number,
	start: () => Promise<unknown>,
	options: { signal: AbortSignal; timeoutMs?: number; quietMs?: number },
): Promise<Loaded> {
	const { signal, timeoutMs = LOAD_TIMEOUT_MS, quietMs = QUIET_MS } = options;
	return new Promise<Loaded>((resolve, reject) => {
		let started = false;
		let done = false;
		const timers: ReturnType<typeof setTimeout>[] = [];
		const finish = (result: Loaded | Error) => {
			if (done) return;
			done = true;
			unwatch();
			for (const timer of timers) clearTimeout(timer);
			signal.removeEventListener("abort", aborted);
			if (result instanceof Error) reject(result);
			else resolve(result);
		};
		const aborted = () =>
			finish(
				new Error(
					"The call was cancelled; the tab may have started to go to the page.",
				),
			);
		// Before `start`: its first events may come before it resolves.
		const unwatch = events.watch(tabId, {
			status: (status) => {
				if (status === "loading") started = true;
				else if (status === "complete" && started) finish("complete");
			},
			removed: () => finish("closed"),
		});
		if (signal.aborted) {
			aborted();
			return;
		}
		signal.addEventListener("abort", aborted, { once: true });
		timers.push(setTimeout(() => finish("timeout"), timeoutMs));
		start().then(
			async () => {
				const status = await events.status(tabId);
				if (status === undefined) return finish("closed");
				if (status === "loading") started = true;
				timers.push(
					setTimeout(async () => {
						if (started || done) return;
						const now = await events.status(tabId);
						if (now === undefined) finish("closed");
						else if (!started && now === "complete") finish("complete");
					}, quietMs),
				);
			},
			(error: unknown) =>
				finish(error instanceof Error ? error : new Error(message(error))),
		);
	});
}

/** The origin of an http(s) address; `undefined` for any other. */
export function httpOrigin(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:"
			? parsed.origin
			: undefined;
	} catch {
		return undefined;
	}
}

const cut = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * The address `navigate` opens: `raw` resolved against the page in front
 * (`base`), http(s) only, without a user name or password (in
 * `https://shop.example@evil.example` the site is evil.example, which a
 * reader can miss), at most MAX_URL characters. Throws why not.
 */
export function addressFor(raw: string, base: string): URL {
	if (raw.length > MAX_URL)
		throw new TypeError(`The address is longer than ${MAX_URL} characters.`);
	let url: URL;
	try {
		url = new URL(
			raw.trim(),
			httpOrigin(base) === undefined ? undefined : base,
		);
	} catch {
		throw new TypeError(`Not an address: ${JSON.stringify(cut(raw, 200))}.`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new TypeError(
			`Only http and https addresses can be opened, not ${cut(url.protocol, 40)} ones.`,
		);
	if (url.username !== "" || url.password !== "")
		throw new TypeError(
			"An address with a user name or password is not opened.",
		);
	if (url.href.length > MAX_URL)
		throw new TypeError(`The address is longer than ${MAX_URL} characters.`);
	return url;
}

/** A host in a question's title is cut to this, from its start. */
export const MAX_TITLE_HOST = 48;

/**
 * `host`, cut from its start if long: the end names the site
 * (`…aaaa.evil.example`), which a cut at the end would hide
 * (`shop.example.aaaa…`).
 */
export function hostEnd(host: string): string {
	return host.length > MAX_TITLE_HOST
		? `…${host.slice(host.length - MAX_TITLE_HOST + 1)}`
		: host;
}

/** What the navigation tools need from Chrome. */
export interface NavigationChrome {
	/** The tab in front. */
	current(): Promise<TargetTab>;
	/** Tab `tabId` now (its address empty where Chrome hides it), `undefined` if closed. */
	tab(tabId: number): Promise<TargetTab | undefined>;
	/** The page in `tab`; throws `page_info`'s access message if it may not be read. */
	page(tab: TargetTab): Promise<PageInfo>;
	history(tab: TargetTab): Promise<PageHistory>;
	/** Take tab `tabId` a step and wait for it to load (`waitForLoad`). */
	go(tabId: number, step: Step, signal: AbortSignal): Promise<Loaded>;
}

/** A navigation question: the tab, the origin it is on, where it would go. */
export interface NavigationWhere {
	tabId: number;
	origin?: string;
	navigation: { to: string };
}

/** Ask the user (the connection's questions). */
export type AskNavigation = (
	request: AppRequest,
	where: NavigationWhere,
) => Promise<Answer | "timeout" | "busy">;

/** A navigation tool's result: the new page's `page_info`, or why it cannot be read. */
export type NavigationResult = (
	| PageInfo
	| { readable: false; reason: string }
) & { loading?: true };

type Kind = "navigate" | "back" | "forward" | "reload";

/** Where a navigation goes, as far as it is known before. */
interface Target {
	step: Step;
	/** The origin it goes to; `undefined`: not known (back or forward elsewhere). */
	origin: string | undefined;
	/** For the question: the address, or what is known of it. */
	to: string;
	/** For the question's title ("Allow opening evil.example?"). */
	title: string;
}

async function targetOf(
	kind: Kind,
	args: Record<string, unknown>,
	tab: TargetTab,
	from: string | undefined,
	chrome: NavigationChrome,
): Promise<Target> {
	if (kind === "navigate") {
		const url = addressFor(
			typeof args["url"] === "string" ? args["url"] : "",
			tab.url,
		);
		return {
			step: { url: url.href },
			origin: url.origin,
			to: url.href,
			title: `opening ${hostEnd(url.host)}`,
		};
	}
	if (kind === "reload")
		return { step: "reload", origin: from, to: tab.url, title: "reloading" };
	const history = await chrome.history(tab);
	if (history.length <= 1)
		throw new Error(`There is no page to go ${kind} to in this tab.`);
	const entry = kind === "back" ? history.back : history.forward;
	// Listed by the Navigation API: on the page's origin (its address may be
	// hidden; one that is given must say the same).
	const known =
		entry !== undefined &&
		(entry.url === null || httpOrigin(entry.url) === from)
			? from
			: undefined;
	return {
		step: kind,
		origin: known,
		to:
			known !== undefined && entry?.url
				? entry.url
				: `The ${kind === "back" ? "previous" : "next"} page in the tab's history, on another site (its address is not known to the extension), if there is one.`,
		title: `going ${kind} to another site`,
	};
}

/**
 * Ask the user about a navigation to another origin; throws unless they
 * allow it.
 */
async function askFirst(
	ask: AskNavigation,
	name: string,
	args: Record<string, unknown>,
	options: ToolExecuteOptions,
	tab: TargetTab,
	from: string | undefined,
	target: Target,
): Promise<void> {
	const { client } = options;
	// Only AI apps through the relay call the extension's tools.
	if (client.kind !== "relay")
		throw new Error("The user did not allow this navigation.");
	const answer = await ask(
		{
			tool: {
				name,
				title: target.title,
				description: "Opens a page of another site in the tab.",
			},
			arguments: args,
			client,
			signal: options.signal,
		},
		{
			tabId: tab.id,
			...(from !== undefined ? { origin: from } : {}),
			navigation: { to: target.to },
		},
	);
	if (answer === "busy")
		throw new Error(
			`${MAX_QUESTIONS_PER_APP} calls of this AI app already wait for the user's answer; this one was not asked. Wait for those answers.`,
		);
	if (answer === "timeout")
		throw new Error(
			`The user was asked and did not answer within ${QUESTION_TIMEOUT_MS / 1000} s; the tab stays where it is.`,
		);
	if (answer === "deny")
		throw new Error(
			"The user did not allow this navigation; the tab stays where it is.",
		);
}

/** The page in tab `tabId` after a navigation, or why it cannot be read. */
async function readAfter(
	chrome: NavigationChrome,
	tabId: number,
	loaded: Loaded,
): Promise<NavigationResult> {
	const loading = loaded === "timeout" ? { loading: true as const } : {};
	const tab = await chrome.tab(tabId);
	if (tab === undefined) throw new Error("The tab was closed.");
	try {
		return { ...(await chrome.page(tab)), ...loading };
	} catch (error) {
		return { readable: false, reason: message(error), ...loading };
	}
}

async function navigation(
	kind: Kind,
	name: string,
	args: Record<string, unknown>,
	options: ToolExecuteOptions,
	chrome: NavigationChrome,
	ask: AskNavigation,
	refresh: () => Promise<void>,
): Promise<NavigationResult> {
	const tab = await chrome.current();
	// Only a tab the extension may read now: this throws page_info's message.
	await chrome.page(tab);
	const from = httpOrigin(tab.url);
	const target = await targetOf(kind, args, tab, from, chrome);
	// A reload stays where the page is: it never asks.
	if (kind !== "reload" && (from === undefined || target.origin !== from))
		await askFirst(ask, name, args, options, tab, from, target);
	// Still on that origin (a question takes a while; a page can move on).
	const now = await chrome.tab(tab.id);
	if (now === undefined) throw new Error("The tab was closed.");
	if (
		httpOrigin(now.url) !== from ||
		(from === undefined && now.url !== tab.url)
	)
		throw new Error(
			"The tab went to another page meanwhile; it was not navigated. page_info says which page it is now.",
		);
	// Still the tab in front: the user may have switched tabs while asked,
	// and the tools act on the tab in front only (DEC-121).
	if (!(await inFront(chrome, tab.id)))
		throw new Error(
			"The tab in front changed meanwhile; it was not navigated. page_info says which page is in front now.",
		);
	const loaded = await chrome.go(tab.id, target.step, options.signal);
	if (loaded === "closed") throw new Error("The tab was closed.");
	// The new page's page_<name> tools are offered before the answer.
	await refresh().catch(() => {});
	// The answer and those tools describe the same tab: the one in front.
	if (!(await inFront(chrome, tab.id)))
		return {
			readable: false,
			reason:
				"The tab was navigated, but another tab is in front now; page_info says which page that is.",
			...(loaded === "timeout" ? { loading: true as const } : {}),
		};
	return readAfter(chrome, tab.id, loaded);
}

/** Tab `tabId` is the tab in front (none in front: it is not). */
async function inFront(
	chrome: NavigationChrome,
	tabId: number,
): Promise<boolean> {
	try {
		return (await chrome.current()).id === tabId;
	} catch {
		return false;
	}
}

const SAME_ORIGIN =
	'On the page\'s own origin it runs at once; to another origin it asks the user first, and the extension may then not read the new page until the user clicks its icon there (or turned on "Allow on all sites").';

/** The four navigation tools, for the connection's `TabMcp`. */
export function navigationTools(
	chrome: NavigationChrome,
	ask: AskNavigation,
	refresh: () => Promise<void>,
): Tool[] {
	// They change what the tab shows (and a GET can change things on a
	// site): not read-only. Not consequential either: the extension asks
	// itself, for another origin only. The result carries the page's title.
	const annotations = { readOnlyHint: false, untrustedContentHint: true };
	const noInput = {
		type: "object",
		properties: {},
		additionalProperties: false,
	} as const;
	const run =
		(kind: Kind, name: string) =>
		(args: Record<string, unknown>, options: ToolExecuteOptions) =>
			navigation(kind, name, args ?? {}, options, chrome, ask, refresh);
	return [
		{
			name: "navigate",
			title: "Open an address in the tab",
			description: `Opens an http(s) address in the tab in front (the page page_info reads), for example a page a tool's result points to. Waits until it has loaded and returns its page_info. ${SAME_ORIGIN}`,
			inputSchema: {
				type: "object",
				properties: {
					url: {
						type: "string",
						maxLength: MAX_URL,
						description:
							'An http or https address, or one relative to the page in front ("/sale").',
					},
				},
				required: ["url"],
				additionalProperties: false,
			},
			annotations,
			execute: run("navigate", "navigate"),
		},
		{
			name: "go_back",
			title: "Back",
			description:
				"Goes back one page in the tab in front, as the browser's Back button does, and returns the page's page_info once it has loaded. Back to another origin asks the user first.",
			inputSchema: noInput,
			annotations,
			execute: run("back", "go_back"),
		},
		{
			name: "go_forward",
			title: "Forward",
			description:
				"Goes forward one page in the tab in front, as the browser's Forward button does, and returns the page's page_info once it has loaded. Forward to another origin asks the user first.",
			inputSchema: noInput,
			annotations,
			execute: run("forward", "go_forward"),
		},
		{
			name: "reload",
			title: "Reload the page",
			description:
				"Reloads the page in the tab in front and returns its page_info once it has loaded: for a page that shows old content or whose tools did not show up. What the user typed into the page and did not save is lost.",
			inputSchema: noInput,
			annotations,
			execute: run("reload", "reload"),
		},
	];
}

/** Chrome's tab events for `waitForLoad`. */
const tabEvents: TabEvents = {
	watch(tabId, on) {
		const updated = (id: number, change: { status?: string }) => {
			if (id === tabId && change.status !== undefined) on.status(change.status);
		};
		const removed = (id: number) => {
			if (id === tabId) on.removed();
		};
		chrome.tabs.onUpdated.addListener(updated);
		chrome.tabs.onRemoved.addListener(removed);
		return () => {
			chrome.tabs.onUpdated.removeListener(updated);
			chrome.tabs.onRemoved.removeListener(removed);
		};
	},
	async status(tabId) {
		try {
			return (await chrome.tabs.get(tabId)).status ?? "complete";
		} catch {
			return undefined;
		}
	},
};

/**
 * Take tab `tabId` a step (none needs a permission: `tabs.update`,
 * `goBack`, `goForward`, `reload`) and wait until it has loaded.
 */
export async function goInTab(
	tabId: number,
	step: Step,
	signal: AbortSignal,
): Promise<Loaded> {
	const start = async () => {
		try {
			if (step === "back") await chrome.tabs.goBack(tabId);
			else if (step === "forward") await chrome.tabs.goForward(tabId);
			else if (step === "reload") await chrome.tabs.reload(tabId);
			else await chrome.tabs.update(tabId, { url: step.url });
		} catch (error) {
			const what =
				step === "back"
					? "go back"
					: step === "forward"
						? "go forward"
						: step === "reload"
							? "reload"
							: "open the address";
			throw new Error(
				`The tab could not ${what}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
	return waitForLoad(tabEvents, tabId, start, { signal });
}
