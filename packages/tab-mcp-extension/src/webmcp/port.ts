/**
 * The messages between Chrome's page-world polyfill (`chrome/webmcp-main.ts`)
 * and the content script (`chrome/webmcp-port.ts`), over a `MessagePort` the
 * content script hands over with `window.postMessage` (iteration 44, question
 * 6). The page can see the handover and use a port of its own: it gets
 * nothing it does not have (its own tools, their inputs and results), and the
 * extension trusts nothing it reads here more than any page tool's answer.
 */

import type { ToolInfo } from "./registry.ts";

/** The `window.postMessage` that hands a port over (one in `ports`). */
export const CONNECT = "tab-mcp:webmcp-connect";

/** From the content script. */
export type PortRequest =
	| { type: "list"; id: number }
	| { type: "call"; id: number; name: string; input: unknown }
	| { type: "cancel"; id: number };

/** From the page-world polyfill. */
export type PortMessage =
	| { type: "hello" }
	| { type: "changed" }
	| { type: "tools"; id: number; tools: ToolInfo[] }
	| { type: "result"; id: number; ok: true; text: string | null }
	| { type: "result"; id: number; ok: false; error: string; aborted: boolean };
