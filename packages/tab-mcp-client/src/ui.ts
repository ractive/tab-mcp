/**
 * The default UI, loaded on demand: the "Connect your AI app" dialog
 * (DEC-028) and the confirmation of consequential tools. Plain `<dialog>`
 * elements, no styles beyond a few CSS custom properties (`--tab-mcp-*`), all
 * text set with `textContent`. Pages with their own UI use the events and
 * methods of `TabMcp` instead.
 */

import type { TabMcp } from "./tab-mcp.ts";
import type {
	ConfirmRequest,
	DisconnectDetail,
	Grant,
	SessionInfo,
	ToolCallClient,
} from "./types.ts";

let counter = 0;

function el<K extends keyof HTMLElementTagNameMap>(
	doc: Document,
	tag: K,
	props: { className?: string; text?: string; id?: string } = {},
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const node = doc.createElement(tag);
	if (props.className !== undefined) node.className = props.className;
	if (props.id !== undefined) node.id = props.id;
	if (props.text !== undefined) node.textContent = props.text;
	node.append(...children);
	return node;
}

function button(
	doc: Document,
	text: string,
	onClick: () => void,
): HTMLButtonElement {
	const node = el(doc, "button", { text });
	node.type = "button";
	node.addEventListener("click", onClick);
	return node;
}

/**
 * A Copy button for `value()`, read at click time. Shows "Copied" once the
 * clipboard took it; without a clipboard (or when it refuses) `select()` puts
 * the text in the selection for Ctrl+C instead. `noun` names it for assistive
 * technology ("Copy code"), as the dialog has more than one Copy.
 */
function copyButton(
	doc: Document,
	noun: string,
	value: () => string,
	select: () => void,
): { button: HTMLButtonElement; reset: () => void } {
	const node = button(doc, "Copy", () => {
		const done = () => {
			node.textContent = "Copied";
			node.setAttribute("aria-label", `Copied ${noun}`);
		};
		const clipboard = (doc.defaultView?.navigator as Navigator | undefined)
			?.clipboard;
		if (clipboard !== undefined)
			clipboard.writeText(value()).then(done, select);
		else select();
	});
	const reset = () => {
		node.textContent = "Copy";
		node.setAttribute("aria-label", `Copy ${noun}`);
	};
	reset();
	return { button: node, reset };
}

function newDialog(
	doc: Document,
	className: string,
	title: string,
): { dialog: HTMLDialogElement; heading: HTMLHeadingElement } {
	const id = `tab-mcp-${++counter}`;
	const dialog = el(doc, "dialog", {
		className: `tab-mcp-dialog ${className}`,
	});
	dialog.setAttribute("aria-labelledby", `${id}-title`);
	// CSSOM properties are allowed under a strict CSP (no inline style attribute).
	const style = dialog.style;
	style.setProperty("max-width", "var(--tab-mcp-max-width, 34rem)");
	style.setProperty("font", "var(--tab-mcp-font, inherit)");
	style.setProperty("color", "var(--tab-mcp-color, CanvasText)");
	style.setProperty("background", "var(--tab-mcp-background, Canvas)");
	style.setProperty("border", "var(--tab-mcp-border, 1px solid GrayText)");
	style.setProperty("border-radius", "var(--tab-mcp-radius, 0.5rem)");
	style.setProperty("padding", "var(--tab-mcp-padding, 1rem 1.25rem)");
	const heading = el(doc, "h2", { id: `${id}-title`, text: title });
	heading.style.setProperty("margin-top", "0");
	heading.style.setProperty("font-size", "var(--tab-mcp-title-size, 1.25em)");
	dialog.append(heading);
	return { dialog, heading };
}

function clientLabel(client: ToolCallClient | Grant["client"]): string {
	const host = client.host || client.id;
	return client.name !== undefined && client.name !== ""
		? `${client.name} (${host})`
		: host;
}

/**
 * The arguments as text, in full: what the user approves must be visible.
 * (The relay caps a request at 1 MiB, so this stays bounded.) `undefined`
 * when they cannot be shown, and then "Allow" is not offered.
 */
function showArguments(args: Record<string, unknown>): string | undefined {
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return undefined;
	}
}

/** How long "Allow" stays disabled after the confirmation opens, and the floor. */
export const ALLOW_DELAY_MS = 750;
export const MIN_ALLOW_DELAY_MS = 500;

/** The user's answer: "always" allows this tool for this AI app from now on. */
export type ConfirmAnswer = "allow" | "always" | "deny";

/**
 * Ask whether a consequential tool may run. "Allow" and "Always allow" stay
 * disabled for `allowDelayMs` (default 750, at least 500) after the dialog
 * opens, so a click meant for the page cannot approve. Everything else
 * (Don't allow, Escape, an aborted call) is "deny".
 */
export function confirmDialog(
	request: ConfirmRequest,
	doc: Document,
	options: { allowDelayMs?: number } = {},
): Promise<ConfirmAnswer> {
	const delay = Math.max(
		MIN_ALLOW_DELAY_MS,
		options.allowDelayMs ?? ALLOW_DELAY_MS,
	);
	if (request.signal.aborted) return Promise.resolve("deny");
	const title = request.tool.title ?? request.tool.name;
	const { dialog } = newDialog(doc, "tab-mcp-confirm", `Allow ${title}?`);
	const deny = button(doc, "Don't allow", () => dialog.close("deny"));
	const allow = button(doc, "Allow", () => {
		if (!allow.disabled) dialog.close("allow");
	});
	const always = button(doc, "Always allow", () => {
		if (!always.disabled) dialog.close("always");
	});
	allow.disabled = true;
	always.disabled = true;
	const actions = el(
		doc,
		"div",
		{ className: "tab-mcp-actions" },
		deny,
		" ",
		allow,
		" ",
		always,
	);
	const alwaysNote = el(doc, "p", {
		className: "tab-mcp-always-note",
		text: `Always allow: ${title} runs without asking for ${clientLabel(request.client)} until you reload this page or disconnect it.`,
	});
	const shown = showArguments(request.arguments);
	const args = el(doc, "pre", {
		className: "tab-mcp-arguments",
		text:
			shown ?? "The arguments cannot be shown, so this call cannot be allowed.",
	});
	if (shown === undefined) {
		allow.hidden = true;
		always.hidden = true;
		alwaysNote.hidden = true;
	}
	args.style.setProperty("white-space", "pre-wrap");
	args.style.setProperty("max-height", "12rem");
	args.style.setProperty("overflow", "auto");
	args.hidden = Object.keys(request.arguments).length === 0;
	dialog.append(
		el(doc, "p", {
			text: `${clientLabel(request.client)} wants to run ${title}.`,
		}),
		el(doc, "p", {
			className: "tab-mcp-description",
			text: request.tool.description,
		}),
		args,
		actions,
		alwaysNote,
	);
	doc.body.append(dialog);
	return new Promise((resolve) => {
		const onAbort = () => dialog.close("deny");
		request.signal.addEventListener("abort", onAbort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		dialog.addEventListener(
			"close",
			() => {
				clearTimeout(timer);
				request.signal.removeEventListener("abort", onAbort);
				const value = dialog.returnValue;
				dialog.remove();
				resolve(value === "allow" || value === "always" ? value : "deny");
			},
			{ once: true },
		);
		dialog.showModal();
		deny.focus(); // the safe choice is the default
		// Counted from when the dialog is shown, not from when it was built.
		timer = setTimeout(() => {
			allow.disabled = false;
			always.disabled = false;
		}, delay);
	});
}

const INSTRUCTIONS: [string, string][] = [
	[
		"Claude (claude.ai and the desktop app)",
		"Settings → Connectors → Add custom connector, then paste the address.",
	],
	[
		"ChatGPT",
		"Settings → Apps and connectors → Advanced settings: turn on developer mode, then Create and paste the address.",
	],
	["Claude Code", "Run: claude mcp add --transport http tools ADDRESS"],
];

/** "A and B", "A, B and C". */
function listOf(items: string[]): string {
	return items.length < 2
		? (items[0] ?? "")
		: `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * The "Connect your AI app" dialog: the address with Copy and New address,
 * short instructions, the pairing code (with Copy) while the relay sends one,
 * and the connected apps with Disconnect. Pairing is on while it is open, so
 * closing it ends the code; the connection and the address stay. Until an app
 * connects, only a small Close (and Escape) close it; then a Done. New address
 * asks first when it would disconnect connected apps (`newAddress()` revokes
 * them).
 */
export function showConnectDialog(
	mcp: TabMcp,
	connecting: Promise<SessionInfo>,
	doc: Document,
): Promise<void> {
	const { dialog } = newDialog(doc, "tab-mcp-connect", "Connect your AI app");
	// Focusable from script only, for the moment before the address is shown.
	dialog.tabIndex = -1;
	dialog.style.setProperty("outline", "none");
	const status = el(doc, "p", {
		className: "tab-mcp-status",
		text: "Connecting…",
	});
	status.setAttribute("role", "status");

	const addressId = `tab-mcp-${++counter}-address`;
	const label = el(doc, "label", { text: "Add this address to your AI app:" });
	label.htmlFor = addressId;
	const address = el(doc, "input", {
		id: addressId,
		className: "tab-mcp-address-input",
	});
	address.readOnly = true;
	address.style.setProperty("width", "100%");
	address.style.setProperty("font-family", "var(--tab-mcp-mono, monospace)");
	const { button: copy, reset: resetCopy } = copyButton(
		doc,
		"address",
		() => address.value,
		() => address.select(),
	);
	copy.className = "tab-mcp-address-copy";
	const fresh = button(doc, "New address", () => askNewAddress());
	fresh.className = "tab-mcp-new-address";
	const addressBox = el(
		doc,
		"div",
		{ className: "tab-mcp-address" },
		label,
		address,
		" ",
		copy,
		" ",
		fresh,
	);

	// Asked in the dialog before New address disconnects connected apps.
	const confirmId = `tab-mcp-${++counter}-new-address`;
	const confirmText = el(doc, "p", { id: confirmId });
	const cancelNew = button(doc, "Cancel", () => {
		confirmBox.hidden = true;
		fresh.focus();
	});
	const confirmNew = button(doc, "Disconnect and get new address", () =>
		getNewAddress(),
	);
	confirmNew.className = "tab-mcp-new-address-confirm";
	const confirmBox = el(
		doc,
		"div",
		{ className: "tab-mcp-new-address-question" },
		confirmText,
		el(
			doc,
			"div",
			{ className: "tab-mcp-actions" },
			cancelNew,
			" ",
			confirmNew,
		),
	);
	confirmBox.setAttribute("role", "group");
	confirmBox.setAttribute("aria-labelledby", confirmId);
	confirmBox.hidden = true;

	const code = el(doc, "strong", { className: "tab-mcp-code-value" });
	code.style.setProperty("font-size", "var(--tab-mcp-code-size, 1.5em)");
	code.style.setProperty("letter-spacing", "0.1em");
	code.style.setProperty("font-family", "var(--tab-mcp-mono, monospace)");
	// One click selects the whole code; it stays plain, selectable text.
	code.style.setProperty("user-select", "all");
	code.style.setProperty("-webkit-user-select", "all");
	// Reads the code shown at click time, so a rotated code is copied as shown.
	const { button: copyCode, reset: resetCopyCode } = copyButton(
		doc,
		"code",
		() => code.textContent ?? "",
		() => doc.getSelection()?.selectAllChildren(code),
	);
	copyCode.className = "tab-mcp-code-copy";
	// Only the sentence with the code is announced when the code changes,
	// not its Copy button's "Copied".
	const codeSentence = el(doc, "span", {}, "When asked, enter the code ", code);
	codeSentence.setAttribute("aria-live", "polite");
	const codeLine = el(
		doc,
		"p",
		{ className: "tab-mcp-code" },
		codeSentence,
		" ",
		copyCode,
		el(doc, "br"),
		el(doc, "small", {
			className: "tab-mcp-code-note",
			text: "A new code appears every 2 minutes and after each use.",
		}),
	);

	const steps = el(doc, "ul");
	const help = el(
		doc,
		"details",
		{ className: "tab-mcp-help" },
		el(doc, "summary", { text: "How do I add it?" }),
		steps,
	);

	const appList = el(doc, "ul");
	const apps = el(
		doc,
		"div",
		{ className: "tab-mcp-apps" },
		el(doc, "h3", { text: "Connected" }),
		appList,
	);

	// Until an app connects in this dialog, closing it is not the next step:
	// a small Close at the end, saying what closing does (the code stops, the
	// address stays). Once one connects, a prominent Done replaces both.
	const closeNote = el(doc, "small", {
		className: "tab-mcp-close-note",
		text: "Closing this stops the code. The address stays the same: to connect later, open this again from the page.",
	});
	const close = button(doc, "Close", () => dialog.close());
	close.className = "tab-mcp-close";
	close.style.setProperty("font-size", "0.875em");
	const done = button(doc, "Done", () => dialog.close());
	done.className = "tab-mcp-done";
	done.style.setProperty("font-weight", "bold");
	done.hidden = true;
	const actions = el(
		doc,
		"div",
		{ className: "tab-mcp-actions" },
		closeNote,
		" ",
		close,
		done,
	);
	// The note on the left, the button at the far right, apart from the code.
	actions.style.setProperty("display", "flex");
	actions.style.setProperty("align-items", "center");
	actions.style.setProperty("justify-content", "flex-end");
	actions.style.setProperty("gap", "0.75rem");
	actions.style.setProperty("margin-top", "1rem");
	closeNote.style.setProperty("flex", "1");
	// An app connected while this dialog is open (since the last new address),
	// and still connected: the grants that made it so.
	let paired = false;
	const pairedGrants = new Set<string>();
	// The note is about the code: only while one is shown and nothing paired.
	const renderCloseNote = () => {
		closeNote.hidden = paired || codeLine.hidden;
	};
	const setPaired = (value: boolean) => {
		paired = value;
		if (!paired) pairedGrants.clear();
		const focused = doc.activeElement;
		renderCloseNote();
		close.hidden = paired;
		done.hidden = !paired;
		// Focus never stays on a control that was just hidden.
		if (paired && focused === close) done.focus();
		if (!paired && focused === done) close.focus();
	};
	// The visible button that closes the dialog.
	const closer = () => (paired ? done : close);

	dialog.append(status, addressBox, confirmBox, codeLine, help, apps, actions);
	addressBox.hidden = true;
	codeLine.hidden = true;
	help.hidden = true;
	apps.hidden = true;

	// Set while New address waits for the new session.
	let renewing = false;
	// The question names the apps connected now; pairing goes on while it is open.
	const renderQuestion = (): boolean => {
		const names = mcp.grants.map((g) => clientLabel(g.client));
		if (names.length === 0) return false;
		confirmText.textContent = `A new address disconnects ${listOf(names)}. To use this page again, add the new address to ${names.length === 1 ? "it" : "them"}.`;
		return true;
	};
	const askNewAddress = () => {
		if (mcp.state !== "connected") return;
		if (!renderQuestion()) {
			getNewAddress();
			return;
		}
		confirmBox.hidden = false;
		cancelNew.focus(); // the safe choice is the default
	};
	const getNewAddress = () => {
		// The apps are disconnected: the next one has to pair again.
		setPaired(false);
		// Focus moves before the focused control is hidden.
		close.focus();
		confirmBox.hidden = true;
		renewing = true;
		status.textContent = "Getting a new address…";
		// Called from the click, so the reconnect has the user action it needs.
		mcp.newAddress().then(
			() => {
				renewing = false;
				status.textContent =
					"This is a new address. Add it to your AI app again.";
				copy.focus();
			},
			(error: unknown) => {
				renewing = false;
				status.textContent = `Could not connect: ${error instanceof Error ? error.message : String(error)}. Close this and connect again.`;
				closer().focus();
			},
		);
	};
	const renderSession = (session: SessionInfo | undefined) => {
		if (session === undefined) {
			addressBox.hidden = true;
			confirmBox.hidden = true;
			help.hidden = true;
			return;
		}
		address.value = session.address;
		resetCopy();
		const appName = session.appName ?? mcp.appName;
		if (!renewing)
			status.textContent =
				appName !== undefined
					? `${appName} is ready for your AI app.`
					: "This page is ready for your AI app.";
		fresh.disabled = mcp.state !== "connected";
		addressBox.hidden = false;
		// Opened before the session was known: start at the address's Copy.
		if (doc.activeElement === dialog) copy.focus();
		help.hidden = false;
		steps.replaceChildren(
			...INSTRUCTIONS.map(([app, how]) =>
				el(
					doc,
					"li",
					{},
					el(doc, "strong", { text: app }),
					`: ${how.replace("ADDRESS", session.address)}`,
				),
			),
		);
	};
	const renderCode = () => {
		const current = mcp.pairingCode;
		// A new code is not copied yet.
		if (code.textContent !== (current?.code ?? "")) resetCopyCode();
		code.textContent = current?.code ?? "";
		codeLine.hidden = current === undefined;
		renderCloseNote();
	};
	const appsNote = el(doc, "p", { className: "tab-mcp-apps-note" });
	apps.append(appsNote);
	// Grants that were there when the dialog opened; a new one is announced.
	const known = new Set(mcp.grants.map((g) => g.grantId));
	// Grants that come with a (new) session were there before; only the ones
	// added during a session are new connections.
	let session = mcp.session;
	const renderGrants = () => {
		if (mcp.session !== session) {
			session = mcp.session;
			for (const grant of mcp.grants) known.add(grant.grantId);
		}
		for (const grant of mcp.grants) {
			if (known.has(grant.grantId)) continue;
			known.add(grant.grantId);
			status.textContent = `${clientLabel(grant.client)} is connected.`;
			pairedGrants.add(grant.grantId);
			if (!paired) setPaired(true);
		}
		// The app that connected here is gone again (Disconnect, or revoked):
		// back to Close and the note, the code still runs.
		if (paired && !mcp.grants.some((g) => pairedGrants.has(g.grantId))) {
			setPaired(false);
		}
		const connected = mcp.state === "connected";
		appList.replaceChildren(
			...mcp.grants.map((grant) => {
				const disconnect = button(doc, "Disconnect", () => {
					if (!mcp.revoke(grant.grantId)) renderGrants();
				});
				// Only the relay can revoke, so only while connected.
				disconnect.disabled = !connected;
				return el(
					doc,
					"li",
					{},
					`${clientLabel(grant.client)} connected `,
					disconnect,
				);
			}),
		);
		appsNote.textContent = connected
			? ""
			: "To disconnect an app, connect this page again first.";
		appsNote.hidden = connected;
		apps.hidden = mcp.grants.length === 0;
		if (!confirmBox.hidden && !renderQuestion()) {
			// Nobody left to disconnect: no question needed.
			confirmBox.hidden = true;
			fresh.focus();
		}
	};
	const onDisconnected = (event: CustomEvent<DisconnectDetail>) => {
		if (event.detail.reason !== "new_address")
			status.textContent =
				"Disconnected. AI apps can use this page again after you connect.";
		renderSession(undefined);
		renderGrants();
		renderCode();
	};
	const onConnected = () => {
		renderSession(mcp.session);
		renderGrants();
	};

	mcp.addEventListener("pairingcode", renderCode);
	mcp.addEventListener("grantschange", renderGrants);
	mcp.addEventListener("connected", onConnected);
	mcp.addEventListener("disconnected", onDisconnected);
	doc.body.append(dialog);
	mcp.startPairing();
	renderGrants();
	renderCode();
	renderSession(mcp.session);
	connecting.then(
		(session) => renderSession(session),
		(error: unknown) => {
			status.textContent = `Could not connect: ${error instanceof Error ? error.message : String(error)}`;
		},
	);

	return new Promise((resolve) => {
		dialog.addEventListener(
			"close",
			() => {
				mcp.stopPairing();
				mcp.removeEventListener("pairingcode", renderCode);
				mcp.removeEventListener("grantschange", renderGrants);
				mcp.removeEventListener("connected", onConnected);
				mcp.removeEventListener("disconnected", onDisconnected);
				dialog.remove();
				resolve();
			},
			{ once: true },
		);
		dialog.showModal();
		// Start at the address's Copy; until the address is there, at the
		// dialog itself (its title is read out), not at Close.
		if (!addressBox.hidden) copy.focus();
		else dialog.focus();
	});
}
