/**
 * The side panel: the connection to the user's AI app through a relay
 * (`TabMcp`, the library's own dialog for pairing and confirmations), the tab
 * in front with its WebMCP tools (the bridge), and the relay address.
 */

import {
	type DisconnectDetail,
	type Icon,
	TabMcp,
} from "@ractive-ch/tab-mcp-client";
import type { ContentEvent } from "../messages.ts";
import {
	ALL_SITES,
	askPage,
	askTools,
	callInTab,
	tabInFront,
} from "../tabs.ts";
import { type BridgeState, PageToolBridge } from "./bridge.ts";
import {
	loadAiOn,
	loadRelay,
	relayProblem,
	saveAiOn,
	saveRelay,
} from "./relay.ts";
import { createTools, INSTRUCTIONS, type TabBridge } from "./tools.ts";

const $ = <T extends HTMLElement>(id: string) =>
	document.getElementById(id) as T;

const tabs: TabBridge = { current: tabInFront, page: askPage };

let mcp: TabMcp | undefined;
let bridge: PageToolBridge | undefined;
/** The relay `mcp` uses. */
let currentRelay: string | undefined;
let listening = new AbortController();

/** The extension's icon for the AI app's connector list (a PNG `data:` URI). */
async function iconsFor(): Promise<Icon[]> {
	try {
		const png = await (
			await fetch(chrome.runtime.getURL("icons/icon-128.png"))
		).blob();
		const src = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(png);
		});
		return [{ src, mimeType: "image/png", sizes: ["128x128"] }];
	} catch {
		return [];
	}
}

const icons = await iconsFor();

function connection(relay: string): TabMcp {
	const created = new TabMcp({
		relay,
		server: {
			name: "tab-mcp-for-chrome",
			title: "tab-mcp for Chrome",
			version: chrome.runtime.getManifest().version,
			instructions: INSTRUCTIONS,
			icons,
		},
		appName: "tab-mcp for Chrome",
	});
	const pageTools = new PageToolBridge(
		created,
		{ current: tabInFront, list: askTools, call: callInTab },
		() => showTools(),
	);
	for (const tool of createTools(tabs, () => pageTools))
		void created.registerTool(tool);
	bridge?.stop();
	bridge = pageTools;
	void pageTools.refresh();
	return created;
}

// --- The connection ---

function showState(): void {
	const state = mcp?.state ?? "disconnected";
	const connected = state === "connected";
	const names = mcp?.grants.map((g) => g.client.name || g.client.host) ?? [];
	const [kind, text] = connected
		? names.length
			? ["on", `Connected · ${names.join(", ")}`]
			: ["waiting", "On · no AI app connected yet"]
		: state === "connecting"
			? ["connecting", "Connecting…"]
			: mcp?.reconnecting
				? ["retrying", "Connection lost · retrying"]
				: ["off", "Off"];
	$("state").dataset["state"] = kind;
	$("state-text").textContent = text;
	const address = mcp?.address;
	$("address-line").hidden = address === undefined;
	$("address").textContent = address ?? "";
	$("address").title = address ?? "";
	// Also while retrying, so the user can stop the retries.
	$("stop").hidden =
		!connected && state !== "connecting" && mcp?.reconnecting === undefined;
	$("connect").textContent = connected
		? "Pair an AI app"
		: "Connect your AI app";
}

function showProblem(message: string | undefined): void {
	$("problem").hidden = message === undefined;
	$("problem").textContent = message ?? "";
}

function watch(target: TabMcp): void {
	listening.abort();
	listening = new AbortController();
	const { signal } = listening;
	for (const type of [
		"statechange",
		"grantschange",
		"reconnecting",
		"connected",
	] as const)
		target.addEventListener(type, showState, { signal });
	target.addEventListener(
		"connected",
		() => {
			showProblem(undefined);
			void saveAiOn(true);
		},
		{ signal },
	);
	target.addEventListener(
		"disconnected",
		(event) => {
			if ((event as CustomEvent<DisconnectDetail>).detail.reason === "user")
				void saveAiOn(false);
			showState();
		},
		{ signal },
	);
	target.addEventListener(
		"error",
		(event) =>
			showProblem(
				(event as CustomEvent<{ error: Error }>).detail.error.message,
			),
		{ signal },
	);
}

/**
 * Use `relay` from now on. The connection to the one before is ended
 * whatever its state (connected, connecting or waiting to retry): left
 * retrying, it would connect again unseen.
 */
async function useRelay(relay: string): Promise<void> {
	const before = mcp;
	mcp = connection(relay);
	currentRelay = relay;
	watch(mcp);
	await before?.disconnect();
	showState();
	// For the end-to-end tests: which relay the panel uses now.
	document.documentElement.dataset["relay"] = relay;
}

// --- The tab in front ---

let shownTab = 0;

function badge(text: string, kind = ""): HTMLElement {
	const span = document.createElement("span");
	span.className = `badge ${kind}`.trim();
	span.textContent = text;
	return span;
}

// The tab in front and whether the extension may read it. A call that a
// later one overtook shows nothing: its tab may no longer be in front.
async function showTab(): Promise<void> {
	const call = ++shownTab;
	const all = await chrome.permissions.contains(ALL_SITES);
	if (call !== shownTab) return;
	$("allow-all").hidden = all;
	$("allowed-all").hidden = !all;
	let tab: Awaited<ReturnType<typeof tabInFront>>;
	try {
		tab = await tabInFront();
	} catch {
		$("tab-title").textContent = "No tab";
		$("tab-host").textContent = "";
		$("tab-badges").replaceChildren();
		$("tab-access").textContent = "";
		return;
	}
	let readable = true;
	let access = "";
	let webmcp: { available: boolean; tools: number } | undefined;
	let title = tab.title;
	try {
		const page = await askPage(tab);
		webmcp = page.webmcp;
		title = page.title || title;
	} catch (error) {
		readable = false;
		access = error instanceof Error ? error.message : String(error);
	}
	if (call !== shownTab) return;
	let host = "";
	try {
		host = tab.url ? new URL(tab.url).host || tab.url : "";
	} catch {
		host = tab.url;
	}
	$("tab-title").textContent = title || host || "(no title)";
	$("tab-host").textContent = host;
	// The tools the bridge lists for this page, without the page's tab-mcp
	// mirrors; the page's own count until the bridge has read them.
	const state = bridge?.state;
	const count =
		state?.url === tab.url ? state.tools.length : (webmcp?.tools ?? 0);
	$("tab-badges").replaceChildren(
		!readable
			? badge("Not readable")
			: webmcp?.available
				? badge(`WebMCP · ${count} tool${count === 1 ? "" : "s"}`, "reads")
				: badge("No WebMCP"),
	);
	const mirrored = state?.url === tab.url ? state.mirrored.length : 0;
	$("tab-access").textContent =
		access ||
		(mirrored
			? `${mirrored} more ${mirrored === 1 ? "comes" : "come"} from the page's own tab-mcp connection.`
			: "");
}

/** The page's tools as the bridge offers them. */
function showTools(): void {
	const state: BridgeState | undefined = bridge?.state;
	const items = (state?.tools ?? []).map((tool) => {
		const li = document.createElement("li");
		const name = document.createElement("span");
		name.className = "name";
		name.textContent = tool.title ?? tool.name;
		if (tool.title) {
			name.append(" ");
			const code = document.createElement("code");
			code.textContent = tool.name;
			name.append(code);
		}
		if (tool.problem) {
			const why = document.createElement("span");
			why.className = "why";
			why.textContent = `Not offered: ${tool.problem}`;
			name.append(why);
		}
		li.append(
			name,
			tool.problem
				? badge("left out")
				: tool.readOnly
					? badge("reads", "reads")
					: badge("asks first", "asks"),
		);
		return li;
	});
	$("tools").replaceChildren(...items);
	// The tab's badge counts what the page registered; refresh it too.
	void showTab();
}

// --- Controls ---

$("connect").addEventListener("click", () => {
	showProblem(undefined);
	// From the click: the library needs its user activation.
	mcp
		?.showConnectDialog()
		.catch((error: unknown) =>
			showProblem(error instanceof Error ? error.message : String(error)),
		);
});

$("stop").addEventListener("click", () => {
	// "disconnected" fires only for a connection that was up: say it here.
	void saveAiOn(false);
	void mcp?.disconnect();
});

$("copy").addEventListener("click", () => {
	const address = mcp?.address;
	if (address === undefined) return;
	void navigator.clipboard.writeText(address).then(() => {
		$("copy").textContent = "Copied";
		setTimeout(() => {
			$("copy").textContent = "Copy";
		}, 1500);
	});
});

$("allow-all").addEventListener("click", () => {
	// From the click: Chrome asks the user.
	chrome.permissions
		.request(ALL_SITES)
		.then(() => refreshTab())
		.catch((error: unknown) => showProblem(String(error)));
});

$("disallow-all").addEventListener("click", () => {
	chrome.permissions
		.remove(ALL_SITES)
		.then(() => refreshTab())
		.catch((error: unknown) => showProblem(String(error)));
});

$("relay-form").addEventListener("submit", (event) => {
	event.preventDefault();
	const value = ($("relay") as HTMLInputElement).value.trim();
	const problem = relayProblem(value);
	$("relay-problem").hidden = problem === undefined;
	$("relay-problem").textContent = problem ?? "";
	if (problem !== undefined) return;
	if (value === currentRelay) return;
	// AI access was on for the relay before, not for this one: the user
	// connects to it with a click.
	void saveAiOn(false)
		.then(() => saveRelay(value))
		.then(() => useRelay(value));
});

/** The tab in front changed (or what may be read of it): show it, offer its tools. */
function refreshTab(): void {
	void showTab();
	void bridge?.refresh();
}

chrome.tabs.onActivated.addListener(refreshTab);
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
	// Only the active tabs: a tab loading behind them changes nothing shown.
	if (tab.active && (change.status === "complete" || change.url !== undefined))
		refreshTab();
});
chrome.windows.onFocusChanged.addListener(refreshTab);
chrome.permissions.onAdded.addListener(refreshTab);
chrome.permissions.onRemoved.addListener(refreshTab);
// The page's tools changed (`toolchange`), from the content script of an
// active tab.
chrome.runtime.onMessage.addListener((event: ContentEvent, sender) => {
	if (
		sender.id === chrome.runtime.id &&
		event?.type === "webmcp-changed" &&
		sender.tab?.active
	)
		void bridge?.refresh();
	return false;
});

const relay = await loadRelay();
($("relay") as HTMLInputElement).value = relay;
await useRelay(relay);
void showTab();
// The user left AI access on: connect again without a click.
if (await loadAiOn())
	mcp
		?.connect({ resume: true })
		.catch((error: unknown) =>
			showProblem(error instanceof Error ? error.message : String(error)),
		);
