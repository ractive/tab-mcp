/**
 * The texts (`strings.ts`, the `./strings` entry): English only in the
 * package, plural forms and lists by `Intl` in the texts' language, and a
 * page's own table given once (DEC-208).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { confirmDialog } from "../src/confirm.ts";
import { setupInstructions } from "../src/setup.ts";
import {
	type DialogStrings,
	pickStrings,
	STRINGS,
	withEnglish,
} from "../src/strings.ts";
import { directionOf, listOf, plural } from "../src/text.ts";
import type { ConfirmRequest } from "../src/types.ts";

const de = (more: Partial<DialogStrings> = {}): DialogStrings =>
	withEnglish({ lang: "de", ...more });

describe("plural forms and lists follow the texts' language", () => {
	test("one text per plural category the language has; `other` for the rest", () => {
		const en = withEnglish(undefined);
		expect(plural(en.waiting, 1, en)).toBe(
			"1 more call is waiting after this one.",
		);
		expect(plural(en.waiting, 2, en)).toBe(
			"2 more calls are waiting after this one.",
		);
		// Polish has four categories: 1, 2-4, 5-21, and fractions.
		const pl = withEnglish({ lang: "pl" });
		const waiting = {
			one: "one {n}",
			few: "few {n}",
			many: "many {n}",
			other: "other {n}",
		};
		expect([1, 3, 5, 22, 1.5].map((n) => plural(waiting, n, pl))).toEqual([
			"one 1",
			"few 3",
			"many 5",
			"few 22",
			"other 1.5",
		]);
		// A table without the category the count needs: `other`.
		expect(plural({ other: "{n} Aufrufe" }, 1, de())).toBe("1 Aufrufe");
		// Other placeholders are filled in with the count.
		expect(plural(en.connected, 2, en, { apps: "A and B" })).toBe(
			"A and B are connected",
		);
	});

	test("lists are joined as the language joins them, not with a word of the table", () => {
		const en = withEnglish(undefined);
		expect(listOf([], en)).toBe("");
		expect(listOf(["A"], en)).toBe("A");
		expect(listOf(["A", "B"], en)).toBe("A and B");
		expect(listOf(["A", "B", "C"], en)).toBe("A, B, and C");
		expect(listOf(["A", "B", "C"], de())).toBe("A, B und C");
		expect("and" in STRINGS).toBe(false);
	});

	test("a lang the browser cannot read uses English rules instead of throwing", () => {
		const broken = withEnglish({ lang: "not a tag!" });
		expect(listOf(["A", "B"], broken)).toBe("A and B");
		expect(plural(broken.waiting, 1, broken)).toBe(
			"1 more call is waiting after this one.",
		);
		expect(directionOf(broken)).toBe("ltr");
	});

	test("the direction: the table's own dir, else what the browser knows of lang, else ltr", () => {
		expect(directionOf(withEnglish({ lang: "ar", dir: "rtl" }))).toBe("rtl");
		expect(directionOf(withEnglish({ lang: "ar", dir: "ltr" }))).toBe("ltr");
		const proto = Intl.Locale.prototype as Intl.Locale & {
			getTextInfo?: () => { direction: string };
		};
		const had = Object.getOwnPropertyDescriptor(proto, "getTextInfo");
		// Where the browser has it (Chrome, Safari), it says the direction.
		Object.defineProperty(proto, "getTextInfo", {
			configurable: true,
			value(this: Intl.Locale) {
				return { direction: this.language === "ar" ? "rtl" : "ltr" };
			},
		});
		try {
			expect(directionOf(withEnglish({ lang: "ar" }))).toBe("rtl");
			expect(directionOf(withEnglish({ lang: "de" }))).toBe("ltr");
		} finally {
			if (had === undefined) Reflect.deleteProperty(proto, "getTextInfo");
			else Object.defineProperty(proto, "getTextInfo", had);
		}
		// Where it does not (Firefox), left to right unless the table says.
		if (had === undefined)
			expect(directionOf(withEnglish({ lang: "ar" }))).toBe("ltr");
	});
});

describe("a page's own table", () => {
	test("withEnglish takes texts of the right kind and keeps English for the rest", () => {
		const s = withEnglish({
			lang: "de",
			deny: "Nicht erlauben",
			waiting: { one: "{n} weiterer Aufruf", other: "{n} weitere Aufrufe" },
			// The wrong kind: a string where English has plural forms, forms
			// that are not strings, a missing translation, an unknown key.
			connected: "verbunden" as never,
			connectedNext: { one: "x", other: 2 } as never,
			allow: undefined as never,
			dir: "sideways" as never,
			...({ nope: "x" } as object),
		});
		expect(s.lang).toBe("de");
		expect(s.deny).toBe("Nicht erlauben");
		expect(s.waiting).toEqual({
			one: "{n} weiterer Aufruf",
			other: "{n} weitere Aufrufe",
		});
		expect(s.connected).toEqual(STRINGS.connected);
		expect(s.connectedNext).toEqual(STRINGS.connectedNext);
		expect(s.allow).toBe("Allow once");
		expect(s.dir).toBeUndefined();
		expect("nope" in s).toBe(false);
	});

	test("the dialogs carry the table's language and direction", async () => {
		const window = new Window({ url: "https://page.example/" });
		const doc = window.document as unknown as Document;
		try {
			const request: ConfirmRequest = {
				tool: { name: "clear", description: "Clears" },
				arguments: {},
				client: { kind: "webmcp" },
				signal: new AbortController().signal,
			};
			const answer = confirmDialog(request, doc, {
				strings: withEnglish({
					lang: "ar",
					dir: "rtl",
					deny: "لا تسمح",
				}),
			});
			const dialog = doc.querySelector("dialog.tab-mcp-confirm");
			expect(dialog?.getAttribute("lang")).toBe("ar");
			expect(dialog?.getAttribute("dir")).toBe("rtl");
			(dialog as HTMLDialogElement).close("deny");
			expect(await answer).toBe("deny");
		} finally {
			await window.happyDOM.close();
		}
	});

	test("the setup steps are in the same table", () => {
		const steps = setupInstructions(
			"notes",
			"https://relay.example/s/notes/mcp",
			{
				setupClaudeApp: "Claude (claude.ai und die Desktop-App)",
				setupRun: "Ausführen:",
				setupClaudeCodeNote:
					"Dann {command} in Claude Code eingeben und Authenticate wählen.",
			},
		);
		expect(steps.map((s) => s.app)).toEqual([
			"Claude (claude.ai und die Desktop-App)",
			"ChatGPT",
			"Claude Code",
			"Codex",
		]);
		const code = steps.find((s) => s.id === "claude-code");
		expect(code?.text).toBe("Ausführen:");
		expect(code?.note).toEqual([
			{ text: "Dann " },
			{ code: "/mcp" },
			{ text: " in Claude Code eingeben und Authenticate wählen." },
		]);
		// Without a table: English.
		expect(
			setupInstructions("notes", "https://relay.example/s/notes/mcp").find(
				(s) => s.id === "codex",
			)?.note,
		).toEqual([
			{
				text: "The last line opens the sign-in that asks for the code. Start a new chat in Codex after it connects.",
			},
		]);
	});
});

describe("pickStrings: the page's table for the user's languages, loaded once chosen", () => {
	const loads: string[] = [];
	const table = (lang: string) => async () => {
		loads.push(lang);
		return { default: { deny: `deny ${lang}` } };
	};
	const tables = {
		de: table("de"),
		"pt-BR": table("pt-BR"),
		fr: async () => {
			loads.push("fr");
			return { lang: "fr-CA", deny: "Ne pas autoriser" };
		},
	};
	beforeEach(() => {
		loads.length = 0;
	});

	test("exactly, then by the language alone, in the user's order; only the chosen table loads", async () => {
		const pick = async (languages: string[]) => {
			loads.length = 0;
			const picked = await pickStrings(tables, languages);
			return { picked, loads: [...loads] };
		};
		expect(await pick(["de-CH", "fr"])).toEqual({
			picked: { lang: "de", deny: "deny de" },
			loads: ["de"],
		});
		expect(await pick(["pt-br"])).toEqual({
			picked: { lang: "pt-BR", deny: "deny pt-BR" },
			loads: ["pt-BR"],
		});
		expect(await pick(["pt-PT"])).toEqual({
			picked: { lang: "pt-BR", deny: "deny pt-BR" },
			loads: ["pt-BR"],
		});
		// The table's own lang wins over the tag it was found by.
		expect(await pick(["it", "fr"])).toEqual({
			picked: { lang: "fr-CA", deny: "Ne pas autoriser" },
			loads: ["fr"],
		});
	});

	test("English is built in: preferred first, or nothing matches, it stays", async () => {
		expect(await pickStrings(tables, ["en-GB", "de"])).toBeUndefined();
		expect(await pickStrings(tables, ["it", "ja"])).toBeUndefined();
		expect(await pickStrings(tables, [])).toBeUndefined();
		expect(loads).toEqual([]);
	});
});

test("the package ships English only: no translation in the table", () => {
	expect(STRINGS.lang).toBe("en");
	expect(STRINGS.dir).toBeUndefined();
});
