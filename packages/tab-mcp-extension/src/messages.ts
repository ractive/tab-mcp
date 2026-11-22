/**
 * What the connection (in the service worker) and the content script say to
 * each other.
 */

/** The content script's file in the build, for `chrome.scripting`. */
export const CONTENT_SCRIPT = "content.js";

/** Its id for `chrome.scripting.registerContentScripts` (with host access). */
export const CONTENT_SCRIPT_ID = "tab-mcp-page";

/**
 * Chrome's page-world polyfill for pages without Chrome's WebMCP
 * (`chrome/webmcp-main.ts`, iteration 44): its file and registration id.
 */
export const WEBMCP_MAIN_SCRIPT = "webmcp-main.js";
export const WEBMCP_MAIN_ID = "tab-mcp-webmcp-main";

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
			/** The tool as it was offered (`definitionOf`, DEC-217). */
			definition: string;
			input: unknown;
			/**
			 * The user allowed this call (DEC-207): told to a page with the
			 * client library right before the tool runs. Only the bridge's
			 * path after the user's "allow" sets it.
			 */
			vouch?: Vouch;
	  }
	| { type: "webmcp-cancel"; callId: string }
	| { type: "history" }
	/** The extension's state changed: for a page with the library. */
	| { type: "extension-state"; state: ExtensionState };

/** An AI app connected to the extension: its own name and verified host. */
export interface AppView {
	name: string;
	host: string;
}

/** What a vouch says besides the tool and its arguments (DEC-207). */
export interface Vouch {
	/** One per call. */
	nonce: string;
	/** The AI app that made the call. */
	app: AppView;
}

/**
 * The state the worker sends a content script for a page that announced
 * the client library (DEC-207). The content script tells the page only
 * while `on` (DEC-221), and nothing else: not the relay, the address or
 * other tabs.
 */
export interface ExtensionState {
	/** The extension's name. */
	name: string;
	/** AI access is on and connected: the page's tools can be called now. */
	on: boolean;
	/** The AI apps connected now (none while not `on`). */
	apps: AppView[];
	/** It serves the tab in front of a window only. */
	whileInFront: true;
}

/**
 * What a page with the client library announced (DEC-207): the library's
 * version, and the AI apps connected to the page directly, of all its apps
 * together.
 */
export interface PageLibrary {
	version: string;
	apps: AppView[];
}

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

/**
 * From the content script: the page's tools changed (`toolchange`), or
 * what the page with the client library announced; `handshake`: the page
 * announced the library, the worker answers with the `ExtensionState`.
 */
export type ContentEvent = { type: "webmcp-changed" } | { type: "handshake" };

/** The page in a tab, as the content script sees it. */
export interface PageInfo {
	/** The page's address, its query and fragment included. */
	url: string;
	/** The page's title, cut to `MAX_PAGE_TITLE`. */
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
		/**
		 * What to do about a page without WebMCP, in the Firefox build: its
		 * WebMCP comes from tab-mcp as the page loads (iteration 44).
		 */
		note?: string;
	};
}

/**
 * A tool the page registered, as `getTools()` gives it: only what the bridge
 * uses (WM 8). Chrome 156 gives no `outputSchema`; the draft has it (WM 3).
 */
export interface PageTool {
	name: string;
	/** Its input schema was too big to send (over 16 KB as JSON). */
	schemaTooBig?: true;
	title?: string;
	description: string;
	inputSchema?: unknown;
	/** The result's schema, where the browser gives one and it is at most 16 KB. */
	outputSchema?: unknown;
	annotations?: {
		readOnlyHint?: boolean;
		/** WebMCP's hint for tools meant for developers: not offered (WM 8). */
		debugging?: boolean;
		/**
		 * The page's own; missing when the page gave no annotations (Chrome
		 * then lists none) or no boolean: nothing is known (DEC-214).
		 */
		consequentialHint?: boolean;
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
	/** Why the tools could not be listed, if they could not. */
	error?: string;
	/** The page announced the client library (DEC-207). */
	library?: PageLibrary;
}

/**
 * The answer to a call: what `executeTool()` returned (`null`: the tool
 * navigated), or why there is none. `gone`: the tool did not run (the page
 * changed before, or it has no such tool any more). `navigated`: the page
 * went away while the tool ran (a tool that navigates), so it may have done
 * its work.
 */
export type CallResult =
	| { ok: true; value: string | null }
	| { ok: false; error: string; gone?: true; navigated?: true };

export type ContentResponse =
	| ({ ok: true } & PageInfo)
	| ({ ok: true } & PageTools)
	| ({ ok: true } & PageHistory)
	| CallResult
	| { ok: false; error: string };
