import { describe, expect, test } from "bun:test";
import { escapeInvisible } from "../src/visible.ts";

describe("escapeInvisible", () => {
	test("invisible, blank and direction characters become \\uXXXX, as JSON writes them", () => {
		for (const [ch, escaped] of [
			["\u202E", "\\u202E"], // right-to-left override
			["\u200B", "\\u200B"], // zero width space
			["\u2066", "\\u2066"], // isolate
			["\uFEFF", "\\uFEFF"],
			["\u034F", "\\u034F"], // combining grapheme joiner (default-ignorable)
			["\uFE00", "\\uFE00"], // variation selectors
			["\uFE0F", "\\uFE0F"],
			["\u{E0100}", "\\uDB40\\uDD00"],
			["\u{E01EF}", "\\uDB40\\uDDEF"],
			["\u{E0041}", "\\uDB40\\uDC41"], // tag
			["\uE000", "\\uE000"], // private use
			["\u{10FFFD}", "\\uDBFF\\uDFFD"],
			["\u0378", "\\u0378"], // unassigned
			["\u0085", "\\u0085"], // C1
			["\u009F", "\\u009F"],
			["\r", "\\u000D"],
			["\u0000", "\\u0000"],
			["\u2028", "\\u2028"],
			["\u2029", "\\u2029"],
			["\u00A0", "\\u00A0"],
			["\u2007", "\\u2007"],
			["\u3000", "\\u3000"],
			["\u2800", "\\u2800"], // Braille blank
			["\u3164", "\\u3164"], // Hangul filler
			["\u115F", "\\u115F"],
			["\uFFA0", "\\uFFA0"],
			["\uD800", "\\uD800"], // a lone surrogate
		])
			expect(escapeInvisible(`a${ch}b`)).toBe(`a${escaped}b`);
	});

	test("plain text, JSON's layout and emoji stay", () => {
		expect(escapeInvisible("plain text, äöü 😀 中文")).toBe(
			"plain text, äöü 😀 中文",
		);
		expect(escapeInvisible('{\n\t"a": 1\n}')).toBe('{\n\t"a": 1\n}');
	});

	test("JSON with escapes is still JSON for the same value", () => {
		const value = { "k\u202E": "x\uFE0F\u{E0100}\u00A0\u2800\u0085" };
		expect(JSON.parse(escapeInvisible(JSON.stringify(value, null, 2)))).toEqual(
			value,
		);
	});
});
