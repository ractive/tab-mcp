/**
 * What the connection (in the service worker) and the content script say to
 * each other.
 */

/** The content script's file in the build, for `chrome.scripting`. */
export const CONTENT_SCRIPT = "content.js";

/** Its id for `chrome.scripting.registerContentScripts` (with host access). */
export const CONTENT_SCRIPT_ID = "tab-mcp-page";

export type ContentRequest =
	| { type: "page-info" }
	| { type: "webmcp-list" }
	| {
			type: "webmcp-call";
			callId: string;
			/** The page the tool was listed from: a call never reaches another. */
			documentId: string;
			name: string;
			/** The read-only claim the tool was offered with. */
			readOnly: boolean;
			input: unknown;
	  }
	| { type: "webmcp-cancel"; callId: string }
	| { type: "history" };

/**
 * The tab's history as the page can see it: the Navigation API lists only
 * the entries of the page's own origin (HTML: the contiguous same-origin
 * entries of the top frame), so `back` and `forward` are there only when
 * that entry is on the page's origin.
 */
export interface PageHistory {
	/** `history.length`: every entry of the tab, of any origin. */
	length: number;
	/** The previous entry, if it is on the page's origin (`url` may be hidden). */
	back?: { url: string | null };
	/** The next entry, if it is on the page's origin. */
	forward?: { url: string | null };
}

/** From the content script: the page's tools changed (`toolchange`). */
export type ContentEvent = { type: "webmcp-changed" };

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

/** A tool the page registered, as `getTools()` gives it (Chrome 156: no `outputSchema`). */
export interface PageTool {
	name: string;
	/** Its schema was too big to send (over 16 KB as JSON). */
	schemaTooBig?: true;
	title?: string;
	description: string;
	inputSchema?: unknown;
	annotations?: {
		readOnlyHint?: boolean;
		consequentialHint?: boolean;
		untrustedContentHint?: boolean;
	};
}

/** The page's WebMCP tools. */
export interface PageTools {
	url: string;
	origin: string;
	/** This page's id (one per content script, so per document). */
	documentId: string;
	/** Tools beyond the content script's cap, not listed. */
	more: number;
	/** `document.modelContext` is there. */
	available: boolean;
	tools: PageTool[];
	/**
	 * Tools left out: those a tab-mcp page mirrors into WebMCP (listed in
	 * `<html data-tab-mcp-webmcp>`), which an AI app gets from the page itself.
	 */
	mirrored: string[];
	/** Why the tools could not be listed, if they could not. */
	error?: string;
}

/** The answer to a call: what `executeTool()` returned (`null`: the tool navigated). */
export type CallResult =
	| { ok: true; value: string | null }
	| { ok: false; error: string; gone?: true };

export type ContentResponse =
	| ({ ok: true } & PageInfo)
	| ({ ok: true } & PageTools)
	| ({ ok: true } & PageHistory)
	| CallResult
	| { ok: false; error: string };
