import { version } from "../../package.json" with { type: "json" };

/**
 * Server-rendered HTML for `/authorize` (threat model A7): every value is
 * escaped, the page has no scripts, and its headers forbid framing, inline
 * code and foreign form targets.
 */

/**
 * The stylesheet's URL. The version in the query keeps a cached sheet from
 * an older relay away from newer pages; routes match the path only.
 */
export const STYLESHEET: string = `/authorize.css?v=${version}`;

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * The stylesheet at `/authorize.css` (`style-src 'self'`). The rules under
 * `.home` are for the relay's front page only.
 */
export const AUTHORIZE_CSS = `:root { color-scheme: light dark; --accent: #1d4ed8; --error: #b91c1c; }
@media (prefers-color-scheme: dark) { :root { --accent: #93b4ff; --error: #fca5a5; } }
* { box-sizing: border-box; }
body { margin: 0; font: 1rem/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
main { max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 1rem; }
p { margin: 0 0 1rem; }
code, .origin { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.help { color: GrayText; font-size: 0.9rem; }
.error { color: var(--error); font-weight: 600; }
label { display: block; font-weight: 600; margin-bottom: 0.25rem; }
input[type="text"] { font: 1.5rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.2em; width: 10ch; padding: 0.4rem 0.5rem; border: 2px solid GrayText; border-radius: 0.4rem; background: Field; color: FieldText; }
input[type="text"]:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.actions { display: flex; gap: 0.75rem; flex-wrap: wrap; margin: 1.5rem 0 1.25rem; }
button, .button { font: inherit; padding: 0.5rem 1.25rem; border-radius: 0.4rem; border: 2px solid var(--accent); cursor: pointer; text-decoration: none; display: inline-block; }
button.primary, .button.primary { background: var(--accent); color: Canvas; }
button.secondary, .button:not(.primary) { background: transparent; color: var(--accent); }
footer { margin-top: 2.5rem; font-size: 0.85rem; color: GrayText; }
.home a { color: var(--accent); }
.home .brand { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
.home .brand img { border-radius: 12px; }
.home .brand h1, .home .brand p { margin: 0; }
.home .lead { font-size: 1.15rem; }
.home .flow { display: flex; align-items: center; margin: 2rem 0; font-size: 0.95rem; }
.home .node { flex: none; padding: 0.5rem 0.8rem; border: 2px solid GrayText; border-radius: 0.5rem; font-weight: 600; }
.home .node.relay { background: var(--accent); border-color: var(--accent); color: Canvas; }
.home .link { flex: 1; min-width: 4.5rem; position: relative; padding: 0 0.6rem 1.6rem; text-align: center; font-size: 0.8rem; line-height: 1.5; color: GrayText; }
.home .link::before { content: ""; position: absolute; left: 0.4rem; right: 0.5rem; top: calc(50% - 1px); border-top: 2px solid GrayText; }
.home .link::after { content: ""; position: absolute; right: 0.35rem; top: calc(50% - 5px); border: 5px solid transparent; border-left: 8px solid GrayText; border-right: 0; }
@media (max-width: 30rem) {
  .home .flow { flex-direction: column; align-items: flex-start; }
  .home .link { min-width: 0; margin-left: 1rem; padding: 0.6rem 0 0.75rem 1.25rem; text-align: left; }
  .home .link::before { left: 0; right: auto; top: 0.2rem; bottom: 0.6rem; border-top: 0; border-left: 2px solid GrayText; }
  .home .link::after { left: -4px; right: auto; top: auto; bottom: 0.2rem; border: 5px solid transparent; border-top: 8px solid GrayText; border-bottom: 0; }
}
`;

/** Security headers of every `/authorize` response. */
export function pageHeaders(formTargets: readonly string[] = []): Headers {
	// Chrome applies form-action to the redirect after a POST, so the client's
	// redirect origin must be allowed explicitly.
	const formAction = ["'self'", ...formTargets].join(" ");
	return new Headers({
		"content-type": "text/html; charset=utf-8",
		"content-security-policy": `default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action ${formAction}`,
		"x-frame-options": "DENY",
		"x-content-type-options": "nosniff",
		// Not no-referrer: browsers then send `Origin: null` on the form post,
		// which the origin check must refuse. same-origin still sends nothing
		// to the client's redirect.
		"referrer-policy": "same-origin",
		"cache-control": "no-store",
	});
}

/** A complete page; `body` must already be escaped. */
export function renderPage(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${STYLESHEET}">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
</head>
<body>
<main>
${body}
<footer>tab-mcp relay. It passes requests between AI apps and web pages and does not store their contents.</footer>
</main>
</body>
</html>`;
}
