/**
 * What the side panel and the content script say to each other.
 */

/** The content script's file in the build, for `chrome.scripting`. */
export const CONTENT_SCRIPT = "content.js";

/** Its id for `chrome.scripting.registerContentScripts` (with host access). */
export const CONTENT_SCRIPT_ID = "tab-mcp-page";

export type ContentRequest = { type: "page-info" };

/** The page in a tab, as the content script sees it. */
export interface PageInfo {
	url: string;
	title: string;
	/** The page's `lang`, if it has one. */
	language?: string;
	webmcp: {
		/**
		 * `document.modelContext` is there: the page takes part in Chrome's
		 * origin trial, or the user turned on the flag (then it is there on
		 * every page).
		 */
		available: boolean;
		/** How many tools the page registered (`getTools().length`). */
		tools: number;
		/** Why the tools could not be counted, if they could not. */
		error?: string;
	};
}

export type ContentResponse =
	| ({ ok: true } & PageInfo)
	| { ok: false; error: string };
