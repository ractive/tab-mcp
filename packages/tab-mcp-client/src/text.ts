/**
 * Filling in the texts of `strings.ts`: placeholders, plural forms and lists,
 * by the rules of the texts' language (`Intl`), not by grammar made by hand.
 * No DOM, so that `./react` can use it as well as the dialogs.
 */

import type { DialogStrings, PluralText } from "./strings.ts";

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

/**
 * The form of `text` for the count `n`, by the plural rules of the texts'
 * language, with `{n}` and `values` filled in; `other` where the table
 * lacks the form.
 */
export function plural(
	text: PluralText,
	n: number,
	s: DialogStrings,
	values: Record<string, string> = {},
): string {
	const category = inLanguage((l) => new Intl.PluralRules(l), s.lang).select(n);
	return format(text[category] ?? text.other, { n: String(n), ...values });
}

/** "A and B", "A, B and C", as the texts' language joins a list. */
export function listOf(items: string[], s: DialogStrings): string {
	return inLanguage(
		(l) => new Intl.ListFormat(l, { type: "conjunction" }),
		s.lang,
	).format(items);
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
