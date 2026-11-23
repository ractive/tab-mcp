/**
 * A page that uses the client library with its default, the WebMCP mirror
 * on (DEC-207, no `webmcp` option), for the
 * extension's end-to-end test of the handshake: one tool that asks, an
 * `onConfirm` that allows every call and records whom it was asked about
 * (the library asks a WebMCP call only through it, DEC-215; a call the
 * extension vouched for never reaches it), no relay of its own; and one
 * read-only tool that answers with a picture of 300 KiB (DEC-224), as
 * saturnus's `read_display` does. Bundled by the test and served as
 * `/library.js` next to `library.html`.
 */

import {
	TabMcp,
	type ToolCallClient,
	type ToolCallStart,
} from "@ractive-ch/tab-mcp-client";

/** Whom `onConfirm` was asked about. */
const asked: ToolCallClient[] = [];
const mcp = new TabMcp({
	server: { name: "Todos", version: "1.0.0" },
	onConfirm: (request) => {
		asked.push(request.client);
		return true;
	},
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
	// Offered to agents in the browser too, which the page does not ask (DEC-215).
	{ callers: ["relay", "webmcp"] },
);

/**
 * 300 KiB that start as a PNG does, then bytes of a fixed pseudo-random
 * sequence (no compression could shrink them), as base64: 409,600
 * characters, under the extension's 640 KiB of images per result.
 */
function pictureData(): string {
	const bytes = new Uint8Array(300 * 1024);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	let x = 0x2545f491;
	for (let i = 8; i < bytes.length; i++) {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		bytes[i] = x & 0xff;
	}
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}
const picture = pictureData();
void mcp.registerTool(
	{
		name: "snapshot",
		title: "The page as a picture",
		description: "A picture of the page, as PNG.",
		annotations: { readOnlyHint: true },
		execute: () => ({
			content: [
				{ type: "text", text: "The page:" },
				{ type: "image", data: picture, mimeType: "image/png" },
			],
		}),
	},
	{ callers: ["relay", "webmcp"] },
);
const shown = document.getElementById("extension") as HTMLElement;
mcp.addEventListener("extensionchange", () => {
	shown.textContent = JSON.stringify(mcp.extension ?? null);
});
Object.assign(window, { tabMcpPage: { mcp, calls, done, asked, picture } });
