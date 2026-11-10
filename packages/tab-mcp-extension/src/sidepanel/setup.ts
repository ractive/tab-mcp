/**
 * The pairing box's "How do I add it?": the client library's steps per AI app
 * (`@ractive-ch/tab-mcp-client/setup`, the same as its connect dialog), each
 * command in a block with its own Copy. Text only through `textContent`.
 */

import { setupInstructions } from "@ractive-ch/tab-mcp-client/setup";
import { SERVER_NAME } from "../protocol.ts";

/** How long a Copy button says "Copied". */
export const COPIED_MS = 1500;

/**
 * Copy `text` with `button`, which says "Copied" for a moment; with `noun`
 * its label says so too ("Copied Codex command"), and `announce` tells a
 * screen reader, whose focus stays on the button. `failed` gets the text
 * when the clipboard refuses (the panel not focused, say), to show it whole.
 */
export function copyText(
	button: HTMLElement,
	text: string,
	failed: (text: string) => void,
	noun?: string,
	announce?: (message: string) => void,
): void {
	const say = (what: "Copy" | "Copied") => {
		button.textContent = what;
		if (noun !== undefined)
			button.setAttribute("aria-label", `${what} ${noun}`);
	};
	const clipboard = button.ownerDocument.defaultView?.navigator.clipboard;
	if (clipboard === undefined) {
		failed(text);
		return;
	}
	clipboard.writeText(text).then(
		() => {
			say("Copied");
			announce?.(noun === undefined ? "Copied" : `Copied ${noun}`);
			setTimeout(() => say("Copy"), COPIED_MS);
		},
		() => failed(text),
	);
}

/** What a refused Copy of a command says: the command is selected instead. */
export const SELECTED = "Selected: copy it with Ctrl+C or ⌘C";

/**
 * The list items for `address`: per AI app its name, what to do, a command
 * with Copy, a note. `announce` says what a Copy did (a polite status).
 */
export function setupSteps(
	doc: Document,
	address: string,
	announce: (message: string) => void,
): HTMLLIElement[] {
	const el = <K extends keyof HTMLElementTagNameMap>(
		tag: K,
		className?: string,
		text?: string,
	): HTMLElementTagNameMap[K] => {
		const node = doc.createElement(tag);
		if (className !== undefined) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	};
	return setupInstructions(SERVER_NAME, address).map(
		({ app, text, command, note }) => {
			const li = el("li");
			li.append(el("strong", undefined, app), el("span", undefined, text));
			if (command !== undefined) {
				const pre = el("pre", undefined, command);
				pre.dir = "ltr";
				const noun = `${app} command`;
				const copy = el("button", "quiet small copy", "Copy");
				copy.type = "button";
				copy.setAttribute("aria-label", `Copy ${noun}`);
				// A refused clipboard: the command selected in place, its lines
				// as they are (a one-line copy of Codex's two would run wrong).
				const selected = () => {
					doc.getSelection()?.selectAllChildren(pre);
					announce(SELECTED);
				};
				copy.addEventListener("click", () =>
					copyText(copy, command, selected, noun, announce),
				);
				const block = el("div", "command");
				block.append(pre, copy);
				li.append(block);
			}
			if (note !== undefined) {
				const small = el("p", "note muted small");
				small.append(
					...note.map((part) =>
						"code" in part ? el("code", undefined, part.code) : part.text,
					),
				);
				li.append(small);
			}
			return li;
		},
	);
}
