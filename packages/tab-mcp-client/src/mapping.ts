/**
 * WebMCP → MCP mapping of annotations (DEC-022) and results (DEC-023).
 */

import type { ToolAnnotations } from "./types.ts";

/** `_meta` key that keeps the original WebMCP hints. */
export const ANNOTATIONS_META_KEY = "ch.ractive.tab-mcp/annotations";

const WEBMCP_HINTS = [
	"readOnlyHint",
	"untrustedContentHint",
	"consequentialHint",
	"debugging",
] as const;
const MCP_ONLY_HINTS = [
	"destructiveHint",
	"idempotentHint",
	"openWorldHint",
] as const;

export interface McpToolAnnotations {
	annotations?: Record<string, boolean>;
	meta?: Record<string, boolean>;
}

/** MCP annotations plus the WebMCP originals for `_meta`. */
export function mapAnnotations(hints: ToolAnnotations): McpToolAnnotations {
	const annotations: Record<string, boolean> = {};
	if (hints.readOnlyHint === true) {
		annotations["readOnlyHint"] = true;
		annotations["destructiveHint"] = false;
	} else if (hints.readOnlyHint === false) {
		annotations["readOnlyHint"] = false;
	}
	if (hints.consequentialHint === true) annotations["destructiveHint"] = true;
	if (hints.untrustedContentHint === true) annotations["openWorldHint"] = true;
	for (const key of MCP_ONLY_HINTS) {
		const value = hints[key];
		if (value !== undefined) annotations[key] = value; // MCP hints win
	}
	const meta: Record<string, boolean> = {};
	for (const key of WEBMCP_HINTS) {
		const value = hints[key];
		if (value !== undefined) meta[key] = value;
	}
	const out: McpToolAnnotations = {};
	if (Object.keys(annotations).length > 0) out.annotations = annotations;
	if (Object.keys(meta).length > 0) out.meta = meta;
	return out;
}

export interface CallToolResult {
	content: unknown[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	_meta?: Record<string, unknown>;
	[key: string]: unknown;
}

export function errorResult(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isString = (v: unknown): v is string => typeof v === "string";

/**
 * Whether `block` is an MCP 2026-07-28 content block with the fields its
 * type requires: `text` a string `text`; `image` and `audio` string `data`
 * and `mimeType`; `resource_link` string `uri` and `name`; `resource` a
 * `resource` object with a string `uri`.
 */
function isContentBlock(block: unknown): boolean {
	if (!isObject(block)) return false;
	switch (block["type"]) {
		case "text":
			return isString(block["text"]);
		case "image":
		case "audio":
			return isString(block["data"]) && isString(block["mimeType"]);
		case "resource_link":
			return isString(block["uri"]) && isString(block["name"]);
		case "resource":
			return isObject(block["resource"]) && isString(block["resource"]["uri"]);
		default:
			return false;
	}
}

/** The keys of a `CallToolResult` (`resultType` is set by the server). */
const RESULT_KEYS = new Set([
	"content",
	"structuredContent",
	"isError",
	"_meta",
	"resultType",
]);

/**
 * Whether `value` is an MCP `CallToolResult`: an object whose `content` is an
 * array of MCP content blocks (`isContentBlock`), with `isError` a boolean
 * and `structuredContent` and `_meta` objects where present. Domain data
 * that happens to have a `content` array (a ProseMirror document,
 * `{ title, content: ["…"] }`, a chat message with its own blocks) is not
 * one (CC 3). Other keys are allowed next to blocks, as MCP allows them on a
 * result; with an empty `content` they are not, so that `{ title, content:
 * [] }` is data, not an empty result.
 */
export function isCallToolResult(value: unknown): value is CallToolResult {
	if (!isObject(value) || !Array.isArray(value["content"])) return false;
	const { content, isError, structuredContent, _meta } = value;
	return (
		(content.length > 0
			? content.every(isContentBlock)
			: Object.keys(value).every((key) => RESULT_KEYS.has(key))) &&
		(isError === undefined || typeof isError === "boolean") &&
		(structuredContent === undefined || isObject(structuredContent)) &&
		(_meta === undefined || isObject(_meta))
	);
}

/**
 * What `execute` returned → a `CallToolResult`: a string is one text block; a
 * `CallToolResult` (`isCallToolResult`) passes through; `undefined` is an
 * empty result; any other JSON value is a text block with its JSON, plus
 * that JSON as `structuredContent` when it is an object (so a `Date` or a
 * `URL`, whose JSON is a string, has none).
 */
export function toCallToolResult(value: unknown): CallToolResult {
	if (typeof value === "string")
		return { content: [{ type: "text", text: value }] };
	if (value === undefined) return { content: [] };
	if (isCallToolResult(value)) return value;
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		// cyclic or BigInt
	}
	if (text === undefined)
		return errorResult("The tool returned a value that is not JSON.");
	const result: CallToolResult = { content: [{ type: "text", text }] };
	// What the text says, not the value: `toJSON` applied, no class instances.
	const parsed: unknown = JSON.parse(text);
	if (isObject(parsed)) result.structuredContent = parsed;
	return result;
}

/**
 * The text blocks of a result, one per line. With `noted`, each other block
 * (an image, a resource) is a line that says it was left out, naming its type.
 */
export function resultText(result: CallToolResult, noted = false): string {
	return result.content
		.map((block) =>
			isObject(block) &&
			block["type"] === "text" &&
			typeof block["text"] === "string"
				? block["text"]
				: noted
					? `[${isObject(block) ? String(block["type"]) : "A"} content left out: WebMCP results are text.]`
					: "",
		)
		.filter((text) => text !== "")
		.join("\n");
}

/**
 * What a WebMCP caller gets for what `execute` returned (WM 4, WM 6): an MCP
 * result as its `structuredContent` if it has one, else as its text
 * (`resultText`, other blocks noted); `undefined` (which a browser cannot
 * serialize as JSON, so the call would fail) and an empty MCP result as
 * "Done."; any other value as it is.
 */
export function webMcpValue(value: unknown): unknown {
	if (isCallToolResult(value))
		return value.structuredContent ?? (resultText(value, true) || "Done.");
	return value === undefined ? "Done." : value;
}

/** A thrown value → an `isError` result with its message. */
export function thrownResult(error: unknown): CallToolResult {
	const message = error instanceof Error ? error.message : String(error);
	return errorResult(message || "The tool failed.");
}
