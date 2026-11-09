/**
 * Whether a call of a tool that is not read-only may run: allowed for its
 * site, Always allow, or the user's answer to a question.
 */

import type { ConfirmRequest } from "@ractive-ch/tab-mcp-client";
import { allowable } from "./allowed.ts";
import type { AlwaysAllowed, AlwaysKey } from "./always.ts";
import { type LookedUp, sameTool } from "./bridge.ts";
import {
	MAX_QUESTIONS_PER_APP,
	QUESTION_TIMEOUT_MS,
	type Questions,
} from "./questions.ts";

/** What `decide` needs: the bridge, the allowed tools, Always allow, a question. */
export interface Decider {
	lookup(toolName: string): LookedUp | undefined;
	allowed(origin: string, name: string): boolean;
	always: AlwaysAllowed;
	ask: Questions["ask"];
}

/**
 * Whether a tool that is not read-only may run. Always allow is kept for the
 * AI app, the page's origin, the page itself (its document) and the tool,
 * and only if the tool is still that one once the user answered: a page
 * that changed while the question was open (a navigation, another tab in
 * front with a tool of the same name) gets nothing from it.
 */
export async function decide(
	d: Decider,
	request: ConfirmRequest,
): Promise<boolean> {
	const tool = d.lookup(request.tool.name);
	if (tool !== undefined && d.allowed(tool.origin, tool.name)) return true;
	// Always allow only for a page of a real site: opaque origins ("null")
	// would all share one entry.
	const key: AlwaysKey | undefined =
		tool !== undefined && allowable(tool.origin)
			? {
					grantId: request.client.grantId,
					origin: tool.origin,
					documentId: tool.documentId,
					tool: request.tool.name,
				}
			: undefined;
	if (key !== undefined && d.always.has(key)) return true;
	const answer = await d.ask(
		request,
		tool === undefined ? {} : { tabId: tool.tabId, origin: tool.origin },
	);
	if (answer === "busy")
		throw new Error(
			`${MAX_QUESTIONS_PER_APP} calls of this AI app already wait for the user's answer; this one was not asked. Wait for those answers.`,
		);
	if (answer === "timeout")
		// The library declines; `webmcp_call` passes this on to the AI app.
		throw new Error(
			`The user was asked and did not answer within ${QUESTION_TIMEOUT_MS / 1000} s.`,
		);
	if (answer === "always" && key !== undefined && tool !== undefined) {
		const now = d.lookup(request.tool.name);
		if (now !== undefined && sameTool(now, tool)) d.always.add(key);
	}
	return answer !== "deny";
}
