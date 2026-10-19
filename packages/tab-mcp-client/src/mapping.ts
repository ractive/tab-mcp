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
	[key: string]: unknown;
}

export function errorResult(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * What `execute` returned → a `CallToolResult`: a string is one text block; an
 * object with a `content` array passes through; `undefined` is an empty
 * result; any other JSON value is a text block with its JSON, plus
 * `structuredContent` when it is an object.
 */
export function toCallToolResult(value: unknown): CallToolResult {
	if (typeof value === "string")
		return { content: [{ type: "text", text: value }] };
	if (value === undefined) return { content: [] };
	if (isPlainObject(value) && Array.isArray(value["content"])) {
		return value as CallToolResult;
	}
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		// cyclic or BigInt
	}
	if (text === undefined)
		return errorResult("The tool returned a value that is not JSON.");
	const result: CallToolResult = { content: [{ type: "text", text }] };
	if (isPlainObject(value)) result.structuredContent = value;
	return result;
}

/** A thrown value → an `isError` result with its message. */
export function thrownResult(error: unknown): CallToolResult {
	const message = error instanceof Error ? error.message : String(error);
	return errorResult(message || "The tool failed.");
}
