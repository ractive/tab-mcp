/**
 * Text an AI app or a page wrote, made safe to show to the user before they
 * approve something: characters that are invisible, blank or turn the text's
 * direction are written as escapes, so the text cannot look like something
 * else. Shared by the library's confirmation dialog and tab-mcp for Chrome.
 */

/**
 * Characters that are invisible, blank or change the direction of the text
 * around them: controls (C0 and C1, but tab and line feed, which are only
 * JSON's layout), format characters (bidi controls and isolates, zero-width
 * ones, tags), the other default-ignorable ones (variation selectors, U+034F,
 * the Hangul fillers), private-use, unassigned and lone surrogate code
 * points, line and paragraph separators, every space but the plain one
 * (U+00A0, U+2007, U+3000…) and the Braille blank (U+2800).
 */
const INVISIBLE =
	/(?![\t\n ])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Zs}\u{2800}]/gu;

/**
 * `text` with each such character as `\uXXXX` (a surrogate pair for one
 * beyond U+FFFF), as JSON would write it: JSON stays JSON for the same value.
 */
export function escapeInvisible(text: string): string {
	return text.replace(INVISIBLE, (ch) => {
		let escaped = "";
		for (let i = 0; i < ch.length; i++)
			escaped += `\\u${ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
		return escaped;
	});
}
