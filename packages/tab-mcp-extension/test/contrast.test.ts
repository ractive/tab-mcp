/**
 * The look's contrast and rules (DEC-160 to DEC-163): every pair of the
 * tables in kb/design/extension-look.md, computed from the two token blocks
 * of the panel's style sheet (light and dark) and from the badge's fixed
 * colours. WCAG 2.2: text 4.5:1; boundaries, dots and a switch's parts 3:1.
 * And what the style sheet promises without a browser: every colour is a
 * token, no token is unused, nothing is disabled by opacity alone, every
 * transition stops under reduced motion, and no state brings a colour back
 * that a rule for unavailable controls or forced colours took away.
 */

import { describe, expect, test } from "bun:test";
import { BADGE_LOOK } from "../src/look.ts";

const css = await Bun.file(
	new URL("../src/sidepanel/style.css", import.meta.url),
).text();

/** The custom properties with a colour of the first `:root` block from `at`. */
function tokens(at: number): Record<string, string> {
	const start = css.indexOf(":root", at);
	const block = css.slice(start, css.indexOf("}", start));
	return Object.fromEntries(
		[...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/g)].map((m) => [
			m[1] as string,
			m[2] as string,
		]),
	);
}

const DARK = "@media (prefers-color-scheme: dark)";
const light = tokens(0);
const dark = { ...light, ...tokens(css.indexOf(DARK)) };

function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two colours, as the tables give it. */
function ratio(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
		number,
		number,
	];
	return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2));
}

const TEXT = 4.5;
const EDGE = 3;

/** A row of the table: a token on each of some others. */
type Row = [
	on: string,
	under: string[],
	light: number[],
	dark: number[],
	needs: number,
];

const SURFACES = ["--paper", "--sheet", "--wash"];
const NOTICES = ["--warn-bg", "--danger-bg"];

const PAIRS: Row[] = [
	["--ink", SURFACES, [14.61, 16.07, 13.12], [15.89, 14.37, 12.38], TEXT],
	["--ink", NOTICES, [14.22, 13.41], [12.59, 13.78], TEXT],
	["--ink-2", SURFACES, [6.11, 6.72, 5.49], [8.26, 7.48, 6.44], TEXT],
	["--ink-2", NOTICES, [5.95, 5.61], [6.55, 7.17], TEXT],
	[
		"--link",
		[...SURFACES, "--warn-bg"],
		[6.12, 6.73, 5.49, 5.95],
		[9.19, 8.32, 7.16, 7.29],
		TEXT,
	],
	// A strong button's words, and the knob on the "on" track.
	["--on-strong", ["--strong"], [16.07], [15.89], TEXT],
	[
		"--ok",
		["--paper", "--sheet", "--ok-bg"],
		[5.86, 6.44, 5.51],
		[9.85, 8.91, 7.64],
		TEXT,
	],
	[
		"--warn",
		["--paper", "--sheet", "--warn-bg"],
		[7.01, 7.71, 6.83],
		[12.02, 10.87, 9.53],
		TEXT,
	],
	[
		"--danger",
		["--paper", "--sheet", "--danger-bg"],
		[5.94, 6.54, 5.46],
		[8.36, 7.56, 7.25],
		TEXT,
	],
	// An armed button's words.
	["--on-danger", ["--danger"], [6.54], [8.36], TEXT],
	["--edge", SURFACES, [3.51, 3.86, 3.15], [4.39, 3.97, 3.42], EDGE],
	// A button on a notice.
	["--edge", NOTICES, [3.41, 3.22], [3.48, 3.81], EDGE],
	// The knob on the "off" track; the "on" track on what it stands on.
	["--on-strong", ["--edge"], [3.86], [4.39], EDGE],
	["--strong", ["--paper", "--sheet"], [14.61, 16.07], [15.89, 14.37], EDGE],
	[
		"--focus",
		[...SURFACES, ...NOTICES],
		[6.12, 6.73, 5.49, 5.95, 5.61],
		[9.19, 8.32, 7.16, 7.29, 7.98],
		EDGE,
	],
	[
		"--warn-edge",
		["--paper", "--sheet", "--warn-bg"],
		[4.25, 4.68, 4.14],
		[6.26, 5.67, 4.97],
		EDGE,
	],
	// The problem's edge against its fill and the section.
	["--danger", ["--danger-bg", "--paper"], [5.46, 5.94], [7.25, 8.36], EDGE],
	// The waiting dot's ring; the dots of off and on are text colours above.
	["--accent-edge", ["--paper", "--sheet"], [4.12, 4.53], [10.06, 9.1], EDGE],
];

describe("the panel's tokens", () => {
	test("both schemes define every colour, and dark changes the ones it must", () => {
		expect(Object.keys(light).length).toBe(21);
		expect(light["--paper"]).toBe("#f6f4ee");
		expect(dark["--paper"]).toBe("#11141a");
		// Amber is the same in both; every other colour has a dark value.
		expect(
			Object.keys(light).filter((name) => dark[name] === light[name]),
		).toEqual(["--accent"]);
		// The look before (blue accent, cards on a background) is gone.
		expect(
			/--(fg|muted|line|card|bg|on|off|wait|problem|knob-color)(?![\w-])/.test(
				css,
			),
		).toBe(false);
	});

	for (const [on, under, inLight, inDark, needs] of PAIRS)
		for (const [i, below] of under.entries())
			for (const [scheme, t, want] of [
				["light", light, inLight[i]],
				["dark", dark, inDark[i]],
			] as const)
				test(`${on} on ${below}, ${scheme}: ${want}:1 (needs ${needs})`, () => {
					const got = ratio(t[on] as string, t[below] as string);
					expect(got).toBe(want as number);
					expect(got).toBeGreaterThanOrEqual(needs);
				});
});

describe("the badge on the toolbar icon", () => {
	const rows: [keyof typeof BADGE_LOOK, string, number][] = [
		["question", "--accent-edge", 4.53],
		["on", "--ok", 6.44],
		["idle", "--ink-2", 6.72],
	];
	for (const [state, token, want] of rows)
		test(`${state}: the light ${token}, white text ${want}:1 on it`, () => {
			expect<string>(BADGE_LOOK[state]).toBe(light[token] as string);
			expect(ratio(BADGE_LOOK.text, BADGE_LOOK[state])).toBe(want);
			expect(want).toBeGreaterThanOrEqual(TEXT);
		});
});

/** A rule of the style sheet: its media query (if any), selector and body. */
interface Rule {
	media: string;
	selector: string;
	body: string;
}

/** The style sheet's rules, comments out, one level of `@media` unfolded. */
function rules(source: string): Rule[] {
	const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
	const found: Rule[] = [];
	const read = (part: string, media: string) => {
		let at = 0;
		for (;;) {
			const open = part.indexOf("{", at);
			if (open === -1) return;
			const head = part.slice(at, open).trim().replace(/\s+/g, " ");
			let depth = 1;
			let end = open + 1;
			for (; depth > 0 && end < part.length; end++)
				if (part[end] === "{") depth++;
				else if (part[end] === "}") depth--;
			const body = part.slice(open + 1, end - 1);
			if (head.startsWith("@media")) read(body, head);
			else found.push({ media, selector: head, body: body.trim() });
			at = end;
		}
	};
	read(text, "");
	return found;
}

/** A selector list's selectors: commas inside `:is()` and `:not()` do not split. */
function selectors(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = "";
	for (const c of list) {
		if (c === "(") depth++;
		if (c === ")") depth--;
		if (c === "," && depth === 0) {
			out.push(current.trim());
			current = "";
		} else current += c;
	}
	out.push(current.trim());
	return out;
}

const all = rules(css);
const plain = all.filter((r) => r.media === "");
const FORCED = "@media (forced-colors: active)";
const REDUCED = "@media (prefers-reduced-motion: reduce)";
const forced = all.filter((r) => r.media === FORCED);
const isTokenBlock = (r: Rule) => r.selector === ":root";

describe("the style sheet's rules", () => {
	test("it parses: the token blocks, the three media queries, and rules", () => {
		expect(all.filter(isTokenBlock).map((r) => r.media)).toEqual(["", DARK]);
		expect([...new Set(all.map((r) => r.media))].sort()).toEqual(
			["", DARK, FORCED, REDUCED].sort(),
		);
		expect(plain.length).toBeGreaterThan(80);
	});

	test("`hidden` wins over every display rule: its rule is the last, and none before it outweighs it", () => {
		expect(plain.at(-1)).toEqual({
			media: "",
			selector: "html [hidden]",
			body: "display: none;",
		});
		// (0, 1, 1). A rule that shows something has at most one class or
		// attribute and one element, or is on something that is never hidden.
		const NEVER_HIDDEN = [".grants .app", ".setup .command", ".tools .why"];
		const heavier = plain
			.filter((r) => /(^|[;\s])display:\s*(?!none)\S/.test(r.body))
			.flatMap((r) => selectors(r.selector))
			.filter(
				(s) =>
					s.includes("#") ||
					(s.replace(/:(is|not|where|has)\([^)]*\)/g, "").match(/[.[:]/g) ?? [])
						.length > 1,
			);
		expect(heavier).toEqual(NEVER_HIDDEN);
	});

	test("every colour is a token: no literal outside the two blocks, system colours only in forced colours", () => {
		const SYSTEM =
			/\b(Canvas|CanvasText|ButtonText|ButtonFace|ButtonBorder|GrayText|Highlight|HighlightText|LinkText)\b/;
		const NAMED =
			/:\s*(white|black|red|green|blue|gr[ae]y|silver|orange|yellow|purple)\b/i;
		for (const r of all.filter((r) => !isTokenBlock(r))) {
			expect(r.body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
			expect(r.body).not.toMatch(/\b(rgba?|hsla?|oklch|oklab|lab|lch)\(/);
			expect(r.body).not.toMatch(NAMED);
			if (r.media !== FORCED) expect(r.body).not.toMatch(SYSTEM);
		}
	});

	test("every token is read by a rule, and every var() is defined", () => {
		const defined = new Set(
			all.flatMap((r) =>
				[...r.body.matchAll(/(?:^|[;\s])(--[\w-]+)\s*:/g)].map(
					(m) => m[1] as string,
				),
			),
		);
		const read = new Set(
			all.flatMap((r) =>
				[...r.body.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1] as string),
			),
		);
		expect([...defined].filter((name) => !read.has(name))).toEqual([]);
		expect([...read].filter((name) => !defined.has(name))).toEqual([]);
		// No fallback values: a token that is missing shows.
		expect(css).not.toMatch(/var\(--[\w-]+\s*,/);
	});

	test("nothing is dimmed by opacity, and no shadow has a blur", () => {
		for (const r of all) {
			expect(r.body).not.toMatch(/(^|[;\s])opacity\s*:/);
			expect(r.body).not.toMatch(/(^|[;\s])filter\s*:/);
			for (const m of r.body.matchAll(/box-shadow:\s*([^;]+);/g))
				expect(m[1]).toMatch(/^(none|(inset )?0 0 0 1px var\(--[\w-]+\))$/);
		}
	});

	test("a button or switch that takes no click has colours of its own, for disabled and aria-disabled alike", () => {
		const off = plain.find(
			(r) => r.selector === 'button:is(:disabled, [aria-disabled="true"])',
		);
		expect(off?.body).toContain("background: var(--wash);");
		expect(off?.body).toContain("color: var(--ink-2);");
		expect(off?.body).toContain("border-color: var(--rule);");
		// It comes after every button kind it has to win over (same weight).
		const index = (selector: string) =>
			plain.findIndex((r) => selectors(r.selector).includes(selector));
		for (const kind of ["button.strong", "button.small", "button"])
			expect(index(kind)).toBeLessThan(plain.indexOf(off as Rule));
		expect(
			plain.find(
				(r) => r.selector === '.ask-switch input[aria-disabled="true"]',
			)?.body,
		).toContain("background: var(--wash);");
	});

	test("no hover rule of a button reaches one that takes no click", () => {
		const hovers = plain
			.flatMap((r) => selectors(r.selector))
			.filter((s) => s.includes(":hover"));
		expect(hovers.length).toBeGreaterThanOrEqual(5);
		for (const s of hovers)
			expect(s).toContain(':hover:not(:disabled, [aria-disabled="true"])');
	});

	test("no button is amber: amber is the waiting dot only (DEC-161)", () => {
		const amber = all.filter((r) => r.body.includes("var(--accent)"));
		expect(amber.map((r) => r.selector)).toEqual([
			'.state:is( [data-state="connecting"], [data-state="retrying"], [data-state="waiting"] ) .dot',
		]);
		// With its ring: amber alone is 1.67:1 on paper in light.
		expect(amber[0]?.body).toContain(
			"box-shadow: 0 0 0 1px var(--accent-edge);",
		);
		expect(ratio(light["--accent"] as string, light["--paper"] as string)).toBe(
			1.67,
		);
		expect(css).not.toMatch(/\.primary\b/);
	});

	test("one focus ring for every control", () => {
		const focus = plain.filter((r) => r.selector.includes(":focus"));
		expect(focus.map((r) => r.selector)).toEqual([":focus-visible"]);
		expect(focus[0]?.body).toContain("outline: 2px solid var(--focus);");
		expect(css).not.toMatch(/outline:\s*(none|0)\b/);
	});

	test("reduced motion stops every transition", () => {
		const moving = plain
			.filter((r) => /(^|[;\s])(transition|animation)\s*:/.test(r.body))
			.flatMap((r) => selectors(r.selector));
		expect(moving).toEqual([
			"button",
			":is(.switch, .ask-switch) input",
			":is(.switch, .ask-switch) input::after",
		]);
		const reduced = all.filter((r) => r.media === REDUCED);
		expect(reduced.length).toBe(1);
		expect(selectors(reduced[0]?.selector ?? "")).toEqual(moving);
		expect(reduced[0]?.body).toBe("transition: none;");
	});

	test("forced colours: filled buttons keep an edge in every state, the switches and the unavailable ones are in system colours", () => {
		const of = (selector: string) =>
			forced.find((r) => selectors(r.selector).includes(selector))?.body ?? "";
		// The hover rules outside the block are more specific than a plain
		// selector inside it: the block names them too.
		for (const selector of [
			"button.strong",
			'button.strong:hover:not(:disabled, [aria-disabled="true"])',
			"button[data-armed]",
			'button[data-armed]:hover:not(:disabled, [aria-disabled="true"])',
		])
			expect(of(selector)).toBe("border-color: ButtonText;");
		expect(of('button:is(:disabled, [aria-disabled="true"])')).toContain(
			"color: GrayText;",
		);
		expect(of(":is(.switch, .ask-switch) input")).toContain(
			"border-color: CanvasText;",
		);
		expect(of(":is(.switch, .ask-switch) input:checked")).toContain(
			"background: Highlight;",
		);
		// The unavailable switch's knob: its rule outside the block outweighs
		// the knob's rule inside it, so the block names it, after that rule.
		const knob = forced.findIndex(
			(r) => r.selector === ":is(.switch, .ask-switch) input::after",
		);
		const unavailable = forced.findIndex(
			(r) => r.selector === '.ask-switch input[aria-disabled="true"]::after',
		);
		expect(knob).toBeGreaterThanOrEqual(0);
		expect(unavailable).toBeGreaterThan(knob);
		expect(forced[unavailable]?.body).toBe("background: GrayText;");
		// On: the knob is the text colour of the Highlight it stands on
		// (CanvasText on Highlight is a pair no theme promises); before the
		// unavailable knob's rule, which weighs the same and wins.
		const onKnob = forced.findIndex(
			(r) => r.selector === ":is(.switch, .ask-switch) input:checked::after",
		);
		expect(forced[onKnob]?.body).toBe("background: HighlightText;");
		expect(onKnob).toBeGreaterThan(knob);
		expect(onKnob).toBeLessThan(unavailable);
		// Every selector that sets a knob or track colour outside the block
		// has a rule inside it.
		const coloured = plain
			.filter(
				(r) => /switch/.test(r.selector) && /background: var\(/.test(r.body),
			)
			.flatMap((r) => selectors(r.selector))
			.filter((s) => s.includes("input"));
		expect(coloured.length).toBe(5);
		const named = forced.flatMap((r) => selectors(r.selector));
		for (const s of coloured) expect(named).toContain(s);
	});
});
