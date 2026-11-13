/**
 * Mirroring the tools into the browser's own WebMCP (iteration 25, DEC-115,
 * DEC-119, DEC-143): with `webmcp: true`, each tool that is offered there is
 * also registered with `document.modelContext.registerTool()`, under its own
 * `AbortController`, aborted when the tool leaves the registry. Part of the
 * core: only the detection, the registrations and the `<html>` attribute;
 * a call loads the lazy chunk, which checks, confirms and runs it.
 */

import type { RegisteredTool, ToolRegistry } from "./registry.ts";

/** What the library uses of the browser's `ModelContext`. */
export interface ModelContext {
	registerTool(
		tool: object,
		options: { signal: AbortSignal; exposedTo: string[] | undefined },
	): unknown;
}

/** Runs a call of a mirrored tool; `signal` is the browser's, if it gives one. */
export type WebMcpCall = (
	tool: RegisteredTool,
	input: unknown,
	signal: unknown,
) => Promise<unknown>;

/**
 * The browser's own `ModelContext` of this document, read when a `TabMcp` is
 * made, through `Document.prototype`'s getter: never an own
 * `document.modelContext` (a polyfill such as `@mcp-b/global`, or any page
 * script; DEC-115). `undefined` without native WebMCP or a document.
 */
export function nativeContext(): ModelContext | undefined {
	try {
		return Object.getOwnPropertyDescriptor(
			Document.prototype,
			"modelContext",
		)?.get?.call(document);
	} catch {
		return undefined; // no document
	}
}

/** The WebMCP hints; the MCP-only ones are left out. */
const HINTS = [
	"readOnlyHint",
	"untrustedContentHint",
	"consequentialHint",
	"debugging",
] as const;

/**
 * Mirror `registry`'s tools into `context`, now and whenever the registry
 * changes: those whose `callers` list `"webmcp"`, and without `callers` those
 * not marked consequential, where MCP's `destructiveHint` counts as
 * `consequentialHint` (DEC-143, DEC-165). Every failure of the native `registerTool()`
 * stays here: warned once per name, the tool still offered through the relay.
 */
export function mirror(
	registry: ToolRegistry,
	context: ModelContext,
	call: WebMcpCall,
): void {
	const mirrors = new Map<RegisteredTool, AbortController>();
	const warned = new Set<string>();
	const sync = (): void => {
		for (const [tool, controller] of mirrors) {
			if (registry.get(tool.name) === tool) continue;
			controller.abort();
			mirrors.delete(tool);
		}
		for (const tool of registry.list()) {
			const { annotations, callers } = tool;
			const consequential =
				annotations.consequentialHint ?? annotations.destructiveHint;
			// The one place of the rule for WebMCP (the relay and a port: `toolsFor`).
			if (mirrors.has(tool) || !(callers?.includes("webmcp") ?? !consequential))
				continue;
			const controller = new AbortController();
			mirrors.set(tool, controller);
			const hints: Record<string, boolean | undefined> = {
				consequentialHint: consequential,
			};
			for (const key of HINTS) hints[key] ??= annotations[key];
			const { signal } = controller;
			Promise.resolve()
				// Not once unmirrored: whatever the browser does with an aborted
				// signal.
				.then(
					() =>
						signal.aborted ||
						context.registerTool(
							{
								name: tool.name,
								// WebIDL dictionaries: `undefined` is the same as left out.
								title: tool.title,
								description: tool.description,
								inputSchema: tool.inputSchema,
								outputSchema: tool.outputSchema,
								annotations: hints,
								execute: (input: unknown, options?: { signal?: unknown }) =>
									call(tool, input, options?.signal),
							},
							{ signal, exposedTo: tool.exposedTo },
						),
				)
				.catch((error: unknown) => {
					if (signal.aborted) return; // unmirrored meanwhile
					if (warned.has(tool.name)) return;
					warned.add(tool.name);
					console.warn(
						`tab-mcp: ${tool.name} is not offered through WebMCP:`,
						error,
					);
				});
		}
	};
	registry.onChange(sync);
	sync();
}
