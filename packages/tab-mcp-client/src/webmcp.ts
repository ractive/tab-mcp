/**
 * Mirroring the tools into the browser's own WebMCP (iteration 25, DEC-115,
 * DEC-119): with `webmcp: true`, each tool that is offered there is also
 * registered with `document.modelContext.registerTool()`, under its own
 * `AbortController`, aborted when the tool leaves the registry. Part of the
 * core: only the detection, the registrations and the `<html>` attribute;
 * a call loads the lazy chunk, which checks, confirms and runs it.
 */

import type { RegisteredTool, ToolRegistry } from "./registry.ts";

/** What the library uses of the browser's `ModelContext`. */
export interface ModelContext {
	registerTool(tool: object, options: { signal: AbortSignal }): unknown;
}

/** Runs a call of a mirrored tool; `signal` is the browser's, if it gives one. */
export type WebMcpCall = (
	tool: RegisteredTool,
	input: unknown,
	signal: unknown,
) => Promise<unknown>;

const g = globalThis as {
	Document?: { prototype: object };
	ModelContext?: abstract new () => object;
	document?: Document;
};
let getContext: (() => unknown) | undefined;
let Native: (abstract new () => object) | undefined;

/**
 * Capture `Document.prototype`'s `modelContext` getter and `ModelContext`,
 * when the library loads: a page script that runs later cannot put its own
 * object in their place (DEC-115). Called again only by the tests.
 */
export function capture(): void {
	getContext =
		g.Document &&
		Object.getOwnPropertyDescriptor(g.Document.prototype, "modelContext")?.get;
	Native = g.ModelContext;
}
capture();

/**
 * The browser's own `ModelContext` of this document, through
 * `Document.prototype`'s getter: never an own `document.modelContext` (a
 * polyfill such as `@mcp-b/global`, or any page script). `undefined` without
 * native WebMCP.
 */
export function nativeContext(): ModelContext | undefined {
	try {
		const context: unknown = getContext?.call(g.document);
		return Native !== undefined && context instanceof Native
			? (context as ModelContext)
			: undefined;
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
 * Mirror `registry`'s tools that `offered` accepts into `context`, now and
 * whenever the registry changes. Every failure of the native
 * `registerTool()` stays here: warned once per name, the tool still offered
 * through the relay. A failed registration is tried once more a task later
 * (a duplicate right after an abort may be one still on its way out).
 */
export function mirror(
	registry: ToolRegistry,
	context: ModelContext,
	offered: (tool: RegisteredTool) => boolean,
	call: WebMcpCall,
): void {
	const mirrors = new Map<
		RegisteredTool,
		{ name: string; controller: AbortController }
	>();
	const warned = new Set<string>();
	const register = (
		tool: RegisteredTool,
		entry: { name: string; controller: AbortController },
		retry: boolean,
	): void => {
		const annotations: Record<string, boolean> = {};
		for (const key of HINTS) {
			const value = tool.annotations[key];
			if (value !== undefined) annotations[key] = value;
		}
		const native = {
			name: tool.name,
			// A WebIDL dictionary: `undefined` is the same as left out.
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations,
			execute: (input: unknown, options?: { signal?: unknown }) =>
				call(tool, input, options?.signal),
		};
		const { signal } = entry.controller;
		Promise.resolve()
			// Not once unmirrored, also for a retry: whatever the browser does
			// with an aborted signal.
			.then(() => signal.aborted || context.registerTool(native, { signal }))
			.catch((error: unknown) => {
				if (signal.aborted) return; // unmirrored meanwhile
				if (retry) {
					// Once more after a task: a duplicate right after an abort may
					// be a registration still on its way out (React's `useTool`).
					setTimeout(() => register(tool, entry, false));
					return;
				}
				if (warned.has(tool.name)) return;
				warned.add(tool.name);
				console.warn(
					`tab-mcp: ${tool.name} is not offered through WebMCP:`,
					error,
				);
			});
	};
	const sync = (): void => {
		for (const [tool, entry] of mirrors) {
			if (registry.get(tool.name) === tool) continue;
			entry.controller.abort();
			mirrors.delete(tool);
		}
		for (const tool of registry.list()) {
			if (mirrors.has(tool) || !offered(tool)) continue;
			const entry = { name: tool.name, controller: new AbortController() };
			mirrors.set(tool, entry);
			register(tool, entry, true);
		}
	};
	registry.onChange(sync);
	sync();
}
