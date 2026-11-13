/**
 * The side panel: a view of the connection, which lives in the service
 * worker (DEC-116). It shows the state the worker sends over the panel's
 * port and sends the user's commands back: AI access on and off, pairing,
 * the connected apps, the relay address, the tools allowed without asking,
 * and the answers to tools that ask first. Closing it changes nothing but
 * pairing, which stops.
 */

import {
	PANEL_PORT,
	type PanelCommand,
	type PanelState,
	type QuestionSummary,
	type ToolView,
	type WorkerMessage,
} from "../protocol.ts";
import { relayProblem } from "../relay.ts";
import { ALL_SITES } from "../tabs.ts";
import {
	allowAllView,
	cardView,
	confirms,
	DONT_ASK_ALL,
	introText,
	noAccessText,
	SWITCH_WAIT_MS,
	type SwitchIntent,
	switchExpiry,
	switchShown,
	webmcpNote,
} from "./card.ts";
import {
	isUnavailable,
	questionAnnouncement,
	questionCard,
	setAvailable,
	setReady,
	updateCountdowns,
} from "./question.ts";
import { copyText, SELECTED, setupSteps } from "./setup.ts";

/** How long the panel must be visible and focused before Allow counts. */
const ALLOW_DELAY_MS = 750;

const $ = <T extends HTMLElement>(id: string) =>
	document.getElementById(id) as T;

/**
 * Set an element's text only when it changes: a live region (`role="alert"`
 * or `"status"`) would be read out again on every state, and a selection in
 * it would be lost.
 */
function setText(element: HTMLElement, text: string): void {
	if (element.textContent !== text) element.textContent = text;
}

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
/** The address the setup steps were made for. */
let stepsFor = "";

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
		if (message?.type === "question-args") args.set(message.id, message.args);
		else if (message?.type === "state") show(message.state);
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
	setText($("state-text"), view.stateText);
	$("intro").hidden = !view.intro;
	setText($("intro"), view.intro ? introText(s.relay) : "");
	$("grants-note").hidden = view.grantsNote === "";
	setText($("grants-note"), view.grantsNote);
	// Also while connecting or retrying, so the user can stop it.
	const shown = switchShown(view.switchOn, switchIntent, Date.now());
	switchIntent = shown.intent;
	($("ai-switch") as HTMLInputElement).checked = shown.checked;
	$("ai-switch").setAttribute("aria-checked", String(shown.checked));
	$("connect").hidden = !view.turnOn;
	$("problem").hidden = s.problem === undefined;
	setText($("problem"), s.problem ?? "");
	$("replaced").hidden = s.replaced === undefined;
	setText(
		$("replaced-text"),
		s.replaced?.sibling
			? "Opened elsewhere in this browser: the address is in use there."
			: "Another tab or program took over this address, and the AI apps paired with it may now talk to it. Make a new address to disconnect them.",
	);
	$("grants").setAttribute(
		"aria-label",
		s.status === "on" ? "Connected AI apps" : "Paired AI apps",
	);
	// A keyboard user's focus stays on the app's Disconnect, which is made
	// anew: the second Enter of the two-step Disconnect must find it.
	const focused =
		document.activeElement instanceof HTMLElement &&
		document.activeElement.closest("#grants") !== null
			? document.activeElement.dataset["grant"]
			: undefined;
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
			// Disconnect goes through the relay: only while connected (EQ 8).
			li.append(app);
			if (view.disconnect) li.append(disconnectButton(grant));
			return li;
		}),
	);
	if (focused !== undefined)
		$("grants")
			.querySelector<HTMLButtonElement>(
				`button[data-grant="${CSS.escape(focused)}"]`,
			)
			?.focus();
	syncPairing(view.pairing);
	$("pairing").hidden = !view.pairing;
	$("add-app").hidden = !view.addApp;
	$("pair-done").hidden = !view.done;
	// The address only while pairing: it is what an AI app is added with.
	// Set only when it changes: a failed Copy selects it in place (EQ 16).
	setText($("address"), view.address);
	$("address").title = view.address;
	// The steps name the address: made again only when it changes, so a
	// "Copied" and the focus on a Copy stay. Shown with the address.
	if (view.address !== stepsFor) {
		stepsFor = view.address;
		$("setup-steps").replaceChildren(
			...(view.address === ""
				? []
				: setupSteps(document, view.address, copyStatus)),
		);
	}
	$("setup").hidden = view.address === "";
	const code = s.code;
	setText(
		$("code"),
		code === undefined ? "––– –––" : `${code.slice(0, 3)} ${code.slice(3)}`,
	);
	($("copy-code") as HTMLButtonElement).disabled = code === undefined;
	if (s.grants.length === 0) newAddressArmed = false;
	$("new-address-note").hidden = !newAddressArmed;
}

// --- Questions ---

/** Since when the panel has been visible and focused, if it is. */
let focusedSince: number | undefined;
const cards = new Map<
	string,
	{ card: HTMLElement; shownAt: number; question: QuestionSummary }
>();
/** Each question's arguments, sent once before the state that lists it. */
const args = new Map<string, string>();
/** How long the notice of a question nobody answered stays (EQ 13). */
const NOTICE_MS = 6000;

/**
 * Until when the panel's controls that allow something take no click after
 * its layout moved: a question that went away moves what was below it up,
 * and one that came moves it down, under the pointer; a click meant for what
 * was there must not land on an "Allow once", "Don't ask for these tools" or
 * an "Ask first" switch that came there instead (ES 5).
 */
let movedUntil = 0;
/** "Don't ask for these tools" as last shown: its visibility, label and tools. */
let allowAllShown = "";

function showQuestions(questions: QuestionSummary[], expired: string[]): void {
	const ids = new Set(questions.map((q) => q.id));
	for (const id of args.keys()) if (!ids.has(id)) args.delete(id);
	let removed = false;
	for (const [id, { card, question }] of cards)
		if (!ids.has(id)) {
			// The worker says it ran out unanswered: the tool did not run. Said
			// for a few seconds where the card was.
			if (expired.includes(id)) card.replaceWith(expiredNotice(question));
			else card.remove();
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
			const card = questionCard(
				{ ...q, args: args.get(q.id) ?? "" },
				(answer) => send({ type: "answer", id: q.id, answer }),
			);
			$("questions").append(card);
			const now = Date.now();
			cards.set(q.id, { card, shownAt: now, question: q });
			// A short line for screen readers, not the card with its arguments
			// (up to 1 MiB) as a live region (EQ 11).
			announce(questionAnnouncement(q));
			// Everything below the questions moved down by the card's height.
			movedUntil = now + ALLOW_DELAY_MS;
		}
	arm();
}

/**
 * Say `text` in the questions' status line, for screen readers: emptied
 * first, so the same line twice (two questions for the same tool) is said
 * twice. Lines that come within the same moment (two questions in one
 * state) are said together, none dropped.
 */
let announcing: ReturnType<typeof setTimeout> | undefined;
const toAnnounce: string[] = [];
function announce(text: string): void {
	const status = $("question-status");
	status.textContent = "";
	toAnnounce.push(text);
	clearTimeout(announcing);
	announcing = setTimeout(() => {
		status.textContent = toAnnounce.splice(0).join(" ");
	}, 50);
}

/** What is left of a question that nobody answered in time (EQ 13). */
function expiredNotice(q: QuestionSummary): HTMLElement {
	const notice = document.createElement("p");
	notice.className = "question-notice muted small";
	notice.textContent = `Not answered in time: ${q.tool} did not run.`;
	announce(notice.textContent);
	setTimeout(() => {
		notice.remove();
		// What was below moves up again.
		movedUntil = Date.now() + ALLOW_DELAY_MS;
		arm();
	}, NOTICE_MS);
	return notice;
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
	for (const { card, shownAt } of cards.values())
		setReady(
			card,
			focusedSince !== undefined &&
				now - Math.max(shownAt, focusedSince) >= ALLOW_DELAY_MS,
		);
	updateCountdowns($("questions"), now);
	// `aria-disabled`, not `disabled`: a focused control keeps its focus and
	// its place in the tab order during the wait (EQ 11).
	for (const control of document.querySelectorAll<HTMLElement>(
		"input.ask-first, #allow-tools",
	))
		setAvailable(control, now >= movedUntil);
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

/**
 * The tool's "Ask first" switch, for this site: on, it asks before each
 * call; off, it runs without asking, for every paired AI app. A switch with
 * a label that stays, not a badge that changes its text (EQ 9, EQ 11).
 */
function askFirstSwitch(origin: string, tool: ToolView): HTMLElement {
	const label = document.createElement("label");
	label.className = "ask-switch";
	const input = document.createElement("input");
	input.type = "checkbox";
	input.className = "ask-first";
	input.setAttribute("role", "switch");
	input.checked = !tool.allowed;
	input.dataset["tool"] = tool.name;
	input.setAttribute("aria-label", `Ask first: ${tool.title ?? tool.name}`);
	label.title = `On: asks you before each call. Off: runs without asking on ${origin}, for every paired AI app.`;
	setAvailable(input, Date.now() >= movedUntil);
	input.addEventListener("click", (event) => {
		// During the wait after the layout moved the click does nothing.
		if (isUnavailable(input)) {
			event.preventDefault();
			return;
		}
		send({
			type: "set-allowed",
			origin,
			name: tool.name,
			on: !input.checked,
		});
	});
	const text = document.createElement("span");
	text.textContent = "Ask first";
	text.setAttribute("aria-hidden", "true");
	label.append(input, text);
	return label;
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
					? askFirstSwitch(origin, tool)
					: badge("asks first", "asks"),
	);
	return li;
}

function showTab(s: PanelState): void {
	$("host-access").hidden = s.allSites;
	$("allowed-all").hidden = !s.allSites;
	const tab = s.tab;
	setText($("tab-title"), tab?.title ?? "–");
	setText($("tab-host"), tab?.host ?? "");
	const count = tab?.webmcp?.tools ?? 0;
	$("tab-badges").replaceChildren(
		...(tab === undefined
			? []
			: tab.webmcp === undefined
				? [badge("Not readable")]
				: count > 0
					? [badge(`WebMCP · ${count} tool${count === 1 ? "" : "s"}`, "reads")]
					: []),
	);
	// The panel's own words for why it may not read the tab (EQ 6).
	setText(
		$("tab-access"),
		tab?.noAccess !== undefined
			? noAccessText(tab.noAccess, s.allSites)
			: (tab?.access ?? ""),
	);
	// No tools: what still works, and where WebMCP comes from (EQ 7).
	const note = webmcpNote(tab);
	$("no-tools").hidden = note !== "no-tools";
	$("no-webmcp").hidden = note !== "no-webmcp";
	const allowAll = allowAllView(tab);
	// The page changed what the button over the list does (another label,
	// other tools, or it just came): it and the switches below wait, as when
	// a question went, so a click meant for the button as it was cannot allow
	// what it is now.
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
	setText(button, allowAll.label);
	const scope = tab?.origin ?? "this site";
	const label =
		allowAll.label === DONT_ASK_ALL
			? `Don't ask for the ${allowAll.names.length} tools listed on ${scope}, for every paired AI app`
			: `Ask first again for the ${allowAll.names.length} tools listed on ${scope}`;
	button.setAttribute("aria-label", label);
	button.title = label;
	setAvailable(button, Date.now() >= movedUntil);
	// The list is made anew: a keyboard user's focus goes back to the same
	// tool's switch, not to the page's body (EQ 11).
	const focused =
		document.activeElement instanceof HTMLElement &&
		document.activeElement.closest("#tools") !== null
			? document.activeElement.dataset["tool"]
			: undefined;
	$("tools").replaceChildren(
		...(tab?.tools ?? []).map((tool) =>
			toolItem(tab?.origin ?? "", tab?.canAllow === true, tool),
		),
	);
	if (focused !== undefined)
		$("tools")
			.querySelector<HTMLElement>(`[data-tool="${CSS.escape(focused)}"]`)
			?.focus();
}

function show(s: PanelState): void {
	const relayChanged = state?.relay !== s.relay;
	state = s;
	if (relayChanged) ($("relay") as HTMLInputElement).value = s.relay;
	showConnection(s);
	showQuestions(s.questions, s.expired);
	showTab(s);
}

// --- Controls ---

/**
 * A problem of the panel's own (Chrome refused a permission, the extension
 * was reloaded): in an element of its own, which the worker's states do not
 * overwrite (EQ 16).
 */
function problem(text: string): void {
	$("local-problem").hidden = false;
	setText($("local-problem"), text);
}

/**
 * What a Copy in the pairing box did, for everyone and for screen readers
 * (outside "How do I add it?", which may be closed).
 */
let copyStatusTimer: ReturnType<typeof setTimeout> | undefined;
function copyStatus(message: string): void {
	const status = $("copy-status");
	status.textContent = message;
	clearTimeout(copyStatusTimer);
	copyStatusTimer = setTimeout(() => {
		status.textContent = "";
	}, 5000);
}

/**
 * Copy `text` (shown in `shown`). The clipboard refused (the panel not
 * focused, say): the text is selected where it is, to copy by hand, as for
 * the setup commands; the states that follow leave it alone (EQ 16).
 */
function copy(
	button: HTMLElement,
	shown: HTMLElement,
	text: string | undefined,
	noun: string,
): void {
	if (text === undefined) return;
	copyText(
		button,
		text,
		() => {
			document.getSelection()?.selectAllChildren(shown);
			copyStatus(SELECTED);
		},
		noun,
		copyStatus,
	);
}

function addApp(on: boolean): void {
	addingApp = on;
	if (state) showConnection(state);
}

$("connect").addEventListener("click", () => send({ type: "connect" }));

$("ai-switch").addEventListener("change", () => {
	const intent: SwitchIntent = {
		on: ($("ai-switch") as HTMLInputElement).checked,
		until: Date.now() + SWITCH_WAIT_MS,
	};
	switchIntent = intent;
	// No state may follow (a connect that failed at once): the switch shows
	// the state again once the wait is over, not the flip for ever.
	switchExpiry(
		intent,
		() => switchIntent,
		() => {
			if (state) showConnection(state);
			else {
				switchIntent = undefined;
				($("ai-switch") as HTMLInputElement).checked = false;
				$("ai-switch").setAttribute("aria-checked", "false");
			}
		},
	);
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

$("copy").addEventListener("click", () =>
	copy($("copy"), $("address"), state?.address, "address"),
);
$("copy-code").addEventListener("click", () =>
	copy($("copy-code"), $("code"), state?.code, "code"),
);

$("allow-tools").addEventListener("click", () => {
	const button = $("allow-tools") as HTMLButtonElement;
	const tab = state?.tab;
	const view = allowAllView(tab);
	if (isUnavailable(button) || !view.shown || tab?.origin === undefined) return;
	send({
		type: "set-allowed-all",
		origin: tab.origin,
		names: view.names,
		on: view.on,
	});
});

$("allow-all").addEventListener("click", () => {
	$("local-problem").hidden = true;
	// From the click: Chrome asks the user. The worker hears of the change.
	chrome.permissions
		.request(ALL_SITES)
		.catch((error: unknown) => problem(String(error)));
});

$("disallow-all").addEventListener("click", () => {
	$("local-problem").hidden = true;
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
