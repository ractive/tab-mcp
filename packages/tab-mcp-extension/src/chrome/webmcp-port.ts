/**
 * The content script's side of Chrome's page-world polyfill (iteration 44,
 * question 6): a port handed to `chrome/webmcp-main.ts` with
 * `window.postMessage`, behind the interface `content.ts` reads from Chrome's
 * own WebMCP. What comes back is the page's word, as any page tool's answer is.
 */

import type { ExtensionContext } from "../firefox/webmcp.ts";
import { CONNECT, type PortMessage, type PortRequest } from "../webmcp/port.ts";
import type { ToolInfo } from "../webmcp/registry.ts";

/**
 * The page-world polyfill's tools, once it answers the handover. It may
 * never (not registered for this page, Chrome has WebMCP of its own, or the
 * page set up its own first): then the promise stays pending and the port
 * open. No time limit: a page busy for a while after it loaded (a long
 * hydration) answers late, and its tools count from then.
 */
export function connectPolyfill(win: Window): Promise<ExtensionContext> {
	const channel = new MessageChannel();
	const port = channel.port1;
	const listeners = new Set<() => void>();
	const lists = new Map<number, (tools: ToolInfo[]) => void>();
	const calls = new Map<
		number,
		{ resolve: (text: string | null) => void; reject: (error: Error) => void }
	>();
	let next = 0;
	const request = (message: PortRequest) => port.postMessage(message);
	const context: ExtensionContext = {
		getTools: () =>
			new Promise((resolve) => {
				const id = ++next;
				lists.set(id, resolve);
				request({ type: "list", id });
			}),
		executeTool: (tool, input, options) =>
			new Promise((resolve, reject) => {
				const signal = options?.signal;
				if (signal?.aborted) {
					reject(new DOMException("The call was cancelled", "AbortError"));
					return;
				}
				const id = ++next;
				const onAbort = () => {
					request({ type: "cancel", id });
					calls.delete(id);
					reject(new DOMException("The call was cancelled", "AbortError"));
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				calls.set(id, {
					resolve: (text) => {
						signal?.removeEventListener("abort", onAbort);
						resolve(text);
					},
					reject: (error) => {
						signal?.removeEventListener("abort", onAbort);
						reject(error);
					},
				});
				request({ type: "call", id, name: tool.name, input: input ?? {} });
			}),
		addEventListener: (_type, listener) => {
			listeners.add(listener);
		},
		// Chrome's polyfill keeps the page's tools across an extension reload.
		revived: false,
	};
	return new Promise((resolve) => {
		port.onmessage = (event) => {
			const message = event.data as PortMessage;
			switch (message?.type) {
				case "hello":
					resolve(context);
					break;
				case "changed":
					for (const listener of listeners) listener();
					break;
				case "tools":
					lists.get(message.id)?.(
						Array.isArray(message.tools) ? message.tools : [],
					);
					lists.delete(message.id);
					break;
				case "result": {
					const call = calls.get(message.id);
					calls.delete(message.id);
					if (message.ok) call?.resolve(message.text ?? null);
					else call?.reject(new Error(String(message.error)));
					break;
				}
			}
		};
		win.postMessage({ type: CONNECT }, "*", [channel.port2]);
	});
}
