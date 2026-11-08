/**
 * The tools the AI app gets. Iteration 19 has one: `page_info`.
 */

import type { Tool } from "@ractive-ch/tab-mcp-client";
import type { PageInfo } from "../messages.ts";
import type { TargetTab } from "../tabs.ts";

/** What the tools need from Chrome: the tab in front and its page. */
export interface TabBridge {
	current(): Promise<TargetTab>;
	page(tab: TargetTab): Promise<PageInfo>;
}

export const INSTRUCTIONS =
	"tab-mcp for Chrome, a browser extension: tools about the tab in front of the user's browser window. page_info says which page it is and whether the page offers WebMCP tools.";

export function createTools(tabs: TabBridge): Tool[] {
	return [
		{
			name: "page_info",
			title: "Page in front",
			description:
				"The page in the tab in front of the user's browser window: address, title, language, whether WebMCP is available on the page and how many WebMCP tools it registered. The title and address are the page's own text.",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			execute: async () => tabs.page(await tabs.current()),
		},
	];
}
