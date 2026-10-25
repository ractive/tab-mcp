/**
 * The page's icons for `serverInfo.icons` (MCP `Icon`): the AI app may show
 * them for this page's connector. Loaded with the connection, not the core.
 */

import type { Icon } from "./types.ts";

/** At most this many icons; a URL up to 2 KiB, a `data:` URI up to 16 KiB. */
const MAX_ICONS = 8;
const MAX_URL = 2048;
const MAX_DATA = 16_384;
const SIZE = /^(?:\d{1,4}x\d{1,4}|any)$/;

/**
 * An icon worth sending, with clean fields: an http(s) URL (rendering an SVG
 * safely is the AI app's job, as MCP says), or a raster `data:` URI; never
 * an inline SVG, which the app might put into its own page.
 */
function clean(icon: Icon): Icon | undefined {
	const { src, mimeType, sizes, theme } = icon;
	if (typeof src !== "string") return undefined;
	const url = /^https?:/i.test(src) && src.length <= MAX_URL;
	const data =
		/^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon)[;,]/i.test(
			src,
		) && src.length <= MAX_DATA;
	if (!url && !data) return undefined;
	const out: Icon = { src };
	if (typeof mimeType === "string" && /^image\/[\w.+-]+$/i.test(mimeType)) {
		out.mimeType = mimeType.toLowerCase();
	}
	const valid = Array.isArray(sizes)
		? sizes.map((s) => String(s).toLowerCase()).filter((s) => SIZE.test(s))
		: [];
	if (valid.length > 0) out.sizes = valid;
	if (theme === "light" || theme === "dark") out.theme = theme;
	return out;
}

/** Icons as given (`server.icons`), cleaned and capped. */
export function cleanIcons(icons: readonly Icon[]): Icon[] {
	const out: Icon[] = [];
	for (const icon of icons) {
		const c =
			typeof icon === "object" && icon !== null ? clean(icon) : undefined;
		if (c !== undefined) out.push(c);
		if (out.length === MAX_ICONS) break;
	}
	return out;
}

/**
 * The document's `<link rel="icon">` and `<link rel="apple-touch-icon">`,
 * with their `type`, `sizes` and a `prefers-color-scheme` media query as the
 * theme. Empty without a document.
 */
export function pageIcons(
	doc: Document | undefined = globalThis.document,
): Icon[] {
	// Icons are optional: whatever the document is, connecting goes on.
	try {
		const links = doc?.querySelectorAll<HTMLLinkElement>(
			'link[rel~="icon" i], link[rel~="apple-touch-icon" i]',
		);
		return cleanIcons(
			// An empty href resolves to the page itself: no icon.
			[...(links ?? [])]
				.filter((link) => link.getAttribute("href")?.trim())
				.map((link) => {
					const icon: Icon = { src: link.href };
					if (link.type) icon.mimeType = link.type;
					const sizes = link.getAttribute("sizes");
					if (sizes) icon.sizes = sizes.trim().split(/\s+/);
					const scheme = /prefers-color-scheme:\s*(light|dark)/i.exec(
						link.media,
					);
					if (scheme) icon.theme = scheme[1]?.toLowerCase() as "light" | "dark";
					return icon;
				}),
		);
	} catch {
		return [];
	}
}
