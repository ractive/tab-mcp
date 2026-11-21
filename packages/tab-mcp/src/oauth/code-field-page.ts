/**
 * The pairing page's one script (DEC-211), bundled by
 * `scripts/code-field.ts` into `code-field-script.ts`, which the page ships
 * inline and the policy allows by its hash. It only touches the code field:
 * the browser makes every edit itself (typing, paste, drop, undo, an input
 * method), and after each one the script tidies the text and puts the caret
 * back after the same letters (`tidy`). Then it marks the field as enhanced,
 * which draws it as boxes. Without the script the field is a plain input.
 *
 * Type-checked with `tsconfig.browser.json` (the DOM), not with the relay.
 */

import { boxAt, type Edit, tidy } from "./code-field.ts";

const field = document.getElementById("code");
const row = field?.parentElement;
if (
	field instanceof HTMLInputElement &&
	row?.classList.contains("code-field")
) {
	const boxes = row.querySelectorAll(".code-boxes > span");
	let edit: Edit | undefined;

	const paint = () => {
		const start = field.selectionStart;
		const at =
			document.activeElement === field &&
			start !== null &&
			start === field.selectionEnd
				? boxAt(start)
				: -1;
		boxes.forEach((box, i) => {
			box.classList.toggle("at", i === at);
		});
		row.classList.toggle("has-dash", field.value.includes("-"));
	};

	const apply = (done?: Edit) => {
		const next = tidy(
			field.value,
			field.selectionStart ?? field.value.length,
			done,
		);
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
	field.addEventListener("compositionend", () => apply());
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
