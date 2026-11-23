/**
 * Mirroring the tools into the browser's own WebMCP (iteration 25, DEC-115,
 * DEC-119, DEC-143): unless `webmcp: false`, each tool that is offered there is
 * also registered with `document.modelContext.registerTool()`, under its own
 * `AbortController`, aborted when the tool leaves the registry. A chunk of
 * its own (DEC-171), loaded by a `TabMcp` whose constructor found native
 * WebMCP (`nativeContext` in the core); a call loads the connection chunk,
 * which checks and runs it. The handshake with the tab-mcp browser
 * extension (`handshake.ts`, DEC-207) is here too: only a page that mirrors
 * takes part.
 */

import {
	type HandshakePage,
	joinHandshake,
	type Vouched,
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
 * one; `by`: the tab-mcp browser extension announced it for an AI app
 * (a vouch or a claim).
 */
export type WebMcpCall = (
	tool: RegisteredTool,
	input: unknown,
	signal: unknown,
	by: Vouched | undefined,
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
 * DEC-209). A tool that asks is marked `consequentialHint`, so that the agent
 * asks its user; MCP's `destructiveHint` counts as `consequentialHint`
 * (DEC-143). The page's `onConfirm` decides such a call, never the library's
 * dialog (DEC-215). Every failure of the native `registerTool()`
 * stays here: warned once per name, the tool still offered through the relay.
 * The page joins the handshake with the tab-mcp browser extension: `mcp`
 * is its `TabMcp`, `app` its app id, `options` its options
 * (`trustExtension`, and `onConfirm` for the warning below), `version` the
 * library's. A tool that asks, mirrored with an `exposedTo` that names
 * other origins on a page without `onConfirm`, is warned about once per
 * name (`warnUnasked`): documents of those origins can run it, and the
 * library asks no WebMCP caller (DEC-215). The extension's state is `mcp.extension`, defined
 * here on the instance (the core only declares it, for its bytes), and
 * `extensionchange` is sent here.
 */
export function mirror(
	registry: ToolRegistry,
	context: ModelContext,
	call: WebMcpCall,
	mcp: HandshakePage["mcp"],
	app: string,
	options: { trustExtension?: boolean; onConfirm?: unknown },
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
		// The tools are mirrored all the same; no call is vouched for.
		console.warn("tab-mcp: no handshake with the browser extension:", error);
	}
	const mirrors = new Map<RegisteredTool, AbortController>();
	const warned = new Set<string>();
	const unasked = new Set<string>();
	/**
	 * The warning about a tool that asks with `exposedTo` (DEC-215), once its
	 * native registration succeeded (so Chrome accepted every origin), once
	 * per name. Decided then: a handler the page removes later is not
	 * caught. Never throws, whatever `exposedTo` holds.
	 */
	const warnUnasked = (tool: RegisteredTool, asks: boolean | undefined) => {
		try {
			// React's provider always passes a handler; `own` says whether the
			// page gave one.
			const ask = options.onConfirm as { own?: boolean } | undefined;
			const page = globalThis.document?.location?.origin;
			const others = (
				Array.isArray(tool.exposedTo) ? tool.exposedTo : []
			).filter((entry: unknown) => {
				try {
					return new URL(String(entry)).origin !== page;
				} catch {
					return false; // the browser refuses it anyway
				}
			});
			if (
				asks !== true ||
				others.length === 0 ||
				(ask && ask.own !== false) ||
				unasked.has(tool.name)
			)
				return;
			unasked.add(tool.name);
			console.warn(
				`tab-mcp: ${tool.name} asks before it runs, but documents of ${others.join(", ")} (its exposedTo) can call it through WebMCP without a question: the library asks no WebMCP caller. Refuse such calls in onConfirm, or leave exposedTo off.`,
			);
		} catch {
			// a warning never stops the mirror
		}
	};
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
				.then(() => {
					if (!signal.aborted) warnUnasked(tool, consequential);
				})
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
