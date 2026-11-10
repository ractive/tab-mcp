/**
 * `@ractive-ch/tab-mcp-client/setup`: how to add a page's address to each AI
 * app, the steps the connect dialog shows under "How do I add it?", for pages
 * and extensions that show them in their own UI. Plain data, no DOM. An entry
 * of its own, out of the core (DEC-118).
 */

import { commandAddress, commandName } from "./command.ts";

/** The guide for every AI app, step by step and what to do when it fails (its source is on ractive.ch). */
export const SETUP_GUIDE = "https://ractive.ch/tab-mcp/connect/";

/** Codex's feature for MCP 2026-07-28, which the relay speaks; off by default in Codex 0.163. */
const CODEX_FEATURE = "mcp_2026_07_28";

/** A part of a {@link SetupInstruction}'s note: plain text, or code to show as code. */
export type SetupNotePart = { text: string } | { code: string };

/** The steps for one AI app. All strings are plain text (set them with `textContent`). */
export interface SetupInstruction {
	/** Which app, stable across versions: `claude`, `chatgpt`, `claude-code` or `codex`. */
	id: "claude" | "chatgpt" | "claude-code" | "codex";
	/** The app's name as shown, such as "Claude Code". */
	app: string;
	/** What to do, a sentence or two. "Run:" when `command` follows. */
	text: string;
	/**
	 * The commands to run in a terminal, one per line, to show with a Copy
	 * button. Safe to show and to run: the server's name and the address in
	 * them are words that every shell (POSIX shells, PowerShell, cmd.exe) reads
	 * as plain, with nothing to quote. Absent for apps without a command, and
	 * when the address is not shell-plain (only http or https, letters, digits
	 * and `. : [ ] / _ ~ -`); then `text` names the command instead. The relay's
	 * addresses are shell-plain.
	 */
	command?: string;
	/** Shown after the command (or the text): text and code, in order. */
	note?: SetupNotePart[];
}

/**
 * The steps to add `address` (the page's MCP address from the relay) to
 * Claude, ChatGPT, Claude Code and Codex, in that order. `serverName` is the
 * page's `server.name`; the commands name the server by it, reduced to a
 * shell-plain label (lower case, letters without marks, each run of other
 * characters as `-`, at most 40 characters, `tools` if nothing is left).
 * End the list with a link to {@link SETUP_GUIDE}.
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
			text: "On chatgpt.com: Plugins, add an MCP server with the address. In the Mac app: Settings → Plugins → MCPs → Add, type Streamable HTTP; it needs the Codex feature below.",
		},
		{
			id: "claude-code",
			app: "Claude Code",
			text: "Add the address with claude mcp add --transport http.",
			...run(`claude mcp add --transport http ${n} ${a}`),
		},
		{
			id: "codex",
			app: "Codex",
			text: `Run codex features enable ${CODEX_FEATURE}, then add the address with codex mcp add --url.`,
			...run(
				`codex features enable ${CODEX_FEATURE}\ncodex mcp add ${n} --url ${a}`,
			),
			note: [
				{
					text: "Start a new chat in Codex after it connects. The first line turns on a feature for all of Codex's MCP servers; ",
				},
				{ code: `codex features disable ${CODEX_FEATURE}` },
				{ text: " turns it off." },
			],
		},
	];
}
