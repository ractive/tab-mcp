/**
 * Whether a call of a page tool that is not read-only may run: allowed for
 * its site, or the user's answer to a question. "Don't ask again on <host>"
 * in a question allows the tool for its site, as the panel's "asks first"
 * switch does (EQ 10, DEC-139: one way of not being asked, not two).
 */

import type { ConfirmRequest } from "@ractive-ch/tab-mcp-client";
import { allowable } from "./allowed.ts";
import type { LookedUp } from "./bridge.ts";
import {
	MAX_QUESTIONS_PER_APP,
	QUESTION_TIMEOUT_MS,
	type Questions,
} from "./questions.ts";

/** What `decide` needs: the allowed tools, a question, a way to allow one. */
export interface Decider {
	allowed(origin: string, name: string): boolean;
	ask: Questions["ask"];
	/** Allow page tool `name` on `origin` from now on (the panel's "allowed"). */
	allow(origin: string, name: string): Promise<void>;
}

/**
 * Resolves if page tool `tool` may run for `request`; rejects with what the
 * AI app is told if not: not allowed, not answered in time, or not asked at
 * all because too many of its calls wait already.
 */
export async function decide(
	d: Decider,
	request: ConfirmRequest,
	tool: LookedUp,
): Promise<void> {
	// Only AI apps through the relay call here: the extension does not mirror
	// its tools into WebMCP (`webmcp` is off), so any other caller is declined.
	const { client } = request;
	if (client.kind !== "relay")
		throw new Error("The user did not allow this call.");
	if (d.allowed(tool.origin, tool.name)) return;
	const answer = await d.ask(
		{ ...request, client },
		{ tabId: tool.tabId, origin: tool.origin },
	);
	if (answer === "busy")
		throw new Error(
			`${MAX_QUESTIONS_PER_APP} calls of this AI app already wait for the user's answer; this one was not asked. Wait for those answers.`,
		);
	if (answer === "timeout")
		throw new Error(
			`The user was asked and did not answer within ${QUESTION_TIMEOUT_MS / 1000} s.`,
		);
	if (answer === "deny") throw new Error("The user did not allow this call.");
	// Only a page of a real site: opaque origins ("null") would all share one
	// entry (the question does not offer it there either).
	if (answer === "site" && allowable(tool.origin))
		await d.allow(tool.origin, tool.name).catch((error: unknown) =>
			// This call was allowed all the same; the next one asks again.
			console.warn("tab-mcp: allowing a tool for its site", error),
		);
}
