/**
 * Pictures through the extension (DEC-224), on `pages/library.ts`, the same
 * checks in Chrome (its own WebMCP and the extension's) and in Firefox: the
 * AI app gets the read-only tool's picture whole, a script in the page that
 * calls the tool through WebMCP gets the text with the "left out" line.
 */

import { expect } from "bun:test";

/** What a WebMCP caller the extension did not announce gets (DEC-143). */
export const PICTURE_TEXT =
	"The page:\n[image content left out: WebMCP results are text.]";

interface Result {
	isError?: boolean;
	content: { type: string; text?: string; data?: string; mimeType?: string }[];
}

/**
 * `snapshot` through the extension: the AI app (`app`) gets the text and the
 * page's image block with the same bytes, and the page names the AI app;
 * then a script in the page calls it through `document.modelContext`, with
 * no claim: the text as before, no AI app named.
 */
export async function picturesThroughTheExtension(
	callSnapshot: () => Promise<Result>,
	evalInPage: (expression: string) => Promise<unknown>,
	app: { name: string; host: string },
): Promise<void> {
	const picture = (await evalInPage("window.tabMcpPage.picture")) as string;
	expect(picture.length).toBe(409_600);
	const result = await callSnapshot();
	expect(result.isError).toBeFalsy();
	expect(result.content).toEqual([
		{ type: "text", text: "The page:" },
		{ type: "image", data: picture, mimeType: "image/png" },
	]);
	expect(await evalInPage("window.tabMcpPage.calls.at(-1)")).toMatchObject({
		tool: "snapshot",
		client: {
			kind: "webmcp",
			via: "tab-mcp-extension",
			...app,
			allowed: false,
		},
	});
	const own = (await evalInPage(`(async () => {
		const context = document.modelContext;
		const tool = (await context.getTools()).find((t) => t.name === "snapshot");
		return await context.executeTool(tool, {});
	})()`)) as string;
	// The draft serializes every result as JSON; Chrome 156 passes a string on.
	expect(own.startsWith('"') ? JSON.parse(own) : own).toBe(PICTURE_TEXT);
	expect(await evalInPage("window.tabMcpPage.calls.at(-1)")).toMatchObject({
		tool: "snapshot",
		client: { kind: "webmcp" },
	});
	expect(
		await evalInPage("window.tabMcpPage.calls.at(-1).client.via ?? null"),
	).toBeNull();
}
