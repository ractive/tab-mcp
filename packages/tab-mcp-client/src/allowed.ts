/**
 * `@ractive-ch/tab-mcp-client/allowed`: the tools that run without asking,
 * per connected AI app, for a page that draws its own switches ("always
 * allow this tool", "allow everything, no questions asked"). The library's
 * dialogs use the same allowances. An entry of its own, out of the core
 * (DEC-200).
 *
 * ```ts
 * import { allowedTools } from "@ractive-ch/tab-mcp-client/allowed";
 * const allowed = allowedTools(mcp);
 * for (const tool of allowed.tools()) {
 *   box.checked = allowed.has(grant.grantId, tool.name);
 *   box.onchange = () => box.checked ? allowed.allow(grant.grantId, tool.name) : allowed.ask(grant.grantId, tool.name);
 * }
 * ```
 */

import {
	type AllowedTool,
	type AllowedTools,
	allowedFor,
} from "./always-allowed.ts";
import type { TabMcp } from "./tab-mcp.ts";

export type { AllowedTool, AllowedTools };

/**
 * The allowances of `mcp`: one object per `TabMcp`, the same for every
 * call. Kept in its `storage` next to the address secret until the app is
 * disconnected (in memory with `storage: null` or `alwaysAllow:
 * "until-reload"`); they end with the app's grant, as the relay reports it,
 * and with `newAddress()`. A call they allow runs without asking, with the
 * library's dialog and with the page's own `onConfirm` alike.
 */
export function allowedTools(mcp: TabMcp): AllowedTools {
	return allowedFor(mcp);
}
