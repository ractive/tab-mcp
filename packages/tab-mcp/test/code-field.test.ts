/**
 * The pairing page's code field (DEC-211): the text and the caret after each
 * edit, as the page's script sets them, and the script being up to date.
 * The browser side is in code-field.browser.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { buildCodeFieldScript } from "../scripts/code-field.ts";
import {
	boxAt,
	caretSide,
	type Edit,
	LETTERS,
	lettersOf,
	shown,
	tidy,
} from "../src/oauth/code-field.ts";
import { CODE_FIELD_SCRIPT } from "../src/oauth/code-field-script.ts";
import { CODE_LENGTH, normalizeCode } from "../src/oauth/pairing.ts";

/** The field with a selection (`start` = `end`: only the caret). */
interface State {
	value: string;
	start: number;
	end: number;
}

const at = (value: string, start = value.length, end = start): State => ({
	value,
	start,
	end,
});

/** What the browser does, then what the script makes of it. */
function edit(
	state: State,
	inputType: string,
	raw: string,
	caret: number,
): State {
	const before: Edit = {
		previous: state.value,
		inputType,
		collapsed: state.start === state.end,
	};
	const next = tidy(raw, caret, before);
	return at(next.value, next.caret);
}

function type(state: State, text: string, inputType = "insertText"): State {
	const raw =
		state.value.slice(0, state.start) + text + state.value.slice(state.end);
	return edit(state, inputType, raw, state.start + text.length);
}

const paste = (state: State, text: string) =>
	type(state, text, "insertFromPaste");

function backspace(state: State): State {
	const from = state.start === state.end ? state.start - 1 : state.start;
	if (from < 0) return state;
	const raw = state.value.slice(0, from) + state.value.slice(state.end);
	return edit(state, "deleteContentBackward", raw, from);
}

function del(state: State): State {
	const to = state.start === state.end ? state.end + 1 : state.end;
	if (to > state.value.length) return state;
	const raw = state.value.slice(0, state.start) + state.value.slice(to);
	return edit(state, "deleteContentForward", raw, state.start);
}

/** The text with the caret drawn as `|`. */
const show = (s: State) =>
	s.start === s.end
		? `${s.value.slice(0, s.start)}|${s.value.slice(s.start)}`
		: s.value;

describe("the text", () => {
	test("letters in upper case, everything else dropped, the dash with the fifth letter", () => {
		expect(LETTERS).toBe(CODE_LENGTH);
		expect(lettersOf("ab-c d1é\nß")).toBe("ABCDSS");
		expect(shown("ABCD")).toBe("ABCD");
		expect(shown("ABCDE")).toBe("ABCD-E");
		expect(shown("ABCDEFGH")).toBe("ABCD-EFGH");
	});

	test("typing one letter after the other, lower case too", () => {
		let s = at("");
		const seen: string[] = [];
		for (const letter of "bcdfghjk") {
			s = type(s, letter);
			seen.push(show(s));
		}
		expect(seen).toEqual([
			"B|",
			"BC|",
			"BCD|",
			"BCDF|",
			"BCDF-G|",
			"BCDF-GH|",
			"BCDF-GHJ|",
			"BCDF-GHJK|",
		]);
		// A ninth letter is not taken.
		expect(show(type(s, "L"))).toBe("BCDF-GHJK|");
	});

	test("a digit, a space or a dash typed is dropped where it was typed", () => {
		expect(show(type(at("AB"), "1"))).toBe("AB|");
		expect(show(type(at("ABCD"), "-"))).toBe("ABCD|");
		expect(show(type(at("ABCD"), " "))).toBe("ABCD|");
		expect(show(type(at("ABCD-EFG", 4), "-"))).toBe("ABCD|-EFG");
		expect(show(type(at("ABCD-EFG", 2), " "))).toBe("AB|CD-EFG");
	});

	test("every full text is a code the relay and the field's pattern accept", () => {
		const s = paste(at(""), "bcdf-ghjk");
		expect(s.value).toBe("BCDF-GHJK");
		expect(normalizeCode(s.value)).toBe("BCDFGHJK");
		expect(/^[A-Za-z -]{8,12}$/.test(s.value)).toBe(true);
	});
});

describe("Backspace and Delete", () => {
	test("Backspace from a full code to nothing, never stuck on the dash", () => {
		let s = at("ABCD-EFGH");
		const seen: string[] = [];
		while (s.value !== "") {
			s = backspace(s);
			seen.push(show(s));
		}
		expect(seen).toEqual([
			"ABCD-EFG|",
			"ABCD-EF|",
			"ABCD-E|",
			"ABCD|",
			"ABC|",
			"AB|",
			"A|",
			"|",
		]);
	});

	test("Backspace right behind the dash takes the letter in front of it", () => {
		expect(show(backspace(at("ABCD-EFGH", 5)))).toBe("ABC|E-FGH");
		expect(show(backspace(at("ABCD-E", 5)))).toBe("ABC|E");
	});

	test("Backspace in front of the dash takes the fourth letter", () => {
		expect(show(backspace(at("ABCD-EFGH", 4)))).toBe("ABC|E-FGH");
	});

	test("Delete in front of the dash takes the letter after it, the caret stays", () => {
		let s = del(at("ABCD-EFGH", 4));
		expect(show(s)).toBe("ABCD|-FGH");
		s = del(s);
		expect(show(s)).toBe("ABCD|-GH");
		expect(show(del(at("ABCD-E", 4)))).toBe("ABCD|");
	});

	test("Delete in the middle and at the end", () => {
		expect(show(del(at("ABCD-EFGH", 1)))).toBe("A|CDE-FGH");
		expect(show(del(at("ABCD-EFGH", 6)))).toBe("ABCD-E|GH");
		expect(show(del(at("ABCD-EFGH")))).toBe("ABCD-EFGH|");
	});

	test("a selection deleted goes as a whole; the dash alone selected changes nothing", () => {
		expect(show(backspace(at("ABCD-EFGH", 2, 7)))).toBe("AB|GH");
		expect(show(del(at("ABCD-EFGH", 0, 9)))).toBe("|");
		expect(backspace(at("ABCD-EFGH", 4, 5)).value).toBe("ABCD-EFGH");
	});
});

describe("typing in the middle and over a selection", () => {
	test("a letter typed in the middle goes there; the rest moves on", () => {
		expect(show(type(at("ABCD-EFG", 2), "x"))).toBe("ABX|C-DEFG");
		// In front of the dash and behind it: the letter is the fifth.
		expect(show(type(at("ABCD-EFG", 4), "x"))).toBe("ABCD-X|EFG");
		expect(show(type(at("ABCD-EFG", 5), "x"))).toBe("ABCD-X|EFG");
		// The fourth letter typed: the caret goes into the next box.
		expect(show(type(at("ABCE-FGH", 3), "d"))).toBe("ABCD-|EFGH");
		// Typed into a full code: the last letter falls off.
		expect(show(type(at("ABCD-EFGH", 0), "z"))).toBe("Z|ABC-DEFG");
	});

	test("typing over a selection replaces it", () => {
		expect(show(type(at("ABCD-EFGH", 3, 6), "x"))).toBe("ABCX-|FGH");
		expect(show(type(at("ABCD-EFGH", 0, 9), "q"))).toBe("Q|");
	});
});

describe("paste", () => {
	const shapes = [
		"abcd-efgh",
		"ABCD EFGH",
		"ABCDEFGH",
		"\n  abcd-efgh \n",
		" ABCD EFGH\r\n",
		"abcd - efgh",
	];

	test.each(shapes)(
		"%j into the empty field or over everything gives the code",
		(text) => {
			expect(show(paste(at(""), text))).toBe("ABCD-EFGH|");
			expect(show(paste(at("QRST-VW", 0, 7), text))).toBe("ABCD-EFGH|");
		},
	);

	test("a paste into the middle goes there, cut at eight letters", () => {
		expect(show(paste(at("AB"), "cd-ef"))).toBe("ABCD-EF|");
		expect(show(paste(at("ABCD-EFGH", 2), "XY"))).toBe("ABXY-|CDEF");
		expect(show(paste(at("EFGH", 0), "abcd"))).toBe("ABCD-|EFGH");
		expect(show(paste(at(""), "ABCDEFGHJKLM"))).toBe("ABCD-EFGH|");
	});

	test("a drop and a keyboard's suggestion are edits like a paste", () => {
		expect(show(type(at(""), "abcd efgh", "insertFromDrop"))).toBe(
			"ABCD-EFGH|",
		);
		expect(
			show(type(at("ABC", 0, 3), "abcdefgh", "insertReplacementText")),
		).toBe("ABCD-EFGH|");
	});
});

describe("without an edit of its own", () => {
	test("text an extension wrote is tidied; the caret stays after the same letters", () => {
		expect(tidy("bcdf-ghjk", 9)).toEqual({ value: "BCDF-GHJK", caret: 9 });
		expect(tidy("BCDFGHJK", 0)).toEqual({ value: "BCDF-GHJK", caret: 0 });
		expect(tidy("", 0)).toEqual({ value: "", caret: 0 });
	});

	test("undo and redo leave a tidy text as it is", () => {
		for (const inputType of ["historyUndo", "historyRedo"]) {
			expect(
				tidy("ABCD-EF", 7, { previous: "ABCD-E", inputType, collapsed: true }),
			).toEqual({ value: "ABCD-EF", caret: 7 });
			// An undo that brings back fewer characters is no Backspace.
			expect(
				tidy("ABCD", 4, { previous: "ABCD-E", inputType, collapsed: true }),
			).toEqual({ value: "ABCD", caret: 4 });
		}
	});
});

describe("the box the caret is in", () => {
	test("four boxes, the dash, four boxes: the dash's place is the box after it", () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(boxAt)).toEqual([
			0, 1, 2, 3, 5, 5, 6, 7, 8, 8,
		]);
	});
});

describe("where the drawn caret stands", () => {
	test("in front of the box's letter, behind the last letter, in the middle of an empty box", () => {
		const full = "ABCD-EFGH";
		expect(
			[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => caretSide(c, full)),
		).toEqual([
			"before",
			"before",
			"before",
			"before",
			"before",
			"before",
			"before",
			"before",
			"before",
			"after",
		]);
		expect([0, 1, 2, 3].map((c) => caretSide(c, "ABC"))).toEqual([
			"before",
			"before",
			"before",
			"empty",
		]);
		expect([3, 4].map((c) => caretSide(c, "ABCD"))).toEqual([
			"before",
			"empty",
		]);
		expect([4, 5, 6].map((c) => caretSide(c, "ABCD-E"))).toEqual([
			"before",
			"before",
			"empty",
		]);
		expect(caretSide(0, "")).toBe("empty");
	});
});

describe("the script the page ships", () => {
	test("is up to date with its source (bun scripts/code-field.ts)", async () => {
		expect(await buildCodeFieldScript()).toBe(CODE_FIELD_SCRIPT);
	});

	test("can stand inline in a <script> element and uses no eval", () => {
		expect(CODE_FIELD_SCRIPT).not.toMatch(/<\/script|<!--/i);
		expect(CODE_FIELD_SCRIPT).not.toMatch(
			/\beval\b|\bFunction\(|innerHTML|import\(/,
		);
	});
});
