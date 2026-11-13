/** The setup instructions per AI app (`setup.ts`, the `./setup` entry), as the connect dialog shows them. */
import { describe, expect, test } from "bun:test";
import { commandAddress, commandName } from "../src/command.ts";
import {
	SETUP_GUIDE,
	type SetupInstruction,
	setupInstructions,
} from "../src/setup.ts";

describe("the commands in the help (dialog design, review of PR 34)", () => {
	test("the name in a command is a label every shell reads as one plain word", () => {
		const cases: [string, string][] = [
			["tools", "tools"],
			["My notes", "my-notes"],
			["Bücher", "bucher"],
			["ｃａｌｃ", "calc"],
			["a\nb", "a-b"],
			["a\rb", "a-b"],
			["‘x’ “y”", "x-y"],
			["a & calc & b", "a-calc-b"],
			["a | calc", "a-calc"],
			["$HOME", "home"],
			["`calc`", "calc"],
			["%PATH%", "path"],
			["a^b", "a-b"],
			["x' ; calc ; 'y$", "x-calc-y"],
			["'$ & calc & '", "calc"],
			["-rf", "rf"],
			["--url=evil", "url-evil"],
			["my_tools-2", "my_tools-2"],
			["", "tools"],
			["!!!", "tools"],
			["日本語", "tools"],
			["a".repeat(60), "a".repeat(40)],
			[`${"a".repeat(39)} b`, "a".repeat(39)],
		];
		for (const [name, label] of cases)
			expect({ name, label: commandName(name) }).toEqual({ name, label });
	});

	test("an address goes into a command only when every character is plain", () => {
		expect(commandAddress("https://relay.example/a/abc234/mcp")).toBe(
			"https://relay.example/a/abc234/mcp",
		);
		expect(commandAddress("http://127.0.0.1:8080/a/x/mcp")).toBe(
			"http://127.0.0.1:8080/a/x/mcp",
		);
		expect(commandAddress("http://[::1]:8080/a/x/mcp")).toBe(
			"http://[::1]:8080/a/x/mcp",
		);
		for (const unsafe of [
			"https://relay.example/a/x/mcp?q=1&calc",
			"https://relay.example/a/$(calc)/mcp",
			"https://relay.example/a/x%0Acalc/mcp",
			"https://relay.example/a/'x'/mcp",
			"https://relay.example/a/x/mcp#frag",
			"https://user:pw@relay.example/a/x/mcp",
			"ftp://relay.example/a/x/mcp",
			"not an address",
		])
			expect({ unsafe, command: commandAddress(unsafe) }).toEqual({
				unsafe,
				command: undefined,
			});
	});

	test("Codex turns on its MCP 2026-07-28 feature first, one command per line", () => {
		const codex = setupInstructions(
			"calc",
			"https://relay.example/a/x/mcp",
		).find(({ id }) => id === "codex");
		expect(codex?.command).toBe(
			"codex features enable mcp_2026_07_28\ncodex mcp add calc --url https://relay.example/a/x/mcp\ncodex mcp login calc",
		);
		const claudeCode = setupInstructions(
			"x' ; calc ; 'y$",
			"https://r.example/a/x/mcp",
		).find(({ id }) => id === "claude-code");
		expect(claudeCode?.command).toBe(
			"claude mcp add --transport http x-calc-y https://r.example/a/x/mcp",
		);
	});

	test("with an address that is not plain, no commands: only the steps", () => {
		const steps = setupInstructions(
			"calc",
			"https://relay.example/a/x/mcp?a=1&b",
		);
		expect(steps.every((step) => !("command" in step))).toBe(true);
		expect(steps.map(({ app }) => app)).toEqual([
			"Claude (claude.ai and the desktop app)",
			"ChatGPT",
			"Claude Code",
			"Codex",
		]);
		const text = steps.map((step) => step.text).join(" ");
		expect(text).toContain("claude mcp add");
		expect(text).toContain("mcp_2026_07_28");
		expect(text).not.toContain("calc");
	});
});

describe("setupInstructions, the public API", () => {
	const ADDRESS = "https://relay.example/a/abc234/mcp";

	test("one entry per app, in order, each a readable object", () => {
		const steps: SetupInstruction[] = setupInstructions("My notes", ADDRESS);
		expect(steps).toEqual([
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
				text: "Run:",
				command: `claude mcp add --transport http my-notes ${ADDRESS}`,
				note: [
					{ text: "Then type " },
					{ code: "/mcp" },
					{ text: " in Claude Code and choose Authenticate." },
				],
			},
			{
				id: "codex",
				app: "Codex",
				text: "Run:",
				command: `codex features enable mcp_2026_07_28\ncodex mcp add my-notes --url ${ADDRESS}\ncodex mcp login my-notes`,
				note: [
					{
						text: "The last line opens the sign-in that asks for the code. Start a new chat in Codex after it connects.",
					},
				],
			},
		]);
		// Plain data: the same JSON a page could send or store.
		expect(JSON.parse(JSON.stringify(steps))).toEqual(steps);
	});

	test("Codex's first command line turns on the feature, the second adds the server, the third signs in (CU 6)", () => {
		const steps = setupInstructions("calc", ADDRESS);
		const codex = steps.find(({ id }) => id === "codex");
		expect(codex?.command?.split("\n")).toEqual([
			"codex features enable mcp_2026_07_28",
			`codex mcp add calc --url ${ADDRESS}`,
			"codex mcp login calc",
		]);
		// Claude Code signs in from /mcp: the step after the command.
		const claudeCode = steps.find(({ id }) => id === "claude-code");
		expect(claudeCode?.note).toContainEqual({ code: "/mcp" });
		// ChatGPT's Mac app: the guide has its steps (CU 20).
		const chatgpt = steps.find(({ id }) => id === "chatgpt");
		expect(chatgpt?.text).toContain("see the guide");
		expect(chatgpt?.note).toBeUndefined();
	});

	test("an address that is not shell-plain: no command key at all, the note stays", () => {
		for (const unsafe of [
			"https://relay.example/a/$(calc)/mcp",
			"https://relay.example/a/x/mcp?a=1&b",
			"not an address",
		]) {
			const steps = setupInstructions("calc", unsafe);
			for (const step of steps)
				expect(Object.keys(step)).not.toContain("command");
			expect(steps.find(({ id }) => id === "claude-code")?.text).toBe(
				"Add the address with claude mcp add --transport http.",
			);
			expect(steps.find(({ id }) => id === "codex")?.note).toHaveLength(1);
			expect(JSON.stringify(steps)).not.toContain(unsafe);
		}
	});

	test("odd server names become one shell-plain word in every command", () => {
		for (const [name, label] of [
			["", "tools"],
			["日本語", "tools"],
			["Bücher & Co.", "bucher-co"],
			["--url=evil; rm -rf ~", "url-evil-rm-rf"],
			["a\nb", "a-b"],
			["x".repeat(100), "x".repeat(40)],
		] as const) {
			const commands = setupInstructions(name, ADDRESS)
				.flatMap(({ command }) => command?.split("\n") ?? [])
				.filter((line) => line.includes(ADDRESS));
			expect(commands).toEqual([
				`claude mcp add --transport http ${label} ${ADDRESS}`,
				`codex mcp add ${label} --url ${ADDRESS}`,
			]);
		}
	});

	test("the guide is ractive.ch's connect page", () => {
		expect(SETUP_GUIDE).toBe("https://ractive.ch/tab-mcp/connect/");
	});
});
