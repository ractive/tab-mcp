/**
 * The pairing page's code field (DEC-211): what the field shows after an
 * edit, and where the caret goes. Pure functions, used by the page's one
 * script (`code-field-page.ts`); no DOM here.
 *
 * The field shows `XXXX-XXXX`: letters in upper case, everything else
 * dropped, at most eight letters. The dash comes by itself with the fifth
 * letter, not after the fourth, so Backspace never stops at it.
 */

/** Letters in a code (`CODE_LENGTH` in `pairing.ts`). */
export const LETTERS = 8;
const HALF = LETTERS / 2;

/** The field's text and the caret's place in it. */
export interface Field {
	value: string;
	caret: number;
}

/** What the field was before the browser made an edit. */
export interface Edit {
	/** The text before the edit. */
	previous: string;
	/** The edit's `InputEvent.inputType`. */
	inputType: string;
	/** Whether nothing was selected (only a caret) before the edit. */
	collapsed: boolean;
}

/** The letters of `text`, upper-cased; everything else is dropped. */
export function lettersOf(text: string): string {
	return text.toUpperCase().replace(/[^A-Z]/g, "");
}

/** `letters` as the field shows them: the dash once there is a fifth letter. */
export function shown(letters: string): string {
	return letters.length > HALF
		? `${letters.slice(0, HALF)}-${letters.slice(HALF)}`
		: letters;
}

/**
 * The caret's place after `before` of `count` letters. Right after the
 * fourth letter it goes behind the dash, into the box the next letter goes
 * to, unless it was in front of the dash already (`frontOfDash`).
 */
function place(before: number, count: number, frontOfDash: boolean): number {
	if (before < HALF || count <= HALF) return before;
	if (before === HALF) return frontOfDash ? HALF : HALF + 1;
	return before + 1;
}

/**
 * The field after the browser made an edit: `raw` is the text it left and
 * `caret` where it left the caret. The caret stays after the same letters
 * it was after. Backspace that took only the dash takes the letter before
 * it as well, Delete that took only the dash the letter after it. Letters
 * beyond the eighth are cut from the end.
 */
export function tidy(raw: string, caret: number, edit?: Edit): Field {
	let letters = lettersOf(raw);
	let before = lettersOf(raw.slice(0, caret)).length;
	let frontOfDash = raw[caret] === "-";
	const backward = edit?.inputType === "deleteContentBackward";
	const forward = edit?.inputType === "deleteContentForward";
	if (
		edit !== undefined &&
		(backward || forward) &&
		edit.collapsed &&
		raw.length < edit.previous.length &&
		letters === lettersOf(edit.previous)
	) {
		const at = backward ? HALF - 1 : HALF;
		letters = letters.slice(0, at) + letters.slice(at + 1);
		before = at;
		frontOfDash = forward;
	}
	letters = letters.slice(0, LETTERS);
	before = Math.min(before, letters.length);
	return {
		value: shown(letters),
		caret: place(before, letters.length, frontOfDash),
	};
}

/**
 * The box the caret at `caret` is in, as an index into the row of four
 * boxes, the dash and four boxes. The dash's place counts as the box after
 * it, and the place after the last letter as the last box.
 */
export function boxAt(caret: number): number {
	return caret === HALF ? HALF + 1 : Math.min(Math.max(caret, 0), LETTERS);
}
