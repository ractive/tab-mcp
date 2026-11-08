/**
 * The side panel: the connection to the user's AI app through a relay
 * (`TabMcp`, the library's own dialog for pairing), the tab in front and
 * whether the extension may read it, and the relay address.
 */

import { type DisconnectDetail, TabMcp } from "@ractive-ch/tab-mcp-client";
import { ALL_SITES, askPage, tabInFront } from "../tabs.ts";
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
/** The relay `mcp` uses. */
let currentRelay: string | undefined;
let listening = new AbortController();

function connection(relay: string): TabMcp {
	const created = new TabMcp({
		relay,
		server: {
			name: "tab-mcp-for-chrome",
			title: "tab-mcp for Chrome",
			version: chrome.runtime.getManifest().version,
			instructions: INSTRUCTIONS,
			icons: [],
		},
		appName: "tab-mcp for Chrome",
	});
	for (const tool of createTools(tabs)) void created.registerTool(tool);
	return created;
}

function showState(): void {
	const state = mcp?.state ?? "disconnected";
	const connected = state === "connected";
	$("state").textContent =
		state === "connected"
			? mcp?.grants.length
				? `Connected: ${mcp.grants.map((g) => g.client.name || g.client.host).join(", ")}`
				: "On, no AI app connected yet"
			: state === "connecting"
				? "Connecting…"
				: mcp?.reconnecting
					? "Connection lost, retrying…"
					: "Off";
	const address = mcp?.address;
	$("address-line").hidden = address === undefined;
	$("address").textContent = address ?? "";
	// Also while retrying, so the user can stop the retries.
	$("stop").hidden =
		!connected && state !== "connecting" && mcp?.reconnecting === undefined;
	$("connect").textContent = connected
		? "Show address and pairing"
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

let shownTab = 0;

// The tab in front and whether the extension may read it. A call that a
// later one overtook shows nothing: its tab may no longer be in front.
async function showTab(): Promise<void> {
	const call = ++shownTab;
	const show = (url: string, access: string) => {
		if (call !== shownTab) return;
		$("tab-url").textContent = url;
		$("tab-access").textContent = access;
	};
	const all = await chrome.permissions.contains(ALL_SITES);
	if (call !== shownTab) return;
	$("allow-all").hidden = all;
	$("disallow-all").hidden = !all;
	let tab: Awaited<ReturnType<typeof tabInFront>>;
	try {
		tab = await tabInFront();
	} catch {
		show("–", "");
		return;
	}
	const url = tab.url || "(no address)";
	try {
		const page = await askPage(tab);
		show(
			url,
			page.webmcp.available
				? `Readable. WebMCP: ${page.webmcp.tools} tool${page.webmcp.tools === 1 ? "" : "s"}.`
				: "Readable. No WebMCP on this page.",
		);
	} catch (error) {
		show(url, error instanceof Error ? error.message : String(error));
	}
}

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

$("allow-all").addEventListener("click", () => {
	// From the click: Chrome asks the user.
	chrome.permissions
		.request(ALL_SITES)
		.then(() => showTab())
		.catch((error: unknown) => showProblem(String(error)));
});

$("disallow-all").addEventListener("click", () => {
	chrome.permissions
		.remove(ALL_SITES)
		.then(() => showTab())
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

chrome.tabs.onActivated.addListener(() => void showTab());
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
	// Only the active tabs: a tab loading behind them changes nothing shown.
	if (tab.active && (change.status === "complete" || change.url !== undefined))
		void showTab();
});
chrome.permissions.onAdded.addListener(() => void showTab());
chrome.permissions.onRemoved.addListener(() => void showTab());

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
