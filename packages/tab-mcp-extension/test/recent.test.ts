/**
 * "Recent calls" in the worker (DEC-226): what it keeps of each call, how
 * long the list grows, how each call ended, and what it makes of other
 * people's text.
 */

import { describe, expect, test } from "bun:test";
import type {
	RelayClient,
	Tool,
	ToolCallEnd,
	ToolCallOutcome,
	ToolCallStart,
	ToolExecuteOptions,
} from "@ractive-ch/tab-mcp-client";
import type { CallView } from "../src/protocol.ts";
import {
	argsLine,
	MAX_ARGS,
	MAX_CALLS,
	MAX_ERROR,
	MAX_NAME,
	RecentCalls,
} from "../src/worker/recent.ts";

const CLAUDE: RelayClient = {
	kind: "relay",
	grantId: "g1",
	id: "https://claude.ai/oauth/client",
	name: "Claude",
	host: "claude.ai",
};

const start = (
	id: number,
	tool = "page_info",
	args: Record<string, unknown> = {},
	client: RelayClient = CLAUDE,
): ToolCallStart => ({ id, tool, arguments: args, client });

const end = (
	id: number,
	outcome: ToolCallOutcome = "ok",
	text = "done",
	tool = "page_info",
): ToolCallEnd => ({
	id,
	tool,
	client: CLAUDE,
	outcome,
	result: {
		content: [{ type: "text", text }],
		...(outcome === "ok" ? {} : { isError: true }),
	},
	durationMs: 5,
});

function recorded() {
	const changes: { call: CallView; added: boolean }[] = [];
	const recent = new RecentCalls(
		(call, added) => changes.push({ call, added }),
		() => 1_700_000_000_000,
	);
	return { recent, changes };
}

/** A call as the library makes it: its start, `execute` with its signal, then the end. */
function run(
	recent: RecentCalls,
	id: number,
	tool = "page_get_greeting",
	args: Record<string, unknown> = {},
) {
	const signal = new AbortController().signal;
	recent.started(start(id, tool, args));
	recent.bind(tool, CLAUDE, signal);
	return signal;
}

describe("the record (DEC-226)", () => {
	test("each call with its AI app, tool, arguments and start, newest first, until it ends", () => {
		const { recent, changes } = recorded();
		recent.started(start(1, "page_get_greeting", { name: "Ada" }));
		expect(recent.list).toEqual([
			{
				id: 1,
				at: 1_700_000_000_000,
				app: "Claude",
				host: "claude.ai",
				tool: "page_get_greeting",
				args: '{"name":"Ada"}',
				state: "running",
			},
		]);
		recent.started(start(2));
		recent.ended(end(1));
		expect(recent.list.map((c) => [c.id, c.state])).toEqual([
			[2, "running"],
			[1, "ok"],
		]);
		expect(changes.map((c) => [c.call.id, c.call.state, c.added])).toEqual([
			[1, "running", true],
			[2, "running", true],
			[1, "ok", false],
		]);
	});

	test(`${MAX_CALLS} kept: the oldest goes when another starts`, () => {
		const { recent } = recorded();
		for (let id = 1; id <= MAX_CALLS + 5; id++) recent.started(start(id));
		expect(recent.count).toBe(MAX_CALLS);
		expect(recent.list[0]?.id).toBe(MAX_CALLS + 5);
		expect(recent.list.at(-1)?.id).toBe(6);
		// The end of one that went changes nothing.
		recent.ended(end(3));
		expect(recent.list.some((c) => c.id === 3)).toBe(false);
	});

	test("each way a call ends", () => {
		const { recent } = recorded();
		const state = (id: number) => recent.list.find((c) => c.id === id);

		run(recent, 1);
		recent.ended(end(1));
		expect(state(1)).toMatchObject({ state: "ok" });
		expect(state(1)).not.toHaveProperty("allowed");

		run(recent, 2);
		recent.ended(end(2, "error", "The page's tool threw.\nat line 3"));
		expect(state(2)).toMatchObject({
			state: "failed",
			error: "The page's tool threw.",
		});

		// Asked: waiting, then allowed once, then ran.
		const asked = run(recent, 3, "page_place_order");
		recent.note(asked, { site: "https://shop.example" });
		recent.note(asked, { waiting: true });
		expect(state(3)).toMatchObject({ state: "waiting" });
		recent.note(asked, { answer: "allow" });
		expect(state(3)).toMatchObject({ state: "running", allowed: "once" });
		recent.ended(end(3, "ok", "done", "page_place_order"));
		expect(state(3)).toMatchObject({
			state: "ok",
			allowed: "once",
			site: "https://shop.example",
		});

		// "Always allow on <host>" in the question, and allowed before.
		const site = run(recent, 4, "page_place_order");
		recent.note(site, { waiting: true });
		recent.note(site, { answer: "site" });
		recent.ended(end(4));
		expect(state(4)).toMatchObject({ state: "ok", allowed: "always" });
		const before = run(recent, 5, "page_place_order");
		recent.note(before, { allowedBefore: true });
		recent.ended(end(5));
		expect(state(5)).toMatchObject({ state: "ok", allowed: "always" });

		// Declined, not answered: the worker's error, told apart by the answer.
		const declined = run(recent, 6, "page_place_order");
		recent.note(declined, { answer: "deny" });
		recent.ended(end(6, "error", "The user did not allow this call."));
		expect(state(6)).toMatchObject({ state: "declined" });
		expect(state(6)).not.toHaveProperty("error");
		const unanswered = run(recent, 7, "page_place_order");
		recent.note(unanswered, { answer: "timeout" });
		recent.ended(end(7, "error", "The user was asked and did not answer."));
		expect(state(7)).toMatchObject({ state: "unanswered" });

		// Busy: not asked, a failure with its reason.
		const busy = run(recent, 8, "page_place_order");
		recent.note(busy, { answer: "busy" });
		recent.ended(end(8, "error", "5 calls of this AI app already wait."));
		expect(state(8)).toMatchObject({ state: "failed" });

		// Cancelled by the AI app; the page out of time.
		run(recent, 9);
		recent.ended(end(9, "cancelled", "The call was cancelled."));
		expect(state(9)).toMatchObject({ state: "cancelled" });
		const slow = run(recent, 10);
		recent.note(slow, { timedOut: true });
		recent.ended(end(10, "error", "did not answer within 30 s."));
		expect(state(10)).toMatchObject({ state: "timeout" });
	});

	test("a note binds to its own call: the newest of that tool by that AI app not yet running, never an ended one", () => {
		const { recent } = recorded();
		const signal = new AbortController().signal;
		recent.started(start(1, "page_a"));
		recent.started(start(2, "page_b"));
		// The library calls `execute` right after `toolcall`: page_a's.
		recent.bind("page_a", CLAUDE, signal);
		recent.note(signal, { site: "https://a.example" });
		expect(recent.list.find((c) => c.id === 1)?.site).toBe("https://a.example");
		expect(recent.list.find((c) => c.id === 2)?.site).toBeUndefined();
		// Another AI app's call of the same tool is not this one.
		const other = new AbortController().signal;
		recent.bind("page_b", { ...CLAUDE, host: "chatgpt.com" }, other);
		recent.note(other, { site: "https://b.example" });
		expect(recent.list.find((c) => c.id === 2)?.site).toBeUndefined();
		// A late answer after the end changes nothing.
		recent.ended(end(1));
		recent.note(signal, { answer: "deny" });
		expect(recent.list.find((c) => c.id === 1)?.state).toBe("ok");
	});

	test("`wrap`: the tool's own `execute` runs, after its call is bound", async () => {
		const { recent } = recorded();
		const tool: Tool = {
			name: "page_info",
			description: "",
			inputSchema: { type: "object" },
			execute: (_input, options) => {
				recent.note(options.signal, { site: "https://shop.example" });
				return "ran";
			},
		};
		recent.started(start(1));
		const options: ToolExecuteOptions = {
			signal: new AbortController().signal,
			client: CLAUDE,
		};
		expect(await recent.wrap(tool).execute({}, options)).toBe("ran");
		expect(recent.list[0]?.site).toBe("https://shop.example");
	});

	test("`watch`: starts until the connection goes, ends after it too (a call in flight as the relay changes)", () => {
		const { recent } = recorded();
		const mcp = new EventTarget();
		const listening = new AbortController();
		recent.watch(mcp, listening.signal);
		mcp.dispatchEvent(new CustomEvent("toolcall", { detail: start(1) }));
		listening.abort();
		mcp.dispatchEvent(new CustomEvent("toolcall", { detail: start(2) }));
		expect(recent.list.map((c) => c.id)).toEqual([1]);
		mcp.dispatchEvent(new CustomEvent("toolcallend", { detail: end(1) }));
		expect(recent.list[0]?.state).toBe("ok");
	});

	test("memory only: the record and the panel's list use no storage API", async () => {
		for (const file of [
			"../src/worker/recent.ts",
			"../src/sidepanel/calls.ts",
		]) {
			const source = await Bun.file(new URL(file, import.meta.url)).text();
			// The code, not its comments (which say where it is not kept).
			const code = source
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^\s*\/\/.*$/gm, "");
			expect(code).not.toMatch(
				/indexedDB|IDB|chrome\.storage|browser\.storage|localStorage|sessionStorage|\bKv\b/,
			);
		}
	});

	test("the list is a copy: the panel's message cannot change the record", () => {
		const { recent } = recorded();
		recent.started(start(1));
		const [first] = recent.list;
		if (first) first.state = "ok";
		expect(recent.list[0]?.state).toBe("running");
	});
});

describe("other people's text in the record", () => {
	test(`arguments: one line of JSON, cut to ${MAX_ARGS} characters`, () => {
		const long = argsLine({ text: "x".repeat(10_000) });
		expect(long).toHaveLength(MAX_ARGS);
		expect(long.endsWith("…")).toBe(true);
		expect(long.startsWith('{"text":"xxx')).toBe(true);
		expect(argsLine({})).toBe("{}");
		expect(argsLine(undefined)).toBe("{}");
		// A line break in a value is JSON's \n, never a new line.
		expect(argsLine({ a: "1\n2" })).toBe('{"a":"1\\n2"}');
	});

	test("markup stays text, invisible and direction characters are escaped, controls never break the line", () => {
		const { recent } = recorded();
		recent.started(
			start(
				1,
				"page_<b>x</b>",
				{ html: "<img src=x onerror=alert(1)>", rtl: "a‮b" },
				{ ...CLAUDE, name: "Evil‮\n<script>App" },
			),
		);
		const [call] = recent.list;
		expect(call?.tool).toBe("page_<b>x</b>");
		expect(call?.args).toBe(
			'{"html":"<img src=x onerror=alert(1)>","rtl":"a\\u202Eb"}',
		);
		expect(call?.app).toBe("Evil\\u202E <script>App");
		recent.bind("page_<b>x</b>", CLAUDE, new AbortController().signal);
		recent.ended({
			...end(1, "error", `${"\u0007bad ".repeat(100)}`),
		});
		const error = recent.list[0]?.error ?? "";
		expect(error).toHaveLength(MAX_ERROR);
		expect([...error].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)).toBe(
			false,
		);
		expect(error.startsWith("\\u0007bad")).toBe(true);
	});

	test(`names, hosts and sites cut to ${MAX_NAME}`, () => {
		const { recent } = recorded();
		const signal = new AbortController().signal;
		const name = "n".repeat(500);
		recent.started(
			start(1, name, {}, { ...CLAUDE, name, host: `${name}.example` }),
		);
		recent.bind(name, { ...CLAUDE, host: `${name}.example` }, signal);
		recent.note(signal, { site: `https://${name}.example` });
		const [call] = recent.list;
		for (const text of [call?.tool, call?.app, call?.host, call?.site])
			expect(text).toHaveLength(MAX_NAME);
	});
});
