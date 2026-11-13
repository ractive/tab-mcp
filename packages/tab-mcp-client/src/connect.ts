/**
 * The "Connect your AI app" dialog (DEC-028) and the notice that the page
 * lost its address, loaded on demand when a page opens the dialog.
 */

import { allowedFor } from "./always-allowed.ts";
import {
	button,
	clientLabel,
	copyButton,
	el,
	fill,
	format,
	listOf,
	newDialog,
	nextId,
	stringsOf,
	visible,
} from "./dialog.ts";
import { SETUP_GUIDE, setupInstructions } from "./setup.ts";
import type { DialogStrings } from "./strings.ts";
import type { TabMcp } from "./tab-mcp.ts";
import type {
	DialogOptions,
	DisconnectReason,
	Grant,
	PairingCode,
	SessionInfo,
	StateChangeDetail,
} from "./types.ts";

/**
 * The labels of the apps behind these grants, each once: an app can hold
 * more than one grant (paired twice), and is still one app.
 */
function appLabels(grants: readonly Grant[], s: DialogStrings): string[] {
	return [...new Set(grants.map((g) => clientLabel(g.client, s)))];
}

/**
 * Why connecting failed, in the user's words (CU 4). The error itself, with
 * the relay's wording, goes to the console. Without a `reason` it never
 * started (no user action, cancelled): just not connected.
 */
function connectFailure(error: unknown, s: DialogStrings): string {
	console.warn("tab-mcp: could not connect.", error);
	const reason = (error as { reason?: DisconnectReason } | null)?.reason;
	if (reason === undefined) return s.notConnected;
	if (reason === "network") return s.unreachable;
	if (reason === "rate_limited") return s.rateLimited;
	return s.refused;
}

/** Why the page was disconnected, in the user's words (CU 4). */
function disconnectedText(reason: DisconnectReason, s: DialogStrings): string {
	switch (reason) {
		case "expired":
		case "idle":
			return s.ended;
		case "user":
			return s.disconnected;
		case "network":
		case "heartbeat":
		case "shutdown":
			return s.lost;
		case "rate_limited":
			return s.rateLimited;
		default:
			return s.closed;
	}
}

/**
 * With identity binding: what stands between the user and the address until
 * the relay knows who is signed in (CU 7). `undefined` once it does.
 */
function signInText(mcp: TabMcp, s: DialogStrings): string | undefined {
	switch (mcp.identity) {
		case "bound":
			return undefined;
		case "pending":
			return s.checkingSignIn;
		case "refused":
			return mcp.identityMessage
				? format(s.signInRefusedWhy, { reason: mcp.identityMessage })
				: s.signInRefused;
		default:
			return s.signInFirst;
	}
}

/** The document and texts of the connect dialog per `TabMcp`, once it was opened. */
const watched = new WeakMap<TabMcp, { doc: Document; ui?: DialogOptions }>();

/**
 * Once a page has opened the connect dialog, the default UI also says when
 * the page loses its address (`replaced`), in that dialog's document.
 */
function watchReplaced(mcp: TabMcp, doc: Document, ui?: DialogOptions): void {
	const known = watched.has(mcp);
	watched.set(mcp, ui === undefined ? { doc } : { doc, ui });
	if (known) return;
	mcp.addEventListener("replaced", (event) => {
		const current = watched.get(mcp);
		// Not when the page already went on (a New address or connect since).
		if (current !== undefined && mcp.state === "disconnected")
			replacedNotice(mcp, current.doc, event.detail.sibling, current.ui);
	});
}

/**
 * Says that the page lost its address (`replaced`, DEC-095). A sibling tab
 * that announced it: "Opened in another tab", nothing to do. Otherwise a
 * warning that another tab or program took over, with "New address", which
 * takes the address back, disconnects its apps, connects with a new one and
 * opens the connect dialog to add it to the AI apps again.
 */
export function replacedNotice(
	mcp: TabMcp,
	doc: Document,
	sibling: boolean,
	ui?: DialogOptions,
): void {
	const s = stringsOf(ui);
	(
		doc.querySelector("dialog.tab-mcp-replaced") as HTMLDialogElement | null
	)?.close();
	const { dialog } = newDialog(
		doc,
		"tab-mcp-replaced",
		s,
		sibling ? s.replacedSiblingTitle : s.replacedTitle,
	);
	const status = el(doc, "p", { className: "tab-mcp-status" });
	status.setAttribute("role", "status");
	status.hidden = true;
	const close = button(
		doc,
		s.close,
		() => dialog.close(),
		"tab-mcp-replaced-close",
		sibling ? "primary" : undefined,
	);
	const actions = el(doc, "div", { className: "tab-mcp-actions" }, close);
	let first = close;
	if (!sibling) {
		const fresh = button(
			doc,
			s.newAddress,
			() => {
				fresh.disabled = true;
				status.hidden = false;
				status.textContent = s.gettingNewAddress;
				mcp.newAddress().then(
					() => {
						dialog.close();
						mcp.showConnectDialog({ document: doc }).catch(() => {});
					},
					(error: unknown) => {
						fresh.disabled = false;
						status.textContent =
							(error as { reason?: unknown } | null)?.reason === "replaced"
								? s.takenOverAgain
								: format(s.tryAgainOrClose, {
										reason: connectFailure(error, s),
									});
					},
				);
			},
			"tab-mcp-new-address",
			"primary",
		);
		actions.append(" ", fresh);
		first = fresh;
	}
	dialog.append(
		el(doc, "p", {
			className: "tab-mcp-description",
			text: sibling ? s.replacedSibling : s.replaced,
		}),
		status,
		actions,
	);
	dialog.addEventListener("close", () => dialog.remove(), { once: true });
	doc.body.append(dialog);
	dialog.showModal();
	first.focus();
}

/**
 * How long a used code stays "Code used" before its replacement is shown: the
 * AI app connects a moment after the code was entered (its token request), and
 * a new code in plain view meanwhile looks as if it did not work. Only when
 * the relay says the code was used (`reason: "used"`); a relay that does not
 * say why gets the new code shown at once.
 */
export const CODE_USED_WAIT_MS = 10_000;

/**
 * The "Connect your AI app" dialog: the address with Copy, how to add it,
 * the pairing code (with Copy) while the relay sends one, New address, and
 * the connected apps with Disconnect (and the tools allowed until reload
 * for each, with Ask again). Pairing is on while it is open, so closing it
 * ends the code; the connection and the address stay. Until an app is
 * connected, only a small Close (and Escape) close it. Once one is, a
 * confirmation leads, the setup moves behind "Connect another app" and
 * Done is the primary button. New address asks first when it would
 * disconnect connected apps. When the page loses its address (`replaced`),
 * this dialog closes and `replacedNotice` says why, from then on also while
 * it is closed.
 *
 * Its nodes are built once; one `render()` derives what is shown from `mcp`
 * and a few flags of its own after every change, so nothing flickers and
 * focus stays, or moves to the next step when its control was hidden.
 */
export function showConnectDialog(
	mcp: TabMcp,
	connecting: Promise<SessionInfo>,
	doc: Document,
	serverName = "tools",
	ui?: DialogOptions,
): Promise<void> {
	const s = stringsOf(ui);
	const allowed = allowedFor(mcp);
	const { dialog } = newDialog(doc, "tab-mcp-connect", s, s.connectTitle);
	// Focusable from script only, for the moment before the address is shown.
	dialog.tabIndex = -1;
	const status = el(doc, "p", { className: "tab-mcp-status" });
	status.setAttribute("role", "status");
	// What a Copy did, for assistive technology only; out of sight, also
	// without the stylesheet. The same message twice is still a change.
	const live = el(doc, "span", { className: "tab-mcp-announce" });
	live.setAttribute("aria-live", "polite");
	for (const [property, value] of [
		["position", "absolute"],
		["width", "1px"],
		["height", "1px"],
		["overflow", "hidden"],
		["clip-path", "inset(50%)"],
		["white-space", "nowrap"],
	] as const)
		live.style.setProperty(property, value);
	const announce = (text: string) => {
		live.textContent = live.textContent === text ? `${text} ` : text;
	};

	// The confirmation once an app is connected: what happened, what next.
	const successId = `${nextId()}-success`;
	const successTitle = el(doc, "p", { className: "tab-mcp-success-title" });
	const successNext = el(doc, "p", { className: "tab-mcp-success-next" });
	// A check mark in a tinted disk, drawn by the stylesheet (CU 19).
	const check = el(doc, "span", { className: "tab-mcp-success-icon" });
	check.setAttribute("aria-hidden", "true");
	const success = el(
		doc,
		"div",
		{ className: "tab-mcp-success", id: successId },
		check,
		el(
			doc,
			"div",
			{ className: "tab-mcp-success-text" },
			successTitle,
			successNext,
		),
	);

	const addressId = `${nextId()}-address`;
	const label = el(doc, "label", { text: s.addressLabel });
	label.htmlFor = addressId;
	const address = el(doc, "input", {
		id: addressId,
		className: "tab-mcp-address-input",
	});
	address.readOnly = true;
	// Copying the address is the first step: the primary button, until an
	// app is connected (then Done is).
	const { button: copy, reset: resetCopy } = copyButton(
		doc,
		s,
		s.copyAddress,
		() => address.value,
		() => address.select(),
		announce,
		"tab-mcp-address-copy",
		"primary",
	);
	const addressBox = el(
		doc,
		"div",
		{ className: "tab-mcp-address" },
		label,
		address,
		" ",
		copy,
	);

	// Not next to Copy, and saying what it does (CU 23): with no app connected
	// it changes the address at once, also one just pasted into an AI app.
	const fresh = button(
		doc,
		s.newAddress,
		() => askNewAddress(),
		"tab-mcp-new-address",
	);
	const freshBox = el(
		doc,
		"div",
		{ className: "tab-mcp-new-address-row" },
		el(doc, "small", { text: s.newAddressNote }),
		" ",
		fresh,
	);
	// Asked in the dialog before New address disconnects connected apps.
	const questionId = `${nextId()}-new-address`;
	const questionText = el(doc, "p", { id: questionId });
	const cancelNew = button(doc, s.cancel, () => {
		asking = false;
		render();
		fresh.focus();
	});
	const confirmNew = button(
		doc,
		s.newAddressConfirm,
		() => getNewAddress(),
		"tab-mcp-new-address-confirm",
		"danger",
	);
	const question = el(
		doc,
		"div",
		{ className: "tab-mcp-new-address-question" },
		questionText,
		el(
			doc,
			"div",
			{ className: "tab-mcp-actions" },
			cancelNew,
			" ",
			confirmNew,
		),
	);
	question.setAttribute("role", "group");
	question.setAttribute("aria-labelledby", questionId);

	// Large, in a monospace font: a new code takes the same room.
	const code = el(doc, "strong", { className: "tab-mcp-code-value" });
	// One click selects the whole code; it stays plain, selectable text.
	code.style.setProperty("user-select", "all");
	code.style.setProperty("-webkit-user-select", "all");
	// Reads the code shown at click time, so a rotated code is copied as shown.
	const { button: copyCode, reset: resetCopyCode } = copyButton(
		doc,
		s,
		s.copyCode,
		() => code.textContent ?? "",
		() => doc.getSelection()?.selectAllChildren(code),
		announce,
		"tab-mcp-code-copy",
	);
	// Only the sentence with the code is announced when the code changes,
	// not its Copy button's "Copied".
	const codeSentence = el(
		doc,
		"span",
		{},
		...fill(doc, s.codeSentence, { code }),
	);
	codeSentence.setAttribute("aria-live", "polite");
	// In the code's place while the AI app finishes connecting with it.
	const codeUsed = el(doc, "span", { className: "tab-mcp-code-used" });
	const codeLine = el(
		doc,
		"p",
		{ className: "tab-mcp-code" },
		codeSentence,
		codeUsed,
		" ",
		copyCode,
		el(doc, "br"),
		el(doc, "small", { className: "tab-mcp-code-note", text: s.codeNote }),
	);
	// Identity binding: no code, the same account at the AI app's sign-in.
	const signInLine = el(doc, "p", {
		className: "tab-mcp-sign-in",
		text: s.signIn,
	});

	const steps = el(doc, "ul");
	const help = el(
		doc,
		"details",
		{ className: "tab-mcp-help" },
		el(doc, "summary", { text: s.help }),
		steps,
	);
	const guideUrl = ui?.setup?.guide === undefined ? SETUP_GUIDE : ui.setup.guide;
	if (guideUrl !== null) {
		const guide = el(doc, "a", { text: s.guide });
		guide.href = guideUrl;
		guide.target = "_blank";
		guide.rel = "noopener noreferrer";
		help.append(el(doc, "p", { className: "tab-mcp-guide" }, guide));
	}
	const instructions = ui?.setup?.instructions ?? setupInstructions;

	// Everything for adding the page to an AI app. Once one is connected, it
	// is behind "Connect another app", closed: the next code is not news.
	// Where to paste the address comes right after it, the code after that
	// (CU 23); New address last. The help stays closed (DEC-147).
	const setupId = `${nextId()}-setup`;
	const setup = el(
		doc,
		"div",
		{ className: "tab-mcp-setup", id: setupId },
		addressBox,
		help,
		codeLine,
		signInLine,
		freshBox,
		question,
	);
	const setupToggle = button(
		doc,
		s.connectAnother,
		() => {
			expanded = !expanded;
			render();
		},
		"tab-mcp-setup-toggle",
	);
	setupToggle.setAttribute("aria-controls", setupId);

	const appList = el(doc, "ul");
	const appsNote = el(doc, "p", { className: "tab-mcp-apps-note" });
	appsNote.setAttribute("role", "status");
	const apps = el(
		doc,
		"div",
		{ className: "tab-mcp-apps" },
		el(doc, "h3", { text: s.connectedHeading }),
		appList,
		appsNote,
	);

	// Until an app is connected, closing it is not the next step: a small
	// Close at the end, saying what closing does (the code stops, the address
	// stays). Once one is, a prominent Done replaces both.
	const closeNote = el(doc, "small", {
		className: "tab-mcp-close-note",
		text: s.closeNote,
	});
	const close = button(doc, s.close, () => dialog.close(), "tab-mcp-close");
	const done = button(
		doc,
		s.done,
		() => dialog.close(),
		"tab-mcp-done",
		"primary",
	);
	// While not connected (it failed, the session ended, it reconnects): the
	// next step, from a click, so it has the user action it needs (CU 4).
	// While reconnecting, connect() makes the next attempt at once.
	const retry = button(
		doc,
		s.connectAgain,
		() => {
			message = undefined;
			mcp.connect().then(
				() => {
					if (doc.activeElement === close) start().focus();
				},
				(error: unknown) => {
					message = connectFailure(error, s);
					render();
					// Focus went to Close while it connected: back to Connect
					// again, so a second Enter tries again instead of closing.
					if (doc.activeElement === close && !retry.hidden) retry.focus();
				},
			);
			render();
		},
		"tab-mcp-retry",
		"primary",
	);
	const actions = el(
		doc,
		"div",
		{ className: "tab-mcp-actions" },
		closeNote,
		" ",
		close,
		retry,
		done,
	);
	dialog.append(success, status, apps, setupToggle, setup, actions, live);

	// The dialog's own state; the rest is read from `mcp` in `render()`.
	/** The setup is open while an app is connected. */
	let expanded = false;
	/** The New address question is open. */
	let asking = false;
	/** New address waits for the new session. */
	let renewing = false;
	/** New address got its session; until an app pairs or it disconnects. */
	let renewed = false;
	/** Why it is not connected, in the user's words, while it is not. */
	let message: string | undefined;
	/** Why the last Disconnect failed, while connected. */
	let appsProblem: string | undefined;
	/** The grants of the last render: a new one is an app that just paired. */
	let grantsSeen = new Set(mcp.grants.map((g) => g.grantId));
	/** The address the help's steps were made for. */
	let stepsFor: string | undefined;
	/** The code shown, and the wait after it was used (until the app connects). */
	let shownCode: PairingCode | undefined;
	let usedTimer: ReturnType<typeof setTimeout> | undefined;
	/** Shown in the connected state. */
	let connectedView = false;

	// Where focus goes when its control was hidden: the next step (Done or
	// Connect again), else Close.
	const closer = () => (connectedView ? done : retry.hidden ? close : retry);
	// Where focus starts: Done once connected, else the address's Copy.
	const start = () => (connectedView ? done : copy);

	// One item per grant, kept while the grant is: a focused Disconnect keeps
	// its focus. Under it, the tools allowed until reload, with Ask again.
	const items = new Map<
		string,
		{
			item: HTMLLIElement;
			disconnect: HTMLButtonElement;
			allowedText: HTMLElement;
			allowedBox: HTMLElement;
		}
	>();
	const appItem = (grant: Grant) => {
		const app = clientLabel(grant.client, s);
		const disconnect = button(
			doc,
			s.disconnect,
			() => {
				appsProblem = undefined;
				mcp.revoke(grant.grantId).catch((error: unknown) => {
					// Not connected any more: the note says so already.
					if (mcp.state === "connected")
						appsProblem =
							(error as { code?: unknown } | null)?.code ===
							"store_unavailable"
								? s.storeUnavailable
								: s.disconnectFailed;
					render();
				});
				render();
			},
			"tab-mcp-disconnect",
			"danger",
		);
		// One name per button: each list item has its own Disconnect.
		disconnect.setAttribute("aria-label", format(s.disconnectApp, { app }));
		const askAgain = button(
			doc,
			s.askAgain,
			() => allowed.forget(grant.grantId),
			"tab-mcp-ask-again",
		);
		askAgain.setAttribute("aria-label", format(s.askAgainApp, { app }));
		const allowedText = el(doc, "span");
		const allowedBox = el(
			doc,
			"div",
			{ className: "tab-mcp-allowed" },
			allowedText,
			" ",
			askAgain,
		);
		const item = el(
			doc,
			"li",
			{},
			el(
				doc,
				"span",
				{ className: "tab-mcp-app" },
				format(s.appConnected, { app }),
			),
			" ",
			disconnect,
			allowedBox,
		);
		return { item, disconnect, allowedText, allowedBox };
	};

	/** The steps for `address` in the help, made again when it changes. */
	const renderSteps = (session: SessionInfo) => {
		if (stepsFor === session.address) return;
		stepsFor = session.address;
		steps.replaceChildren(
			...instructions(serverName, session.address).map(
				({ app, text: how, command, note }) => {
					const item = el(
						doc,
						"li",
						{},
						el(doc, "strong", { text: `${app}:` }),
						` ${how}`,
					);
					if (command !== undefined) {
						// A block with its own Copy, like the code.
						const text = el(doc, "pre", { text: command });
						text.dir = "ltr";
						const { button: copyCommand } = copyButton(
							doc,
							s,
							format(s.copyCommand, { app }),
							() => text.textContent ?? "",
							() => doc.getSelection()?.selectAllChildren(text),
							announce,
							"tab-mcp-command-copy",
						);
						item.append(
							el(
								doc,
								"div",
								{ className: "tab-mcp-command" },
								text,
								copyCommand,
							),
						);
					}
					if (note !== undefined)
						item.append(
							el(
								doc,
								"small",
								{ className: "tab-mcp-command-note" },
								...note.map((part) =>
									"code" in part
										? el(doc, "code", { text: part.code })
										: part.text,
								),
							),
						);
					return item;
				},
			),
		);
	};

	/** The pairing code, or "Code used" in its place while the AI app connects. */
	const renderCode = (paired: boolean) => {
		const current = mcp.pairingCode;
		if (current === undefined || paired) {
			// None any more, or the app connected: the next code shows.
			clearTimeout(usedTimer);
			usedTimer = undefined;
		} else if (current.code !== shownCode?.code) {
			if (current.reason === "used") {
				// Entered just now: no new code in plain view while the AI app
				// connects; it shows if none does.
				if (usedTimer === undefined) {
					usedTimer = setTimeout(() => {
						// No app came: the code shows (unless another came meanwhile).
						usedTimer = undefined;
						shownCode = mcp.pairingCode;
						render();
					}, CODE_USED_WAIT_MS);
					announce(s.codeUsed);
				}
			} else if (usedTimer !== undefined) {
				// Locked or expired meanwhile: the user needs this one now.
				clearTimeout(usedTimer);
				usedTimer = undefined;
			}
		}
		const used = usedTimer !== undefined;
		if (!used) {
			// A new code is not copied yet.
			if (code.textContent !== (current?.code ?? "")) resetCopyCode();
			code.textContent = current?.code ?? "";
			shownCode = current;
		}
		codeSentence.hidden = used;
		copyCode.hidden = used;
		codeUsed.hidden = !used;
		codeUsed.textContent = used ? s.codeUsed : "";
		return current !== undefined;
	};

	/** Shows what `mcp` and the flags say; keeps the focus on a shown control. */
	const render = () => {
		const focused = doc.activeElement;
		const { state, session, grants } = mcp;
		const connected = state === "connected";
		const oidc = session?.pairing === "oidc";
		// With identity binding, the address is of no use until the relay
		// knows who is signed in to the page: the status says what is missing.
		const signIn = oidc ? signInText(mcp, s) : undefined;
		const shown = session !== undefined && signIn === undefined;

		// An app that paired just now: the setup closes again (unless the New
		// address question is open in it), and the confirmation is announced.
		const ids = new Set(grants.map((g) => g.grantId));
		const paired = connected && grants.some((g) => !grantsSeen.has(g.grantId));
		grantsSeen = ids;
		if (paired) {
			renewed = false;
			if (!asking) expanded = false;
		}
		// Nobody left to disconnect: no question needed.
		const names = appLabels(grants, s);
		if (names.length === 0 || !shown) asking = false;

		connectedView = !renewing && connected && grants.length > 0;
		const one = names.length === 1;
		successTitle.textContent = format(
			one ? s.connectedOne : s.connectedMany,
			{ apps: listOf(names, s) },
		);
		successNext.textContent = one ? s.connectedNextOne : s.connectedNextMany;
		if (connectedView) dialog.setAttribute("aria-describedby", successId);
		else dialog.removeAttribute("aria-describedby");
		success.hidden = !connectedView;

		// The status line is for the setup; the confirmation says it otherwise.
		if (connected) message = undefined;
		const appName = session?.appName;
		status.textContent = renewing
			? s.gettingNewAddress
			: state === "connecting"
				? s.connecting
				: state === "reconnecting"
					? s.reconnecting
					: !connected
						? (message ?? s.notConnected)
						: (signIn ??
							(renewed
								? s.newAddressDone
								: appName !== undefined
									? format(s.readyApp, { app: appName })
									: s.readyPage));
		status.hidden = connectedView;

		// The address, its help and New address.
		const addressShownBefore = !addressBox.hidden;
		if (shown && address.value !== session.address) {
			address.value = session.address;
			resetCopy();
		}
		if (shown) renderSteps(session);
		addressBox.hidden = help.hidden = freshBox.hidden = !shown;
		fresh.disabled = !connected;
		question.hidden = !asking;
		if (asking)
			questionText.textContent = format(
				one ? s.newAddressQuestionOne : s.newAddressQuestionMany,
				{ apps: listOf(names, s) },
			);
		const hasCode = renderCode(paired);
		codeLine.hidden = oidc || !hasCode || !connected;
		signInLine.hidden = !oidc || mcp.identity !== "bound";

		setupToggle.hidden = !connectedView;
		setupToggle.setAttribute("aria-expanded", String(expanded));
		setup.hidden = connectedView && !expanded;
		copy.classList.toggle("tab-mcp-primary", !connectedView);

		// The connected apps; only the relay can revoke, so only while connected.
		for (const [id, { item }] of items) {
			if (ids.has(id)) continue;
			item.remove();
			items.delete(id);
		}
		grants.forEach((grant, i) => {
			let entry = items.get(grant.grantId);
			if (entry === undefined) {
				entry = appItem(grant);
				items.set(grant.grantId, entry);
			}
			entry.disconnect.disabled = !connected;
			const tools = allowed.list(grant.grantId);
			entry.allowedBox.hidden = tools.length === 0;
			entry.allowedText.textContent = format(s.runsWithoutAsking, {
				tools: tools.map(visible).join(", "),
			});
			if (appList.children[i] !== entry.item)
				appList.insertBefore(entry.item, appList.children[i] ?? null);
		});
		appsNote.textContent = connected ? (appsProblem ?? "") : s.disconnectNote;
		appsNote.hidden = connected && appsProblem === undefined;
		apps.hidden = grants.length === 0;

		// The note is about the code: only while one is shown and none connected.
		closeNote.hidden = connectedView || codeLine.hidden;
		close.hidden = connectedView;
		done.hidden = !connectedView;
		retry.hidden =
			renewing || (state !== "disconnected" && state !== "reconnecting");

		// Focus never stays on a control that was hidden or removed; from the
		// New address question that closed, back to New address.
		if (
			focused !== null &&
			focused !== dialog &&
			focused !== doc.body &&
			(!focused.isConnected ||
				(dialog.contains(focused) && focused.closest("[hidden]") !== null))
		)
			(question.contains(focused) && !freshBox.hidden
				? fresh
				: closer()
			).focus();
		// The address showed only now: start there (or at Done), or, after a
		// New address, at its Copy.
		else if (doc.activeElement === dialog && (connectedView || shown))
			start().focus();
		else if (renewed && shown && !addressShownBefore && doc.activeElement === close)
			copy.focus();
		if (paired && connectedView)
			announce(`${successTitle.textContent}. ${successNext.textContent}`);
	};

	const askNewAddress = () => {
		if (mcp.state !== "connected") return;
		if (mcp.grants.length === 0) {
			getNewAddress();
			return;
		}
		asking = true;
		render();
		cancelNew.focus(); // the safe choice is the default
	};
	const getNewAddress = () => {
		renewing = true;
		renewed = false;
		// Focus moves before the focused control is hidden.
		close.focus();
		asking = false;
		render();
		// Called from the click, so the reconnect has the user action it needs.
		mcp.newAddress().then(
			() => {
				renewing = false;
				renewed = true;
				render();
				// At its Copy once the new address shows (with identity binding
				// maybe only later: `render()` moves it then).
				if (!addressBox.hidden) copy.focus();
			},
			(error: unknown) => {
				renewing = false;
				message = connectFailure(error, s);
				render();
				closer().focus();
			},
		);
	};

	// A refusal that stops reconnecting comes as `error` (with its `reason`)
	// just before the `statechange` to `disconnected`: that says why it stopped.
	let stoppedBy: unknown;
	let wasReconnecting = mcp.state === "reconnecting";
	const onError = (event: CustomEvent<{ error: Error }>) => {
		const { error } = event.detail;
		if (wasReconnecting && (error as { reason?: unknown }).reason !== undefined)
			stoppedBy = error;
	};
	const onState = (event: CustomEvent<StateChangeDetail>) => {
		const { state, reason } = event.detail;
		if (reason !== undefined && reason !== "new_address") {
			message = disconnectedText(reason, s);
			renewed = false;
		}
		// Refused, or ended by the page (`disconnect()`) while it waited.
		if (state === "disconnected" && wasReconnecting)
			message =
				stoppedBy === undefined ? s.disconnected : connectFailure(stoppedBy, s);
		wasReconnecting = state === "reconnecting";
		stoppedBy = undefined;
		render();
	};

	// The address was taken over: the notice says so instead of this dialog.
	const onReplaced = () => dialog.close();
	watchReplaced(mcp, doc, ui);
	const stopAllowed = allowed.onChange(render);
	mcp.addEventListener("statechange", onState);
	mcp.addEventListener("pairingcode", render);
	mcp.addEventListener("grantschange", render);
	mcp.addEventListener("identitychange", render);
	mcp.addEventListener("error", onError);
	mcp.addEventListener("replaced", onReplaced);
	doc.body.append(dialog);
	mcp.startPairing();
	render();
	connecting.then(render, (error: unknown) => {
		message = connectFailure(error, s);
		render();
	});

	return new Promise((resolve) => {
		dialog.addEventListener(
			"close",
			() => {
				clearTimeout(usedTimer);
				mcp.stopPairing();
				stopAllowed();
				mcp.removeEventListener("statechange", onState);
				mcp.removeEventListener("pairingcode", render);
				mcp.removeEventListener("grantschange", render);
				mcp.removeEventListener("identitychange", render);
				mcp.removeEventListener("error", onError);
				mcp.removeEventListener("replaced", onReplaced);
				dialog.remove();
				resolve();
			},
			{ once: true },
		);
		dialog.showModal();
		// Start at Done once connected, else at the address's Copy; until the
		// address is there, at the dialog itself (its title is read out), not
		// at Close.
		if (connectedView || !addressBox.hidden) start().focus();
		else dialog.focus();
	});
}
