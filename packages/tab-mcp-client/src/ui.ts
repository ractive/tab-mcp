/**
 * The default UI, loaded on demand: the "Connect your AI app" dialog
 * (DEC-028) and the confirmation of consequential tools. Plain `<dialog>`
 * elements, all text set with `textContent`, styled by one constructed
 * stylesheet (`DIALOG_CSS`) that pages adjust through `--tab-mcp-*` custom
 * properties or their own CSS. Pages with their own UI use the events and
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

/**
 * A button. `className` is its own class; `kind` marks the one next step
 * (`tab-mcp-primary`) or one that disconnects (`tab-mcp-danger`); without
 * one it is a plain, outlined button.
 */
function button(
	doc: Document,
	text: string,
	onClick: () => void,
	className?: string,
	kind?: "primary" | "danger",
): HTMLButtonElement {
	const node = el(doc, "button", { text });
	node.type = "button";
	if (className !== undefined) node.classList.add(className);
	if (kind !== undefined) node.classList.add(`tab-mcp-${kind}`);
	node.addEventListener("click", onClick);
	return node;
}

/**
 * The look of both dialogs. Every selector has the specificity of one class
 * (the rest is in `:where()`), so rules of the page for elements, such as
 * `button { … }` or a reset's `* { border-width: 0 }`, do not change the
 * dialogs. The rules for states (hover, focus, disabled) and the primary
 * and danger buttons add two elements (`html dialog.…`, `html button.…`),
 * so `button:hover`, `button:focus` or `button:disabled` of the page do not
 * either. A rule with two classes, such as `.tab-mcp-dialog .tab-mcp-primary`,
 * wins over all of them. The `--tab-mcp-*`
 * custom properties (on `:root` or on `.tab-mcp-dialog`) change single
 * values; the library only reads them. The defaults use system colours and the
 * page's `color-scheme`, so the dialogs follow its light or dark scheme. The
 * `--_tab-mcp-*` properties are internal. Order matters among equals.
 */
export const DIALOG_CSS = `.tab-mcp-dialog {
--_tab-mcp-fg: var(--tab-mcp-color, CanvasText);
--_tab-mcp-bg: var(--tab-mcp-background, Canvas);
--_tab-mcp-muted: var(--tab-mcp-muted, color-mix(in srgb, var(--_tab-mcp-fg) 72%, transparent));
--_tab-mcp-line: color-mix(in srgb, var(--_tab-mcp-fg) 22%, transparent);
--_tab-mcp-surface: var(--tab-mcp-surface, color-mix(in srgb, var(--_tab-mcp-fg) 6%, transparent));
--_tab-mcp-danger: var(--tab-mcp-danger, light-dark(#b3261e, #ffb4ab));
--_tab-mcp-mono: var(--tab-mcp-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
--_tab-mcp-small-radius: calc(var(--tab-mcp-radius, 0.75rem) * 0.6);
box-sizing: border-box; width: calc(100% - 2rem); max-width: var(--tab-mcp-max-width, 34rem); max-height: calc(100% - 2rem); overflow: auto;
font: var(--tab-mcp-font, inherit); line-height: 1.5; color: var(--_tab-mcp-fg); background: var(--_tab-mcp-bg);
border: var(--tab-mcp-border, 1px solid var(--_tab-mcp-line)); border-radius: var(--tab-mcp-radius, 0.75rem);
padding: var(--tab-mcp-padding, clamp(1rem, 5vw, 1.5rem)); box-shadow: var(--tab-mcp-shadow, 0 1rem 3rem rgb(0 0 0 / 0.3));
}
.tab-mcp-dialog::backdrop { background: var(--tab-mcp-backdrop, rgb(0 0 0 / 0.4)); }
.tab-mcp-dialog:where([open]) { display: flex; flex-direction: column; gap: 1rem; }
.tab-mcp-dialog:where([open]) > * { flex-shrink: 0; }
.tab-mcp-dialog :where([hidden]) { display: none !important; }
html dialog.tab-mcp-dialog:where(:focus) { outline: none; }
.tab-mcp-dialog :where(*) { box-sizing: border-box; }
.tab-mcp-dialog :where(h2, h3, p, ul, li, pre) { margin: 0; }
.tab-mcp-dialog :where(h2) { font-size: var(--tab-mcp-title-size, 1.25em); line-height: 1.3; font-weight: 600; overflow-wrap: anywhere; }
.tab-mcp-dialog :where(h3) { font-size: 0.875em; font-weight: 600; color: var(--_tab-mcp-muted); margin-bottom: 0.5rem; }
.tab-mcp-dialog :where(small) { font-size: 0.875em; }
.tab-mcp-dialog :where(small, .tab-mcp-status, .tab-mcp-description, .tab-mcp-always-note, .tab-mcp-apps-note) { color: var(--_tab-mcp-muted); }
html dialog.tab-mcp-dialog :where(:focus-visible) { outline: 2px solid var(--tab-mcp-focus, var(--_tab-mcp-fg)); outline-offset: 2px; }
.tab-mcp-dialog :where(button) { font: inherit; font-size: 0.9375em; line-height: 1.25; min-height: 2.5rem; padding: 0.5rem 1rem; margin: 0; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); border-radius: var(--_tab-mcp-small-radius); background: transparent; color: inherit; cursor: pointer; }
html dialog.tab-mcp-dialog :where(button:hover:not(:disabled)) { color: inherit; background: color-mix(in srgb, currentColor 8%, transparent); }
html dialog.tab-mcp-dialog :where(button:disabled) { opacity: 0.45; cursor: not-allowed; }
html button.tab-mcp-primary { background: var(--tab-mcp-accent, var(--_tab-mcp-fg)); color: var(--tab-mcp-accent-text, var(--_tab-mcp-bg)); border-color: transparent; font-weight: 600; }
html button.tab-mcp-primary:where(:hover:not(:disabled)) { background: var(--tab-mcp-accent, var(--_tab-mcp-fg)); opacity: 0.85; }
html button.tab-mcp-danger { color: var(--_tab-mcp-danger); border-color: color-mix(in srgb, currentColor 45%, transparent); }
.tab-mcp-copy { min-width: 6em; }
.tab-mcp-close { font-size: 0.875em; }
.tab-mcp-status { margin-top: -0.5rem; }
.tab-mcp-description:where(:empty) { display: none; }
.tab-mcp-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 0.5rem; }
.tab-mcp-address { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.tab-mcp-address :where(label) { flex-basis: 100%; font-weight: 600; }
.tab-mcp-address :where(input) { flex: 1 1 12rem; min-width: 0; min-height: 2.5rem; margin: 0; padding: 0.5rem 0.625rem; font: 0.875em var(--_tab-mcp-mono); text-overflow: ellipsis; color: inherit; background: var(--_tab-mcp-surface); border: 1px solid var(--_tab-mcp-line); border-radius: var(--_tab-mcp-small-radius); }
.tab-mcp-code { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 0.25rem 1rem; padding: 1rem; background: var(--_tab-mcp-surface); border-radius: var(--_tab-mcp-small-radius); }
.tab-mcp-code > :where(span) { font-weight: 600; }
.tab-mcp-code :where(br) { display: none; }
.tab-mcp-code :where(small) { grid-column: 1 / -1; }
.tab-mcp-code-value { display: block; font: 700 var(--tab-mcp-code-size, 2em) / 1.2 var(--_tab-mcp-mono); letter-spacing: 0.12em; font-variant-numeric: tabular-nums; }
.tab-mcp-help :where(summary) { width: fit-content; cursor: pointer; }
.tab-mcp-dialog :where(.tab-mcp-help ul, .tab-mcp-apps ul) { list-style: none; padding: 0; display: grid; gap: 0.5rem; }
.tab-mcp-help :where(ul) { margin-top: 0.75rem; gap: 0.75rem; }
.tab-mcp-help :where(li) { overflow-wrap: anywhere; }
.tab-mcp-help :where(strong) { display: block; font-weight: 600; }
.tab-mcp-command { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: flex-start; gap: 0.5rem; margin-top: 0.375rem; }
.tab-mcp-command > :where(pre) { flex: 1 1 16rem; min-width: 0; margin: 0; padding: 0.5rem 0.625rem; font: 0.8125em / 1.5 var(--_tab-mcp-mono); white-space: pre-wrap; word-break: break-all; background: var(--_tab-mcp-surface); border: 1px solid var(--_tab-mcp-line); border-radius: var(--_tab-mcp-small-radius); }
.tab-mcp-command-note { display: block; margin-top: 0.375rem; }
.tab-mcp-help :where(code) { font: 0.875em var(--_tab-mcp-mono); padding: 0.125em 0.375em; background: var(--_tab-mcp-surface); border-radius: 0.25rem; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.tab-mcp-apps :where(li) { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.5rem 0.5rem 0.5rem 0.75rem; border: 1px solid var(--_tab-mcp-line); border-radius: var(--_tab-mcp-small-radius); }
.tab-mcp-app { min-width: 0; overflow-wrap: anywhere; }
.tab-mcp-apps-note { margin-top: 0.5rem; }
.tab-mcp-new-address-question { display: grid; gap: 0.75rem; padding: 1rem; border: 1px solid color-mix(in srgb, var(--_tab-mcp-danger) 50%, transparent); border-radius: var(--_tab-mcp-small-radius); }
.tab-mcp-connect > :where(.tab-mcp-actions) { gap: 0.75rem; padding-top: 1rem; border-top: 1px solid var(--_tab-mcp-line); }
.tab-mcp-close-note { flex: 1 1 12rem; }
.tab-mcp-confirm :where(p bdi) { font-weight: 600; }
.tab-mcp-arguments { box-sizing: content-box; font: 0.875em / 1.45 var(--_tab-mcp-mono); padding: 0.75rem; background: var(--_tab-mcp-surface); border: 1px solid var(--_tab-mcp-line); border-radius: var(--_tab-mcp-small-radius); }
.tab-mcp-always-note { font-size: 0.875em; }
@media (max-width: 30rem) { .tab-mcp-actions > :where(button) { flex: 1 1 auto; } .tab-mcp-connect > :where(.tab-mcp-actions) > :where(button) { flex: 0 0 auto; } }
@media (prefers-reduced-motion: no-preference) { .tab-mcp-dialog:where([open]) { animation: tab-mcp-in 0.15s ease-out; } }
@media (forced-colors: active) { html button.tab-mcp-primary { border-color: ButtonText; } }
@keyframes tab-mcp-in { from { opacity: 0; transform: translateY(0.5rem); } }
`;

const sheets = new WeakMap<Document, CSSStyleSheet>();

/**
 * Adopts `DIALOG_CSS` into the document once, next to the page's own adopted
 * sheets. A constructed stylesheet needs no `style-src` exception under a
 * strict CSP. Where constructed stylesheets are not supported, the dialogs
 * keep the browser's default look and work the same.
 */
function adoptStyles(doc: Document): void {
	try {
		let sheet = sheets.get(doc);
		if (sheet === undefined) {
			const Sheet = (doc.defaultView as (Window & typeof globalThis) | null)
				?.CSSStyleSheet;
			if (Sheet === undefined || !Array.isArray(doc.adoptedStyleSheets)) return;
			sheet = new Sheet();
			sheet.replaceSync(DIALOG_CSS);
			sheets.set(doc, sheet);
		}
		// The page may have replaced the list since.
		if (!doc.adoptedStyleSheets.includes(sheet))
			doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
	} catch {
		// Not supported: the default look.
	}
}

/**
 * A Copy button for `value()`, read at click time. Shows "Copied" once the
 * clipboard took it; without a clipboard (or when it refuses) `select()` puts
 * the text in the selection for Ctrl+C instead. `noun` names it for assistive
 * technology ("Copy code"), as the dialog has more than one Copy; `announce`
 * says what happened ("Code copied", or that the text is selected).
 */
function copyButton(
	doc: Document,
	noun: string,
	value: () => string,
	select: () => void,
	announce: (text: string) => void,
	className: string,
	kind?: "primary",
): { button: HTMLButtonElement; reset: () => void } {
	const node = button(
		doc,
		"Copy",
		() => {
			const done = () => {
				node.textContent = "Copied";
				node.setAttribute("aria-label", `Copied ${noun}`);
				announce(`${noun[0]?.toUpperCase()}${noun.slice(1)} copied`);
			};
			const selected = () => {
				select();
				announce("Selected: press Ctrl+C to copy");
			};
			const clipboard = (doc.defaultView?.navigator as Navigator | undefined)
				?.clipboard;
			if (clipboard !== undefined)
				clipboard.writeText(value()).then(done, selected);
			else selected();
		},
		className,
		kind,
	);
	// The same width for "Copy" and "Copied": nothing moves.
	node.classList.add("tab-mcp-copy");
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
	adoptStyles(doc);
	const heading = el(doc, "h2", { id: `${id}-title`, text: title });
	dialog.append(heading);
	return { dialog, heading };
}

/**
 * Characters that are invisible or change the direction of the text around
 * them: format characters (bidi controls and isolates, zero-width ones, tags),
 * the other default-ignorable ones (fillers, variation selectors), private-use
 * and unassigned code points, C1 controls, and line and paragraph separators.
 */
const INVISIBLE =
	/[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cn}\u0080-\u009F\u2028\u2029]/gu;

/** Each such character as `\uXXXX` (a pair for one beyond U+FFFF), as JSON would write it. */
function visible(text: string): string {
	return text.replace(INVISIBLE, (ch) => {
		let escaped = "";
		for (let i = 0; i < ch.length; i++)
			escaped += `\\u${ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
		return escaped;
	});
}

function clientLabel(client: ToolCallClient | Grant["client"]): string {
	const host = visible(client.host || client.id);
	return client.name !== undefined && client.name !== ""
		? `${visible(client.name)} (${host})`
		: host;
}

/** A name in a sentence, isolated so that it cannot reorder the words around it. */
function name(doc: Document, text: string): HTMLElement {
	const node = el(doc, "bdi", { text });
	node.dir = "ltr";
	return node;
}

/**
 * The arguments as text, in full: what the user approves must be visible.
 * (The relay caps a request at 1 MiB, so this stays bounded.) Invisible and
 * direction characters are shown as escapes, so the text is still JSON for
 * the same arguments; the tool gets them unchanged. `undefined` when they
 * cannot be shown, and then "Allow" is not offered.
 */
function showArguments(args: Record<string, unknown>): string | undefined {
	try {
		return visible(JSON.stringify(args, null, 2));
	} catch {
		return undefined;
	}
}

/** How long "Allow" stays disabled after the confirmation opens, and the floor. */
export const ALLOW_DELAY_MS = 750;
export const MIN_ALLOW_DELAY_MS = 500;

/** The user's answer: "always" allows this tool for this AI app from now on. */
export type ConfirmAnswer = "allow" | "always" | "deny";

/** `allowDelayMs` as a usable delay: the default unless a number of ms, never below the floor. */
function allowDelay(ms: number | undefined): number {
	const value =
		typeof ms === "number" && Number.isFinite(ms) && ms < 2 ** 31
			? ms
			: ALLOW_DELAY_MS;
	return Math.max(MIN_ALLOW_DELAY_MS, value);
}

/**
 * Ask whether a consequential tool may run. "Allow" and "Always allow" stay
 * disabled until the page has been visible and focused for `allowDelayMs`
 * (default 750, at least 500) while the dialog is open, so a click meant for
 * the page, or the click that brings the tab or window back, cannot approve.
 * Leaving the page disables them again. Everything else (Don't allow,
 * Escape, an aborted call) is "deny".
 */
export function confirmDialog(
	request: ConfirmRequest,
	doc: Document,
	options: { allowDelayMs?: number } = {},
): Promise<ConfirmAnswer> {
	const delay = allowDelay(options.allowDelayMs);
	if (request.signal.aborted) return Promise.resolve("deny");
	const title = request.tool.title ?? request.tool.name;
	const { dialog, heading } = newDialog(doc, "tab-mcp-confirm", "");
	heading.append("Allow ", name(doc, title), "?");
	const client = clientLabel(request.client);
	// The safe choice is the default: focused, and the one that stands out.
	const deny = button(
		doc,
		"Don't allow",
		() => dialog.close("deny"),
		"tab-mcp-deny",
		"primary",
	);
	const allow = button(
		doc,
		"Allow",
		() => {
			if (!allow.disabled) dialog.close("allow");
		},
		"tab-mcp-allow",
	);
	const always = button(
		doc,
		"Always allow",
		() => {
			if (!always.disabled) dialog.close("always");
		},
		"tab-mcp-always",
	);
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
	const alwaysNote = el(
		doc,
		"p",
		{ className: "tab-mcp-always-note" },
		"Always allow: ",
		name(doc, title),
		" runs without asking for ",
		name(doc, client),
		" until you reload this page or disconnect it.",
	);
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
	args.dir = "ltr";
	// Inline, so the arguments stay readable in full without the stylesheet:
	// wrapped (also a long word, at 360 px), scrolling when long.
	args.style.setProperty("white-space", "pre-wrap");
	args.style.setProperty("overflow-wrap", "anywhere");
	args.style.setProperty(
		"max-height",
		"var(--tab-mcp-arguments-height, 12rem)",
	);
	args.style.setProperty("overflow", "auto");
	args.hidden = Object.keys(request.arguments).length === 0;
	dialog.append(
		el(
			doc,
			"p",
			{},
			name(doc, client),
			" wants to run ",
			name(doc, title),
			".",
		),
		el(doc, "p", {
			className: "tab-mcp-description",
			text: request.tool.description,
		}),
		args,
		actions,
		alwaysNote,
	);
	doc.body.append(dialog);
	const view = doc.defaultView;
	return new Promise((resolve) => {
		const onAbort = () => dialog.close("deny");
		request.signal.addEventListener("abort", onAbort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		// The delay counts only while the user can see the page: tools are
		// called while the user is in the AI app, so the dialog often opens in
		// a background tab or window. Any change starts it again from zero (DEC-087).
		const arm = (event?: Event) => {
			clearTimeout(timer);
			timer = undefined;
			allow.disabled = true;
			always.disabled = true;
			if (
				event?.type === "blur" ||
				doc.visibilityState === "hidden" ||
				!doc.hasFocus()
			)
				return;
			timer = setTimeout(() => {
				allow.disabled = false;
				always.disabled = false;
			}, delay);
		};
		doc.addEventListener("visibilitychange", arm);
		view?.addEventListener("focus", arm);
		view?.addEventListener("blur", arm);
		dialog.addEventListener(
			"close",
			() => {
				clearTimeout(timer);
				doc.removeEventListener("visibilitychange", arm);
				view?.removeEventListener("focus", arm);
				view?.removeEventListener("blur", arm);
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
		arm();
	});
}

/**
 * The server's name as a label that every shell (POSIX shells, PowerShell,
 * cmd.exe) reads as one plain word, so it needs no quoting: letters without
 * their marks ("Bücher" → "bucher"), lower case, each run of anything but
 * a-z, 0-9, _ and - as one "-", no "-" at either end (no option), at most 40
 * characters; "tools" when nothing is left. The page names its server, but
 * the command runs in the user's shell: nothing of the name may be quoted
 * text (review of PR 34).
 */
export function commandName(name: string): string {
	const label = name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return label === "" ? "tools" : label;
}

/**
 * The address for a command, only when all of it is plain in every shell
 * (http or https, letters, digits and . : [ ] / _ ~ -); else `undefined`, and
 * the help shows the steps without commands. The relay's addresses are.
 */
export function commandAddress(address: string): string | undefined {
	try {
		const href = new URL(address).href;
		return /^https?:\/\/[A-Za-z0-9.:[\]/_~-]+$/.test(href) ? href : undefined;
	} catch {
		return undefined;
	}
}

/** Codex's feature for MCP 2026-07-28, which the relay speaks; off by default in Codex 0.163. */
const CODEX_FEATURE = "mcp_2026_07_28";

/**
 * Per AI app: its name, what to do, a command to run (one per line), and a
 * note after it, alternating text and code. `name` is the page's server name.
 */
export function instructions(
	name: string,
	address: string,
): [string, string, (string | undefined)?, string[]?][] {
	const n = commandName(name);
	const a = commandAddress(address);
	return [
		[
			"Claude (claude.ai and the desktop app)",
			"Settings → Connectors → Add custom connector, then paste the address.",
		],
		[
			"ChatGPT",
			"Settings → Apps and connectors → Advanced settings: turn on developer mode, then Create and paste the address.",
		],
		a === undefined
			? ["Claude Code", "Add the address with claude mcp add --transport http."]
			: ["Claude Code", "Run:", `claude mcp add --transport http ${n} ${a}`],
		[
			"Codex",
			...((a === undefined
				? [
						`Run codex features enable ${CODEX_FEATURE}, then add the address with codex mcp add --url.`,
						undefined,
					]
				: [
						"Run:",
						`codex features enable ${CODEX_FEATURE}\ncodex mcp add ${n} --url ${a}`,
					]) as [string, string | undefined]),
			[
				"Start a new chat in Codex after it connects. The first line turns on a feature for all of Codex's MCP servers; ",
				`codex features disable ${CODEX_FEATURE}`,
				" turns it off.",
			],
		],
	];
}

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
	serverName = "tools",
): Promise<void> {
	const { dialog } = newDialog(doc, "tab-mcp-connect", "Connect your AI app");
	// Focusable from script only, for the moment before the address is shown.
	dialog.tabIndex = -1;
	const status = el(doc, "p", {
		className: "tab-mcp-status",
		text: "Connecting…",
	});
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
	])
		live.style.setProperty(property as string, value as string);
	const announce = (text: string) => {
		live.textContent = live.textContent === text ? `${text}\u00a0` : text;
	};

	const addressId = `tab-mcp-${++counter}-address`;
	const label = el(doc, "label", { text: "Add this address to your AI app:" });
	label.htmlFor = addressId;
	const address = el(doc, "input", {
		id: addressId,
		className: "tab-mcp-address-input",
	});
	address.readOnly = true;
	// Copying the address is the first step: the primary button.
	const { button: copy, reset: resetCopy } = copyButton(
		doc,
		"address",
		() => address.value,
		() => address.select(),
		announce,
		"tab-mcp-address-copy",
		"primary",
	);
	const fresh = button(
		doc,
		"New address",
		() => askNewAddress(),
		"tab-mcp-new-address",
	);
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
	const confirmNew = button(
		doc,
		"Disconnect and get new address",
		() => getNewAddress(),
		"tab-mcp-new-address-confirm",
		"danger",
	);
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

	// Large, in a monospace font: a new code takes the same room.
	const code = el(doc, "strong", { className: "tab-mcp-code-value" });
	// One click selects the whole code; it stays plain, selectable text.
	code.style.setProperty("user-select", "all");
	code.style.setProperty("-webkit-user-select", "all");
	// Reads the code shown at click time, so a rotated code is copied as shown.
	const { button: copyCode, reset: resetCopyCode } = copyButton(
		doc,
		"code",
		() => code.textContent ?? "",
		() => doc.getSelection()?.selectAllChildren(code),
		announce,
		"tab-mcp-code-copy",
	);
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

	// Until an app connects in this dialog, closing it is not the next step:
	// a small Close at the end, saying what closing does (the code stops, the
	// address stays). Once one connects, a prominent Done replaces both.
	const closeNote = el(doc, "small", {
		className: "tab-mcp-close-note",
		text: "Closing this stops the code. The address stays the same: to connect later, open this again from the page.",
	});
	const close = button(doc, "Close", () => dialog.close(), "tab-mcp-close");
	const done = button(
		doc,
		"Done",
		() => dialog.close(),
		"tab-mcp-done",
		"primary",
	);
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

	dialog.append(
		status,
		addressBox,
		confirmBox,
		codeLine,
		signInLine,
		help,
		apps,
		actions,
		live,
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
			...instructions(serverName, session.address).map(
				([app, how, command, note]) => {
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
							`${app} command`,
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
								...note.map((part, i) =>
									i % 2 === 1 ? el(doc, "code", { text: part }) : part,
								),
							),
						);
					return item;
				},
			),
		);
	};
	const renderCode = () => {
		const current = mcp.pairingCode;
		const oidc = mcp.session?.pairing === "oidc";
		// A new code is not copied yet.
		if (code.textContent !== (current?.code ?? "")) resetCopyCode();
		code.textContent = current?.code ?? "";
		codeLine.hidden = oidc || current === undefined;
		signInLine.hidden = !oidc;
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
				const disconnect = button(
					doc,
					"Disconnect",
					() => {
						if (!mcp.revoke(grant.grantId)) renderGrants();
					},
					"tab-mcp-disconnect",
					"danger",
				);
				// Only the relay can revoke, so only while connected.
				disconnect.disabled = !connected;
				return el(
					doc,
					"li",
					{},
					el(doc, "span", {
						className: "tab-mcp-app",
						text: `${clientLabel(grant.client)} connected `,
					}),
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
		// Start at the address's Copy; until the address is there, at the
		// dialog itself (its title is read out), not at Close.
		if (!addressBox.hidden) copy.focus();
		else dialog.focus();
	});
}
