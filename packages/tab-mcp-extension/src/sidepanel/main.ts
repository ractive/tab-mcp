/**
 * The side panel: a view of the connection, which lives in the service
 * worker (DEC-116). It shows the state the worker sends over the panel's
 * port and sends the user's commands back: AI access on and off, pairing,
 * the connected apps, the relay address, the tools allowed without asking,
 * and the answers to tools that ask first. Closing it changes nothing but
 * pairing, which stops.
 */

import {
	type Answer,
	PANEL_PORT,
	type PanelCommand,
	type PanelState,
	type QuestionView,
	type ToolView,
	type WorkerMessage,
} from "../protocol.ts";
import { relayProblem } from "../relay.ts";
import { ALL_SITES } from "../tabs.ts";

/** How long the panel must be visible and focused before Allow counts. */
const ALLOW_DELAY_MS = 750;

const $ = <T extends HTMLElement>(id: string) =>
	document.getElementById(id) as T;

const { id: windowId } = await chrome.windows.getCurrent();

let port: chrome.runtime.Port | undefined;
let state: PanelState | undefined;
/** The pairing view is open (codes come only then). */
let pairingOpen = false;
/** "New address" with apps connected asks first: a second click makes it. */
let newAddressArmed = false;

function send(command: PanelCommand): void {
	try {
		port?.postMessage(command);
	} catch {
		// The worker went away; the port reconnects and the view follows.
	}
}

/**
 * The port to the worker. Chrome ends it when the worker stops (an update,
 * a reload): connect again, which starts the worker.
 */
function connect(): void {
	const opened = chrome.runtime.connect({ name: PANEL_PORT });
	port = opened;
	opened.onMessage.addListener((message: WorkerMessage) => {
		if (message?.type === "state") show(message.state);
	});
	opened.onDisconnect.addListener(() => {
		if (port === opened) port = undefined;
		setTimeout(connect, 250);
	});
	if (windowId !== undefined) send({ type: "hello", windowId });
	if (pairingOpen) send({ type: "pair", on: true });
}

// --- The AI app ---

const STATUS_TEXT: Record<PanelState["status"], string> = {
	off: "Off",
	connecting: "Connecting…",
	retrying: "Connection lost · retrying",
	waiting: "On · no AI app connected yet",
	on: "Connected",
};

function showConnection(s: PanelState): void {
	const names = s.grants.map((g) => g.name || g.host);
	$("state").dataset["state"] = s.status;
	$("state-text").textContent =
		s.status === "on"
			? `Connected · ${names.join(", ")}`
			: STATUS_TEXT[s.status];
	$("address-line").hidden = s.address === undefined;
	$("address").textContent = s.address ?? "";
	$("address").title = s.address ?? "";
	// Also while retrying, so the user can stop the retries.
	$("stop").hidden = s.status === "off";
	const on = s.status !== "off";
	$("connect").textContent = on ? "Pair an AI app" : "Connect your AI app";
	$("connect").hidden = pairingOpen && on;
	$("problem").hidden = s.problem === undefined;
	$("problem").textContent = s.problem ?? "";
	$("replaced").hidden = s.replaced === undefined;
	$("replaced-text").textContent = s.replaced?.sibling
		? "Opened elsewhere in this browser: the address is in use there."
		: "Another tab or program took over this address, and the AI apps paired with it may now talk to it. Make a new address to disconnect them.";
	$("grants").replaceChildren(
		...s.grants.map((grant) => {
			const li = document.createElement("li");
			const name = document.createElement("span");
			name.textContent = grant.name || grant.host;
			if (grant.name) {
				const host = document.createElement("span");
				host.className = "host";
				host.textContent = ` ${grant.host}`;
				name.append(host);
			}
			const disconnect = document.createElement("button");
			disconnect.type = "button";
			disconnect.className = "quiet small";
			disconnect.textContent = "Disconnect";
			disconnect.addEventListener("click", () =>
				send({ type: "revoke", grantId: grant.grantId }),
			);
			li.append(name, disconnect);
			return li;
		}),
	);
	$("pairing").hidden = !pairingOpen || !on;
	const code = s.code;
	$("code").textContent =
		code === undefined ? "––– –––" : `${code.slice(0, 3)} ${code.slice(3)}`;
	($("copy-code") as HTMLButtonElement).disabled = code === undefined;
	if (s.grants.length === 0) newAddressArmed = false;
	$("new-address-note").hidden = !newAddressArmed;
}

// --- Questions ---

/** Since when the panel has been visible and focused, if it is. */
let focusedSince: number | undefined;
const cards = new Map<string, { card: HTMLElement; shownAt: number }>();

function question(q: QuestionView): HTMLElement {
	const card = document.createElement("section");
	card.className = "card question";
	card.dataset["question"] = q.id;
	const ask = document.createElement("p");
	ask.className = "ask";
	const site = q.origin ? ` on ${q.origin}` : "";
	ask.textContent = `${q.app} wants to run ${q.title ?? q.tool}${site}.`;
	const tool = document.createElement("p");
	tool.className = "muted small";
	tool.textContent = `Tool ${q.tool}, with these arguments from the AI app:`;
	const args = document.createElement("pre");
	args.textContent = q.args;
	const buttons = document.createElement("div");
	buttons.className = "buttons";
	const button = (text: string, answer: Answer, primary = false) => {
		const b = document.createElement("button");
		b.type = "button";
		b.textContent = text;
		b.dataset["answer"] = answer;
		if (primary) b.className = "primary";
		// Allow and Always allow only once the panel has been in front a while:
		// the click that brings it forward cannot approve.
		if (answer !== "deny") b.disabled = true;
		b.addEventListener("click", () => {
			if (!b.disabled) send({ type: "answer", id: q.id, answer });
		});
		return b;
	};
	buttons.append(
		button("Don't allow", "deny"),
		button("Allow", "allow", true),
		button("Always allow", "always"),
	);
	const always = document.createElement("p");
	always.className = "muted small";
	always.textContent =
		"Always allow: this tool runs without asking for this AI app, until the page changes.";
	card.append(ask, tool, args, buttons, always);
	return card;
}

function showQuestions(questions: QuestionView[]): void {
	const ids = new Set(questions.map((q) => q.id));
	for (const [id, { card }] of cards)
		if (!ids.has(id)) {
			card.remove();
			cards.delete(id);
		}
	for (const q of questions)
		if (!cards.has(q.id)) {
			const card = question(q);
			$("questions").append(card);
			cards.set(q.id, { card, shownAt: Date.now() });
		}
	arm();
}

/**
 * Allow counts once the panel has been visible and focused for
 * ALLOW_DELAY_MS with the question shown; leaving it starts the wait again.
 */
function arm(): void {
	const now = Date.now();
	if (document.visibilityState === "visible" && document.hasFocus())
		focusedSince ??= now;
	else focusedSince = undefined;
	for (const { card, shownAt } of cards.values()) {
		const ready =
			focusedSince !== undefined &&
			now - Math.max(shownAt, focusedSince) >= ALLOW_DELAY_MS;
		for (const b of card.querySelectorAll<HTMLButtonElement>(
			'button[data-answer]:not([data-answer="deny"])',
		))
			b.disabled = !ready;
	}
}

setInterval(() => {
	if (cards.size > 0) arm();
}, 100);
for (const type of ["focus", "blur", "visibilitychange"])
	window.addEventListener(type, arm);

// --- The tab in front ---

function badge(text: string, kind = ""): HTMLElement {
	const span = document.createElement("span");
	span.className = `badge ${kind}`.trim();
	span.textContent = text;
	return span;
}

/** "asks first" or "allowed": a click turns it into the other, for this site. */
function allowToggle(origin: string, tool: ToolView): HTMLElement {
	const on = tool.allowed;
	const button = document.createElement("button");
	button.type = "button";
	button.className = `badge toggle ${on ? "allowed" : "asks"}`;
	button.textContent = on ? "allowed" : "asks first";
	button.title = on
		? `Runs without asking on ${origin}. Click to ask first again.`
		: `Asks you before each call. Click to allow it on ${origin} without asking.`;
	button.setAttribute("aria-pressed", String(on));
	button.dataset["tool"] = tool.name;
	button.addEventListener("click", () =>
		send({ type: "set-allowed", origin, name: tool.name, on: !on }),
	);
	return button;
}

function toolItem(origin: string, tool: ToolView): HTMLElement {
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
				: allowToggle(origin, tool),
	);
	return li;
}

function showTab(s: PanelState): void {
	$("allow-all").hidden = s.allSites;
	$("allowed-all").hidden = !s.allSites;
	const tab = s.tab;
	$("tab-title").textContent = tab?.title ?? "–";
	$("tab-host").textContent = tab?.host ?? "";
	const count = tab?.webmcp?.tools ?? 0;
	$("tab-badges").replaceChildren(
		...(tab === undefined
			? []
			: [
					tab.webmcp === undefined
						? badge("Not readable")
						: tab.webmcp.available
							? badge(
									`WebMCP · ${count} tool${count === 1 ? "" : "s"}`,
									"reads",
								)
							: badge("No WebMCP"),
				]),
	);
	const mirrored = tab?.mirrored ?? 0;
	$("tab-access").textContent =
		tab?.access ||
		(mirrored
			? `${mirrored} more ${mirrored === 1 ? "comes" : "come"} from the page's own tab-mcp connection.`
			: "");
	$("tools").replaceChildren(
		...(tab?.tools ?? []).map((tool) => toolItem(tab?.origin ?? "", tool)),
	);
}

function show(s: PanelState): void {
	const relayChanged = state?.relay !== s.relay;
	state = s;
	if (relayChanged) {
		($("relay") as HTMLInputElement).value = s.relay;
		// For the end-to-end tests: the relay the connection uses now.
		document.documentElement.dataset["relay"] = s.relay;
	}
	showConnection(s);
	showQuestions(s.questions);
	showTab(s);
}

// --- Controls ---

function problem(text: string): void {
	$("problem").hidden = false;
	$("problem").textContent = text;
}

function copy(button: HTMLElement, text: string | undefined): void {
	if (text === undefined) return;
	navigator.clipboard.writeText(text).then(
		() => {
			button.textContent = "Copied";
			setTimeout(() => {
				button.textContent = "Copy";
			}, 1500);
		},
		// Not focused, or not allowed: it is shown whole to copy by hand.
		() => problem(`Copy did not work: ${text}`),
	);
}

function openPairing(on: boolean): void {
	pairingOpen = on;
	send({ type: "pair", on });
	if (state) showConnection(state);
}

$("connect").addEventListener("click", () => {
	if (state?.status === "off") send({ type: "connect" });
	openPairing(true);
});

$("stop").addEventListener("click", () => {
	openPairing(false);
	send({ type: "stop" });
});

$("pair-done").addEventListener("click", () => openPairing(false));

$("new-address").addEventListener("click", () => {
	if ((state?.grants.length ?? 0) > 0 && !newAddressArmed) {
		newAddressArmed = true;
		$("new-address-note").hidden = false;
		return;
	}
	newAddressArmed = false;
	send({ type: "new-address" });
});
$("replaced-new-address").addEventListener("click", () =>
	send({ type: "new-address" }),
);

$("copy").addEventListener("click", () => copy($("copy"), state?.address));
$("copy-code").addEventListener("click", () =>
	copy($("copy-code"), state?.code),
);

$("allow-all").addEventListener("click", () => {
	// From the click: Chrome asks the user. The worker hears of the change.
	chrome.permissions
		.request(ALL_SITES)
		.catch((error: unknown) => problem(String(error)));
});

$("disallow-all").addEventListener("click", () => {
	chrome.permissions
		.remove(ALL_SITES)
		.catch((error: unknown) => problem(String(error)));
});

$("relay-form").addEventListener("submit", (event) => {
	event.preventDefault();
	const value = ($("relay") as HTMLInputElement).value.trim();
	const why = relayProblem(value);
	$("relay-problem").hidden = why === undefined;
	$("relay-problem").textContent = why ?? "";
	if (why !== undefined || value === state?.relay) return;
	openPairing(false);
	send({ type: "set-relay", relay: value });
});

connect();
