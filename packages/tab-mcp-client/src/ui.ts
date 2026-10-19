/**
 * The default UI, loaded on demand: the "Connect your AI tool" dialog
 * (DEC-028) and the confirmation of consequential tools. Plain `<dialog>`
 * elements, no styles beyond a few CSS custom properties (`--tab-mcp-*`), all
 * text set with `textContent`. Pages with their own UI use the events and
 * methods of `TabMcp` instead.
 */

import type { TabMcp } from "./tab-mcp.ts";
import type {
	ConfirmRequest,
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

function summarize(args: Record<string, unknown>): string {
	let text: string;
	try {
		text = JSON.stringify(args, null, 2) ?? "";
	} catch {
		text = "(arguments that cannot be shown)";
	}
	return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

/** Ask whether a consequential tool may run. Resolves `true` only for "Allow". */
export function confirmDialog(
	request: ConfirmRequest,
	doc: Document,
): Promise<boolean> {
	if (request.signal.aborted) return Promise.resolve(false);
	const title = request.tool.title ?? request.tool.name;
	const { dialog } = newDialog(doc, "tab-mcp-confirm", `Allow ${title}?`);
	const deny = button(doc, "Don't allow", () => dialog.close("deny"));
	const allow = button(doc, "Allow", () => dialog.close("allow"));
	const actions = el(
		doc,
		"div",
		{ className: "tab-mcp-actions" },
		deny,
		" ",
		allow,
	);
	const args = el(doc, "pre", {
		className: "tab-mcp-arguments",
		text: summarize(request.arguments),
	});
	args.style.setProperty("white-space", "pre-wrap");
	args.style.setProperty("max-height", "12rem");
	args.style.setProperty("overflow", "auto");
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
	);
	doc.body.append(dialog);
	return new Promise((resolve) => {
		const onAbort = () => dialog.close("deny");
		request.signal.addEventListener("abort", onAbort, { once: true });
		dialog.addEventListener(
			"close",
			() => {
				request.signal.removeEventListener("abort", onAbort);
				const allowed = dialog.returnValue === "allow";
				dialog.remove();
				resolve(allowed);
			},
			{ once: true },
		);
		dialog.showModal();
		deny.focus(); // the safe choice is the default
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

/**
 * The "Connect your AI tool" dialog: the address with a copy button, short
 * instructions, the pairing code while the relay sends one, and the connected
 * apps with Disconnect. Pairing is on while it is open.
 */
export function showConnectDialog(
	mcp: TabMcp,
	connecting: Promise<SessionInfo>,
	doc: Document,
): Promise<void> {
	const { dialog } = newDialog(doc, "tab-mcp-connect", "Connect your AI tool");
	const status = el(doc, "p", {
		className: "tab-mcp-status",
		text: "Connecting…",
	});
	status.setAttribute("role", "status");

	const addressId = `tab-mcp-${++counter}-address`;
	const label = el(doc, "label", { text: "Add this address to your AI tool:" });
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
	const addressBox = el(
		doc,
		"div",
		{ className: "tab-mcp-address" },
		label,
		address,
		" ",
		copy,
	);

	const code = el(doc, "strong", { className: "tab-mcp-code-value" });
	code.style.setProperty("font-size", "var(--tab-mcp-code-size, 1.5em)");
	code.style.setProperty("letter-spacing", "0.1em");
	const codeLine = el(
		doc,
		"p",
		{ className: "tab-mcp-code" },
		"When asked, enter the code ",
		code,
	);
	codeLine.setAttribute("aria-live", "polite");

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

	dialog.append(status, addressBox, codeLine, help, apps, actions);
	addressBox.hidden = true;
	codeLine.hidden = true;
	help.hidden = true;
	apps.hidden = true;

	const renderSession = (session: SessionInfo | undefined) => {
		if (session === undefined) {
			addressBox.hidden = true;
			help.hidden = true;
			return;
		}
		address.value = session.address;
		status.textContent =
			session.appName !== undefined
				? `${session.appName} is ready for your AI tool.`
				: "This page is ready for your AI tool.";
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
		code.textContent = current?.code ?? "";
		codeLine.hidden = current === undefined;
	};
	const renderGrants = () => {
		appList.replaceChildren(
			...mcp.grants.map((grant) => {
				const disconnect = button(doc, "Disconnect", () =>
					mcp.revoke(grant.grantId),
				);
				return el(
					doc,
					"li",
					{},
					`${clientLabel(grant.client)} connected `,
					disconnect,
				);
			}),
		);
		apps.hidden = mcp.grants.length === 0;
	};
	const onDisconnected = () => {
		status.textContent =
			"Disconnected. AI tools can use this page again after you connect.";
		renderSession(undefined);
		renderCode();
	};
	const onConnected = () => renderSession(mcp.session);

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
