/**
 * What the library's dialogs share: the stylesheet, elements, buttons, the
 * texts (`strings.ts`) and how a caller is named. The confirmation
 * (`confirm.ts`) and the connect dialog (`connect.ts`) are chunks of their
 * own, loaded on demand; pages with their own UI use the events and methods
 * of `TabMcp` instead.
 */

import { type DialogStrings, STRINGS } from "./strings.ts";
import type { DialogOptions, Grant, ToolCallClient } from "./types.ts";
import { escapeInvisible } from "./visible.ts";

let counter = 0;

/** A new id for the elements of one dialog. */
export function nextId(): string {
	return `tab-mcp-${++counter}`;
}

/** The texts: the page's own where it gave them, else the English ones. */
export function stringsOf(options: DialogOptions | undefined): DialogStrings {
	return { ...STRINGS, ...options?.strings };
}

/** `template` with its `{name}` placeholders filled in, as text. */
export function format(
	template: string,
	values: Record<string, string>,
): string {
	return template.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);
}

/**
 * `template` with its `{name}` placeholders filled in, as nodes: a string
 * value is a name, isolated so that it cannot reorder the words around it
 * (and may stand twice); a node is put in as it is.
 */
export function fill(
	doc: Document,
	template: string,
	values: Record<string, string | Node>,
): (Node | string)[] {
	return template.split(/\{(\w+)\}/).map((part, i) => {
		if (i % 2 === 0) return part;
		const value = values[part];
		if (value === undefined) return `{${part}}`;
		return typeof value === "string" ? name(doc, value) : value;
	});
}

export function el<K extends keyof HTMLElementTagNameMap>(
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
export function button(
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

/** A name in a sentence, isolated so that it cannot reorder the words around it. */
export function name(doc: Document, text: string): HTMLElement {
	const node = el(doc, "bdi", { text });
	node.dir = "ltr";
	return node;
}

/** Invisible, blank and direction characters as `\uXXXX` (`visible.ts`). */
export const visible: (text: string) => string = escapeInvisible;

/**
 * How the dialogs name a caller: an AI app's name and verified host; for
 * the caller of a served port, the name the page gave it and what it is.
 */
export function clientLabel(
	client: ToolCallClient | Grant["client"],
	s: DialogStrings,
): string {
	if ("kind" in client && client.kind === "webmcp") return s.clientWebMcp;
	if ("kind" in client && client.kind === "local")
		return format(s.clientLocal, { name: visible(client.name ?? client.id) });
	const host = visible(client.host || client.id);
	return client.name !== undefined && client.name !== ""
		? format(s.clientRelay, { name: visible(client.name), host })
		: host;
}

/** "A and B", "A, B and C". */
export function listOf(items: string[], s: DialogStrings): string {
	return items.length < 2
		? (items[0] ?? "")
		: `${items.slice(0, -1).join(", ")} ${s.and} ${items.at(-1)}`;
}

/**
 * The look of the dialogs. Every selector has the specificity of one class
 * (the rest is in `:where()`), so rules of the page for elements, such as
 * `button { … }` or a reset's `* { border-width: 0 }`, do not change the
 * dialogs. The rules for states (hover, focus, disabled) and the primary
 * and danger buttons add two elements (`html dialog.…`, `html button.…`),
 * so `button:hover`, `button:focus` or `button:disabled` of the page do not
 * either. A page overrides with two classes, `.tab-mcp-dialog .tab-mcp-x`,
 * which wins over all of them; one class does not. The `--tab-mcp-*`
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
--_tab-mcp-success: var(--tab-mcp-success, light-dark(#1a7f37, #6fdd8b));
--_tab-mcp-mono: var(--tab-mcp-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
--_tab-mcp-small-radius: calc(var(--tab-mcp-radius, 0.75rem) * 0.6);
box-sizing: border-box; margin: auto; width: calc(100% - 2rem); max-width: var(--tab-mcp-max-width, 34rem); max-height: calc(100% - 2rem); overflow: auto;
font: var(--tab-mcp-font, inherit); line-height: 1.5; color: var(--_tab-mcp-fg); background: var(--_tab-mcp-bg);
border: var(--tab-mcp-border, 1px solid var(--_tab-mcp-line)); border-radius: var(--tab-mcp-radius, 0.75rem);
padding: var(--tab-mcp-padding, clamp(1rem, 5vw, 1.5rem)); box-shadow: var(--tab-mcp-shadow, 0 1rem 3rem rgb(0 0 0 / 0.3));
pointer-events: auto;
}
.tab-mcp-dialog::backdrop { background: var(--tab-mcp-backdrop, rgb(0 0 0 / 0.4)); }
.tab-mcp-dialog:where([open]) { display: flex; flex-direction: column; gap: 1rem; }
.tab-mcp-dialog:where([open]) > * { flex-shrink: 0; }
.tab-mcp-dialog :where([hidden]) { display: none !important; }
html dialog.tab-mcp-dialog:where(:focus) { outline: none; }
.tab-mcp-dialog :where(*) { box-sizing: border-box; color: inherit; }
.tab-mcp-dialog :where(h2, h3, p, ul, li, pre) { margin: 0; }
.tab-mcp-dialog :where(h2) { font-size: var(--tab-mcp-title-size, 1.25em); line-height: 1.3; font-weight: 600; overflow-wrap: anywhere; }
.tab-mcp-dialog :where(h3) { font-size: 0.875em; font-weight: 600; color: var(--_tab-mcp-muted); margin-bottom: 0.5rem; }
.tab-mcp-dialog :where(small) { font-size: 0.875em; }
.tab-mcp-dialog :where(small, .tab-mcp-status, .tab-mcp-description, .tab-mcp-always-note, .tab-mcp-apps-note, .tab-mcp-success-next, .tab-mcp-waiting, .tab-mcp-scroll-note, .tab-mcp-allowed) { color: var(--_tab-mcp-muted); }
html dialog.tab-mcp-dialog :where(:focus-visible) { outline: 2px solid var(--tab-mcp-focus, var(--_tab-mcp-fg)); outline-offset: 2px; }
.tab-mcp-dialog :where(button) { font: inherit; font-size: 0.9375em; line-height: 1.25; text-transform: none; letter-spacing: normal; width: auto; min-height: 2.5rem; padding: 0.5rem 1rem; margin: 0; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); border-radius: var(--_tab-mcp-small-radius); background: transparent; color: inherit; cursor: pointer; }
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
.tab-mcp-help { border: 1px solid var(--_tab-mcp-line); border-radius: var(--_tab-mcp-small-radius); }
.tab-mcp-help :where(summary) { padding: 0.75rem 1rem; font-weight: 600; cursor: pointer; }
.tab-mcp-help > :where(:not(summary)) { margin-inline: 1rem; }
.tab-mcp-help > :where(:last-child:not(summary)) { margin-bottom: 1rem; }
.tab-mcp-dialog :where(.tab-mcp-help ul, .tab-mcp-apps ul) { list-style: none; padding: 0; display: grid; gap: 0.5rem; }
.tab-mcp-help :where(ul) { margin-top: 0.25rem; margin-bottom: 0.75rem; gap: 0.75rem; }
.tab-mcp-help :where(li) { overflow-wrap: anywhere; }
.tab-mcp-help :where(strong) { display: block; font-weight: 600; }
.tab-mcp-command { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: flex-start; gap: 0.5rem; margin-top: 0.375rem; }
.tab-mcp-command > :where(pre) { flex: 1 1 16rem; min-width: 0; margin: 0; padding: 0.5rem 0.625rem; font: 0.8125em / 1.5 var(--_tab-mcp-mono); white-space: pre-wrap; word-break: break-all; background: var(--_tab-mcp-surface); border: 1px solid var(--_tab-mcp-line); border-radius: var(--_tab-mcp-small-radius); }
.tab-mcp-command-note { display: block; margin-top: 0.375rem; }
.tab-mcp-help :where(code) { font: 0.875em var(--_tab-mcp-mono); padding: 0.125em 0.375em; background: var(--_tab-mcp-surface); border-radius: 0.25rem; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.tab-mcp-apps :where(li) { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 0.75rem; padding: 0.5rem 0.5rem 0.5rem 0.75rem; border: 1px solid var(--_tab-mcp-line); border-radius: var(--_tab-mcp-small-radius); }
.tab-mcp-app { flex: 1 1 10rem; min-width: 0; overflow-wrap: anywhere; }
.tab-mcp-allowed { display: flex; flex-basis: 100%; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.875em; overflow-wrap: anywhere; }
.tab-mcp-apps-note { margin-top: 0.5rem; }
.tab-mcp-success { display: flex; align-items: center; gap: 0.875rem; padding: 1rem; background: color-mix(in srgb, var(--_tab-mcp-success) 10%, transparent); border: 1px solid color-mix(in srgb, var(--_tab-mcp-success) 45%, transparent); border-radius: var(--_tab-mcp-small-radius); }
.tab-mcp-success-icon { flex: none; display: grid; place-items: center; width: 2.75rem; height: 2.75rem; border-radius: 50%; font-size: 1.5em; font-weight: 700; line-height: 1; color: var(--_tab-mcp-success); background: color-mix(in srgb, var(--_tab-mcp-success) 16%, transparent); }
.tab-mcp-success-icon::before { content: "\\2713"; }
.tab-mcp-success-text { display: grid; gap: 0.125rem; min-width: 0; }
.tab-mcp-success-title { font-size: 1.125em; line-height: 1.3; font-weight: 600; overflow-wrap: anywhere; }
.tab-mcp-setup { display: flex; flex-direction: column; gap: 1rem; }
.tab-mcp-setup-toggle { display: flex; align-items: center; gap: 0.75rem; width: 100%; padding: 0.75rem 1rem; text-align: start; font-weight: 600; border-color: var(--_tab-mcp-line); }
.tab-mcp-setup-toggle::before { content: ""; flex: none; width: 0.45em; height: 0.45em; border: solid currentColor; border-width: 0 2px 2px 0; transform: translateX(-0.1em) rotate(-45deg); }
.tab-mcp-setup-toggle:where([aria-expanded="true"])::before { transform: translateY(-0.15em) rotate(45deg); }
.tab-mcp-code-used { display: flex; align-items: center; min-height: calc(var(--tab-mcp-code-size, 2em) * 1.2); }
.tab-mcp-new-address-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; }
.tab-mcp-new-address-row > :where(small) { flex: 1 1 14rem; color: var(--_tab-mcp-muted); }
.tab-mcp-new-address-question { display: grid; gap: 0.75rem; padding: 1rem; border: 1px solid color-mix(in srgb, var(--_tab-mcp-danger) 50%, transparent); border-radius: var(--_tab-mcp-small-radius); }
.tab-mcp-connect > :where(.tab-mcp-actions) { gap: 0.75rem; padding-top: 1rem; border-top: 1px solid var(--_tab-mcp-line); }
.tab-mcp-close-note { flex: 1 1 12rem; }
.tab-mcp-confirm :where(p bdi) { font-weight: 600; }
.tab-mcp-arguments { box-sizing: content-box; font: 0.875em / 1.45 var(--_tab-mcp-mono); padding: 0.75rem; background: var(--_tab-mcp-surface); border: 1px solid var(--_tab-mcp-line); border-radius: var(--_tab-mcp-small-radius); }
.tab-mcp-always-note, .tab-mcp-waiting, .tab-mcp-scroll-note { font-size: 0.875em; }
@media (max-width: 30rem) { .tab-mcp-actions > :where(button) { flex: 1 1 auto; } .tab-mcp-connect > :where(.tab-mcp-actions) > :where(button) { flex: 0 0 auto; } .tab-mcp-code { grid-template-columns: minmax(0, 1fr); } .tab-mcp-code > :where(button) { justify-self: start; } }
@media (prefers-reduced-motion: no-preference) { .tab-mcp-dialog:where([open]) { animation: tab-mcp-in 0.15s ease-out; } .tab-mcp-success-icon { animation: tab-mcp-pop 0.4s cubic-bezier(0.3, 1.4, 0.6, 1); } }
@media (forced-colors: active) { html button.tab-mcp-primary { border-color: ButtonText; } }
@keyframes tab-mcp-in { from { opacity: 0; transform: translateY(0.5rem); } }
@keyframes tab-mcp-pop { from { opacity: 0; transform: scale(0.4); } }
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
 * A dialog with its heading (`title`, or filled in by the caller). It
 * carries the texts' language and direction (`lang`, `dir` of the
 * strings), whatever the page's: read out with that voice, laid out that way.
 */
export function newDialog(
	doc: Document,
	className: string,
	s: DialogStrings,
	...title: (Node | string)[]
): { dialog: HTMLDialogElement; heading: HTMLHeadingElement; id: string } {
	const id = nextId();
	const dialog = el(doc, "dialog", {
		className: `tab-mcp-dialog ${className}`,
	});
	dialog.setAttribute("aria-labelledby", `${id}-title`);
	dialog.lang = s.lang;
	dialog.dir = s.dir;
	adoptStyles(doc);
	const heading = el(doc, "h2", { id: `${id}-title` }, ...title);
	dialog.append(heading);
	return { dialog, heading, id };
}

/** How long a Copy button says "Copied", and how long it says to press Ctrl+C. */
export const COPIED_MS = 2000;
export const SELECTED_MS = 8000;

/** What the button says after a refused Copy, by the user's device. */
function pressToCopy(doc: Document, s: DialogStrings): string {
	const view = doc.defaultView;
	if (view?.matchMedia?.("(pointer: coarse)").matches === true)
		return s.selected;
	const platform = view?.navigator.platform ?? "";
	return /^(Mac|iP)/.test(platform) ? s.pressMac : s.pressOther;
}

/**
 * A Copy button for `value()`, read at click time. Says "Copied" for a
 * moment once the clipboard took it; without a clipboard (or when it refuses)
 * `select()` puts the text in the selection and the button says to press
 * Ctrl+C (⌘C on Apple devices). `label` names it for assistive technology
 * ("Copy code"), as the dialog has more than one Copy; while it says what
 * happened, that is its name, and `announce` says it too.
 */
export function copyButton(
	doc: Document,
	s: DialogStrings,
	label: string,
	value: () => string,
	select: () => void,
	announce: (text: string) => void,
	className: string,
	kind?: "primary",
): { button: HTMLButtonElement; reset: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const say = (text: string, ms: number) => {
		node.textContent = text;
		node.removeAttribute("aria-label");
		announce(text);
		clearTimeout(timer);
		timer = setTimeout(reset, ms);
	};
	const node = button(
		doc,
		s.copy,
		() => {
			const clipboard = (doc.defaultView?.navigator as Navigator | undefined)
				?.clipboard;
			const selected = () => {
				select();
				say(pressToCopy(doc, s), SELECTED_MS);
			};
			if (clipboard !== undefined)
				clipboard.writeText(value()).then(() => say(s.copied, COPIED_MS), selected);
			else selected();
		},
		className,
		kind,
	);
	// The same width for "Copy" and "Copied": nothing moves.
	node.classList.add("tab-mcp-copy");
	const reset = () => {
		clearTimeout(timer);
		timer = undefined;
		node.textContent = s.copy;
		node.setAttribute("aria-label", label);
	};
	reset();
	return { button: node, reset };
}
