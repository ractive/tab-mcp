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
 * short instructions, the pairing code while the relay sends one, and the
 * connected apps with Disconnect. Pairing is on while it is open. New address
 * asks first when it would disconnect connected apps (`newAddress()` revokes
 * them).
 */
export function showConnectDialog(
	mcp: TabMcp,
	connecting: Promise<SessionInfo>,
	doc: Document,
): Promise<void> {
	const { dialog } = newDialog(doc, "tab-mcp-connect", "Connect your AI app");
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
	const copy = button(doc, "Copy", () => {
		const done = () => {
			copy.textContent = "Copied";
		};
		const clipboard = (doc.defaultView?.navigator as Navigator | undefined)
			?.clipboard;
		if (clipboard !== undefined)
			clipboard.writeText(address.value).then(done, () => address.select());
		else address.select();
	});
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
	const codeLine = el(
		doc,
		"p",
		{ className: "tab-mcp-code" },
		"When asked, enter the code ",
		code,
		el(doc, "br"),
		el(doc, "small", {
			className: "tab-mcp-code-note",
			text: "A new code appears every 2 minutes and after each use.",
		}),
	);
	codeLine.setAttribute("aria-live", "polite");
	// Identity binding: no code, the same account at the AI app's sign-in.
	const signInLine = el(doc, "p", {
		className: "tab-mcp-sign-in",
		text: "When your AI app asks, sign in with the account you use on this page. No code is needed.",
	});

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

	const close = button(doc, "Close", () => dialog.close());
	const actions = el(doc, "div", { className: "tab-mcp-actions" }, close);

	dialog.append(
		status,
		addressBox,
		confirmBox,
		codeLine,
		signInLine,
		help,
		apps,
		actions,
	);
	addressBox.hidden = true;
	codeLine.hidden = true;
	signInLine.hidden = true;
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
				close.focus();
			},
			(error: unknown) => {
				renewing = false;
				status.textContent = `Could not connect: ${error instanceof Error ? error.message : String(error)}. Close this and connect again.`;
				close.focus();
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
		copy.textContent = "Copy";
		const appName = session.appName ?? mcp.appName;
		if (!renewing)
			status.textContent =
				appName !== undefined
					? `${appName} is ready for your AI app.`
					: "This page is ready for your AI app.";
		fresh.disabled = mcp.state !== "connected";
		addressBox.hidden = false;
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
		const oidc = mcp.session?.pairing === "oidc";
		code.textContent = current?.code ?? "";
		codeLine.hidden = oidc || current === undefined;
		signInLine.hidden = !oidc;
	};
	const appsNote = el(doc, "p", { className: "tab-mcp-apps-note" });
	apps.append(appsNote);
	// Grants that were there when the dialog opened; a new one is announced.
	const known = new Set(mcp.grants.map((g) => g.grantId));
	const renderGrants = () => {
		for (const grant of mcp.grants) {
			if (known.has(grant.grantId)) continue;
			known.add(grant.grantId);
			status.textContent = `${clientLabel(grant.client)} is connected.`;
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
		renderCode();
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
		close.focus();
	});
}
