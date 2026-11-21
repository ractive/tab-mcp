/**
 * Mirroring the tools into the browser's own WebMCP (iteration 25, DEC-115,
 * DEC-119, DEC-143): with `webmcp: true`, each tool that is offered there is
 * also registered with `document.modelContext.registerTool()`, under its own
 * `AbortController`, aborted when the tool leaves the registry. A chunk of
 * its own (DEC-171), loaded by a `TabMcp` whose constructor found native
 * WebMCP (`nativeContext` in the core); a call loads the connection chunk,
 * which checks, confirms and runs it. The handshake with the tab-mcp browser
 * extension (`handshake.ts`, DEC-207) is here too: only a page that mirrors
 * takes part.
 */

import {
	type HandshakePage,
	joinHandshake,
	type VouchedBy,
} from "./handshake.ts";
import type { RegisteredTool, ToolRegistry } from "./registry.ts";
import type { BrowserExtension } from "./types.ts";

/** What the library uses of the browser's `ModelContext`. */
export interface ModelContext {
	registerTool(
		tool: object,
		options: { signal: AbortSignal; exposedTo: string[] | undefined },
	): unknown;
}

/**
 * Runs a call of a mirrored tool; `signal` is the browser's, if it gives
 * one; `by`: the AI app the tab-mcp browser extension vouched for it.
 */
export type WebMcpCall = (
	tool: RegisteredTool,
	input: unknown,
	signal: unknown,
	by: VouchedBy | undefined,
) => Promise<unknown>;

/** The WebMCP hints; the MCP-only ones are left out. */
const HINTS = [
	"readOnlyHint",
	"untrustedContentHint",
	"consequentialHint",
	"debugging",
] as const;

/**
 * Mirror `registry`'s tools into `context`, now and whenever the registry
 * changes: every tool, unless its `callers` leave `"webmcp"` out (DEC-165,
 * DEC-209). A tool that asks asks a WebMCP caller as it asks an AI app; MCP's
 * `destructiveHint` counts as `consequentialHint` (DEC-143). Every failure of the native `registerTool()`
 * stays here: warned once per name, the tool still offered through the relay.
 * The page joins the handshake with the tab-mcp browser extension: `mcp`
 * is its `TabMcp`, `app` its app id, `options` its options
 * (`trustExtension`), `version` the library's. The extension's state is `mcp.extension`, defined
 * here on the instance (the core only declares it, for its bytes), and
 * `extensionchange` is sent here.
 */
export function mirror(
	registry: ToolRegistry,
	context: ModelContext,
	call: WebMcpCall,
	mcp: HandshakePage["mcp"],
	app: string,
	options: { trustExtension?: boolean },
	version: string,
): void {
	let state: BrowserExtension | undefined;
	Object.defineProperty(mcp, "extension", {
		get: () => state,
		configurable: true,
	});
	let handshake: ReturnType<typeof joinHandshake>;
	try {
		handshake = joinHandshake({
			version,
			app,
			registry,
			trust: options.trustExtension !== false,
			mcp,
			set: (extension) => {
				state = extension;
				mcp.dispatchEvent(
					new CustomEvent("extensionchange", { detail: { extension } }),
				);
			},
		});
	} catch (error) {
		// The tools are mirrored all the same; their calls are asked.
		console.warn("tab-mcp: no handshake with the browser extension:", error);
	}
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
			if (mirrors.has(tool) || !(callers?.includes("webmcp") ?? true)) continue;
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
								// The vouch is looked up as the call arrives: it was
								// sent right before the extension made the call.
								execute: (input: unknown, options?: { signal?: unknown }) =>
									call(
										tool,
										input,
										options?.signal,
										handshake?.take(tool, input),
									),
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
