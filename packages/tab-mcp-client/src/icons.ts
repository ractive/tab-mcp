/**
 * The page's icons for `serverInfo.icons` (MCP `Icon`): the AI app may show
 * them for this page's connector. Loaded with the connection, not the core.
 */

import type { Icon } from "./types.ts";

/** At most this many icons, each `src` at most this long (a `data:` URI too). */
const MAX_ICONS = 8;
const MAX_SRC = 65_536;
const SIZE = /^(?:\d{1,4}x\d{1,4}|any)$/;

/** An icon worth sending: an http(s) URL or a `data:image/` URI, with clean fields. */
function clean(icon: Icon): Icon | undefined {
	const { src, mimeType, sizes, theme } = icon;
	if (typeof src !== "string" || src.length > MAX_SRC) return undefined;
	if (!/^(?:https?:|data:image\/)/i.test(src)) return undefined;
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
			[...(links ?? [])].map((link) => {
				const icon: Icon = { src: link.href };
				if (link.type) icon.mimeType = link.type;
				const sizes = link.getAttribute("sizes");
				if (sizes) icon.sizes = sizes.trim().split(/\s+/);
				const scheme = /prefers-color-scheme:\s*(light|dark)/i.exec(link.media);
				if (scheme) icon.theme = scheme[1]?.toLowerCase() as "light" | "dark";
				return icon;
			}),
		);
	} catch {
		return [];
	}
}
