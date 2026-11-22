/**
 * The pairing page's one script (DEC-211), bundled by
 * `scripts/code-field.ts` into `code-field-script.ts`, which the page ships
 * inline and the policy allows by its hash. It only touches the code field:
 * the browser makes every edit itself (typing, paste, drop, an input
 * method), and after each one the script tidies the text and puts the caret
 * back after the same letters (`tidy`). Then it marks the field as enhanced,
 * which draws it as boxes. Without the script the field is a plain input.
 *
 * Undo is not kept: when the script rewrites the text (upper case, the dash,
 * dropped characters), the browser forgets the field's undo history, so undo
 * then does nothing or stops at that point. It never throws or loops: setting
 * `value` fires no `input` event. Keeping it would take the deprecated
 * `document.execCommand`, not worth it for eight letters (review of PR 194).
 *
 * Type-checked with `tsconfig.browser.json` (the DOM), not with the relay.
 */

import { boxAt, caretSide, type Edit, tidy } from "./code-field.ts";

const field = document.getElementById("code");
const row = field?.parentElement;
if (
	field instanceof HTMLInputElement &&
	row?.classList.contains("code-field")
) {
	const boxes = row.querySelectorAll(".code-boxes > span");
	let edit: Edit | undefined;
	// While an input method composes, no box stands in for the caret.
	let composing = false;

	const paint = () => {
		const start = field.selectionStart;
		const at =
			!composing &&
			document.activeElement === field &&
			start !== null &&
			start === field.selectionEnd
				? boxAt(start)
				: -1;
		// The classes go and come back after a reflow, so that the caret's blink
		// starts again, visible, as a native caret's does.
		for (const box of boxes)
			box.classList.remove("at", "caret-after", "caret-empty");
		const box = boxes[at];
		if (box instanceof HTMLElement && start !== null) {
			void box.offsetWidth;
			box.classList.add("at");
			const side = caretSide(start, field.value);
			if (side !== "before") box.classList.add(`caret-${side}`);
		}
		row.classList.toggle("has-dash", field.value.includes("-"));
	};

	const apply = (done?: Edit) => {
		const next = tidy(
			field.value,
			field.selectionStart ?? field.value.length,
			done,
		);
		// Only when the text changes: setting it drops the undo history.
		if (next.value !== field.value) field.value = next.value;
		if (document.activeElement === field)
			field.setSelectionRange(next.caret, next.caret);
		paint();
	};

	field.addEventListener("beforeinput", (event) => {
		edit = {
			previous: field.value,
			inputType: event.inputType,
			collapsed: field.selectionStart === field.selectionEnd,
		};
	});
	field.addEventListener("input", (event) => {
		// An extension's plain `Event` has no inputType; an edit of another
		// kind left over from a `beforeinput` without `input` is not this one.
		const type = event instanceof InputEvent ? event.inputType : undefined;
		const done = edit?.inputType === type ? edit : undefined;
		edit = undefined;
		// Changing the text while an input method composes would break it.
		if (event instanceof InputEvent && event.isComposing) return;
		apply(done);
	});
	field.addEventListener("compositionstart", () => {
		composing = true;
		paint();
	});
	field.addEventListener("compositionend", () => {
		composing = false;
		apply();
	});
	field.addEventListener("change", () => apply());
	for (const type of [
		"focus",
		"blur",
		"keyup",
		"pointerup",
		"select",
		"selectionchange",
	]) {
		field.addEventListener(type, paint);
	}
	// The script keeps the code at eight letters; `maxlength` would cut a
	// paste with spaces around it before the script could tidy it.
	field.removeAttribute("maxlength");
	apply();
	row.classList.add("enhanced");
}
