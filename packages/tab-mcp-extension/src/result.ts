/**
 * What the AI app gets for a page tool's answer, within the extension's
 * budgets: the worker's `resultOf` (`worker/bridge.ts`), and the content
 * script's `shrunk` for an MCP result too long to send to the worker at all
 * (DEC-224). Pure, so that both use the very same rules.
 */

/** A result's text, all blocks together, is cut to this many characters. */
export const MAX_RESULT = 100_000;
/** At most this many content blocks. */
export const MAX_BLOCKS = 32;
/**
 * The image data of one result, all images together (base64 characters).
 * With the text above, a result stays under the relay's default limit of
 * 1 MiB per response; an image beyond it is left out with a note.
 */
export const MAX_IMAGES_BASE64 = 640 * 1024;

const cut = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

/** An MCP content block a page result may carry through. */
type Block =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

/** A block on its way: the page's text (cut later), a note of the extension's, an image. */
type Item =
	| { type: "text"; text: string; note?: true }
	| { type: "image"; data: string; mimeType: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** The image types passed on: those every AI app shows. */
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/;
const CARRIED =
	"the tab-mcp browser extension passes on text and PNG, JPEG, GIF and WebP images.";

/**
 * Whether `item` is an MCP content block with the fields its type requires,
 * as the client library's `isContentBlock` checks it: `text`; `image` and
 * `audio`; `resource_link`; `resource`. Anything else makes the value data
 * that only has a `content` key (a ProseMirror document), not an MCP result.
 */
function isBlock(item: unknown): item is Record<string, unknown> {
	if (!isObject(item)) return false;
	switch (item["type"]) {
		case "text":
			return isString(item["text"]);
		case "image":
		case "audio":
			return isString(item["data"]) && isString(item["mimeType"]);
		case "resource_link":
			return isString(item["uri"]) && isString(item["name"]);
		case "resource":
			return isObject(item["resource"]) && isString(item["resource"]["uri"]);
		default:
			return false;
	}
}

const note = (text: string): Item => ({ type: "text", text, note: true });

/**
 * The MCP result the AI app gets for `value`, within the budget; `undefined`
 * if `value` is no MCP result. Text blocks pass, and the text of an embedded
 * text resource as a text block after its uri; images (`IMAGE_TYPE`, base64)
 * up to `MAX_IMAGES_BASE64` together; `isError`; `structuredContent` (an
 * object) where its JSON fits in what the text left of `MAX_RESULT`. Each
 * thing left out is a line that says so: an image beyond the budget, of
 * another type, or not base64; audio, a resource link, a binary resource;
 * the blocks past `MAX_BLOCKS` (one line; past 31 with `structuredContent`,
 * whose note may need the last); `structuredContent` that does not fit. The
 * notes count against `MAX_RESULT` first and the page's text is cut to what
 * they leave, so that the result of this, given to it again, comes back
 * unchanged (the content script's `shrunk`, then the worker).
 */
export function mcpResult(value: unknown): Record<string, unknown> | undefined {
	if (!isObject(value) || !Array.isArray(value["content"])) return undefined;
	const blocks: unknown[] = value["content"];
	if (!blocks.every(isBlock)) return undefined;
	const structured = isObject(value["structuredContent"])
		? value["structuredContent"]
		: undefined;
	// With `structuredContent` one block less: its note may need the last.
	const most = structured === undefined ? MAX_BLOCKS : MAX_BLOCKS - 1;
	const items: Item[] = [];
	let images = MAX_IMAGES_BASE64;
	for (const [i, block] of (blocks as Record<string, unknown>[]).entries()) {
		if (i === most - 1 && blocks.length > most) {
			items.push(
				note(
					`[${blocks.length - i} more content blocks left out: the tab-mcp browser extension passes on ${MAX_BLOCKS} blocks of a result.]`,
				),
			);
			break;
		}
		const { type, text, data, mimeType, resource } = block;
		if (type === "text" && isString(text)) items.push({ type: "text", text });
		else if (
			type === "resource" &&
			isObject(resource) &&
			isString(resource["text"])
		)
			items.push({
				type: "text",
				text: `${String(resource["uri"])}\n${resource["text"]}`,
			});
		else if (
			type === "image" &&
			isString(data) &&
			isString(mimeType) &&
			IMAGE_TYPE.test(mimeType)
		) {
			if (!BASE64.test(data))
				items.push(
					note(
						`[An image (${mimeType}) was left out: its data is not base64.]`,
					),
				);
			else if (data.length > images)
				items.push(
					note(
						`[An image of ${Math.ceil(data.length / 1024)} KiB (base64) was left out: the images of one result may have ${MAX_IMAGES_BASE64 / 1024} KiB together.]`,
					),
				);
			else {
				images -= data.length;
				items.push({ type: "image", data, mimeType });
			}
		} else
			items.push(
				note(
					`[${type === "image" ? `An image (${cut(String(mimeType), 50)})` : `${String(type)} content`} was left out: ${CARRIED}]`,
				),
			);
	}
	const length = (keep: (item: Item) => boolean) =>
		items.reduce(
			(n, item) =>
				n + (item.type === "text" && keep(item) ? item.text.length : 0),
			0,
		);
	// What the page's text may use: what the notes leave.
	let room = MAX_RESULT - length((item) => "note" in item);
	const text = length((item) => !("note" in item));
	let keepStructured = false;
	if (structured !== undefined) {
		const json = JSON.stringify(structured).length;
		keepStructured = json <= room - Math.min(text, room);
		if (!keepStructured) {
			const dropped = note(
				`[structuredContent of ${json} characters was left out: with the text it is over the ${MAX_RESULT} characters the tab-mcp browser extension passes on.]`,
			);
			items.push(dropped);
			room -= (dropped as { text: string }).text.length;
		}
	}
	const content: Block[] = [];
	for (const item of items) {
		if (item.type === "image") content.push(item);
		else if ("note" in item) content.push({ type: "text", text: item.text });
		else if (room > 0) {
			const kept = cut(item.text, room);
			room -= kept.length;
			content.push({ type: "text", text: kept });
		}
	}
	return {
		content,
		...(keepStructured ? { structuredContent: structured } : {}),
		...(value["isError"] === true ? { isError: true } : {}),
	};
}

/**
 * For the content script: `value` (what `executeTool()` returned), too long to
 * send, as the JSON of `mcpResult` if it is the JSON of an MCP result (a
 * picture of several MiB, say), which then fits; `undefined` otherwise. The
 * worker's `resultOf` gives the AI app the same as it would have for `value`.
 */
export function shrunk(value: string): string | undefined {
	if (!value.startsWith("{")) return undefined;
	try {
		const result = mcpResult(JSON.parse(value));
		return result === undefined ? undefined : JSON.stringify(result);
	} catch {
		return undefined;
	}
}

/**
 * What `executeTool()` returned, as the tool's result: a string as one text
 * block; the JSON of an MCP result (`{"content": [...]}`, what
 * `@mcp-b/global` pages return, and what the client library gives a call
 * the extension announced, DEC-224) as `mcpResult` makes it; the JSON of
 * another object without a `content` key, within `MAX_RESULT`, as that
 * object, which the library sends as text and as `structuredContent` (WM 8);
 * a JSON-encoded string as that string: the draft serializes every result as
 * JSON, Chrome 156 passes a string on as it is (WM 7). (`null`, the tool
 * navigated, is answered with the new page.)
 */
export function resultOf(value: string): unknown {
	if (value.startsWith("{") || value.startsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(value);
			if (typeof parsed === "string") return cut(parsed, MAX_RESULT);
			const result = mcpResult(parsed);
			if (result !== undefined) return result;
			// Not with a `content` key: the library would take it for an MCP
			// result past the budget above.
			if (
				isObject(parsed) &&
				!Object.hasOwn(parsed, "content") &&
				value.length <= MAX_RESULT
			)
				return parsed;
		} catch {
			// Not JSON: the text as it is.
		}
	}
	return cut(value, MAX_RESULT);
}
