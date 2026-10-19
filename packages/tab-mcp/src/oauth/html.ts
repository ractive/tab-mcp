/**
 * Server-rendered HTML for `/authorize` (threat model A7): every value is
 * escaped, the page has no scripts, and its headers forbid framing, inline
 * code and foreign form targets.
 */

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

/** The stylesheet at `/authorize.css` (`style-src 'self'`). */
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
.actions { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 1.5rem; }
button, .button { font: inherit; padding: 0.5rem 1.25rem; border-radius: 0.4rem; border: 2px solid var(--accent); cursor: pointer; text-decoration: none; display: inline-block; }
button.primary { background: var(--accent); color: Canvas; }
button.secondary, .button { background: transparent; color: var(--accent); }
footer { margin-top: 2.5rem; font-size: 0.85rem; color: GrayText; }
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
		"referrer-policy": "no-referrer",
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
<link rel="stylesheet" href="/authorize.css">
</head>
<body>
<main>
${body}
<footer>tab-mcp relay. It passes requests between AI tools and web pages and does not store their contents.</footer>
</main>
</body>
</html>`;
}
