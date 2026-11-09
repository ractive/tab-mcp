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
import {
	allowAllView,
	cardView,
	confirms,
	SWITCH_WAIT_MS,
	type SwitchIntent,
	switchShown,
} from "./card.ts";

/** How long the panel must be visible and focused before Allow counts. */
const ALLOW_DELAY_MS = 750;

const $ = <T extends HTMLElement>(id: string) =>
	document.getElementById(id) as T;

const { id: windowId } = await chrome.windows.getCurrent();

let port: chrome.runtime.Port | undefined;
let state: PanelState | undefined;
/** The user asked to add another AI app (with apps paired already). */
let addingApp = false;
/** What the worker was told: pairing on (codes come only then). */
let pairing = false;
/** Disconnect asks first: the apps whose button was clicked once. */
const disconnectArmed = new Map<
	string,
	{ at: number; timer: ReturnType<typeof setTimeout> }
>();
/** The user's flip of the AI access switch, while the worker acts on it. */
let switchIntent: SwitchIntent | undefined;
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
	let opened: chrome.runtime.Port;
	try {
		opened = chrome.runtime.connect({ name: PANEL_PORT });
	} catch {
		// The extension was updated, reloaded or removed: this panel belongs
		// to the version before and can reach nothing any more.
		port = undefined;
		problem(
			"tab-mcp for Chrome was updated or reloaded: close and open this panel again.",
		);
		return;
	}
	port = opened;
	opened.onMessage.addListener((message: WorkerMessage) => {
		if (message?.type === "state") show(message.state);
	});
	opened.onDisconnect.addListener(() => {
		if (port === opened) port = undefined;
		setTimeout(connect, 250);
	});
	if (windowId !== undefined) send({ type: "hello", windowId });
	sendVisible();
	if (pairing) send({ type: "pair", on: true });
}

// --- The AI app ---

/** Tell the worker whether to pair (codes come only then). */
function syncPairing(on: boolean): void {
	if (on === pairing) return;
	pairing = on;
	send({ type: "pair", on });
}

function disconnectButton(grant: PanelState["grants"][number]): HTMLElement {
	const button = document.createElement("button");
	button.type = "button";
	// An outlined button: plain grey text read as a state ("disconnected").
	button.className = "small";
	const armed = disconnectArmed.has(grant.grantId);
	button.textContent = armed ? "Disconnect? Click again" : "Disconnect";
	button.dataset["grant"] = grant.grantId;
	button.addEventListener("click", () => {
		const armed = disconnectArmed.get(grant.grantId);
		if (armed === undefined) {
			// Asks first: the app has to be added and paired again after.
			disconnectArmed.set(grant.grantId, {
				at: Date.now(),
				timer: setTimeout(() => {
					disconnectArmed.delete(grant.grantId);
					if (state) showConnection(state);
				}, 4000),
			});
		} else {
			// The second click of a double click confirms nothing.
			if (!confirms(armed.at, Date.now())) return;
			clearTimeout(armed.timer);
			disconnectArmed.delete(grant.grantId);
			send({ type: "revoke", grantId: grant.grantId });
		}
		if (state) showConnection(state);
	});
	return button;
}

function showConnection(s: PanelState): void {
	// Adding another app ends with the connection, or once none is paired.
	if (s.status !== "on") addingApp = false;
	const view = cardView(s, addingApp);
	$("state").dataset["state"] = s.status;
	$("state-text").textContent = view.stateText;
	// Also while connecting or retrying, so the user can stop it.
	const shown = switchShown(view.switchOn, switchIntent, Date.now());
	switchIntent = shown.intent;
	($("ai-switch") as HTMLInputElement).checked = shown.checked;
	$("ai-switch").setAttribute("aria-checked", String(shown.checked));
	$("connect").hidden = !view.turnOn;
	$("problem").hidden = s.problem === undefined;
	$("problem").textContent = s.problem ?? "";
	$("replaced").hidden = s.replaced === undefined;
	$("replaced-text").textContent = s.replaced?.sibling
		? "Opened elsewhere in this browser: the address is in use there."
		: "Another tab or program took over this address, and the AI apps paired with it may now talk to it. Make a new address to disconnect them.";
	$("grants").setAttribute(
		"aria-label",
		s.status === "on" ? "Connected AI apps" : "Paired AI apps",
	);
	$("grants").replaceChildren(
		...s.grants.map((grant) => {
			const li = document.createElement("li");
			// The row says the state (a green dot: connected); the button acts.
			const app = document.createElement("span");
			app.className = "app";
			const dot = document.createElement("span");
			// Green only while connected: off, connecting or retrying the
			// apps stay paired, not connected.
			dot.className = s.status === "on" ? "dot on" : "dot";
			dot.setAttribute("aria-hidden", "true");
			const name = document.createElement("span");
			name.className = "app-name";
			name.textContent = grant.name || grant.host;
			app.append(dot, name);
			if (grant.name) {
				const host = document.createElement("span");
				host.className = "host";
				host.textContent = grant.host;
				app.append(" ", host);
			}
			li.append(app, disconnectButton(grant));
			return li;
		}),
	);
	syncPairing(view.pairing);
	$("pairing").hidden = !view.pairing;
	$("add-app").hidden = !view.addApp;
	$("pair-done").hidden = !view.done;
	// The address only while pairing: it is what an AI app is added with.
	$("address").textContent = view.address;
	$("address").title = view.address;
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
	buttons.append(button("Don't allow", "deny"), button("Allow", "allow", true));
	card.append(ask, tool, args, buttons);
	// Not for a page without a site of its own (an opaque origin).
	if (q.always) {
		buttons.append(button("Always allow", "always"));
		const always = document.createElement("p");
		always.className = "muted small";
		always.textContent =
			"Always allow: this tool runs without asking for this AI app, until the page changes.";
		card.append(always);
	}
	return card;
}

/**
 * Until when the panel's buttons that allow something stay off after its
 * layout moved: a question that went away moves what was below it up, under
 * the pointer, and a click meant for it must not land on an Allow or an
 * "asks first" that came there.
 */
let movedUntil = 0;
/** "Allow all" as last shown: its visibility, label and tools. */
let allowAllShown = "";

function showQuestions(questions: QuestionView[]): void {
	const ids = new Set(questions.map((q) => q.id));
	let removed = false;
	for (const [id, { card }] of cards)
		if (!ids.has(id)) {
			card.remove();
			cards.delete(id);
			removed = true;
		}
	if (removed) {
		const now = Date.now();
		movedUntil = now + ALLOW_DELAY_MS;
		// Every question left waits again, as if just shown.
		for (const entry of cards.values()) entry.shownAt = now;
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
	for (const toggle of document.querySelectorAll<HTMLButtonElement>(
		"button.badge.toggle, #allow-tools",
	))
		toggle.disabled = now < movedUntil;
}

setInterval(() => {
	if (cards.size > 0 || Date.now() < movedUntil + 200) arm();
}, 100);
for (const type of ["focus", "blur", "visibilitychange"])
	window.addEventListener(type, arm);

/** Tell the worker whether the panel is on screen (not covered by another's). */
function sendVisible(): void {
	send({ type: "visible", visible: document.visibilityState === "visible" });
}
document.addEventListener("visibilitychange", sendVisible);

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
	button.disabled = Date.now() < movedUntil;
	button.addEventListener("click", () => {
		if (!button.disabled)
			send({ type: "set-allowed", origin, name: tool.name, on: !on });
	});
	return button;
}

function toolItem(
	origin: string,
	canAllow: boolean,
	tool: ToolView,
): HTMLElement {
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
				: canAllow
					? allowToggle(origin, tool)
					: badge("asks first", "asks"),
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
	const allowAll = allowAllView(tab);
	// The page changed what "Allow all" does (another label, other tools, or
	// it just came): it and the switches below wait, as when a question went,
	// so a click meant for the button as it was cannot allow what it is now.
	const shownAs = JSON.stringify([
		allowAll.shown,
		allowAll.label,
		allowAll.names,
	]);
	if (allowAll.shown && shownAs !== allowAllShown) {
		movedUntil = Date.now() + ALLOW_DELAY_MS;
		arm();
	}
	allowAllShown = shownAs;
	$("tools-head").hidden = !allowAll.shown;
	const button = $("allow-tools") as HTMLButtonElement;
	button.textContent = allowAll.label;
	const scope = tab?.origin ?? "this site";
	const label =
		allowAll.label === "Allow all"
			? `Allow all ${allowAll.names.length} tools that ask first on ${scope}`
			: `Ask first for all tools on ${scope}`;
	button.setAttribute("aria-label", label);
	button.title = label;
	button.disabled = Date.now() < movedUntil;
	$("tools").replaceChildren(
		...(tab?.tools ?? []).map((tool) =>
			toolItem(tab?.origin ?? "", tab?.canAllow === true, tool),
		),
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

function addApp(on: boolean): void {
	addingApp = on;
	if (state) showConnection(state);
}

$("connect").addEventListener("click", () => send({ type: "connect" }));

$("ai-switch").addEventListener("change", () => {
	switchIntent = {
		on: ($("ai-switch") as HTMLInputElement).checked,
		until: Date.now() + SWITCH_WAIT_MS,
	};
	addingApp = false;
	send({
		type: ($("ai-switch") as HTMLInputElement).checked ? "connect" : "stop",
	});
});

$("add-app").addEventListener("click", () => addApp(true));
$("pair-done").addEventListener("click", () => addApp(false));

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

$("allow-tools").addEventListener("click", () => {
	const button = $("allow-tools") as HTMLButtonElement;
	const tab = state?.tab;
	const view = allowAllView(tab);
	if (button.disabled || !view.shown || tab?.origin === undefined) return;
	send({
		type: "set-allowed-all",
		origin: tab.origin,
		names: view.names,
		on: view.on,
	});
});

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
	addApp(false);
	send({ type: "set-relay", relay: value });
});

connect();
