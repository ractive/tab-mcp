/**
 * WebMCP for Chrome without its own (iteration 44, question 6): Chrome has
 * `document.modelContext` only where the WebMCP flag is on or the site sends
 * an origin trial token. This script runs in the page's own world at
 * `document_start` (a content script registered with `world: "MAIN"`), before
 * the page's scripts, and defines it for the page, which registers its tools
 * here as it would with Chrome's (`webmcp/registry.ts`). The content script
 * reads and calls them over a port (`webmcp/port.ts`).
 *
 * It steps aside where Chrome has WebMCP or the page brought its own before
 * (`"modelContext" in document`). Where a site turns Chrome's WebMCP on later,
 * through an origin trial `<meta>`, Chrome defines its own attribute over this
 * accessor (configurable, as WebIDL's are), and the content script reads
 * Chrome's.
 *
 * It shares the page's world: the page can see, change or replace it. That
 * harms only the page's own tools; nothing here has the extension's powers.
 */

import { CONNECT, type PortMessage, type PortRequest } from "../webmcp/port.ts";
import {
	messageOf,
	PageError,
	type PageObject,
	resultText,
	type SignalLike,
	ToolRegistry,
} from "../webmcp/registry.ts";

/** The events the object has `on…` handlers for. */
const EVENTS = ["toolchange", "toolactivated", "toolcancel"] as const;

function install(): void {
	if (!isSecureContext) return;
	if ("modelContext" in document || "modelContext" in navigator) return;
	const context = new EventTarget();
	const ports = new Set<MessagePort>();
	const send = (port: MessagePort, message: PortMessage) => {
		try {
			port.postMessage(message);
		} catch {
			// A result that cannot be cloned is sent as an error by the caller.
		}
	};
	const tools = new ToolRegistry(() => {
		context.dispatchEvent(new Event("toolchange"));
		for (const port of ports) send(port, { type: "changed" });
	});

	const toPage = (error: unknown): unknown =>
		error instanceof PageError
			? error.kind === "TypeError"
				? new TypeError(error.message)
				: new DOMException(error.message, error.kind)
			: error;
	/** `work` now, its outcome as a promise (a registration counts at once). */
	const settle = <T>(work: () => T | Promise<T>): Promise<T> => {
		try {
			return Promise.resolve(work()).catch((error: unknown) =>
				Promise.reject(toPage(error)),
			);
		} catch (error) {
			return Promise.reject(toPage(error));
		}
	};

	/** Run a tool: the page's `execute` with `input` and a signal. */
	const run = async (
		name: string,
		input: unknown,
		signal?: AbortSignal,
	): Promise<string | null> => {
		const entry = tools.get(name);
		if (entry === undefined) throw new Error(`no tool named ${name}`);
		signal?.throwIfAborted();
		const controller = new AbortController();
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => {
				controller.abort();
				reject(new DOMException("The call was cancelled", "AbortError"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		try {
			const value: unknown = await Promise.race([
				Promise.resolve(
					entry.execute.call(entry.tool, input ?? {}, {
						signal: controller.signal,
					}),
				),
				aborted,
			]);
			return resultText(value);
		} finally {
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	};

	const methods: Record<string, (...args: PageObject[]) => unknown> = {
		registerTool: (tool, options) =>
			settle(() =>
				tools.register(tool, options?.signal as SignalLike | undefined),
			),
		unregisterTool: (name) => tools.unregister(String(name)),
		getTools: () => settle(() => tools.list()),
		executeTool: (tool, input, options) =>
			settle(() =>
				run(String(tool?.name ?? ""), input, options?.signal ?? undefined),
			),
		provideContext: (value) => settle(() => tools.provide(value?.tools)),
		clearContext: () => tools.clear(),
	};
	for (const [name, method] of Object.entries(methods))
		Object.defineProperty(context, name, {
			value: method,
			configurable: true,
			writable: true,
		});
	for (const type of EVENTS) {
		let handler: PageObject = null;
		context.addEventListener(type, (event) => {
			if (typeof handler === "function") {
				try {
					handler.call(context, event);
				} catch {
					// The page's handler threw: its own affair.
				}
			}
		});
		Object.defineProperty(context, `on${type}`, {
			get: () => handler,
			set: (value: unknown) => {
				handler = typeof value === "function" ? value : null;
			},
			configurable: true,
			enumerable: true,
		});
	}
	for (const proto of [Document.prototype, Navigator.prototype])
		Object.defineProperty(proto, "modelContext", {
			get: () => context,
			configurable: true,
			enumerable: true,
		});

	// A content script's port: the calls it makes, each with its id.
	const answer = async (
		port: MessagePort,
		calls: Map<number, AbortController>,
		request: PortRequest,
	) => {
		if (request?.type === "list") {
			send(port, { type: "tools", id: request.id, tools: tools.list() });
		} else if (request?.type === "call") {
			const controller = new AbortController();
			calls.set(request.id, controller);
			try {
				const text = await run(request.name, request.input, controller.signal);
				send(port, { type: "result", id: request.id, ok: true, text });
			} catch (error) {
				send(port, {
					type: "result",
					id: request.id,
					ok: false,
					error: messageOf(error),
					aborted: controller.signal.aborted,
				});
			} finally {
				calls.delete(request.id);
			}
		} else if (request?.type === "cancel") {
			calls.get(request.id)?.abort();
		}
	};
	window.addEventListener("message", (event) => {
		if (
			event.source !== window ||
			(event.data as { type?: unknown } | null)?.type !== CONNECT ||
			event.ports.length !== 1
		)
			return;
		const port = event.ports[0] as MessagePort;
		ports.add(port);
		const calls = new Map<number, AbortController>();
		port.onmessage = (message) =>
			void answer(port, calls, message.data as PortRequest);
		send(port, { type: "hello" });
	});
}

install();
