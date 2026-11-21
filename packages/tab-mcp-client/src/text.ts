/**
 * Filling in the texts of `strings.ts`: placeholders, plural forms and lists,
 * by the rules of the texts' language (`Intl`), not by grammar made by hand.
 * No DOM and no texts, so that `./react` can use it without loading the
 * table, as well as the dialogs.
 */

import type { DialogStrings, PluralText } from "./strings.ts";

/** What the helpers need of the texts: their language. */
type InLanguage = { lang: string };

/** `template` with its `{name}` placeholders filled in, as text. */
export function format(
	template: string,
	values: Record<string, string>,
): string {
	return template.replace(
		/\{(\w+)\}/g,
		(all, key: string) => values[key] ?? all,
	);
}

/**
 * `Intl` objects for the texts' language; a `lang` the browser cannot
 * read (a malformed tag throws) uses English rules instead.
 */
function inLanguage<T>(make: (lang: string) => T, lang: string): T {
	try {
		return make(lang);
	} catch {
		return make("en");
	}
}

/** Whether `value` is a plural text: an object of strings with `other`. */
export const isPlural = (value: unknown): value is PluralText =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { other?: unknown }).other === "string" &&
	Object.values(value).every((form) => typeof form === "string");

const warned = new WeakSet<object>();

/**
 * A table with texts but no `lang` is taken as English: its plural forms
 * follow English rules and the dialogs say `lang="en"`. Said once per table
 * in the console, as it is almost always a translation that forgot its tag.
 */
export function warnWithoutLang(strings: object | undefined): void {
	if (strings === undefined || warned.has(strings)) return;
	const texts = Object.entries(strings).filter(
		([key, value]) => key !== "lang" && key !== "dir" && value !== undefined,
	);
	if (texts.length === 0 || typeof (strings as InLanguage).lang === "string")
		return;
	warned.add(strings);
	console.warn(
		"tab-mcp: ui.strings has texts but no lang, so they count as English (plural forms, lists, the dialogs' lang). Add lang, the language tag of the texts.",
	);
}

/**
 * The form of `text` for the count `n`, by the plural rules of the texts'
 * language, with `{n}` filled in; `other` where the table lacks the form.
 */
export function pluralForm(text: PluralText, n: number, s: InLanguage): string {
	const category = inLanguage((l) => new Intl.PluralRules(l), s.lang).select(n);
	return format(text[category] ?? text.other, { n: String(n) });
}

/** `pluralForm` with the other placeholders filled in too, as text. */
export function plural(
	text: PluralText,
	n: number,
	s: InLanguage,
	values: Record<string, string> = {},
): string {
	return format(pluralForm(text, n, s), values);
}

/** How the texts' language joins a list ("A, B and C"). */
export function listFormat(s: InLanguage): Intl.ListFormat {
	return inLanguage(
		(l) => new Intl.ListFormat(l, { type: "conjunction" }),
		s.lang,
	);
}

/** "A and B", "A, B and C", as the texts' language joins a list. */
export function listOf(items: string[], s: InLanguage): string {
	return listFormat(s).format(items);
}

/**
 * The direction of the texts: their own `dir`, else the one the browser
 * knows for `lang` (`Intl.Locale`'s text info, not in every browser), else
 * left to right.
 */
export function directionOf(s: DialogStrings): "ltr" | "rtl" {
	if (s.dir !== undefined) return s.dir;
	try {
		const locale = new Intl.Locale(s.lang) as Intl.Locale & {
			getTextInfo?: () => { direction?: string };
			textInfo?: { direction?: string };
		};
		const info = locale.getTextInfo?.() ?? locale.textInfo;
		return info?.direction === "rtl" ? "rtl" : "ltr";
	} catch {
		return "ltr";
	}
}
