/**
 * A page that uses the client library with `webmcp: true` (DEC-207), for the
 * extension's end-to-end test of the handshake: one tool that asks, the
 * library's own confirmation, no relay of its own. Bundled by the test and
 * served as `/library.js` next to `library.html`.
 */

import { TabMcp, type ToolCallStart } from "@ractive-ch/tab-mcp-client";

const mcp = new TabMcp({
	server: { name: "Todos", version: "1.0.0" },
	webmcp: true,
});
const calls: ToolCallStart[] = [];
const done: number[] = [];
mcp.addEventListener("toolcall", (event) => calls.push(event.detail));
void mcp.registerTool(
	{
		name: "complete_todo",
		title: "Complete a todo",
		description: "Marks a todo as done.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "number" } },
			required: ["id"],
		},
		annotations: { consequentialHint: true },
		execute: ({ id }) => {
			done.push(Number(id));
			return `Todo ${id} is done.`;
		},
	},
	// Offered to agents in the browser too, where the page asks itself.
	{ callers: ["relay", "webmcp"] },
);
const shown = document.getElementById("extension") as HTMLElement;
mcp.addEventListener("extensionchange", () => {
	shown.textContent = JSON.stringify(mcp.extension ?? null);
});
Object.assign(window, { tabMcpPage: { mcp, calls, done } });
