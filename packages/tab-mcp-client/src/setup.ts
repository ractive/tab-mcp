/**
 * `@ractive-ch/tab-mcp-client/setup`: how to add a page's address to each AI
 * app, the steps the connect dialog shows under "How do I add it?", for pages
 * and extensions that show them in their own UI. Plain data, no DOM. An entry
 * of its own, out of the core (DEC-118).
 */

import { commandAddress, commandName } from "./command.ts";
import type { SetupNotePart, SetupStep } from "./types.ts";

export type { SetupNotePart, SetupStep };

/** The guide for every AI app, step by step and what to do when it fails (its source is on ractive.ch). */
export const SETUP_GUIDE = "https://ractive.ch/tab-mcp/connect/";

/** Codex's feature for MCP 2026-07-28, which the relay speaks; off by default in Codex 0.163. */
const CODEX_FEATURE = "mcp_2026_07_28";

/**
 * The steps for one AI app. All strings are plain text (set them with
 * `textContent`). `command`, where present, is safe to show and to run: the
 * server's name and the address in it are words that every shell (POSIX
 * shells, PowerShell, cmd.exe) reads as plain, with nothing to quote. It is
 * absent for apps without a command, and when the address is not
 * shell-plain (only http or https, letters, digits and `. : [ ] / _ ~ -`);
 * then `text` names the command instead. The relay's addresses are
 * shell-plain.
 */
export interface SetupInstruction extends SetupStep {
	/** Which app, stable across versions: `claude`, `chatgpt`, `claude-code` or `codex`. */
	id: "claude" | "chatgpt" | "claude-code" | "codex";
}

/**
 * The steps to add `address` (the page's MCP address from the relay) to
 * Claude, ChatGPT, Claude Code and Codex, in that order. `serverName` is the
 * page's `server.name`; the commands name the server by it, reduced to a
 * shell-plain label (lower case, letters without marks, each run of other
 * characters as `-`, at most 40 characters, `tools` if nothing is left).
 * End the list with a link to {@link SETUP_GUIDE}: the steps here are the
 * minimum (CU 20), the guide has the rest and follows the apps' menus.
 */
export function setupInstructions(
	serverName: string,
	address: string,
): SetupInstruction[] {
	const n = commandName(serverName);
	const a = commandAddress(address);
	const run = (command: string) =>
		a === undefined ? {} : { text: "Run:", command };
	return [
		{
			id: "claude",
			app: "Claude (claude.ai and the desktop app)",
			text: "Settings → Connectors → Add custom connector, then paste the address.",
		},
		{
			id: "chatgpt",
			app: "ChatGPT",
			text: "On chatgpt.com: Plugins, add an MCP server with the address, then Connect. The Mac app needs more steps: see the guide.",
		},
		{
			id: "claude-code",
			app: "Claude Code",
			text: "Add the address with claude mcp add --transport http.",
			...run(`claude mcp add --transport http ${n} ${a}`),
			// The command only adds the server; the sign-in that asks for the
			// code starts in Claude Code (CU 6).
			note: [
				{ text: "Then type " },
				{ code: "/mcp" },
				{ text: " in Claude Code and choose Authenticate." },
			],
		},
		{
			id: "codex",
			app: "Codex",
			text: `Run codex features enable ${CODEX_FEATURE}, then add the address with codex mcp add --url and sign in with codex mcp login.`,
			...run(
				`codex features enable ${CODEX_FEATURE}\ncodex mcp add ${n} --url ${a}\ncodex mcp login ${n}`,
			),
			note: [
				{
					text: "The last line opens the sign-in that asks for the code. Start a new chat in Codex after it connects.",
				},
			],
		},
	];
}
