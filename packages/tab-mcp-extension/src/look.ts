/**
 * The colours the extension sets outside its style sheet (DEC-160): the
 * badge on the toolbar icon. Chrome draws it on its own toolbar, in either
 * scheme, so they are fixed: the light values of the panel's tokens
 * (`sidepanel/style.css`), with white text. test/contrast.test.ts holds the
 * text on each to 4.5:1 and each to its token.
 */
export const BADGE_LOOK = {
	/** The badge's text, on every background. */
	text: "#ffffff",
	/** A tool asks ("?"): the waiting dot's edge, `--accent-edge`. */
	question: "#a06c00",
	/** AI access is on ("on"): `--ok`. */
	on: "#166d2d",
	/** Connecting or retrying ("…"), or nothing to say: `--ink-2`. */
	idle: "#535c6e",
} as const;
