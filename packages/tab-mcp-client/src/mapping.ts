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

/** The content block types of MCP 2026-07-28. */
const BLOCK_TYPES = new Set([
	"text",
	"image",
	"audio",
	"resource_link",
	"resource",
]);

/**
 * Whether `value` is an MCP `CallToolResult`: an object whose `content` is an
 * array of MCP content blocks (objects whose `type` is `text`, `image`,
 * `audio`, `resource_link` or `resource`), with `isError` a boolean and
 * `structuredContent` and `_meta` objects where present. Domain data that
 * happens to have a `content` array (a ProseMirror document,
 * `{ title, content: ["…"] }`) is not one (CC 3). Other keys are allowed, as
 * MCP allows them on a result.
 */
export function isCallToolResult(value: unknown): value is CallToolResult {
	if (!isObject(value) || !Array.isArray(value["content"])) return false;
	const { content, isError, structuredContent, _meta } = value;
	return (
		content.every(
			(block) => isObject(block) && BLOCK_TYPES.has(block["type"] as string),
		) &&
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

/** The text blocks of a result, one per line. */
export function resultText(result: CallToolResult): string {
	return result.content
		.map((block) =>
			isObject(block) &&
			block["type"] === "text" &&
			typeof block["text"] === "string"
				? block["text"]
				: "",
		)
		.filter((text) => text !== "")
		.join("\n");
}

/** A thrown value → an `isError` result with its message. */
export function thrownResult(error: unknown): CallToolResult {
	const message = error instanceof Error ? error.message : String(error);
	return errorResult(message || "The tool failed.");
}
